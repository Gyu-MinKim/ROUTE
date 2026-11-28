'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./lib/engine');
const { generateFeedback } = require('./lib/llm');
const { feedbackResult, basicFeedback } = require('./lib/feedbackResult');
const { logCoach } = require('./lib/coachLog');
const { network: subwayNetwork } = require('./lib/subwayNetwork');
const F = require('./lib/farePolicy');
const { newSegmentRound } = require('./lib/segmentRounds');
const { newStoredRound, VerifiedRoundError } = require('./lib/verifiedRounds');

// Node.js 20.12+ 환경에서는 프로젝트 루트의 .env를 자동으로 읽는다.
// 구버전 Node.js/배포 환경에서는 KAKAO_REST_API_KEY 환경변수를 직접 설정하면 된다.
let coachEnvFile = 'loader_unavailable';
if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(path.join(__dirname, '.env')); coachEnvFile = 'loaded'; }
  catch (e) { if (e.code !== 'ENOENT') throw e; coachEnvFile = 'absent'; }
}
logCoach('configuration', { envFile: coachEnvFile });

const stationCoordinates = new Map();
for (const { stationName, lat, lng } of Object.values(subwayNetwork.stations)) {
  // Ambiguous station names require an explicit station ID or coordinates.
  stationCoordinates.set(stationName, stationCoordinates.has(stationName) ? null : { lat, lng });
}

const PORT = process.env.PORT || 3000;
const HISTORY = path.join(__dirname, 'data', 'game_history.json');
const sessions = new Map();
const TTL = 60 * 60 * 1000;

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Legacy endpoints explicitly report that routing is offline.
app.get('/api/kakao/status', (req, res) => res.json({ configured: false, source: 'json' }));
app.get('/api/kakao/transit', (req, res) => res.status(410).json({ error: 'routing_offline' }));

app.get('/api/kakao/weights', async (req, res) => {
  const s = sessions.get(req.query.sessionId);
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  s.touched = Date.now();
  if (req.query.format === 'archive') return res.status(422).json({ error: 'live_session_required' });
  let edges = s.graph.edges;
  if (req.query.edgeId !== undefined) {
    const input = String(req.query.edgeId);
    if (!/^\d+$/.test(input)) return res.status(400).json({ error: 'invalid_edge_id' });
    const edge = edges.find(e => e.id === Number(input));
    if (!edge) return res.status(404).json({ error: 'edge_not_found' });
    edges = [edge];
  }
  try {
    const results = edges.map(edge => s.baseWeights[edge.id] ?? null);
    res.json({sessionId:s.id, direction:'both', total:s.graph.edges.length,
      loaded:s.baseWeights.filter(Boolean).length, baseWeights:results,
      farePolicy: { adultCardBase: F.ADULT_CARD_BASE, seoulBusTypes: F.SEOUL_BUS_CARD,
        shinbundangAdditional: F.SHINBUNDANG_EXTRA }, appliedToGame:!!s.graph.verifiedWeights});
  } catch (error) {
    console.error('baseWeights load failed:', error);
    res.status(500).json({error:'weights_load_failed'});
  }
});

// ── 기록 파일: 없거나 깨져도 빈 기록으로 시작 (재시작/초기화 안전) ──
function readHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
    return Array.isArray(h) ? h : [];
  } catch { return []; }
}
function appendHistory(rec) {
  try {
    const h = readHistory();
    h.push(rec);
    fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
    fs.writeFileSync(HISTORY, JSON.stringify(h.slice(-500)));
  } catch (e) { console.warn('history write failed:', e.message); }
}

function quotesFor(s) {
  const entries = E.movesFrom(s.graph, s.cur, s, s.persona, s.event);
  return Object.fromEntries([...entries].map(([key, { q: { time, cost, transfer, stam } }]) =>
    [key, { time, cost, transfer, stam }]));
}

// vague(시각 미상) 사건은 시작되기 전까지 정확한 시각을 숨긴다
function eventView(s) {
  const ev = s.event;
  if (!ev) return null;
  const active = s.used >= ev.at;
  return { icon: ev.icon, title: ev.title, text: ev.text, mode: ev.mode, off: !!ev.off, mul: ev.mul || null, active, at: ev.vague && !active ? null : ev.at };
}

