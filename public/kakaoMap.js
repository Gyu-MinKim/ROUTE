
'use strict';

// 기존 게임 지도와 카카오맵
const gameMapEl = document.getElementById('map');
const kakaoMapEl = document.getElementById('kakao-map');
const mapWrapEl = document.querySelector('.map-wrap');
const gameMapBtn = document.getElementById('btn-game-map');
const kakaoMapBtn = document.getElementById('btn-kakao-map');

let kakaoMapInstance = null;
let transitData = null;
let routeLines = [];
let routeMarkers = [];

// 지도에 표시할 게임 노드
const nodeMarkers = [];
const nodeLabels = [];
let stationRequest = 0;

// 지도 위의 경로 선택 버튼 영역
const routeOptions = document.createElement('div');
routeOptions.className = 'kakao-route-options hidden';
mapWrapEl.appendChild(routeOptions);

// 기존 게임 지도 이벤트와 카카오맵 이벤트가 충돌하지 않도록 처리
['wheel', 'pointerdown', 'dblclick'].forEach((type) => {
  kakaoMapEl.addEventListener(type, (event) => {
    event.stopPropagation();
  });
});

// 기존 게임 지도로 돌아가기
function showGameMap() {
  stationRequest++; // 진행 중인 이전 역 검색 결과 무효화

  kakaoMapEl.classList.add('hidden');
  gameMapEl.classList.remove('hidden');
  routeOptions.classList.add('hidden');
  mapWrapEl.classList.remove('kakao-active');
}

gameMapBtn.addEventListener('click', showGameMap);

// 실제 카카오맵 표시
kakaoMapBtn.addEventListener('click', () => {
  showKakaoMap().catch((error) => {
    console.error('카카오맵 오류:', error);
    notify('카카오맵을 불러오지 못했어요. 설정을 확인해 주세요.');
    showGameMap();
  });
});

async function showKakaoMap() {
  gameMapEl.classList.add('hidden');
  kakaoMapEl.classList.remove('hidden');
  mapWrapEl.classList.add('kakao-active');

  if (!window.kakao || !kakao.maps) {
    throw new Error('카카오맵 SDK를 불러오지 못했습니다.');
  }

  // SDK가 준비되면 지도 생성
  await new Promise((resolve) => kakao.maps.load(resolve));

  if (!kakaoMapInstance) {
    kakaoMapInstance = new kakao.maps.Map(kakaoMapEl, {
      center: new kakao.maps.LatLng(37.59, 127.02),
      level: 8
    });
  }

  // 숨겨진 지도 영역을 다시 표시했으므로 크기 재계산
  kakaoMapInstance.relayout();

  // 현재 게임에서 생성된 노드들의 실제 위치 조회
  await showGameNodes();
}

// 경로 선택 버튼 생성
function showRouteOptions() {
  routeOptions.replaceChildren();

  transitData.routes.forEach((route, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `경로 ${index + 1} · ${route.totalMinutes}분`;

    button.addEventListener('click', () => {
      drawRoute(index);
    });

    routeOptions.appendChild(button);
  });

  routeOptions.classList.remove('hidden');
}

