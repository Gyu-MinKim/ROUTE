"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const E = require('../lib/engine');

const spine = ['s1_115', 'changdong', 'nokcheon', 'wolgye', 'gwangundae'];
const errand = 'seokgye';
const evidence = { url: 'https://example.invalid/mock', observedAt: '2026-11-24T00:00:00Z' };
const mockWalk = { seconds: 300, evidence };
const mockBus = { seconds: 300, routeId: 'mock-bus', evidence, cardBaseFare: 1500, fareEvidence: evidence };
const mockRail = { seconds: 240, rideSeconds: 120, evidence };

// Fixture times test the game rules. This data is created only inside the test temp directory.
function mapFor(levelId) {
  const edges = spine.slice(1).map((to, i) => ({
    from: spine[i], to, lineId: '1', stationPath: [spine[i], to],
    forward: { walk: mockWalk, bus: mockBus, subway: mockRail },
    reverse: { walk: { ...mockWalk, seconds: 360 }, bus: mockBus, subway: mockRail },
  }));
  edges.push(...[spine[1], spine[2]].map(from => ({
    from, to: errand, forward: { walk: mockWalk, bus: mockBus },
    reverse: { walk: mockWalk, bus: mockBus },
  })));
  if ([6, 10, 14].includes(levelId)) {
    for (const edge of edges) {
      delete edge.forward.subway;
      delete edge.reverse.subway;
    }
  }
  if (levelId === 5 || levelId === 15) {
    for (const edge of edges) {
      delete edge.forward.subway;
      delete edge.forward.walk;
    }
  }
  if (levelId === 7) {
    for (const edge of edges) {
      delete edge.forward.subway;
      delete edge.forward.bus;
    }
  }
  return { mode: 'level', levelId, stationIds: [...spine, errand], start: spine[0], dest: spine.at(-1), edges };
}

