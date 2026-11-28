'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { feedbackResult, basicFeedback } = require('../lib/feedbackResult');
const { validateFeedback, parseFeedback } = require('../lib/feedbackSchema');
const { coachFailure, logCoach } = require('../lib/coachLog');

const good = { evaluation: '목적지까지 잘 도착했어요!', comparison: '이동 순서가 기준 경로와 같아요.', tip: '다음에도 이동 시간을 먼저 확인해 보세요.' };
function session(overrides = {}) {
  const step = { from: 0, to: 1, mode: 'bus', time: 5, cost: 100, stamina: 1 };
  return {
    graph: { nodes: [{ name: '출발역' }, { name: '도착역' }], edges: [{ opts: { bus: 5, walk: 8 } }] },
    start: 0, dest: 1, cur: 1, path: [step], persona: {}, maxStamina: 5, stamSpent: 1,
    used: 5, limit: 10, resources: 200,
    result: { status: 'success', usedTime: 5, usedRes: 100, optimal: { steps: [step], time: 5, cost: 100 } },
    ...overrides,
  };
}

test('structured feedback accepts concise Korean text and rejects malformed or internal content', () => {
  assert.deepEqual(parseFeedback(JSON.stringify(good)), good);
  assert.deepEqual(validateFeedback({ ...good, tip: `  ${good.tip}  ` }), good);
  for (const input of [undefined, '', ' ', 'not JSON', '```json\n{}\n```', '{']) {
    assert.throws(() => parseFeedback(input), /gemini_(?:empty_response|invalid_json)/);
  }
  for (const value of [null, [], {}, { ...good, extra: '추가예요.' }, { ...good, tip: null },
    { ...good, tip: ['조언이에요.'] }, { ...good, comparison: ' ' }, { ...good, tip: '가'.repeat(301) },
    { ...good, tip: '한 문장이에요. 두 문장이에요. 세 문장이에요.' },
    { ...good, tip: 'usedTime을 확인해요.' }, { ...good, evaluation: '(시간/자원/체력 부족)이에요.' },
    { ...good, tip: 'Only English.' }, { ...good, evaluation: '목적지에 도착했습니다.' },
    { ...good, comparison: '기준 경로와 일치합니다.' }]) {
    assert.throws(() => validateFeedback(value), /gemini_invalid_schema/);
  }
});

test('fallback praises a clear without duplicating the result totals', () => {
  const feedback = basicFeedback(feedbackResult(session()));
  assert.match(feedback.evaluation, /잘 도착/);
  assert.match(feedback.comparison, /기준 경로와 같아요/);
  assert.doesNotMatch(Object.values(feedback).join(' '), /100원|5분|체력은 4/);
  assert.deepEqual(validateFeedback(feedback), feedback);
});

test('fallback describes an observed slower segment and mode without inventing a route', () => {
  const s = session();
  s.path = [{ from: 0, to: 1, mode: 'walk', time: 8, cost: 0, stamina: 2 }];
  s.result = { ...s.result, usedTime: 8, usedRes: 0 };
  const feedback = basicFeedback(feedbackResult(s));
  assert.match(feedback.comparison, /출발역 → 도착역.*도보.*버스.*3분 더 걸렸어요/);
  assert.match(feedback.tip, /출발역 → 도착역.*버스/);
});

test('fallback uses only confirmed causes and does not treat an unfinished trip as efficient', () => {
  for (const [constraint, phrase] of [['time', '남은 시간'], ['fare', '남은 교통비'], ['stamina', '남은 체력']]) {
    const s = session({ cur: 0, path: [], blockedBy: [[constraint]],
      result: { status: 'fail', reason: '더 이상 이동할 수 없어요. (시간/자원/체력 부족)', usedTime: 0, usedRes: 0 } });
    const data = feedbackResult(s);
    const feedback = basicFeedback(data);
    assert.ok(feedback.evaluation.includes(phrase));
    assert.doesNotMatch(JSON.stringify(feedback), /시간\/자원\/체력 부족|더 효율|절약|undefined/);
    assert.deepEqual(validateFeedback(feedback), feedback);
  }
  const mixed = session({ blockedBy: [['time'], ['fare']],
    result: { status: 'fail', reason: 'PRIVATE_ERROR', usedTime: 0, usedRes: 0 } });
  const mixedFeedback = basicFeedback(feedbackResult(mixed));
  assert.match(mixedFeedback.evaluation, /남은 조건/);
  assert.doesNotMatch(mixedFeedback.evaluation, /시간 부족|교통비 부족|PRIVATE_ERROR/);
  const unknown = session({ result: { status: 'fail', reason: 'PRIVATE_ERROR', usedTime: 0, usedRes: 0 } });
  assert.equal(basicFeedback(feedbackResult(unknown)).evaluation, '이번에는 목적지까지 도착하지 못했어요.');
  const overrun = session({ result: { status: 'fail', reason: 'PRIVATE_ERROR', usedTime: 11, usedRes: 0 } });
  assert.match(basicFeedback(feedbackResult(overrun)).evaluation, /제한 시간/);
  const givenUp = session({ cur: 0, path: [], result: { status: 'fail', reason: '포기했어요.', usedTime: 0, usedRes: 0 } });
  assert.match(basicFeedback(feedbackResult(givenUp)).evaluation, /도전을 멈췄어요/);
});

test('partial trips and absent stamina or optimal data never produce fabricated comparisons', () => {
  const s = session({ persona: null, cur: 0, path: [],
    result: { status: 'fail', usedTime: 0, usedRes: 0 } });
  const data = feedbackResult(s);
  assert.equal(data.player.staminaLeft, null);
  assert.equal(data.optimal, null);
  assert.equal(data.playerMinusOptimal, null);
  assert.match(basicFeedback(data).comparison, /기준 경로가 없어/);

  const s2 = session();
  s2.result = { ...s2.result, status: 'fail', reason: '포기했어요.' };
  const feedback = basicFeedback(feedbackResult(s2));
  assert.match(feedback.comparison, /도착 전이라 전체 효율을 비교하지는 않았어요/);
  assert.doesNotMatch(feedback.comparison, /절약|효율적/);
});

test('diagnostic logs categorize deadline, authentication, network and parser failures without secrets', t => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-secret-do-not-print';
  t.after(() => { if (previous === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previous; });
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  const error = { status: 400, message: JSON.stringify({ error: {
    code: 400, message: 'Manually set deadline 8s is too short. Minimum allowed deadline is 10s. test-secret-do-not-print https://example.invalid?key=secret',
  } }) };
  assert.deepEqual(coachFailure(error), { status: 400, reason: 'deadline_too_short' });
  logCoach('fallback', { error, source: 'fallback' });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /deadline_too_short/);
  assert.doesNotMatch(logs[0], /test-secret|https:|key=|Manually/);
  assert.deepEqual(coachFailure({ status: 400, message: JSON.stringify({ error: { details: [{ reason: 'API_KEY_INVALID' }] } }) }), { status: 400, reason: 'API_KEY_INVALID' });
  assert.equal(coachFailure({ status: 404 }).reason, 'model_or_endpoint_not_found');
  assert.equal(coachFailure({ status: 429 }).reason, 'upstream_rate_limit');
  assert.equal(coachFailure({ name: 'AbortError' }).reason, 'timeout');
  assert.equal(coachFailure({ name: 'TypeError' }).reason, 'network_error');
  assert.equal(coachFailure({ code: 'gemini_invalid_schema' }).reason, 'gemini_invalid_schema');
});
