import asyncio
import datetime
import json
import os
import re
import secrets
import time
from collections import defaultdict
from pathlib import Path

import httpx
import uvicorn
from bs4 import BeautifulSoup
from cachetools import TTLCache
from fastapi import FastAPI, Query, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
from starlette.responses import Response

# .env 자동 로드 (python-dotenv 있을 때만)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

# ── Playwright: 실제 Chrome 브라우저로 API 인터셉트 (가장 신뢰성 높음) ──
try:
    from playwright.async_api import async_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    async_playwright = None
    PLAYWRIGHT_AVAILABLE = False
    print("⚠️ playwright 미설치 → py -m playwright install chromium")

# Render 무료 tier: Playwright 기본 비활성화 (메모리/CPU 부족)
# 활성화하려면 환경변수 ENABLE_PLAYWRIGHT=true 설정
if os.environ.get("ENV") == "production" and os.environ.get("ENABLE_PLAYWRIGHT", "false").lower() != "true":
    PLAYWRIGHT_AVAILABLE = False
    print("⚠️ [Production] Playwright 비활성화 → curl_cffi 전용")

# ── curl_cffi: Chrome TLS 핑거프린팅 우회 (Playwright 불가 시 fallback) ──
try:
    from curl_cffi.requests import AsyncSession as CurlSession
    CURL_AVAILABLE = True
except ImportError:
    CurlSession = None
    CURL_AVAILABLE = False

# ── 환경 변수 기반 설정 ───────────────────────────────────────
# 배포 시 환경 변수로 주입:
#   ALLOWED_ORIGINS="https://yourdomain.com,https://www.yourdomain.com"
#   ENV=production
_ENV     = os.environ.get("ENV", "development")
_IS_PROD = _ENV == "production"

# 명시적으로 허용할 추가 오리진 (환경변수에서 읽음)
# Render/Railway: ALLOWED_ORIGINS=https://pitchmap.onrender.com
_EXTRA_ORIGINS = [
    o.strip().rstrip("/")
    for o in os.environ.get("ALLOWED_ORIGINS", "").split(",")
    if o.strip()
]

# FastAPI가 HTML까지 서빙하므로 브라우저 요청은 same-origin
# → CORS는 외부 도메인 프론트엔드용 안전망으로만 유지
_LOCAL_ORIGINS = [
    "http://127.0.0.1:5500", "http://localhost:5500",
    "http://127.0.0.1:8000", "http://localhost:8000",
    "null",
]

ALLOWED_ORIGINS = ([] if _IS_PROD else _LOCAL_ORIGINS) + _EXTRA_ORIGINS

# 환경변수 미설정 시 same-origin 요청은 CORS 헤더 없이도 통과하므로
# origins 가 비었을 때만 임시 전체 허용 (배포 초기 디버깅용)
if not ALLOWED_ORIGINS:
    ALLOWED_ORIGINS = ["*"]

app = FastAPI(
    docs_url=None if _IS_PROD else "/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["Accept", "Content-Type"],
)

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"]  = "nosniff"
        response.headers["X-Frame-Options"]          = "DENY"
        response.headers["Referrer-Policy"]           = "no-referrer"
        response.headers["Cache-Control"]             = "no-store"
        return response

app.add_middleware(SecurityHeadersMiddleware)

# TTL 환경변수로 조정 가능 (Render 무료: 15분 fresh / 4시간 stale 권장)
_FRESH_TTL = int(os.environ.get("CACHE_TTL",       900))   # 기본 15분
_STALE_TTL = int(os.environ.get("CACHE_STALE_TTL", 14400)) # 기본 4시간

match_cache       = TTLCache(maxsize=64, ttl=_FRESH_TTL)
match_cache_stale = TTLCache(maxsize=64, ttl=_STALE_TTL)

# 동시 크롤링 중복 방지용 lock set
_crawl_in_progress: set[str] = set()

# 간단한 IP별 rate limiter (분당 최대 20회)
_rate_buckets: dict = defaultdict(list)
RATE_LIMIT_PER_MIN = 20

def _check_rate_limit(client_ip: str) -> bool:
    now = time.time()
    bucket = _rate_buckets[client_ip]
    _rate_buckets[client_ip] = [t for t in bucket if now - t < 60]
    if len(_rate_buckets[client_ip]) >= RATE_LIMIT_PER_MIN:
        return False
    _rate_buckets[client_ip].append(now)
    return True