// 선택한 경로를 지도에 표시
function drawRoute(index) {
  const route = transitData.routes[index];

  // 이전 경로와 마커 제거
  routeLines.forEach((line) => line.setMap(null));
  routeMarkers.forEach((marker) => marker.setMap(null));
  routeLines = [];
  routeMarkers = [];

  const bounds = new kakao.maps.LatLngBounds();

  // 이동 수단별 색상
  const colors = {
    subway: '#3366CC',
    bus: '#E66A4E',
    walk: '#548C62'
  };

  route.steps.forEach((step) => {
    if (!Array.isArray(step.points) || step.points.length < 2) {
      return;
    }

    // API: [경도, 위도]
    // 카카오맵: LatLng(위도, 경도)
    const path = step.points.map(([x, y]) => {
      const point = new kakao.maps.LatLng(y, x);
      bounds.extend(point);
      return point;
    });

    const line = new kakao.maps.Polyline({
      path,
      strokeWeight: 6,
      strokeColor: colors[step.mode] || '#888888',
      strokeOpacity: 0.9
    });

    line.setMap(kakaoMapInstance);
    routeLines.push(line);
  });

  // 출발지 및 도착지 마커
  [transitData.origin, transitData.destination].forEach((place) => {
    const position = new kakao.maps.LatLng(place.y, place.x);
    bounds.extend(position);

    const marker = new kakao.maps.Marker({
      position,
      title: place.name
    });

    marker.setMap(kakaoMapInstance);
    routeMarkers.push(marker);
  });

  kakaoMapInstance.relayout();
  kakaoMapInstance.setBounds(bounds);

  // 현재 선택한 경로 버튼 강조
  [...routeOptions.children].forEach((button, i) => {
    button.classList.toggle('selected', i === index);
  });
}

// 지도에 정점 표시하기
async function showGameNodes() {
  const request = ++stationRequest;

  if (!S || !Array.isArray(S.nodes)) {
    notify('게임을 먼저 시작해 주세요.');
    return;
  }

  if (!kakao.maps.services?.Places) {
    throw new Error('카카오 장소 검색 라이브러리를 불러오지 못했습니다.');
  }

  // 이전 테스트 경로와 노드 마커 제거
  routeLines.forEach((line) => line.setMap(null));
  routeMarkers.forEach((marker) => marker.setMap(null));
  nodeMarkers.forEach((marker) => marker.setMap(null));
  nodeLabels.forEach((label) => label.setMap(null));

  routeLines = [];
  routeMarkers = [];
  nodeMarkers.length = 0;
  nodeLabels.length = 0;
  routeOptions.classList.add('hidden');

  const places = new kakao.maps.services.Places();

  // 실제 지하철역 위치 조회
  const results = await Promise.all(
    S.nodes.map((node) => new Promise((resolve) => {
      const keyword = node.stationName || node.name;

      places.keywordSearch(keyword, (data, status) => {
        // 장소 검색 자체가 실패한 경우
        if (status !== kakao.maps.services.Status.OK) {
          console.warn('역 검색 실패:', keyword, status);
          resolve(null);
          return;
        }

        const normalize = (name) => name.replace(/\s+/g, '');

        // 검색 결과 중 이름이 일치하는 지하철역 탐색
        const station = data.find((place) =>
          place.category_group_code === 'SW8' &&
          normalize(place.place_name).startsWith(normalize(keyword))
        );

        // 검색 결과는 있지만 일치하는 역이 없는 경우
        if (!station) {
          console.warn(
            '일치하는 지하철역 없음:',
            keyword,
            data.map((place) => place.place_name)
          );
          resolve(null);
          return;
        }

        resolve({
          node,
          position: new kakao.maps.LatLng(
            Number(station.y),
            Number(station.x)
          )
        });
      }, { category_group_code: 'SW8' });
    }))
  );

  // 이전 검색 요청이 뒤늦게 완료되었으면 무시
  if (request !== stationRequest) return;

  const found = results.filter(Boolean);

  if (!found.length) {
    notify('검색된 지하철역이 없습니다.');
    return;
  }

  const bounds = new kakao.maps.LatLngBounds();

  found.forEach(({ node, position }) => {
    bounds.extend(position);

    // 역 위치 마커
    const marker = new kakao.maps.Marker({
      position,
      title: node.name
    });

    marker.setMap(kakaoMapInstance);
    nodeMarkers.push(marker);

    // 역 이름 표시
    const labelElement = document.createElement('div');
    labelElement.className = 'kakao-node-label';
    labelElement.textContent = node.name;

    const label = new kakao.maps.CustomOverlay({
      position,
      content: labelElement,
      yAnchor: 2
    });

    label.setMap(kakaoMapInstance);
    nodeLabels.push(label);
  });

  kakaoMapInstance.relayout();
  kakaoMapInstance.setBounds(bounds);

  const missing = S.nodes.length - found.length;

  notify(
    `실제 지도에 ${found.length}개 노드 표시 완료` +
    (missing ? ` · ${missing}개 위치 검색 실패` : '')
  );
}


