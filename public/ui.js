'use strict';
// Presentation and navigation only. Game rules and session data remain in game.js/server.js.
(() => {
  let focusOrigin = null;
  let dialog = null;
  let stationOptionsKey = null;
  const modalEl = document.getElementById('modal');
  const subwayEl = document.getElementById('subway');
  const focusables = (root) => [...root.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')].filter((el) => !el.closest('.hidden'));
  const setBackgroundInert = (on) => {
    document.querySelectorAll('.screen').forEach((screen) => { screen.inert = on; });
    if (on && dialog && subwayEl.contains(dialog)) document.getElementById('game').inert = false;
  };
  function focusDialog(target) {
    if (!dialog) focusOrigin = document.activeElement;
    dialog = target;
    setBackgroundInert(true);
    // Keep the close control available, but focus the primary action first.
    (target.querySelector('.primary:not(:disabled)') || focusables(target)[0] || target).focus();
  }
  function releaseDialog() {
    dialog = null;
    setBackgroundInert(false);
    if (focusOrigin?.isConnected && !focusOrigin.closest('.screen:not(.active)')) focusOrigin.focus({ preventScroll: true });
    focusOrigin = null;
  }
  function closeSubway() {
    subwayEl.classList.add('hidden');
    releaseDialog();
  }
  document.addEventListener('route:modal', () => focusDialog(modalEl.querySelector('.modal-box')));
  document.addEventListener('route:modal-closed', releaseDialog);
  document.getElementById('modal-close').onclick = () => closeModal();
  modalEl.addEventListener('click', (e) => { if (e.target === modalEl && !document.getElementById('modal-close').classList.contains('hidden')) closeModal(); });
  document.getElementById('btn-subway').addEventListener('click', () => focusDialog(subwayEl.querySelector('.overlay-box')));
  document.getElementById('subway-close').addEventListener('click', closeSubway);
  subwayEl.addEventListener('click', (e) => { if (e.target === subwayEl) closeSubway(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!modalEl.classList.contains('hidden')) {
        e.preventDefault();
        if (!document.getElementById('modal-close').classList.contains('hidden')) closeModal();
      } else if (dialog && subwayEl.contains(dialog)) {
        e.preventDefault(); closeSubway();
      } else if (!document.getElementById('tutorial').classList.contains('hidden')) {
        endTutorial();
      } else if (sel != null && !busy) {
        sel = null; selMode = null; render(); updateFooter();
      }
    }
    if (e.key === 'Tab' && dialog) {
      const list = focusables(dialog);
      if (!list.length) { e.preventDefault(); dialog.focus(); return; }
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  });

  function sync() {
    document.querySelectorAll('#start button').forEach((button) => { button.disabled = busy; });
    const inGame = document.getElementById('game').classList.contains('active');
    const resumable = (!!S && S.status === 'active') || !!weekBriefing;
    document.getElementById('btn-resume').classList.toggle('hidden', !resumable);
    document.getElementById('resume-note').classList.toggle('hidden', !resumable);
    document.getElementById('btn-play').classList.toggle('primary', !resumable);
    document.getElementById('btn-resume').classList.toggle('primary', resumable);
    const pr = progress();
    const next = levels.find((l) => unlocked(l.id) && !pr[l.id]);
    document.getElementById('btn-play').textContent = Object.keys(pr).length ? next ? `레벨 ${next.id} 도전하기 ↗` : '완료한 여정 다시 둘러보기 ↗' : '첫 등교 시작하기 ↗';
    if (weekBriefing && (!S || S.status !== 'active')) document.getElementById('btn-resume').textContent = '일주일 등교 · 다음 날 준비하기 →';
    else if (resumable) document.getElementById('btn-resume').textContent = `${S.mode === 'level' ? `레벨 ${S.levelId}` : S.mode === 'campaign' ? '캠페인' : S.mode === 'week' ? `${S.week?.name || '일주일 등교'}` : `라운드 ${S.round}`} 이어서 하기 →`;
    if (!S) return;
    document.getElementById('game-context').textContent = S.mode === 'level' ? `레벨 ${S.levelId} · ${S.scenario?.title || ''}` : S.mode === 'campaign' ? S.scenario?.title || '캠페인' : S.mode === 'week' ? `일주일 등교 · ${S.week?.name || ''}` : `무한 모드 · 라운드 ${S.round}`;
    if (S.subwayPreview) document.getElementById('game-context').textContent += ' · 노선 미리보기 (게임용 시간)';
    document.getElementById('current-station').textContent = S.nodes[S.cur].name;
    document.getElementById('destination-station').textContent = S.nodes[S.dest].name;
    document.getElementById('selection-route').textContent = busy ? '여정을 준비하고 있어요…' : S.status !== 'active' ? '여정을 마쳤어요' : sel == null ? '이동할 역을 선택하세요' : `${S.nodes[S.cur].name} → ${S.nodes[sel].name}`;
    document.getElementById('selection-step').textContent = S.status !== 'active' ? 'JOURNEY COMPLETE' : sel == null ? '01 / 역 선택' : busy ? '이동 중…' : '02 / 이동 수단 선택 · 누르면 바로 이동';
    document.getElementById('btn-clear-selection').classList.toggle('hidden', sel == null || busy);
    const available = availableDestinations();
    const optionsKey = `${S.sessionId}:${S.cur}:${sel}:${S.status}:${busy}:${available.join(",")}`;
    if (stationOptionsKey !== optionsKey) {
      const options = document.getElementById('station-options');
      options.replaceChildren();
      available.forEach((id) => {
        const button = document.createElement('button');
        button.className = 'btn small station-option' + (id === sel ? ' selected' : '');
        button.textContent = S.nodes[id].name;
        button.disabled = busy;
        button.setAttribute('aria-pressed', String(id === sel));
        button.onclick = () => map.querySelector(`[data-id="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        options.appendChild(button);
      });
      stationOptionsKey = optionsKey;
    }
    const playing = S.status === 'active' && !busy;
    const noMoves = playing && available.length === 0;
    const selectedBlocked = playing && sel != null && !available.includes(sel);
    const giveup = document.getElementById('btn-giveup');
    const warning = document.getElementById('move-warning');
    const alternative = selectedBlocked && !noMoves ? S.nodes[available[0]].name : '';
    let message = '';
    if (noMoves) message = '남은 시간·교통비·체력으로 이동할 수 있는 역이 없어요. 라운드를 포기하면 같은 지도로 다시 도전할 수 있어요.';
    else if (selectedBlocked) message = '선택한 역으로 갈 수 없어요. ' + alternative + '으로 이동하거나 라운드를 포기할 수 있어요.';
    warning.textContent = message;
    warning.classList.toggle('hidden', !message);
    giveup.classList.toggle('primary', noMoves || selectedBlocked);
    document.getElementById('hud-time').classList.toggle('low-resource', S.limit - S.used <= Math.max(10, S.limit * 0.15));
    if (!inGame) document.getElementById('tutorial').classList.add('hidden');
  }
  document.addEventListener('route:ui', sync);
  document.getElementById('btn-home').onclick = goHome;
  document.getElementById('btn-resume').onclick = () => {
    if (busy) return;
    if (weekBriefing && (!S || S.status !== 'active')) { showWeek(weekBriefing); return; }
    if (!S || S.status !== 'active') return;
    if (sessionCtx) ctx = { ...sessionCtx };
    closeModal(false); show('game'); render(); updateHud(); updateFooter(); setVB();
  };
  document.getElementById('btn-play').onclick = async () => {
    if (!await loadLevels()) return;
    const next = levels.find((l) => unlocked(l.id) && !progress()[l.id]);
    if (next) openLevelCard(next.id); else openLevels();
  };
  document.getElementById('btn-clear-selection').onclick = () => { sel = null; selMode = null; render(); updateFooter(); };
  document.getElementById('btn-locate').onclick = () => { if (S) zoomTo(S.nodes[S.cur].x, S.nodes[S.cur].y, 0.65, 250); };
  document.getElementById('btn-destination').onclick = () => { if (S) zoomTo(S.nodes[S.dest].x, S.nodes[S.dest].y, 0.65, 250); };
  // Preserve one app entry in browser history; Back returns to home before leaving the page.
  const entry = window.history.state;
  if (!entry?.routeApp) {
    window.history.replaceState({ routeApp: true, screen: 'start' }, '', window.location.href);
    window.history.pushState({ routeApp: true, screen: 'app' }, '', window.location.href);
  }
  window.addEventListener('popstate', () => {
    if (busy) { window.history.pushState({ routeApp: true, screen: 'app' }, '', window.location.href); notify('처리가 끝나면 홈으로 이동할 수 있어요.'); return; }
    if (!document.getElementById('start').classList.contains('active') || !modalEl.classList.contains('hidden')) {
      goHome();
      window.history.pushState({ routeApp: true, screen: 'app' }, '', window.location.href);
    }
  });
  sync();
  api('/api/routes').then((data) => { levels = data.levels; personas = data.personas; sync(); }).catch(() => {});
})();
