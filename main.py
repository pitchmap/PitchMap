import asyncio
import datetime
import os
import re
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
    "아시아드", "월드컵경기장"
]

def is_public_venue_name(stadium_name: str) -> bool:
    if not stadium_name:
        return False
    for kw in PUBLIC_VENUE_KEYWORDS:
        if kw in stadium_name:
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

    return {
        "platform":      "PLAB",
        "stadium":       m.get("label_stadium") or m.get("label_title"),
        "stadium_group": stadium_group,
        "time":          schedule_time.strftime("%m/%d %H:%M"),
        "date_label":    date_label,
        "price":         f"{m.get('fee', 0):,}원",
        "status":        status,
        "link":          f"https://www.plabfootball.com/match/{m.get('id')}/",
        "schedule":      schedule_time,
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

        matches.append({
            "platform":      "PLAB",
            "stadium":       m.get("label_stadium") or m.get("label_title"),
            "stadium_group": clean_stadium_group_name(raw_stadium),
            "time":          schedule_time.strftime("%m/%d %H:%M"),
            "date_label":    _date_label(schedule_time, now),
            "price":         f"{m.get('fee', 0):,}원",
            "status":        status,
            "link":          f"https://www.plabfootball.com/match/{m.get('id')}/",
            "schedule":      schedule_time,
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

            matches.append({
                "platform":      "URBAN",
                "stadium":       stadium,
                "stadium_group": stadium_group,
                "time":          match_time.strftime("%m/%d %H:%M"),
                "date_label":    _date_label(match_time, now),
                "price":         price,
                "status":        status,
                "link":          f"https://www.urbanfootball.co.kr/goods/goods_view.html?goods_no={goods_id}",
                "schedule":      match_time,
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
             "온라인", "https://reserve.busan.go.kr/rent",
             "051-364-4127", "부산 북구 화명동 소재. 부산광역시 통합예약시스템에서 예약 가능하며 결제 완료 후 대관이 승인됩니다. 낙동강관리본부 관리."),
            ("삼락생태공원 풋살장", "삼락생태공원",
             "온라인", "https://reserve.busan.go.kr/rent",
             "051-303-0048", "부산 사상구 삼락동 소재. 부산시 통합예약시스템에서 신청할 수 있으며, 주말 예약 경쟁률이 높습니다."),
            ("대저생태공원 축구장", "대저생태공원",
             "온라인", "https://reserve.busan.go.kr/rent",
             "051-971-6028", "부산 강서구 대저동 소재. 부산시 통합예약시스템을 통해 온라인 신청 및 대관료 납부가 필수적입니다."),
            ("황령산레포츠공원 풋살장", "황령산레포츠공원",
             "온라인", "https://www.busanjin.go.kr/index.busanjin?menuCd=DOM_000001503006000000",
             "051-605-4127", "부산진구 전포동 소재 레포츠공원. 부산진구청 분야별 통합예약 시스템 또는 황령산레포츠공원 웹사이트에서 온라인 접수 가능합니다."),
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
        "schedule":       dummy_time,
    })

    for (full_name, group_name, method, url, phone, notes) in entries:
        matches.append({
            "platform":       "PUBLIC",
            "stadium":        full_name,
            "stadium_group":  group_name,
            "time":           "대관 가능",
            "date_label":     "상시 대관",
            "price":          "대관료 확인",
            "status":         "대관 가능",
            "link":           url,
            "booking_method": method,
            "phone":          phone,
            "notes":          notes,
            "schedule":       dummy_time,
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
            "status":        "신청가능" if i % 3 != 2 else "마감임박",
            "link":          "https://www.plabfootball.com/",
            "schedule":      match_time,
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
from fastapi.responses import HTMLResponse, FileResponse

# .env에서 로드, 없으면 로컬 개발용 기본값
_KAKAO_APP_KEY = os.environ.get("KAKAO_APP_KEY", "30d61422e38612b247c57f3942a111bd")
_HTML_PATH     = Path(__file__).parent / "index.html"

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


if __name__ == "__main__":
    is_prod = os.environ.get("ENV") == "production"
    host    = "0.0.0.0" if is_prod else "127.0.0.1"
    port    = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host=host, port=port, reload=not is_prod)
