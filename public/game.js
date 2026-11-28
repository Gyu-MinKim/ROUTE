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

async function api(path, body, controller = new AbortController()) {
  const timeout = setTimeout(() => controller.abort(), path === '/api/simulate/start' ? 35000 : path === '/api/feedback' ? 25000 : 15000);
  try {
    const res = await fetch(path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'error'); e.code = data.error; e.upstreamStatus = data.upstreamStatus; throw e; }
    layoutGeo(data); layoutGeo(data && data.state);
    return data;
  } finally { clearTimeout(timeout); }
}

/* ── 실제 위치 기준 지도 배치 (화면 표시만 바꾸며 판정에는 쓰이지 않음) ── */
// 역 좌표가 있는 실제 지도 모드에서는 위도·경도를 가로·세로 같은 축척으로 1000×600 화면에 맞춘다.
function layoutGeo(state) {
  if (!state || !Array.isArray(state.nodes) || !state.nodes.length) return;
  if (!(state.realMapEnabled || state.usesSegmentTimes || state.subwayPreview)) return;
  if (!state.nodes.every((n) => Number.isFinite(n.lat) && Number.isFinite(n.lng))) return;
  const lats = state.nodes.map((n) => n.lat), lngs = state.nodes.map((n) => n.lng);
  const lat0 = Math.min(...lats), lat1 = Math.max(...lats), lng0 = Math.min(...lngs), lng1 = Math.max(...lngs);
  const c = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180), W = 1000, H = 600, PAD = 80;
  const dx = Math.max((lng1 - lng0) * c, 1e-6), dy = Math.max(lat1 - lat0, 1e-6);
  const k = Math.min((W - 2 * PAD) / dx, (H - 2 * PAD) / dy);
  const ox = (W - dx * k) / 2, oy = (H - dy * k) / 2;
  state.geo = { c, k, ox, oy, lng0, lat1 };
  state.nodes.forEach((n) => { n.x = Math.round(ox + (n.lng - lng0) * c * k); n.y = Math.round(oy + (lat1 - n.lat) * k); });
}
const geoPoint = (g, lat, lng) => [Math.round((g.ox + (lng - g.lng0) * g.c * g.k) * 10) / 10, Math.round((g.oy + (g.lat1 - lat) * g.k) * 10) / 10];
function smoothPath(pts, closed) {
  if (pts.length < 3) return 'M' + pts.map((p) => p.join(' ')).join(' L');
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2].map((v) => Math.round(v * 10) / 10);
  const list = closed ? [...pts, pts[0], pts[1]] : pts;
  let d = closed ? `M${mid(pts[0], pts[1]).join(' ')}` : `M${pts[0].join(' ')}`;
  for (let i = closed ? 1 : 1; i < list.length - 1; i++) d += ` Q${list[i].join(' ')} ${mid(list[i], list[i + 1]).join(' ')}`;
  return closed ? d + ' Z' : d + ` L${pts[pts.length - 1].join(' ')}`;
}
// 배경: 실제 지도 모드는 강·산을 실제 자리에, 기본 모드는 격자만 그린다.
function backgroundSvg() {
  let h = `<rect x="${WORLD.x}" y="${WORLD.y}" width="${WORLD.w}" height="${WORLD.h}" fill="var(--map)" pointer-events="none"/>`;
  if (S.geo && typeof GEO_FEATURES !== 'undefined') {
    const g = S.geo, P = ([lat, lng]) => geoPoint(g, lat, lng);
    h += GEO_FEATURES.parks.map((f) => `<path class="geo-park" d="${smoothPath(f.points.map(P), true)}"/>`).join('');
    h += GEO_FEATURES.rivers.map((f) => `<path class="geo-water" stroke-width="${f.width * 1.4}" d="${smoothPath(f.points.map(P), false)}"/>`).join('');
    h += GEO_FEATURES.parks.filter((f) => f.points.length).map((f) => { const [x, y] = P(f.label); return `<text class="geo-label park" x="${x}" y="${y}">${escapeHtml(f.name)}</text>`; }).join('');
    h += GEO_FEATURES.rivers.filter((f) => f.label).map((f) => { const [x, y] = P(f.points[Math.floor(f.points.length / 2)]); return `<text class="geo-label water" x="${x + 10}" y="${y}">${escapeHtml(f.name)}</text>`; }).join('');
  } else {
    let grid = '';
    for (let x = -500; x <= 1500; x += 100) grid += `M${x} -300V900`;
    for (let y = -300; y <= 900; y += 100) grid += `M-500 ${y}H1500`;
    h += `<path class="map-grid" d="${grid}"/>`;
  }
  return h;
}
// 노선 색 (서울교통공사·코레일 노선도 대표색). 기본 모드처럼 호선 정보가 없으면 중립색.
const LINE_COLOR = { 1: '#0052A4', 2: '#00A84D', 3: '#EF7C1C', 4: '#00A5DE', 5: '#996CAC', 6: '#CD7C2F', 7: '#747F00', 8: '#E6186C', 9: '#BDB092', K: '#77C4A3', B: '#F5A200', S: '#D4003B' };
const edgeMode = (e) => MODE_ORDER.find((m) => e.opts && e.opts[m] != null) || null;
const edgeColor = (e, m = edgeMode(e)) => (m === 'subway' ? LINE_COLOR[e.lineId] || '#4b6a66' : m === 'bus' ? '#E8590C' : m === 'walk' ? '#6b7280' : 'var(--edge)');

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
// 처음 화면·전체 보기: 실제 지도 모드는 역이 있는 범위에 맞춰 확대하고, 기본 모드는 전체 지도를 보여 준다.
function homeView() {
  if (!S || !S.geo) return { cx: 500, cy: 300, s: 1 };
  const xs = S.nodes.map((n) => n.x), ys = S.nodes.map((n) => n.y), m = 95;
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const ratio = map.clientWidth && map.clientHeight ? Math.max(0.6, map.clientHeight / map.clientWidth) : 0.6;
  const s = Math.min(1, Math.max(0.25, Math.max(x1 - x0 + 2 * m, (y1 - y0 + 2 * m) / ratio) / 1000));
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s };
}
const zoomHome = (ms) => { const h = homeView(); return zoomTo(h.cx, h.cy, h.s, ms); };
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
function initPanels() { setCollapsed('panel-mission', false); setCollapsed('panel-log', false); }
wrap.addEventListener('dblclick', (ev) => { if (ev.target.closest('button, [data-id]')) return; zoomHome(400); });   // 역·카드 더블클릭은 전체 보기로 취급하지 않는다
$('#z-reset').onclick = () => zoomHome(400);
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


