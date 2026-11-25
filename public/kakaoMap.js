'use strict';

// ROUTE: 기존 SVG 게임 지도와 실제 카카오맵을 전환한다.
// 게임 판정은 game.js -> /api/simulate/step 이 담당한다.
// 이 파일은 "보여 주기"만 담당한다. 이동 가능 여부·소요 시간·요금은 서버가 준 S.quotes 를 그대로 사용한다.
const gameMapEl = document.getElementById('map');
const kakaoMapEl = document.getElementById('kakao-map');
const mapWrapEl = document.querySelector('.map-wrap');
const gameMapBtn = document.getElementById('btn-game-map');
const kakaoMapBtn = document.getElementById('btn-kakao-map');

let kakaoMapInstance = null;
const nodeMarkers = [];
const nodeLabels = [];
const graphEdgeLines = []; // 게임 간선 (실제 선로가 아닌 게임 연결 관계)
const kakaoPathLines = []; // 지나온 경로 / 결과 비교(내 경로·최적 경로)
const kakaoModeBadges = []; // 이동 가능 구간 위 수단별 소요 시간
const nodePositions = new Map();
let stationRequest = 0;
let mapRequest = 0;
let renderedSessionId = null;
let kakaoCurrentOverlay = null; // 현재 위치 표시 (CustomOverlay)
let kakaoLegendEl = null;
let kakaoFittedOverlay = null; // 결과 비교 화면에서 한 번만 지도 범위를 맞추기 위한 키
let kakaoFollowKey = null; // 최적 경로 재생 중 따라가는 구간

const mapSwitch = document.querySelector('.map-switch');

// 노선 색상 (서울교통공사·코레일 노선도에서 쓰는 대표색)
const KAKAO_LINE_COLORS = {
  1: '#0052A4', 2: '#00A84D', 3: '#EF7C1C', 4: '#00A5DE', 5: '#996CAC',
  6: '#CD7C2F', 7: '#747F00', 8: '#E6186C', 9: '#BDB092',
  K: '#77C4A3', B: '#F5A200', S: '#D4003B',
};
const KAKAO_LINE_NAMES = {
  1: '1호선', 2: '2호선', 3: '3호선', 4: '4호선', 5: '5호선', 6: '6호선',
  7: '7호선', 8: '8호선', 9: '9호선', K: '경의중앙선', B: '수인분당선', S: '신분당선',
};
const KAKAO_MODE_ORDER = ['subway', 'bus', 'walk'];
const KAKAO_MODE_INFO = {
  subway: { icon: '🚇', name: '지하철' },
  bus: { icon: '🚌', name: '버스', color: '#E8590C', style: 'shortdash' },
  walk: { icon: '🚶', name: '도보', color: '#6B7280', style: 'shortdot' },
};
const KAKAO_PATH_COLORS = { done: '#1F2937', my: '#526E85', opt: '#963E48' };

// 기존 SVG 지도 드래그/휠 이벤트가 카카오맵 조작과 충돌하지 않도록 한다.
['wheel', 'pointerdown', 'dblclick'].forEach((type) => {
  kakaoMapEl.addEventListener(type, (event) => event.stopPropagation());
});

function clearMapObjects(objects) {
  objects.forEach((object) => object.setMap(null));
  objects.length = 0;
}

