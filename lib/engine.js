'use strict';
// 게임 핵심 규칙. 서버가 모든 판정을 담당한다 (클라이언트 값은 신뢰하지 않음).
// 무작위는 "맵 생성"에만 쓰고, 이동 시간/판정은 전부 결정적이다 → 최적해 비교가 공정하다.
const cfg = require('../routes.json');
const { PREMIUM_BY_MASK } = require('./farePolicy');
const { buildSubwayGraph } = require('./subwayGraph');

const MODE_IDS = Object.keys(cfg.modes);
const W = 1000, H = 600;

const rnd = (a, b) => a + Math.random() * (b - a);
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// 라운드별 난이도 (노드 증가 / 교통수단 추가 / 이동 제약 / 자원·시간 축소)
function roundParams(round) {
  const r = Math.max(1, round);
  return {
    cols: Math.min(4 + Math.floor((r - 1) / 2), 7),
    rows: Math.min(3 + Math.floor((r - 1) / 3), 5),
    resources: Math.max(3100, 6200 - 300 * (r - 1)),   // 이동 자금(원), 50원 단위
    slack: Math.max(1.1, 1.5 - 0.05 * (r - 1)),
    busEnabled: r >= 2,
    blockWalk: r >= 3 ? Math.min(0.1 + 0.03 * (r - 3), 0.3) : 0,
    minHops: 3,
  };
}

function describeRound(round) {
  const p = roundParams(round);
  const prev = round > 1 ? roundParams(round - 1) : null;
  const add = [];
  if (!prev || p.cols * p.rows > prev.cols * prev.rows) add.push('노드 증가');
  if (round === 2) add.push('교통수단 추가 (버스)');
  if (round === 3) add.push('이동 제약 (도보 불가 구간)');
  if (prev && p.resources < prev.resources) add.push('자금 감소');
  if (prev && p.slack < prev.slack) add.push('시간 여유 감소');
  return add;
}

function edgeTimes(len, p, mods) {
  const t = (m) => Math.max(1, Math.round(cfg.modes[m].base + len / cfg.modes[m].div));
  let walk = t('walk'), bus = t('bus'), subway = t('subway');
  if (mods.walkMul) walk = Math.round(walk * mods.walkMul);
  if (mods.busMul) bus = Math.round(bus * mods.busMul);
  return { walk, bus, subway };
}

function buildLegacyGraph(p, mods) {
  const { cols, rows } = p;
  const names = shuffle(cfg.stations);
  const nodes = [];
  const cw = W / cols, ch = H / rows;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const id = j * cols + i;
      const stationName = names[id].endsWith('역') ? names[id] : names[id] + '역';
      nodes.push({
        id,
        name: stationName,
        stationName: stationName,
        x: Math.round((i + 0.5) * cw + rnd(-cw * 0.22, cw * 0.22)),
        y: Math.round((j + 0.5) * ch + rnd(-ch * 0.22, ch * 0.22)),
        col: i,
      });
    }
  }
  const pairs = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * cols + i;
      if (i + 1 < cols && Math.random() < 0.92) pairs.push([a, a + 1]);
      if (j + 1 < rows && Math.random() < 0.92) pairs.push([a, a + cols]);
      if (i + 1 < cols && j + 1 < rows && Math.random() < 0.3) {
        pairs.push(Math.random() < 0.5 ? [a, a + cols + 1] : [a + 1, a + cols]);
      }
    }
  }
  const edges = pairs.map(([a, b], id) => {
    const len = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
    const tm = edgeTimes(len, p, mods);
    const opts = { walk: tm.walk, bus: null, subway: null };
    if (p.busEnabled && Math.random() < 0.65) opts.bus = tm.bus;
    if (!mods.subwayOff && Math.random() < 0.4) opts.subway = tm.subway;
    // 이동 제약: 일부 구간은 도보 불가 (탈것이 반드시 있어야 함)
    if (Math.random() < p.blockWalk) {
      opts.walk = null;
      if (p.busEnabled && opts.bus == null) opts.bus = tm.bus;
      if (opts.bus == null && opts.subway == null) opts.walk = tm.walk;
    }
    return { id, a, b, opts };
  });
  const adj = nodes.map(() => []);
  edges.forEach((e) => { adj[e.a].push(e); adj[e.b].push(e); });
  return { nodes, edges, adj };
}