const eb = (a, b) => S.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
function availableDestinations() {
  if (S?.status !== 'active') return [];
  return [...new Set(Object.entries(S.quotes)
    .filter(([, quote]) => !moveUnavailable(quote))
    .map(([key]) => Number(key.split(':')[0])))];
}
const ln = (a, b, cls) => { const A = S.nodes[a], B = S.nodes[b]; return `<line class="edge ${cls}" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`; };

function render() {
  if (!S) return;
  const reach = new Set(availableDestinations());
  let h = '';
  h += backgroundSvg();
  // 간선: 지금 갈 수 있는 구간과 지나온 구간만 진하게, 나머지는 옅게. 대표 수단 하나의 모양으로 그린다.
  const done = new Set(S.path.map((st) => [Math.min(st.from, st.to), Math.max(st.from, st.to)].join(':')));
  const parts = { idle: '', act: '' };
  S.edges.forEach((e) => {
    const m = edgeMode(e), A = S.nodes[e.a], B = S.nodes[e.b];
    const other = e.a === S.cur ? e.b : e.b === S.cur ? e.a : null;
    const hot = sel != null && other === sel;
    const used = !overlay && done.has([Math.min(e.a, e.b), Math.max(e.a, e.b)].join(':'));
    const state = hot ? 'hot' : other != null && reach.has(other) ? 'act' : used ? 'used' : 'idle';
    const line = (cls) => `<line class="edge ${cls}" style="stroke:${edgeColor(e, m)}" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`;
    if (state === 'idle') { parts.idle += line(`m-${m || 'none'} idle`); return; }
    if (used) parts.act += `<line class="edge casing" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>`;
    parts.act += line(`m-${m || 'none'} ${state}`);
  });
  h += parts.idle + parts.act;
  if (overlay) {
    overlay.my.forEach((st) => { h += ln(st.from, st.to, 'my'); });
    overlay.opt.forEach((st) => { h += ln(st.from, st.to, 'opt'); });
  }
  // 수단별 소요 시간은 선택한 역의 구간에만 표시
  [...reach].filter((n) => n === sel).forEach((n) => {
    const e = eb(S.cur, n), A = S.nodes[S.cur], B = S.nodes[n];
    // 지금 탈 수 없는 수단은 흐리게
    const tags = MODE_ORDER.filter((m) => S.quotes[`${n}:${m}`]).map((m) => { const q = S.quotes[`${n}:${m}`]; return `<tspan ${moveUnavailable(q) ? 'opacity=".4"' : ''}>${MODES[m].icon}${q.time}</tspan>`; }).join(' ');
    h += `<text class="mode-tag" x="${(A.x + B.x) / 2}" y="${(A.y + B.y) / 2 - 6}">${tags}</text>`;
  });
  h += S.nodes.map((n) => {
    const cls = ['node'];
    if (reach.has(n.id)) cls.push('reach');
    if (n.id === sel) cls.push('sel');
    if (n.id === S.cur) cls.push('cur');
    if (n.id === S.dest) cls.push('dest');
    const reachable = reach.has(n.id);
    const quiet = !reachable && n.id !== S.cur && n.id !== S.dest && n.id !== S.start;   // 지금 갈 수 없는 역은 작고 흐리게
    if (quiet) cls.push('quiet');
    const r = n.id === S.cur ? 12 : quiet ? 7 : 10;
    return `<g class="station-target" data-id="${n.id}" ${reachable ? `role="button" tabindex="0" aria-label="${escapeHtml(n.name)} 선택" aria-pressed="${n.id === sel}"` : ''}>
      <rect class="station-hit" x="${n.x - 35}" y="${n.y - 24}" width="70" height="66" rx="12"/>
      ${n.isTransfer && !quiet ? `<circle class="xfer-ring" cx="${n.x}" cy="${n.y}" r="${r + 5}"/>` : ''}
      <circle class="${cls.join(' ')}" cx="${n.x}" cy="${n.y}" r="${r}"/>
      <text class="label${quiet ? ' quiet' : ''}" x="${n.x}" y="${n.y + (quiet ? 24 : 32)}">${escapeHtml(n.name)}</text></g>`;
  }).join('');
  const st = S.nodes[S.start], ds = S.nodes[S.dest];
  h += `<text x="${st.x}" y="${st.y - 22}" font-size="24" pointer-events="none" text-anchor="middle">⌂</text>`;
  h += `<text x="${ds.x}" y="${ds.y - 22}" font-size="28" pointer-events="none" text-anchor="middle">⚑</text>`;
  if (S.errand) { const en = S.nodes[S.errand.node]; h += `<text x="${en.x}" y="${en.y - 20}" font-size="26" pointer-events="none" text-anchor="middle" ${S.errand.done ? 'opacity=".45"' : ''}>${S.errand.icon}${S.errand.done ? '✔' : ''}</text>`; }
  h += `<circle id="mk" class="marker" pointer-events="none" cx="${markerPos.x}" cy="${markerPos.y}" r="11"/>`;
  map.innerHTML = h;
  if (typeof kakaoMapRender === 'function') kakaoMapRender(); // 실제 지도(kakaoMap.js)도 같은 상태로 갱신
}

