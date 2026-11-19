'use strict';

// ROUTE: 기존 SVG 게임 지도와 실제 카카오맵을 전환한다.
// 게임 판정은 game.js -> /api/simulate/step 이 담당한다.
const gameMapEl = document.getElementById('map');
const kakaoMapEl = document.getElementById('kakao-map');
const mapWrapEl = document.querySelector('.map-wrap');
const gameMapBtn = document.getElementById('btn-game-map');
const kakaoMapBtn = document.getElementById('btn-kakao-map');

let kakaoMapInstance = null;
let transitData = null;
let routeLines = [];     // 대중교통 API 경로 확인용
let routeMarkers = [];

const nodeMarkers = [];
const nodeLabels = [];
const graphEdgeLines = []; // 게임 간선 (실제 선로가 아닌 게임 연결 관계)
const nodePositions = new Map();
const stationCoordinateCache = new Map();
let stationRequest = 0;
let mapRequest = 0;
let renderedSessionId = null;

const routeOptions = document.createElement('div');
routeOptions.className = 'kakao-route-options hidden';
mapWrapEl.appendChild(routeOptions);

// 기존 SVG 지도 드래그/휠 이벤트가 카카오맵 조작과 충돌하지 않도록 한다.
['wheel', 'pointerdown', 'dblclick'].forEach((type) => {
  kakaoMapEl.addEventListener(type, (event) => event.stopPropagation());
});

function clearMapObjects(objects) {
  objects.forEach((object) => object.setMap(null));
  objects.length = 0;
}

function showGameMap() {
  ++mapRequest;
  ++stationRequest; // 닫은 뒤 도착하는 장소 검색 결과 무시
  kakaoMapEl.classList.add('hidden');
  gameMapEl.classList.remove('hidden');
  routeOptions.classList.add('hidden');
  mapWrapEl.classList.remove('kakao-active');
  if (S) updateFooter(); // 이동수단 카드를 원래 SVG 지도 위치로 복귀
}

gameMapBtn.addEventListener('click', showGameMap);
kakaoMapBtn.addEventListener('click', () => {
  showKakaoMap().catch((error) => {
    console.error('카카오맵 오류:', error);
    notify('실제 지도를 표시하지 못했습니다. 콘솔을 확인해 주세요.');
    showGameMap();
  });
});

async function showKakaoMap() {
  const request = ++mapRequest;
  gameMapEl.classList.add('hidden');
  kakaoMapEl.classList.remove('hidden');
  mapWrapEl.classList.add('kakao-active');

  if (!window.kakao || !kakao.maps) {
    throw new Error('카카오맵 SDK를 불러오지 못했습니다.');
  }
  await new Promise((resolve) => kakao.maps.load(resolve));
  if (request !== mapRequest || kakaoMapEl.classList.contains('hidden')) return;

  if (!kakaoMapInstance) {
    kakaoMapInstance = new kakao.maps.Map(kakaoMapEl, {
      center: new kakao.maps.LatLng(37.59, 127.02),
      level: 8,
    });
  }
  kakaoMapInstance.relayout();
  await showGameNodes();
  if (request === mapRequest && !kakaoMapEl.classList.contains('hidden') && S) {
    updateFooter(); // 실제 지도를 사용할 때 이동수단을 하단 패널에 표시
  }
}

// 기존 카카오 경로 조회 기능은 수동 테스트용으로 유지한다.
function showRouteOptions() {
  if (!transitData?.routes) return;
  routeOptions.replaceChildren();
  transitData.routes.forEach((route, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `경로 ${index + 1} · ${route.totalMinutes}분`;
    button.addEventListener('click', () => drawRoute(index));
    routeOptions.appendChild(button);
  });
  routeOptions.classList.remove('hidden');
}