// Step 2 opt-in: verified 1/6/7 station connections only.
// Keep legacy graph by default until the subway-only preview is approved.
function buildGraph(p, mods) {
  if (process.env.ROUTE_GRAPH_MODE === 'subway') {
    return buildSubwayGraph(p, mods, edgeTimes);
  }
  return buildLegacyGraph(p, mods);
}

const other = (e, n) => (e.a === n ? e.b : e.a);

// ── 요금/환승 규칙 ──
// 지하철·버스는 탈 때마다 기본요금. 직전 승차 하차 후 window분 이내에 다시 타면 환승(무료)이지만
// 환승 이동 penalty분이 추가로 든다. 도보로 오래 걸으면 window가 줄어 환승이 불가(요금 재결제)해진다.
function quote(t, mode, rem) {
  if (mode === 'walk') return { time: t, cost: 0, transfer: false };
  if (rem > 0) return { time: t + cfg.transfer.penalty, cost: 0, transfer: true };
  return { time: t, cost: cfg.modes[mode].fare, transfer: false };
}
const nextRem = (mode, time, rem) => (mode === 'walk' ? Math.max(0, rem - time) : cfg.transfer.window);

// ── 체력 ──  도보가 가장 힘들고 지하철이 가장 편하다. 5 단위로 양자화해 최적해 탐색 상태를 줄인다.
const SQ = 5;
function staminaCost(mode, base, persona) {
  const f = mode === 'walk' ? (persona && persona.walkMul ? persona.walkMul : 1) : mode === 'bus' ? 0.3 : 0.15;
  return Math.max(1, Math.ceil(base * f));
}
const stamUnits = (c) => Math.ceil(c / SQ);

// ── 예고형 사건 ──  출발 후 ev.at분부터 특정 수단이 느려지거나(mul) 운행 중단(off)된다.
// 판정 기준은 "출발 시각"이며 결정적이다 → 견적·서버 판정·최적 경로가 같은 규칙을 쓴다.
function timeAt(base, mode, now, ev) {
  if (base == null) return null;
  if (ev && ev.mode === mode && now >= ev.at) return ev.off ? null : Math.round(base * ev.mul);
  return base;
}

// The same transition supplies quotes, move validation and the verified route search.
function movement(g, edge, from, mode, state, persona, event) {
  if (!g.verifiedWeights) {
    const raw = edge.opts[mode], base = timeAt(raw, mode, state.used, event);
    if (base == null) return null;
    const q = quote(base, mode, state.rem);
    return { ...q, stam: persona ? staminaCost(mode, raw, persona) : 0,
      rem: nextRem(mode, q.time, state.rem) };
  }
  if ((mode === 'subway' && g.mods.subwayOff) || (mode === 'bus' && !g.busEnabled)) return null;
  const stored = g.verifiedWeights[edge.id];
  const weight = edge.a === from ? stored : stored?.reverse;
  const raw = weight?.base[mode], fare = weight?.gameFare[mode];
  if (raw == null || fare == null) return null;
  const ongoing = mode === 'subway' && state.line === edge.lineId && state.rem > 0;
  const minutes = ongoing ? weight.rideMinutes : raw;
  if (minutes == null) return null;
  const multiplier = mode === 'walk' ? g.mods.walkMul : mode === 'bus' ? g.mods.busMul : null;
  const adjusted = multiplier ? Math.round(minutes * multiplier) : minutes;
  const base = timeAt(adjusted, mode, state.used, event);
  if (base == null) return null;
  const stam = persona ? staminaCost(mode, adjusted, persona) : 0;
  if (mode === 'walk') {
    const rem = nextRem(mode, base, state.rem);
    return { time: base, cost: 0, transfer: false, stam, rem, line: null,
      paid: rem ? state.paid : 0, premium: rem ? state.premium : 0 };
  }
  const transfer = state.rem > 0 && !ongoing;
  const paidBefore = state.rem > 0 ? state.paid || 0 : 0;
  const previousPremium = state.rem > 0 ? state.premium || 0 : 0;
  if (mode === 'subway' && edge.lineId === 'S' && edge.premiumSections == null) return null;
  const premium = previousPremium | (mode === 'subway' ? edge.premiumSections || 0 : 0);
  const surcharge = PREMIUM_BY_MASK[premium] ?? null;
  if (surcharge === null) return null;
  return { time: base + (transfer ? cfg.transfer.penalty : 0),
    cost: Math.max(0, fare - paidBefore) + surcharge - PREMIUM_BY_MASK[previousPremium],
    transfer, stam, rem: cfg.transfer.window, paid: Math.max(fare, paidBefore), premium,
    line: mode === 'subway' ? edge.lineId : null };
}

