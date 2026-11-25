"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PassThrough } = require('node:stream');
const E = require('../lib/engine');
const B = require('../lib/baseWeights');
const F = require('../lib/farePolicy');

function graph(legs, mods = {}) {
  const nodes = Array.from({ length: legs.length + 1 }, (_, id) => ({ id }));
  const adj = nodes.map(() => []);
  const edges = legs.map(({ lineId, premiumSections }, id) => {
    const e = { id, a: id, b: id + 1, lineId, premiumSections };
    adj[e.a].push(e);
    adj[e.b].push(e);
    return e;
  });
  const verifiedWeights = legs.map(({ base, gameFare, rideMinutes, reverse }) =>
    ({ base, gameFare, rideMinutes, reverse }));
  return { nodes, edges, adj, verifiedWeights, mods, busEnabled: true };
}

const subway = (lineId, premiumSections) => ({
  lineId, premiumSections, base: { subway: 8 }, gameFare: { subway: 1550 }, rideMinutes: 5,
});

test('same subway line continues without a transfer and a line change adds the penalty', () => {
  const g = graph([subway('1'), subway('1'), subway('2')]);
  const result = E.solveOptimal(g, 0, 3, 1600);
  assert.deepEqual(result.steps.map(({ time, cost, transfer }) => [time, cost, transfer]),
    [[8, 1550, false], [5, 0, false], [11, 0, true]]);
});

test('event boundary closes rail and uses verified bus with independent fare delta', () => {
  const bus = { base: { subway: 5, bus: 9 }, gameFare: { subway: 1550, bus: 3000 }, lineId: '1' };
  const g = graph([subway('1'), bus]);
  const event = { mode: 'subway', at: 8, off: true };
  const result = E.solveOptimal(g, 0, 2, 3100, null, { ev: event });
  assert.equal(result.cost, 3000);
  assert.equal(result.steps[1].mode, 'bus');
  assert.equal(result.steps[1].time, 9 + E.cfg.transfer.penalty);
  assert.equal(result.steps[1].cost, 1450);
});

test('walking uses exact stamina and does not assume the reverse time', () => {
  const walk = { base: { walk: 3 }, gameFare: { walk: 0 },
    reverse: { base: { walk: 8 }, gameFare: { walk: 0 } } };
  const g = graph([walk, walk], { subwayOff: true });
  const persona = { walkMul: 2 };
  assert.equal(E.solveOptimal(g, 0, 2, 0, { max: 12, persona }).time, 6);
  assert.equal(E.solveOptimal(g, 0, 2, 0, { max: 11, persona }), null);
  assert.equal(E.solveOptimal(g, 2, 1, 0, { max: 16, persona }).time, 8);
});

test('verified time alone does not activate a mode with unknown fare or invent a detour', () => {
  const g = graph([{ base: { bus: 3, walk: null }, gameFare: { bus: null, walk: null } }], { subwayOff: true });
  assert.equal(E.movesFrom(g, 0, { used: 0, rem: 0 }, null, null).size, 0);
  assert.equal(E.solveOptimal(g, 0, 1, 6200), null);
});

test('Shinbundang charges each covered section once during a transfer window', () => {
  assert.equal(F.shinbundangSections(['s3_337', 's2_loop_222']), 1);
  assert.equal(F.shinbundangSections(['s2_loop_222', 'sb_k230']), 2);
  assert.equal(F.shinbundangSections(['sd_gwanggyo', 's3_337']), 7);
  const g = graph([subway('3'), subway('S', 1), subway('S', 1), subway('S', 2), subway('S', 4), subway('B')]);
  const result = E.solveOptimal(g, 0, 6, 3750);
  assert.deepEqual(result.steps.map(step => step.cost), [1550, 700, 0, 1000, 500, 0]);
  assert.equal(result.cost, 3750);
});

test('subway validation checks direction, line, and every compressed stop', () => {
  const edge = { id: 0, a: 0, b: 1, lineId: 'S', stationPath: ['s3_337', 's7_734', 's9_925', 's2_loop_222'], opts: {} };
  const nodes = [{ name: '신사역' }, { name: '강남역' }];
  const step = { mode: 'subway', stops: ['신사', '논현', '신논현', '강남'],
    vehicles: ['신분당'], boardable: true, seconds: 120 };
  const route = { totalMinutes: 4, totalSeconds: 240, transfers: 0, steps: [step] };
  const parse = (r, dir) => B.parseWeight(edge, nodes, { source: 'kakao-publictraffic', routes: [r] }, dir);
  assert.equal(parse(route).rideMinutes, 2);
  assert.equal(parse(route, 'b-to-a').base.subway, null);
  assert.equal(parse({ ...route, steps: [{ ...step, stops: ['신사', '강남'] }] }).base.subway, null);
  assert.equal(parse({ ...route, steps: [{ ...step, vehicles: ['3호선'] }] }).base.subway, null);
});