/* ── 실제 대중교통 간선 검증 테스트 ── */
window.testTransitEdge = async function (edgeId = 0) {
  // 게임 상태 확인
  if (!S || !Array.isArray(S.edges)) {
    console.error('게임을 먼저 시작해 주세요.');
    return null;
  }

  // 카카오맵 초기화 여부 확인
  if (!kakaoMapInstance || kakaoMapEl.classList.contains('hidden')) {
    console.error('먼저 실제 지도 버튼을 눌러 주세요.');
    return null;
  }

  // 선택한 간선 탐색
  const edge = S.edges.find((e) => e.id === edgeId);

  if (!edge) {
    console.error(`간선 ${edgeId}을 찾지 못했습니다.`);
    return null;
  }

  const from = S.nodes[edge.a];
  const to = S.nodes[edge.b];

  const start = from.stationName;
  const end = to.stationName;

  if (!start || !end || start === end) {
    console.error('유효한 출발역 또는 도착역 정보가 없습니다.');
    return null;
  }

  console.log(`간선 ${edge.id}: ${start} → ${end}`);
  console.log('기존 게임 가중치:', edge.opts);

  try {
    // 실제 대중교통 경로 조회
    const params = new URLSearchParams({ start, end });
    const response = await fetch(`/api/kakao/transit?${params}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    if (!Array.isArray(data.routes) || !data.routes.length) {
      throw new Error('조회된 대중교통 경로가 없습니다.');
    }

    // 조회한 경로별 정보 출력
    console.table(data.routes.map((route, index) => ({
      경로: index + 1,
      소요시간: `${route.totalMinutes}분`,
      교통비: `${route.fare}원`,
      환승횟수: route.transfers,
      이동수단: [...new Set(
        route.steps.map((step) => step.mode)
      )].join(', ')
    })));

    // 가장 빠른 경로 선택
    const fastest = data.routes.reduce((best, route) =>
      route.totalMinutes < best.totalMinutes ? route : best
    );

    // 기존 테스트 경로 제거
    routeLines.forEach((line) => line.setMap(null));
    routeLines = [];

    const bounds = new kakao.maps.LatLngBounds();

    const colors = {
      subway: '#3366CC',
      bus: '#E66A4E',
      walk: '#548C62'
    };

    // 실제 이동 경로 표시
    fastest.steps.forEach((step) => {
      if (!Array.isArray(step.points) || step.points.length < 2) {
        return;
      }

      // API 좌표 [경도, 위도] → 카카오맵 LatLng(위도, 경도)
      const path = step.points.map(([x, y]) => {
        const point = new kakao.maps.LatLng(y, x);
        bounds.extend(point);
        return point;
      });

      const line = new kakao.maps.Polyline({
        map: kakaoMapInstance,
        path,
        strokeWeight: 6,
        strokeColor: colors[step.mode] || '#888888',
        strokeOpacity: 0.9
      });

      routeLines.push(line);
    });

    // 출발지와 도착지 좌표 포함
    bounds.extend(
      new kakao.maps.LatLng(data.origin.y, data.origin.x)
    );
    bounds.extend(
      new kakao.maps.LatLng(data.destination.y, data.destination.x)
    );

    kakaoMapInstance.relayout();
    kakaoMapInstance.setBounds(bounds);

    console.log('선택된 실제 경로:', fastest);
    console.log(
      `기존 가중치:`,
      edge.opts,
      `실제 예상 소요 시간: ${fastest.totalMinutes}분`
    );

    notify(
      `${start} → ${end}: 실제 예상 ${fastest.totalMinutes}분`
    );

    return data;

  } catch (error) {
    console.error('실제 간선 검증 실패:', error);
    notify('실제 대중교통 경로 조회에 실패했습니다.');
    return null;
  }
};
