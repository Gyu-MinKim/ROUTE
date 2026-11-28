'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/engine');
const { feedbackResult, basicFeedback, completeObjectiveFeedback } = require('../lib/feedbackResult');
const { validateFeedback } = require('../lib/feedbackSchema');
const { generateFeedback } = require('../lib/llm');

const generated = {
  evaluation: '목적지까지 잘 도착했어요! 이동을 잘 마쳤어요.',
  comparison: '기준 경로와 이동 선택을 비교해 볼 수 있어요.',
  tip: '다음에도 이동 시간을 먼저 확인해 보세요.',
};

function fixture({ hasMission = true, completed = true, arrived = true, kind = 'money', used = 8, spent = 200, stamina = 2 } = {}) {
  const nodes = ['출발역', '심부름역', '도착역'].map(name => ({ name }));
  const steps = [
    { from: 0, to: 1, mode: 'bus', time: 4, cost: 100, stamina: 1 },
    { from: 1, to: 2, mode: 'bus', time: 4, cost: 100, stamina: 1 },
  ];
  const opt = { steps, time: 8, cost: 200 };
  const errand = hasMission ? { node: 1, goal: '친구에게 빌린 노트 돌려주기' } : null;
  const persona = { stamina: kind === 'stamina' ? 50 : 100, walkMul: 1 };
  const goals = E.levelGoals(opt, 20, 2000, persona.stamina, persona, errand);
  const status = arrived ? 'success' : 'fail';
  const judgement = E.evalGoals(goals, status, used, spent, stamina, completed);
  return feedbackResult({
    mode: 'level', levelId: 6, graph: { nodes, edges: [{ opts: { bus: 4 } }] },
    start: 0, dest: 2, cur: arrived ? 2 : 1,
    path: hasMission && !completed
      ? [{ from: 0, to: 2, mode: 'bus', time: used, cost: spent, stamina }]
      : arrived ? steps : [steps[0]],
    persona, maxStamina: persona.stamina, stamSpent: stamina,
    used, limit: 20, resources: 2000, errand, goals,
    result: {
      ...judgement, status, usedTime: used, usedRes: spent, optimal: opt, errandDone: completed,
      reason: arrived ? '목적지에 도착!' : '포기했어요.',
      grade: arrived ? E.gradeOf(Math.min(1, opt.time / used)) : '-',
      checks: { arrived, inTime: arrived && used <= 20, efficient: arrived && opt.time / used >= 0.8 },
    },
  });
}

function assertValid(feedback) {
  assert.deepEqual(validateFeedback(feedback), feedback);
  assert.deepEqual(Object.keys(feedback).sort(), ['comparison', 'evaluation', 'tip']);
  assert.equal(feedback.evaluation.split(/[.!?]+(?:\s|$)/).filter(part => part.trim()).length, 2);
}

test('arrival and completed errand receive distinct positive evaluations using existing payload fields', () => {
  const data = fixture();
  assert.deepEqual(data.mission, { station: '심부름역', goal: '친구에게 빌린 노트 돌려주기', completed: true });
  assert.equal(data.stars, 3);
  assert.equal(data.goalResults.time, true);
  assert.match(data.optimal.criterion, /심부름 경유/);
  const feedback = basicFeedback(data);
  assert.match(feedback.evaluation, /목적지까지 잘 도착.*심부름역.*노트 돌려주기.*마친 점은 좋았어요/);
  assertValid(feedback);
});

test('arrival without the errand prioritizes the missing station and task over speed or price', () => {
  const data = fixture({ completed: false, used: 6, spent: 100 });
  assert.equal(data.stars, 2);
  assert.equal(data.goalResults.time, false);
  const feedback = basicFeedback(data);
  assert.match(feedback.evaluation, /목적지까지 잘 도착.*심부름역.*노트 돌려주기.*완료하지 못했어요/);
  assert.match(feedback.comparison, /심부름까지/);
  assert.match(feedback.comparison, /더 효율적이었다고 볼 수는 없어요/);
  assert.match(feedback.tip, /심부름역.*경유.*심부름 뒤 목적지/);
  assert.doesNotMatch(feedback.evaluation, /목표 시간|완벽|모든 목표/);
  assertValid(feedback);
});