function movesFrom(g, from, state, persona, event) {
  const moves = new Map();
  for (const edge of g.adj[from]) for (const mode of MODE_IDS) {
    const to = other(edge, from), key = to + ':' + mode;
    const q = movement(g, edge, from, mode, state, persona, event);
    if (!q) continue;
    const previous = moves.get(key);
    if (!previous || q.time < previous.q.time || (q.time === previous.q.time && q.cost < previous.q.cost))
      moves.set(key, { to, mode, q });
  }
  return moves;
}

class Heap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

function solveVerified(g, start, dest, budget, sp, { ev, via } = {}) {
  const initial = { node: start, used: 0, spent: 0, stamina: 0, rem: 0,
    line: null, paid: 0, premium: 0, visited: via == null || start === via };
  // Before the event, different arrival times can yield different available moves.
  const key = s => [s.node, s.spent, s.stamina, s.rem, s.line, s.paid, s.premium,
    Number(s.visited), ev ? Math.min(ev.at, s.used) : 0].join(':');
  const best = new Map([[key(initial), initial]]);
  const heap = new Heap();
  heap.push([0, initial]);
  let finish = null;
  while (heap.size) {
    const [, state] = heap.pop();
    if (finish && state.used > finish.used) break;
    if (best.get(key(state)) !== state) continue;
    if (state.node === dest) {
      if (state.visited && (!finish || state.spent < finish.spent)) finish = state;
      continue;
    }
    for (const { to, mode, q } of movesFrom(g, state.node, state, sp?.persona, ev).values()) {
      const spent = state.spent + q.cost, stamina = state.stamina + q.stam;
      if (spent > budget || (sp && stamina > sp.max)) continue;
      const next = { node: to, spent, stamina, used: state.used + q.time,
        rem: q.rem, line: q.line, paid: q.paid, premium: q.premium,
        visited: state.visited || to === via, parent: state,
        step: { from: state.node, to, mode, time: q.time, cost: q.cost, stamina: q.stam, transfer: q.transfer } };
      const id = key(next);
      if ((best.get(id)?.used ?? Infinity) <= next.used) continue;
      best.set(id, next);
      heap.push([next.used, next]);
    }
  }
  if (!finish) return null;
  const steps = [];
  for (let state = finish; state.parent; state = state.parent) steps.push(state.step);
  return { time: finish.used, cost: finish.spent, steps: steps.reverse() };
}

// 자금 R(원) 이하로 시작→도착 최소 시간. 상태: 노드 × 사용 자금(50원 단위) × 환승 가능 잔여시간
let pool = new Float32Array(0);
// x.ev: 예고형 사건, x.via: 반드시 들러야 하는 노드(심부름)
function solveOptimal(g, start, dest, R, sp, x = {}) {
  if (g.verifiedWeights) return solveVerified(g, start, dest, R, sp, x);
  const N = g.nodes.length, U = Math.floor(R / 50), Wn = cfg.transfer.window;
  const persona = sp ? sp.persona : null;
  const SU = sp ? Math.floor(sp.max / SQ) : 0;
  const ev = x.ev || null, via = x.via == null ? -1 : x.via, V = via < 0 ? 1 : 2;
  const key = (n, u, w, st, v) => (((n * (U + 1) + u) * (Wn + 1) + w) * (SU + 1) + st) * V + v;
  const size = N * (U + 1) * (Wn + 1) * (SU + 1) * V;
  if (pool.length < size) pool = new Float32Array(size);   // 버퍼 재사용 (요청마다 수십 MB 할당 방지)
  const dist = pool.subarray(0, size).fill(Infinity), prev = new Map();
  const heap = new Heap();
  dist[key(start, 0, 0, 0, 0)] = 0;
  heap.push([0, start, 0, 0, 0, 0]);
  const endings = [];
  while (heap.size) {
    const [d, n, u, w, st, v] = heap.pop();
    if (d > dist[key(n, u, w, st, v)]) continue;
    if (n === dest) { if (via < 0 || v === 1) endings.push({ k: key(n, u, w, st, v), d, u, st }); continue; }
    for (const e of g.adj[n]) {
      const to = other(e, n);
      for (const m of MODE_IDS) {
        const raw = e.opts[m], base = timeAt(raw, m, d, ev);
        if (base == null) continue;
        const q = quote(base, m, w);
        const nu = u + q.cost / 50;
        if (nu > U) continue;
        const sc = sp ? staminaCost(m, raw, persona) : 0;
        const nst = st + (sp ? stamUnits(sc) : 0);
        if (nst > SU) continue;
        const nv = v || (to === via ? 1 : 0);
        const nw = nextRem(m, q.time, w), nk = key(to, nu, nw, nst, nv), nd = d + q.time;
        if (nd < dist[nk]) {
          dist[nk] = nd;
          prev.set(nk, { from: key(n, u, w, st, v), step: { from: n, to, mode: m, time: q.time, cost: q.cost, transfer: q.transfer, stamina: sc } });
          heap.push([nd, to, nu, nw, nst, nv]);
        }
      }
    }
  }
  if (!endings.length) return null;
  endings.sort((x, y) => x.d - y.d || x.u - y.u);
  const best = endings[0], steps = [];
  for (let k = best.k; prev.has(k); k = prev.get(k).from) steps.unshift(prev.get(k).step);
  return { time: best.d, cost: best.u * 50, steps };
}