test('offline start and move use stored weights even with the old live setting', async t => {
  const previousLoad = process.loadEnvFile, previousFetch = global.fetch;
  const previousMode = process.env.ROUTE_GRAPH_MODE, previousKey = process.env.KAKAO_REST_API_KEY;
  const previousSource = process.env.ROUTE_WEIGHT_SOURCE;
  const previousApi = process.env.ROUTE_KAKAO_API;
  process.loadEnvFile = () => {};
  t.after(() => {
    process.loadEnvFile = previousLoad;
    if (previousApi === undefined) delete process.env.ROUTE_KAKAO_API;
    else process.env.ROUTE_KAKAO_API = previousApi;
    if (previousSource === undefined) delete process.env.ROUTE_WEIGHT_SOURCE;
    else process.env.ROUTE_WEIGHT_SOURCE = previousSource;
    global.fetch = previousFetch;
    if (previousMode === undefined) delete process.env.ROUTE_GRAPH_MODE;
    else process.env.ROUTE_GRAPH_MODE = previousMode;
    if (previousKey === undefined) delete process.env.KAKAO_REST_API_KEY;
    else process.env.KAKAO_REST_API_KEY = previousKey;
  });
  process.env.ROUTE_GRAPH_MODE = 'subway';
  process.env.ROUTE_WEIGHT_SOURCE = 'live';
  process.env.ROUTE_KAKAO_API = 'affiliate';
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'route-verified-test-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const root = path.join(__dirname, '..');
  for (const name of ['lib', 'node_modules', 'routes.json', 'server.js']) {
    fs.cpSync(path.join(root, name), path.join(runtime, name), { recursive: true });
  }
  fs.mkdirSync(path.join(runtime, 'data'));
  fs.copyFileSync(path.join(root, 'data', 'subwayNetwork.json'), path.join(runtime, 'data', 'subwayNetwork.json'));
  const serverPath = path.join(runtime, 'server.js');
  const app = require(serverPath);
  const api = (url, body, handler = app) => new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(new PassThrough());
    Object.assign(req, { method: body ? 'POST' : 'GET', url, body });
    const res = new http.ServerResponse(req);
    res.end = data => resolve({ status: res.statusCode, body: JSON.parse(data) });
    handler.handle(req, res, error => reject(error || new Error('Unhandled endpoint: ' + url)));
  });
  const start = levelId => api('/api/simulate/start', { mode: 'level', levelId });
  delete process.env.KAKAO_REST_API_KEY;
  let requests = 0;
  global.fetch = async () => { requests++; throw new Error('unexpected external request'); };
  assert.equal((await api('/api/kakao/transit?start=A&end=B')).status, 410);
  const ids = ['s1_115', 'changdong', 'nokcheon', 'wolgye', 'gwangundae'];
  const evidence = { url: 'https://example.invalid/fixture', observedAt: '2026-11-24T00:00:00Z' };
  const forward = { walk: { seconds: 240, evidence }, bus: { seconds: 180, routeId: 'test', routeFare: 1500, evidence } };
  const segments = ids.slice(1).map((to, i) => ({ from: ids[i], to, forward, reverse: forward }));
  fs.writeFileSync(path.join(runtime, 'data', 'commuteSegments.json'), JSON.stringify({ version: 1, segments }));
  for (const levelId of [1, 9, 12, 13]) {
    const response = await start(levelId);
    assert.equal(requests, 0);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const initial = response.body;
    if (levelId === 13) assert.equal(initial.event.off, true);
    const weights = await api('/api/kakao/weights?sessionId=' + initial.sessionId);
    assert.equal(weights.body.appliedToGame, true);
    assert.equal(weights.body.loaded, initial.edges.length);
    const scenario = E.cfg.levels.find(level => level.id === levelId);
    const g = { ...initial, adj: initial.nodes.map(() => []), verifiedWeights: weights.body.baseWeights,
      mods: scenario.mods, busEnabled: initial.edges.some(edge => edge.opts.bus != null) };
    for (const edge of g.edges) {
      g.adj[edge.a].push(edge);
      g.adj[edge.b].push(edge);
    }
    const optimal = E.solveOptimal(g, initial.start, initial.dest, initial.resources,
      { max: initial.stamina.max, persona: E.cfg.personas[scenario.persona] }, { ev: initial.event });
    assert.ok(optimal);
    let state = initial, result;
    for (const step of optimal.steps) {
      const quote = state.quotes[step.to + ':' + step.mode];
      assert.ok(quote);
      assert.deepEqual([quote.time, quote.cost, quote.stam], [step.time, step.cost, step.stamina]);
      if ([9, 12].includes(levelId) || state.event?.active) {
        assert.ok(Object.keys(state.quotes).every(key => !key.endsWith(':subway')));
      }
      const moved = await api('/api/simulate/step', { sessionId: initial.sessionId, to: step.to, mode: step.mode });
      assert.equal(moved.status, 200);
      assert.equal(moved.body.state.used - state.used, quote.time);
      assert.equal(state.resLeft - moved.body.state.resLeft, quote.cost);
      assert.equal(state.stamina.left - moved.body.state.stamina.left, quote.stam);
      ({ state, result } = moved.body);
    }
    assert.equal(result?.status, 'success');
    assert.deepEqual(result.optimal, optimal);
    const retried = await api('/api/simulate/retry', { sessionId: initial.sessionId });
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.body.quotes, initial.quotes);
    assert.deepEqual(retried.body.edges, initial.edges);
    assert.equal(requests, 0);
  }
});