function publicState(s) {
  const g = s.graph;
  return {
    sessionId: s.id, mode: s.mode, round: s.round, scenario: s.scenario && {
      id: s.scenario.id, title: s.scenario.title, text: s.scenario.text, tags: s.scenario.tags,
    },
    levelId: s.levelId || null, goals: s.goals || null,
    realMapEnabled: Boolean(g.verifiedWeights && g.nodes.every(node => node.stationId)),
    usesSegmentTimes: g.graphSource === 'verified-segments',
    subwayPreview: g.graphSource === 'verified-subway-topology' && !g.verifiedWeights,
    event: eventView(s), errand: s.errand ? { ...s.errand, done: s.errandDone } : null,
    week: s.weekId ? { weekId: s.weekId, day: s.scenario.day, name: s.scenario.name } : null,
    stamina: s.persona ? { left: s.maxStamina - s.stamSpent, max: s.maxStamina } : null,
    nodes: g.nodes.map(({ id, name, stationName, stationId, x, y, lat, lng, lineIds, isTransfer, isTransferWithinNetwork }) => {
      const point = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : stationCoordinates.get(stationName);
      return { id, name, stationName, stationId, x, y, ...point, lineIds, isTransfer, isTransferWithinNetwork };
    }),
    edges: g.edges.map(({ id, a, b, opts, lineId, weightSource, directionalOpts }) => ({ id, a, b, opts, lineId, weightSource, directionalOpts })),
    start: s.start, dest: s.dest, cur: s.cur,
    limit: s.limit, used: s.used, resources: s.resources, resLeft: s.resources - s.spent,
    path: s.path, status: s.status, rem: s.rem, quotes: quotesFor(s), transfer: E.cfg.transfer,
    added: E.describeRound(s.round),
  };
}

function finish(s, status, reason, blockedBy) {
  s.status = status;
  const opt = s.opt;
  const eff = status === 'success' ? Math.min(1, opt.time / s.used) : 0;
  const grade = status === 'success' ? E.gradeOf(eff) : '-';
  const result = {
    status, reason, grade,
    ...(s.goals ? E.evalGoals(s.goals, status, s.used, s.spent, s.stamSpent, s.errandDone) : { stars: null, hit: null }),
    efficiency: Math.round(eff * 100),
    usedTime: s.used, usedRes: s.spent, limit: s.limit,
    checks: {
      arrived: status === 'success',
      inTime: status === 'success' && s.used <= s.limit,
      efficient: eff >= 0.8,
    },
    errandDone: s.errand ? s.errandDone : null,
    story: status !== 'success' ? null : s.errand ? (s.errandDone ? s.errand.done : s.errand.skipped) : null,
    optimal: opt,
    hint: E.divergenceHint(s.graph, s.path, opt),
  };
  s.result = result;
  s.blockedBy = blockedBy;
  const w = s.weekId && weeks.get(s.weekId);
  if (w && w.day === s.scenario.day) w.pending = { status, left: s.resources - s.spent, errandDone: !!s.errandDone };
  appendHistory({
    at: new Date().toISOString(), mode: s.mode, round: s.round, scenario: s.scenario ? s.scenario.id : null,
    level: s.levelId || null, stars: result.stars,
    status, grade, efficiency: result.efficiency, time: s.used, res: s.spent,
  });
  return result;
}

// 남은 시간·자금 안에 더 이동할 수 있는 간선이 있는지
function blockedMoves(s) {
  const left = s.limit - s.used, money = s.resources - s.spent, stam = s.maxStamina - s.stamSpent;
  const reasons = [];
  for (const q of Object.values(quotesFor(s))) {
    const constraints = [];
    if (q.time > left) constraints.push('time');
    if (q.cost > money) constraints.push('fare');
    if (s.persona && q.stam > stam) constraints.push('stamina');
    if (!constraints.length) return null;
    reasons.push(constraints);
  }
  return reasons;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.touched > TTL) sessions.delete(k);
  for (const [k, v] of weeks) if (now - v.touched > 6 * TTL) weeks.delete(k);
}, 10 * 60 * 1000).unref();

app.get('/api/routes', (req, res) => {
  res.json({
    modes: E.cfg.modes, personas: E.cfg.personas,
    levels: E.cfg.levels.map(({ id, title, text, persona, weather, tags, mods, event, errand }) => ({
      id, title, text, persona, weather, tags, slack: mods.slack || null, subwayOff: !!mods.subwayOff,
      event: event ? `${event.icon} ${event.title} 예고` : null, errand: errand ? `${errand.icon} ${errand.goal}` : null,
    })),
    scenarios: E.cfg.scenarios.map(({ id, title, text, tags }) => ({ id, title, text, tags })) });
});

// ── 일주일 등교 캠페인 ──  하루의 결과(저금·지각·친구 도움)가 다음 날로 이어진다.
// 하루 결과는 "다음 날" 요청 때 확정한다 → 그 전까지는 같은 지도 재도전 가능.
const weeks = new Map();
const DAYS = E.cfg.week;