test('stored maps complete levels 1 through 15 without a key or live request', async t => {
  const root = path.resolve(__dirname, '..');
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'route-stored-test-'));
  const previous = Object.fromEntries(['ROUTE_GRAPH_MODE', 'ROUTE_WEIGHT_SOURCE', 'ROUTE_VERIFIED_ROUNDS_FILE',
    'KAKAO_REST_API_KEY'].map(key => [key, process.env[key]]));
  const previousFetch = global.fetch;
  let requests = 0;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = previousFetch;
    fs.rmSync(runtime, { recursive: true, force: true });
  });
  for (const name of ['lib', 'node_modules', 'routes.json', 'server.js']) {
    fs.cpSync(path.join(root, name), path.join(runtime, name), { recursive: true });
  }
  fs.mkdirSync(path.join(runtime, 'data'));
  fs.copyFileSync(path.join(root, 'data', 'subwayNetwork.json'), path.join(runtime, 'data', 'subwayNetwork.json'));
  delete process.env.KAKAO_REST_API_KEY;
  delete process.env.ROUTE_WEIGHT_SOURCE;
  delete process.env.ROUTE_VERIFIED_ROUNDS_FILE;
  process.env.ROUTE_GRAPH_MODE = 'subway';
  global.fetch = async () => { requests++; throw new Error('offline'); };

  const app = require(path.join(runtime, 'server.js'));
  const api = (url, body) => new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(new PassThrough());
    Object.assign(req, { method: body ? 'POST' : 'GET', url, body });
    const res = new http.ServerResponse(req);
    res.end = data => resolve({ status: res.statusCode, body: JSON.parse(data) });
    app.handle(req, res, error => reject(error || new Error('Unhandled endpoint: ' + url)));
  });
  const start = levelId => api('/api/simulate/start', { mode: 'level', levelId });
  const file = path.join(runtime, 'data', 'verifiedRounds.json');
  const write = maps => fs.writeFileSync(file, JSON.stringify({ version: 1, maps }));
  // Reproduce the original Git Bash command without a key or a data file.
  for (const id of [1, 9, 12, 13]) {
    assert.deepEqual(await start(id), { status: 503, body: { error: 'verified_data_missing' } });
  }
  fs.copyFileSync(path.join(root, 'data', 'seoulMetroTimes.json'), path.join(runtime, 'data', 'seoulMetroTimes.json'));
  fs.writeFileSync(path.join(runtime, 'data', 'commuteSegments.json'), JSON.stringify({ version: 1, segments: mapFor(1).edges }));
  const levels = E.cfg.levels;
  for (const { id } of levels) {
    const opened = await start(id);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const weights = await api('/api/kakao/weights?sessionId=' + opened.body.sessionId);
    assert.equal(weights.body.appliedToGame, true);
    assert.equal(requests, 0);
  }
  process.env.ROUTE_WEIGHT_SOURCE = 'stored';
  assert.deepEqual(await start(1), { status: 503, body: { error: 'verified_data_missing' } });
  write([]);
  assert.deepEqual(await start(9), { status: 422, body: { error: 'verified_level_data_missing' } });
  const broken = mapFor(9);
  broken.edges[0].stationPath = [spine[0], spine[3], spine[1]];
  write([broken]);
  assert.deepEqual(await start(9), { status: 422, body: { error: 'verified_data_invalid' } });

  const empty = mapFor(9);
  for (const edge of empty.edges) {
    edge.forward = { bus: { status: 'no_route' }, walk: { status: 'lookup_failed' } };
    edge.reverse = {};
  }
  write([empty]);
  assert.deepEqual(await start(9), { status: 422, body: { error: 'verified_lookup_incomplete' } });
  for (const edge of empty.edges) delete edge.forward.walk;
  write([empty]);
  assert.deepEqual(await start(9), { status: 422, body: { error: 'no_verified_route' } });
  write([empty, ...levels.map(level => mapFor(level.id))]);
  const { newStoredRound } = require('../lib/verifiedRounds');
  for (const scenario of levels) {
    const id = scenario.id;
    const { status, body: initial } = await start(id);
    assert.equal(status, 200, 'Level ' + id + ': ' + JSON.stringify(initial));
    assert.equal(initial.subwayPreview, false);
    const weights = await api('/api/kakao/weights?sessionId=' + initial.sessionId);
    assert.equal(weights.status, 200);
    assert.equal(weights.body.appliedToGame, true);
    assert.equal(weights.body.baseWeights[0].reverse.base.walk, 6);
    const solved = await newStoredRound(file, { mode: 'level', round: scenario.round, scenario });
    assert.equal(initial.limit, solved.limit);
    let state = initial, result, sawShutdown = false;
    for (const step of solved.opt.steps) {
      const quote = state.quotes[step.to + ':' + step.mode];
      assert.deepEqual([quote.time, quote.cost, quote.stam], [step.time, step.cost, step.stamina], 'Level ' + id);
      if (id === 13 && state.event.active) sawShutdown = true;
      if ([9, 12].includes(id) || (id === 13 && state.event.active))
        assert.ok(Object.keys(state.quotes).every(key => !key.endsWith(':subway')));
      const moved = await api('/api/simulate/step', { sessionId: initial.sessionId, to: step.to, mode: step.mode });
      assert.equal(moved.status, 200);
      assert.equal(moved.body.state.used - state.used, quote.time);
      assert.equal(state.resLeft - moved.body.state.resLeft, quote.cost);
      assert.equal(state.stamina.left - moved.body.state.stamina.left, quote.stam);
      ({ state, result } = moved.body);
    }
    assert.equal(result?.status, 'success', 'Level ' + id);
    assert.equal(result.stars, 3, 'Level ' + id);
    if (scenario.errand) assert.equal(result.errandDone, true);
    if (id === 13) assert.equal(sawShutdown, true);
    assert.deepEqual(result.optimal, solved.opt);
  }
  assert.equal(requests, 0);
});