function drawRoute(index) {
  if (!transitData?.routes?.[index] || !kakaoMapInstance) return;
  const route = transitData.routes[index];
  clearMapObjects(routeLines);
  clearMapObjects(routeMarkers);
  const bounds = new kakao.maps.LatLngBounds();
  const colors = { subway: '#3366CC', bus: '#E66A4E', walk: '#548C62' };

  route.steps.forEach((step) => {
    if (!Array.isArray(step.points) || step.points.length < 2) return;
    const path = step.points.map(([x, y]) => {
      const point = new kakao.maps.LatLng(y, x);
      bounds.extend(point);
      return point;
    });
    const line = new kakao.maps.Polyline({
      path, strokeWeight: 6, strokeColor: colors[step.mode] || '#888888',
      strokeOpacity: 0.9,
    });
    line.setMap(kakaoMapInstance);
    routeLines.push(line);
  });

  [transitData.origin, transitData.destination].forEach((place) => {
    const position = new kakao.maps.LatLng(place.y, place.x);
    bounds.extend(position);
    const marker = new kakao.maps.Marker({ position, title: place.name });
    marker.setMap(kakaoMapInstance);
    routeMarkers.push(marker);
  });
  kakaoMapInstance.relayout();
  kakaoMapInstance.setBounds(bounds);
  [...routeOptions.children].forEach((button, i) => {
    button.classList.toggle('selected', i === index);
  });
}

// Places: 이름이 실제 지하철역 검색 결과와 일치할 때만 좌표를 사용한다.
async function findStationPosition(places, stationName) {
  if (stationCoordinateCache.has(stationName)) {
    return stationCoordinateCache.get(stationName);
  }
  const coordinate = await new Promise((resolve) => {
    places.keywordSearch(stationName, (data, status) => {
      if (status !== kakao.maps.services.Status.OK) {
        console.warn('역 검색 실패:', stationName, status);
        resolve(null);
        return;
      }
      const normalize = (name) => String(name).replace(/\s+/g, '');
      const station = data.find((place) =>
        place.category_group_code === 'SW8' &&
        normalize(place.place_name).startsWith(normalize(stationName))
      );
      if (!station) {
        console.warn('일치하는 지하철역 없음:', stationName, data.map((p) => p.place_name));
        resolve(null);
        return;
      }
      const lat = Number(station.y), lng = Number(station.x);
      resolve(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null);
    }, { category_group_code: 'SW8' });
  });
  if (coordinate) stationCoordinateCache.set(stationName, coordinate);
  return coordinate;
}

async function showGameNodes() {
  const request = ++stationRequest;
  if (!S || !Array.isArray(S.nodes)) {
    notify('게임을 먼저 시작해 주세요.');
    return;
  }
  if (!kakao.maps.services?.Places) {
    throw new Error('카카오 장소 검색 라이브러리를 불러오지 못했습니다.');
  }

  const sessionId = S.sessionId;
  renderedSessionId = sessionId;
  clearMapObjects(routeLines);
  clearMapObjects(routeMarkers);
  clearMapObjects(nodeMarkers);
  clearMapObjects(nodeLabels);
  clearMapObjects(graphEdgeLines);
  nodePositions.clear();
  routeOptions.classList.add('hidden');

  const places = new kakao.maps.services.Places();
  const results = await Promise.all(S.nodes.map(async (node) => ({
    node,
    coordinate: await findStationPosition(places, node.stationName || node.name),
  })));

  if (request !== stationRequest || S?.sessionId !== sessionId ||
      kakaoMapEl.classList.contains('hidden')) return;

  const found = results.filter(({ coordinate }) => coordinate !== null);
  if (!found.length) {
    notify('검색된 지하철역이 없습니다.');
    return;
  }

  const bounds = new kakao.maps.LatLngBounds();
  found.forEach(({ node, coordinate }) => {
    const position = new kakao.maps.LatLng(coordinate.lat, coordinate.lng);
    nodePositions.set(node.id, position);
    bounds.extend(position);

    const marker = new kakao.maps.Marker({ position, title: node.name });
    marker.setMap(kakaoMapInstance);
    kakao.maps.event.addListener(marker, 'click', () => selectKakaoNode(node.id));
    nodeMarkers.push(marker);

    const labelElement = document.createElement('div');
    labelElement.className = 'kakao-node-label';
    labelElement.textContent = node.name;
    labelElement.dataset.nodeId = String(node.id);
    labelElement.setAttribute('role', 'button');
    labelElement.tabIndex = 0;
    labelElement.addEventListener('click', () => selectKakaoNode(node.id));
    labelElement.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectKakaoNode(node.id);
      }
    });
    const label = new kakao.maps.CustomOverlay({
      position, content: labelElement, yAnchor: 2,
    });
    label.setMap(kakaoMapInstance);
    nodeLabels.push(label);
  });

  kakaoMapInstance.relayout();
  kakaoMapInstance.setBounds(bounds);
  syncKakaoGameState();

  const missing = S.nodes.length - found.length;
  notify(`실제 지도에 ${found.length}개 노드 표시 완료` +
    (missing ? ` · ${missing}개 위치 검색 실패 (기존 게임 지도에서는 이동 가능)` : ''));
}