function hopDistance(g, s, d) {
  const dist = new Array(g.nodes.length).fill(-1);
  dist[s] = 0;
  const q = [s];
  while (q.length) {
    const n = q.shift();
    for (const e of g.adj[n]) {
      const t = other(e, n);
      if (dist[t] < 0) { dist[t] = dist[n] + 1; q.push(t); }
    }
  }
  return dist[d];
}

// scenario: 캠페인 또는 레벨 정의. persona가 있으면 체력 시스템이 켜진다.
function* roundCandidates({ round = 1, scenario = null, verified = false, storedGraphs = null, maxGraphs = 300, checkBudget = () => {} }) {
  const sc = scenario;
  const p = roundParams(sc ? sc.round : round);
  const mods = sc ? sc.mods || {} : {};
  if (mods.slack) p.slack = mods.slack;
  let persona = sc && sc.persona ? cfg.personas[sc.persona] : null;
  if (persona && sc.stamDelta) persona = { ...persona, stamina: persona.stamina + sc.stamDelta };
  const sp = persona ? { max: persona.stamina, persona } : null;
  const R = p.resources + ((sc && sc.bonusMoney) || 0);
  if (!verified && process.env.ROUTE_GRAPH_MODE === 'subway' && sc && sc.event && sc.event.mode === 'subway' && sc.event.off) {
    throw new Error('subway graph preview cannot run subway shutdown events without verified alternate transport routes');
  }
  for (let attempt = 0; attempt < (storedGraphs?.length ?? maxGraphs); attempt++) {
    checkBudget();
    const g = storedGraphs ? storedGraphs[attempt] : verified ? buildSubwayGraph(p, mods, null) : buildGraph(p, mods);
    if (verified) {
      g.mods = mods;
      g.busEnabled ??= p.busEnabled || !!mods.subwayOff;
      if (!storedGraphs) {
        g.verifiedWeights = new Array(g.edges.length).fill(null);
      }
    }
    const starts = g.startCandidates ? g.startCandidates.map(id => g.nodes[id]) : g.nodes.filter((n) => n.col === 0);
    const dests = g.destCandidates ? g.destCandidates.map(id => g.nodes[id]) : g.nodes.filter((n) => n.col === p.cols - 1);
    const endpointPairs = verified && !storedGraphs
      ? shuffle(starts.flatMap(start => dests.map(dest => [start.id, dest.id])))
      : [[starts[Math.floor(Math.random() * starts.length)].id, dests[Math.floor(Math.random() * dests.length)].id]];
    const pairs = endpointPairs.filter(([start, dest]) => hopDistance(g, start, dest) >= p.minHops);
    if (!pairs.length) continue;
    for (let pass = 0; pass < (verified && !storedGraphs ? 2 : 1); pass++) {
      if (verified && !storedGraphs) yield { graph: g, alternatives: pass === 1 };
      for (const [start, dest] of pairs) {
        checkBudget();
        const plain = solveOptimal(g, start, dest, R, sp);
        if (!plain) continue;
        // 사건 시각은 사건 없는 최적 시간의 일정 비율 지점
        const event = sc && sc.event ? { ...sc.event, at: Math.max(5, Math.round(plain.time * sc.event.frac)) } : null;
        let opt = event ? solveOptimal(g, start, dest, R, sp, { ev: event }) : plain;
        if (!opt) continue;
        // 심부름: 최적 경로 밖의 역 중, 들르면 5~60% 더 걸리는 곳
        let errand = null;
        if (sc && sc.errand) {
          const on = new Set([start, dest, ...opt.steps.map((x) => x.to)]);
          const candidates = g.nodes.filter(n => !on.has(n.id));
          for (const c of storedGraphs ? candidates : shuffle(candidates).slice(0, 8)) {
            const o = solveOptimal(g, start, dest, R, sp, { ev: event, via: c.id });
            if (o && o.time >= opt.time * 1.05 && o.time <= opt.time * 1.6) { errand = { ...sc.errand, node: c.id }; opt = o; break; }
          }
          if (!errand) continue;
        }
        if (sc && sc.startName) {
          g.nodes[start].name = sc.startName;
          g.nodes[dest].name = sc.destName;
          g.nodes[dest].stationName = sc.destName;
        }
        return {
          graph: g, start, dest, params: p, opt, event, errand,
          limit: Math.ceil(opt.time * p.slack),
          resources: R, persona, maxStamina: persona ? persona.stamina : 0,
        };
      }
    }
  }
  if (verified || storedGraphs) return null;
  throw new Error('round generation failed');
}

