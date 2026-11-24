"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const affiliate = process.env.ROUTE_KAKAO_API === 'affiliate';
const enabled = process.env.ROUTE_KAKAO_LIVE === '1';
const K = require('../lib/kakaoTransit');
const existing = require('../lib/kakaoExisting');
const { network } = require('../lib/subwayNetwork');
const from = network.stations.changdong, to = network.stations.nokcheon;
const key = process.env.KAKAO_REST_API_KEY;
const transit = affiliate ? K.getTransitRoutesFromCoords : existing.transit;
const walk = affiliate ? K.getWalkRouteFromCoords : existing.walk;

test('live Kakao transit contract', { skip: !enabled }, async () => {
  const result = await transit(from, to, key);
  assert.ok(result.routes.some(route => route.totalMinutes > 0), 'No valid Kakao routes');
});

test('live Kakao walking contract', { skip: !enabled }, async () => {
  const result = await walk(from, to, key);
  assert.equal(result.status, 'ok', result.reason);
  assert.ok(result.totalMinutes > 0);
});