// game.js 전역 상태를 안전하게 읽는다. (테스트처럼 game.js 없이 실행될 때도 동작)
function kakaoOverlayState() {
  return typeof overlay !== 'undefined' && overlay ? overlay : null;
}
function kakaoUnavailableReason(quote) {
  if (typeof moveUnavailable === 'function') return moveUnavailable(quote);
  return quote ? '' : '이 구간에 노선 없음';
}
function kakaoEscape(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function kakaoMapVisible() {
  return !!kakaoMapInstance && !kakaoMapEl.classList.contains('hidden') && !!S &&
    renderedSessionId === S.sessionId;
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
    // 확대/축소하면 겹친 간선의 화면상 간격을 다시 계산한다.
    kakao.maps.event.addListener(kakaoMapInstance, 'zoom_changed', () => syncKakaoGameState());
  }
  ensureKakaoLegend();
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
  clearMapObjects(kakaoPathLines);
  clearMapObjects(kakaoModeBadges);
  if (kakaoCurrentOverlay) kakaoCurrentOverlay.setMap(null);
  kakaoCurrentOverlay = null;
  kakaoFittedOverlay = null;
  kakaoFollowKey = null;
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
  const dotImage = kakaoDotImage();
  found.forEach(({ node, coordinate }) => {
    const position = new kakao.maps.LatLng(coordinate.lat, coordinate.lng);
    nodePositions.set(node.id, position);
    bounds.extend(position);

    const markerOptions = { position, title: node.name };
    if (dotImage) markerOptions.image = dotImage;
    const marker = new kakao.maps.Marker(markerOptions);
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
      position, content: labelElement, yAnchor: dotImage ? 1.45 : 2, zIndex: 5,
    });
    label.setMap(kakaoMapInstance);
    nodeLabels.push(label);
  });

  // 현재 위치 표시: Marker 대신 CustomOverlay (역 Marker와 구분)
  const currentElement = document.createElement('div');
  currentElement.className = 'kakao-current';
  currentElement.setAttribute('aria-label', '현재 위치');
  currentElement.title = '현재 위치';
  const startNode = S.nodes[S.cur] ?? S.nodes[S.start];
  if (startNode && nodePositions.has(startNode.id)) {
    kakaoCurrentOverlay = new kakao.maps.CustomOverlay({
      position: nodePositions.get(startNode.id), content: currentElement,
      xAnchor: 0.5, yAnchor: 0.5, zIndex: 6,
    });
    kakaoCurrentOverlay.setMap(kakaoMapInstance);
  }

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

