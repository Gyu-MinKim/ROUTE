'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'kakaoMap.js'), 'utf8');
function classList(initial = []) {
  const classes = new Set(initial);
  return { add: (x) => classes.add(x), remove: (x) => classes.delete(x),
    contains: (x) => classes.has(x), toggle: (x, on) => {
      if (on) classes.add(x); else classes.delete(x);
    } };
}
function element() {
  const listeners = {};
  return {
    classList: classList(), style: {}, dataset: {}, children: [],
    addEventListener(event, listener) { listeners[event] = listener; },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    setAttribute(name, value) { this[name] = value; },
    dispatchEvent(event) { listeners[event.type]?.(event); },
    _listeners: listeners,
  };
}
function setup() {
  const fakeGameMap = element(), mapSwitch = element();
  const fakeKakaoEl = element(); fakeKakaoEl.classList.add('hidden');
  const fakeWrap = element(); const gameButton = element(), kakaoButton = element();
  const nodes = [
    { id: 0, name: '쌍문역', stationName: '쌍문역', lat: 37.61, lng: 127.01 },
    { id: 1, name: '미아역', stationName: '미아역', lat: 37.62, lng: 127.02 },
    { id: 2, name: '신이문역', stationName: '신이문역', lat: 37.63, lng: 127.05 },
  ];
  const state = { sessionId: 'abc', realMapEnabled: true, nodes, edges: [{ id: 0, a: 0, b: 1 }],
    cur: 0, start: 0, dest: 2, status: 'active', path: [] };
  const clicks = [];
  fakeGameMap.querySelector = (query) => {
    const match = query.match(/data-id="(\d+)"/);
    if (!match) return null;
    return { dispatchEvent: () => clicks.push(Number(match[1])) };
  };
  const status = { notifications: [], updateCount: 0, boundsSet: 0, markers: [], lines: [], overlays: [] };
  const listeners = {};
  class MapStub { relayout() {} setBounds() { status.boundsSet++; } }
  class MarkerStub {
    constructor({position}) { this.position = position; status.markers.push(this); }
    setMap(map) { this.map = map; }
  }
  class OverlayStub {
    constructor({ content }) { this.content = content; status.overlays.push(this); }
    setMap(map) { this.map = map; }
    getContent() { return this.content; }
  }
  class LineStub {
    constructor(options) { this.path = options.path; this.options = options; status.lines.push(this); }
    setMap(map) { this.map = map; }
  }
  class BoundsStub { extend() {} }
  class LatLngStub { constructor(lat, lng) { this.lat = lat; this.lng = lng; } }
  const document = {
    getElementById(id) { return ({'map':fakeGameMap, 'kakao-map':fakeKakaoEl,
      'btn-game-map':gameButton,'btn-kakao-map':kakaoButton})[id]; },
    querySelector(selector) { return selector === '.map-wrap' ? fakeWrap : selector === '.map-switch' ? mapSwitch : null; },
    createElement() { return element(); },
    addEventListener(type, cb) { listeners[type] = cb; },
  };
  const kakao = { maps: { load(cb) { cb(); }, Map: MapStub, Marker: MarkerStub,
    CustomOverlay: OverlayStub, Polyline: LineStub, LatLngBounds: BoundsStub,
    LatLng: LatLngStub, event: { addListener() {} } } };
  const context = vm.createContext({ document, window: {kakao}, kakao,
    S:state, busy:false, sel:null, availableDestinations() { return state.status === 'active' ? state.available ?? [1] : []; }, updateFooter() { status.updateCount++; },
    notify(msg) { status.notifications.push(msg); },
    MouseEvent: class { constructor(type) { this.type = type; } },
    console, fetch: async () => { throw new Error('unexpected fetch'); },
    URLSearchParams,
  });
  vm.runInContext(source, context);
  return { context, clicks, status, listeners, fakeKakaoEl, state, mapSwitch };
}

test('인접 노드 선택은 기존 게임 SVG 클릭으로 전달된다', () => {
  const x = setup();
  vm.runInContext('selectKakaoNode(1)', x.context);
  vm.runInContext('selectKakaoNode(2)', x.context);
  assert.deepEqual(x.clicks, [1]);
  assert.equal(x.status.notifications.length, 1);
});

test('게임 진행 중이 아닐 때 노드를 선택하지 않는다', () => {
  const x = setup();
  x.state.status = 'success';
  vm.runInContext('selectKakaoNode(1)', x.context);
  assert.deepEqual(x.clicks, []);
});

test('실제 지도에서 게임 노드와 간선을 시각화하고 다시 SVG로 돌아올 수 있다', async () => {
  const x = setup();
  await vm.runInContext('showKakaoMap()', x.context);
  assert.equal(x.fakeKakaoEl.classList.contains('hidden'), false);
  assert.equal(x.status.markers.length, 3);
  assert.equal(x.status.lines.length, 1);
  assert.equal(x.status.boundsSet, 1);
  assert.equal(x.status.updateCount, 1);
  vm.runInContext('showGameMap()', x.context);
  assert.equal(x.fakeKakaoEl.classList.contains('hidden'), true);
  assert.equal(x.status.updateCount, 2);
});

