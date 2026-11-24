'use strict';

// ROUTE: 기존 SVG 게임 지도와 실제 카카오맵을 전환한다.
// 게임 판정은 game.js -> /api/simulate/step 이 담당한다.
const gameMapEl = document.getElementById('map');
const kakaoMapEl = document.getElementById('kakao-map');
const mapWrapEl = document.querySelector('.map-wrap');
const gameMapBtn = document.getElementById('btn-game-map');
const kakaoMapBtn = document.getElementById('btn-kakao-map');

let kakaoMapInstance = null;
const nodeMarkers = [];
const nodeLabels = [];
const graphEdgeLines = []; // 게임 간선 (실제 선로가 아닌 게임 연결 관계)
const nodePositions = new Map();
let stationRequest = 0;
let mapRequest = 0;
let renderedSessionId = null;

const mapSwitch = document.querySelector('.map-switch');

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
  if (!S?.realMapEnabled) return;
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

async function showGameNodes() {
  const request = ++stationRequest;
  if (!S || !Array.isArray(S.nodes)) {
    notify('게임을 먼저 시작해 주세요.');
    return;
  }
  const sessionId = S.sessionId;
  renderedSessionId = sessionId;
  clearMapObjects(nodeMarkers);
  clearMapObjects(nodeLabels);
  clearMapObjects(graphEdgeLines);
  nodePositions.clear();

  const results = S.nodes.map(node => ({
    node,
    coordinate: Number.isFinite(node.lat) && Number.isFinite(node.lng) ? node : null,
  }));

  if (request !== stationRequest || S?.sessionId !== sessionId ||
      kakaoMapEl.classList.contains('hidden')) return;

  const found = results.filter(({ coordinate }) => coordinate !== null);
  if (!found.length) {
    notify('저장된 역 좌표가 없습니다.');
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
    (missing ? ` · ${missing}개 역 좌표 없음 (기존 게임 지도에서는 이동 가능)` : ''));
}

// 카카오맵에서 인접 노드를 선택해 기존 SVG 지도 클릭 흐름을 재사용한다.
// 이동수단 선택 및 서버 판정은 기존 game.js가 그대로 수행한다.
function selectKakaoNode(nodeId) {
  if (!S || S.status !== 'active' || busy) return;
  if (!availableDestinations().includes(nodeId)) {
    notify('지금 이동할 수 있는 역만 선택할 수 있어요.');
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
  const reachable = new Set(availableDestinations());

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
  const reachable = new Set(availableDestinations());
  const visited = new Set([S.start, ...S.path.map((step) => step.to)]);

  nodeLabels.forEach((label) => {
    const element = label.getContent();
    const id = Number(element.dataset.nodeId);
    const errand = S.errand?.node === id ? S.errand : null;
    const name = S.nodes[id].name;
    element.textContent = errand ? `${errand.icon} ${name}${errand.done ? ' ✔' : ''}` : name;
    element.setAttribute('aria-label', errand ? `${name}, 경유지, ${errand.goal}${errand.done ? ', 완료' : ''}` : name);
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
    if (errand) element.title = `${errand.goal}${errand.done ? ' (완료)' : ''} · ${element.title}`;
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
  mapSwitch.classList.toggle('hidden', !S?.realMapEnabled);
  if (!S?.realMapEnabled) {
    if (!kakaoMapEl.classList.contains('hidden')) showGameMap();
    return;
  }
  if (!kakaoMapInstance || kakaoMapEl.classList.contains('hidden') || !S) return;
  if (renderedSessionId !== S.sessionId) {
    showGameNodes().catch((error) => console.error('카카오맵 노드 갱신 실패:', error));
  } else {
    syncKakaoGameState();
  }
});