// 역 표시: 기본 파란 핀 대신 작은 원 (경로선을 가리지 않도록). SDK에 MarkerImage가 없으면 기본 핀 사용
function kakaoDotImage() {
  if (!kakao.maps.MarkerImage || !kakao.maps.Size || !kakao.maps.Point) return null;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
    '<circle cx="8" cy="8" r="6" fill="#ffffff" stroke="#1F2937" stroke-width="2.5"/></svg>';
  return new kakao.maps.MarkerImage('data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    new kakao.maps.Size(16, 16), { offset: new kakao.maps.Point(8, 8) });
}

// 화면 크기가 바뀌면(모바일 회전, 창 크기 변경) 지도를 다시 맞춘다.
let kakaoResizeTimer = null;
function refitKakaoMap() {
  if (kakaoLegendEl && typeof window.matchMedia === 'function') {
    kakaoLegendEl.open = !window.matchMedia('(max-width: 800px)').matches; // 좁은 화면에서는 범례를 접어 둔다
  }
  if (!kakaoMapVisible()) return;
  kakaoMapInstance.relayout();
  const review = kakaoOverlayState();
  if (review) {
    kakaoFittedOverlay = null;
    fitKakaoReview(review);
  } else if (nodePositions.size > 1) {
    const bounds = new kakao.maps.LatLngBounds();
    nodePositions.forEach((position) => bounds.extend(position));
    kakaoMapInstance.setBounds(bounds);
  }
  syncKakaoGameState();
}
if (typeof window.addEventListener === 'function') {
  window.addEventListener('resize', () => {
    clearTimeout(kakaoResizeTimer);
    kakaoResizeTimer = setTimeout(refitKakaoMap, 250);
  });
}

/* ── 간선(노선) 표시 ── */

// 간선에서 이용 가능한 수단과 방향. directionalOpts 가 없으면 opts 를 양방향으로 본다.
function kakaoEdgeModes(edge) {
  const both = edge.opts || {};
  const forward = edge.directionalOpts?.forward || both;
  const reverse = edge.directionalOpts?.reverse || both;
  return KAKAO_MODE_ORDER
    .filter((mode) => forward[mode] != null || reverse[mode] != null)
    .map((mode) => ({ mode, forward: forward[mode] != null, reverse: reverse[mode] != null }));
}

function kakaoModeStyle(mode, lineId) {
  if (mode === 'subway') {
    return { color: KAKAO_LINE_COLORS[lineId] || '#475569', style: 'solid' };
  }
  const info = KAKAO_MODE_INFO[mode];
  return info ? { color: info.color, style: info.style } : { color: '#94A3B8', style: 'solid' };
}

// 같은 두 역을 잇는 간선이 여러 개일 때 화면에서 겹치지 않도록 수직 방향으로 몇 px 띄운다.
function kakaoOffsetPath(from, to, offsetPx) {
  const projection = offsetPx && kakaoMapInstance.getProjection?.();
  if (!projection || !kakao.maps.Point) return [from, to];
  const p1 = projection.pointFromCoords(from), p2 = projection.pointFromCoords(to);
  const dx = p2.x - p1.x, dy = p2.y - p1.y, length = Math.hypot(dx, dy) || 1;
  const ox = -dy / length * offsetPx, oy = dx / length * offsetPx;
  return [
    projection.coordsFromPoint(new kakao.maps.Point(p1.x + ox, p1.y + oy)),
    projection.coordsFromPoint(new kakao.maps.Point(p2.x + ox, p2.y + oy)),
  ];
}

const kakaoPairKey = (a, b) => [Math.min(a, b), Math.max(a, b)].join(':');

function drawGameEdges() {
  clearMapObjects(graphEdgeLines);
  if (!S) return;
  const reviewing = !!kakaoOverlayState();
  const completed = new Set(S.path.map((step) => kakaoPairKey(step.from, step.to)));
  const reachable = new Set(availableDestinations());

  // 같은 역 쌍의 간선 묶음 (평행 간선 간격 계산용)
  const pairs = new Map();
  S.edges.forEach((edge) => {
    const key = kakaoPairKey(edge.a, edge.b);
    if (!pairs.has(key)) pairs.set(key, []);
    pairs.get(key).push(edge.id);
  });

  S.edges.forEach((edge) => {
    const from = nodePositions.get(edge.a), to = nodePositions.get(edge.b);
    if (!from || !to) return;
    const key = kakaoPairKey(edge.a, edge.b);
    const siblings = pairs.get(key);
    const offset = (siblings.indexOf(edge.id) - (siblings.length - 1) / 2) * 7;
    const [p1, p2] = kakaoOffsetPath(from, to, offset);

    const isSelected = sel != null &&
      ((edge.a === S.cur && edge.b === sel) || (edge.b === S.cur && edge.a === sel));
    const isReachable = (reachable.has(edge.a) && edge.b === S.cur) ||
      (reachable.has(edge.b) && edge.a === S.cur);
    const wasUsed = completed.has(key);
    const weight = isSelected ? 9 : isReachable ? 6 : wasUsed ? 5 : 4;
    const opacity = reviewing ? 0.25 : isSelected || isReachable ? 1 : wasUsed ? 0.9 : 0.4;

    const modes = kakaoEdgeModes(edge);
    if (!modes.length) modes.push({ mode: null, forward: true, reverse: true });
    // 첫 수단(지하철 > 버스 > 도보)은 굵은 선, 나머지 수단은 그 위에 얇은 점선으로 겹쳐 표시
    modes.forEach(({ mode, forward, reverse }, index) => {
      const style = mode ? kakaoModeStyle(mode, edge.lineId) : { color: '#94A3B8', style: 'solid' };
      const oneWay = forward !== reverse; // 한쪽 방향만 가능한 수단은 화살표로 방향 표시
      const path = oneWay && reverse ? [p2, p1] : [p1, p2];
      const line = new kakao.maps.Polyline({
        path,
        strokeWeight: index === 0 ? weight : Math.max(2, weight - 3),
        strokeColor: style.color,
        strokeOpacity: opacity,
        strokeStyle: style.style,
        endArrow: oneWay,
        zIndex: index === 0 ? (isSelected ? 4 : isReachable ? 3 : 2) : 5,
      });
      line.setMap(kakaoMapInstance);
      graphEdgeLines.push(line);
    });
  });
}

/* ── 지나온 경로 / 결과 비교 ── */

function kakaoAddPathLine(step, color, weight, opacity, zIndex, strokeStyle = 'solid') {
  const from = nodePositions.get(step.from), to = nodePositions.get(step.to);
  if (!from || !to) return;
  const line = new kakao.maps.Polyline({
    path: [from, to], strokeWeight: weight, strokeColor: color,
    strokeOpacity: opacity, strokeStyle, zIndex,
  });
  line.setMap(kakaoMapInstance);
  kakaoPathLines.push(line);
}

function drawKakaoPaths() {
  clearMapObjects(kakaoPathLines);
  if (!S) return;
  const review = kakaoOverlayState();
  if (review) {
    // 결과 화면: 최적 경로(굵은 선) 위에 내 경로(얇은 선)를 겹쳐 SVG 지도와 같은 규칙으로 표시
    (review.opt || []).forEach((step) => kakaoAddPathLine(step, KAKAO_PATH_COLORS.opt, 10, 0.85, 7));
    (review.my || []).forEach((step) => kakaoAddPathLine(step, KAKAO_PATH_COLORS.my, 5, 0.95, 8, 'shortdash'));
    fitKakaoReview(review);
  } else {
    kakaoFittedOverlay = null;
    // 진행 중: 이미 지나온 구간을 노선 색 아래에 진한 테두리로 표시
    S.path.forEach((step) => kakaoAddPathLine(step, KAKAO_PATH_COLORS.done, 12, 0.45, 1));
  }
}

// 결과 비교 화면이 처음 열릴 때 출발·도착과 두 경로가 모두 보이도록 범위를 맞춘다.
function fitKakaoReview(review) {
  const key = `${S.sessionId}:${S.path.length}`;
  if (kakaoFittedOverlay === key) return;
  kakaoFittedOverlay = key;
  const bounds = new kakao.maps.LatLngBounds();
  const ids = new Set([S.start, S.dest]);
  [...(review.my || []), ...(review.opt || [])].forEach((step) => { ids.add(step.from); ids.add(step.to); });
  const finalResult = typeof result !== 'undefined' ? result : null;
  if (finalResult?.optimal?.steps) finalResult.optimal.steps.forEach((step) => { ids.add(step.from); ids.add(step.to); });
  let count = 0;
  ids.forEach((id) => { const p = nodePositions.get(id); if (p) { bounds.extend(p); count++; } });
  if (count > 1) kakaoMapInstance.setBounds(bounds);
}

/* ── 이동 가능 구간의 수단별 시간 배지 ── */

function drawKakaoModeBadges() {
  clearMapObjects(kakaoModeBadges);
  if (!S || S.status !== 'active') return;
  const quotes = S.quotes || {};
  const reachable = availableDestinations();
  const here = S.nodes[S.cur];
  reachable.forEach((nodeId) => {
    const target = S.nodes[nodeId];
    if (!here || !target || !nodePositions.has(here.id) || !nodePositions.has(nodeId)) return;
    const items = KAKAO_MODE_ORDER.filter((mode) => quotes[`${nodeId}:${mode}`]);
    if (!items.length) return;
    // 지하철 노선 색: 현재 역과 대상 역 사이 지하철 간선의 lineId
    const subwayEdge = S.edges.find((edge) => edge.lineId && edge.opts?.subway != null &&
      ((edge.a === S.cur && edge.b === nodeId) || (edge.b === S.cur && edge.a === nodeId)));

    const badge = document.createElement('div');
    badge.className = 'kakao-mode-badge' + (nodeId === sel ? ' is-selected' : '');
    badge.setAttribute('role', 'button');
    badge.tabIndex = 0;
    badge.dataset.nodeId = String(nodeId);
    const labels = [];
    badge.innerHTML = items.map((mode) => {
      const quote = quotes[`${nodeId}:${mode}`];
      const reason = kakaoUnavailableReason(quote);
      const color = mode === 'subway' ? kakaoModeStyle('subway', subwayEdge?.lineId).color : KAKAO_MODE_INFO[mode].color;
      labels.push(`${KAKAO_MODE_INFO[mode].name} ${quote.time}분${reason ? ` (${reason})` : ''}`);
      return `<span class="kakao-mode-chip${reason ? ' is-off' : ''}" style="--chip:${color}">` +
        `${KAKAO_MODE_INFO[mode].icon}${kakaoEscape(quote.time)}</span>`;
    }).join('');
    badge.title = `${target.name} · ${labels.join(' · ')}`;
    badge.setAttribute('aria-label', `${target.name}(으)로 이동, ${labels.join(', ')}`);
    badge.addEventListener('click', () => selectKakaoNode(nodeId));
    badge.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectKakaoNode(nodeId); }
    });
    const position = new kakao.maps.LatLng((here.lat + target.lat) / 2, (here.lng + target.lng) / 2);
    const overlayObject = new kakao.maps.CustomOverlay({
      position, content: badge, xAnchor: 0.5, yAnchor: 0.5, zIndex: nodeId === sel ? 9 : 8, clickable: true,
    });
    overlayObject.setMap(kakaoMapInstance);
    kakaoModeBadges.push(overlayObject);
  });
}