test('A+ time efficiency and the efficient check never conceal a missed errand or imply three stars', () => {
  const data = fixture({ completed: false, used: 4, spent: 50 });
  assert.equal(data.grade, 'A+');
  assert.equal(data.checks.efficient, true);
  assert.equal(data.playerMinusOptimal.minutes, -4);
  assert.equal(data.playerMinusOptimal.fareWon, -150);
  assert.equal(data.stars, 2);
  const feedback = completeObjectiveFeedback(data, {
    ...generated, evaluation: '완벽하게 도착해 모든 목표를 달성했어요.',
    comparison: '더 빠르고 저렴해서 더 효율적이에요.',
  });
  assert.match(feedback.evaluation, /완료하지 못했어요/);
  assert.match(feedback.comparison, /같은 조건|조건이라/);
  assert.doesNotMatch(feedback.evaluation, /모든 목표|완벽|별 3/);
  assertValid(feedback);
});

test('completed errand remains a positive achievement even when arrival and all star goals fail', () => {
  const data = fixture({ completed: true, arrived: false, used: 4 });
  assert.equal(data.mission.completed, true);
  assert.equal(data.goalResults.time, false); // evalGoals gates this on arrival.
  assert.equal(data.stars, 0);
  const feedback = basicFeedback(data);
  assert.match(feedback.evaluation, /도착하기 전에 도전을 멈췄어요.*그래도.*노트 돌려주기.*마친 점은 좋았어요/);
  assert.match(feedback.comparison, /별점은 0개/);
  assert.doesNotMatch(feedback.evaluation, /완료하지 못|체력.*초과|교통비.*초과/);
  assertValid(feedback);
});

test('ordinary levels without missions or missed goals retain existing Gemini coaching', () => {
  const data = fixture({ hasMission: false });
  assert.equal(data.mission, null);
  assert.equal(data.goals.errand, false);
  assert.deepEqual(completeObjectiveFeedback(data, generated), generated);
  assert.doesNotMatch(JSON.stringify(basicFeedback(data)), /심부름|노트/);
  const failed = basicFeedback(fixture({ hasMission: false, arrived: false, used: 4 }));
  assert.doesNotMatch(JSON.stringify(failed), /심부름|노트|교통비.*초과|체력.*초과/);
  assert.match(failed.evaluation, /레벨 목표.*도착/);
  assertValid(failed);
});

test('ordinary additional time, money and stamina goals use engine verdicts and correct goal labels', () => {
  for (const options of [
    { hasMission: false, used: 16 },
    { hasMission: false, spent: 1800 },
    { hasMission: false, kind: 'stamina', stamina: 13 },
    { hasMission: false, used: 16, spent: 1800 },
  ]) {
    const data = fixture(options);
    const feedback = completeObjectiveFeedback(data, generated);
    if (data.goalResults.time === false) {
      assert.ok(feedback.evaluation.includes(`목표 시간 ${data.goals.time}분`));
      assert.ok(feedback.tip.includes(`${data.goals.time}분`));
    }
    if (data.goalResults.res === false) {
      assert.ok(feedback.evaluation.includes(data.goals.kind === 'money' ? '교통비 1700원' : '체력 12'));
    }
    assert.doesNotMatch(JSON.stringify(feedback), /심부름|노트/);
    assertValid(feedback);
  }
});

test('errand levels do not mistake the second star for a time goal, and retain other missed goals', () => {
  const data = fixture({ completed: true, used: 16, spent: 1800 });
  assert.equal(data.goalResults.time, true); // Even though used > goals.time.
  const feedback = basicFeedback(data);
  assert.match(feedback.evaluation, /노트 돌려주기.*좋았어요.*교통비 1700원 이하 사용/);
  assert.doesNotMatch(feedback.evaluation, /목표 시간/);
  assert.match(feedback.tip, /교통비.*1700원/);
  assertValid(feedback);
});