// 카카오맵에서 인접 노드를 선택해 기존 SVG 지도 클릭 흐름을 재사용한다.
// 이동수단 선택 및 서버 판정은 기존 game.js가 그대로 수행한다.
function selectKakaoNode(nodeId) {
  if (!S || S.status !== 'active' || busy) return;
  const isAdjacent = S.edges.some((edge) =>
    (edge.a === S.cur && edge.b === nodeId) ||
    (edge.b === S.cur && edge.a === nodeId)
  );
  if (!isAdjacent) {
    notify('현재 위치에서 간선으로 연결된 역만 선택할 수 있어요.');
    return;
  }
  const svgNode = gameMapEl.querySelector(`[data-id="${nodeId}"]`);
  if (!svgNode) {
    notify('역 선택 데이터를 찾지 못했습니다.');
    return;
  }
  svgNode.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  // game.js가 sel, quotes, 이동수단 버튼을 관리한다.
}

function drawGameEdges() {
  clearMapObjects(graphEdgeLines);
  if (!S) return;
  const completed = new Set(S.path.map((step) =>
    [Math.min(step.from, step.to), Math.max(step.from, step.to)].join(':')
  ));
  const reachable = S.status === 'active' ? new Set(S.edges
    .filter((edge) => edge.a === S.cur || edge.b === S.cur)
    .map((edge) => edge.a === S.cur ? edge.b : edge.a)) : new Set();

  S.edges.forEach((edge) => {
    const from = nodePositions.get(edge.a), to = nodePositions.get(edge.b);
    if (!from || !to) return;
    const key = [Math.min(edge.a, edge.b), Math.max(edge.a, edge.b)].join(':');
    const wasUsed = completed.has(key);
    const isReachable = reachable.has(edge.a) && edge.b === S.cur ||
      reachable.has(edge.b) && edge.a === S.cur;
    const isSelected = sel != null &&
      ((edge.a === S.cur && edge.b === sel) || (edge.b === S.cur && edge.a === sel));
    const line = new kakao.maps.Polyline({
      path: [from, to],
      strokeWeight: isSelected ? 6 : wasUsed ? 5 : isReachable ? 4 : 2,
      strokeColor: isSelected ? '#F59E0B' : wasUsed ? '#E74C3C' :
        isReachable ? '#16A34A' : '#94A3B8',
      strokeOpacity: isSelected || wasUsed || isReachable ? 0.95 : 0.45,
    });
    line.setMap(kakaoMapInstance);
    graphEdgeLines.push(line);
  });
}

function styleNodeLabels() {
  if (!S) return;
  const reachable = S.status === 'active' ? new Set(S.edges
    .filter((edge) => edge.a === S.cur || edge.b === S.cur)
    .map((edge) => edge.a === S.cur ? edge.b : edge.a)) : new Set();
  const visited = new Set([S.start, ...S.path.map((step) => step.to)]);

  nodeLabels.forEach((label) => {
    const element = label.getContent();
    const id = Number(element.dataset.nodeId);
    const current = id === S.cur;
    const selected = id === sel;
    const canSelect = reachable.has(id);
    element.style.cursor = canSelect && !busy ? 'pointer' : 'default';
    element.style.border = '2px solid ' +
      (selected ? '#F59E0B' : current ? '#2563EB' : canSelect ? '#16A34A' : '#94A3B8');
    element.style.backgroundColor = current ? '#DBEAFE' : selected ? '#FEF3C7' :
      canSelect ? '#DCFCE7' : visited.has(id) ? '#FEE2E2' : '#FFFFFF';
    element.style.color = '#111827';
    element.style.borderRadius = '8px';
    element.style.padding = '3px 7px';
    element.style.fontWeight = current ? '800' : '600';
    element.style.whiteSpace = 'nowrap';
    element.title = current ? '현재 위치' : canSelect ? '클릭하여 이동할 역 선택' : '현재 위치에서는 직접 이동할 수 없는 역';
    element.setAttribute('aria-disabled', String(!canSelect || busy));
  });
}