/* ── 역 이름표 ── */

function styleNodeLabels() {
  if (!S) return;
  const reachable = new Set(availableDestinations());
  const visited = new Set([S.start, ...S.path.map((step) => step.to)]);

  nodeLabels.forEach((label) => {
    const element = label.getContent();
    const id = Number(element.dataset.nodeId);
    const node = S.nodes[id];
    const errand = S.errand?.node === id ? S.errand : null;
    const name = node.name;
    element.textContent = errand ? `${errand.icon} ${name}${errand.done ? ' ✔' : ''}` : name;
    const current = id === S.cur;
    const selected = id === sel;
    const canSelect = reachable.has(id) && !busy;
    const classes = ['kakao-node-label'];
    if (id === S.start) classes.push('is-start');
    if (id === S.dest) classes.push('is-dest');
    if (current) classes.push('is-current');
    if (selected) classes.push('is-selected');
    if (canSelect) classes.push('is-reachable');
    else if (!current) classes.push('is-disabled');
    if (visited.has(id) && !current) classes.push('is-visited');
    if (node.isTransfer) classes.push('is-transfer');
    if (errand) classes.push(errand.done ? 'is-errand-done' : 'is-errand');
    element.className = classes.join(' ');

    const lines = (node.lineIds || []).map((lineId) => KAKAO_LINE_NAMES[lineId] || lineId).join('·');
    const role = [id === S.start ? '출발' : '', id === S.dest ? '도착' : '', node.isTransfer ? '환승역' : ''].filter(Boolean).join(', ');
    element.setAttribute('aria-label', [errand ? `${name}, 경유지, ${errand.goal}${errand.done ? ', 완료' : ''}` : name, role, lines].filter(Boolean).join(', '));
    element.title = current ? '현재 위치' : canSelect ? '클릭하여 이동할 역 선택' : '현재 위치에서는 직접 이동할 수 없는 역';
    if (lines) element.title = `${lines} · ${element.title}`;
    if (errand) element.title = `${errand.goal}${errand.done ? ' (완료)' : ''} · ${element.title}`;
    element.setAttribute('aria-disabled', String(!canSelect));
  });
}

