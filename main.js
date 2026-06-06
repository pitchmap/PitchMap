/* ================================================================
   PitchMap — main.js
   기능: 지도 마커, 날짜 필터, 목록 뷰, 즐겨찾기, 위치 감지, 검색, 토스트
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {

    // ── API 베이스 URL (배포 시 data-api-url 속성으로 주입 가능) ─
    const API_BASE = (document.documentElement.dataset.apiUrl || window.location.origin)
                     .replace(/\/$/, '');

    // ── DOM 참조 ────────────────────────────────────────────────
    const welcomePage    = document.getElementById('welcome-page');
    const mapPage        = document.getElementById('map-page');
    const searchBtn      = document.getElementById('search-btn');
    const backBtn        = document.getElementById('back-btn');
    const sidePanel      = document.getElementById('side-panel');
    const closePanelBtn  = document.getElementById('close-panel-btn');
    const mapLoading     = document.getElementById('map-loading');
    const panelMatchList = document.getElementById('panel-match-list');
    const panelEmpty     = document.getElementById('panel-empty');
    const panelLoading   = document.getElementById('panel-loading');
    const panelStadium   = document.getElementById('panel-stadium');
    const stadiumSearch  = document.getElementById('stadium-search');
    const viewToggleBtn  = document.getElementById('view-toggle-btn');
    const viewToggleLabel= document.getElementById('view-toggle-label');
    const viewIconList   = document.getElementById('view-icon-list');
    const viewIconMap    = document.getElementById('view-icon-map');
    const listView       = document.getElementById('list-view');
    const listBody       = document.getElementById('list-body');
    const listSubtitle   = document.getElementById('list-subtitle');
    const favBtn         = document.getElementById('fav-btn');
    const favFilterBtn   = document.getElementById('fav-filter-btn');
    const gpsBtn         = document.getElementById('gps-btn');

    // ── 상태 ────────────────────────────────────────────────────
    let map = null, ps = null, geocoder = null;
    let markers = [];           // { overlay, dates, stadiumData, position }
    let markerIndex = new Map();// stadiumName → marker 객체
    let allStadiumData = {};    // stadiumName → stadiumData (목록 뷰용)
    let allLoadedMatches = [];  // 통계용 누적
    let loadedRegions  = new Set();
    let mapInitialized = false;
    let currentDateFilter = 'ALL';
    let currentPlatformFilter = 'ALL';
    let currentPanelStadium = null;
    let isListView = false;
    let showFavOnly = false;
    let userCoords = null;

    // 즐겨찾기 (localStorage)
    let favorites = new Set(
        JSON.parse(localStorage.getItem('futsal_favorites') || '[]')
    );

    // ── 상수 ────────────────────────────────────────────────────
    const REGION_COORDINATES = {
        '서울': { lat: 37.5665, lng: 126.9780 }, '경기': { lat: 37.2748, lng: 127.0090 },
        '인천': { lat: 37.4563, lng: 126.7052 }, '강원': { lat: 37.8853, lng: 127.7298 },
        '대전/세종': { lat: 36.3504, lng: 127.3845 }, '충남': { lat: 36.6588, lng: 126.6728 },
        '충북': { lat: 36.6358, lng: 127.4913 }, '대구': { lat: 35.8714, lng: 128.6014 },
        '경북': { lat: 36.5759, lng: 128.5056 }, '부산': { lat: 35.1578, lng: 129.0593 },
        '울산': { lat: 35.5384, lng: 129.3114 }, '경남': { lat: 35.2383, lng: 128.6925 },
        '광주': { lat: 35.1595, lng: 126.8526 }, '전남': { lat: 34.8159, lng: 126.4630 },
        '전북': { lat: 35.8242, lng: 127.1480 }, '제주': { lat: 33.3617, lng: 126.5292 },
    };

    const PLATFORM_CFG = {
        PLAB:   { bg: '#2563eb', border: '#1d4ed8', label: 'P', name: '플랩풋볼' },
        URBAN:  { bg: '#1e293b', border: '#0f172a', label: 'U', name: '어반풋볼' },
        PUBLIC: { bg: '#16a34a', border: '#15803d', label: '공', name: '공공대관' },
        MIXED:  { bg: '#7c3aed', border: '#6d28d9', label: '⚽', name: '복합' },
    };

    const KAKAO_REGION_MAP = {
        '서울특별시': '서울', '경기도': '경기', '인천광역시': '인천',
        '강원도': '강원', '강원특별자치도': '강원',
        '대전광역시': '대전/세종', '세종특별자치시': '대전/세종',
        '충청남도': '충남', '충청북도': '충북', '대구광역시': '대구',
        '경상북도': '경북', '부산광역시': '부산', '울산광역시': '울산',
        '경상남도': '경남', '광주광역시': '광주', '전라남도': '전남',
        '전라북도': '전북', '전북특별자치도': '전북', '제주특별자치도': '제주',
    };

    // 날짜 라벨 집합을 올바른 시간순으로 정렬
    function sortedDateLabels(labelSet) {
        const anchors = ['오늘', '내일', '모레'];
        const tail    = ['상시 대관', '기타'];
        const parseDate = s => { const m = s.match(/(\d+)\/(\d+)/); return m ? +m[1] * 100 + +m[2] : 9999; };
        const dynamic = [...labelSet].filter(l => !anchors.includes(l) && !tail.includes(l))
                                     .sort((a, b) => parseDate(a) - parseDate(b));
        return [...anchors, ...dynamic, ...tail].filter(l => labelSet.has(l));
    }

    // 날짜별 고정색 팔레트 (3일 이후는 인덱스 기반 할당)
    const DATE_PALETTE = ['#0891b2','#db2777','#ea580c','#ca8a04','#4f46e5','#be185d','#0f766e','#7c2d12'];

    function getDateColor(label) {
        switch(label) {
            case '오늘':      return '#16a34a';
            case '내일':      return '#2563eb';
            case '모레':      return '#7c3aed';
            case '상시 대관': return '#94a3b8';
            case '기타':      return '#94a3b8';
            default: {
                // 날짜 문자열("6/7(토)" 등)은 일 숫자로 팔레트 선택 → 항상 같은 색
                const dayNum = parseInt(label.split('/')[1]) || 0;
                return DATE_PALETTE[dayNum % DATE_PALETTE.length];
            }
        }
    }

    function getDateActiveClass(label) {
        return { '오늘': 'active-today', '내일': 'active-tomorrow', '모레': 'active-dayafter',
                 '상시 대관': 'active-public', 'ALL': 'active' }[label] || '';
    }

    function getDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
            Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    }

    // ── 토스트 ──────────────────────────────────────────────────
    function toast(msg, type = 'info', ms = 2800) {
        const wrap = document.getElementById('toast-wrap');
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.textContent = msg;
        wrap.appendChild(el);
        requestAnimationFrame(() => el.classList.add('show'));
        setTimeout(() => {
            el.classList.remove('show');
            setTimeout(() => el.remove(), 300);
        }, ms);
    }

    // ── 즐겨찾기 저장 ───────────────────────────────────────────
    function saveFavorites() {
        localStorage.setItem('futsal_favorites', JSON.stringify([...favorites]));
    }

    function toggleFavorite(name) {
        if (favorites.has(name)) {
            favorites.delete(name);
            toast(`즐겨찾기 해제: ${name}`, 'info');
        } else {
            favorites.add(name);
            toast(`즐겨찾기 추가: ${name} ★`, 'success');
        }
        saveFavorites();
        refreshFavBtn(name);
        if (isListView) renderListView();
    }

    function refreshFavBtn(name) {
        const isFav = favorites.has(name);
        favBtn.textContent = isFav ? '★' : '☆';
        favBtn.className = `fav-btn ${isFav ? 'fav-star' : 'fav-empty'}`;
    }

    // ── 패널 열기/닫기 ─────────────────────────────────────────
    function openPanel()  { sidePanel.classList.add('open'); }
    function closePanel() { sidePanel.classList.remove('open'); currentPanelStadium = null; }

    // ── 목록 뷰 토글 ───────────────────────────────────────────
    function setListView(on) {
        isListView = on;
        listView.classList.toggle('show', on);
        viewToggleLabel.textContent = on ? '지도' : '목록';
        viewIconList.classList.toggle('hidden', on);
        viewIconMap.classList.toggle('hidden', !on);
        if (on) {
            closePanel();
            renderListView();
        }
    }

    viewToggleBtn.addEventListener('click', () => setListView(!isListView));

    // 플랫폼/날짜 필터는 좌측 패널 컨트롤이 단일 소스 — 별도 hidden select 이벤트 불필요

    // ── 좌측 패널 컨트롤 연결 ────────────────────────────
    const leftPanel = document.getElementById('left-panel');
    const leftPanelToggle = document.getElementById('left-panel-toggle');
    const leftPanelCloseBtn = document.getElementById('left-panel-close-btn');
    const lpRegionSelect = document.getElementById('lp-region-select');
    const lpDaysSelect = document.getElementById('lp-days-select');
    const lpStadiumSearch = document.getElementById('lp-stadium-search');

    // 모바일 토글
    if (leftPanelToggle) {
        leftPanelToggle.addEventListener('click', () => {
            leftPanel?.classList.toggle('open');
        });
    }
    if (leftPanelCloseBtn) {
        leftPanelCloseBtn.addEventListener('click', () => {
            leftPanel?.classList.remove('open');
        });
    }
    // 미디어 쿼리로 모바일에서만 토글 버튼/닫기 버튼 표시
    function _checkLeftPanelResponsive() {
        const isMobile = window.innerWidth < 768;
        if (leftPanelToggle) leftPanelToggle.style.display = isMobile ? 'flex' : 'none';
        if (leftPanelCloseBtn) leftPanelCloseBtn.classList.toggle('hidden', !isMobile);
        // 데스크톱에서는 항상 열림
        if (!isMobile && leftPanel) leftPanel.classList.add('open');
        // 데스크톱에서 레전드 숨기기 (좌측패널 내장)
        const legendMobile = document.getElementById('legend-box-mobile');
        if (legendMobile) legendMobile.style.display = isMobile ? '' : 'none';
    }
    _checkLeftPanelResponsive();
    window.addEventListener('resize', _checkLeftPanelResponsive);

    // 좌측 패널: 지역 변경
    if (lpRegionSelect) {
        lpRegionSelect.addEventListener('change', () => {
            const r = lpRegionSelect.value;
            document.getElementById('region-filter').value = r;
            setRegionTag(r);
            if (mapInitialized) fetchMatchData();
        });
    }

    // 좌측 패널: 날짜 기한 변경
    if (lpDaysSelect) {
        lpDaysSelect.addEventListener('change', () => {
            if (mapInitialized) fetchMatchData();
        });
    }

    // 좌측 패널: 플랫폼 토글 버튼
    document.querySelectorAll('.platform-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const pf = btn.dataset.pf;
            currentPlatformFilter = pf;
            _syncLeftPanelPlatformBtns(pf);
            applyFilters();
            if (isListView) renderListView();
        });
    });

    function _syncLeftPanelPlatformBtns(pf) {
        document.querySelectorAll('.platform-toggle-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.pf === pf);
        });
    }

    // 좌측 패널: 구장 검색 동기
    if (lpStadiumSearch) {
        lpStadiumSearch.addEventListener('input', () => {
            stadiumSearch.value = lpStadiumSearch.value;
            applyFilters();
        });
    }
    // 상단 검색 → 좌측 패널 동기 + 필터 적용
    stadiumSearch.addEventListener('input', () => {
        if (lpStadiumSearch) lpStadiumSearch.value = stadiumSearch.value;
        applyFilters();
    });

    // ── 통계 ──────────────────────────────────────────────────
    function updateStats() {
        const m = allLoadedMatches;
        document.getElementById('stats-total').textContent  = `총 ${m.length}개 매치`;
        document.getElementById('stats-plab').textContent   = `P ${m.filter(x => x.platform==='PLAB').length}`;
        document.getElementById('stats-urban').textContent  = `U ${m.filter(x => x.platform==='URBAN').length}`;
        document.getElementById('stats-public').textContent = `공 ${m.filter(x => x.platform==='PUBLIC').length}`;
        document.getElementById('map-stats').classList.add('show');
    }

    // ── 지역 로딩 배지 ─────────────────────────────────────────
    function setRegionBadge(region, on) {
        const el = document.getElementById('region-loading-badge');
        el.querySelector('span').textContent = `${region} 매치 불러오는 중...`;
        el.classList.toggle('show', on);
    }

    // ── 동적 칩 바 생성 ────────────────────────────────────────
    function rebuildChipsBar(matches) {
        const bar = document.getElementById('chips-bar');
        // 기존 동적 칩만 제거 (ALL 칩은 유지)
        bar.querySelectorAll('.chip:not([data-date="ALL"])').forEach(c => c.remove());

        // 고유 날짜 라벨 수집 후 정렬
        const raw = [...new Set(matches.map(m => m.date_label).filter(Boolean))];
        raw.sort((a, b) => {
            const fixed = ['오늘','내일','모레'];
            const ia = fixed.indexOf(a), ib = fixed.indexOf(b);
            if (ia >= 0 && ib >= 0) return ia - ib;
            if (ia >= 0) return -1;
            if (ib >= 0) return 1;
            if (a === '상시 대관') return 1;
            if (b === '상시 대관') return -1;
            if (a === '기타') return 1;
            if (b === '기타') return -1;
            // "M/D(요일)" 형식 → 월/일 숫자로 정렬
            const parseDate = s => { const m = s.match(/(\d+)\/(\d+)/); return m ? +m[1]*100 + +m[2] : 9999; };
            return parseDate(a) - parseDate(b);
        });

        raw.forEach(label => {
            if (label === '기타') return;
            const color = getDateColor(label);
            const displayText = label === '상시 대관' ? '공공구장' : label;
            const btn = document.createElement('button');
            btn.className = 'chip';
            btn.dataset.date = label;
            btn.innerHTML = `<span class="chip-dot" style="background:${color};"></span>${displayText}`;
            bar.appendChild(btn);
        });

        // 현재 필터 칩 활성화 상태 재적용
        _applyChipActive(currentDateFilter);
    }

    function _applyChipActive(dateFilter) {
        document.querySelectorAll('#chips-bar .chip').forEach(c => {
            c.classList.remove('active','active-today','active-tomorrow','active-dayafter','active-public');
            c.style.removeProperty('background');
            c.style.removeProperty('border-color');
            c.style.removeProperty('color');
        });
        const btn = document.querySelector(`#chips-bar [data-date="${CSS.escape(dateFilter)}"]`);
        if (!btn) return;
        const namedClass = getDateActiveClass(dateFilter);
        if (namedClass) {
            btn.classList.add(namedClass);
        } else {
            // 동적 날짜 칩: 인라인 스타일로 활성화
            const color = getDateColor(dateFilter);
            btn.style.background   = color;
            btn.style.borderColor  = color;
            btn.style.color        = 'white';
        }
    }

    // ── 날짜 필터 칩 클릭 ──────────────────────────────────────
    document.getElementById('chips-bar').addEventListener('click', e => {
        const btn = e.target.closest('[data-date]');
        if (!btn) return;
        currentDateFilter = btn.dataset.date;
        _applyChipActive(currentDateFilter);
        applyFilters();
        if (isListView) renderListView();
    });

    // 날짜 필터 + 플랫폼 필터 + 검색어 필터 동시 적용 (동적 마커 필터링)
    function applyFilters() {
        const q = stadiumSearch.value.trim().toLowerCase();
        const pf = currentPlatformFilter;
        markers.forEach(({ overlay, dates, stadiumData }) => {
            const dateOk = currentDateFilter === 'ALL' || dates.has(currentDateFilter);
            const searchOk = !q || stadiumData.name.toLowerCase().includes(q);
            // 플랫폼 필터: 해당 구장의 매치 중 선택된 플랫폼이 1건이라도 있으면 표시
            const platformOk = pf === 'ALL' || stadiumData.matches.some(m => m.platform === pf);
            const visible = dateOk && searchOk && platformOk;
            overlay.setMap(visible ? map : null);
        });
    }

    // ── 구장 검색 ──────────────────────────────────────────────
    stadiumSearch.addEventListener('input', applyFilters);

    // ── 현재 지역 태그 업데이트 ────────────────────────────────
    function setRegionTag(region) {
        const el = document.getElementById('current-region-tag');
        el.textContent = region;
        el.classList.remove('hidden');
        document.getElementById('region-filter').value = region;
        // 좌측 패널 동기
        if (lpRegionSelect) lpRegionSelect.value = region;
    }

    // ── UI 이벤트 ──────────────────────────────────────────────
    // SDK 준비 전 버튼을 눌렀을 때 대기 플래그
    let _pendingInit = false;

    searchBtn.addEventListener('click', () => {
        welcomePage.classList.add('opacity-0', 'pointer-events-none');
        mapPage.classList.remove('opacity-0', 'pointer-events-none');
        if (!mapInitialized) {
            if (window.__kakaoSDKReady) {
                initMap();                      // SDK 이미 로드됨 → 바로 초기화
            } else {
                _pendingInit = true;            // SDK 대기 중 → 이벤트가 처리
                mapLoading.classList.add('show');
            }
        } else {
            fetchMatchData();
        }
    });

    // SDK 로드 완료 이벤트 수신 (클로저 내부에서 등록 → initMap 접근 가능)
    window.addEventListener('kakao-maps-ready', function () {
        if (_pendingInit && !mapInitialized) {
            _pendingInit = false;
            initMap();
        }
    });

    backBtn.addEventListener('click', () => {
        welcomePage.classList.remove('opacity-0', 'pointer-events-none');
        mapPage.classList.add('opacity-0', 'pointer-events-none');
        closePanel();
        setListView(false);
        document.getElementById('map-stats').classList.remove('show');
        loadedRegions    = new Set();
        allLoadedMatches = [];
        allStadiumData   = {};
        clearMarkers();
    });

    closePanelBtn.addEventListener('click', closePanel);

    // ── 내 주변 버튼 ───────────────────────────────────────────
    function setGpsBtnActive(active) {
        const label = document.getElementById('gps-label');
        if (active) {
            gpsBtn.classList.add('text-blue-600', 'border-blue-400', 'bg-blue-50');
            gpsBtn.classList.remove('text-slate-600', 'border-slate-200');
            if (label) label.textContent = '내 주변 ●';
        } else {
            gpsBtn.classList.remove('text-blue-600', 'border-blue-400', 'bg-blue-50');
            gpsBtn.classList.add('text-slate-600', 'border-slate-200');
            if (label) label.textContent = '내 주변';
        }
    }

    gpsBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
            toast('GPS를 지원하지 않는 브라우저입니다.', 'warn');
            return;
        }
        mapLoading.classList.add('show');
        navigator.geolocation.getCurrentPosition(pos => {
            userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            setGpsBtnActive(true);
            map.panTo(new kakao.maps.LatLng(userCoords.lat, userCoords.lng));
            addLocationDot(userCoords.lat, userCoords.lng);
            if (geocoder) {
                geocoder.coord2RegionCode(userCoords.lng, userCoords.lat, (result, status) => {
                    if (status === kakao.maps.services.Status.OK) {
                        const rec = result.find(r => r.region_type === 'H') || result[0];
                        const apiRegion = KAKAO_REGION_MAP[rec?.region_1depth_name];
                        if (apiRegion) {
                            setRegionTag(apiRegion);
                            document.getElementById('region-filter').value = apiRegion;
                            fetchMatchData({ preserveCenter: true }); // GPS panTo 좌표 유지
                        }
                    }
                });
            }
            toast('내 주변 구장을 불러옵니다', 'success');
            mapLoading.classList.remove('show');
        }, () => {
            toast('GPS 위치를 가져올 수 없습니다.', 'error');
            mapLoading.classList.remove('show');
        }, { timeout: 8000 });
    });

    favBtn.addEventListener('click', () => {
        if (currentPanelStadium) toggleFavorite(currentPanelStadium);
    });

    favFilterBtn.addEventListener('click', () => {
        showFavOnly = !showFavOnly;
        favFilterBtn.textContent = showFavOnly ? '★ 즐겨찾기만' : '☆ 즐겨찾기';
        favFilterBtn.style.color = showFavOnly ? '#f59e0b' : '';
        favFilterBtn.style.borderColor = showFavOnly ? '#fbbf24' : '';
        renderListView();
    });

    // ── 지오로케이션 (페이지 로드 시 즉시 요청) ────────────────
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            userCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
            document.getElementById('location-badge').classList.remove('hidden');
            setGpsBtnActive(true);  // 위치 감지 성공 → 버튼 활성 표시
        }, () => {}, { timeout: 8000 });
    }

    // ── 지도 초기화 ───────────────────────────────────────────
    // 이 함수는 window.__kakaoSDKReady === true 인 시점에만 호출됨
    function initMap() {
        let center;
        if (userCoords) {
            center = new kakao.maps.LatLng(userCoords.lat, userCoords.lng);
        } else {
            const r = document.getElementById('region-filter').value;
            const c = REGION_COORDINATES[r] || REGION_COORDINATES['서울'];
            center = new kakao.maps.LatLng(c.lat, c.lng);
        }

        map = new kakao.maps.Map(document.getElementById('map'), { center, level: 7 });
        ps       = new kakao.maps.services.Places();
        geocoder = new kakao.maps.services.Geocoder();

        map.addControl(new kakao.maps.MapTypeControl(), kakao.maps.ControlPosition.TOPRIGHT);
        map.addControl(new kakao.maps.ZoomControl(),    kakao.maps.ControlPosition.RIGHT);

        // 내 위치 점 표시
        if (userCoords) addLocationDot(userCoords.lat, userCoords.lng);

        // 지도 이동 시 역지오코딩 → 지역 자동 감지 + 매치 자동 로딩
        kakao.maps.event.addListener(map, 'idle', handleMapIdle);

        // 내 위치면 지역 역지오코딩으로 드롭다운 업데이트 후 데이터 로드
        if (userCoords) {
            geocoder.coord2RegionCode(userCoords.lng, userCoords.lat, (result, status) => {
                if (status === kakao.maps.services.Status.OK) {
                    const rec = result.find(r => r.region_type === 'H') || result[0];
                    const apiRegion = KAKAO_REGION_MAP[rec?.region_1depth_name];
                    if (apiRegion) {
                        setRegionTag(apiRegion);
                        document.getElementById('region-filter').value = apiRegion;
                    }
                }
                fetchMatchData({ preserveCenter: true }); // 초기 GPS: panTo 좌표 유지
            });
        } else {
            setRegionTag(document.getElementById('region-filter').value);
            fetchMatchData();
        }

        mapInitialized = true;
    }

    // ── 내 위치 점 ────────────────────────────────────────────
    function addLocationDot(lat, lng) {
        const el = document.createElement('div');
        el.style.cssText = 'position:relative;width:20px;height:20px;';
        el.innerHTML = `
            <div class="loc-ring" style="position:absolute;inset:0;border-radius:50%;
                 background:rgba(37,99,235,0.4);"></div>
            <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
                 width:10px;height:10px;border-radius:50%;background:#2563eb;
                 border:2px solid white;box-shadow:0 0 8px rgba(37,99,235,0.6);"></div>`;
        new kakao.maps.CustomOverlay({
            position: new kakao.maps.LatLng(lat, lng),
            content: el, yAnchor: 0.5, xAnchor: 0.5,
        }).setMap(map);
    }

    // ── 지도 idle → 새 지역 자동 로딩 ─────────────────────────
    function handleMapIdle() {
        if (!geocoder) return;
        const c = map.getCenter();
        geocoder.coord2RegionCode(c.getLng(), c.getLat(), (result, status) => {
            if (status !== kakao.maps.services.Status.OK) return;
            const rec = result.find(r => r.region_type === 'H') || result[0];
            const apiRegion = KAKAO_REGION_MAP[rec?.region_1depth_name];
            if (apiRegion) {
                setRegionTag(apiRegion);
                if (!loadedRegions.has(apiRegion)) autoLoadRegion(apiRegion);
            }
        });
    }

    // ── 초기 검색 (전체 리셋) ──────────────────────────────────
    // preserveCenter: GPS 이동 후 호출 시 true — 이미 panTo된 좌표를 덮어쓰지 않음
    async function fetchMatchData({ preserveCenter = false } = {}) {
        allLoadedMatches = [];
        loadedRegions    = new Set();
        allStadiumData   = {};
        clearMarkers();
        closePanel();
        setListView(false);
        document.getElementById('map-stats').classList.remove('show');

        mapLoading.classList.add('show');

        const region = document.getElementById('region-filter').value;
        loadedRegions.add(region);
        setRegionTag(region);

        // 지역이 바뀌면 지도 중심을 해당 위치로 이동 (GPS 트리거 시 제외)
        if (map && !preserveCenter) {
            const coords = REGION_COORDINATES[region];
            if (coords) {
                map.setCenter(new kakao.maps.LatLng(coords.lat, coords.lng));
                map.setLevel(7);
            }
        }

        try {
            const pf  = currentPlatformFilter;
            const days = document.getElementById('lp-days-select')?.value || 14;
            const res = await fetch(`${API_BASE}/api/matches?region=${encodeURIComponent(region)}&days=${days}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();
            if (result.status === 'error') { toast(result.message, 'error'); loadedRegions.delete(region); return; }

            // 오염된 데이터 필터링 (프론트엔드 c29어 레이어)
            let matches = result.data.filter(m => !_isJunkData(m.stadium || m.stadium_group || ''));

            if (matches?.length > 0) {
                allLoadedMatches.push(...matches);
                updateStats();
                rebuildChipsBar(allLoadedMatches);
                addMarkersForMatches(matches, true, region);
                toast(`${region} 매치 ${matches.length}개 로드됨`, 'success');
            } else {
                toast('해당 조건에 맞는 매치가 없습니다', 'warn');
                loadedRegions.delete(region);
            }
        } catch (e) {
            console.error(e);
            toast('서버에 연결할 수 없습니다. 서버를 먼저 실행해 주세요.', 'error', 5000);
            loadedRegions.delete(region);
        } finally {
            mapLoading.classList.remove('show');
        }
    }

    // ── 자동 지역 추가 로딩 ───────────────────────────────────
    async function autoLoadRegion(region) {
        if (loadedRegions.has(region)) return;
        loadedRegions.add(region);
        setRegionBadge(region, true);

        try {
            const pf  = currentPlatformFilter;
            const days = document.getElementById('lp-days-select')?.value || 14;
            const res = await fetch(`${API_BASE}/api/matches?region=${encodeURIComponent(region)}&days=${days}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();
            if (result.status !== 'success') { loadedRegions.delete(region); return; }

            let matches = result.data.filter(m => !_isJunkData(m.stadium || m.stadium_group || ''));
            if (matches?.length > 0) {
                allLoadedMatches.push(...matches);
                updateStats();
                rebuildChipsBar(allLoadedMatches);
                addMarkersForMatches(matches, false, region);
            }
        } catch {
            loadedRegions.delete(region);
        } finally {
            setRegionBadge(region, false);
        }
    }

    // ── 한국 영역 좌표 유효성 검사 ────────────────────────────
    const _isKorea = (lat, lng) =>
        lat >= 33.0 && lat <= 38.7 && lng >= 124.5 && lng <= 132.0;

    // ── 오염된 데이터 필터 (프론트엔드 방어 레이어) ─────────────
    const JUNK_KEYWORDS = ['레슨', '훈련', '이벤트', '클래스', '아카데미',
        '스킬 레슨', '일반 스킬', '키즈', '유소년', '교실', '캠프', '클리닉'];
    function _isJunkData(name) {
        if (!name) return true;
        return JUNK_KEYWORDS.some(kw => name.includes(kw));
    }

    // ── 물리 마커 없이 지역 중심으로 처리할 웹 플랫폼 목록 ──────
    const WEB_PLATFORM_VENUES = new Set(['아이엠그라운드']);

    // ── 모호한 구장명 → 카카오 검색 최적화 키워드 매핑 ──────────
    // 형식: "데이터 원본 stadium_group명(또는 부분 포함 키워드)": "카카오 검색어"
    // 부분 매칭: stadium.name.includes(key) 로 체크
    const SPECIAL_VENUE_MAP = {
        // 서울
        '도봉 라온 풋살':        '라온풋살장 도봉',
        '도봉 풋살장':           '도봉다목적체육공원 풋살',
        '노원 풋살':             '노원구 공공 풋살장',
        '마포 풋살':             '마포구 풋살장',
        '강서 공공 풋살':        '강서공공스포츠클럽 풋살',
        '목동 풋살':             '목동운동장 풋살',
        '잠실종합운동장':        '잠실종합운동장 풋살',
        '보라매공원':            '보라매공원 풋살',
        '뚝섬한강공원':          '뚝섬한강공원 풋살',
        '난지한강공원':          '난지한강공원 풋살',
        // 부산
        '구덕운동장':            '구덕운동장 풋살',
        '스포원파크':            '스포원파크 풋살',
        '화명생태공원':          '화명생태공원 풋살',
        '삼락생태공원':          '삼락생태공원 풋살',
        '대저생태공원':          '대저생태공원 풋살',
        '황령산레포츠공원':      '황령산레포츠공원 풋살',
        // 경기
        '수원월드컵경기장':      '수원월드컵경기장 풋살',
        '탄천종합운동장':        '탄천종합운동장 풋살',
        // 인천
        '인천아시아드':          '인천아시아드주경기장 풋살',
        '송도풋살공원':          '송도풋살공원',
        // 부산 신규
        '백운포체육공원':        '백운포체육공원 풋살',
        '을숙도생태공원':        '을숙도생태공원 풋살 사하',
        '부산시민공원':          '부산시민공원 풋살',
        '민락수변공원':          '민락수변공원 풋살',
        '일광체육공원':          '기장 일광체육공원',
        // 울산
        '문수축구경기장':        '울산문수축구경기장 보조구장',
        '태화강국가정원':        '태화강국가정원 울산',
        // 경남
        '양산디자인공원':        '양산 디자인공원 축구장',
        '양산수질정화공원':      '양산 수질정화공원 축구장',
        '창원성산공공체육':      '창원 성산구 풋살장',
        '김해시공공풋살':        '김해시 풋살경기장',
        '거제공공풋살':          '거제시 풋살경기장',
        '진주종합경기장':        '진주종합경기장',
        // 경북
        '포항효자체육공원':      '포항 효자체육공원 풋살',
        '경주황성공원':          '경주 황성공원 풋살',
        '금오체육공원':          '구미 금오체육공원',
        // 강원
        '강릉올림픽파크':        '강릉올림픽파크 풋살',
        '춘천종합운동장':        '춘천 종합운동장',
        '원주종합운동장':        '원주 종합운동장',
        // 전북
        '전주월드컵경기장':      '전주월드컵경기장 보조구장',
        // 전남
        '광양축구전용구장':      '광양축구전용구장',
        '팔마종합운동장':        '순천 팔마종합운동장',
        // 충남/충북
        '천안종합운동장':        '천안종합운동장 풋살',
        '아산이순신종합운동장':  '아산이순신종합운동장',
        '청주종합운동장':        '청주종합운동장 풋살',
    };

    // ── 정밀 좌표 하드코딩 테이블 (카카오 검색 오차 방지) ──────
    // 출처: 위키백과·국토정보플랫폼·visitkorea 검증 좌표
    const VENUE_HARDCOORDS = {
        // 서울
        '잠실종합운동장':    { lat: 37.5155, lng: 127.0731 },
        '어린이대공원':      { lat: 37.5482, lng: 127.0816 },
        '보라매공원':        { lat: 37.4942, lng: 126.9237 },
        '뚝섬한강공원':      { lat: 37.5313, lng: 127.0626 },
        '난지한강공원':      { lat: 37.5713, lng: 126.8919 },
        // 경기/인천
        '탄천종합운동장':    { lat: 37.3716, lng: 127.1109 },
        '수원월드컵경기장':  { lat: 37.2940, lng: 127.0092 },
        '인천아시아드':      { lat: 37.5676, lng: 126.6748 },
        '송도풋살공원':      { lat: 37.3840, lng: 126.6541 },
        // 부산
        '구덕운동장':        { lat: 35.1165, lng: 129.0145 },
        '스포원파크':        { lat: 35.2891, lng: 129.1070 },
        '화명생태공원':      { lat: 35.2305, lng: 129.0041 },
        '삼락생태공원':      { lat: 35.1657, lng: 128.9738 },
        '대저생태공원':      { lat: 35.2165, lng: 128.9543 },
        '황령산레포츠공원':  { lat: 35.1576, lng: 129.0762 },
        '백운포체육공원':    { lat: 35.1028, lng: 129.1099 },  // 부산 남구 용호동
        '을숙도생태공원':    { lat: 35.0876, lng: 128.9768 },
        '부산시민공원':      { lat: 35.1663, lng: 129.0445 },
        '민락수변공원':      { lat: 35.1536, lng: 129.1244 },
        '일광체육공원':      { lat: 35.2749, lng: 129.2170 },
        // 경남
        '양산디자인공원':    { lat: 35.3226, lng: 129.0004 },  // 물금읍 백호로 23
        '양산수질정화공원':  { lat: 35.3071, lng: 129.0225 },  // 강변로 54
        // 울산
        '문수축구경기장':    { lat: 35.5196, lng: 129.2936 },
        // 대구
        '대구스타디움':      { lat: 35.8397, lng: 128.6833 },
        // 광주
        '상무시민공원':      { lat: 35.1533, lng: 126.8441 },
        // 대전
        '대전월드컵경기장':  { lat: 36.3957, lng: 127.3345 },
        // 제주
        '제주월드컵경기장':  { lat: 33.4747, lng: 126.4997 },
        // 강원
        '강릉올림픽파크':    { lat: 37.6387, lng: 128.7177 },
        // 전북
        '전주월드컵경기장':  { lat: 35.8197, lng: 127.1331 },
    };

    // stadium.name 에서 SPECIAL_VENUE_MAP 키가 포함되면 매핑된 검색어 반환
    function _specialVenueKeyword(name) {
        for (const [key, mapped] of Object.entries(SPECIAL_VENUE_MAP)) {
            if (name.includes(key)) return mapped;
        }
        return null;
    }

    // ── 검색 키워드용 이름 정제 ──────────────────────────────────
    function _sanitizeSearchName(raw) {
        return raw
            // 구장 식별자
            .replace(/\s*[A-Za-z]\s*구장\b/gi, '')          // A구장, B구장, a코트
            .replace(/\s*[A-Za-z]\s*코트\b/gi, '')           // A코트
            .replace(/\s*\d+\s*구장\b/g, '')                 // 1구장, 2구장
            .replace(/\s*\d+\s*코트\b/g, '')                 // 1코트
            .replace(/\s*\d+\s*호점\b/g, '')                 // 1호점
            .replace(/\s*\d+\s*호\s*구장\b/g, '')            // 1호구장
            .replace(/\s+제\d+\s*(?:풋살|축구)?(?:경기장|구장)\b/g, '')
            // 시설 유형 접미사
            .replace(/\s+(?:인조잔디|천연잔디)(?:구장|경기장)?\s*$/g, '')
            .replace(/\s+(?:실내|실외|야외)\s*$/g, '')
            .replace(/\s+(?:대관|예약|문의)\s*$/g, '')
            // 괄호 및 특수문자
            .replace(/\s*\([^)]*\)/g, '')
            .replace(/\s*\[[^\]]*\]/g, '')
            .trim();
    }

    // ── 주소에 지역명이 포함된 첫 번째 결과 반환 (없으면 null) ──
    function _pickByRegion(results, region) {
        if (!region || !results.length) return null;
        return results.find(r =>
            (r.address_name || '').includes(region) ||
            (r.road_address_name || '').includes(region)
        ) || null;
    }

    // ── 위치 결정: 카카오 keywordSearch 신뢰 + 지역 필터 보정 ──
    function _resolvePosition(stadium, region, fallbackRandom, cb) {
        if (!ps) { _fallbackCenter(region, fallbackRandom, cb); return; }

        // 웹 플랫폼 PUBLIC → 마커 생략 (물리 위치 없음)
        if (WEB_PLATFORM_VENUES.has(stadium.name)) return;

        // 하드코딩 좌표 우선 — 검색 오차 없이 정확한 위치 사용
        for (const [key, coord] of Object.entries(VENUE_HARDCOORDS)) {
            if (stadium.name.includes(key)) {
                cb(new kakao.maps.LatLng(coord.lat, coord.lng));
                return;
            }
        }

        const emit = (lat, lng, next) => {
            const fLat = parseFloat(lat), fLng = parseFloat(lng);
            _isKorea(fLat, fLng) ? cb(new kakao.maps.LatLng(fLat, fLng)) : next();
        };

        // SPECIAL_VENUE_MAP 우선 → 없으면 일반 정제
        const cleanName = _specialVenueKeyword(stadium.name) ?? _sanitizeSearchName(stadium.name);

        // Tier-1: "지역 + 정제명" → 지역 주소 포함 결과 우선
        const q1 = region ? `${region} ${cleanName}` : cleanName;
        ps.keywordSearch(q1, (d1, s1) => {
            if (s1 === kakao.maps.services.Status.OK) {
                const pick = _pickByRegion(d1, region) || d1[0];
                emit(pick.y, pick.x, () => _kwTier2(cleanName, region, fallbackRandom, cb, emit));
            } else {
                _kwTier2(cleanName, region, fallbackRandom, cb, emit);
            }
        });
    }

    // Tier-2: 구장명만으로 재시도
    function _kwTier2(cleanName, region, fallbackRandom, cb, emit) {
        ps.keywordSearch(cleanName, (d2, s2) => {
            if (s2 === kakao.maps.services.Status.OK) {
                const pick = _pickByRegion(d2, region) || d2[0];
                emit(pick.y, pick.x, () => _fallbackCenter(region, fallbackRandom, cb));
            } else {
                _fallbackCenter(region, fallbackRandom, cb);
            }
        });
    }

    function _fallbackCenter(region, fallbackRandom, cb) {
        if (!fallbackRandom) return;
        const rc = REGION_COORDINATES[region] || { lat: map.getCenter().getLat(), lng: map.getCenter().getLng() };
        cb(new kakao.maps.LatLng(
            rc.lat + (Math.random() - 0.5) * 0.03,
            rc.lng + (Math.random() - 0.5) * 0.03
        ));
    }

    // ── 마커 추가 ─────────────────────────────────────────────
    function addMarkersForMatches(matches, fallbackRandom, region) {
        const stadiums = {};
        matches.forEach(m => {
            const key = m.stadium_group || m.stadium;
            if (!stadiums[key]) stadiums[key] = { name: key, matches: [] };
            stadiums[key].matches.push(m);
            if (!allStadiumData[key]) allStadiumData[key] = { name: key, matches: [] };
            allStadiumData[key].matches.push(m);
        });

        Object.values(stadiums).forEach(stadium => {
            _resolvePosition(stadium, region, fallbackRandom, pos => {
                // 최종 좌표 유효성 이중 확인 후 마커 생성
                if (pos && _isKorea(pos.getLat(), pos.getLng())) {
                    createMarker(pos, stadium);
                } else {
                    console.warn(`[마커 스킵] 유효하지 않은 좌표: ${stadium.name}`, pos);
                }
            });
        });
    }

    function createMarker(position, stadiumData) {
        const platforms = [...new Set(stadiumData.matches.map(m => m.platform))];
        const platform  = platforms.length > 1 ? 'MIXED' : platforms[0];
        const cfg   = PLATFORM_CFG[platform] || PLATFORM_CFG.MIXED;
        const count = stadiumData.matches.length;
        const isFav = favorites.has(stadiumData.name);
        const isRentalVenue = stadiumData.matches.some(m => m.is_rental === true);

        const el = document.createElement('div');
        el.style.cssText = `
            position:relative; width:46px; height:46px;
            display:flex; flex-direction:column; align-items:center; justify-content:center;
            background:${cfg.bg}; border:${isRentalVenue ? '3px solid #10b981' : `2.5px solid ${cfg.border}`}; border-radius:50%;
            cursor:pointer; box-shadow:${isRentalVenue ? '0 3px 14px rgba(16,185,129,0.45)' : '0 3px 12px rgba(0,0,0,0.28)'};
            color:white; font-family:'Pretendard',sans-serif;
            transition:transform 0.15s ease, box-shadow 0.15s ease; user-select:none;`;
        el.innerHTML = `
            <span style="font-weight:800;font-size:14px;line-height:1.1;">${cfg.label}</span>
            <span style="font-size:9px;opacity:0.85;line-height:1.2;font-weight:600;">${count}건</span>
            ${isFav ? '<span style="position:absolute;top:-4px;right:-4px;font-size:11px;background:white;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,0.2);">★</span>' : ''}
            ${isRentalVenue ? '<span style="position:absolute;bottom:-9px;left:50%;transform:translateX(-50%);font-size:8px;font-weight:900;background:#10b981;color:white;padding:1px 5px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.25);letter-spacing:0.2px;">대관</span>' : ''}`;

        el.addEventListener('mouseenter', () => { el.style.transform='scale(1.18)'; el.style.boxShadow= isRentalVenue ? '0 6px 20px rgba(16,185,129,0.55)' : '0 5px 18px rgba(0,0,0,0.38)'; });
        el.addEventListener('mouseleave', () => { el.style.transform='scale(1)';    el.style.boxShadow= isRentalVenue ? '0 3px 14px rgba(16,185,129,0.45)' : '0 3px 12px rgba(0,0,0,0.28)'; });
        el.addEventListener('click', () => {
            showSidePanel(stadiumData);
            map.panTo(position);
            setListView(false);
        });

        const overlay = new kakao.maps.CustomOverlay({ position, content: el, yAnchor: 0.5, xAnchor: 0.5 });
        overlay.setMap(map);

        const dates = new Set(stadiumData.matches.map(m => m.date_label).filter(Boolean));
        const markerObj = { overlay, dates, stadiumData, position, el };

        markers.push(markerObj);
        markerIndex.set(stadiumData.name, markerObj);

        // 현재 필터 적용
        const q = stadiumSearch.value.trim().toLowerCase();
        const pf = currentPlatformFilter;
        const dateOk   = currentDateFilter === 'ALL' || dates.has(currentDateFilter);
        const searchOk = !q || stadiumData.name.toLowerCase().includes(q);
        const platformOk = pf === 'ALL' || stadiumData.matches.some(m => m.platform === pf);
        if (!dateOk || !searchOk || !platformOk) overlay.setMap(null);
    }

    function clearMarkers() {
        markers.forEach(m => m.overlay.setMap(null));
        markers = [];
        markerIndex = new Map();
        allStadiumData = {};
    }

    // ── 사이드 패널 표시 ──────────────────────────────────────
    function showSidePanel(stadiumData) {
        currentPanelStadium = stadiumData.name;
        const isRental = stadiumData.matches.some(m => m.is_rental === true);

        let distText = '';
        if (userCoords) {
            const markerObj = markerIndex.get(stadiumData.name);
            if (markerObj && markerObj.position) {
                const dist = getDistance(
                    userCoords.lat, userCoords.lng,
                    markerObj.position.getLat(), markerObj.position.getLng()
                );
                distText = `<span style="font-size:11px;color:#10b981;font-weight:700;margin-left:8px;background:#ecfdf5;padding:2px 6px;border-radius:4px;border:1px solid #a7f3d0;">📍 내 위치에서 ${dist.toFixed(1)}km</span>`;
            }
        }

        panelStadium.innerHTML = `${stadiumData.name}${distText}`;

        // 대관 배지 + 아웃링크 버튼 — panel-stadium 바로 아래 삽입
        document.getElementById('_panel-rental-badge')?.remove();
        document.getElementById('_panel-rental-btn')?.remove();
        if (isRental) {
            // 배지
            const b = document.createElement('span');
            b.id = '_panel-rental-badge';
            b.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-top:4px;'
                + 'font-size:10px;font-weight:800;color:#15803d;background:#dcfce7;'
                + 'padding:2px 9px;border-radius:99px;border:1px solid #86efac;';
            b.textContent = '✓ 대관 가능';
            panelStadium.insertAdjacentElement('afterend', b);

            // 대관 아웃링크 버튼 — window.open으로 URL 원문 그대로 전달 (HTML 인코딩 우회)
            const rentalMatch = stadiumData.matches.find(m => m.is_rental && m.rental_url);
            if (rentalMatch) {
                const rentalUrl = rentalMatch.rental_url;
                const label = rentalMatch.rental_platform_label
                    ? `${rentalMatch.rental_platform_label}로 대관하러 가기 →`
                    : '예약 페이지 바로가기 →';
                const btn = document.createElement('button');
                btn.id = '_panel-rental-btn';
                btn.style.cssText = 'display:block;width:100%;margin-top:8px;padding:8px 14px;'
                    + 'background:#2563eb;color:white;border-radius:10px;font-size:12px;border:none;'
                    + 'font-weight:800;text-align:center;cursor:pointer;transition:opacity 0.18s;';
                btn.textContent = label;
                btn.addEventListener('mouseover', () => btn.style.opacity = '0.85');
                btn.addEventListener('mouseout',  () => btn.style.opacity = '1');
                btn.addEventListener('click', () => window.open(rentalUrl, '_blank', 'noopener'));
                b.insertAdjacentElement('afterend', btn);
            }
        }

        refreshFavBtn(stadiumData.name);
        renderMatchList(stadiumData);
        openPanel();
        if (window.VenuePlatform) window.VenuePlatform.load(stadiumData.name, isRental);
    }

    // ── 날짜 세그먼트를 container(Element)에 렌더링 ──────────
    function _renderDateSegment(container, dates, byDate, stadiumData, firstIsTop) {
        dates.forEach((dateLabel, dIdx) => {
            const color  = getDateColor(dateLabel);
            const courts = byDate[dateLabel];
            if (!courts) return;
            const total = Object.values(courts).reduce((s, a) => s + a.length, 0);
            const multi = Object.keys(courts).length > 1;

            container.insertAdjacentHTML('beforeend', `
                <div style="display:flex;align-items:center;gap:7px;
                            margin:${firstIsTop && dIdx === 0 ? '0' : '18px'} 0 10px;
                            padding-bottom:7px;border-bottom:2.5px solid ${color};">
                    <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;"></div>
                    <span style="font-size:13px;font-weight:800;color:${color};">${dateLabel}</span>
                    <span style="font-size:11px;color:#94a3b8;font-weight:500;">${total}개 매치</span>
                </div>`);

            Object.entries(courts).forEach(([courtName, matches], cIdx) => {
                if (multi) {
                    const label  = courtName.replace(stadiumData.name, '').trim() || courtName;
                    const mapUrl = `https://map.kakao.com/?q=${encodeURIComponent(courtName)}`;
                    container.insertAdjacentHTML('beforeend', `
                        <div style="display:flex;justify-content:space-between;align-items:center;
                                    margin:${cIdx===0?'0':'10px'} 0 6px;
                                    padding:5px 9px;background:#f1f5f9;border-radius:8px;">
                            <div style="display:flex;align-items:center;gap:5px;">
                                <div style="width:2px;height:13px;background:#94a3b8;border-radius:1px;flex-shrink:0;"></div>
                                <span style="font-size:12px;font-weight:700;color:#475569;">${label}</span>
                            </div>
                            <a href="${mapUrl}" target="_blank" rel="noopener"
                               style="font-size:11px;color:#3b82f6;font-weight:600;text-decoration:none;">지도 보기</a>
                        </div>`);
                }
                matches.forEach(m => container.insertAdjacentHTML('beforeend', buildMatchCard(m, multi)));
            });
        });
    }

    // ── 매치 리스트 렌더링 (날짜 필터 반영 + 더보기 accordion) ─
    function renderMatchList(stadiumData) {
        panelEmpty.classList.add('hidden');
        panelLoading.classList.add('hidden');
        panelMatchList.innerHTML = '';

        const NEAR_SET = new Set(['오늘', '내일', '모레', '상시 대관']);

        // 날짜 → 코트 2단계 그룹핑
        const byDate = {};
        stadiumData.matches.forEach(m => {
            const dl = m.date_label || '기타';
            if (!byDate[dl]) byDate[dl] = {};
            if (!byDate[dl][m.stadium]) byDate[dl][m.stadium] = [];
            byDate[dl][m.stadium].push(m);
        });

        const allDates = sortedDateLabels(new Set(Object.keys(byDate)));
        if (!allDates.length) { panelEmpty.classList.remove('hidden'); return; }

        // ── 특정 날짜 칩 선택 시: 해당 날짜만 즉시 노출 ──────
        if (currentDateFilter !== 'ALL') {
            const targeted = allDates.filter(d => d === currentDateFilter);
            if (!targeted.length) {
                panelMatchList.insertAdjacentHTML('beforeend', `
                    <div style="text-align:center;padding:32px 16px;">
                        <div style="font-size:2.2rem;margin-bottom:10px;">🗓️</div>
                        <p style="font-weight:800;color:#475569;font-size:13px;margin-bottom:5px;">
                            이 날짜의 매치가 없습니다</p>
                        <p style="font-size:11px;color:#94a3b8;">상단에서 '전체'를 선택하면 모든 매치를 볼 수 있어요</p>
                    </div>`);
                return;
            }
            _renderDateSegment(panelMatchList, targeted, byDate, stadiumData, true);
            return;
        }

        // ── ALL: 오늘/내일/모레 즉시 노출, 이후 날짜는 accordion ──
        const nearDates = allDates.filter(d => NEAR_SET.has(d));
        const farDates  = allDates.filter(d => !NEAR_SET.has(d));

        if (nearDates.length) {
            _renderDateSegment(panelMatchList, nearDates, byDate, stadiumData, true);
        }

        if (farDates.length) {
            const farMatchTotal = farDates.reduce(
                (s, d) => s + Object.values(byDate[d]).reduce((ss, a) => ss + a.length, 0), 0
            );
            panelMatchList.insertAdjacentHTML('beforeend', `
                <div style="margin-top:${nearDates.length ? '20px' : '0'};">
                    <button id="_more-btn" onclick="window._toggleMoreDates()"
                            style="width:100%;display:flex;align-items:center;justify-content:space-between;
                                   padding:11px 14px;background:#f8fafc;
                                   border:1.5px dashed #cbd5e1;border-radius:12px;
                                   cursor:pointer;transition:all 0.18s;"
                            onmouseover="this.style.background='#f1f5f9';this.style.borderColor='#94a3b8';"
                            onmouseout="this.style.background='#f8fafc';this.style.borderColor='#cbd5e1';">
                        <div style="display:flex;align-items:center;gap:7px;">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#64748b"
                                 stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="4" width="18" height="18" rx="2"/>
                                <line x1="16" y1="2" x2="16" y2="6"/>
                                <line x1="8"  y1="2" x2="8"  y2="6"/>
                                <line x1="3"  y1="10" x2="21" y2="10"/>
                            </svg>
                            <span style="font-size:12px;font-weight:700;color:#475569;">
                                이후 일정 더보기
                                <span id="_more-badge"
                                      style="margin-left:5px;background:#e2e8f0;color:#64748b;
                                             padding:1px 7px;border-radius:99px;font-size:11px;font-weight:700;">
                                    +${farDates.length}일 · ${farMatchTotal}경기
                                </span>
                            </span>
                        </div>
                        <svg id="_more-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
                             stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                             style="transition:transform 0.22s;flex-shrink:0;">
                            <path d="M6 9l6 6 6-6"/>
                        </svg>
                    </button>
                    <div id="_more-content" style="display:none;padding-top:4px;"></div>
                </div>`);

            // 숨겨진 영역에 미리 렌더링
            _renderDateSegment(
                document.getElementById('_more-content'),
                farDates, byDate, stadiumData, true
            );
        }
    }

    window._toggleMoreDates = function() {
        const content = document.getElementById('_more-content');
        const chevron = document.getElementById('_more-chevron');
        const badge   = document.getElementById('_more-badge');
        if (!content) return;
        const opening = content.style.display === 'none';
        content.style.display   = opening ? 'block' : 'none';
        chevron.style.transform = opening ? 'rotate(180deg)' : '';
        if (badge) {
            badge.style.background = opening ? '#dbeafe' : '#e2e8f0';
            badge.style.color      = opening ? '#1d4ed8' : '#64748b';
        }
    };

    // ── 매치 카드 HTML ────────────────────────────────────────
    function buildMatchCard(match, hideCourtName) {
        if (match.platform === 'PUBLIC') {
            const hasLink = !!match.link;
            const hasPhone = !!match.phone;
            const methodBadge = `<span style="padding:3px 8px;border-radius:6px;font-size:10px;font-weight:800;
                                background:#16a34a;color:white;letter-spacing:0.3px;box-shadow:0 2px 4px rgba(22,163,74,0.15);">공공 대관 정보</span>`;
            
            const typeBadge = `<span style="background:#e8f5e9;color:#1b5e20;padding:3px 8px;border-radius:6px;font-size:10px;font-weight:800;border:1px solid #c8e6c9;">${match.booking_method || '대관 문의'}</span>`;
            
            let btnHtml = '';
            if (hasLink) {
                btnHtml = `
                    <a href="${match.link}" target="_blank" rel="noopener"
                       style="display:block;width:100%;padding:11px 0;text-align:center;font-size:13px;
                              font-weight:800;border-radius:10px;text-decoration:none;
                              background:#16a34a;color:white;cursor:pointer;
                              transition:opacity 0.18s;box-sizing:border-box;box-shadow:0 4px 10px rgba(22,163,74,0.25);"
                       onmouseover="this.style.opacity='0.88'"
                       onmouseout="this.style.opacity='1'">
                        공식 예약 사이트 바로가기 →
                    </a>`;
            } else if (hasPhone) {
                btnHtml = `
                    <a href="tel:${match.phone}"
                       style="display:block;width:100%;padding:11px 0;text-align:center;font-size:13px;
                              font-weight:800;border-radius:10px;text-decoration:none;
                              background:#475569;color:white;cursor:pointer;
                              transition:opacity 0.18s;box-sizing:border-box;box-shadow:0 4px 10px rgba(71,85,105,0.25);"
                       onmouseover="this.style.opacity='0.88'"
                       onmouseout="this.style.opacity='1'">
                        전화 문의하기 (${match.phone}) →
                    </a>`;
            } else {
                btnHtml = `
                    <div style="display:block;width:100%;padding:11px 0;text-align:center;font-size:13px;
                               font-weight:800;border-radius:10px;background:#94a3b8;color:white;
                               box-sizing:border-box;">
                        대관 상세 정보는 구장으로 문의 바랍니다.
                    </div>`;
            }

            const phoneRow = hasPhone ? `
                <div style="display:flex;align-items:center;gap:6px;font-size:11px;color:#475569;margin-bottom:8px;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:#16a34a;flex-shrink:0;">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                    </svg>
                    <span><strong>문의처:</strong> ${match.phone}</span>
                </div>` : '';

            return `
                <div style="background:#f4fbf7;border:1.8px solid #a7f3d0;border-radius:16px;
                            padding:15px;margin-bottom:12px;box-shadow:0 4px 12px rgba(22,163,74,0.06);
                            position:relative;overflow:hidden;">
                    <div style="position:absolute;top:-20px;right:-20px;width:60px;height:60px;background:rgba(22,163,74,0.04);border-radius:50%;pointer-events:none;"></div>
                    
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                        <div style="display:flex;align-items:center;gap:6px;">
                            ${methodBadge}
                            <span style="font-weight:800;font-size:15px;color:#0f2d1e;letter-spacing:-0.3px;">${match.time}</span>
                        </div>
                        ${typeBadge}
                    </div>
                    
                    <div style="font-size:12px;font-weight:700;color:#065f46;margin-bottom:8px;
                                white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                        ${match.stadium}
                    </div>
                    
                    <div style="background:white;border:1px solid #d1fae5;border-radius:10px;padding:10px 12px;margin-bottom:12px;">
                        <div style="font-size:11px;color:#64748b;font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:4px;">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="12" y1="16" x2="12" y2="12"/>
                                <line x1="12" y1="8" x2="12.01" y2="8"/>
                            </svg>
                            대관 안내사항
                        </div>
                        <div style="font-size:11.5px;color:#1e293b;line-height:1.5;font-weight:500;word-break:keep-all;">
                            ${match.notes || '예약 및 관련 상세 정보는 위 링크 또는 문의 전화를 이용해 주세요.'}
                        </div>
                    </div>
                    
                    ${phoneRow}
                    ${btnHtml}
                </div>`;
        }

        const isClosed     = match.status === '마감' || match.status === '마감됨';
        const isAlmostFull = !isClosed && match.status.includes('임박');
        const cfg          = PLATFORM_CFG[match.platform] || PLATFORM_CFG.MIXED;

        const badge = `<span style="padding:2px 7px;border-radius:4px;font-size:10px;font-weight:800;
                            background:${cfg.bg};color:white;letter-spacing:0.3px;">${match.platform}</span>`;

        let statusBadge;
        if (isClosed)
            statusBadge = `<span style="background:#fee2e2;color:#dc2626;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;">마감</span>`;
        else if (isAlmostFull)
            statusBadge = `<span style="background:#ffedd5;color:#c2410c;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;">마감임박</span>`;
        else
            statusBadge = `<span style="background:#dcfce7;color:#16a34a;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;">신청가능</span>`;

        let btnStyle, btnText;
        if (isClosed) {
            btnStyle = 'background:#e5e7eb;color:#9ca3af;cursor:not-allowed;pointer-events:none;';
            btnText  = '신청 마감';
        } else if (!match.link) {
            btnStyle = 'background:#94a3b8;color:white;cursor:not-allowed;pointer-events:none;';
            btnText  = '전화 문의 필요';
        } else {
            btnStyle = `background:${cfg.bg};color:white;cursor:pointer;`;
            btnText  = match.platform === 'PUBLIC' ? '예약 방법 확인 →' : '예약하러 가기 →';
        }

        const link    = match.link ? `href="${match.link}" target="_blank" rel="noopener"` : '';
        const cardBg  = isClosed ? '#f8fafc' : 'white';
        const cardBdr = isClosed ? '#e2e8f0' : isAlmostFull ? '#fed7aa' : '#bfdbfe';
        const shadow  = (isClosed || isAlmostFull) ? '' : 'box-shadow:0 2px 8px rgba(37,99,235,0.08);';
        const opacity = isClosed ? 'opacity:0.75;' : '';
        const courtLine = hideCourtName ? '' : `
            <div style="font-size:11px;color:#64748b;margin-bottom:10px;
                        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${match.stadium}</div>`;

        return `
            <div style="background:${cardBg};border:1.5px solid ${cardBdr};border-radius:14px;
                        padding:14px;margin-bottom:10px;${shadow}${opacity}">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        ${badge}
                        <span style="font-weight:800;font-size:17px;color:#1e3a5f;letter-spacing:-0.3px;">${match.time}</span>
                    </div>
                    ${statusBadge}
                </div>
                ${courtLine}
                <div style="background:#f8fafc;border-radius:9px;padding:9px 12px;margin-bottom:11px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <span style="font-size:11px;color:#94a3b8;font-weight:600;">참가비</span>
                        <span style="font-weight:800;color:#1e293b;font-size:14px;">${match.price}</span>
                    </div>
                </div>
                <a ${link}
                   style="display:block;width:100%;padding:10px 0;text-align:center;font-size:13px;
                          font-weight:800;border-radius:10px;text-decoration:none;
                          transition:opacity 0.18s;box-sizing:border-box;${btnStyle}"
                   onmouseover="if(this.style.cursor!=='not-allowed')this.style.opacity='0.82'"
                   onmouseout="this.style.opacity='1'">
                    ${btnText}
                </a>
            </div>`;
    }

    // ── 목록 뷰 렌더링 ────────────────────────────────────────
    function renderListView() {
        const pf = currentPlatformFilter;

        // 필터 적용
        let stadiums = Object.values(allStadiumData).filter(sd => {
            if (showFavOnly && !favorites.has(sd.name)) return false;
            const matchesFilter = sd.matches.some(m =>
                (pf === 'ALL' || m.platform === pf) &&
                (currentDateFilter === 'ALL' || m.date_label === currentDateFilter)
            );
            return matchesFilter;
        });

        // 거리 계산
        stadiums.forEach(sd => {
            sd.distance = null;
            if (userCoords) {
                const markerObj = markerIndex.get(sd.name);
                if (markerObj && markerObj.position) {
                    sd.distance = getDistance(
                        userCoords.lat, userCoords.lng,
                        markerObj.position.getLat(), markerObj.position.getLng()
                    );
                }
            }
        });

        // userCoords가 있으면 가까운 거리순으로 구장 정렬
        if (userCoords) {
            stadiums.sort((a, b) => {
                if (a.distance === null) return 1;
                if (b.distance === null) return -1;
                return a.distance - b.distance;
            });
        }

        if (!stadiums.length) {
            listBody.innerHTML = `<div class="empty-state">
                <p style="font-size:2.5rem;margin-bottom:12px;">${showFavOnly ? '☆' : '🔍'}</p>
                <p style="font-weight:700;color:#475569;margin-bottom:6px;">${showFavOnly ? '즐겨찾기한 구장이 없습니다' : '표시할 매치가 없습니다'}</p>
                <p style="font-size:13px;">필터 조건을 변경해 보세요.</p>
            </div>`;
            listSubtitle.textContent = '0개 구장';
            return;
        }

        // 날짜별 그룹핑
        const byDate = {};
        stadiums.forEach(sd => {
            sd.matches
                .filter(m => (pf === 'ALL' || m.platform === pf)
                          && (currentDateFilter === 'ALL' || m.date_label === currentDateFilter))
                .forEach(m => {
                    const dl = m.date_label || '기타';
                    if (!byDate[dl]) byDate[dl] = new Map();
                    if (!byDate[dl].has(sd.name)) byDate[dl].set(sd.name, { name: sd.name, matches: [], distance: sd.distance });
                    byDate[dl].get(sd.name).matches.push(m);
                });
        });

        let html = '';
        let totalStadiums = 0;

        sortedDateLabels(new Set(Object.keys(byDate))).forEach(dl => {
            const color = getDateColor(dl);
            const entries = [...byDate[dl].values()];
            totalStadiums += entries.length;
            const total = entries.reduce((s, e) => s + e.matches.length, 0);

            html += `<div class="list-date-header" style="color:${color};border-color:${color};">
                <div style="width:8px;height:8px;border-radius:50%;background:${color};"></div>
                <span style="font-weight:800;font-size:13px;">${dl}</span>
                <span style="font-size:11px;color:#94a3b8;font-weight:500;">${total}개 매치 · ${entries.length}개 구장</span>
            </div>`;

            entries.forEach(entry => {
                const platforms = [...new Set(entry.matches.map(m => m.platform))];
                const cfg = PLATFORM_CFG[platforms.length > 1 ? 'MIXED' : platforms[0]] || PLATFORM_CFG.MIXED;
                const times = [...new Set(entry.matches.map(m => m.time.split(' ')[1]))].sort().slice(0, 4).join(', ');
                const hasMore = entry.matches.length > 4;
                const isFav = favorites.has(entry.name);
                const isAvail = entry.matches.some(m => m.status === '신청가능');
                const safeName = entry.name.replace(/'/g, "\\'").replace(/"/g, '\\"');
                
                const distBadge = entry.distance !== null ? ` · <span style="color:#10b981;font-weight:700;">${entry.distance.toFixed(1)}km</span>` : '';

                html += `<div class="list-stadium-row" onclick="focusStadium('${safeName}')">
                    <div class="list-platform-dot" style="background:${cfg.bg};">${cfg.label}</div>
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px;">
                            <span style="font-weight:700;font-size:14px;color:#1e293b;
                                         white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
                                         max-width:160px;">${entry.name}</span>
                            ${isAvail ? '<span style="font-size:10px;font-weight:700;color:#16a34a;background:#dcfce7;padding:1px 6px;border-radius:99px;flex-shrink:0;">신청가능</span>' : ''}
                        </div>
                        <div style="font-size:11px;color:#94a3b8;">
                            ${times}${hasMore ? ` 외 ${entry.matches.length - 4}개` : ''} · ${entry.matches.length}매치${distBadge}
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                        <span class="fav-btn ${isFav ? 'fav-star' : 'fav-empty'}"
                              onclick="event.stopPropagation();toggleFav('${safeName}',this)">${isFav ? '★' : '☆'}</span>
                        <svg style="color:#94a3b8;" width="14" height="14" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M9 18l6-6-6-6"/>
                        </svg>
                    </div>
                </div>`;
            });
        });

        listBody.innerHTML = html;
        listSubtitle.textContent = `${totalStadiums}개 구장 · ${allLoadedMatches.length}개 매치`;
    }

    // 목록 뷰에서 즐겨찾기 토글 (전역 노출)
    window.toggleFav = function(name, starEl) {
        toggleFavorite(name);
        const isFav = favorites.has(name);
        starEl.textContent = isFav ? '★' : '☆';
        starEl.className = `fav-btn ${isFav ? 'fav-star' : 'fav-empty'}`;
        // 마커 즐겨찾기 배지 업데이트
        const markerObj = markerIndex.get(name);
        if (markerObj) {
            const el = markerObj.el;
            const existingBadge = el.querySelector('.fav-badge');
            if (isFav && !existingBadge) {
                const badge = document.createElement('span');
                badge.className = 'fav-badge';
                badge.style.cssText = 'position:absolute;top:-4px;right:-4px;font-size:11px;background:white;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,0.2);';
                badge.textContent = '★';
                el.appendChild(badge);
            } else if (!isFav && existingBadge) {
                existingBadge.remove();
            }
        }
    };

    // 목록에서 구장 포커스 (전역 노출)
    window.focusStadium = function(name) {
        const markerObj = markerIndex.get(name);
        const sd = allStadiumData[name];
        if (!sd) return;

        setListView(false);

        if (markerObj) {
            map.setCenter(markerObj.position);
            if (map.getLevel() > 5) map.setLevel(5);
        }

        showSidePanel(sd);
    };

});

// ═══════════════════════════════════════════════════════════════
// ⚽  조축 매칭 플랫폼 모듈 — 기존 DOMContentLoaded 클로저와 완전 독립
//     전역 노출: window.JochukPlatform (버튼 onclick 에서 사용)
// ═══════════════════════════════════════════════════════════════
window.JochukPlatform = (function () {
    'use strict';

    const _base = () =>
        (document.documentElement.dataset.apiUrl || window.location.origin).replace(/\/$/, '');

    const $  = id  => document.getElementById(id);
    const v  = id  => ($(`${id}`)?.value  ?? '').trim();
    const ck = id  => !!$(`${id}`)?.checked;

    function fmtDate(iso) {
        if (!iso) return '';
        try { return new Date(iso).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }); }
        catch { return iso; }
    }

    // ── 탭 전환 ────────────────────────────────────────────────
    function switchTab(tab) {
        document.querySelectorAll('.jtab-pane').forEach(p => {
            p.classList.add('hidden');
            p.style.display = 'none';
        });
        document.querySelectorAll('.jtab-btn').forEach(b => {
            b.classList.remove('jtab-active');
        });
        const pane = $(`jochuk-tab-${tab}`);
        if (pane) { pane.classList.remove('hidden'); pane.style.display = 'flex'; }
        const btn = document.querySelector(`.jtab-btn[data-jtab="${tab}"]`);
        if (btn) btn.classList.add('jtab-active');
        if (tab === 'exchange') loadExchange();
        if (tab === 'recruit')  loadRecruit();
        if (tab === 'teams')    loadTeams();
    }

    // ── 폼 토글 ────────────────────────────────────────────────
    function toggleForm(id) {
        const el = $(id);
        if (!el) return;
        const hidden = el.style.display === 'none' || el.style.display === '';
        el.style.display = hidden ? 'flex' : 'none';
        el.style.flexDirection = 'column';
    }

    // ── 패널 열기/닫기 ─────────────────────────────────────────
    function openPanel() {
        const p = $('jochuk-panel');
        if (p) { p.style.display = 'flex'; }
        switchTab('exchange');
    }
    function closePanel() {
        const p = $('jochuk-panel');
        if (p) p.style.display = 'none';
    }

    // ── 공통 카드 래퍼 ─────────────────────────────────────────
    function card(content) {
        return `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;
                            padding:14px;margin-bottom:10px;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
                    ${content}
                </div>`;
    }
    function badge(txt, bg, color) {
        return `<span style="display:inline-block;padding:2px 8px;border-radius:99px;
                             font-size:10px;font-weight:800;background:${bg};color:${color};">${txt}</span>`;
    }
    function emptyMsg(txt) {
        return `<p style="text-align:center;color:#94a3b8;font-size:13px;padding:32px 0;">${txt}</p>`;
    }

    // ── A. 교류전 ──────────────────────────────────────────────
    async function loadExchange() {
        const p = new URLSearchParams();
        const r = v('jx-r'); const sk = v('jx-sk');
        if (r)  p.set('region', r);
        if (sk) p.set('skill_level', sk);
        const res = await fetch(`${_base()}/api/matches/exchange?${p}`);
        const { data } = await res.json();
        if (!$('jx-list')) return;
        $('jx-list').innerHTML = !data?.length ? emptyMsg('등록된 교류전이 없습니다') :
            data.map(m => card(`
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
                    <span style="font-weight:800;font-size:15px;">${m.team_name}</span>
                    ${m.status==='open' ? badge('모집중','#d1fae5','#065f46') : badge('마감','#f1f5f9','#64748b')}
                </div>
                <p style="font-size:11px;color:#94a3b8;margin-bottom:4px;">${m.region} ${m.district} · ${m.skill_level} · ${m.age_group}</p>
                <p style="font-size:13px;color:#334155;margin-bottom:2px;">📍 ${m.pitch_name}</p>
                <p style="font-size:12px;color:#64748b;margin-bottom:8px;">🗓 ${fmtDate(m.match_date)}</p>
                ${m.fee_total > 0 ? `<p style="font-size:12px;color:#475569;margin-bottom:8px;">💰 총 ${m.fee_total.toLocaleString()}원 → 팀당 <strong>${m.fee_each.toLocaleString()}원</strong></p>` : ''}
                ${m.status==='open' && m.contact_url ? `<a href="${m.contact_url}" target="_blank" rel="noopener"
                    style="display:block;text-align:center;padding:9px;background:#059669;color:#fff;
                           border-radius:8px;font-weight:800;font-size:13px;text-decoration:none;">연락하기 →</a>` : ''}
            `)).join('');
    }

    async function submitExchange() {
        const body = {
            team_name:   v('jx-team_name'),   region:      v('jx-region'),
            district:    v('jx-district'),     pitch_name:  v('jx-pitch_name'),
            match_date:  v('jx-match_date'),   skill_level: v('jx-skill_level'),
            age_group:   v('jx-age_group'),    fee_total:   parseInt(v('jx-fee_total')) || 0,
            contact_url: v('jx-contact_url'),
        };
        if (!body.team_name || !body.region || !body.district || !body.pitch_name || !body.match_date || !body.contact_url)
            return alert('* 표시 항목을 모두 입력하세요');
        const res = await fetch(`${_base()}/api/matches/exchange`,
            { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        if (!res.ok) return alert('등록 실패');
        toggleForm('jx-form');
        ['jx-team_name','jx-district','jx-pitch_name','jx-match_date','jx-contact_url']
            .forEach(id => { if ($(id)) $(id).value = ''; });
        await loadExchange();
    }

    // ── B. 선모집 후대관 ───────────────────────────────────────
    async function loadRecruit() {
        const p = new URLSearchParams();
        const r = v('jr-r');
        if (r) p.set('region', r);
        const res = await fetch(`${_base()}/api/matches/pre-recruit?${p}`);
        const { data } = await res.json();
        if (!$('jr-list')) return;
        $('jr-list').innerHTML = !data?.length ? emptyMsg('등록된 모집 공고가 없습니다') :
            data.map(m => {
                const pct = Math.round(m.current_players / m.max_players * 100);
                const confirmed = m.status === 'CONFIRMED';
                return card(`
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
                        <span style="font-weight:800;font-size:15px;">${m.title}</span>
                        ${confirmed ? badge('대관확정','#dbeafe','#1e40af') : badge('모집중','#dcfce7','#15803d')}
                    </div>
                    <p style="font-size:11px;color:#94a3b8;margin-bottom:4px;">${m.region} ${m.district}</p>
                    <p style="font-size:13px;color:#334155;margin-bottom:2px;">📍 ${m.pitch_name}</p>
                    <p style="font-size:12px;color:#64748b;margin-bottom:8px;">🗓 ${fmtDate(m.match_date)}</p>
                    ${m.fee_per_person > 0 ? `<p style="font-size:12px;color:#475569;margin-bottom:6px;">💰 1인 ${m.fee_per_person.toLocaleString()}원</p>` : ''}
                    <div style="margin-bottom:8px;">
                        <div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-bottom:4px;">
                            <span>참가 인원</span>
                            <span>${m.current_players} / ${m.max_players}명 (최소 ${m.min_players}명)</span>
                        </div>
                        <div style="height:6px;background:#f1f5f9;border-radius:99px;overflow:hidden;">
                            <div style="height:100%;width:${pct}%;background:${confirmed?'#3b82f6':'#4ade80'};border-radius:99px;transition:width 0.3s;"></div>
                        </div>
                    </div>
                    ${!confirmed ? `
                    <div style="display:flex;gap:6px;">
                        <input id="jr-nick-${m.id}" class="ji" placeholder="닉네임 입력" style="flex:1;">
                        <button onclick="JochukPlatform.joinRecruit('${m.id}')"
                            style="padding:0 14px;background:#2563eb;color:#fff;border:none;
                                   border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;">참가 신청</button>
                    </div>` : `<p style="font-size:12px;color:#2563eb;font-weight:800;">✅ 인원 확정! 대관 진행 중</p>`}
                `);
            }).join('');
    }

    async function submitRecruit() {
        const body = {
            title: v('jr-title'),             region:           v('jr-region'),
            district: v('jr-district'),        pitch_name:       v('jr-pitch_name'),
            match_date: v('jr-match_date'),    booking_deadline: v('jr-booking_deadline'),
            min_players: parseInt(v('jr-min_players')) || 10,
            max_players: parseInt(v('jr-max_players')) || 14,
            fee_per_person: parseInt(v('jr-fee_per_person')) || 0,
            booking_url: v('jr-booking_url'),  host_nickname:    v('jr-host_nickname'),
            contact_url: v('jr-contact_url'),
        };
        if (!body.title || !body.region || !body.district || !body.pitch_name || !body.match_date || !body.host_nickname)
            return alert('* 표시 항목을 모두 입력하세요');
        const res = await fetch(`${_base()}/api/matches/pre-recruit`,
            { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        if (!res.ok) return alert('등록 실패');
        toggleForm('jr-form');
        await loadRecruit();
    }

    async function joinRecruit(matchId) {
        const nick = v(`jr-nick-${matchId}`);
        if (!nick) return alert('닉네임을 입력하세요');
        const res = await fetch(`${_base()}/api/matches/pre-recruit/${matchId}/join`,
            { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ nickname: nick }) });
        const json = await res.json();
        if (!res.ok) return alert(json.detail || '오류 발생');
        await loadRecruit();
    }

    // ── C. 팀 디렉토리 ─────────────────────────────────────────
    async function loadTeams() {
        const p = new URLSearchParams();
        const r = v('jt-r'), d = v('jt-d'), sk = v('jt-sk'), rec = ck('jt-rec');
        if (r)   p.set('region', r);
        if (d)   p.set('district', d);
        if (sk)  p.set('skill_level', sk);
        if (rec) p.set('recruiting', 'true');
        const res = await fetch(`${_base()}/api/teams?${p}`);
        const { data } = await res.json();
        if (!$('jt-list')) return;
        $('jt-list').innerHTML = !data?.length ? emptyMsg('등록된 팀이 없습니다') :
            data.map(t => card(`
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5px;">
                    <span style="font-weight:800;font-size:15px;">${t.team_name}</span>
                    ${t.recruiting ? badge('모집중','#d1fae5','#065f46') : ''}
                </div>
                <p style="font-size:11px;color:#94a3b8;margin-bottom:4px;">${t.region} ${t.district} · ${t.age_group} · ${t.skill_level}</p>
                <p style="font-size:13px;color:#334155;margin-bottom:2px;">⏰ ${t.match_day} ${t.match_time} · ${t.member_count}명</p>
                ${t.home_pitch ? `<p style="font-size:13px;color:#334155;margin-bottom:4px;">📍 ${t.home_pitch}</p>` : ''}
                ${t.description ? `<p style="font-size:12px;color:#64748b;margin-bottom:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${t.description}</p>` : ''}
                ${t.open_chat_url ? `<a href="${t.open_chat_url}" target="_blank" rel="noopener"
                    style="font-size:13px;color:#2563eb;font-weight:700;text-decoration:underline;">오픈채팅 →</a>` : ''}
            `)).join('');
    }

    async function submitTeam() {
        const body = {
            team_name: v('jt-team_name'),     region:        v('jt-region'),
            district:  v('jt-district'),       home_pitch:    v('jt-home_pitch'),
            match_day: v('jt-match_day'),      match_time:    v('jt-match_time'),
            age_group: v('jt-age_group'),      skill_level:   v('jt-skill_level'),
            member_count: parseInt(v('jt-member_count')) || 11,
            open_chat_url: v('jt-open_chat_url'),
            description:   v('jt-description'),
            recruiting:    ck('jt-recruiting'),
        };
        if (!body.team_name || !body.region || !body.district || !body.age_group || !body.skill_level)
            return alert('* 표시 항목을 모두 입력하세요');
        const res = await fetch(`${_base()}/api/teams`,
            { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        if (!res.ok) return alert('등록 실패');
        toggleForm('jt-form');
        await loadTeams();
    }

    // ── 이벤트 바인딩 ──────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        $('jochuk-open-btn')?.addEventListener('click', openPanel);
        $('jochuk-close-btn')?.addEventListener('click', closePanel);

        document.querySelectorAll('.jtab-btn').forEach(btn =>
            btn.addEventListener('click', () => switchTab(btn.dataset.jtab))
        );

        // map-page가 visible 상태로 바뀌면 FAB 표시
        const mapEl = document.getElementById('map-page');
        if (mapEl) {
            new MutationObserver(() => {
                const visible = !mapEl.classList.contains('opacity-0')
                             && !mapEl.classList.contains('pointer-events-none');
                const fab = $('jochuk-fab');
                if (fab) fab.style.display = visible ? 'block' : 'none';
            }).observe(mapEl, { attributes: true, attributeFilter: ['class'] });
        }
    });

    return { loadExchange, submitExchange, loadRecruit, submitRecruit, joinRecruit,
             loadTeams, submitTeam, toggleForm, openPanel, closePanel };

})();

// ═══════════════════════════════════════════════════════════════
// 🏟️  VenuePlatform — 구장 매칭판 (로그인·팀매칭·용병·리뷰)
// ═══════════════════════════════════════════════════════════════
window.VenuePlatform = (function () {
    'use strict';

    const _base = () =>
        (document.documentElement.dataset.apiUrl || window.location.origin).replace(/\/$/, '');
    const $  = id  => document.getElementById(id);
    const v  = id  => ($(`${id}`)?.value ?? '').trim();
    const FEE = { '50_50':'반반', 'host_pays':'홈팀 부담', 'loser_pays':'패팀 부담' };

    let _user      = null;
    let _venueId   = null;
    let _activeTab = 'match';
    let _isRental  = false;

    // ── 로그인 ──────────────────────────────────────────────────
    function _loadSaved() {
        const raw = localStorage.getItem('pm_user');
        if (raw) _user = JSON.parse(raw);
    }

    function openLoginModal()  { const m=$('pm-login-modal'); if(m) m.style.display='flex'; }
    function closeLoginModal() { const m=$('pm-login-modal'); if(m) m.style.display='none'; }

    // ── 카카오 로그인 — 팝업 방식 (postMessage로 부모창 동기화) ───
    function openKakaoLogin() {
        closeLoginModal();
        const popup = window.open(
            `${_base()}/api/auth/kakao/login`,
            'kakao_login',
            'width=520,height=720,scrollbars=yes,resizable=yes,toolbar=no,menubar=no,location=no'
        );
        // 팝업 차단 시 전체 페이지 리다이렉트로 폴백
        if (!popup || popup.closed || typeof popup.closed === 'undefined') {
            window.location.href = `${_base()}/api/auth/kakao/login`;
        }
    }

    // ── URL 파라미터로 돌아온 Kakao 콜백 처리 ───────────────────
    async function _handleKakaoRedirect() {
        const sp = new URLSearchParams(window.location.search);

        // 오류 처리
        const err = sp.get('pm_kakao_err');
        if (err) {
            window.history.replaceState({}, document.title, '/');
            alert(`카카오 로그인 오류: ${err}`);
            return;
        }

        // URL 인가 코드(code) 감지 시 백엔드 직접 fetch 처리 (Kakao Redirect URI가 루트로 유도될 경우 대비)
        const code = sp.get('code');
        if (code) {
            window.history.replaceState({}, document.title, '/');
            if (_user && _user.token) {
                return; // 이미 로그인 세션이 있으면 무시 (인가 코드 중복 사용으로 인한 invalid_grant 방지)
            }
            try {
                const res = await fetch(`${_base()}/api/auth/kakao/callback?code=${code}&format=json`);
                if (!res.ok) {
                    const errJson = await res.json();
                    throw new Error(errJson.detail || '로그인 처리 실패');
                }
                const user = await res.json();
                _user = user;
                localStorage.setItem('pm_user', JSON.stringify(user));
                _syncTopbarBtn();

                if (!user.profile_complete) {
                    const greet = $('pm-profile-greet');
                    if (greet) greet.textContent = `${user.nickname}님, 환영해요! 🎉`;
                    const av = $('pm-profile-avatar');
                    if (av && user.avatar) { av.src = user.avatar; av.style.display = 'inline-block'; }
                    const nickEl = $('pm-profile-nick');
                    if (nickEl) nickEl.value = user.nickname || '';
                    const modal = $('pm-profile-modal');
                    if (modal) modal.style.display = 'flex';
                } else {
                    _renderUserBar();
                    if ($('vp-tab-body')) _loadTab(_activeTab);
                }

                // 팝업 창 안에서 이 코드가 실행되었다면
                const isPopup = window.name === 'kakao_login' || (window.opener && window.opener !== window);
                if (isPopup) {
                    if (window.opener && !window.opener.closed) {
                        window.opener.postMessage({ type: 'KAKAO_LOGIN_DONE', user }, '*');
                    }
                    window.close();
                }
                return;
            } catch (e) {
                alert(`카카오 로그인 실패: ${e.message}`);
                return;
            }
        }

        const token = sp.get('pm_token');
        if (!token) return;

        const isNew = sp.get('pm_new') === '1';
        const isProfileComplete = sp.get('pm_pc') === '1';

        // 기존 localStorage 유저의 프로필 데이터 병합 (재로그인 시 보존)
        let prevRegion = '', prevPosition = '올포지션', prevSkill = '';
        if (!isNew) {
            try {
                const prev = JSON.parse(localStorage.getItem('pm_user') || '{}');
                if (prev.kakao_id === sp.get('pm_kid')) {
                    prevRegion   = prev.region   || '';
                    prevPosition = prev.position || '올포지션';
                    prevSkill    = prev.skill    || '';
                }
            } catch {}
        }

        const user = {
            token:            token,
            nickname:         sp.get('pm_nick') || '카카오유저',
            kakao_id:         sp.get('pm_kid')  || '',
            avatar:           sp.get('pm_av')   || '',
            region:           prevRegion,
            position:         prevPosition,
            skill:            prevSkill,
            profile_complete: isProfileComplete || (!isNew && !!prevRegion && !!prevSkill),
        };

        _user = user;
        localStorage.setItem('pm_user', JSON.stringify(user));

        // URL 쿼리스트링 제거
        window.history.replaceState({}, document.title, '/');

        _syncTopbarBtn();

        if (!user.profile_complete) {
            // 프로필 모달 열기
            const greet = $('pm-profile-greet');
            if (greet) greet.textContent = isNew
                ? `${user.nickname}님, 환영해요! 🎉`
                : `${user.nickname}님, 프로필을 완성해 주세요`;
            const av = $('pm-profile-avatar');
            if (av && user.avatar) { av.src = user.avatar; av.style.display = 'inline-block'; }
            const nickEl = $('pm-profile-nick');
            if (nickEl) nickEl.value = user.nickname;
            const modal = $('pm-profile-modal');
            if (modal) modal.style.display = 'flex';
        } else {
            _renderUserBar();
            if ($('vp-tab-body')) _loadTab(_activeTab);
        }
    }

    // ── 프로필 설정 저장 (닉네임·지역·포지션·실력) ──────────────
    async function submitProfile() {
        if (!_user) return;

        // 개인정보 수집 동의 필수 체크
        const privacyEl = document.getElementById('pm-privacy-agree');
        if (privacyEl && !privacyEl.checked) {
            alert('개인정보 수집 및 이용에 동의해야 프로필을 등록할 수 있습니다.');
            return;
        }

        const nickname = $('pm-profile-nick')?.value?.trim() || _user.nickname;
        const region   = $('pm-profile-region')?.value?.trim();
        const pos      = document.querySelector('input[name="pm-profile-pos-r"]:checked')?.value
                         || '올포지션';
        const skill    = document.querySelector('input[name="pm-profile-skill"]:checked')?.value;

        if (!region) return alert('선호 지역을 입력해 주세요.');
        if (!skill)  return alert('실력 레벨을 선택해 주세요.');

        try {
            const res = await fetch(`${_base()}/api/auth/me`, {
                method: 'PATCH',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    token: _user.token, nickname, region, position: pos, skill,
                }),
            });
            if (res.ok) { const { data } = await res.json(); _user = data; }
            else throw new Error();
        } catch {
            // 서버 저장 실패 시 로컬 적용
            _user = { ..._user, nickname, region, position: pos, skill, profile_complete: true };
        }

        localStorage.setItem('pm_user', JSON.stringify(_user));
        const m = $('pm-profile-modal');
        if (m) m.style.display = 'none';
        _syncTopbarBtn();
        _renderUserBar();
        if ($('vp-tab-body')) _loadTab(_activeTab);
    }

    async function submitLogin() {
        const nick = v('pm-login-nick'), region = v('pm-login-region'),
              pos  = v('pm-login-pos');
        if (!nick || !region) return alert('닉네임과 지역을 입력하세요');
        const res  = await fetch(`${_base()}/api/auth/login`, {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ nickname: nick, region, position: pos })
        });
        const { data } = await res.json();
        _user = data;
        localStorage.setItem('pm_user', JSON.stringify(data));
        closeLoginModal();
        _syncTopbarBtn();
        _renderUserBar();
        await _loadTab(_activeTab);
    }

    function _logout() {
        _user = null;
        localStorage.removeItem('pm_user');
        _syncTopbarBtn();
        _renderUserBar();
        _loadTab(_activeTab);
    }

    async function _withdraw() {
        if (!_user) return;
        const nick = _user.nickname;
        if (!confirm(`${nick}님, 정말 탈퇴하시겠습니까?\n\n탈퇴 시 카카오 연결 해제 및 모든 데이터가 즉시 파기됩니다.`)) return;
        try {
            await fetch(`${_base()}/api/auth/kakao/withdraw`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: _user.token }),
            });
        } catch (_) {}
        _logout();
        alert('탈퇴가 완료되었습니다.');
    }

    // ── 구장 섹션 주입 ───────────────────────────────────────────
    function load(venueName, isRental = false) {
        _loadSaved();
        _venueId   = encodeURIComponent(venueName.trim());
        _isRental  = isRental;
        _activeTab = isRental ? 'match' : 'review';
        $('vp-section')?.remove();

        const scroll = $('match-list-scroll');
        if (!scroll) return;

        const TAB_LABELS = { match: '팀 매칭', recruit: '용병 모집', review: '리뷰' };
        const tabs = isRental ? ['match', 'recruit', 'review'] : ['review'];

        const tabBar = isRental ? `
            <div style="display:flex;border-bottom:2px solid #e2e8f0;padding:0 14px;">
              ${tabs.map((t, i) => `
                <button class="vp-tbtn" data-vt="${t}"
                  style="flex:1;padding:9px 4px;font-size:12px;font-weight:700;border:none;
                         background:none;cursor:pointer;
                         color:${i===0?'#2563eb':'#64748b'};
                         border-bottom:${i===0?'2.5px solid #2563eb':'2.5px solid transparent'};
                         margin-bottom:-2px;">
                  ${TAB_LABELS[t]}
                </button>`).join('')}
            </div>` : '';

        const headerNote = isRental
            ? ''
            : `<p style="font-size:11px;color:#94a3b8;padding:0 14px 8px;margin:0;">
                 대관 예약 불가 구장입니다. 방문 후기 및 잔디·매너 평점을 남겨주세요.
               </p>`;

        const sec = document.createElement('div');
        sec.id = 'vp-section';
        sec.innerHTML = `
          <div style="border-top:2px dashed #e2e8f0;padding:14px 0 4px;">
            <p style="font-weight:900;font-size:14px;color:#1e293b;
                      margin-bottom:${isRental?'10px':'4px'};padding:0 14px;">
              ${isRental ? '🏟️ 이 구장에서 매칭하기' : '📝 구장 리뷰'}
            </p>
            ${headerNote}
            <div id="vp-user-bar" style="padding:0 14px 10px;"></div>
            ${tabBar}
            <div id="vp-tab-body" style="padding:12px 14px;"></div>
          </div>`;
        scroll.appendChild(sec);

        if (isRental) {
            sec.querySelectorAll('.vp-tbtn').forEach(btn =>
                btn.addEventListener('click', () => _switchTab(btn.dataset.vt))
            );
        }
        _renderUserBar();
        _loadTab(_activeTab);
    }

    function _renderUserBar() {
        const el = $('vp-user-bar'); if (!el) return;
        if (_user) {
            const avatarHtml = _user.avatar
                ? `<img src="${_user.avatar}" width="28" height="28"
                        style="border-radius:50%;object-fit:cover;border:2px solid #FEE500;flex-shrink:0;"
                        onerror="this.style.display='none'">`
                : `<span style="font-size:11px;background:#2563eb;color:#fff;
                               padding:2px 8px;border-radius:99px;font-weight:800;flex-shrink:0;">
                     ${_user.position || '올포지션'}
                   </span>`;
            const kakaoTag = _user.kakao_id
                ? `<span style="font-size:9px;background:#FEE500;color:#3C1E1E;
                               padding:1px 5px;border-radius:3px;font-weight:800;">K</span>`
                : '';
            el.innerHTML = `
              <div style="display:flex;align-items:center;justify-content:space-between;
                           background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:8px 12px;">
                <div style="display:flex;align-items:center;gap:6px;">
                  ${avatarHtml}
                  <span style="font-size:13px;font-weight:800;">${_user.nickname}</span>
                  ${kakaoTag}
                  <span style="font-size:11px;color:#64748b;">${_user.region || ''}</span>
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                  <button onclick="VenuePlatform._logout()"
                    style="font-size:11px;color:#94a3b8;border:none;background:none;cursor:pointer;padding:0;">
                    로그아웃
                  </button>
                  <span style="font-size:10px;color:#cbd5e1;">|</span>
                  <button onclick="VenuePlatform._withdraw()"
                    style="font-size:11px;color:#f87171;border:none;background:none;cursor:pointer;padding:0;">
                    탈퇴
                  </button>
                </div>
              </div>`;
        } else {
            el.innerHTML = `
              <button onclick="VenuePlatform.openKakaoLogin()"
                style="width:100%;padding:10px 14px;background:#FEE500;color:#3C1E1E;border:none;
                       border-radius:10px;font-weight:900;font-size:13px;cursor:pointer;
                       display:flex;align-items:center;justify-content:center;gap:6px;">
                <svg width="16" height="16" viewBox="0 0 24 24" style="flex-shrink:0;">
                  <path fill="#3C1E1E" d="M12 3C6.48 3 2 6.93 2 11.75c0 3.08 1.74 5.79
                  4.36 7.34L5.25 22.5l4.56-2.48A10.5 10.5 0 0 0 12 20.5c5.52 0
                  10-3.93 10-8.75S17.52 3 12 3z"/>
                </svg>
                ${_isRental ? '카카오로 1초 로그인 후 매칭 참여' : '카카오로 1초 로그인 후 리뷰 남기기'}
              </button>`;
        }
    }

    function _switchTab(tab) {
        _activeTab = tab;
        $('vp-section')?.querySelectorAll('.vp-tbtn').forEach(btn => {
            const on = btn.dataset.vt === tab;
            btn.style.color = on ? '#2563eb' : '#64748b';
            btn.style.borderBottom = on ? '2.5px solid #2563eb' : '2.5px solid transparent';
        });
        _loadTab(tab);
    }

    async function _loadTab(tab) {
        const el = $('vp-tab-body'); if (!el || !_venueId) return;
        if (tab === 'match')   await _tabMatch(el);
        if (tab === 'recruit') await _tabRecruit(el);
        if (tab === 'review')  await _tabReview(el);
    }

    // 공통 카드 헬퍼
    const _card  = html => `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;
                                        padding:12px;margin-bottom:8px;">${html}</div>`;
    const _badge = (txt,bg,c) => `<span style="font-size:10px;padding:2px 8px;border-radius:99px;
                                               font-weight:800;background:${bg};color:${c};">${txt}</span>`;
    const _fmt   = iso => { try { return new Date(iso).toLocaleString('ko-KR',
        {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}); } catch { return iso; } };
    const _loginBtn = (label) =>
        `<div style="background:#fefce8;border:1.5px dashed #fde68a;border-radius:12px;
                     padding:14px;margin-bottom:12px;text-align:center;">
           <p style="font-size:12px;font-weight:800;color:#92400e;margin:0 0 10px;">
             카카오 로그인이 필요한 서비스입니다
           </p>
           <p style="font-size:11px;color:#b45309;margin:0 0 10px;">${label}</p>
           <button onclick="VenuePlatform.openKakaoLogin()"
             style="width:100%;padding:10px 14px;background:#FEE500;color:#3C1E1E;border:none;
                    border-radius:8px;font-weight:900;font-size:13px;cursor:pointer;
                    display:flex;align-items:center;justify-content:center;gap:6px;">
             <svg width="16" height="16" viewBox="0 0 24 24" style="flex-shrink:0;">
               <path fill="#3C1E1E" d="M12 3C6.48 3 2 6.93 2 11.75c0 3.08 1.74 5.79
               4.36 7.34L5.25 22.5l4.56-2.48A10.5 10.5 0 0 0 12 20.5c5.52 0
               10-3.93 10-8.75S17.52 3 12 3z"/>
             </svg>
             카카오로 1초 로그인
           </button>
         </div>`;
    const _profileCompletePrompt = () =>
        `<div style="background:#fef3c7;border:1.5px dashed #fcd34d;border-radius:12px;
                     padding:14px;margin-bottom:12px;text-align:center;">
           <p style="font-size:13px;font-weight:800;color:#92400e;margin:0 0 6px;">
             프로필 설정을 완료해야 이용 가능합니다</p>
           <p style="font-size:11px;color:#b45309;margin:0 0 10px;">
             닉네임·선호 지역·포지션·레벨을 설정해 주세요.</p>
           <button onclick="document.getElementById('pm-profile-modal').style.display='flex'"
             style="padding:9px 20px;background:#2563eb;color:#fff;border:none;
                    border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;">
             프로필 설정하기
           </button>
         </div>`;

    const _empty = txt => `<p style="text-align:center;color:#94a3b8;font-size:13px;
                                      padding:16px 0;">${txt}</p>`;

    // ── 팀 매칭 탭 ──────────────────────────────────────────────
    async function _tabMatch(el) {
        const { data } = await (await fetch(`${_base()}/api/venue/${_venueId}/matches`)).json();

        const form = !_user
            ? _loginBtn('팀 매칭 신청, 조건 제시, 상대팀 연결 기능')
            : !_user.profile_complete ? _profileCompletePrompt()
            : `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;
                      padding:12px;margin-bottom:12px;display:flex;flex-direction:column;gap:6px;">
            <p style="font-size:12px;font-weight:800;color:#475569;">팀 매칭 신청</p>
            <input class="ji" id="vp-m-date" type="datetime-local">
            <div style="display:flex;gap:6px;">
              <select class="ji" id="vp-m-size" style="flex:1;">
                <option>5vs5</option><option>6vs6</option><option>7vs7</option><option>풀코트</option>
              </select>
              <select class="ji" id="vp-m-skill" style="flex:1;">
                <option>중급</option><option>입문</option><option>초급</option><option>고급</option>
              </select>
            </div>
            <select class="ji" id="vp-m-fee">
              <option value="50_50">구장비 반반</option>
              <option value="host_pays">홈팀 부담</option>
              <option value="loser_pays">패팀 부담</option>
            </select>
            <input class="ji" id="vp-m-url" placeholder="연락처 URL *">
            <input class="ji" id="vp-m-memo" placeholder="한마디 (선택)">
            <button onclick="VenuePlatform._submitMatch()"
              style="padding:9px;background:#059669;color:#fff;border:none;
                     border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;">
              팀 매칭 등록
            </button>
          </div>`;

        const list = !data.length ? _empty('등록된 팀 매칭이 없습니다') :
            data.map(m => _card(`
              <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                <span style="font-weight:800;font-size:13px;">${m.created_by}</span>
                ${_badge(m.size,'#dcfce7','#15803d')}
              </div>
              <p style="font-size:11px;color:#94a3b8;margin-bottom:4px;">
                ${_fmt(m.match_date)} · ${m.skill_level} · ${FEE[m.fee_policy]||m.fee_policy}
              </p>
              ${m.memo?`<p style="font-size:12px;color:#475569;margin-bottom:6px;">${m.memo}</p>`:''}
              ${m.status==='open'&&m.contact_url?`<a href="${m.contact_url}" target="_blank" rel="noopener"
                style="font-size:12px;color:#059669;font-weight:700;text-decoration:underline;">
                연락하기 →</a>`:''}`)).join('');

        el.innerHTML = form + list;
    }

    async function _submitMatch() {
        if (!_user) return openLoginModal();
        if (!_user.profile_complete) return;
        const body = { token: _user.token, match_date: v('vp-m-date'),
                       size: v('vp-m-size'), skill_level: v('vp-m-skill'),
                       fee_policy: v('vp-m-fee'), contact_url: v('vp-m-url'),
                       memo: v('vp-m-memo') };
        if (!body.match_date || !body.contact_url) return alert('날짜와 연락처 URL을 입력하세요');
        const res = await fetch(`${_base()}/api/venue/${_venueId}/matches`,
            { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        if (res.ok) await _tabMatch($('vp-tab-body'));
    }

    // ── 용병 모집 탭 ────────────────────────────────────────────
    async function _tabRecruit(el) {
        const { data } = await (await fetch(`${_base()}/api/venue/${_venueId}/recruit`)).json();

        const form = !_user
            ? _loginBtn('개인 용병 모집 글 등록 및 참가 신청 기능')
            : !_user.profile_complete ? _profileCompletePrompt()
            : `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;
                      padding:12px;margin-bottom:12px;display:flex;flex-direction:column;gap:6px;">
            <p style="font-size:12px;font-weight:800;color:#475569;">용병 모집 등록</p>
            <input class="ji" id="vp-rc-date" type="datetime-local">
            <div style="display:flex;gap:6px;">
              <input class="ji" id="vp-rc-max" type="number" placeholder="목표 인원" value="10" style="flex:1;">
              <input class="ji" id="vp-rc-fee" type="number" placeholder="1인 참가비(원)" value="0" style="flex:1;">
            </div>
            <select class="ji" id="vp-rc-size">
              <option>5vs5</option><option>6vs6</option><option>7vs7</option><option>풀코트</option>
            </select>
            <input class="ji" id="vp-rc-url" placeholder="연락처 URL *">
            <input class="ji" id="vp-rc-memo" placeholder="한마디 (선택)">
            <button onclick="VenuePlatform._submitRecruit()"
              style="padding:9px;background:#7c3aed;color:#fff;border:none;
                     border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;">
              용병 모집 등록
            </button>
          </div>`;

        const list = !data.length ? _empty('모집 중인 용병 공고가 없습니다') :
            data.map(m => {
                const pct = Math.round(m.current_players / m.max_players * 100);
                const joinBtn = !_user
                    ? `<button onclick="VenuePlatform.openLoginModal()"
                         style="width:100%;padding:7px;background:#e2e8f0;color:#64748b;border:none;
                                border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;">
                         로그인 후 참가 신청</button>`
                    : !_user.profile_complete
                    ? `<button onclick="document.getElementById('pm-profile-modal').style.display='flex'"
                         style="width:100%;padding:7px;background:#fcd34d;color:#92400e;border:none;
                                border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;">
                         프로필 설정 후 참가 신청</button>`
                    : `<button onclick="VenuePlatform._joinRecruit('${m.id}')"
                         style="width:100%;padding:7px;background:#7c3aed;color:#fff;border:none;
                                border-radius:8px;font-weight:700;font-size:12px;cursor:pointer;">
                         참가 신청</button>`;
                return _card(`
                  <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-weight:800;font-size:13px;">${m.created_by}</span>
                    ${_badge(m.size,'#ede9fe','#6d28d9')}
                  </div>
                  <p style="font-size:11px;color:#94a3b8;margin-bottom:6px;">
                    ${_fmt(m.match_date)}${m.fee_per_person>0?` · ${m.fee_per_person.toLocaleString()}원/인`:''}
                  </p>
                  <div style="margin-bottom:8px;">
                    <div style="display:flex;justify-content:space-between;font-size:11px;
                                color:#94a3b8;margin-bottom:3px;">
                      <span>참가 인원</span><span>${m.current_players}/${m.max_players}명</span>
                    </div>
                    <div style="height:5px;background:#f1f5f9;border-radius:99px;overflow:hidden;">
                      <div style="height:100%;width:${pct}%;background:#7c3aed;border-radius:99px;"></div>
                    </div>
                  </div>
                  ${joinBtn}`);
            }).join('');

        el.innerHTML = form + list;
    }

    async function _submitRecruit() {
        if (!_user) return openLoginModal();
        if (!_user.profile_complete) return;
        const body = { token: _user.token, match_date: v('vp-rc-date'),
                       max_players: parseInt(v('vp-rc-max'))||10,
                       fee_per_person: parseInt(v('vp-rc-fee'))||0,
                       size: v('vp-rc-size'), contact_url: v('vp-rc-url'),
                       memo: v('vp-rc-memo') };
        if (!body.match_date || !body.contact_url) return alert('날짜와 연락처 URL을 입력하세요');
        const res = await fetch(`${_base()}/api/venue/${_venueId}/recruit`,
            { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
        if (res.ok) await _tabRecruit($('vp-tab-body'));
    }

    async function _joinRecruit(rid) {
        if (!_user) return openLoginModal();
        const res = await fetch(`${_base()}/api/venue/${_venueId}/recruit/${rid}/join`,
            { method:'POST', headers:{'Content-Type':'application/json'},
              body: JSON.stringify({ token: _user.token }) });
        const json = await res.json();
        if (!res.ok) return alert(json.detail || '오류');
        await _tabRecruit($('vp-tab-body'));
    }

    // ── 리뷰 탭 ─────────────────────────────────────────────────
    const _TURF_STAR   = { '상':'🟢 좋음', '중':'🟡 보통', '하':'🔴 나쁨' };
    const _MANNER_ICON = { '상':'😊 매너 좋음', '중':'😐 보통', '하':'😞 아쉬움' };

    async function _tabReview(el) {
        const { data } = await (await fetch(`${_base()}/api/venue/${_venueId}/reviews`)).json();

        const stats = data.length ? (() => {
            const cnt = g => data.filter(r => r[g[0]] === g[1]).length;
            const best = v => ['상','중','하'].sort((a,b) => cnt([v,b])-cnt([v,a]))[0];
            return `<div style="display:flex;gap:6px;margin-bottom:10px;">
              <div style="flex:1;background:#fefce8;border:1px solid #fde68a;border-radius:10px;
                          padding:8px;text-align:center;">
                <p style="font-size:10px;font-weight:700;color:#92400e;">잔디</p>
                <p style="font-size:13px;font-weight:800;">${_TURF_STAR[best('turf')]||'-'}</p>
              </div>
              <div style="flex:1;background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;
                          padding:8px;text-align:center;">
                <p style="font-size:10px;font-weight:700;color:#075985;">매너</p>
                <p style="font-size:13px;font-weight:800;">${_MANNER_ICON[best('manner')]||'-'}</p>
              </div>
              <div style="flex:1;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;
                          padding:8px;text-align:center;">
                <p style="font-size:10px;font-weight:700;color:#15803d;">리뷰 수</p>
                <p style="font-size:18px;font-weight:900;color:#15803d;">${data.length}</p>
              </div>
            </div>`;
        })() : '';

        const selRow = (name, label, opts) => `
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <span style="font-size:12px;color:#64748b;width:40px;flex-shrink:0;">${label}</span>
            ${opts.map(o => `
              <label style="flex:1;cursor:pointer;text-align:center;">
                <input type="radio" name="vp-rv-${name}" value="${o}"
                       style="display:none;" onchange="VenuePlatform._onRadio(this)">
                <span class="vp-rv-opt" style="display:block;padding:5px 2px;
                     border:1.5px solid #e2e8f0;border-radius:8px;font-size:12px;
                     font-weight:700;user-select:none;">${o}</span>
              </label>`).join('')}
          </div>`;

        const form = !_user
            ? _loginBtn('잔디 상태 및 매너 평점 리뷰 작성 기능')
            : !_user.profile_complete ? _profileCompletePrompt()
            : `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;
                      padding:12px;margin-bottom:12px;">
            <p style="font-size:12px;font-weight:800;color:#475569;margin-bottom:8px;">리뷰 남기기</p>
            ${selRow('turf','잔디',['상','중','하'])}
            ${selRow('manner','매너',['상','중','하'])}
            <input class="ji" id="vp-rv-comment" placeholder="한줄 리뷰 *" style="margin:4px 0 8px;">
            <button onclick="VenuePlatform._submitReview()"
              style="width:100%;padding:9px;background:#f59e0b;color:#fff;border:none;
                     border-radius:8px;font-weight:800;font-size:13px;cursor:pointer;">
              리뷰 등록
            </button>
          </div>`;

        const list = !data.length ? _empty('첫 번째 리뷰를 남겨보세요!') :
            data.map(r => _card(`
              <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
                <span style="font-weight:800;font-size:13px;">${r.nickname}</span>
                <span style="font-size:10px;color:#94a3b8;">${r.region}</span>
              </div>
              <div style="display:flex;gap:5px;margin-bottom:6px;">
                ${_badge(_TURF_STAR[r.turf],'#fef9c3','#92400e')}
                ${_badge(_MANNER_ICON[r.manner],'#e0f2fe','#075985')}
              </div>
              <p style="font-size:13px;color:#334155;">${r.comment}</p>`)).join('');

        el.innerHTML = form + stats + list;
    }

    // 라디오 버튼 선택 시각화 (전역 노출 필요)
    function _onRadio(radio) {
        const sec = $('vp-section');
        if (!sec) return;
        sec.querySelectorAll(`input[name="${radio.name}"]`).forEach(r => {
            if (r.nextElementSibling) {
                r.nextElementSibling.style.borderColor = '#e2e8f0';
                r.nextElementSibling.style.background  = '#fff';
                r.nextElementSibling.style.color       = '#1e293b';
            }
        });
        if (radio.nextElementSibling) {
            radio.nextElementSibling.style.borderColor = '#f59e0b';
            radio.nextElementSibling.style.background  = '#fef3c7';
            radio.nextElementSibling.style.color       = '#92400e';
        }
    }

    async function _submitReview() {
        if (!_user) return openLoginModal();
        if (!_user.profile_complete) return;
        const get = name => $('vp-section')?.querySelector(`input[name="${name}"]:checked`)?.value;
        const turf = get('vp-rv-turf'), manner = get('vp-rv-manner'), comment = v('vp-rv-comment');
        if (!turf || !manner || !comment) return alert('잔디·매너·한줄평을 모두 입력하세요');
        const res = await fetch(`${_base()}/api/venue/${_venueId}/reviews`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ token: _user.token, turf, manner, comment })
        });
        if (res.ok) await _tabReview($('vp-tab-body'));
    }

    // ── 탑바 버튼 텍스트 동기화 ─────────────────────────────────
    function _syncTopbarBtn() {
        const btn   = $('pm-topbar-login-btn');
        const label = $('pm-topbar-login-label');
        if (!btn || !label) return;
        if (_user) {
            // 카카오 유저: 노란 K 배지 + 닉네임
            const kTag = _user.kakao_id
                ? '<span style="font-size:9px;background:#FEE500;color:#3C1E1E;padding:1px 4px;border-radius:3px;font-weight:900;margin-right:3px;">K</span>'
                : '';
            label.innerHTML = `${kTag}${_user.nickname}`;
            btn.style.color       = '#059669';
            btn.style.borderColor = '#a7f3d0';
            btn.style.background  = '#f0fdf4';
            btn.onclick = () => {
                if (confirm(`${_user.nickname}님, 로그아웃 할까요?`)) _logout();
            };
        } else {
            label.textContent = '로그인';
            btn.style.color       = '#2563eb';
            btn.style.borderColor = '#bfdbfe';
            btn.style.background  = '#eff6ff';
            btn.onclick = openLoginModal;
        }
    }

    // ── 초기화 ──────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        _loadSaved();
        _handleKakaoRedirect();   // URL 파라미터로 돌아온 카카오 콜백 처리
        _syncTopbarBtn();

        // 모달 배경 클릭 시 닫기
        $('pm-login-modal')?.addEventListener('click', e => {
            if (e.target === $('pm-login-modal')) closeLoginModal();
        });
        $('pm-profile-modal')?.addEventListener('click', e => {
            if (e.target === $('pm-profile-modal')) $('pm-profile-modal').style.display = 'none';
        });

        // 첫 방문 & 미로그인 시 3초 후 로그인 유도
        if (!_user && !localStorage.getItem('pm_login_prompted')) {
            setTimeout(() => {
                localStorage.setItem('pm_login_prompted', '1');
                openLoginModal();
            }, 3000);
        }
    });

    // ── 카카오 팝업 → postMessage 수신 ──────────────────────────
    window.addEventListener('message', function(e) {
        if (!e.data || typeof e.data !== 'object') return;
        if (e.origin !== window.location.origin) return;

        if (e.data.type === 'KAKAO_LOGIN_DONE') {
            const user = e.data.user;
            if (!user?.token) return;
            _user = user;
            localStorage.setItem('pm_user', JSON.stringify(user));
            closeLoginModal();
            _syncTopbarBtn();

            if (!user.profile_complete) {
                // 프로필 미완성 → 설정 모달 열기 (닉네임·아바타 자동 세팅)
                const isNew = !user.region && !user.skill;
                const greet = $('pm-profile-greet');
                if (greet) greet.textContent = isNew
                    ? `${user.nickname}님, 환영해요! 🎉`
                    : `${user.nickname}님, 프로필을 완성해 주세요`;
                const av = $('pm-profile-avatar');
                if (av && user.avatar) { av.src = user.avatar; av.style.display = 'inline-block'; }
                const nickEl = $('pm-profile-nick');
                if (nickEl) nickEl.value = user.nickname || '';
                // 개인정보 동의 체크박스 & 제출 버튼 초기화
                const privacyCb = $('pm-privacy-agree');
                if (privacyCb) { privacyCb.checked = false; }
                const submitBtn = $('pm-profile-submit-btn');
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.style.background = '#94a3b8';
                    submitBtn.style.cursor = 'not-allowed';
                    submitBtn.style.opacity = '0.65';
                }
                const modal = $('pm-profile-modal');
                if (modal) modal.style.display = 'flex';
            } else {
                _renderUserBar();
                if ($('vp-tab-body')) _loadTab(_activeTab);
            }
        } else if (e.data.type === 'KAKAO_LOGIN_ERR') {
            alert(`카카오 로그인 오류: ${e.data.msg || '다시 시도해 주세요.'}`);
        }
    });

    // ── localStorage 동기화 수신 (window.opener 유실 시 대응) ───
    window.addEventListener('storage', function(e) {
        if (e.key === 'pm_user' && e.newValue) {
            try {
                const user = JSON.parse(e.newValue);
                if (!user?.token) return;
                _user = user;
                closeLoginModal();
                _syncTopbarBtn();

                if (!user.profile_complete) {
                    const greet = $('pm-profile-greet');
                    if (greet) greet.textContent = `${user.nickname}님, 환영해요! 🎉`;
                    const av = $('pm-profile-avatar');
                    if (av && user.avatar) { av.src = user.avatar; av.style.display = 'inline-block'; }
                    const nickEl = $('pm-profile-nick');
                    if (nickEl) nickEl.value = user.nickname || '';
                    const modal = $('pm-profile-modal');
                    if (modal) modal.style.display = 'flex';
                } else {
                    _renderUserBar();
                    if ($('vp-tab-body')) _loadTab(_activeTab);
                }
            } catch (err) {}
        }
    });

    return { load, openLoginModal, closeLoginModal, submitLogin,
             openKakaoLogin, submitProfile,
             _logout, _withdraw, _submitMatch, _submitRecruit, _joinRecruit,
             _submitReview, _onRadio };
})();
