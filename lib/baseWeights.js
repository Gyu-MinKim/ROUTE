'use strict';

// 서버 전용: 실제 대중교통 경로 조회 결과를 게임 간선별 '기본 가중치'로 정리한다.
// WALK 구간은 버스·지하철 접근/환승에 포함될 수 있지만, 단독 WALK 경로가
// 아닌 이상 도보 이동의 실제 소요 시간으로 취급하지 않는다.
const MODES = ['walk', 'bus', 'subway'];

function blank(edge, nodes) {
  const from = nodes[edge.a];
  const to = nodes[edge.b];
  return {
    edgeId: edge.id,
    a: edge.a,
    b: edge.b,
    from: from.stationName || from.name,
    to: to.stationName || to.name,
    direction: 'a-to-b', // 현재 그래프는 무방향이지만, 실제 소요 시간은 방향별로 다를 수 있다.
    virtual: { ...edge.opts },
    base: { walk: null, bus: null, subway: null },
    fare: { walk: null, bus: null, subway: null },
    routeIndex: { walk: null, bus: null, subway: null },
    candidates: [],
    status: 'pending',
  };
}

function parseWeight(edge, nodes, data) {
  const result = blank(edge, nodes);
  const routes = Array.isArray(data?.routes) ? data.routes : [];

  routes.forEach((route, index) => {
    const minutes = Number(route.totalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;

    const modes = new Set(
      (Array.isArray(route.steps) ? route.steps : [])
        .map((step) => step.mode)
        .filter((mode) => mode === 'bus' || mode === 'subway')
    );
    // 버스+지하철 혼합 경로는 둘 중 하나의 전용 가중치로 넣지 않는다.
    let mode = null;
    if (modes.size === 1) mode = [...modes][0];
    else if (modes.size === 0 && route.steps?.length > 0 &&
      route.steps.every((step) => step.mode === 'walk')) mode = 'walk';

    const fareValue = Number(route.fare);
    // API 응답에 운임이 없어 0으로 파싱된 경우를 '무료'로 해석하지 않는다.
    const fare = mode === 'walk' ? 0 :
      (Number.isFinite(fareValue) && fareValue > 0 ? fareValue : null);

    result.candidates.push({
      routeIndex: Number.isInteger(route.index) ? route.index : index,
      type: route.type || null,
      mode,
      minutes,
      fare,
      transfers: Number(route.transfers) || 0,
    });

    if (!mode || !MODES.includes(mode)) return;
    if (result.base[mode] === null || minutes < result.base[mode]) {
      result.base[mode] = minutes;
      result.fare[mode] = fare;
      result.routeIndex[mode] = Number.isInteger(route.index) ? route.index : index;
    }
  });

  result.status = MODES.some((mode) => result.base[mode] !== null) ? 'ok' : 'no_single_mode_route';
  return result;
}

function errorWeight(edge, nodes, errorCode) {
  const result = blank(edge, nodes);
  result.status = 'error';
  result.error = errorCode;
  return result;
}

module.exports = { parseWeight, errorWeight };
