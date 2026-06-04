/* ================================================================
   풋살모여 — main.js
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

    // 날짜 필터 + 검색어 필터 동시 적용
    function applyFilters() {
        const q = stadiumSearch.value.trim().toLowerCase();
        markers.forEach(({ overlay, dates, stadiumData }) => {
            const dateOk = currentDateFilter === 'ALL' || dates.has(currentDateFilter);
            const searchOk = !q || stadiumData.name.toLowerCase().includes(q);
            overlay.setMap(dateOk && searchOk ? map : null);
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
            const pf  = document.getElementById('platform-filter').value;
            const days = document.getElementById('days-filter')?.value || 14;
            const res = await fetch(`${API_BASE}/api/matches?region=${encodeURIComponent(region)}&days=${days}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();
            if (result.status === 'error') { toast(result.message, 'error'); loadedRegions.delete(region); return; }

            let matches = pf === 'ALL' ? result.data : result.data.filter(m => m.platform === pf);
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
            const pf  = document.getElementById('platform-filter').value;
            const days = document.getElementById('days-filter')?.value || 14;
            const res = await fetch(`${API_BASE}/api/matches?region=${encodeURIComponent(region)}&days=${days}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();
            if (result.status !== 'success') { loadedRegions.delete(region); return; }

            let matches = pf === 'ALL' ? result.data : result.data.filter(m => m.platform === pf);
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

    // ── 물리 마커 없이 지역 중심으로 처리할 웹 플랫폼 목록 ──────
    const WEB_PLATFORM_VENUES = new Set(['아이엠그라운드']);

    // ── 검색 키워드용 이름 정제 ──────────────────────────────────
    // Python의 clean_stadium_group_name으로 못 걸러진 나머지 패턴 제거
    function _sanitizeSearchName(raw) {
        return raw
            .replace(/\s*[A-F]\s*구장\b/gi, '')       // A구장, B구장
            .replace(/\s*\d+\s*구장\b/g, '')           // 1구장, 2구장
            .replace(/\s+제\d+\s*(?:풋살|축구)?(?:경기장|구장)\b/g, '')  // 제1풋살경기장
            .replace(/\s+(?:인조잔디|천연잔디|실내|실외)\b/g, '')
            .replace(/\s+(?:풋살장|축구장|경기장|운동장|체육관)\s*$/g, '')
            .replace(/\s+(?:대관|예약)\s*$/g, '')
            .replace(/\s*\([^)]*\)/g, '')              // (괄호 내용)
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

        const emit = (lat, lng, next) => {
            const fLat = parseFloat(lat), fLng = parseFloat(lng);
            _isKorea(fLat, fLng) ? cb(new kakao.maps.LatLng(fLat, fLng)) : next();
        };

        const cleanName = _sanitizeSearchName(stadium.name);

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

        const el = document.createElement('div');
        el.style.cssText = `
            position:relative; width:46px; height:46px;
            display:flex; flex-direction:column; align-items:center; justify-content:center;
            background:${cfg.bg}; border:2.5px solid ${cfg.border}; border-radius:50%;
            cursor:pointer; box-shadow:0 3px 12px rgba(0,0,0,0.28);
            color:white; font-family:'Pretendard',sans-serif;
            transition:transform 0.15s ease, box-shadow 0.15s ease; user-select:none;`;
        el.innerHTML = `
            <span style="font-weight:800;font-size:14px;line-height:1.1;">${cfg.label}</span>
            <span style="font-size:9px;opacity:0.85;line-height:1.2;font-weight:600;">${count}건</span>
            ${isFav ? '<span style="position:absolute;top:-4px;right:-4px;font-size:11px;background:white;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,0.2);">★</span>' : ''}`;

        el.addEventListener('mouseenter', () => { el.style.transform='scale(1.18)'; el.style.boxShadow='0 5px 18px rgba(0,0,0,0.38)'; });
        el.addEventListener('mouseleave', () => { el.style.transform='scale(1)';    el.style.boxShadow='0 3px 12px rgba(0,0,0,0.28)'; });
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
        const dateOk   = currentDateFilter === 'ALL' || dates.has(currentDateFilter);
        const searchOk = !q || stadiumData.name.toLowerCase().includes(q);
        if (!dateOk || !searchOk) overlay.setMap(null);
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
        refreshFavBtn(stadiumData.name);
        renderMatchList(stadiumData);
        openPanel();
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
        const pf = document.getElementById('platform-filter').value;

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
