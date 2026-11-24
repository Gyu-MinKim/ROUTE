"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../lib/kakaoExisting');
const B = require('../lib/baseWeights');
const { network } = require('../lib/subwayNetwork');

const from = network.stations.changdong, to = network.stations.nokcheon;
const edge = { id: 0, a: 0, b: 1, lineId: '1', stationPath: ['changdong', 'nokcheon'], opts: {} };
const response = data => ({ ok: true, status: 200, json: async () => data });

test('existing Kakao contract preserves verified single bus fare and rejects wrong rail line', async () => {
  const step = (type, name, stops, time) => ({ properties: { type, time,
    vehicles: [{ name }], stops: stops.map(name => ({ name })) } });
  const route = (i, fare, totalTime) => ({ properties: { totalTime, transfers: 0,
    ...(fare != null ? { fare: { value: fare } } : {}) }, steps: [i] });
  const data = await K.transit(from, to, 'mock', async (url, options) => {
    assert.equal(url.hostname, 'dapi.kakao.com');
    assert.equal(url.pathname, '/v2/routing/publictraffic');
    assert.equal(url.searchParams.get('start_x'), String(from.lng));
    assert.equal(options.headers.Authorization, 'KakaoAK mock');
    return response({ status: 'OK', routes: [
      route(step('BUS', '111', ['정류장1', '정류장2'], 300), null, 390),
      route(step('BUS', '112', ['정류장1', '정류장2'], 400), 1200, 420),
      route(step('SUBWAY', '4호선', ['창동', '녹천'], 100), 1550, 160),
      route(step('SUBWAY', '1호선', ['창동', '녹천'], 160), 1550, 220),
    ] });
  });
  const plan = B.parseWeight(edge, [from, to], {
    ...data, routes: data.routes.map(r => ({ ...r, evidence: data.evidence })),
  });
  assert.equal(plan.base.subway, 4);
  assert.equal(plan.capture.subway.rideSeconds, 160);
  assert.equal(plan.gameFare.bus, 1200);
  assert.equal(plan.capture.bus.routeFare, 1200);
  assert.equal(plan.capture.bus.routeId, '112');
  assert.equal(plan.base.bus, 7);
  assert.ok(!plan.capture.bus.evidence.url.includes('mock'));
});

test('existing Kakao walking contract distinguishes a verified result from unavailable and invalid results', async () => {
  const walk = await K.walk(from, to, 'mock', async url => {
    assert.equal(url.pathname, '/v2/routing/walk');
    return response({ status: 'OK', route: { properties: { totalTime: 961, totalDistance: 1200 } } });
  });
  assert.equal(walk.totalMinutes, 17);
  assert.equal(walk.totalSeconds, 961);
  assert.equal((await K.walk(from, to, 'mock', async () => response({ status: 'TOO_FAR_AWAY' }))).reason, 'no_route');
  await assert.rejects(K.walk(from, to, 'mock', async () => response({ status: 'OK' })), /kakao_invalid_walk_response/);
});