test('omitted or contradictory mission evaluations are corrected once without duplication or a new API call', () => {
  for (const completed of [true, false]) {
    const data = fixture({ completed });
    const feedback = completeObjectiveFeedback(data, generated);
    assert.ok(feedback.evaluation.includes(data.mission.station));
    assert.ok(feedback.evaluation.includes(data.mission.goal));
    assert.equal(feedback.evaluation.split(data.mission.goal).length - 1, 1);
    assert.deepEqual(completeObjectiveFeedback(data, feedback), feedback);
    if (completed) assert.equal(feedback.comparison, generated.comparison);
    assertValid(feedback);
  }
});

test('Gemini responses missing mission coverage are guarded in generateFeedback without extra requests', async t => {
  try { require.resolve('@google/genai'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return t.skip('Optional Gemini SDK not installed.'); }
  const previous = { ...process.env };
  t.after(() => { process.env = previous; });
  process.env.GEMINI_API_KEY = 'objective-test-only';
  process.env.GEMINI_MODEL = 'objective-fixture';
  // Observe the SDK generation boundary without mocking its implementation:
  // retries happen below this method, at the fetch/HTTP boundary.
  const { Models } = await import('@google/genai');
  const generations = t.mock.method(Models.prototype, 'generateContentInternal');
  const attempts = [];
  let responseStatus = 200;
  const upstream = t.mock.method(global, 'fetch', async (_, options) => {
    attempts.push({ status: responseStatus, body: options.body, signal: options.signal });
    const payload = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
    assert.equal(payload.mission.station, '심부름역');
    assert.equal(payload.mission.completed, false);
    assert.equal(payload.stars, 2);
    const system = JSON.parse(options.body).systemInstruction.parts.map(part => part.text).join(' ');
    assert.match(system, /goalResults.time.*심부름 완료/);
    if (responseStatus !== 200) return Response.json({ error: { code: responseStatus } }, { status: responseStatus });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(generated) }] } }] });
  });
  const data = fixture({ completed: false });
  const result = await generateFeedback(data);
  assert.equal(generations.mock.callCount(), 1, 'mission repair must not start another generation');
  assert.deepEqual(generations.mock.calls[0].arguments[0].config.httpOptions,
    { timeout: 15000, retryOptions: { attempts: 2 } }, 'test the production retry settings without replacing them');
  assert.deepEqual(attempts.map(attempt => attempt.status), [200]);
  assert.match(result.evaluation, /심부름역.*완료하지 못했어요/);
  assert.match(result.tip, /심부름역/);
  assertValid(result);

  responseStatus = 503;
  const beforeGeneration = generations.mock.callCount();
  const beforeHttp = upstream.mock.callCount();
  const fallback = await generateFeedback(data).catch(() => basicFeedback(data));
  assert.equal(generations.mock.callCount() - beforeGeneration, 1, 'a failure must not start an application-level retry');
  assert.equal(upstream.mock.callCount() - beforeHttp, 2, 'SDK must make only the initial attempt and one retry');
  const failedAttempts = attempts.slice(beforeHttp);
  assert.deepEqual(failedAttempts.map(attempt => attempt.status), [503, 503]);
  assert.equal(failedAttempts[0].body, failedAttempts[1].body);
  assert.notEqual(failedAttempts[0].signal, failedAttempts[1].signal, 'SDK creates a fresh per-attempt signal');
  assert.equal(generations.mock.callCount(), 2, 'mission repair and fallback add no extra generations');
  assert.equal(upstream.mock.callCount(), 3, 'one successful HTTP call plus a failed two-attempt generation');
  assert.match(fallback.evaluation, /노트 돌려주기.*완료하지 못했어요/);
  assertValid(fallback);
});