function weekScenario(w, choice) {
  const d = DAYS[w.day - 1];
  const sc = { ...d, id: 'week' + d.day, startName: '집', destName: '광운대역', tags: [] };
  if (w.lastLate) { sc.stamDelta = -15; sc.tags.push('😮‍💨 어제 뛰어서 체력 -15'); }
  if (d.umbrella) {
    if (choice === 'umbrella' && !w.umbrella && w.savings >= d.umbrella) { w.umbrella = true; w.savings -= d.umbrella; }
    if (w.umbrella) { sc.event = null; sc.tags.push('☂ 우산 있음 (소나기 영향 없음)'); }
  }
  if (d.day === 4 && sc.event) {
    if (w.helped) sc.tags.push('📱 민수의 제보로 지연 시각을 안다');
    else sc.event = { ...sc.event, vague: true };
  }
  if (d.day === 5 && w.savings > 0) { sc.bonusMoney = w.savings; sc.tags.push(`🐷 저금 ₩${w.savings.toLocaleString('ko-KR')} 보탬`); }
  return sc;
}

function weekView(w) {
  const done = w.day > DAYS.length;
  const v = { weekId: w.id, day: w.day, savings: w.savings, late: w.late, helped: w.helped, log: w.log, done, today: null, ending: null };
  if (done) {
    const on = DAYS.length - w.late;
    v.ending = on === DAYS.length ? { title: '🏆 완벽한 일주일', text: '닷새 모두 제시간에 도착했다. 교수님도 얼굴을 기억하기 시작했다.' }
      : on >= 3 ? { title: '🙂 무난한 일주일', text: `${on}일은 제시간에 도착했다. 다음 주엔 조금 더 일찍 나서 보자.` }
        : { title: '😵 험난한 일주일', text: `지각 ${w.late}번… 주말에 푹 쉬고 다음 주에 다시 도전하자.` };
    if (w.helped) v.ending.text += ' 민수와는 꽤 친해졌다.';
    return v;
  }
  const d = DAYS[w.day - 1], notes = [];
  if (w.lastLate) notes.push('😮‍💨 어제 지각해서 뛰었더니 피곤하다. (체력 -15)');
  if (d.day === 4) notes.push(w.helped ? '📱 민수: "교재 고마웠어! 오늘 집회 때문에 버스 막히는 시각 알려줄게."' : '📻 오늘 집회로 버스가 막힌다는데, 정확한 시각은 알 수 없다.');
  if (d.day === 5 && w.late >= 2) notes.push('😨 이번 주 지각이 벌써 여러 번… 오늘은 정말 늦으면 안 된다.');
  if (d.day === 5 && w.savings > 0) notes.push(`🐷 모아 둔 저금 ₩${w.savings.toLocaleString('ko-KR')}을 오늘 교통비에 보탠다.`);
  if (d.umbrella && w.umbrella) notes.push('☂ 우산을 챙겼다.');
  v.today = {
    day: d.day, name: d.name, title: d.title, text: d.text, notes,
    errand: d.errand ? d.errand.ask : null, event: d.event && !(d.umbrella && w.umbrella) ? `${d.event.icon} ${d.event.title} 예고` : null,
    choice: d.umbrella && !w.umbrella ? { id: 'umbrella', label: `☂ 우산 사기 (저금 ₩${d.umbrella.toLocaleString('ko-KR')})`, price: d.umbrella, ok: w.savings >= d.umbrella } : null,
  };
  return v;
}

app.post('/api/week/start', (req, res) => {
  const w = { id: crypto.randomUUID(), day: 1, savings: 0, late: 0, helped: false, umbrella: false, lastLate: false, log: [], pending: null, touched: Date.now() };
  weeks.set(w.id, w);
  res.json(weekView(w));
});

// 오늘 결과를 확정하고 다음 날로
app.post('/api/week/next', (req, res) => {
  const w = weeks.get((req.body || {}).weekId);
  if (!w) return res.status(404).json({ error: 'week_not_found' });
  if (w.day > DAYS.length) return res.json(weekView(w));
  if (!w.pending) return res.status(409).json({ error: 'day_not_finished' });
  const d = DAYS[w.day - 1], p = w.pending, ok = p.status === 'success';
  const saved = ok && d.day < DAYS.length ? Math.min(1500, Math.floor(p.left / 2 / 50) * 50) : 0;   // 남긴 교통비의 절반(최대 1,500원)을 저금
  if (d.day === DAYS.length) w.savings = 0;   // 금요일엔 저금을 털어 썼다
  w.savings += saved;
  if (!ok) w.late += 1;
  w.lastLate = !ok;
  if (d.errand && ok && p.errandDone) w.helped = true;
  w.log.push({ day: d.day, name: d.name, ok, saved, errand: d.errand ? !!(ok && p.errandDone) : null });
  w.day += 1; w.pending = null; w.touched = Date.now();
  res.json(weekView(w));
});

