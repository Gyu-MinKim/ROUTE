'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../lib/engine');
const { generateFeedback } = require('../lib/llm');
const { feedbackResult, basicFeedback } = require('../lib/feedbackResult');
const { validateFeedback, parseFeedback } = require('../lib/feedbackSchema');
const { coachFailure, logCoach } = require('../lib/coachLog');

test('completed sessions generate and cache coaching from server-owned gameplay data', async t => {
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  if (process.loadEnvFile) t.mock.method(process, 'loadEnvFile', () => {});
  const env = { ...process.env };
  t.after(() => { process.env = env; });
  for (const key of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'ROUTE_GRAPH_MODE']) delete process.env[key];

  const writeFile = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (path.basename(String(file)) !== 'game_history.json') return writeFile(file, ...args);
  });

  const nodes = ['출발역', '경유역', '도착역'].map((name, id) => ({ id, name }));
  const edges = [{ id: 0, a: 0, b: 1, opts: { bus: 2 } }, { id: 1, a: 1, b: 2, opts: { bus: 2 } }];
  const graph = { nodes, edges, adj: [[edges[0]], edges, [edges[1]]] };
  const steps = [
    { from: 0, to: 1, mode: 'bus', time: 2, cost: 100, stamina: 1, transfer: false },
    { from: 1, to: 2, mode: 'bus', time: 2, cost: 100, stamina: 1, transfer: false },
  ];
  const optimal = { steps, time: 4, cost: 200 };
  t.mock.method(E, 'newRound', ({ scenario }) => ({
    graph, start: 0, dest: 2, limit: 8, resources: 300, opt: optimal,
    persona: scenario ? {} : null, maxStamina: scenario ? 10 : 0,
    event: scenario && { title: '운행 중단', mode: 'subway', at: 2, off: true },
    errand: scenario && { node: 1, goal: '들르기' },
  }));
  let first = { time: 2, cost: 100, stam: 0 };
  let second = { ...first };
  t.mock.method(E, 'movesFrom', (_, node) => new Map(node === 2 ? [] : [
    [`${node + 1}:bus`, { q: node === 0 ? first : second }],
  ]));

  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const httpFetch = global.fetch;
  const api = async (endpoint, body) => {
    const response = await httpFetch(`http://127.0.0.1:${server.address().port}/api/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const start = async body => (await api('simulate/start', body)).body;
  const move = async (sessionId, to) => (await api('simulate/step', { sessionId, to, mode: 'bus' })).body;
  const giveup = sessionId => api('simulate/giveup', { sessionId });
  const feedback = (sessionId, extra) => api('feedback', { sessionId, ...extra });

  const missingKeyRound = await start({});
  assert.equal((await feedback(missingKeyRound.sessionId)).status, 409);
  assert.equal((await feedback(randomUUID())).status, 404);
  assert.equal((await feedback(42)).status, 400);
  await giveup(missingKeyRound.sessionId);
  assert.equal((await feedback(missingKeyRound.sessionId)).body.source, 'fallback');
  await assert.rejects(generateFeedback({}), /gemini_not_configured/);

  try {
    require.resolve('@google/genai');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    return t.diagnostic('Gemini SDK tests require the optional SDK on Node.js 22+.');
  }

  process.env.GEMINI_API_KEY = 'test-only';
  process.env.GEMINI_MODEL = 'fixture-model';
  let responseStatus = 200;
  let networkError = false;
  let waitForAbort = false;
  const generatedFeedback = {
    evaluation: '목적지까지 잘 도착했어요!',
    comparison: '이동 순서와 수단이 기준 경로와 같아요.',
    tip: '다음에도 갈림길에서 시간과 요금을 먼저 살펴보세요.',
  };
  let generatedText = JSON.stringify(generatedFeedback);
  const payloads = [];
  const upstream = t.mock.method(global, 'fetch', async (url, options) => {
    assert.match(String(url), /generativelanguage.googleapis.com\/.*fixture-model:generateContent/);
    const request = JSON.parse(options.body);
    assert.equal(request.generationConfig.maxOutputTokens, 1536);
    assert.equal(request.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(request.generationConfig.responseJsonSchema.required, ['evaluation', 'comparison', 'tip']);
    assert.equal(request.generationConfig.responseJsonSchema.additionalProperties, false);
    assert.ok(options.signal);
    payloads.push(JSON.parse(request.contents[0].parts[0].text));
    if (waitForAbort) {
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    if (networkError) throw new TypeError('mock connection lost');
    if (responseStatus !== 200) return Response.json({ error: { code: responseStatus } }, { status: responseStatus });
    return Response.json({ candidates: [{ content: { parts: [{ text: generatedText }] } }] });
  });

  const endless = await start({});
  await move(endless.sessionId, 1);
  assert.equal((await move(endless.sessionId, 2)).result.status, 'success');
  assert.equal(upstream.mock.callCount(), 0);
  const requests = await Promise.all(Array.from({ length: 4 }, () => feedback(endless.sessionId, { usedTime: 999 })));
  assert.deepEqual(requests.map(r => r.body), Array(4).fill({ success: true, source: 'gemini', feedback: generatedFeedback }));
  assert.deepEqual((await feedback(endless.sessionId)).body, requests[0].body);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal(payloads[0].mode, 'endless');
  assert.deepEqual(payloads[0].playerMinusOptimal, { minutes: 0, fareWon: 0, staminaLeft: null });
  assert.deepEqual(payloads[0].player.steps.map(step => step.to), ['경유역', '도착역']);
  assert.equal(payloads[0].sessionId, undefined);
  assert.equal(payloads[0].graph, undefined);

  const restricted = E.cfg.levels.find(level => level.mods.subwayOff);
  first = { time: 3, cost: 150, stam: 2 };
  second = { time: 3, cost: 150, stam: 2 };
  const level = await start({ mode: 'level', levelId: restricted.id });
  await move(level.sessionId, 1);
  assert.equal((await move(level.sessionId, 2)).result.status, 'success');
  await feedback(level.sessionId);
  const playedLevel = payloads.at(-1);
  assert.equal(playedLevel.levelId, restricted.id);
  assert.equal(playedLevel.limits.subwayDisabled, true);
  assert.equal(playedLevel.event.startedByRoundEnd, true);
  assert.equal(playedLevel.mission.completed, true);
  assert.deepEqual(playedLevel.playerMinusOptimal, { minutes: 2, fareWon: 100, staminaLeft: -2 });
  assert.ok(playedLevel.stars > 0);

  for (const [quote, constraint] of [
    [{ time: 9, cost: 0, stam: 0 }, 'time'],
    [{ time: 2, cost: 301, stam: 0 }, 'fare'],
    [{ time: 2, cost: 0, stam: 11 }, 'stamina'],
  ]) {
    second = quote;
    const round = await start({ mode: 'level', levelId: restricted.id });
    assert.equal((await move(round.sessionId, 1)).result.status, 'fail');
    await feedback(round.sessionId);
    assert.deepEqual(payloads.at(-1).blockedMoveConstraints, [[constraint]]);
    assert.equal(payloads.at(-1).player.lastStation, '경유역');
  }
  const overrun = await start({});
  first = { time: 9, cost: 0, stam: 0 };
  assert.match((await move(overrun.sessionId, 1)).result.reason, /제한 시간/);
  await feedback(overrun.sessionId);
  assert.match(payloads.at(-1).failureReason, /제한 시간/);

  for (const status of [429, 503, 200]) {
    responseStatus = status;
    generatedText = ' ';
    const round = await start({});
    await giveup(round.sessionId);
    const before = upstream.mock.callCount();
    const failed = await feedback(round.sessionId);
    assert.equal(failed.body.source, 'fallback');
    assert.match(failed.body.feedback.evaluation, /도전을 멈췄어요/);
    assert.deepEqual(validateFeedback(failed.body.feedback), failed.body.feedback);
    assert.deepEqual((await feedback(round.sessionId)).body, failed.body);
    assert.equal(upstream.mock.callCount(), before + 1);
  }
  const limited = await start({});
  await giveup(limited.sessionId);
  assert.equal((await feedback(limited.sessionId)).body.source, 'fallback');
  assert.equal(upstream.mock.callCount(), 9);
  await api('simulate/retry', { sessionId: endless.sessionId });
  assert.equal((await feedback(endless.sessionId)).status, 404);

  // A new quota window lets us exercise malformed provider responses through
  // the real endpoint, including caching the fallback across repeated reads.
  const now = Date.now() + 60001;
  t.mock.method(Date, 'now', () => now);
  responseStatus = 200;
  for (const invalid of ['not JSON', '{', '{"evaluation":"좋아요."}', '{"evaluation":3,"comparison":"비교예요.","tip":"조언이에요."}']) {
    generatedText = invalid;
    const round = await start({});
    await giveup(round.sessionId);
    const before = upstream.mock.callCount();
    const failed = await feedback(round.sessionId);
    assert.equal(failed.body.source, 'fallback');
    assert.deepEqual(validateFeedback(failed.body.feedback), failed.body.feedback);
    assert.deepEqual((await feedback(round.sessionId)).body, failed.body);
    assert.equal(upstream.mock.callCount(), before + 1);
  }

  responseStatus = 404;
  await assert.rejects(generateFeedback({}), { status: 404 });
  networkError = true;
  await assert.rejects(generateFeedback({}), /mock connection lost/);

  waitForAbort = true;
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 20000);
    return timeout(10);
  });
  await assert.rejects(generateFeedback({}), { name: 'AbortError' });
  assert.ok(logs.some(line => line.includes('gemini_not_configured')));
  assert.ok(logs.some(line => line.includes('upstream_rate_limit')));
  assert.ok(logs.some(line => line.includes('gemini_empty_response')));
  assert.ok(logs.some(line => line.includes('gemini_invalid_json')));
  assert.ok(logs.some(line => line.includes('gemini_invalid_schema')));
  assert.ok(logs.some(line => line.includes('local_rate_limit')));
  assert.ok(logs.some(line => line.includes('"event":"generated"')));
  assert.ok(logs.every(line => !line.includes('test-only')));
});

test('partial failure without an optimal route has no fabricated comparison', () => {
  const result = feedbackResult({
    graph: { nodes: [{ name: '출발역' }, { name: '도착역' }], edges: [] },
    start: 0, dest: 1, cur: 0, path: [],
    result: { status: 'fail', reason: '포기했어요.', usedTime: 0, usedRes: 0 },
  });
  assert.equal(result.optimal, null);
  assert.equal(result.playerMinusOptimal, null);
  assert.equal(result.player.lastStation, result.player.start);
});
