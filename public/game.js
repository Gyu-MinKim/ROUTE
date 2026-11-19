'use strict';
// ROUTE 경로 플래너 — 클라이언트. 모든 판정/계산은 서버(/api)가 한다.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MODES = { subway: { name: '지하철', icon: '🚇' }, bus: { name: '버스', icon: '🚌' }, walk: { name: '도보', icon: '🚶' } };
const won = (n) => '₩' + Number(n).toLocaleString('ko-KR');
const MODE_ORDER = ['subway', 'bus', 'walk'];
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const syncUI = () => document.dispatchEvent(new Event('route:ui'));

/* ── 저장소: 실패해도(시크릿 모드/초기화) 게임은 정상 동작 ── */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const sess = {
  get(k, d) { try { const v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};
let settings = Object.assign({ dark: false, reduce: false, tut: true }, store.get('route.settings', {}));
function applySettings() {
  document.body.classList.toggle('dark', settings.dark);
  document.body.classList.toggle('reduce', settings.reduce);
  store.set('route.settings', settings);
}

async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'error'); e.code = data.error; throw e; }
    return data;
  } finally { clearTimeout(timeout); }
}

/* ── 상태 ── */
let S = null;            // 서버가 준 라운드 상태
let result = null;       // 라운드 결과
let ctx = { kind: 'endless', round: 1, scenarioId: null };
let scenarios = [], levels = [], personas = {};
const WX = { clear: '☀️', rain: '🌧️' };
const progress = () => store.get('route.progress', {});
const unlocked = (id) => id === 1 || (progress()[id - 1] || 0) > 0;
let sel = null, selMode = null;
let overlay = null;      // { opt:[steps], my:[steps] }
let deco = null;
let busy = false;
let markerPos = { x: 0, y: 0 };
let vb = { x: 0, y: 0, w: 1000, h: 600 }, anim = 0;
let replayTok = 0, paused = false, replaying = false;
let roundToken = 0;
let sessionCtx = null;
let weekBriefing = null;

/* ── 모달 ── */
let modalDismiss = null;
function modal(title, html, actions = [], options = {}) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  const box = $('#modal-actions');
  box.innerHTML = ''; box.style.flexDirection = '';
  modalDismiss = options.onDismiss || null;
  $('#modal-close').classList.toggle('hidden', options.dismissible === false);
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    b.onclick = () => { closeModal(false); a.fn && a.fn(); };
    box.appendChild(b);
  });
  $('#modal').classList.remove('hidden');
  document.dispatchEvent(new Event('route:modal'));
}
function closeModal(dismiss = true) {
  const fn = modalDismiss;
  modalDismiss = null;
  $('#modal').classList.add('hidden');
  document.dispatchEvent(new Event('route:modal-closed'));
  if (dismiss && fn) fn();
}
function notify(message) {
  const el = $('#ui-notice');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => el.classList.add('hidden'), 5500);
}
function confirmNewGame(action, continuingWeekId = null) {
  const activeRound = S && S.status === 'active';
  const pendingWeek = weekBriefing && weekBriefing.weekId !== continuingWeekId;
  if (!activeRound && !pendingWeek) return action();
  modal('진행 중인 여정을 바꿀까요?', '<p>새 게임을 시작하면 현재 판으로 돌아올 수 없어요. 완료한 레벨과 별점은 유지돼요.</p>', [
    { label: '취소' }, { label: '새 게임 시작', primary: true, fn: action },
  ]);
}
function goHome() {
  if (busy) return;
  replayTok++; replaying = false; paused = false; anim++;
  if (S) { markerPos = { x: S.nodes[S.cur].x, y: S.nodes[S.cur].y }; render(); setReplayBtn(); }
  closeModal(false);
  $('#tutorial').classList.add('hidden');
  $('#subway').classList.add('hidden');
  show('start'); refreshStats();
}

/* ── 화면 전환 / 시작 화면 ── */
function show(id) { $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id)); syncUI(); }

async function refreshStats() {
  const mine = store.get('route.plays', 0), thisSession = sess.get('plays', 0);
  let line = `이 기기 플레이 ${mine}회 · 이번 접속 ${thisSession}회`;
  try { const h = await api('/api/history'); line += ` · 전체 ${h.plays}회 (클리어 ${h.clears})`; } catch { /* 서버 기록 없어도 OK */ }
  $('#stats').textContent = line;
}

// 설정 팝업 (시작 화면의 설정 버튼 / 게임 내 ⚙ 버튼 공용)
function openSettings() {
  const row = (id, label, on) => `<label class="row"><span>${label}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}></label>`;
  modal('⚙ 설정',
    row('m-dark', '다크 모드', settings.dark) + row('m-reduce', '애니메이션 줄이기', settings.reduce) + row('m-tut', '튜토리얼 자동 표시 (게임 내)', settings.tut) +
    '<div class="reset-section"><b>이 기기의 진행 기록</b><p>완료한 레벨과 별점을 이 브라우저에 저장해요.</p><button class="btn small danger" id="m-reset">기록 초기화</button></div><div class="stats" id="m-note"></div>',
    [{ label: '닫기', primary: true }]);
  $('#m-dark').onchange = (e) => { settings.dark = e.target.checked; applySettings(); };
  $('#m-reduce').onchange = (e) => { settings.reduce = e.target.checked; applySettings(); };
  $('#m-tut').onchange = (e) => { settings.tut = e.target.checked; if (settings.tut) store.del('route.tutDone'); applySettings(); };
  $('#m-reset').onclick = () => modal('진행 기록을 지울까요?', '<p>이 기기에 저장된 레벨 해금과 별점, 플레이 횟수를 삭제해요. 삭제한 기록은 복구할 수 없어요.</p><p>화면 설정과 서버의 전체 플레이 기록은 유지돼요.</p>', [
    { label: '취소', fn: openSettings },
    { label: '기록 삭제', danger: true, fn: () => {
      ['route.plays', 'route.progress'].forEach(store.del);
      refreshStats(); syncUI(); openSettings();
      $('#m-note').textContent = '이 기기의 진행 기록을 삭제했어요.';
    } },
  ], { onDismiss: openSettings });
}