function syncKakaoGameState() {
  if (!kakaoMapInstance || kakaoMapEl.classList.contains('hidden') || !S ||
      renderedSessionId !== S.sessionId) return;
  drawGameEdges();
  styleNodeLabels();
}

// game.js의 updateFooter()가 호출될 때마다 상태를 다시 그린다.
// 이동 성공, 재시도, 역 선택 후에도 원본 game.js 게임 규칙이 우선한다.
document.addEventListener('route:ui', () => {
  if (!kakaoMapInstance || kakaoMapEl.classList.contains('hidden') || !S) return;
  if (renderedSessionId !== S.sessionId) {
    showGameNodes().catch((error) => console.error('카카오맵 노드 갱신 실패:', error));
  } else {
    syncKakaoGameState();
  }
});

/* ── 기존 실제 대중교통 간선 조회 수동 테스트 유지 ── */
window.testTransitEdge = async function (edgeId = 0) {
  if (!S || !Array.isArray(S.edges)) {
    console.error('게임을 먼저 시작해 주세요.');
    return null;
  }
  if (!kakaoMapInstance || kakaoMapEl.classList.contains('hidden')) {
    console.error('먼저 실제 지도 버튼을 눌러 주세요.');
    return null;
  }
  const edge = S.edges.find((item) => item.id === edgeId);
  if (!edge) {
    console.error(`간선 ${edgeId}을 찾지 못했습니다.`);
    return null;
  }
  const from = S.nodes[edge.a], to = S.nodes[edge.b];
  const start = from.stationName, end = to.stationName;
  if (!start || !end || start === end) {
    console.error('유효한 출발역 또는 도착역 정보가 없습니다.');
    return null;
  }
  console.log(`간선 ${edge.id}: ${start} → ${end}`);
  console.log('기존 게임 가중치:', edge.opts);
  try {
    const params = new URLSearchParams({ start, end });
    const response = await fetch(`/api/kakao/transit?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (!Array.isArray(data.routes) || !data.routes.length) throw new Error('대중교통 경로 없음');
    console.table(data.routes.map((route, i) => ({
      경로: i + 1, 소요시간: `${route.totalMinutes}분`, 교통비: `${route.fare}원`,
      환승횟수: route.transfers,
      이동수단: [...new Set(route.steps.map((step) => step.mode))].join(', '),
    })));
    const fastest = data.routes.reduce((best, route) =>
      route.totalMinutes < best.totalMinutes ? route : best);
    transitData = data;
    clearMapObjects(routeLines);
    const bounds = new kakao.maps.LatLngBounds();
    const colors = { subway: '#3366CC', bus: '#E66A4E', walk: '#548C62' };
    fastest.steps.forEach((step) => {
      if (!Array.isArray(step.points) || step.points.length < 2) return;
      const path = step.points.map(([x, y]) => {
        const point = new kakao.maps.LatLng(y, x);
        bounds.extend(point);
        return point;
      });
      const line = new kakao.maps.Polyline({
        path, strokeWeight: 6, strokeColor: colors[step.mode] || '#888888', strokeOpacity: 0.9,
      });
      line.setMap(kakaoMapInstance);
      routeLines.push(line);
    });
    bounds.extend(new kakao.maps.LatLng(data.origin.y, data.origin.x));
    bounds.extend(new kakao.maps.LatLng(data.destination.y, data.destination.x));
    kakaoMapInstance.relayout();
    kakaoMapInstance.setBounds(bounds);
    console.log('가장 빠른 경로:', fastest);
    notify(`${start} → ${end}: 실제 예상 ${fastest.totalMinutes}분`);
    return data;
  } catch (error) {
    console.error('실제 간선 검증 실패:', error);
    notify('실제 대중교통 경로 조회에 실패했습니다.');
    return null;
  }
};