function moveMarker(a, b, ms, follow) {
  const movementToken = roundToken, replayId = replayTok;
  const mk = () => $('#mk');
  const kakaoStep = (k) => { if (typeof kakaoMarkerAt === 'function') kakaoMarkerAt(a, b, k, follow); }; // 실제 지도 현재 위치 동기화
  if (settings.reduce) { markerPos = { x: b.x, y: b.y }; if (mk()) { mk().setAttribute('cx', b.x); mk().setAttribute('cy', b.y); } kakaoStep(1); return Promise.resolve(); }
  return new Promise((res) => {
    const t0 = performance.now();
    (function step(now) {
      if (movementToken !== roundToken || (follow && replayId !== replayTok)) return res();
      const k = Math.min(1, (now - t0) / ms);
      markerPos = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      const m = mk();
      if (m) { m.setAttribute('cx', markerPos.x); m.setAttribute('cy', markerPos.y); }
      kakaoStep(k);
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
  $('#map-attrib').classList.toggle('hidden', !S.usesSegmentTimes);
  document.body.classList.toggle('has-stam', !!S.stamina);
  if (S.stamina) {
    $('#hud-stam').textContent = `${S.stamina.left} / ${S.stamina.max}`;
    $('#stam-fill').style.width = Math.max(0, 100 * S.stamina.left / S.stamina.max) + '%';
  }
  $('#log').innerHTML = S.path.map((p) => `<li>${S.nodes[p.from].name} → ${S.nodes[p.to].name} <small>(${MODES[p.mode].icon} ${p.time}분 · ${p.transfer && p.cost === 0 ? '환승 무료' : won(p.cost)})</small></li>`).join('') || '<li style="list-style:none;opacity:.6">아직 이동 기록이 없어요</li>';
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
    const detail = !active ? (busy ? '이동 준비 중' : '라운드 종료') : sel == null ? '역을 먼저 선택하세요' : reason || `${q.time}분 · ${q.transfer && q.cost === 0 ? '환승 무료' : won(q.cost)}${S.stamina ? ` · 체력 −${q.stam}` : ''}`;
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
  const controller = new AbortController();
  const cancel = () => {
    roundToken++;
    controller.abort();
    if (sessionCtx) ctx = { ...sessionCtx };
    busy = false;
    updateFooter();
    goHome();
  };
  modal('라운드 준비 중', '<p role="status">이동 경로와 기준 소요 시간을 확인하고 있어요. 준비하는 동안 게임 시간은 흐르지 않아요.</p>',
    [{ label: '홈으로', fn: cancel }], { onDismiss: cancel });
  try {
    const next = await api(retry ? '/api/simulate/retry' : '/api/simulate/start', retry ? { sessionId: S.sessionId } : ctx.kind === 'campaign' ? { mode: 'campaign', scenarioId: ctx.scenarioId } : ctx.kind === 'level' ? { mode: 'level', levelId: ctx.levelId } : ctx.kind === 'week' ? { mode: 'week', weekId: ctx.weekId, choice: ctx.choice } : { mode: 'endless', round: ctx.round }, controller);
    if (token !== roundToken) return;
    closeModal(false);
    S = next; sessionCtx = { ...ctx }; weekBriefing = null;
  } catch (e) {
    if (token !== roundToken) return;
    if (sessionCtx) ctx = { ...sessionCtx };
    busy = false; updateFooter();
    const expired = e.code === 'session_not_found';
    const startErrors = {
      round_preparation_timeout: '경로 준비 시간이 길어졌어요. 새 역 조합으로 다시 시도할 수 있어요.',
      segment_coverage_missing: '저장된 역 구간으로 이번 레벨의 완주 경로를 구성할 수 없어요.',
      verified_data_missing: '저장된 실제 이동 데이터가 아직 준비되지 않았어요.',
      verified_data_unreadable: '저장된 실제 이동 데이터 파일을 읽을 수 없어요.',
      verified_data_invalid: '저장된 이동 데이터의 형식이나 역·노선 연결을 확인해 주세요.',
      verified_lookup_incomplete: '일부 경로를 조회하지 못해 완주 가능한 지도를 확인할 수 없어요.',
      verified_level_weights_missing: '이 레벨 지도에 확인된 이동 시간이 아직 없어요.',
      verified_level_data_missing: '이 레벨에서 사용할 검증된 실제 지도 데이터가 아직 없어요.',
      kakao_key_missing: '카카오 길찾기 인증 설정이 필요해요.',
      kakao_upstream_error: Number.isInteger(e.upstreamStatus)
        ? `카카오 길찾기가 오류(HTTP ${e.upstreamStatus})를 반환해 이동 시간을 확인하지 못했어요.`
        : '카카오 길찾기에서 이동 시간을 확인하지 못했어요.',
      kakao_auth_failed: '카카오 길찾기 인증 또는 제휴 권한을 확인해 주세요.',
      kakao_rate_limited: '카카오 길찾기 호출 한도에 도달했어요. 잠시 뒤 다시 시도해 주세요.',
      no_verified_route: '검증된 이동 경로를 찾지 못했어요.',
      no_playable_verified_route: '검증된 경로 중 이번 레벨의 체력·요금·운행 조건으로 완주할 수 있는 경로가 없어요.',
      verified_map_generation_failed: '이번 레벨에 맞는 실제 노선 지도를 구성하지 못했어요.',
    };
    modal(expired ? '이 지도의 보관 시간이 끝났어요' : '여정을 시작하지 못했어요', `<p>${expired ? '같은 지도로 재도전할 수 없어요. 새 지도로 시작할 수 있어요.' : (Object.hasOwn(startErrors, e.code) ? startErrors[e.code] : '연결을 확인한 뒤 다시 시도해 주세요.')}</p>`, [
      { label: '홈으로', fn: goHome },
      { label: expired ? '새 지도로 시작' : '다시 시도', primary: true, fn: () => { ctx = { ...requestedCtx }; startRound(expired ? false : retry); } },
    ]);
    return;
  }
  result = null; overlay = null; sel = null; selMode = null;
  $('#panel-result').classList.add('hidden'); $('#panel-compare').classList.add('hidden'); $('#panel-log').classList.remove('hidden');
  $('#tutorial').classList.add('hidden');
  markerPos = { x: S.nodes[S.start].x, y: S.nodes[S.start].y };
  const d = S.nodes[S.dest];
  $('#mission').textContent = `${d.name}에 도착하기`;
  $('#mission-sub').innerHTML = missionSub();
  show('game'); initPanels(); render(); updateHud();
  { const h = homeView(); vb = { x: h.cx - 500 * h.s, y: h.cy - 300 * h.s, w: 1000 * h.s, h: 600 * h.s }; setVB(); }
  const play = Number(store.get('route.plays', 0)) + 1;
  store.set('route.plays', play); sess.set('plays', sess.get('plays', 0) + 1);
  busy = false; updateFooter();
  if (retry) { notify('같은 지도에서 다시 출발해요.'); return; }
  // One briefing per new round. Closing it is equivalent to starting play.
  modal(S.scenario ? S.scenario.title : `라운드 ${S.round}`, `<p class="briefing-route">${escapeHtml(S.nodes[S.start].name)} <span>→</span> ${escapeHtml(d.name)}</p>${S.scenario ? `<p>${escapeHtml(S.scenario.text)}</p>` : ''}<div class="chips"><span class="chip">시간 ${S.limit}분</span><span class="chip">교통비 ${won(S.resources)}</span>${S.stamina ? `<span class="chip">체력 ${S.stamina.max}</span>` : ''}</div>${S.errand ? `<p class="msg">${escapeHtml(S.errand.ask)}<br><small>${escapeHtml(S.nodes[S.errand.node].name)}에 들러주세요. 지도에 ${S.errand.icon}로 표시돼요. (선택)</small></p>` : ''}${S.event ? `<p class="msg warn">${S.event.icon} ${escapeHtml(S.event.text)}<br><small>${S.event.at != null ? `${S.event.at}분 이후 출발하는 이동부터` : '발생 시점부터'} ${evEffect(S.event)}</small></p>` : ''}${S.goals ? goalsHtml(S.goals) : ''}`, [
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
  if (!availableDestinations().includes(id)) return;
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
const coachLoading = 'AI가 플레이 결과를 분석하고 있어요...';
const coachContentMarkup = `<div class="coach-heading"><strong>AI ROUTE COACH</strong><small data-coach-source></small></div>
  <p data-coach-state role="status"></p>
  <div data-coach-sections hidden>
    <section class="coach-section"><h3>플레이 평가</h3><p data-coach-field="evaluation"></p></section>
    <section class="coach-section"><h3>최적 경로와의 비교</h3><p data-coach-field="comparison"></p></section>
    <section class="coach-section"><h3>다음 플레이 TIP</h3><p data-coach-field="tip"></p></section>
  </div>`;
const coachMarkup = `<div class="route-coach" data-coach-feedback aria-live="polite">${coachContentMarkup}</div>`;
let coachRequestToken = 0;

async function loadRoundFeedback(sessionId) {
  const token = ++coachRequestToken;
  const areas = [$('#panel-result [data-coach-feedback]'), $('#modal-body [data-coach-feedback]')];
  areas.forEach(area => {
    area.innerHTML = coachContentMarkup;
    area.setAttribute('aria-busy', 'true');
    area.querySelector('[data-coach-state]').textContent = coachLoading;
  });
  let data;
  try {
    data = await api('/api/feedback', { sessionId });
    if (!['gemini', 'fallback'].includes(data.source)
        || !['evaluation', 'comparison', 'tip'].every(key => typeof data.feedback?.[key] === 'string'
          && data.feedback[key].trim() && data.feedback[key].length <= 300)) data = null;
  } catch { /* Keep transport errors out of the coaching content. */ }
  if (token !== coachRequestToken || S?.sessionId !== sessionId || S.status === 'active') return;
  areas.forEach(area => {
    if (!area.isConnected) return;
    area.setAttribute('aria-busy', 'false');
    const state = area.querySelector('[data-coach-state]');
    if (!data) { state.textContent = '피드백을 불러오지 못했어요. 경로 비교에서 이번 이동을 돌아볼 수 있어요.'; return; }
    state.hidden = true;
    area.querySelector('[data-coach-source]').textContent = data.source === 'gemini' ? 'Gemini 생성' : '기본 피드백';
    for (const key of ['evaluation', 'comparison', 'tip']) {
      area.querySelector(`[data-coach-field="${key}"]`).textContent = data.feedback[key];
    }
    area.querySelector('[data-coach-sections]').hidden = false;
  });
}

function onRoundEnd(r) {
  result = r; sel = null; selMode = null; updateFooter();
  $('#panel-result').classList.remove('hidden'); setCollapsed('panel-result', false);
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
    modal('CLEAR', `${starsHtml}<div class="big-grade">${r.grade}</div>${story}${isLv ? '' : checks}<p>최적 대비 효율 ${r.efficiency}% (최적 ${r.optimal.time}분 / 내 경로 ${r.usedTime}분)</p>${coachMarkup}`,
      [{ label: nextLabel(), primary: true, fn: nextRound }, retryBtn, { label: '경로 비교', fn: showCompare }, exitBtn], { onDismiss: showCompare });
  } else {
    modal('FAILED', `<p>${escapeHtml(r.reason)}</p>${story}${checks}<p><b>💡 ${r.hint}</b></p>${coachMarkup}`,
      [{ ...retryBtn, primary: true }, { label: '경로 비교', fn: showCompare }, { label: '최적 경로 재생', fn: () => { showCompare(); replay(); } }, ...(ctx.kind === 'week' ? [{ label: nextLabel(), fn: nextRound }] : []), exitBtn], { onDismiss: showCompare });
  }
  void loadRoundFeedback(S.sessionId);
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
  zoomHome(500);
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
  await zoomHome(800);
}

/* ── 튜토리얼 ── */
const TUT = [
  '① 테두리가 강조된 역이나 역 이름을 누르면 구간 위에 수단별 소요 시간(분)과 수단 카드가 떠요. 카드를 누르면 바로 이동해요. (이동은 되돌릴 수 없어요 · 단축키 1 2 3)',
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
    return `<button class="level-tile ${current ? 'recommended' : ''}" data-lv="${l.id}" ${ok ? '' : 'disabled'} aria-label="레벨 ${l.id} ${escapeHtml(l.title)}, ${ok ? `별 ${st}개` : `레벨 ${l.id - 1} 완료 후 해금`}"><span class="level-top"><b>${String(l.id).padStart(2, '0')}</b><span class="wx">${WX[l.weather] || ''}${personas[l.persona].icon}</span></span><strong>${escapeHtml(l.title)}</strong><span class="stars">${ok ? '★'.repeat(st) + '☆'.repeat(3 - st) : '잠김'}</span><small>${!ok ? `레벨 ${l.id - 1} 완료 후 해금` : st ? '클리어' : '도전 가능'}</small></button>`;
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
// 게임 메뉴 (설정 · 라운드 포기 포함)
function openMenu() {
  const playing = !!S && S.status === 'active' && !busy;
  modal('일시정지', '', [
    { label: '계속하기', primary: true },
    { label: '레벨 선택', fn: openLevels },
    { label: '도움말', fn: () => openHelp() },
    { label: '설정', fn: openSettings },
    ...(playing ? [{ label: '라운드 포기', danger: true, fn: () => $('#btn-giveup').click() }] : []),
    { label: '홈으로', fn: goHome },
  ]);
}
// 도움말: 게임 방법 · 지도 범례 · 데이터 출처
const HELP_TABS = { how: '게임 방법', legend: '지도 범례', source: '데이터 출처' };
function helpBody(tab) {
  if (tab === 'how') {
    return `<ol class="help-list">${TUT.map((t) => `<li>${escapeHtml(t.replace(/^[①②③④]\s*/, ''))}</li>`).join('')}</ol>
      <button type="button" class="btn small" id="help-tutorial">튜토리얼 다시 보기</button>`;
  }
  if (tab === 'legend') {
    return `<ul class="help-legend">
      <li><i class="lg-dot cur"></i>현재 위치</li><li><i class="lg-dot reach"></i>지금 이동할 수 있는 역</li><li>⌂ 출발 · ⚑ 목적지</li>
      <li><i class="lg-line subway"></i>🚇 지하철 — 실제 지도 모드에서는 호선 색</li><li><i class="lg-line bus"></i>🚌 버스</li><li><i class="lg-line walk"></i>🚶 도보</li>
      <li>역을 누르면 구간 위에 소요 시간(분)이 떠요 · 지금 갈 수 있는 구간만 진하게 보여요</li>
      <li>흐린 수단은 지금 탈 수 없어요 (시간·교통비·체력 부족 또는 운행 중단)</li></ul>`;
  }
  const real = !!S?.usesSegmentTimes;
  return `<dl class="help-source">
    ${real ? `<dt>기준 시간</dt><dd>평일 08:00~09:00 등교</dd>
    <dt>지하철</dt><dd>표준 운행시간</dd>
    <dt>버스 · 도보</dt><dd>구간별 관측값<br><small>일부 버스 구간은 승차 전과 하차 후 도보 3분씩 적용</small></dd>
    <dt>도보 경로</dt><dd>일부 추정에 <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a> 자료 사용</dd>`
    : `<dt>지도</dt><dd>게임용으로 만든 지도와 이동 시간</dd>`}
  </dl>`;
}
function openHelp(tab = 'how') {
  const tabs = Object.entries(HELP_TABS).map(([key, label]) => `<button type="button" class="tab ${key === tab ? 'sel' : ''}" data-help="${key}" aria-pressed="${key === tab}">${label}</button>`).join('');
  modal('도움말', `<div class="help-tabs" role="group" aria-label="도움말 항목">${tabs}</div><div class="help-body">${helpBody(tab)}</div>`, [{ label: '닫기', primary: true }]);
  $$('[data-help]').forEach((b) => { b.onclick = () => openHelp(b.dataset.help); });
  const again = $('#help-tutorial');
  if (again) again.onclick = () => { closeModal(false); runTutorial(); };
}
$('#btn-pause').onclick = openMenu;
$('#btn-help').onclick = () => openHelp();

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
  const minutes = n => n == null ? '—' : n + '분';
  const edgeTime = (e, mode) => {
    if (!e.directionalOpts) return minutes(e.opts[mode]);
    const { forward, reverse } = e.directionalOpts;
    return forward[mode] === reverse[mode] ? minutes(forward[mode])
      : '→ ' + minutes(forward[mode]) + ' / ← ' + minutes(reverse[mode]);
  };
  const palette = ['#782F40', '#2e7d6b', '#c28a1e', '#3b6ea8', '#8a5fb3'];
  const adj = {}; se.forEach((e) => { (adj[e.a] = adj[e.a] || []).push(e.b); (adj[e.b] = adj[e.b] || []).push(e.a); });
  const comp = {}; let c = 0;
  Object.keys(adj).forEach((k) => { if (comp[k] !== undefined) return; const q = [Number(k)]; comp[k] = c; while (q.length) { const n = q.pop(); adj[n].forEach((m) => { if (comp[m] === undefined) { comp[m] = c; q.push(m); } }); } c += 1; });
  const col = (n) => palette[comp[n] % palette.length];
  let h = `<div class="sub-legend"><span><i style="background:var(--accent)"></i>지하철 구간 (기본요금 ${won(1550)}, 환승·별도운임은 이동 견적에 표시)</span><span>흐린 역: 지하철 없음</span><span>📍 출발 · 🚩 목적지 · 채워진 역: 현재 위치</span></div>
    <svg viewBox="0 0 1000 600">`;
  se.forEach((e) => {
    const A = S.nodes[e.a], B = S.nodes[e.b];
    h += `<line class="sline" stroke="${col(e.a)}" x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}"/>
      <text class="stime" x="${(A.x + B.x) / 2}" y="${(A.y + B.y) / 2 - 8}">${edgeTime(e, 'subway')}</text>`;
  });
  S.nodes.forEach((n) => {
    const on = adj[n.id], isCur = n.id === S.cur;
    h += `<circle class="sst ${on ? 'xf' : ''}" cx="${n.x}" cy="${n.y}" r="${on ? 9 : 5}" ${isCur ? 'style="fill:var(--accent)"' : on ? '' : 'style="opacity:.5"'}/>
      <text class="sname ${n.id === S.dest || isCur ? 'me' : ''}" x="${n.x}" y="${n.y + 26}" text-anchor="middle" ${on ? '' : 'style="opacity:.55"'}>${n.name}${n.id === S.dest ? ' 🚩' : ''}${n.id === S.start ? ' 📍' : ''}</text>`;
  });
  h += '</svg>';
  const rows = se.map((e) => `<tr><td>${S.nodes[e.a].name} ↔ ${S.nodes[e.b].name}</td><td>🚇 ${edgeTime(e, 'subway')}</td><td>🚶 ${edgeTime(e, 'walk')}</td><td>🚌 ${edgeTime(e, 'bus')}</td></tr>`).join('');
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