# 대관 가능 구장 화이트리스트 — 구장별 1:1 상세 예약 페이지 연결
# 이 목록에 없는 PLAB/URBAN 구장은 소셜매치 전용 → is_rental: False
RENTAL_WHITELIST: dict[str, dict] = {
    # ── 어반풋볼 대관 파트너 (구장별 상세 페이지) ────────────────
    "어반풋볼파크 사상점":        {"platform_label": "어반풋볼", "rental_url": "https://urbanfootball.co.kr/goods/goods_rent_stadium_view.html?no=2&ref=main"},
    "어반풋볼파크 부산진구점":    {"platform_label": "어반풋볼", "rental_url": "https://urbanfootball.co.kr/goods/goods_rent_stadium_view.html?no=2&ref=main"},
    "어반풋볼파크 부산강서1호점": {"platform_label": "어반풋볼", "rental_url": "https://urbanfootball.co.kr/goods/goods_rent_stadium_view.html?no=15&ref=main"},
    "어반풋볼파크 부산강서2호점": {"platform_label": "어반풋볼", "rental_url": "https://urbanfootball.co.kr/goods/goods_rent_stadium_view.html?no=16&ref=main"},
    "어반풋볼파크 동래금정점":    {"platform_label": "어반풋볼", "rental_url": "https://urbanfootball.co.kr/goods/goods_rent_stadium_view.html?no=17&ref=main"},
    "어반풋볼파크 부산북구점":    {"platform_label": "어반풋볼", "rental_url": "https://urbanfootball.co.kr/goods/goods_rent_stadium_view.html?no=19&ref=main"},
    "어반풋볼파크 양산점":        {"platform_label": "어반풋볼", "rental_url": "https://urbanfootball.co.kr/goods/goods_rent_stadium_view.html?no=20&ref=main"},
    "HM풋살파크 창원점":          {"platform_label": "어반풋볼", "rental_url": "https://urbanfootball.co.kr/goods/goods_rent_stadium_view.html?no=21&ref=main"},
    "BJ풋살파크 마산점":          {"platform_label": "어반풋볼", "rental_url": "https://urbanfootball.co.kr/goods/goods_rent_stadium_view.html?no=22&ref=main"},
    # ── 플랩풋볼 대관 파트너 (구장별 상세 페이지) ────────────────
    # 부산·경남권
    "스포풋살파크":               {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/spo-futsal-park/"},
    "센텀풋살장":                 {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/centum-futsal/"},
    "레인보우풋살파크 사하":      {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/rainbow-futsal-saha/"},
    "BS89 연산":                  {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/112/info/"},
    "백호 풋살파크 만덕":         {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/baekho-futsal-park/"},
    "주레 풋살파크":              {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/3501/info/"},
    "더킥 풋살파크 해운대":       {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/thekick-futsal-haeundae/"},
    "플레이그라운드 풋살클럽":    {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/148/info/"},
    # 수도권 (서울)
    "강동 송파 풋살장":           {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/244/info/"},
    "강북 아크 풋살 스타디움":    {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/3545/info/"},
    "강서 KBS 스포츠월드":        {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/3582/info/"},
    "노원 풋살파크":              {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/nowon-futsal-park/"},
    "마포 상암 풋살파크":         {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/mapo-sangam-futsal/"},
    "성동 왕십리 풋살장":         {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/seongdong-wangsimni-futsal/"},
    # 수도권 (경기)
    "수원 영통 풋살파크":         {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/suwon-yeongdong-futsal/"},
    "성남 야탑 풋살파크":         {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/seongnam-yatap-futsal/"},
    "고양 일산 풋살파크":         {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/goyang-ilsan-futsal/"},
    # 수도권 (서울) 추가
    "관악 풋살파크":              {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/gwanak-futsal-park/"},
    "영등포 풋살파크":            {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/yeongdeungpo-futsal/"},
    "광진 풋살파크":              {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/gwangjin-futsal/"},
    "중랑 풋살파크":              {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/jungnang-futsal-park/"},
    "서초 반포 풋살파크":         {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/seocho-banpo-futsal/"},
    # 수도권 (경기) 추가
    "안양 풋살파크":              {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/anyang-futsal-park/"},
    "부천 풋살파크":              {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/bucheon-futsal-park/"},
    "안산 풋살파크":              {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/ansan-futsal-park/"},
    # 인천
    "인천 부평 풋살장":           {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/incheon-bupyeong-futsal/"},
    # 대구
    "대구 달서 풋살파크":         {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/daegu-dalseo-futsal/"},
    # 대전/세종
    "대전 유성 풋살파크":         {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/daejeon-yuseong-futsal/"},
    # 부산 추가
    "기장 풋살파크":              {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/gijang-futsal-park/"},
    # 경남 추가
    "창원 FC 풋살파크":           {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/rental/venue/changwon-fc-futsal/"},
    # 부산 Plab 추가
    "부산 프로픽 풋볼":           {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/201/info/"},
    "부산 준타스 풋살 아레나":    {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/212/info/"},
    "부산 기장 드림사커 풋살장":  {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/3387/info/"},
    "부산 FC리틀슛 풋살장":       {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/3532/info/"},
    "부산 정관 제이 풋볼아카데미":{"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/3715/info/"},
    "남부환경체육공원축구장":     {"platform_label": "플랩풋볼", "rental_url": "https://www.plabfootball.com/stadium/1177/info/"},
}

# 대관 불가 구장 블랙리스트 — 소셜매치 전용 (리뷰만 표시)
NO_RENTAL_STADIUMS: set[str] = {
    "HM풋살파크 화명점",
}

# 오염된 크롤링 데이터 필터 키워드 — 이벤트/교육/레슨 타이틀 원천 차단
JUNK_FILTER_KEYWORDS: list[str] = [
    "레슨", "훈련", "이벤트", "클래스", "아카데미", "스킬 레슨",
    "일반 스킬", "키즈", "유소년", "교실", "캠프", "클리닉",
]

STADIUM_MAPPING = {
    "어반풋볼파크 부산사상점":        "어반풋볼파크 사상점",
    "어반풋볼파크 부산진구점":        "어반풋볼파크 부산진구점",
    "어반풋볼파크 강서1호점":         "어반풋볼파크 부산강서1호점",
    "어반풋볼파크 강서2호점":         "어반풋볼파크 부산강서2호점",
    "어반풋볼파크 부산동래금정점":    "어반풋볼파크 동래금정점",
    "어반풋볼파크 부산북구점":        "어반풋볼파크 부산북구점",
    "부산 센텀풋살장(구 놀이터클럽)": "센텀풋살장",
    "부산 레인보우풋살파크 사하":     "레인보우풋살파크 사하",
    "부산 BS89 연산(실내)":           "BS89 연산",
    "부산 스포 풋살 파크":            "스포풋살파크",
    "화명생태공원":                   "화명생태공원",
    "어반풋볼파크 양산점":            "어반풋볼파크 양산점",
    "HM풋살파크 창원점":              "HM풋살파크 창원점",
    "BJ풋살파크 마산점":              "BJ풋살파크 마산점",
    # 플랩풋볼 신규 구장 매핑
    "부산 백호 풋살파크 만덕점":      "백호 풋살파크 만덕",
    "부산 주레 풋살파크":             "주레 풋살파크",
    "부산 더킥 풋살파크 해운대":      "더킥 풋살파크 해운대",
    "부산 플레이그라운드 풋살클럽":   "플레이그라운드 풋살클럽",
    "서울 강동 송파 풋살장":          "강동 송파 풋살장",
    "서울 강북 아크 풋살 스타디움 실내": "강북 아크 풋살 스타디움",
    "서울 강북 아크 풋살 스타디움":   "강북 아크 풋살 스타디움",
    "서울 강서 KBS 스포츠월드":       "강서 KBS 스포츠월드",
    "서울 노원 풋살파크":             "노원 풋살파크",
    "서울 마포 상암 풋살파크":        "마포 상암 풋살파크",
    "서울 성동 왕십리 풋살장":        "성동 왕십리 풋살장",
    "경기 수원 영통 풋살파크":        "수원 영통 풋살파크",
    "경기 성남 야탑 풋살파크":        "성남 야탑 풋살파크",
    "경기 고양 일산 풋살파크":        "고양 일산 풋살파크",
    # 추가 플랩 구장 정규화
    "서울 관악 풋살파크":             "관악 풋살파크",
    "서울 영등포 풋살파크":           "영등포 풋살파크",
    "서울 광진 풋살파크":             "광진 풋살파크",
    "서울 중랑 풋살파크":             "중랑 풋살파크",
    "서울 서초 반포 풋살파크":        "서초 반포 풋살파크",
    "경기 안양 풋살파크":             "안양 풋살파크",
    "경기 부천 풋살파크":             "부천 풋살파크",
    "경기 안산 풋살파크":             "안산 풋살파크",
    "인천 부평 풋살장":               "인천 부평 풋살장",
    "부산 기장 풋살파크":             "기장 풋살파크",
    "경남 창원 FC 풋살파크":          "창원 FC 풋살파크",
    # 부산 Plab 추가 구장 정규화
    "남부환경체육공원 축구장":         "남부환경체육공원축구장",
    "부산 남부환경체육공원":           "남부환경체육공원축구장",
}

REGION_MAPPING = {
    "서울":    {"plab": 1,  "urban": 11},
    "경기":    {"plab": 2,  "urban": 11},
    "인천":    {"plab": 3,  "urban": 11},
    "강원":    {"plab": 9,  "urban": None},
    "대전/세종":{"plab": 4, "urban": None},
    "충남":    {"plab": 10, "urban": None},
    "충북":    {"plab": 11, "urban": None},
    "대구":    {"plab": 5,  "urban": 9},
    "경북":    {"plab": 12, "urban": 18},
    "부산":    {"plab": 6,  "urban": 2},
    "울산":    {"plab": 13, "urban": None},
    "경남":    {"plab": 14, "urban": 24},
    "광주":    {"plab": 7,  "urban": None},
    "전남":    {"plab": 15, "urban": None},
    "전북":    {"plab": 16, "urban": None},
    "제주":    {"plab": 8,  "urban": None},
}


def clean_stadium_group_name(raw_name: str) -> str:
    cleaned = raw_name
    for suffix in [" A구장", " B구장", " C구장", " D구장", " E구장", " F구장", " ⚡축구⚡"]:
        cleaned = cleaned.replace(suffix, "")
    cleaned = cleaned.strip()
    for key, val in STADIUM_MAPPING.items():
        if key in cleaned:
            return val
    return cleaned


PUBLIC_VENUE_KEYWORDS = [
    "생태공원", "체육시설", "공공구장", "구덕운동장", "스포원", "황령산레포츠",
    "잠실종합운동장", "어린이대공원", "보라매공원", "뚝섬한강공원", "난지한강공원",
    "수원월드컵", "용인공공", "탄천종합운동장", "인천아시아드", "송도풋살공원",
    "대구스타디움", "상무시민공원", "대전월드컵", "제주월드컵",
    "아시아드", "월드컵경기장",
    "백운포체육공원", "을숙도생태공원", "부산시민공원", "민락수변공원",
    "양산디자인공원", "양산수질정화공원",
    "문수축구경기장", "태화강국가정원",
    "포항효자체육공원", "스틸파크",
    "강릉올림픽파크", "전주월드컵", "광양축구전용구장",
    "팔마종합운동장", "천안종합운동장", "청주종합운동장",
]

def is_public_venue_name(stadium_name: str) -> bool:
    if not stadium_name:
        return False
    for kw in PUBLIC_VENUE_KEYWORDS:
        if kw in stadium_name:
            return True
    return False


def is_junk_data(stadium_name: str) -> bool:
    """오염된 크롤링 데이터 필터: 레슨/교육/이벤트 타이틀 원천 차단"""
    if not stadium_name:
        return True
    name_lower = stadium_name.strip()
    for kw in JUNK_FILTER_KEYWORDS:
        if kw in name_lower:
            return True
    return False


WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일']

def _date_label(schedule_time: datetime.datetime, now: datetime.datetime) -> str:
    days_diff = (schedule_time.date() - now.date()).days
    if days_diff == 0: return "오늘"
    if days_diff == 1: return "내일"
    if days_diff == 2: return "모레"
    if days_diff < 0:  return "기타"
    wd = WEEKDAYS[schedule_time.weekday()]
    return f"{schedule_time.month}/{schedule_time.day}({wd})"


# ── Plab Playwright 크롤링 (PRIMARY) ─────────────────────────
# 실제 Chrome 브라우저를 실행해 Plab 매치 페이지를 탐색하면서
# 자동으로 발생하는 /api/v2/matches/ 응답을 인터셉트합니다.
# 진짜 브라우저이므로 어떤 봇 감지도 우회합니다.

# Plab region_id → 웹사이트 city 파라미터 매핑
PLAB_CITY_MAP = {
    1:"seoul", 2:"gyeonggi", 3:"incheon", 4:"daejeon", 5:"daegu",
    6:"busan", 7:"gwangju", 8:"jeju", 9:"gangwon", 10:"chungnam",
    11:"chungbuk", 12:"gyeongbuk", 13:"ulsan", 14:"gyeongnam",
    15:"jeonnam", 16:"jeonbuk",
}


def _parse_plab_match(m: dict, now: datetime.datetime, future_limit: datetime.datetime) -> dict | None:
    """Plab API 결과 하나를 파싱. 범위 밖이면 None 반환."""
    try:
        schedule_time = datetime.datetime.fromisoformat(m["schedule"])
    except Exception:
        return None

    if not (now <= schedule_time <= future_limit):
        return None

    date_label = _date_label(schedule_time, now)

    is_finish      = m.get("is_finish", False)
    player_cnt     = m.get("player_cnt")
    max_player_cnt = m.get("max_player_cnt")

    if is_finish:
        status = "마감"
    elif player_cnt is not None and max_player_cnt and max_player_cnt > 0:
        status = "마감임박" if (player_cnt / max_player_cnt) >= 0.8 else "신청가능"
    else:
        status = "신청가능"

    raw_stadium = (m.get("stadium_group_name") or m.get("label_stadium")
                   or m.get("label_title") or "")
    stadium_group = clean_stadium_group_name(raw_stadium)
    if is_public_venue_name(stadium_group):
        return None
    if is_junk_data(raw_stadium):
        return None
    if stadium_group in NO_RENTAL_STADIUMS:
        pass  # 소셜매치 데이터는 유지, is_rental만 False로 강제

    return {
        "platform":      "PLAB",
        "stadium":       m.get("label_stadium") or m.get("label_title"),
        "stadium_group": stadium_group,
        "time":          schedule_time.strftime("%m/%d %H:%M"),
        "date_label":    date_label,
        "price":         f"{m.get('fee', 0):,}원",
        "status":        status,
        "link":                  f"https://www.plabfootball.com/match/{m.get('id')}/",
        "is_rental":             bool(RENTAL_WHITELIST.get(stadium_group)) and stadium_group not in NO_RENTAL_STADIUMS,
        "rental_url":            RENTAL_WHITELIST.get(stadium_group, {}).get("rental_url", "") if stadium_group not in NO_RENTAL_STADIUMS else "",
        "rental_platform_label": RENTAL_WHITELIST.get(stadium_group, {}).get("platform_label", "") if stadium_group not in NO_RENTAL_STADIUMS else "",
        "schedule":              schedule_time,
    }


async def fetch_plab_playwright(region_id: int, now: datetime.datetime, days: int = 14) -> list:
    """Playwright 실제 브라우저로 Plab API 인터셉트 크롤링."""
    if not PLAYWRIGHT_AVAILABLE or region_id is None:
        return []

    city        = PLAB_CITY_MAP.get(region_id, "seoul")
    future_limit= now + datetime.timedelta(days=days)
    collected   : list[dict] = []
    seen_ids    : set        = set()

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=True,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-blink-features=AutomationControlled"
                ],
            )
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/122.0.0.0 Safari/537.36"
                ),
                locale="ko-KR",
                viewport={"width": 1280, "height": 900},
            )
            
            # navigator.webdriver 값 우회 스크립트 추가
            await context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            page = await context.new_page()

            # API 응답 인터셉트
            async def on_response(resp):
                try:
                    if "api/v2/matches" in resp.url:
                        data    = await resp.json()
                        results = data.get("results", [])
                        print(f"  [PW] intercepted {len(results)}건 from {resp.url[:120]}")
                        for m in results:
                            mid = m.get("id")
                            if mid and mid not in seen_ids:
                                seen_ids.add(mid)
                                parsed = _parse_plab_match(m, now, future_limit)
                                if parsed:
                                    collected.append(parsed)
                except Exception:
                    pass

            page.on("response", on_response)

            # 매치 목록 페이지로 이동 → API 자동 호출
            try:
                await page.goto(
                    f"https://www.plabfootball.com/match/?city={city}",
                    wait_until="domcontentloaded", timeout=30000,
                )
                await page.wait_for_timeout(2000)
            except Exception as e:
                print(f"  [PW] goto ended: {type(e).__name__}")

            # 스크롤로 추가 데이터 로드 — days가 많을수록 더 많이 스크롤
            scroll_rounds = min(6 + days * 2, 40)
            for _ in range(scroll_rounds):
                await page.keyboard.press("PageDown")
                await page.wait_for_timeout(300)
                await page.keyboard.press("End")
                await page.wait_for_timeout(700)

            await page.wait_for_timeout(1500)
            await browser.close()

    except Exception as e:
        print(f"🚨 [Playwright] {type(e).__name__}: {e}")
        return []

    print(f"✅ [Playwright] region={region_id}({city}) → {len(collected)}건")
    return collected


# ── Plab Football 크롤링 ───────────────────────────────────────
# curl_cffi로 Chrome 120 TLS 핑거프린트 흉내 → Cloudflare 봇 감지 우회
# ordering=schedule (오름차순) → 오늘 경기가 페이지1에 등장
# 3일 초과 경기 발견 즉시 중단

PLAB_HEADERS = {
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer":         "https://www.plabfootball.com/",
    "Origin":          "https://www.plabfootball.com",
    "Sec-Fetch-Dest":  "empty",
    "Sec-Fetch-Mode":  "cors",
    "Sec-Fetch-Site":  "same-origin",
}


def _parse_plab_page(data: list, resp_json: dict, now: datetime.datetime, days: int = 14) -> tuple[list, bool]:
    """results 배열 → (matches, should_stop) 파싱"""
    matches      = []
    future_limit = now + datetime.timedelta(days=days)

    for m in data:
        try:
            schedule_time = datetime.datetime.fromisoformat(m["schedule"])
        except Exception:
            continue

        if schedule_time < now:
            continue
        if schedule_time > future_limit:
            return matches, True

        is_finish      = m.get("is_finish", False)
        player_cnt     = m.get("player_cnt")
        max_player_cnt = m.get("max_player_cnt")

        if is_finish:
            status = "마감"
        elif player_cnt is not None and max_player_cnt and max_player_cnt > 0:
            status = "마감임박" if (player_cnt / max_player_cnt) >= 0.8 else "신청가능"
        else:
            status = "신청가능"

        raw_stadium = (
            m.get("stadium_group_name")
            or m.get("label_stadium")
            or m.get("label_title")
            or ""
        )

        # 오염된 데이터 원천 차단
        if is_junk_data(raw_stadium):
            continue

        _sg = clean_stadium_group_name(raw_stadium)
        _is_rental = bool(RENTAL_WHITELIST.get(_sg)) and _sg not in NO_RENTAL_STADIUMS

        matches.append({
            "platform":      "PLAB",
            "stadium":       m.get("label_stadium") or m.get("label_title"),
            "stadium_group": _sg,
            "time":          schedule_time.strftime("%m/%d %H:%M"),
            "date_label":    _date_label(schedule_time, now),
            "price":         f"{m.get('fee', 0):,}원",
            "status":        status,
            "link":                  f"https://www.plabfootball.com/match/{m.get('id')}/",
            "is_rental":             _is_rental,
            "rental_url":            RENTAL_WHITELIST.get(_sg, {}).get("rental_url", "") if _is_rental else "",
            "rental_platform_label": RENTAL_WHITELIST.get(_sg, {}).get("platform_label", "") if _is_rental else "",
            "schedule":              schedule_time,
        })

    should_stop = not bool(resp_json.get("next"))
    return matches, should_stop


async def fetch_plab_all_pages(region_id: int, now: datetime.datetime, days: int = 14) -> list:
    """curl_cffi + 날짜별 sch 필터로 Plab 데이터 수집. Semaphore(3)으로 병렬 fetch."""
    if region_id is None or not CURL_AVAILABLE:
        return []

    future_limit   = now + datetime.timedelta(days=days)
    dates_to_fetch = [now + datetime.timedelta(days=i) for i in range(days)]
    sem            = asyncio.Semaphore(3)   # 동시 요청 3개 상한

    MAIN_HEADERS = {
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Upgrade-Insecure-Requests": "1",
    }

    all_raw_matches: list = []

    async with CurlSession(impersonate="chrome120") as session:
        try:
            await session.get("https://www.plabfootball.com/", headers=MAIN_HEADERS, timeout=20)
        except Exception as e:
            print(f"⚠️ [Plab] 쿠키 획득 실패: {type(e).__name__}")

        async def fetch_one(target_date: datetime.datetime) -> list:
            date_str = target_date.strftime("%Y-%m-%d")
            url = (f"https://www.plabfootball.com/api/v2/matches/"
                   f"?region={region_id}&sch={date_str}&page_size=200")
            async with sem:
                try:
                    resp = await session.get(url, headers=PLAB_HEADERS, timeout=15)
                    await asyncio.sleep(0.2)   # 슬롯 점유 중 짧은 지연
                    if resp.status_code == 200:
                        results = resp.json().get("results", [])
                        print(f"✅ [Plab curl] {date_str} → {len(results)}건")
                        return results
                    print(f"🚨 [Plab] HTTP {resp.status_code} date={date_str}")
                except Exception as e:
                    print(f"⚠️ [Plab] date={date_str} {type(e).__name__}: {e}")
            return []

        results_list = await asyncio.gather(*[fetch_one(d) for d in dates_to_fetch])
        for r in results_list:
            all_raw_matches.extend(r)

    collected, seen_ids = [], set()
    for m in all_raw_matches:
        mid = m.get("id")
        if mid and mid not in seen_ids:
            seen_ids.add(mid)
            parsed = _parse_plab_match(m, now, future_limit)
            if parsed:
                collected.append(parsed)

    print(f"✅ [Plab curl] 최종 region={region_id} → {len(collected)}건 (days={days})")
    return collected


async def fetch_plab(region_id: int, now: datetime.datetime, days: int = 14) -> list:
    """Plab 통합 진입점.
    1순위 Playwright (실제 Chrome 인터셉트) → 2순위 curl_cffi → 빈 리스트"""
    if region_id is None:
        return []
    if PLAYWRIGHT_AVAILABLE:
        pw_matches = await fetch_plab_playwright(region_id, now, days)
        if pw_matches:
            return pw_matches
        print(f"[Plab] Playwright 0건 → curl_cffi fallback")
    if CURL_AVAILABLE:
        return await fetch_plab_all_pages(region_id, now, days)
    return []


# ── Urban Football 크롤링 ─────────────────────────────────────

async def fetch_urban_day(
    client: httpx.AsyncClient,
    target_date: datetime.datetime,
    area_id: int,
    now: datetime.datetime,
) -> list:
    if area_id is None:
        return []

    url  = "https://www.urbanfootball.co.kr/result/result_get_data.php"
    data = {
        "mode": "get_goods_list",
        "date": target_date.strftime("%Y-%m-%d"),
        "area": str(area_id),
    }
    matches = []
    try:
        response = await client.post(url, data=data, timeout=10.0)
        if response.status_code != 200:
            print(f"🚨 [Urban] HTTP {response.status_code} {target_date.date()}")
            return []

        soup = BeautifulSoup(response.text, "html.parser")

        for ul in soup.find_all("ul", class_="goods_table_item"):
            goods_id = ul.get("data_id")
            if not goods_id:
                continue

            time_str = ul.select_one(".time span").text.strip()
            hour, minute = map(int, time_str.split(":"))

            if hour == 24:
                match_time = (target_date + datetime.timedelta(days=1)).replace(
                    hour=0, minute=minute, second=0, microsecond=0
                )
            else:
                match_time = target_date.replace(
                    hour=hour, minute=minute, second=0, microsecond=0
                )

            name_container = ul.select_one(".name > div:first-child")
            stadium = "어반풋볼"
            for div in name_container.find_all("div"):
                txt = div.text.strip()
                if txt:
                    stadium = txt
                    break

            stadium_group = clean_stadium_group_name(stadium)
            if is_public_venue_name(stadium_group):
                continue
            if is_junk_data(stadium):
                continue

            apply_li = ul.select_one(".apply")
            status   = "신청가능"
            price    = "11,000원"

            if apply_li:
                divs = apply_li.select("div > div")
                if len(divs) >= 2:
                    status = divs[0].text.strip()
                    price  = divs[1].text.strip()
                elif len(divs) == 1:
                    status = divs[0].text.strip()
                    if "마감" in status:
                        price = "마감됨"

            _is_rental = bool(RENTAL_WHITELIST.get(stadium_group)) and stadium_group not in NO_RENTAL_STADIUMS

            matches.append({
                "platform":      "URBAN",
                "stadium":       stadium,
                "stadium_group": stadium_group,
                "time":          match_time.strftime("%m/%d %H:%M"),
                "date_label":    _date_label(match_time, now),
                "price":         price,
                "status":        status,
                "link":                  f"https://www.urbanfootball.co.kr/goods/goods_view.html?goods_no={goods_id}",
                "is_rental":             _is_rental,
                "rental_url":            RENTAL_WHITELIST.get(stadium_group, {}).get("rental_url", "") if _is_rental else "",
                "rental_platform_label": RENTAL_WHITELIST.get(stadium_group, {}).get("platform_label", "") if _is_rental else "",
                "schedule":              match_time,
            })

    except Exception as e:
        print(f"Urban fetch exception {target_date.date()}: {e}")

    return matches


# ── 더미 데이터 ───────────────────────────────────────────────

def get_public_dummy_matches(now: datetime.datetime, region: str) -> list:
    """공공구장 대관 안내 데이터.
    소셜매치가 아닌 실제 대관(팀 사용) 예약 방법을 안내합니다.
    각 항목은 match 형식을 따르되 booking_method/phone/notes 필드를 추가로 포함합니다."""

    # 각 구장: (구장명, 그룹명, 예약방법, URL, 전화번호, 안내메모)
    PUBLIC_DB = {
        "서울": [
            ("잠실종합운동장 제1풋살경기장", "잠실종합운동장",
             "온라인", "https://yeyak.seoul.go.kr/web/reservation/selectReservView.do?rsv_svc_id=S210323104949555583",
             "02-2240-8800", "서울시 체육시설관리사업소 운영. 서울시 공공서비스예약 사이트에서 선착순 접수합니다. 주/야간 대관 가능."),
            ("어린이대공원 풋살경기장", "어린이대공원",
             "온라인", "https://www.sisul.or.kr/open_content/childrenpark/guidance/facility/rent_futsal.jsp",
             "02-450-9200", "서울시설공단 어린이대공원 운영. 공단 예약 페이지에서 매월 지정일에 선착순으로 대관을 신청할 수 있습니다."),
            ("보라매공원 인조잔디구장", "보라매공원",
             "온라인", "https://yeyak.seoul.go.kr/web/main.do",
             "02-2181-1195", "동작구 신대방동 소재. 서울시 공공서비스예약시스템을 통해 사전에 온라인으로 신청해야 사용 가능합니다."),
            ("뚝섬한강공원 축구장/풋살장", "뚝섬한강공원",
             "온라인", "https://yeyak.seoul.go.kr/web/main.do",
             "02-3780-0501", "광진구 자양동 소재. 서울시 공공서비스예약시스템에서 예약이 가능하며 동호회 정기 대관 및 일반 대관을 선착순으로 접수합니다."),
            ("난지한강공원 축구장", "난지한강공원",
             "온라인", "https://yeyak.seoul.go.kr/web/main.do",
             "02-3780-0561", "마포구 상암동 소재 한강공원 구장. 서울시 공공서비스예약을 이용해 일정 선점 및 온라인 결제가 필요합니다."),
        ],
        "부산": [
            ("구덕운동장 풋살장", "구덕운동장",
             "온라인", "https://reserve.busan.go.kr/rent",
             "051-602-2201", "부산광역시 체육시설관리사업소 운영. 구덕운동장 내 풋살 1번구장 등을 부산시 통합예약 서비스에서 신청할 수 있습니다."),
            ("스포원파크 풋살경기장", "스포원파크",
             "온라인", "https://www.spo1.or.kr/",
             "1577-0890", "금정구 두구동 소재. 부산경륜공단(스포원) 공식 홈페이지의 대관 시스템을 통해 온라인 사전 예약 및 결제가 가능합니다."),
            ("화명생태공원 풋살장/축구장", "화명생태공원",
             "온라인", "https://reserve.busan.go.kr/rent/view?resveGroupSn=55&progrmSn=213",
             "051-364-4127", "부산 북구 화명동 소재. 부산광역시 통합예약시스템에서 예약 가능하며 결제 완료 후 대관이 승인됩니다. 낙동강관리본부 관리."),
            ("삼락생태공원 풋살장", "삼락생태공원",
             "온라인", "https://reserve.busan.go.kr/rent",
             "051-303-0048", "부산 사상구 삼락동 소재. 부산시 통합예약시스템에서 신청할 수 있으며, 주말 예약 경쟁률이 높습니다."),
            ("대저생태공원 축구장", "대저생태공원",
             "온라인", "https://reserve.busan.go.kr/rent/view?resveGroupSn=55&progrmSn=216",
             "051-971-6028", "부산 강서구 대저동 소재. 부산시 통합예약시스템을 통해 온라인 신청 및 대관료 납부가 필수적입니다."),
            ("황령산레포츠공원 풋살장", "황령산레포츠공원",
             "온라인", "https://www.busanjin.go.kr/index.busanjin?menuCd=DOM_000001503006000000",
             "051-605-4127", "부산진구 전포동 소재 레포츠공원. 부산진구청 분야별 통합예약 시스템 또는 황령산레포츠공원 웹사이트에서 온라인 접수 가능합니다."),
            ("백운포 체육공원 축구장", "백운포체육공원",
             "온라인", "https://reserve.busan.go.kr/rent",
             "051-607-4000", "부산 남구 용호동 소재. 부산시 통합예약시스템(reserve.busan.go.kr)을 통해 온라인 신청 가능. 천연잔디 및 인조잔디 구장 운영."),
            ("을숙도 생태공원 풋살장", "을숙도생태공원",
             "온라인", "https://reserve.busan.go.kr/rent",
             "051-209-2000", "부산 사하구 낙동남로 소재. 낙동강하구에코센터 관리. 부산시 통합예약시스템에서 신청 가능. 주말·공휴일 예약 경쟁 높음."),
            ("부산시민공원 풋살장", "부산시민공원",
             "온라인", "https://www.citizenpark.or.kr/",
             "051-850-6000", "부산 부산진구 시민공원로 소재. 부산시민공원 공식 홈페이지 또는 전화 문의 후 대관 가능. 인조잔디 풋살구장 운영."),
            ("민락수변공원 풋살장", "민락수변공원",
             "전화", "",
             "051-610-4353", "부산 수영구 민락동 소재. 수영구청 공원관리과 문의 후 대관 신청 가능. 해안 인접 야외 구장."),
            ("기장 일광 체육공원 풋살장", "일광체육공원",
             "전화", "",
             "051-709-4000", "부산 기장군 일광읍 소재. 기장군청 문화체육과 문의. 인조잔디 풋살구장 운영."),
            ("명지 근린공원 축구장", "명지 근린공원",
             "전화", "",
             "051-970-4000", "부산 강서구 명지동 소재. 강서구청 공원녹지과 문의 후 대관. 야외 인조잔디 구장."),
            ("기산공원 풋살장", "기산공원",
             "전화", "",
             "051-310-4000", "부산 사상구 기산동 소재. 사상구청 문화체육과 문의. 야외 풋살 구장."),
            ("남부환경체육공원 축구장", "남부환경체육공원",
             "온라인", "https://www.plabfootball.com/stadium/1177/info/",
             "051-607-4000", "부산 남구 소재. 플랩풋볼을 통한 소셜매치 예약 가능. 야외 잔디 구장."),
        ],
        "경기": [
            ("수원 월드컵경기장 보조구장", "수원월드컵경기장",
             "온라인",  "https://www.suwonworldcup.or.kr/",
             None,          "수원도시재단 운영. 홈페이지 예약"),
            ("용인시 공공체육시설",       "용인공공체육시설",
             "온라인",  "https://publicsports.yongin.go.kr/",
             None,          "용인특례시 공공체육시설 통합예약"),
            ("성남 탄천종합운동장",       "탄천종합운동장",
             "전화",    "",
             "031-729-3584", "성남시 시설관리공단 문의"),
        ],
        "인천": [
            ("인천아시아드 주경기장 보조구장", "인천아시아드",
             "온라인",  "https://www.insiseol.or.kr/",
             None,          "인천시설공단(insiseol.or.kr) 운영"),
            ("송도 풋살공원",             "송도풋살공원",
             "온라인",  "https://www.insiseol.or.kr/",
             None,          "인천시설공단 이용"),
        ],
        "대구": [
            ("대구 스타디움 보조구장",    "대구스타디움",
             "온라인",  "https://www.daegustadium.or.kr/",
             None,          "대구도시공사 운영. 홈페이지 예약"),
        ],
        "광주": [
            ("상무시민공원 풋살장",       "상무시민공원",
             "전화",    "",
             "062-613-5214", "광주 서구청 공원관리과 문의"),
        ],
        "대전/세종": [
            ("대전 월드컵경기장 풋살장",  "대전월드컵경기장",
             "온라인",  "https://www.djstadium.or.kr/",
             None,          "대전도시공사 운영"),
        ],
        "제주": [
            ("제주 월드컵경기장 풋살장",  "제주월드컵경기장",
             "전화",    "",
             "064-727-2002", "제주시설공단 문의"),
        ],
        "울산": [
            ("울산 문수축구경기장 보조구장", "문수축구경기장",
             "온라인", "https://www.ulsansisul.or.kr/",
             "052-289-2000", "울산 남구 문수로 소재. 울산시설공단 운영. 홈페이지 또는 전화로 보조구장 및 풋살구장 대관 신청 가능."),
            ("울산 태화강국가정원 운동장", "태화강국가정원",
             "전화", "",
             "052-229-4500", "울산 중구 태화동 소재. 태화강국가정원 관리사무소 문의. 야외 운동장 대관 가능."),
        ],
        "경남": [
            ("양산 디자인공원 축구장", "양산디자인공원",
             "온라인", "https://www.yangsan.go.kr/",
             "055-392-2114", "경남 양산시 물금읍 소재. 양산시 공공체육시설 예약 시스템을 통해 온라인 대관 신청 가능. 인조잔디 축구장 운영."),
            ("양산 수질정화공원 축구장", "양산수질정화공원",
             "온라인", "https://www.yangsan.go.kr/",
             "055-392-2000", "경남 양산시 소재. 양산시 공공체육시설 통합예약 시스템에서 사전 신청 필요. 주말 이용률이 높으므로 조기 예약 권장."),
            ("창원 성산구 공공체육시설 풋살장", "창원성산공공체육",
             "온라인", "https://facility.changwon.go.kr/",
             "055-225-3750", "경남 창원시 성산구 소재. 창원시 공공체육시설 통합예약(facility.changwon.go.kr)에서 신청 가능."),
            ("김해 풋살경기장", "김해시공공풋살",
             "전화", "",
             "055-330-4761", "경남 김해시 소재 공공 풋살장. 김해시 생활체육과 문의 후 예약 가능."),
            ("거제시 공공 풋살경기장", "거제공공풋살",
             "전화", "",
             "055-639-3322", "경남 거제시 소재 공공 풋살·축구장. 거제시 체육진흥과 문의."),
            ("진주 종합경기장 보조구장", "진주종합경기장",
             "전화", "",
             "055-749-2114", "경남 진주시 소재. 진주시 체육시설관리사업소 문의. 풋살 및 보조구장 대관 가능."),
        ],
        "경북": [
            ("포항 효자체육공원 풋살장", "포항효자체육공원",
             "온라인", "https://www.pohang.go.kr/",
             "054-270-3114", "경북 포항시 남구 효자동 소재. 포항시 공공체육시설 예약 시스템에서 신청 가능."),
            ("경주 황성공원 풋살장", "경주황성공원",
             "전화", "",
             "054-779-6114", "경북 경주시 황성동 소재. 경주시 공원관리사업소 문의. 인조잔디 풋살장 운영."),
            ("구미 금오체육공원 풋살장", "금오체육공원",
             "온라인", "https://www.gumi.go.kr/",
             "054-480-2114", "경북 구미시 소재. 구미시 공공체육시설 통합예약에서 신청 가능."),
        ],
        "강원": [
            ("강릉 올림픽파크 풋살장", "강릉올림픽파크",
             "온라인", "https://www.gn-olympicpark.or.kr/",
             "033-650-3000", "강원 강릉시 소재. 2018 평창올림픽 레거시 시설. 강릉올림픽파크 공식 홈페이지에서 대관 신청 가능."),
            ("춘천 종합운동장 보조구장", "춘천종합운동장",
             "전화", "",
             "033-250-4114", "강원 춘천시 소재. 춘천시 시설관리공단 문의. 보조구장 및 풋살장 대관 가능."),
            ("원주 종합운동장 풋살장", "원주종합운동장",
             "전화", "",
             "033-737-2114", "강원 원주시 소재. 원주시 체육시설관리공단 문의."),
        ],
        "전북": [
            ("전주 월드컵경기장 보조구장", "전주월드컵경기장",
             "온라인", "https://www.jjworldcup.or.kr/",
             "063-228-2002", "전북 전주시 덕진구 소재. 전주월드컵경기장 관리사무소에서 대관 신청 가능."),
            ("군산 월명체육관 인조잔디구장", "군산월명체육관",
             "전화", "",
             "063-454-3310", "전북 군산시 소재. 군산시 시설관리공단 문의."),
        ],
        "전남": [
            ("광양 축구전용구장 보조구장", "광양축구전용구장",
             "전화", "",
             "061-797-2114", "전남 광양시 소재. 전남 드래곤즈 홈구장 인근. 광양시 체육진흥과 문의."),
            ("순천 팔마종합운동장 보조구장", "팔마종합운동장",
             "전화", "",
             "061-749-3400", "전남 순천시 소재. 순천시 시설관리공단 팔마종합운동장 문의. 보조구장 및 풋살장 대관."),
        ],
        "충남": [
            ("천안 종합운동장 풋살장", "천안종합운동장",
             "온라인", "https://sport.cheonan.go.kr/",
             "041-521-3020", "충남 천안시 소재. 천안시 공공스포츠클럽 예약 시스템에서 신청 가능."),
            ("아산 이순신종합운동장 보조구장", "아산이순신종합운동장",
             "전화", "",
             "041-537-2114", "충남 아산시 소재. 아산시 시설관리공단 문의."),
        ],
        "충북": [
            ("청주 종합운동장 풋살장", "청주종합운동장",
             "온라인", "https://sport.cheongju.go.kr/",
             "043-201-1114", "충북 청주시 소재. 청주시 공공체육시설 통합예약 시스템에서 신청 가능."),
        ],
    }

    # 아이엠그라운드 — 전국 공통 (사설구장 포함 대관 플랫폼)
    IAG_REGION_MAP = {
        "서울": "seoul", "경기": "gyeonggi", "인천": "incheon",
        "부산": "busan",  "대구": "daegu",    "광주": "gwangju",
        "대전/세종": "daejeon", "울산": "ulsan", "강원": "gangwon",
        "충북": "chungbuk", "충남": "chungnam", "경북": "gyeongbuk",
        "경남": "gyeongnam", "전북": "jeonbuk", "전남": "jeonnam",
        "제주": "jeju",
    }
    iag_city = IAG_REGION_MAP.get(region, "seoul")

    dummy_time = now.replace(hour=0, minute=0, second=0, microsecond=0)
    entries    = PUBLIC_DB.get(region, [])
    matches    = []

    # 아이엠그라운드 통합 대관 링크 (지역별)
    matches.append({
        "platform":       "PUBLIC",
        "stadium":        f"아이엠그라운드 — {region} 구장 찾기",
        "stadium_group":  "아이엠그라운드",
        "time":           "전국 800+ 구장",
        "date_label":     "상시 대관",
        "price":          "구장별 상이",
        "status":         "대관 가능",
        "link":           f"https://www.iamground.kr/futsal/search?city={iag_city}",
        "booking_method": "온라인",
        "phone":          None,
        "notes":          "전국 800여개 풋살·축구장 즉시 예약. 앱/웹 모두 가능.",
        "is_rental":             True,
        "rental_url":            f"https://www.iamground.kr/futsal/search?city={iag_city}",
        "rental_platform_label": "아이엠그라운드",
        "schedule":              dummy_time,
    })

    for (full_name, group_name, method, url, phone, notes) in entries:
        matches.append({
            "platform":              "PUBLIC",
            "stadium":               full_name,
            "stadium_group":         group_name,
            "time":                  "대관 가능",
            "date_label":            "상시 대관",
            "price":                 "대관료 확인",
            "status":                "대관 가능",
            "link":                  url,
            "booking_method":        method,
            "phone":                 phone,
            "notes":                 notes,
            "is_rental":             True,
            "rental_url":            url,
            "rental_platform_label": "공공예약",
            "schedule":              dummy_time,
        })

    return matches


def get_plab_dummy_matches(now: datetime.datetime, region: str) -> list:
    STADIUMS = {
        "서울":    ["용산 아이파크몰 더베이스 A구장", "용산 아이파크몰 더베이스 B구장", "동대문 풋살장"],
        "경기":    ["수원 어반풋볼파크 A구장", "수원 어반풋볼파크 B구장", "일산 킨텍스 풋살장"],
        "부산":    ["부산 스포 풋살 파크 A구장", "부산 스포 풋살 파크 B구장", "부산 센텀풋살장 A구장", "부산 센텀풋살장 B구장", "해운대 카파 풋살구장"],
        "대구":    ["대구 알리안츠 풋살파크 A구장", "대구 알리안츠 풋살파크 B구장"],
        "인천":    ["인천 유나이티드 풋살장", "인천 가좌 풋살파크 A구장", "인천 가좌 풋살파크 B구장"],
        "광주":    ["광주 챔피언스 풋살파크"],
        "대전/세종":["대전 제일풋살파크"],
        "제주":    ["제주 드림풋살파크"],
    }

    region_stadiums = STADIUMS.get(region, [f"{region} 플랩풋살파크 A구장", f"{region} 플랩풋살파크 B구장"])
    matches = []

    for i, stadium in enumerate(region_stadiums):
        match_time = (now + datetime.timedelta(days=i % 3)).replace(
            hour=18 + (i % 4), minute=0, second=0, microsecond=0
        )
        matches.append({
            "platform":      "PLAB",
            "stadium":       stadium,
            "stadium_group": clean_stadium_group_name(stadium),
            "time":          match_time.strftime("%m/%d %H:%M"),
            "date_label":    _date_label(match_time, now),
            "price":         "10,000원",
            "status":                "신청가능" if i % 3 != 2 else "마감임박",
            "link":                  "https://www.plabfootball.com/",
            "is_rental":             False,
            "rental_url":            "",
            "rental_platform_label": "",
            "schedule":              match_time,
        })
    return matches


# ── Urban 지역 자동 탐색 (서버 시작 시 1회) ──────────────────
# 현재 REGION_MAPPING에 urban: None 인 지역들의 area_id를 자동으로 찾습니다.
# Urban Football은 현재 부산(2) 중심으로 운영되므로 area 1~10을 탐색합니다.

_urban_probe_done = False

async def probe_urban_areas_once():
    """서버 최초 요청 시 Urban area ID 자동 탐색 (1회만)"""
    global _urban_probe_done
    if _urban_probe_done:
        return
    _urban_probe_done = True

    today = datetime.date.today().isoformat()
    found = {}
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"}

    async with httpx.AsyncClient(headers=headers) as client:
        tasks = []
        for aid in range(1, 11):
            tasks.append(_check_urban_area(client, aid, today))
        results = await asyncio.gather(*tasks, return_exceptions=True)

    for aid, result in zip(range(1, 11), results):
        if isinstance(result, str) and result:
            found[result] = aid

    if found:
        print(f"✅ [Urban] 유효 지역 발견: {found}")
        # REGION_MAPPING 업데이트 (None인 항목 채움)
        for region_name, area_id in found.items():
            if region_name in REGION_MAPPING and REGION_MAPPING[region_name]["urban"] is None:
                REGION_MAPPING[region_name]["urban"] = area_id


async def _check_urban_area(client, area_id: int, date_str: str):
    """Urban area_id가 유효한지 확인 후 대응 지역명 반환"""
    try:
        r = await client.post(
            "https://www.urbanfootball.co.kr/result/result_get_data.php",
            data={"mode": "get_goods_list", "date": date_str, "area": str(area_id)},
            timeout=6.0
        )
        if r.status_code != 200:
            return None
        soup = BeautifulSoup(r.text, "html.parser")
        items = soup.find_all("ul", class_="goods_table_item")
        if not items:
            return None
        # 첫 구장명에서 지역을 추측
        name_div = items[0].select_one(".name > div:first-child div")
        raw = name_div.text.strip() if name_div else ""
        # 간단 지역 추측
        for kw, region in [("서울","서울"),("부산","부산"),("대구","대구"),("인천","인천"),
                            ("광주","광주"),("대전","대전/세종"),("울산","울산"),("경기","경기"),
                            ("경남","경남"),("경북","경북"),("강원","강원"),("제주","제주")]:
            if kw in raw:
                return region
        return f"urban_{area_id}"  # 매핑 안 되면 임시 키
    except Exception:
        return None


# ── API 엔드포인트 ────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "playwright": PLAYWRIGHT_AVAILABLE,
        "curl_cffi":  CURL_AVAILABLE,
        "cached_regions": list(match_cache.keys()),
        "stale_regions":  list(match_cache_stale.keys()),
    }


async def _do_crawl(region: str, days: int) -> list:
    """실제 크롤링 수행 → 정렬된 매치 리스트 반환"""
    now        = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9)))
    region_ids = REGION_MAPPING[region]
    plab_id    = region_ids["plab"]
    urban_id   = region_ids["urban"]
    all_matches: list = []

    plab_matches = await fetch_plab(plab_id, now, days)
    all_matches.extend(plab_matches)
    if not plab_matches:
        all_matches.extend(get_plab_dummy_matches(now, region))

    target_dates = [now + datetime.timedelta(days=i) for i in range(days)]
    ua_headers   = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    }
    urban_sem = asyncio.Semaphore(4)

    async def _urban(client, d):
        async with urban_sem:
            return await fetch_urban_day(client, d, urban_id, now)

    async with httpx.AsyncClient(headers=ua_headers) as client:
        for r in await asyncio.gather(*[_urban(client, d) for d in target_dates],
                                      return_exceptions=True):
            if isinstance(r, list):
                all_matches.extend(r)

    all_matches.extend(get_public_dummy_matches(now, region))
    all_matches.sort(key=lambda x: x["schedule"])
    for m in all_matches:
        del m["schedule"]

    return all_matches


async def _refresh_cache(cache_key: str, region: str, days: int) -> None:
    """백그라운드 캐시 갱신 — 동일 key 중복 실행 방지"""
    if cache_key in _crawl_in_progress:
        return
    _crawl_in_progress.add(cache_key)
    try:
        data = await _do_crawl(region, days)
        if data:
            match_cache[cache_key]       = data
            match_cache_stale[cache_key] = data
            print(f"✅ [BG Refresh] {cache_key} → {len(data)}건")
    except Exception as e:
        print(f"🚨 [BG Refresh Error] {cache_key}: {e}")
    finally:
        _crawl_in_progress.discard(cache_key)


@app.get("/api/matches")
async def get_all_matches(
    request: Request,
    region: str = Query(default="서울", max_length=20),
    days: int   = Query(default=14, ge=3, le=30),
):
    client_ip = request.client.host if request.client else "unknown"
    if not _check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Too many requests. Please wait a moment.")
    if region not in REGION_MAPPING:
        raise HTTPException(status_code=400, detail=f"지원하지 않는 지역: {region}")

    asyncio.create_task(probe_urban_areas_once())
    cache_key = f"matches_{region}_{days}"

    # ① Fresh cache → 즉시 반환
    if cache_key in match_cache:
        print(f"[Cache] Fresh: {cache_key}")
        return {"status": "success", "data": match_cache[cache_key]}

    # ② Stale cache → 즉시 반환 + 백그라운드 갱신 (stale-while-revalidate)
    if cache_key in match_cache_stale:
        print(f"[Cache] Stale: {cache_key} → BG refresh 시작")
        asyncio.create_task(_refresh_cache(cache_key, region, days))
        return {"status": "success", "data": match_cache_stale[cache_key]}

    # ③ 완전 미스 + 이미 크롤링 중 → 최대 45초 대기 후 캐시 확인
    if cache_key in _crawl_in_progress:
        for _ in range(45):
            await asyncio.sleep(1)
            if cache_key in match_cache:
                return {"status": "success", "data": match_cache[cache_key]}
        raise HTTPException(status_code=503, detail="크롤링 대기 중입니다. 잠시 후 다시 시도해 주세요.")

    # ④ 완전 미스 → 직접 크롤링 (최초 1회)
    _crawl_in_progress.add(cache_key)
    try:
        data = await _do_crawl(region, days)
    finally:
        _crawl_in_progress.discard(cache_key)

    if not data:
        return {"status": "error", "message": f"'{region}' 지역 매치 없음"}

    match_cache[cache_key]       = data
    match_cache_stale[cache_key] = data
    return {"status": "success", "data": data}


# ── 프론트엔드 서빙 ───────────────────────────────────────────
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse
from urllib.parse import urlencode

# .env에서 로드, 없으면 로컬 개발용 기본값
_KAKAO_APP_KEY  = os.environ.get("KAKAO_APP_KEY", "30d61422e38612b247c57f3942a111bd")
_KAKAO_REST_KEY = os.environ.get("KAKAO_REST_API_KEY", "")
_KAKAO_CLIENT_SECRET = os.environ.get("KAKAO_CLIENT_SECRET", "")
_KAKAO_REDIRECT = os.environ.get(
    "KAKAO_REDIRECT_URI", "http://127.0.0.1:8000/api/auth/kakao/callback"
)
_KAKAO_ADMIN_KEY = os.environ.get("KAKAO_ADMIN_KEY", "")
_KAKAO_ID_MAP: dict[str, str] = {}      # kakao_id → session token
_OAUTH_STATES: dict[str, float] = {}    # state → created_at (epoch)
_STATE_TTL = 600                         # 10분 유효

def _new_oauth_state() -> str:
    now = time.time()
    expired = [k for k, v in list(_OAUTH_STATES.items()) if now - v > _STATE_TTL]
    for k in expired:
        _OAUTH_STATES.pop(k, None)
    state = secrets.token_urlsafe(32)
    _OAUTH_STATES[state] = now
    return state

def _validate_oauth_state(state: str) -> bool:
    ts = _OAUTH_STATES.pop(state, None)
    if ts is None:
        return False
    return (time.time() - ts) <= _STATE_TTL

def _get_dynamic_redirect_uri(request: Request) -> str:
    host = request.headers.get("host", "")
    forwarded_proto = request.headers.get("x-forwarded-proto", "")
    is_local = any(h in host for h in ("localhost", "127.0.0.1", "0.0.0.0"))
    if is_local:
        scheme = "http"
    elif forwarded_proto:
        scheme = forwarded_proto
    else:
        scheme = "https"
    return f"{scheme}://{host}/api/auth/kakao/callback"
_HTML_PATH      = Path(__file__).parent / "index.html"

@app.get("/api/config")
async def get_api_config(request: Request):
    """프론트엔드가 Kakao 앱키를 동적으로 가져가는 엔드포인트"""
    client_ip = request.client.host if request.client else "unknown"
    if not _check_rate_limit(client_ip):
        raise HTTPException(status_code=429, detail="Too many requests")
    return {"kakao_app_key": _KAKAO_APP_KEY}

@app.get("/", response_class=HTMLResponse)
async def serve_index(request: Request):
    if not _HTML_PATH.exists():
        raise HTTPException(status_code=404, detail="index.html not found")
    html = _HTML_PATH.read_text(encoding="utf-8")
    return HTMLResponse(content=html, headers={
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options":         "DENY",
        "Cache-Control":           "no-store",
    })

@app.get("/main.js")
async def serve_js():
    p = Path(__file__).parent / "main.js"
    return FileResponse(p, media_type="application/javascript")


import uuid as _jochuk_uuid
from asyncio import Lock as _JochukLock
from typing import Optional as _JOpt
from pydantic import BaseModel as _JModel


def _jid()  -> str: return str(_jochuk_uuid.uuid4())
def _jnow() -> str: return datetime.datetime.now(datetime.timezone.utc).isoformat()



# ═══════════════════════════════════════════════════════════════════
# 🏟️  구장 매칭판 — 로그인 · 팀매칭 · 용병모집 · 리뷰 (venue 기반)
# ═══════════════════════════════════════════════════════════════════

_VP_SESSIONS: dict[str, dict] = {}   # token → user
_VP_MATCHES:  dict[str, list] = {}   # venue_id → [team_match]
_VP_RECRUIT:  dict[str, list] = {}   # venue_id → [recruit]
_VP_REVIEWS:  dict[str, list] = {}   # venue_id → [review]
_VP_REC_LOCK = _JochukLock()


def _vp_user(token: str) -> dict:
    u = _VP_SESSIONS.get(token)
    if not u: raise HTTPException(401, "로그인이 필요합니다")
    return u


class _VPMatchIn(_JModel):
    token:       str
    match_date:  str
    size:        str = "5vs5"
    skill_level: str = "중급"
    fee_policy:  str = "50_50"
    contact_url: str
    memo:        str = ""

class _VPRecruitIn(_JModel):
    token:           str
    match_date:      str
    max_players:     int = 10
    fee_per_person:  int = 0
    size:            str = "5vs5"
    contact_url:     str
    memo:            str = ""

class _VPJoinIn(_JModel):
    token: str

class _VPReviewIn(_JModel):
    token:   str
    turf:    str   # 상|중|하
    manner:  str   # 상|중|하
    comment: str


@app.get("/api/auth/me")
async def vp_me(token: str):
    return {"status": "success", "data": _vp_user(token)}


# ── 카카오 OAuth ─────────────────────────────────────────────────

@app.get("/api/auth/kakao/login")
async def kakao_oauth_start(request: Request):
    if not _KAKAO_REST_KEY:
        raise HTTPException(503, "KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다")
    redirect_uri = _get_dynamic_redirect_uri(request)
    state = _new_oauth_state()
    q = urlencode({
        "client_id":     _KAKAO_REST_KEY,
        "redirect_uri":  redirect_uri,
        "response_type": "code",
        "state":         state,
    })
    return RedirectResponse(f"https://kauth.kakao.com/oauth/authorize?{q}")


@app.get("/api/auth/kakao/callback")
async def kakao_oauth_callback(
    request: Request,
    code: str = Query(...),
    state: str = Query(None),
    format: str = Query(None),
):
    redirect_uri = _get_dynamic_redirect_uri(request)

    def _err(msg: str):
        if format == "json":
            raise HTTPException(400, detail=msg)
        msg_j = json.dumps(msg, ensure_ascii=False)
        return HTMLResponse(
            f'<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;'
            f'text-align:center;padding:60px;background:#fef2f2;">'
            f'<p style="font-size:2rem;margin-bottom:12px;">⚠️</p>'
            f'<p style="font-weight:700;color:#dc2626;margin-bottom:6px;">로그인 오류</p>'
            f'<p style="font-size:13px;color:#64748b;">{msg}</p>'
            f'<script>'
            f'var _to=(location.hostname==="localhost"||location.hostname==="127.0.0.1")?'
            f'"http://"+location.host:location.origin;'
            f'if(window.opener&&!window.opener.closed){{'
            f'window.opener.postMessage({{type:"KAKAO_LOGIN_ERR",msg:{msg_j}}},_to);'
            f'}}'
            f'setTimeout(function(){{window.close();}},2000);'
            f'</script></body></html>'
        )

    # 0. CSRF state 검증
    if not state or not _validate_oauth_state(state):
        return _err("잘못된 요청입니다 (CSRF 검증 실패). 다시 로그인해 주세요.")

    # 1. 인가 코드 → 액세스 토큰
    # REST API 키는 클라이언트 시크릿 기본 활성화 상태 → client_secret 필수 포함
    token_data = {
        "grant_type": "authorization_code",
        "client_id": _KAKAO_REST_KEY,
        "redirect_uri": redirect_uri,
        "code": code,
        "client_secret": _KAKAO_CLIENT_SECRET,
    }

    async with httpx.AsyncClient() as cl:
        tr = await cl.post(
            "https://kauth.kakao.com/oauth/token",
            data=token_data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10,
        )
    if tr.status_code != 200:
        return _err(f"토큰 발급 실패 (상태코드: {tr.status_code}, 상세: {tr.text})")
    access_token = tr.json().get("access_token", "")

    # 2. 액세스 토큰 → 사용자 정보
    async with httpx.AsyncClient() as cl:
        mr = await cl.get(
            "https://kapi.kakao.com/v2/user/me",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10,
        )
    if mr.status_code != 200:
        return _err(f"사용자 정보 조회 실패 (상태코드: {mr.status_code}, 상세: {mr.text})")

    me       = mr.json()
    kakao_id = str(me["id"])
    profile  = me.get("kakao_account", {}).get("profile", {})
    nickname = (profile.get("nickname")
                or me.get("properties", {}).get("nickname", "카카오유저"))
    avatar   = (profile.get("thumbnail_image_url")
                or me.get("properties", {}).get("thumbnail_image", ""))

    # 3. 기존 세션 재사용 또는 신규 생성 (is_new 플래그로 신규 여부 판별)
    is_new = kakao_id not in _KAKAO_ID_MAP
    if not is_new:
        token = _KAKAO_ID_MAP[kakao_id]
        if token in _VP_SESSIONS:
            _VP_SESSIONS[token].update({"nickname": nickname, "avatar": avatar})
    else:
        token = _jid()
        _KAKAO_ID_MAP[kakao_id] = token

    prev = _VP_SESSIONS.get(token, {})
    user = {
        "token":            token,
        "nickname":         nickname,
        "kakao_id":         kakao_id,
        "avatar":           avatar,
        "region":           prev.get("region", ""),
        "position":         prev.get("position", "올포지션"),
        "skill":            prev.get("skill", ""),
        "profile_complete": prev.get("profile_complete", False),
    }
    _VP_SESSIONS[token] = user

    if format == "json":
        return user

    # 4. 팝업 창에서 부모 창으로 postMessage 후 자동 닫기
    user_json = json.dumps(user, ensure_ascii=False)
    return HTMLResponse(f"""<!doctype html>
<html><head><meta charset="utf-8"><title>카카오 로그인</title>
<style>*{{margin:0;padding:0;box-sizing:border-box;}}
body{{font-family:'Apple SD Gothic Neo',sans-serif;background:#f8fafc;
     display:flex;align-items:center;justify-content:center;min-height:100vh;}}
.card{{background:white;border-radius:24px;padding:40px 32px;text-align:center;
       box-shadow:0 20px 60px rgba(0,0,0,0.12);max-width:280px;width:90%;}}
</style></head>
<body>
<div class="card">
  <div style="font-size:3rem;margin-bottom:16px;">⚽</div>
  <p style="font-weight:900;font-size:18px;color:#1e293b;margin-bottom:8px;">카카오 로그인 완료!</p>
  <p style="font-size:13px;color:#94a3b8;">잠시 후 창이 닫힙니다...</p>
</div>
<script>
(function(){{
  var u={user_json};
  var _to=(location.hostname==='localhost'||location.hostname==='127.0.0.1')
    ?'http://'+location.host:location.origin;
  try{{
    if(window.opener&&!window.opener.closed){{
      window.opener.postMessage({{type:'KAKAO_LOGIN_DONE',user:u}},_to);
    }}else{{
      localStorage.setItem('pm_user',JSON.stringify(u));
      window.location.replace('/');
      return;
    }}
  }}catch(e){{}}
  setTimeout(function(){{window.close();}},1500);
}})();
</script>
</body></html>""")


# ── 프로필 업데이트 (카카오 로그인 후 지역·포지션 설정) ─────────

class _VPProfileIn(_JModel):
    token:          str
    nickname:       str = ""
    region:         str
    position:       str = "올포지션"
    plab_level:     str = ""
    urban_level:    str = ""
    football_skill: str = ""

@app.patch("/api/auth/me")
async def vp_update_profile(b: _VPProfileIn):
    u = _vp_user(b.token)
    if b.nickname.strip():
        u["nickname"] = b.nickname.strip()
    u["region"]           = b.region
    u["position"]         = b.position
    u["plab_level"]       = b.plab_level
    u["urban_level"]      = b.urban_level
    u["football_skill"]   = b.football_skill
    u["profile_complete"] = True
    return {"status": "success", "data": u}


# ── 회원 탈퇴 / 카카오 연결 끊기 ─────────────────────────────────

class _VPWithdrawIn(_JModel):
    token: str

@app.post("/api/auth/kakao/withdraw")
async def kakao_withdraw(b: _VPWithdrawIn):
    u = _vp_user(b.token)          # 세션 없으면 401 자동 raise
    kakao_id = u.get("kakao_id", "")

    # 1. 카카오 연결 끊기 (admin key 방식 — access token 불필요)
    if kakao_id and _KAKAO_ADMIN_KEY:
        async with httpx.AsyncClient() as cl:
            await cl.post(
                "https://kapi.kakao.com/v1/user/unlink",
                headers={"Authorization": f"KakaoAK {_KAKAO_ADMIN_KEY}"},
                data={"target_id_type": "user_id", "target_id": kakao_id},
                timeout=10,
            )

    # 2. 서버 내 사용자 데이터 파기 (개인정보 보호법 제21조)
    _VP_SESSIONS.pop(b.token, None)
    if kakao_id:
        _KAKAO_ID_MAP.pop(kakao_id, None)

    return {"status": "success", "message": "탈퇴가 완료되었습니다."}


# ── 구장별 팀 매칭 ───────────────────────────────────────────────
@app.get("/api/venue/{vid}/matches")
async def vp_matches_list(vid: str):
    return {"status": "success", "data": _VP_MATCHES.get(vid, [])}

@app.post("/api/venue/{vid}/matches")
async def vp_matches_create(vid: str, b: _VPMatchIn):
    u   = _vp_user(b.token)
    doc = {**b.dict(), "id": _jid(), "created_by": u["nickname"],
           "status": "open", "created_at": _jnow()}
    _VP_MATCHES.setdefault(vid, []).append(doc)
    return {"status": "success", "data": doc}


# ── 구장별 용병 모집 ─────────────────────────────────────────────
@app.get("/api/venue/{vid}/recruit")
async def vp_recruit_list(vid: str):
    out = [r for r in _VP_RECRUIT.get(vid, [])
           if r["current_players"] < r["max_players"]]
    return {"status": "success", "data": out}

@app.post("/api/venue/{vid}/recruit")
async def vp_recruit_create(vid: str, b: _VPRecruitIn):
    u   = _vp_user(b.token)
    doc = {**b.dict(), "id": _jid(), "created_by": u["nickname"],
           "current_players": 1, "participants": [u["nickname"]],
           "created_at": _jnow()}
    _VP_RECRUIT.setdefault(vid, []).append(doc)
    return {"status": "success", "data": doc}

@app.post("/api/venue/{vid}/recruit/{rid}/join")
async def vp_recruit_join(vid: str, rid: str, b: _VPJoinIn):
    async with _VP_REC_LOCK:
        u = _vp_user(b.token)
        posts = _VP_RECRUIT.get(vid, [])
        post  = next((p for p in posts if p["id"] == rid), None)
        if not post: raise HTTPException(404, "모집글 없음")
        if post["current_players"] >= post["max_players"]: raise HTTPException(400, "인원 마감")
        if u["nickname"] in post["participants"]:           raise HTTPException(400, "이미 참가")
        post["current_players"] += 1
        post["participants"].append(u["nickname"])
        return {"status": "success", "data": {"current_players": post["current_players"]}}


# ── 구장별 리뷰 ──────────────────────────────────────────────────
@app.get("/api/venue/{vid}/reviews")
async def vp_reviews_list(vid: str):
    return {"status": "success", "data": _VP_REVIEWS.get(vid, [])}

@app.post("/api/venue/{vid}/reviews")
async def vp_reviews_create(vid: str, b: _VPReviewIn):
    u   = _vp_user(b.token)
    doc = {"id": _jid(), "nickname": u["nickname"], "region": u["region"],
           "turf": b.turf, "manner": b.manner, "comment": b.comment,
           "created_at": _jnow()}
    _VP_REVIEWS.setdefault(vid, []).append(doc)
    return {"status": "success", "data": doc}


if __name__ == "__main__":
    is_prod = os.environ.get("ENV") == "production"
    host    = "0.0.0.0" if is_prod else "127.0.0.1"
    port    = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host=host, port=port, reload=not is_prod)
