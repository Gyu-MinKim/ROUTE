'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../lib/baseWeights');

const nodes = [
  { id: 0, name: '집', stationName: '쌍문역' },
  { id: 1, name: '광운대역', stationName: '광운대역' },
];
const edge = { id: 0, a: 0, b: 1, opts: { walk: 18, bus: 14, subway: 9 } };

test('단독 지하철/버스 경로만 가중치 후보로 사용하고 원본 opts는 유지한다', () => {
  const data = {
    routes: [
      { index: 0, totalMinutes: 5, fare: 1550, steps: [{ mode: 'subway' }] },
      { index: 1, totalMinutes: 22, fare: 0, steps: [{ mode: 'walk' }, { mode: 'bus' }] },
      { index: 2, totalMinutes: 16, fare: 1650, steps: [{ mode: 'subway' }, { mode: 'bus' }] },
    ],
  };
  const rec = B.parseWeight(edge, nodes, data);
  assert.equal(rec.from, '쌍문역');
  assert.equal(rec.to, '광운대역');
  assert.equal(rec.status, 'ok');
  assert.deepEqual(rec.base, { walk: null, bus: 22, subway: 5 });
  assert.deepEqual(rec.fare, { walk: null, bus: null, subway: 1550 });
  assert.deepEqual(edge.opts, { walk: 18, bus: 14, subway: 9 });
  assert.equal(rec.candidates[2].mode, null);
});

test('유효한 단일 수단 경로가 없으면 명시적으로 no_single_mode_route', () => {
  const rec = B.parseWeight(edge, nodes, {
    routes: [{ totalMinutes: 13, steps: [{ mode: 'subway' }, { mode: 'bus' }] }]
  });
  assert.equal(rec.status, 'no_single_mode_route');
  assert.equal(rec.base.subway, null);
});

test('같은 수단 여러 경로 중 더 빠른 결과를 선택한다', () => {
  const rec = B.parseWeight(edge, nodes, { routes: [
    { totalMinutes: 22, index: 0, fare: 1550, steps: [{ mode: 'subway' }] },
    { totalMinutes: 18, index: 1, fare: 1650, steps: [{ mode: 'subway' }] },
  ] });
  assert.equal(rec.base.subway, 18);
  assert.equal(rec.routeIndex.subway, 1);
});

test('API 실패를 배열에 기록할 수 있는 형태로 표현한다', () => {
  const rec = B.errorWeight(edge, nodes, 'station_not_found');
  assert.equal(rec.status, 'error');
  assert.equal(rec.error, 'station_not_found');
  assert.equal(rec.base.walk, null);
});