/* ── 현재 위치 마커 ── */

function kakaoSetCurrent(lat, lng) {
  if (!kakaoCurrentOverlay?.setPosition) return;
  kakaoCurrentOverlay.setPosition(new kakao.maps.LatLng(lat, lng));
}

// game.js moveMarker() 가 매 프레임 호출한다. a, b 는 S.nodes 의 노드, k 는 0~1 진행률.
function kakaoMarkerAt(a, b, k, follow) {
  if (!kakaoMapVisible() || !a || !b) return;
  if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) return;
  kakaoSetCurrent(a.lat + (b.lat - a.lat) * k, a.lng + (b.lng - a.lng) * k);
  const key = `${a.id}>${b.id}`;
  if (follow && kakaoFollowKey !== key && kakaoMapInstance.panTo) {
    kakaoFollowKey = key;
    kakaoMapInstance.panTo(new kakao.maps.LatLng(b.lat, b.lng));
  }
}

// 멈춰 있을 때는 game.js markerPos(SVG 좌표)와 같은 역에 현재 위치를 둔다.
function placeKakaoCurrent() {
  if (!S || !kakaoCurrentOverlay) return;
  let node = S.nodes[S.cur];
  if (typeof markerPos !== 'undefined' && markerPos) {
    const atNode = S.nodes.find((n) => n.x === markerPos.x && n.y === markerPos.y);
    if (!atNode) return; // 이동 애니메이션 중에는 kakaoMarkerAt 이 위치를 갱신한다.
    node = atNode;
  }
  kakaoFollowKey = null; // 멈춘 상태: 다음 재생 구간에서 다시 지도를 따라가도록 초기화
  if (node && Number.isFinite(node.lat) && Number.isFinite(node.lng)) kakaoSetCurrent(node.lat, node.lng);
  const element = kakaoCurrentOverlay.getContent?.();
  if (element?.classList) element.classList.toggle('is-replay', typeof replaying !== 'undefined' && !!replaying);
}