/* ── 지도 뷰 (viewBox 줌 애니메이션) ── */
const map = $('#map');
const WORLD = { x: -500, y: -300, w: 2000, h: 1200 };   // 지도 바깥 여백 (축소 시 보이는 영역)
function setVB() {
  map.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const px = Math.min(map.clientWidth / vb.w, map.clientHeight / vb.h);   // 화면px / 지도단위
  const bar = $('#scale-bar'); if (bar) bar.style.width = Math.max(20, Math.min(160, 200 * px)) + 'px';
  if (typeof placeModes === 'function') placeModes();
}
function clampVB() {
  vb.w = Math.min(WORLD.w, Math.max(250, vb.w)); vb.h = vb.w * 0.6;
  vb.x = Math.min(WORLD.x + WORLD.w - vb.w, Math.max(WORLD.x, vb.x));
  vb.y = Math.min(WORLD.y + WORLD.h - vb.h, Math.max(WORLD.y, vb.y));
}
// 마우스 휠: 커서 위치 기준 확대/축소 / 드래그: 이동 / 더블클릭: 전체 보기
function svgPoint(ev) { const p = map.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; return p.matrixTransform(map.getScreenCTM().inverse()); }
const wrap = $('.map-wrap');
wrap.addEventListener('wheel', (ev) => {
  ev.preventDefault(); anim++;
  const f = ev.deltaY > 0 ? 1.15 : 1 / 1.15, p = svgPoint(ev);
  vb.x = p.x - (p.x - vb.x) * f; vb.y = p.y - (p.y - vb.y) * f; vb.w *= f; vb.h *= f;
  clampVB(); setVB();
}, { passive: false });
let drag = null, dragged = false, pinch = null;
const ptrs = new Map();   // 터치/마우스 포인터 (두 손가락 핀치 줌 지원)
const dist2 = () => { const [a, b] = [...ptrs.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
wrap.addEventListener('pointerdown', (ev) => {
  if (ev.target.closest('button') || replaying || busy) return;
  anim++; ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    pinch = { d0: dist2(), vb0: { ...vb }, p: svgPoint({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 }) };
    drag = null; dragged = true;
  } else if (ptrs.size === 1) { drag = { x: ev.clientX, y: ev.clientY, vx: vb.x, vy: vb.y }; dragged = false; }
});
window.addEventListener('pointermove', (ev) => {
  if (ptrs.has(ev.pointerId)) ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
  if (pinch && ptrs.size >= 2) {
    const f = Math.min(4, Math.max(0.25, pinch.d0 / Math.max(1, dist2())));
    vb.w = pinch.vb0.w * f; vb.h = pinch.vb0.h * f;
    vb.x = pinch.p.x - (pinch.p.x - pinch.vb0.x) * f; vb.y = pinch.p.y - (pinch.p.y - pinch.vb0.y) * f;
    clampVB(); setVB(); return;
  }
  if (!drag) return;
  const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
  if (!dragged && Math.hypot(dx, dy) < 6) return;
  dragged = true; wrap.classList.add('dragging');
  const u = 1 / Math.min(map.clientWidth / vb.w, map.clientHeight / vb.h);
  vb.x = drag.vx - dx * u; vb.y = drag.vy - dy * u;
  clampVB(); setVB();
});
const endPtr = (ev) => {
  ptrs.delete(ev.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (ptrs.size === 0) { drag = null; wrap.classList.remove('dragging'); setTimeout(() => { dragged = false; }, 50); }
};
window.addEventListener('pointerup', endPtr);
window.addEventListener('pointercancel', endPtr);

/* ── 정보 패널 접기/펴기 (지도 제외) ── */
const mobile = () => window.matchMedia('(max-width:800px)').matches;
function setCollapsed(id, on) { const el = document.getElementById(id); if (el) { el.classList.toggle('collapsed', on); el.querySelector('.panel-title')?.setAttribute('aria-expanded', String(!on)); } }
$$('aside .panel-title').forEach((t) => { t.onclick = () => setCollapsed(t.parentElement.id, !t.parentElement.classList.contains('collapsed')); });
function initPanels() { setCollapsed('panel-mission', mobile()); setCollapsed('panel-log', mobile()); }
wrap.addEventListener('dblclick', (ev) => { if (ev.target.closest('button, [data-id]')) return; zoomTo(500, 300, 1, 400); });   // 역·카드 더블클릭은 전체 보기로 취급하지 않는다
$('#z-reset').onclick = () => zoomTo(500, 300, 1, 400);
window.addEventListener('resize', () => { if (S) setVB(); });
function zoomTo(cx, cy, scale, ms = 700) {
  const t = { x: cx - 500 * scale, y: cy - 300 * scale, w: 1000 * scale, h: 600 * scale };
  const id = ++anim;
  if (settings.reduce || ms <= 0) { vb = t; setVB(); return Promise.resolve(); }
  const f = { ...vb };
  return new Promise((res) => {
    const t0 = performance.now();
    (function step(now) {
      if (id !== anim) return res();
      const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      for (const p in t) vb[p] = f[p] + (t[p] - f[p]) * e;
      setVB();
      if (k < 1) requestAnimationFrame(step); else res();
    })(t0);
  });
}
function zoomBy(m) {
  const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
  const s = Math.min(2, Math.max(0.25, (vb.w / 1000) * m));
  zoomTo(cx, cy, s, 200);
}
$('#z-in').onclick = () => zoomBy(0.75);
$('#z-out').onclick = () => zoomBy(1.33);

function makeDeco() {
  const r = (a, b) => a + Math.random() * (b - a);
  const y0 = r(150, 450);
  const pts = []; for (let x = -550; x <= 1550; x += 150) pts.push([x, y0 + r(-90, 90)]);
  const river = 'M ' + pts.map((p) => p.join(' ')).join(' L ');
  const bx = r(250, 750), by = y0 + (pts.find((p) => p[0] >= bx - 150) || [0, 0])[1] - y0;
  const rect = (n, f) => Array.from({ length: n }, f);
  return {
    river, bridge: { x: bx, y: by },
    parks: rect(10, () => ({ x: r(-450, 1350), y: r(-250, 800), w: r(60, 140), h: r(50, 100) })),
    blocks: rect(46, () => ({ x: r(-450, 1400), y: r(-250, 850), w: r(24, 46), h: r(24, 56) })),
    trees: rect(40, () => ({ x: r(-450, 1450), y: r(-250, 850) })),
    roads: rect(14, (_, i) => (i % 2 ? { x1: r(-500, 1500), y1: -300, x2: r(-500, 1500), y2: 900 } : { x1: -500, y1: r(-300, 900), x2: 1500, y2: r(-300, 900) })),
  };
}

const eb = (a, b) => S.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
const adjacent = (n) => S.edges.filter((e) => e.a === n || e.b === n).map((e) => (e.a === n ? e.b : e.a));
const ln = (a, b, cls) => { const A = S.nodes[a], B = S.nodes[b]; return `<line class="edge ${cls}" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`; };

function render() {
  if (!S) return;
  const reach = S.status === 'active' ? new Set(adjacent(S.cur)) : new Set();
  let h = '';
  h += `<rect x="${WORLD.x}" y="${WORLD.y}" width="${WORLD.w}" height="${WORLD.h}" fill="var(--map)" pointer-events="none"/>`;
  h += deco.roads.map((l) => `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="var(--edge)" stroke-opacity=".35" stroke-width="10"/>`).join('');
  h += deco.parks.map((p) => `<rect class="deco-park" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="6"/>`).join('');
  h += deco.blocks.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="var(--edge)" opacity=".55" stroke="var(--line)" stroke-opacity=".3" stroke-width="2"/>`).join('');
  h += `<path class="deco-water" d="${deco.river}"/>`;
  h += `<rect x="${deco.bridge.x - 8}" y="${deco.bridge.y - 40}" width="16" height="80" fill="var(--panel)" stroke="var(--line)" stroke-width="2" opacity=".8"/>`;
  h += deco.trees.map((t) => `<circle cx="${t.x}" cy="${t.y}" r="9" fill="var(--park)" stroke="var(--line)" stroke-opacity=".4" stroke-width="2"/>`).join('');
  h += S.edges.map((e) => ln(e.a, e.b, sel != null && ((e.a === S.cur && e.b === sel) || (e.b === S.cur && e.a === sel)) ? 'hot' : '')).join('');
  if (overlay) {
    overlay.my.forEach((st) => { h += ln(st.from, st.to, 'my'); });
    overlay.opt.forEach((st) => { h += ln(st.from, st.to, 'opt'); });
  } else {
    S.path.forEach((st) => { h += ln(st.from, st.to, 'mine'); });
  }
  // 이동 가능 구간 수단 표시
  reach.forEach((n) => {
    const e = eb(S.cur, n), A = S.nodes[S.cur], B = S.nodes[n];
    // 수단별 소요 시간(분)을 구간 위에 바로 표시 → 역을 눌러 보지 않아도 비교 가능. 지금 탈 수 없는 수단은 흐리게.
    const tags = MODE_ORDER.filter((m) => S.quotes[`${n}:${m}`]).map((m) => { const q = S.quotes[`${n}:${m}`]; return `<tspan ${moveUnavailable(q) ? 'opacity=".4"' : ''}>${MODES[m].icon}${q.time}</tspan>`; }).join(' ');
    h += `<text class="mode-tag" x="${(A.x + B.x) / 2}" y="${(A.y + B.y) / 2 - 6}">${tags}</text>`;
  });
  h += S.nodes.map((n) => {
    const cls = ['node'];
    if (reach.has(n.id)) cls.push('reach');
    if (n.id === sel) cls.push('sel');
    if (n.id === S.cur) cls.push('cur');
    const reachable = reach.has(n.id);
    return `<g class="station-target" data-id="${n.id}" ${reachable ? `role="button" tabindex="0" aria-label="${escapeHtml(n.name)} 선택" aria-pressed="${n.id === sel}"` : ''}>
      <rect class="station-hit" x="${n.x - 35}" y="${n.y - 24}" width="70" height="66" rx="12"/>
      <rect class="${cls.join(' ')}" x="${n.x - 13}" y="${n.y - 13}" width="26" height="26" rx="7"/>
      <text class="label" x="${n.x}" y="${n.y + 32}">${escapeHtml(n.name)}</text></g>`;
  }).join('');
  const st = S.nodes[S.start], ds = S.nodes[S.dest];
  h += `<text x="${st.x}" y="${st.y - 22}" font-size="24" pointer-events="none" text-anchor="middle">⌂</text>`;
  h += `<text x="${ds.x}" y="${ds.y - 22}" font-size="28" pointer-events="none" text-anchor="middle">⚑</text>`;
  if (S.errand) { const en = S.nodes[S.errand.node]; h += `<text x="${en.x}" y="${en.y - 20}" font-size="26" pointer-events="none" text-anchor="middle" ${S.errand.done ? 'opacity=".45"' : ''}>${S.errand.icon}${S.errand.done ? '✔' : ''}</text>`; }
  h += `<circle id="mk" class="marker" pointer-events="none" cx="${markerPos.x}" cy="${markerPos.y}" r="11"/>`;
  map.innerHTML = h;
}

function moveMarker(a, b, ms, follow) {
  const movementToken = roundToken, replayId = replayTok;
  const mk = () => $('#mk');
  if (settings.reduce) { markerPos = { x: b.x, y: b.y }; if (mk()) { mk().setAttribute('cx', b.x); mk().setAttribute('cy', b.y); } return Promise.resolve(); }
  return new Promise((res) => {
    const t0 = performance.now();
    (function step(now) {
      if (movementToken !== roundToken || (follow && replayId !== replayTok)) return res();
      const k = Math.min(1, (now - t0) / ms);
      markerPos = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      const m = mk();
      if (m) { m.setAttribute('cx', markerPos.x); m.setAttribute('cy', markerPos.y); }
      if (follow) { vb.x = markerPos.x - vb.w / 2; vb.y = markerPos.y - vb.h / 2; setVB(); }
      if (k < 1) requestAnimationFrame(step); else res();
    })(t0);
  });
}

/* ── HUD / 하단 바 ── */
function updateHud() {
  $('#hud-time').textContent = `${Math.max(0, S.limit - S.used)}분`;
  $('#hud-res').textContent = won(S.resLeft);
  $('#hud-round').textContent = S.mode === 'campaign' ? 'C' : S.mode === 'level' ? 'L' + S.levelId : S.week ? S.week.name : S.round;
  const ev = S.event, bn = $('#event-banner');
  bn.classList.toggle('hidden', !ev); bn.classList.toggle('on', !!ev && ev.active);
  if (ev) bn.textContent = ev.active ? `${ev.icon} ${ev.title} 발생 중` : ev.at != null ? `⚠ ${Math.max(0, ev.at - S.used)}분 후 ${ev.title} (출발 ${ev.at}분부터)` : `⚠ 오늘 중 ${ev.title} 예보 (시각 미상)`;
  $('#mission-sub').innerHTML = missionSub();
  document.body.classList.toggle('has-stam', !!S.stamina);
  if (S.stamina) {
    $('#hud-stam').textContent = `${S.stamina.left} / ${S.stamina.max}`;
    $('#stam-fill').style.width = Math.max(0, 100 * S.stamina.left / S.stamina.max) + '%';
  }
  $('#log').innerHTML = S.path.map((p) => `<li>${S.nodes[p.from].name} → ${S.nodes[p.to].name} <small>(${MODES[p.mode].icon} ${p.time}분 · ${p.transfer ? '환승 무료' : won(p.cost)})</small></li>`).join('') || '<li style="list-style:none;opacity:.6">노드를 클릭해 이동하세요</li>';
}

function moveUnavailable(q) {
  if (!q) return '이 구간에 노선 없음';
  if (q.cost > S.resLeft) return `교통비 ${won(q.cost - S.resLeft)} 부족`;
  if (S.stamina && q.stam > S.stamina.left) return `체력 ${q.stam - S.stamina.left} 부족`;
  if (S.used + q.time > S.limit) return `제한 시간 ${S.used + q.time - S.limit}분 초과`;
  return '';
}
// 수단 카드 위치: 넓은 화면에서는 선택한 역 옆 팝오버, 좁은 화면(또는 좌표 계산 불가 환경)에서는 하단 바.
function placeModes() {
  const modesEl = $('.modes'), modesSlot = $('#modes-slot');
  const open = !!S && S.status === 'active' && sel != null && !busy;
  const pop = !mobile() && !wrap.classList.contains('kakao-active') && typeof map.getScreenCTM === 'function' && typeof map.createSVGPoint === 'function';
  const host = pop ? wrap : modesSlot;
  if (modesEl.parentElement !== host) host.appendChild(modesEl);
  modesEl.classList.toggle('pop', pop);
  modesEl.classList.toggle('hidden', pop && !open);
  if (!pop || !open) { modesEl.style.left = modesEl.style.top = ''; return; }
  const m = map.getScreenCTM(); if (!m) return;
  const p = map.createSVGPoint(); p.x = S.nodes[sel].x; p.y = S.nodes[sel].y;
  const s = p.matrixTransform(m), r = wrap.getBoundingClientRect();
  const x = s.x - r.left, y = s.y - r.top, w = modesEl.offsetWidth, h = modesEl.offsetHeight, gap = 26;
  const left = x + gap + w <= r.width - 8 ? x + gap : x - gap - w;   // 오른쪽에 자리가 없으면 왼쪽
  modesEl.style.left = Math.max(8, Math.min(r.width - w - 8, left)) + 'px';
  modesEl.style.top = Math.max(8, Math.min(r.height - h - 8, y - h / 2)) + 'px';
}

function updateFooter() {
  const active = S && S.status === 'active' && !busy;
  const quote = (m) => (S && sel != null ? S.quotes[`${sel}:${m}`] : null);
  $$('.mode').forEach((b) => {
    const m = b.dataset.mode, q = quote(m), reason = sel != null ? moveUnavailable(q) : '';
    const ok = active && sel != null && !reason;
    b.disabled = !ok;
    const detail = !active ? (busy ? '이동 준비 중' : '라운드 종료') : sel == null ? '역을 먼저 선택하세요' : reason || `${q.time}분 · ${q.transfer ? '환승 무료' : won(q.cost)}${S.stamina ? ` · 체력 −${q.stam}` : ''}`;
    b.innerHTML = `<span class="mode-symbol" aria-hidden="true">${MODES[m].icon}</span><span>${MODES[m].name}</span><small>${detail}</small>`;
    b.title = detail;
  });
  $('#info-xfer').textContent = S && S.status === 'active' ? (S.rem > 0 ? `환승 가능 · ${S.rem}분 이내 탑승` : '다음 대중교통 탑승 시 요금 결제') : '';
  placeModes();
  $('#btn-giveup').disabled = !active;
  $$('#game header button').forEach((b) => { b.disabled = busy; });
  $('#game').setAttribute('aria-busy', String(busy));
  syncUI();
}

/* ── 라운드 시작 ── */
const evEffect = (ev) => (ev.off ? `${MODES[ev.mode].name} 이용 불가` : `${MODES[ev.mode].name} 시간 ×${ev.mul}`);
function missionSub() {
  let h = S.scenario ? S.scenario.text : '';
  if (S.errand) h += `<div class="errand ${S.errand.done ? 'done' : ''}">${S.errand.icon} ${S.errand.goal} ${S.errand.done ? '✔' : '(지도의 ' + S.errand.icon + ' 역)'}</div>`;
  if (S.goals) h += goalsHtml(S.goals);
  return h;
}
const goalTexts = (g) => ['제한 시간 안에 도착', g.errand && S.errand ? `${S.errand.icon} ${S.errand.goal}` : `⏱ ${g.time}분 이내 도착`, g.kind === 'money' ? `💰 교통비 ${won(g.max)} 이하 사용` : `❤️ 체력 ${g.max} 이하 소모`];
function goalsHtml(g, hit) {
  const keys = ['arrive', 'time', 'res'];
  return `<ul class="goals">${goalTexts(g).map((t, i) => `<li class="${hit && hit[keys[i]] ? 'hit' : ''}">${hit ? (hit[keys[i]] ? '★' : '☆') : '★'} ${t}</li>`).join('')}</ul>`;
}

// retry=true: 같은 지도(맵·조건 동일)에서 이동 상태만 초기화해 다시 시작
async function startRound(retry) {
  if (busy) return;
  retry = retry === true && !!S;
  const token = ++roundToken;
  const requestedCtx = { ...ctx };
  busy = true; replayTok++; replaying = false;
  updateFooter();
  try {
    const next = await api(retry ? '/api/simulate/retry' : '/api/simulate/start', retry ? { sessionId: S.sessionId } : ctx.kind === 'campaign' ? { mode: 'campaign', scenarioId: ctx.scenarioId } : ctx.kind === 'level' ? { mode: 'level', levelId: ctx.levelId } : ctx.kind === 'week' ? { mode: 'week', weekId: ctx.weekId, choice: ctx.choice } : { mode: 'endless', round: ctx.round });
    if (token !== roundToken) return;
    S = next; sessionCtx = { ...ctx }; weekBriefing = null;
  } catch (e) {
    if (sessionCtx) ctx = { ...sessionCtx };
    busy = false; updateFooter();
    const expired = e.code === 'session_not_found';
    modal(expired ? '이 지도의 보관 시간이 끝났어요' : '여정을 시작하지 못했어요', `<p>${expired ? '같은 지도로 재도전할 수 없어요. 새 지도로 시작할 수 있어요.' : '연결을 확인한 뒤 다시 시도해 주세요.'}</p>`, [
      { label: '홈으로', fn: goHome },
      { label: expired ? '새 지도로 시작' : '다시 시도', primary: true, fn: () => { ctx = { ...requestedCtx }; startRound(expired ? false : retry); } },
    ]);
    return;
  }
  result = null; overlay = null; sel = null; selMode = null;
  $('#panel-result').classList.add('hidden'); $('#panel-compare').classList.add('hidden'); $('#panel-log').classList.remove('hidden');
  $('#tutorial').classList.add('hidden');
  if (!retry || !deco) deco = makeDeco();
  markerPos = { x: S.nodes[S.start].x, y: S.nodes[S.start].y };
  const d = S.nodes[S.dest];
  $('#mission').textContent = `${d.name}에 도착하기`;
  $('#mission-sub').innerHTML = missionSub();
  show('game'); initPanels(); render(); updateHud();
  vb = { x: 0, y: 0, w: 1000, h: 600 }; setVB();
  const play = Number(store.get('route.plays', 0)) + 1;
  store.set('route.plays', play); sess.set('plays', sess.get('plays', 0) + 1);
  busy = false; updateFooter();
  if (retry) { notify('같은 지도에서 다시 출발해요.'); return; }
  // One briefing per new round. Closing it is equivalent to starting play.
  modal(S.scenario ? S.scenario.title : `라운드 ${S.round}`, `<p class="briefing-route">${escapeHtml(S.nodes[S.start].name)} <span>→</span> ${escapeHtml(d.name)}</p>${S.scenario ? `<p>${escapeHtml(S.scenario.text)}</p>` : ''}<div class="chips"><span class="chip">시간 ${S.limit}분</span><span class="chip">교통비 ${won(S.resources)}</span>${S.stamina ? `<span class="chip">체력 ${S.stamina.max}</span>` : ''}</div>${S.errand ? `<p class="msg">${escapeHtml(S.errand.ask)}<br><small>${escapeHtml(S.nodes[S.errand.node].name)}에 들러주세요. 지도에 ${S.errand.icon}로 표시돼요. (선택)</small></p>` : ''}${S.event ? `<p class="msg warn">${S.event.icon} ${escapeHtml(S.event.text)}<br><small>${S.event.at != null ? `${S.event.at}분 이후 출발하는 이동부터` : '발생 시점부터'} ${evEffect(S.event)}</small></p>` : ''}${S.goals ? goalsHtml(S.goals) : ''}<p class="muted">생각하는 동안에는 시간이 줄어들지 않아요.</p>`, [
    { label: '출발하기', primary: true, fn: maybeTutorial },
  ], { onDismiss: maybeTutorial });
}

/* ── 이동 ── */
map.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.target.closest('[data-id]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
});
// 역 선택 직후 이 시간(ms) 동안은 수단 카드 입력을 무시한다 (더블클릭·터치 겹침으로 인한 오이동 방지)
let MOVE_GUARD_MS = 250, selAt = 0;
map.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-id]');
  if (!t && !dragged && sel != null && !busy) { sel = null; selMode = null; render(); updateFooter(); return; }   // 빈 곳을 누르면 선택 해제
  if (dragged || !t || !S || S.status !== 'active' || busy) return;
  const id = Number(t.dataset.id);
  if (!adjacent(S.cur).includes(id)) return;
  sel = id; selMode = null; selAt = Date.now(); render(); updateFooter();
  map.querySelector(`[data-id="${id}"]`)?.focus({ preventScroll: true });
});
$$('.mode').forEach((b) => { b.onclick = () => moveBy(b.dataset.mode); });
// 역을 고른 상태에서 1·2·3 = 지하철·버스·도보로 바로 이동
window.addEventListener('keydown', (ev) => {
  const i = ['1', '2', '3'].indexOf(ev.key);
  if (i < 0 || ev.ctrlKey || ev.metaKey || ev.altKey || sel == null) return;
  if (!$('#game').classList.contains('active') || !$('#modal').classList.contains('hidden') || !$('#subway').classList.contains('hidden') || !$('#tutorial').classList.contains('hidden')) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName || '')) return;
  ev.preventDefault(); moveBy(MODE_ORDER[i]);
});

// 수단 카드를 누르면 확인 단계 없이 바로 이동한다. 이동은 되돌릴 수 없다.
async function moveBy(mode) {
  if (busy || !S || S.status !== 'active' || sel == null || moveUnavailable(S.quotes[`${sel}:${mode}`])) return;
  if (Date.now() - selAt < MOVE_GUARD_MS) return;
  selMode = mode;
  busy = true; updateFooter();
  const from = S.nodes[S.cur], to = S.nodes[sel];
  try {
    const r = await api('/api/simulate/step', { sessionId: S.sessionId, to: sel, mode: selMode });
    await moveMarker(from, to, 600, false);
    S = r.state; sel = null; selMode = null;
    markerPos = { x: S.nodes[S.cur].x, y: S.nodes[S.cur].y };
    render(); updateHud();
    busy = false; updateFooter();
    if (r.result) onRoundEnd(r.result);
  } catch (e) {
    busy = false; selMode = null;
    if (e.code === 'session_not_found') modal('세션 만료', '보관 시간이 끝났거나 서버가 재시작됐어요. 새 지도로 다시 시작해 주세요.', [{ label: '확인', primary: true, fn: startRound }]);
    else { render(); updateFooter(); notify('이동하지 못했어요. 연결과 남은 자원을 확인한 뒤 다시 시도해 주세요.'); }
  }
}
$('#btn-giveup').onclick = () => {
  if (!S || S.status !== 'active' || busy) return;
  modal('포기할까요?', '이번 라운드를 포기하고 최적 경로를 확인합니다.', [
    { label: '취소' },
    { label: '포기', primary: true, fn: async () => { busy = true; updateFooter(); try { const r = await api('/api/simulate/giveup', { sessionId: S.sessionId }); S = r.state; busy = false; render(); updateHud(); updateFooter(); onRoundEnd(r.result); } catch { busy = false; updateFooter(); notify('포기 요청을 완료하지 못했어요. 다시 시도해 주세요.'); } } },
  ]);
};

/* ── 결과 / 비교 / 재생 ── */
function onRoundEnd(r) {
  result = r; sel = null; selMode = null; updateFooter();
  $('#panel-result').classList.remove('hidden'); setCollapsed('panel-result', false);
  if (mobile()) { setCollapsed('panel-mission', true); setCollapsed('panel-log', true); }
  $('#result-list').innerHTML = `
    <li><span>⏱ 소요 시간</span><b>${r.usedTime}분 / ${r.limit}분</b></li>
    <li><span>💰 사용 자금</span><b>${won(r.usedRes)} / ${won(S.resources)}</b></li>
    ${S.stamina ? `<li><span>❤️ 남은 체력</span><b>${S.stamina.left} / ${S.stamina.max}</b></li>` : ''}
    <li><span>▮ 최적 대비 효율</span><b>${r.status === 'success' ? r.efficiency + '%' : '-'}</b></li>`;
  $('#grade').textContent = r.grade;
  const ok = r.status === 'success';
  const checks = `<ul class="checks"><li>${r.checks.arrived ? '✔' : '✖'} 목적지 도착</li><li>${r.checks.inTime ? '✔' : '✖'} 시간 내 도착</li><li>${r.checks.efficient ? '✔' : '✖'} 효율적인 경로</li></ul>`;
  if (ctx.kind === 'level' && r.stars > 0) {
    const p = progress(); p[ctx.levelId] = Math.max(p[ctx.levelId] || 0, r.stars); store.set('route.progress', p);
  }
  const isLv = ctx.kind === 'level' && S.goals;
  const starsHtml = isLv ? `<div class="stars-big">${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)}</div>${goalsHtml(S.goals, r.hit)}` : '';
  const story = r.story ? `<p class="msg">${escapeHtml(r.story)}</p>` : '';
  const retryBtn = { label: '같은 지도 재도전', fn: () => startRound(true) };
  const exitBtn = ctx.kind === 'level' ? { label: '레벨 선택', fn: openLevels } : { label: '홈으로', fn: goHome };
  if (ok) {
    modal('라운드 결과', `${starsHtml}<div class="big-grade">${r.grade}</div>${story}${isLv ? '' : checks}<p>최적 대비 효율 ${r.efficiency}% (최적 ${r.optimal.time}분 / 내 경로 ${r.usedTime}분)</p>`,
      [{ label: nextLabel(), primary: true, fn: nextRound }, retryBtn, { label: '경로 비교', fn: showCompare }, exitBtn], { onDismiss: showCompare });
  } else {
    modal('실패…! 최적 경로를 확인해보세요.', `<p>${escapeHtml(r.reason)}</p>${story}${checks}<p><b>💡 ${r.hint}</b></p>`,
      [{ ...retryBtn, primary: true }, { label: '경로 비교', fn: showCompare }, { label: '최적 경로 재생', fn: () => { showCompare(); replay(); } }, ...(ctx.kind === 'week' ? [{ label: nextLabel(), fn: nextRound }] : []), exitBtn], { onDismiss: showCompare });
  }
}

const nextLabel = () => (ctx.kind === 'week' ? (S && S.week && S.week.day >= 5 ? '일주일 결과 ›' : '다음 날 ›') : ctx.kind === 'campaign' ? '메인으로' : ctx.kind === 'level' ? (ctx.levelId < 15 ? '다음 레벨 ›' : '레벨 선택') : '다음 라운드 ›');
function nextRound() {
  if (ctx.kind === 'week') { weekNext(); return; }
  if (ctx.kind === 'campaign') { goHome(); return; }
  if (ctx.kind === 'level') {
    if (result && result.status === 'success' && ctx.levelId < 15) { openLevelCard(ctx.levelId + 1); return; }
    if (result && result.status === 'success') { openLevels(); return; }
    startRound(); return;   // 실패 → 같은 레벨 재도전
  }
  if (result && result.status === 'success') ctx.round += 1;
  startRound();
}

function routeRow(label, steps, best, total, res) {
  const chain = [S.nodes[S.start].name];
  steps.forEach((s) => chain.push(`${MODES[s.mode].icon}${s.transfer ? '🔁' : ''}`, `${S.nodes[s.to].name}`));
  return `<div class="route-row"><span class="tag ${best ? 'best' : ''}">${best ? '👑 ' : ''}${label}</span>${chain.join(' › ')}<br><small>⏱ ${total}분 · 💰 ${won(res)}</small></div>`;
}
function showCompare() {
  if (!result) return;
  overlay = { my: S.path, opt: result.optimal.steps };
  $('#panel-log').classList.add('hidden');
  $('#panel-compare').classList.remove('hidden'); setCollapsed('panel-compare', false);
  $('#compare-text').innerHTML = routeRow('내 경로', S.path, false, S.used, S.path.reduce((a, p) => a + p.cost, 0)) +
    routeRow('최적 경로', result.optimal.steps, true, result.optimal.time, result.optimal.cost) +
    `<p>💡 ${result.hint}</p>`;
  $('#btn-next').textContent = result.status === 'success' || ctx.kind === 'campaign' || ctx.kind === 'week' ? nextLabel() : '새 지도로 도전 ›';
  zoomTo(500, 300, 1, 500);
  render();
}
$('#btn-next').onclick = nextRound;
$('#btn-retry').onclick = () => startRound(true);

function setReplayBtn() { $('#btn-replay').textContent = replaying ? (paused ? '▶ 계속' : '⏸ 일시정지') : '↻ 최적 경로 재생하기'; }
$('#btn-replay').onclick = () => { if (replaying) { paused = !paused; setReplayBtn(); } else replay(); };

async function replay() {
  if (!result) return;
  const tok = ++replayTok; paused = false; replaying = true; setReplayBtn();
  const steps = result.optimal.steps;
  overlay = { my: S.path, opt: [] };
  markerPos = { x: S.nodes[S.start].x, y: S.nodes[S.start].y };
  render();
  await zoomTo(markerPos.x, markerPos.y, 0.4, 700);
  for (const st of steps) {
    if (tok !== replayTok) return;
    while (paused && tok === replayTok) await sleep(100);
    await moveMarker(S.nodes[st.from], S.nodes[st.to], 1100, true);
    if (tok !== replayTok) return;
    overlay.opt.push(st); render();
    await sleep(settings.reduce ? 0 : 250);
  }
  if (tok !== replayTok) return;
  replaying = false; setReplayBtn();
  await zoomTo(500, 300, 1, 800);
}

/* ── 튜토리얼 ── */
const TUT = [
  '① 구간 위 숫자는 수단별 소요 시간(분)이에요. 테두리가 강조된 역이나 역 이름을 누르면 수단 카드가 뜨고, 카드를 누르면 바로 이동해요. (이동은 되돌릴 수 없어요 · 단축키 1 2 3)',
  '② 이동 자금(원)은 한정되어 있어요. 지하철·버스는 탈 때마다 요금이 나가고, 도보는 무료예요.',
  '③ 하차 후 30분 이내에 다시 지하철·버스를 타면 환승 무료(+3분). 너무 오래 걸으면 환승이 불가해져 요금을 다시 내요!',
  '④ 제한 시간 안에 🚩에 도착하세요. 최적 경로와 비교해 등급이 매겨져요.',
];
let tutIdx = 0;
function maybeTutorial() { if (settings.tut && !store.get('route.tutDone', false)) runTutorial(); }
function runTutorial() { if (busy) return; tutIdx = 0; $('#tutorial').classList.remove('hidden'); $('#tut-text').textContent = `튜토리얼 1/${TUT.length}\n` + TUT[0]; $('#tut-next').textContent = '다음'; }
function endTutorial() { $('#tutorial').classList.add('hidden'); store.set('route.tutDone', true); }
$('#tut-next').onclick = () => {
  tutIdx += 1;
  if (tutIdx >= TUT.length) return endTutorial();
  $('#tut-text').textContent = `튜토리얼 ${tutIdx + 1}/${TUT.length}\n` + TUT[tutIdx];
  if (tutIdx === TUT.length - 1) $('#tut-next').textContent = '완료';
};
$('#tut-skip').onclick = endTutorial;
$('#tut-text').style.whiteSpace = 'pre-line';

/* ── 레벨 선택 ── */
async function loadLevels() {
  if (levels.length) return true;
  try { const d = await api('/api/routes'); levels = d.levels; personas = d.personas; return true; }
  catch { modal('서버 오류', '레벨 정보를 불러올 수 없어요.', [{ label: '확인' }]); return false; }
}
function renderLevelGrid() {
  const pr = progress();
  const recommended = levels.find((l) => unlocked(l.id) && !(pr[l.id] > 0))?.id;
  $('#level-grid').innerHTML = levels.map((l) => {
    const st = pr[l.id] || 0, ok = unlocked(l.id), current = l.id === recommended;
    return `<button class="level-tile ${current ? 'recommended' : ''}" data-lv="${l.id}" ${ok ? '' : 'disabled'} aria-label="레벨 ${l.id} ${escapeHtml(l.title)}, ${ok ? `별 ${st}개` : `레벨 ${l.id - 1} 완료 후 해금`}"><span class="level-top"><b>${String(l.id).padStart(2, '0')}</b><span class="wx">${WX[l.weather] || ''}${personas[l.persona].icon}</span></span><strong>${escapeHtml(l.title)}</strong><span class="stars">${ok ? '★'.repeat(st) + '☆'.repeat(3 - st) : '잠김'}</span><small>${current ? '지금 도전할 여정 →' : !ok ? `레벨 ${l.id - 1} 완료 후 해금` : st ? '다시 도전할 수 있어요' : '새로운 여정'}</small></button>`;
  }).join('');
  $('#levels-total').textContent = `★ ${Object.values(pr).reduce((a, b) => a + b, 0)} / ${levels.length * 3}`;
  $$('.level-tile').forEach((b) => { b.onclick = () => openLevelCard(Number(b.dataset.lv)); });
}
async function openLevels() {
  if (!(await loadLevels())) return;
  renderLevelGrid(); closeModal(); show('levels');
}
// 시작 전 "상황 카드": 날씨 · 이동 타입 · 스토리
async function openLevelCard(id) {
  if (!(await loadLevels())) return;
  const l = levels.find((x) => x.id === id), p = personas[l.persona];
  const chips = [`${WX[l.weather]} ${l.weather === 'rain' ? '비' : '맑음'}`, `${p.icon} ${p.name}`, `❤️ 체력 ${p.stamina}`]
    .concat(p.walkMul > 1 ? ['🦶 걷기 체력 ×' + p.walkMul] : [], l.subwayOff ? ['🚇 지하철 중단'] : [], l.slack ? ['⏱ 시간 여유 적음'] : [], l.event ? [l.event] : [], l.errand ? [l.errand] : []);
  renderLevelGrid(); show('levels');
  modal(`Level ${l.id}. ${l.title}`,
    `<div class="sit-card"><div class="sit-icons">${WX[l.weather]}${p.icon}</div><p>${l.text}</p><div class="chips">${chips.map((c) => `<span class="chip">${c}</span>`).join('')}</div></div>`,
    [{ label: '‹ 레벨 선택', fn: openLevels }, { label: '▶ 시작하기', primary: true, fn: () => confirmNewGame(() => { ctx = { kind: 'level', levelId: id, round: 1, scenarioId: null }; startRound(); }) }]);
}
$('#btn-levels').onclick = openLevels;
$('#levels-back').onclick = goHome;

/* ── 일주일 등교 캠페인 ── */
const weekErr = () => modal('진행 초기화', '일주일 캠페인 진행 정보를 찾을 수 없어요. (서버 재시작 등) 처음부터 다시 시작해 주세요.', [{ label: '메인으로', primary: true, fn: () => { show('start'); refreshStats(); } }]);
function weekLogHtml(w) {
  return `<div class="week-log">${['월', '화', '수', '목', '금'].map((n, i) => { const l = w.log[i]; return `<span class="${l ? (l.ok ? 'ok' : 'late') : (i + 1 === w.day ? 'now' : '')}">${n}<br>${l ? (l.ok ? '✔' : '지각') : '·'}</span>`; }).join('')}</div>`;
}
function showWeek(w) {
  weekBriefing = w.done ? null : w;
  show('start');
  if (w.done) {
    modal(w.ending.title, `${weekLogHtml(w)}<p>${w.ending.text}</p>`, [{ label: '메인으로', primary: true, fn: refreshStats }]);
    return;
  }
  const t = w.today, go = (choice) => () => confirmNewGame(() => { ctx = { kind: 'week', weekId: w.weekId, choice, round: 1, scenarioId: null }; startRound(); }, w.weekId);
  const last = w.log[w.log.length - 1];
  modal(t.title,
    `${weekLogHtml(w)}<div class="sit-card"><p>${t.text}</p>
      ${last && last.saved ? `<p class="msg">🐷 어제 남긴 교통비 중 ${won(last.saved)}을 저금했다.</p>` : ''}
      ${t.errand ? `<p class="msg">📱 ${t.errand}</p>` : ''}${t.notes.map((n) => `<p class="msg">${n}</p>`).join('')}
      ${t.choice && !t.choice.ok ? `<p class="msg">☂ 우산을 사고 싶지만 저금이 부족하다. (${won(t.choice.price)} 필요)</p>` : ''}
      <div class="chips"><span class="chip">🐷 저금 ${won(w.savings)}</span><span class="chip">⏰ 지각 ${w.late}회</span>${t.event ? `<span class="chip">${t.event}</span>` : ''}</div></div>`,
    [{ label: '그만두기', fn: refreshStats }].concat(t.choice && t.choice.ok ? [{ label: t.choice.label, fn: go(t.choice.id) }] : [], [{ label: t.choice && t.choice.ok ? '▶ 그냥 출발' : '▶ 출발하기', primary: true, fn: go() }]));
}
async function weekNext() {
  try { showWeek(await api('/api/week/next', { weekId: ctx.weekId })); } catch { weekErr(); }
}
$('#btn-week').onclick = async () => {
  if (weekBriefing) { showWeek(weekBriefing); return; }
  try { showWeek(await api('/api/week/start', {})); } catch { modal('서버 오류', '게임 서버에 연결할 수 없어요.', [{ label: '확인' }]); }
};

/* ── 버튼 연결 ── */
$('#btn-endless').onclick = () => confirmNewGame(() => { ctx = { kind: 'endless', round: 1, scenarioId: null }; startRound(); });
$('#btn-settings').onclick = openSettings;
$('#btn-campaign').onclick = async () => {
  try { scenarios = (await api('/api/routes')).scenarios; } catch { return modal('서버 오류', '캠페인 정보를 불러올 수 없어요.', [{ label: '확인' }]); }
  modal('캠페인 모드', '<p>특정 상황이 주어지는 시나리오를 선택하세요.</p>', scenarios.map((s) => ({ label: s.title, fn: () => { ctx = { kind: 'campaign', round: 1, scenarioId: s.id }; startRound(); } })).concat([{ label: '닫기' }]));
  $('#modal-actions').style.flexDirection = 'column';
};
$('#btn-pause').onclick = () => modal('게임 메뉴', '<p>생각하는 동안에는 시간이 줄어들지 않아요. 홈으로 이동해도 이 탭에서 여정을 이어갈 수 있어요.</p>', [{ label: '계속하기', primary: true }, { label: '레벨 선택', fn: openLevels }, { label: '도움말', fn: runTutorial }, { label: '홈으로', fn: goHome }]);
$('#btn-help').onclick = () => { runTutorial(); };
$('#btn-gear').onclick = openSettings;

/* ── 지하철 노선도 (플레이 화면 버튼) ── */
const L1 = ['도봉산', '도봉', '방학', '창동', '녹천', '월계', '광운대', '석계', '신이문', '외대앞', '회기', '청량리', '제기동', '신설동', '동묘앞', '동대문', '종로5가', '종로3가', '종각', '시청', '서울역'];
const XFER = { 도봉산: '7', 창동: '4', 동대문: '4', 서울역: '4', 노원: '4', 석계: '6', 태릉입구: '6' };
const METRO = {
  lines: [
    { name: '1호선', color: '#0052A4', pts: [[330, 30], [330, 550]] },
    { name: '4호선', color: '#00A5DE', pts: [[330, 108], [500, 108], [560, 160], [560, 342], [330, 420], [390, 445], [390, 520], [330, 550]] },
    { name: '7호선', color: '#747F00', pts: [[330, 30], [700, 30], [700, 134]] },
  ],
  stations: [
    ...L1.map((n, i) => ({ n, x: 330, y: 30 + 26 * i, side: 'l' })),
    ...['쌍문', '수유', '미아', '미아사거리', '길음', '성신여대입구', '한성대입구', '혜화'].map((n, i) => ({ n, x: 560, y: 160 + 26 * i, side: 'r' })),
    ...['동대문역사문화공원', '충무로', '명동', '회현'].map((n, i) => ({ n, x: 390, y: 445 + 25 * i, side: 'r' })),
    ...['수락산', '마들', '노원'].map((n, i) => ({ n, x: 440 + 80 * i, y: 30, side: 't' })),
    ...['중계', '하계', '공릉', '태릉입구'].map((n, i) => ({ n, x: 700, y: 56 + 26 * i, side: 'r' })),
  ],
};
const bare = (s) => s.replace(/역$/, '');

function metroHTML() {
  const here = new Set(S ? S.nodes.map((n) => bare(n.name)) : []);
  const cur = S ? bare(S.nodes[S.cur].name) : '', dst = S ? bare(S.nodes[S.dest].name) : '';
  let h = `<div class="sub-legend">${METRO.lines.map((l) => `<span><i style="background:${l.color}"></i>${l.name}</span>`).join('')}
    <span>◉ 환승역</span><span style="color:var(--accent)">● 이번 라운드에 등장하는 역</span></div>
    <svg viewBox="0 0 860 580">`;
  METRO.lines.forEach((l) => { h += `<polyline class="sline" stroke="${l.color}" points="${l.pts.map((p) => p.join(',')).join(' ')}"/>`; });
  METRO.stations.forEach((s) => {
    const x = XFER[s.n], on = here.has(s.n), me = s.n === cur || s.n === dst;
    const tx = s.side === 'l' ? s.x - 14 : s.side === 'r' ? s.x + 14 : s.x, ty = s.side === 't' ? s.y - 14 : s.y + 4;
    const anchor = s.side === 'l' ? 'end' : s.side === 'r' ? 'start' : 'middle';
    h += `<circle class="sst ${x ? 'xf' : ''}" cx="${s.x}" cy="${s.y}" r="${x ? 8 : 6}" ${on ? 'style="fill:var(--accent)"' : ''}/>
      <text class="sname ${me ? 'me' : ''}" x="${tx}" y="${ty}" text-anchor="${anchor}">${s.n}${x ? ` <tspan fill="#888" font-size="10">(${x}호선)</tspan>` : ''}${s.n === dst ? ' 🚩' : ''}${s.n === cur ? ' 📍' : ''}</text>`;
  });
  h += '</svg><p class="sub-note">※ 참고용 간략 노선도입니다(광운대 인근 일부 구간, 실제 배치/거리와 다름). 게임 속 이동 시간은 [이번 라운드] 탭을 확인하세요.</p>';
  return h;
}

function roundSubwayHTML() {
  if (!S) return '<p>라운드를 시작하면 노선도가 표시돼요.</p>';
  const se = S.edges.filter((e) => e.opts.subway != null);
  const palette = ['#782F40', '#2e7d6b', '#c28a1e', '#3b6ea8', '#8a5fb3'];
  const adj = {}; se.forEach((e) => { (adj[e.a] = adj[e.a] || []).push(e.b); (adj[e.b] = adj[e.b] || []).push(e.a); });
  const comp = {}; let c = 0;
  Object.keys(adj).forEach((k) => { if (comp[k] !== undefined) return; const q = [Number(k)]; comp[k] = c; while (q.length) { const n = q.pop(); adj[n].forEach((m) => { if (comp[m] === undefined) { comp[m] = c; q.push(m); } }); } c += 1; });
  const col = (n) => palette[comp[n] % palette.length];
  let h = `<div class="sub-legend"><span><i style="background:var(--accent)"></i>지하철 구간 (기본요금 ${won(1550)}, 환승 시 무료)</span><span>흐린 역: 지하철 없음</span><span>📍 출발 · 🚩 목적지 · 채워진 역: 현재 위치</span></div>
    <svg viewBox="0 0 1000 600">`;
  se.forEach((e) => {
    const A = S.nodes[e.a], B = S.nodes[e.b];
    h += `<line class="sline" stroke="${col(e.a)}" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>
      <text class="stime" x="${(A.x + B.x) / 2}" y="${(A.y + B.y) / 2 - 8}">${e.opts.subway}분</text>`;
  });
  S.nodes.forEach((n) => {
    const on = adj[n.id], isCur = n.id === S.cur;
    h += `<circle class="sst ${on ? 'xf' : ''}" cx="${n.x}" cy="${n.y}" r="${on ? 9 : 5}" ${isCur ? 'style="fill:var(--accent)"' : on ? '' : 'style="opacity:.5"'}/>
      <text class="sname ${n.id === S.dest || isCur ? 'me' : ''}" x="${n.x}" y="${n.y + 26}" text-anchor="middle" ${on ? '' : 'style="opacity:.55"'}>${n.name}${n.id === S.dest ? ' 🚩' : ''}${n.id === S.start ? ' 📍' : ''}</text>`;
  });
  h += '</svg>';
  const rows = se.map((e) => `<tr><td>${S.nodes[e.a].name} ↔ ${S.nodes[e.b].name}</td><td>🚇 ${e.opts.subway}분</td><td>🚶 ${e.opts.walk != null ? e.opts.walk + '분' : '불가'}</td><td>🚌 ${e.opts.bus != null ? e.opts.bus + '분' : '-'}</td></tr>`).join('');
  h += se.length ? `<table class="sub-table"><tr><th>구간</th><th>지하철</th><th>도보</th><th>버스</th></tr>${rows}</table>` : '<p>이번 라운드에는 지하철 구간이 없어요 (버스/도보로 이동).</p>';
  return h;
}

let subTab = 'round';
function renderSubway() {
  $$('.tab').forEach((t) => t.classList.toggle('sel', t.dataset.tab === subTab));
  $('#subway-body').innerHTML = subTab === 'round' ? roundSubwayHTML() : metroHTML();
}
$('#btn-subway').onclick = () => { $('#subway').classList.remove('hidden'); renderSubway(); };
$('#subway-close').onclick = () => $('#subway').classList.add('hidden');
$('#subway').addEventListener('click', (e) => { if (e.target.id === 'subway') $('#subway').classList.add('hidden'); });
$$('.tab').forEach((t) => { t.onclick = () => { subTab = t.dataset.tab; renderSubway(); }; });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#subway').classList.add('hidden'); });

applySettings(); refreshStats();