test('기본 모드는 지도 전환을 숨기고 실제 지도 요청을 무시한다', async () => {
  const x = setup();
  x.state.realMapEnabled = false;
  x.listeners['route:ui']();
  assert.ok(x.mapSwitch.classList.contains('hidden'));
  await vm.runInContext('showKakaoMap()', x.context);
  assert.equal(x.status.markers.length, 0);
  x.state.realMapEnabled = true;
  x.listeners['route:ui']();
  assert.equal(x.mapSwitch.classList.contains('hidden'), false);
});

test('실제 지도에서 심부름 역과 완료 상태를 갱신한다', async () => {
  const x = setup();
  x.state.errand = { node: 1, icon: '💊', goal: '약국 들르기', done: false };
  await vm.runInContext('showKakaoMap()', x.context);
  const label = vm.runInContext('nodeLabels[1].getContent()', x.context);
  assert.equal(label.textContent, '💊 미아역');
  assert.match(label.title, /약국 들르기/);
  x.state.errand.done = true;
  x.listeners['route:ui']();
  assert.equal(label.textContent, '💊 미아역 ✔');
  x.state.errand = null;
  x.listeners['route:ui']();
  assert.equal(label.textContent, '미아역');
});

test('실제 지도에서 이동수단이 모두 막힌 연결역을 선택할 수 없다', () => {
  const x = setup();
  x.state.available = [];
  vm.runInContext('selectKakaoNode(1)', x.context);
  assert.deepEqual(x.clicks, []);
});

test('실제 지도에서 노선 색·버스/도보 선 모양·한 방향 구간을 구분한다', async () => {
  const x = setup();
  x.state.edges = [
    { id: 0, a: 0, b: 1, lineId: '4', opts: { subway: 3, bus: null, walk: 20 } },
    { id: 1, a: 1, b: 2, lineId: null, opts: { subway: null, bus: 5, walk: null },
      directionalOpts: { forward: { subway: null, bus: 5, walk: null }, reverse: { subway: null, bus: null, walk: null } } },
  ];
  await vm.runInContext('showKakaoMap()', x.context);
  const lines = x.status.lines.map((line) => line.options);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].strokeColor, '#00A5DE');
  assert.equal(lines[0].strokeStyle, 'solid');
  assert.equal(lines[1].strokeStyle, 'shortdot');
  assert.equal(lines[2].strokeStyle, 'shortdash');
  assert.equal(lines[2].endArrow, true);
  assert.equal(lines[0].endArrow, false);
});

test('실제 지도에서 이동 가능 구간의 수단별 시간을 보여 주고 누르면 역을 선택한다', async () => {
  const x = setup();
  x.state.edges = [{ id: 0, a: 0, b: 1, lineId: '4', opts: { subway: 3, bus: null, walk: 20 } }];
  x.state.quotes = { '1:subway': { time: 3, cost: 1400 }, '1:walk': { time: 20, cost: 0 } };
  await vm.runInContext('showKakaoMap()', x.context);
  const badge = x.status.overlays.map((o) => o.content).find((el) => /kakao-mode-badge/.test(el.className));
  assert.ok(badge);
  assert.match(badge.innerHTML, /🚇3/);
  assert.match(badge.innerHTML, /🚶20/);
  badge.dispatchEvent({ type: 'click' });
  assert.deepEqual(x.clicks, [1]);
});

test('실제 지도 이름표에 출발·도착·현재 위치·환승역 상태를 표시한다', async () => {
  const x = setup();
  x.state.nodes[1].isTransfer = true;
  await vm.runInContext('showKakaoMap()', x.context);
  const cls = (id) => vm.runInContext(`nodeLabels[${id}].getContent().className`, x.context);
  assert.match(cls(0), /is-start/);
  assert.match(cls(0), /is-current/);
  assert.match(cls(1), /is-transfer/);
  assert.match(cls(1), /is-reachable/);
  assert.match(cls(2), /is-dest/);
  assert.match(cls(2), /is-disabled/);
});

test('결과 화면에서 내 경로와 최적 경로를 실제 지도에 겹쳐 그리고 범위를 맞춘다', async () => {
  const x = setup();
  await vm.runInContext('showKakaoMap()', x.context);
  const before = x.status.lines.length;
  x.state.status = 'success';
  x.state.path = [{ from: 0, to: 1, mode: 'walk' }];
  x.context.overlay = { my: x.state.path, opt: [{ from: 0, to: 1, mode: 'subway' }, { from: 1, to: 2, mode: 'bus' }] };
  x.listeners['route:ui']();
  const added = x.status.lines.slice(before).map((line) => line.options);
  assert.equal(added.filter((o) => o.strokeColor === '#963E48').length, 2);
  assert.equal(added.filter((o) => o.strokeColor === '#526E85').length, 1);
  assert.equal(x.status.boundsSet, 2);
  x.listeners['route:ui']();
  assert.equal(x.status.boundsSet, 2); // 같은 결과 화면에서는 범위를 다시 맞추지 않음
});