app.get('/api/history', (req, res) => {
  const h = readHistory();
  res.json({ plays: h.length, clears: h.filter((x) => x.status === 'success').length,
    bestRound: h.reduce((m, x) => (x.mode === 'endless' && x.status === 'success' ? Math.max(m, x.round) : m), 0) });
});

app.post('/api/simulate/start', async (req, res) => {
  const { mode = 'endless', scenarioId, levelId } = req.body || {};
  let round = Number(req.body && req.body.round) || 1;
  if (!['endless', 'campaign', 'level', 'week'].includes(mode)) return res.status(400).json({ error: 'invalid_mode' });
  if (!Number.isInteger(round) || round < 1 || round > 30) return res.status(400).json({ error: 'invalid_round' });
  let scenario = null;
  if (mode === 'campaign') {
    scenario = E.cfg.scenarios.find((s) => s.id === scenarioId);
    if (!scenario) return res.status(400).json({ error: 'invalid_scenario' });
    round = 1;
  }
  if (mode === 'level') {
    scenario = E.cfg.levels.find((l) => l.id === levelId);
    if (!scenario) return res.status(400).json({ error: 'invalid_level' });
    round = scenario.round;
  }
  let week = null, weekDraft = null;
  if (mode === 'week') {
    week = weeks.get((req.body || {}).weekId);
    if (!week) return res.status(404).json({ error: 'week_not_found' });
    if (week.day > E.cfg.week.length) return res.status(409).json({ error: 'week_over' });
    week.touched = Date.now();
    weekDraft = { ...week };
    scenario = weekScenario(weekDraft, (req.body || {}).choice);
    round = scenario.round;
  }
  const subwayMode = process.env.ROUTE_GRAPH_MODE === 'subway';
  const useStored = subwayMode && process.env.ROUTE_WEIGHT_SOURCE === 'stored';
  let r;
  try {
    if (useStored) {
      const file = process.env.ROUTE_VERIFIED_ROUNDS_FILE || path.join(__dirname, 'data', 'verifiedRounds.json');
      r = await newStoredRound(file, { mode, round, scenario });
    } else if (subwayMode) {
      const file = process.env.ROUTE_SEGMENTS_FILE || path.join(__dirname, 'data', 'commuteSegments.json');
      r = await newSegmentRound(file, round, scenario);
    } else r = E.newRound({ round, scenario });
  } catch (error) {
    if (res.destroyed) return;
    if (error instanceof VerifiedRoundError)
      return res.status(error.status).json({ error: error.message, upstreamStatus: error.upstreamStatus });
    if (subwayMode) {
      console.warn('Verified round generation failed:', error.message);
      return res.status(422).json({ error: 'verified_map_generation_failed' });
    }
    throw error;
  }
  if (week) {
    if (week.day !== weekDraft.day) return res.status(409).json({ error: 'week_day_changed' });
    if (weekDraft.umbrella && !week.umbrella) {
      week.umbrella = true;
      week.savings = weekDraft.savings;
    }
  }
  const init = {
    mode, round, scenario, graph: r.graph, start: r.start, dest: r.dest, limit: r.limit, resources: r.resources, opt: r.opt,
    levelId: mode === 'level' ? scenario.id : null, persona: r.persona, maxStamina: r.maxStamina,
    goals: mode === 'level' ? E.levelGoals(r.opt, r.limit, r.resources, r.maxStamina, r.persona, r.errand) : null,
    event: r.event, errand: r.errand, weekId: week ? week.id : null,
  };
  res.json(publicState(openSession(init)));
});

// 맵·출발/도착·자원·제한 시간 등 불변 조건(init)은 그대로, 이동 상태만 새로 시작
function openSession(init) {
  // init은 동일 지도를 재도전할 때 공유되므로, 이미 조회한 가중치도 함께 유지된다.
  if (!init.baseWeights) init.baseWeights = init.graph.verifiedWeights || new Array(init.graph.edges.length).fill(null);
  const s = {
    ...init, init, id: crypto.randomUUID(), cur: init.start, used: 0, spent: 0, stamSpent: 0, rem: 0, path: [], errandDone: false,
    status: 'active', touched: Date.now(),
    baseWeights: init.baseWeights,
  };
  sessions.set(s.id, s);
  return s;
}