function newRound(options) {
  return roundCandidates(options).next().value;
}

function gradeOf(eff) {
  if (eff >= 0.95) return 'A+';
  if (eff >= 0.85) return 'A';
  if (eff >= 0.7) return 'B';
  if (eff >= 0.5) return 'C';
  return 'D';
}

// ── 레벨 별 목표 (독립 목표 3개) ──
// ★1 제한 시간 내 도착 / ★2 목표 시간 이내 / ★3 자금 또는 체력 절약.
// 목표는 최적 경로에서 도출하므로, 최적 경로는 항상 별 3개를 모두 받을 수 있다.
function levelGoals(opt, limit, resources, maxStamina, persona, errand) {
  return { ...resGoals(opt, limit, resources, maxStamina, persona), errand: !!errand };
}
function resGoals(opt, limit, resources, maxStamina, persona) {
  const time = Math.min(limit, Math.ceil(opt.time + (limit - opt.time) / 2));
  const optStam = opt.steps.reduce((a, x) => a + (x.stamina || 0), 0);
  if (persona && (persona.walkMul > 1 || persona.stamina < 100)) {
    let max = optStam + 10;
    if (max >= maxStamina) max = optStam;
    return { time, kind: 'stamina', max };
  }
  let max = opt.cost + 1500;
  if (max >= resources) max = opt.cost;
  return { time, kind: 'money', max };
}
// 심부름이 있는 레벨은 ★2가 "목표 시간" 대신 "심부름 완료"
function evalGoals(goals, status, used, spent, stamUsed, errandDone) {
  const arrive = status === 'success';
  const time = arrive && (goals.errand ? !!errandDone : used <= goals.time);
  const res = arrive && (goals.kind === 'money' ? spent : stamUsed) <= goals.max;
  return { stars: arrive ? 1 + (time ? 1 : 0) + (res ? 1 : 0) : 0, hit: { arrive, time, res } };
}

// 내 경로가 최적 경로와 처음으로 갈라진 지점 → 힌트
function divergenceHint(g, mine, opt) {
  for (let i = 0; i < opt.steps.length; i++) {
    const o = opt.steps[i], m = mine[i];
    if (!m) {
      return `${g.nodes[o.from].name}에서 ${cfg.modes[o.mode].name}(으)로 ${g.nodes[o.to].name}까지 계속 갔어야 했어요.`;
    }
    if (m.to !== o.to || m.mode !== o.mode) {
      return `${g.nodes[o.from].name}에서 ${cfg.modes[o.mode].name}(으)로 ${g.nodes[o.to].name} 방향을 선택하는 게 좋았어요.`;
    }
  }
  return '최적 경로와 같은 방향이었어요.';
}

module.exports = { roundCandidates, movesFrom, timeAt, staminaCost, levelGoals, evalGoals, quote, nextRem, cfg, MODE_IDS, roundParams, describeRound, newRound, solveOptimal, gradeOf, divergenceHint, other };
