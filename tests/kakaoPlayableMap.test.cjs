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
  const status = { notifications: [], updateCount: 0, boundsSet: 0, markers: [], lines: [] };
  const listeners = {};
  class MapStub { relayout() {} setBounds() { status.boundsSet++; } }
  class MarkerStub {
    constructor({position}) { this.position = position; status.markers.push(this); }
    setMap(map) { this.map = map; }
  }
  class OverlayStub {
    constructor({ content }) { this.content = content; }
    setMap(map) { this.map = map; }
    getContent() { return this.content; }
  }
  class LineStub {
    constructor({path}) { this.path = path; status.lines.push(this); }
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
    S:state, busy:false, sel:null, updateFooter() { status.updateCount++; },
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