// 같은 지도 재도전: 끝난 라운드와 동일한 조건으로 새 세션을 연다
app.post('/api/simulate/retry', (req, res) => {
  const s = sessions.get((req.body || {}).sessionId);
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  if (s.status === 'active') return res.status(409).json({ error: 'round_active' });
  sessions.delete(s.id);
  res.json(publicState(openSession(s.init)));
});

// Limit new generations across sessions. Cached and concurrent reads use no quota.
const FEEDBACK_PER_MINUTE = 10;
let feedbackWindowEnd = 0;
let feedbackStarts = 0;

app.post('/api/feedback', async (req, res) => {
  const { sessionId } = req.body || {};
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId))
    return res.status(400).json({ error: 'invalid_session_id' });

  const now = Date.now();
  const s = sessions.get(sessionId);
  if (!s || now - s.touched > TTL) return res.status(404).json({ error: 'session_not_found' });
  if (!s.result) return res.status(409).json({ error: 'round_active' });
  if (!s.feedback) {
    if (now >= feedbackWindowEnd) {
      feedbackWindowEnd = now + 60_000;
      feedbackStarts = 0;
    }
    const gameResult = feedbackResult(s);
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const fallback = error => {
      logCoach('fallback', { requestId, elapsedMs: Date.now() - started, source: 'fallback', error });
      return { success: true, source: 'fallback', feedback: basicFeedback(gameResult) };
    };
    if (feedbackStarts >= FEEDBACK_PER_MINUTE) {
      s.feedback = Promise.resolve(fallback({ code: 'local_rate_limit' }));
    } else {
      feedbackStarts++;
      logCoach('request_started', { requestId });
      s.feedback = generateFeedback(gameResult, { requestId })
        .then(feedback => {
          logCoach('generated', { requestId, elapsedMs: Date.now() - started, source: 'gemini' });
          return { success: true, source: 'gemini', feedback };
        })
        .catch(fallback);
    }
  }
  res.json(await s.feedback);
});

app.post('/api/simulate/step', (req, res) => {
  const { sessionId, to, mode } = req.body || {};
  const s = sessions.get(sessionId);
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  if (s.status !== 'active') return res.status(409).json({ error: 'round_over' });
  // 입력값 검증: 인접 노드 / 존재하는 수단 / 해당 구간에서 가능한 수단 / 자원 충분
  if (!Number.isInteger(to) || !s.graph.nodes[to]) return res.status(400).json({ error: 'invalid_node' });
  if (!E.MODE_IDS.includes(mode)) return res.status(400).json({ error: 'invalid_mode' });
  if (!s.graph.adj[s.cur].some((edge) => E.other(edge, s.cur) === to))
    return res.status(400).json({ error: 'not_adjacent' });
  const move = E.movesFrom(s.graph, s.cur, s, s.persona, s.event).get(to + ':' + mode);
  if (!move) return res.status(400).json({ error: 'mode_unavailable' });
  const q = move.q;
  const { time: t, cost, stam } = q;
  if (cost > s.resources - s.spent) return res.status(400).json({ error: 'not_enough_money' });

  if (stam > s.maxStamina - s.stamSpent) return res.status(400).json({ error: 'not_enough_stamina' });

  s.touched = Date.now();
  s.stamSpent += stam;
  s.path.push({ from: s.cur, to, mode, time: t, cost, transfer: q.transfer, stamina: stam });
  Object.assign(s, { rem: q.rem, line: q.line, paid: q.paid, premium: q.premium });
  s.cur = to; s.used += t; s.spent += cost;
  if (s.errand && to === s.errand.node) s.errandDone = true;

  let result = null;
  if (s.used > s.limit) result = finish(s, 'fail', '제한 시간을 초과했어요.');
  else if (s.cur === s.dest) result = finish(s, 'success', '목적지에 도착!');
  else {
    const blockedBy = blockedMoves(s);
    if (blockedBy) result = finish(s, 'fail', '더 이상 이동할 수 없어요. (시간/자원/체력 부족)', blockedBy);
  }
  res.json({ state: publicState(s), result });
});

app.post('/api/simulate/giveup', (req, res) => {
  const s = sessions.get((req.body || {}).sessionId);
  if (!s) return res.status(404).json({ error: 'session_not_found' });
  if (s.status !== 'active') return res.status(409).json({ error: 'round_over' });
  const result = finish(s, 'fail', '포기했어요.');
  res.json({ state: publicState(s), result });
});

app.use((err, req, res, next) => { // eslint-disable-line
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`ROUTE planner: http://localhost:${PORT}`));
}
module.exports = app;