/* ── 범례 ── */

function ensureKakaoLegend() {
  if (kakaoLegendEl) return;
  kakaoLegendEl = document.createElement('details');
  kakaoLegendEl.className = 'kakao-legend';
  const narrow = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 800px)').matches;
  if (!narrow) kakaoLegendEl.open = true;
  ['wheel', 'pointerdown', 'dblclick'].forEach((type) => {
    kakaoLegendEl.addEventListener(type, (event) => event.stopPropagation());
  });
  mapWrapEl.appendChild(kakaoLegendEl);
}

function updateKakaoLegend() {
  if (!kakaoLegendEl || !S) return;
  const lineIds = [...new Set(S.edges.filter((edge) => edge.lineId && edge.opts?.subway != null).map((edge) => edge.lineId))];
  const modes = new Set(S.edges.flatMap((edge) => kakaoEdgeModes(edge).map((item) => item.mode)));
  const swatch = (color, style, text) =>
    `<li><span class="kakao-swatch ${style}" style="--swatch:${color}"></span>${kakaoEscape(text)}</li>`;
  const rows = lineIds.map((lineId) => swatch(KAKAO_LINE_COLORS[lineId] || '#475569', 'solid', KAKAO_LINE_NAMES[lineId] || lineId));
  if (modes.has('bus')) rows.push(swatch(KAKAO_MODE_INFO.bus.color, 'dash', '버스'));
  if (modes.has('walk')) rows.push(swatch(KAKAO_MODE_INFO.walk.color, 'dot', '도보'));
  if (kakaoOverlayState()) {
    rows.push(swatch(KAKAO_PATH_COLORS.opt, 'solid thick', '최적 경로'));
    rows.push(swatch(KAKAO_PATH_COLORS.my, 'dash', '내 경로'));
  } else {
    rows.push(swatch(KAKAO_PATH_COLORS.done, 'solid thick', '지나온 구간'));
    rows.push('<li><span class="kakao-swatch arrow"></span>한 방향만 운행</li>');
  }
  kakaoLegendEl.innerHTML = `<summary>범례</summary><ul>${rows.join('')}</ul>`;
}

/* ── 전체 갱신 ── */

function syncKakaoGameState() {
  if (!kakaoMapVisible()) return;
  drawGameEdges();
  drawKakaoPaths();
  drawKakaoModeBadges();
  styleNodeLabels();
  placeKakaoCurrent();
  updateKakaoLegend();
}

// game.js render() 끝에서 호출된다. (역 선택, 이동 완료, 결과 비교, 최적 경로 재생 단계마다)
function kakaoMapRender() {
  syncKakaoGameState();
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
