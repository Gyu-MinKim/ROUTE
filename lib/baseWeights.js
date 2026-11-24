'use strict';
// 실제 카카오 결과만 baseWeights에 기록한다. 없는 값은 절대로 임의로 채우지 않는다.
const { network } = require('./subwayNetwork');
const { busBaseForTypes, ADULT_CARD_BASE } = require('./farePolicy');
const MODES = ['walk', 'bus', 'subway'];
function blank(edge, nodes, direction = 'a-to-b') {
  const from = nodes[direction === 'a-to-b' ? edge.a : edge.b];
  const to = nodes[direction === 'a-to-b' ? edge.b : edge.a];
  return {
    edgeId: edge.id, a: edge.a, b: edge.b,
    from: from.stationName || from.name, to: to.stationName || to.name,
    direction, virtual: { ...edge.opts },
    base: { walk: null, bus: null, subway: null },
    fare: { walk: null, bus: null, subway: null },
    fareSource: { walk: null, bus: null, subway: null },
    officialBusBaseFare: null,
    gameFare: { walk: null, bus: null, subway: null },
    gameFareSource: { walk: null, bus: null, subway: null },
    rideMinutes: null,
    routeIndex: { walk: null, bus: null, subway: null },
    modeStatus: { walk: 'not_queried', bus: 'not_in_recommended_routes', subway: 'not_in_recommended_routes' },
    candidates: [], status: 'pending',
  };
}
const lineAliases = { S: ['신분당', '신분당선'], K: ['경의중앙', '경의중앙선'], B: ['수인분당', '수인분당선'] };
const normalize = name => String(name || '').replace(/\([^)]*\)|[·\s]/g, '');
const station = name => normalize(name).replace(/역$/, '');
const busTypes = { BLUE: '간선', GREEN: '지선', RED: '광역', YELLOW: '순환', MAUL: '마을' };

function matchesSubway(edge, step, direction) {
  const shortName = normalize(step.vehicles?.[0]);
  const names = lineAliases[edge.lineId] || [edge.lineId + '호선'];
  if (!edge.stationPath || !names.includes(shortName)) return false;
  const expected = edge.stationPath.map(id => station(network.stations[id]?.stationName));
  if (direction === 'b-to-a') expected.reverse();
  const actual = step.stops?.map(station);
  return actual?.length === expected.length && actual.every((name, i) => name && name === expected[i]);
}

function parseWeight(edge, nodes, data, direction = 'a-to-b') {
  const result = blank(edge, nodes, direction);
  const routes = Array.isArray(data?.routes) ? data.routes : [];
  routes.forEach((route, index) => {
    const minutes = Number(route.totalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const steps = Array.isArray(route.steps) ? route.steps : [];
    const modes = steps.filter(step => step.mode === 'bus' || step.mode === 'subway');
    // 한 간선에서 숨겨진 버스/지하철 환승을 허용하지 않는다.
    // 접근/하차 WALK는 버스/지하철 시간에 포함된다.
    const hasUnknown = steps.some(step => !['walk', 'bus', 'subway'].includes(step.mode));
    let mode = !hasUnknown && modes.length === 1 && Number(route.transfers || 0) === 0
      ? modes[0].mode : null;
    const step = modes[0];
    const existing = data.source === 'kakao-existing-transit';
    const official = existing || data.source === 'kakao-publictraffic';
    if (official && (step?.boardable !== true ||
        (mode === 'subway' && ((edge.lineId && !matchesSubway(edge, step, direction)) ||
          !Number.isInteger(step.seconds) || step.seconds <= 0 || step.seconds > route.totalSeconds)))) mode = null;
    const fareValue = Number(route.fare);
    const fare = Number.isFinite(fareValue) && fareValue > 0 ? fareValue : null;
    const types = modes.length === 1 && mode === 'bus' ? (step.vehicleTypes || []).map(type => busTypes[type] || type) : [];
    const officialBusBaseFare = busBaseForTypes(types);
    const routeIndex = Number.isInteger(route.index) ? route.index : index;
    result.candidates.push({routeIndex, type: route.type || null, mode, minutes, fare,
      officialBusBaseFare, transfers: Number(route.transfers) || 0 });
    if (!mode || !MODES.includes(mode)) return;
    const preferVerifiedFare = existing && mode === 'bus' && result.base.bus !== null;
    const candidateHasFare = fare !== null, selectedHasFare = result.fare.bus !== null;
    const preferCandidate = preferVerifiedFare && candidateHasFare !== selectedHasFare
      ? candidateHasFare : result.base[mode] === null || minutes < result.base[mode];
    if (preferCandidate) {
      result.base[mode] = minutes;
      result.fare[mode] = fare;
      // Official card base charges are the game tariff. The provider's journey fare stays separate.
      result.gameFare[mode] = official
        ? (mode === 'subway' ? ADULT_CARD_BASE.subway : existing ? fare : officialBusBaseFare) : fare;
      result.gameFareSource[mode] = result.gameFare[mode] == null ? null :
        official && !(existing && mode === 'bus') ? 'official-card-base' : 'kakao-route';
      if (mode === 'subway' && official) result.rideMinutes = Math.ceil(step.seconds / 60);
      if (official && route.evidence && Number.isSafeInteger(route.totalSeconds) &&
          (mode === 'subway' || typeof step.routeId === 'string' && step.routeId)) {
        result.capture ??= {};
        const record = { seconds: route.totalSeconds, evidence: route.evidence };
        if (mode === 'subway') record.rideSeconds = step.seconds;
        else {
          record.routeId = step.routeId;
          if (existing && fare !== null) record.routeFare = fare;
        }
        result.capture[mode] = record;
      }
      result.fareSource[mode] = fare === null ? null : 'kakao-route';
      result.routeIndex[mode] = routeIndex;
      result.modeStatus[mode] = 'ok';
      if (mode === 'bus') result.officialBusBaseFare = officialBusBaseFare;
    }
  });
  result.status = MODES.some(mode => result.base[mode] !== null) ? 'ok' : 'no_single_mode_route';
  return result;
}
function setWalking(result, walking) {
  if (walking?.status === 'ok' && Number.isFinite(walking.totalMinutes) && walking.totalMinutes > 0) {
    result.base.walk = walking.totalMinutes;
    result.fare.walk = 0;
    result.gameFare.walk = 0;
    result.gameFareSource.walk = 'walking-free';
    result.fareSource.walk = 'walking-free';
    result.modeStatus.walk = 'ok';
    if (walking.evidence && Number.isSafeInteger(walking.totalSeconds)) {
      result.capture ??= {};
      result.capture.walk = { seconds: walking.totalSeconds, evidence: walking.evidence };
    }
  } else {
    result.modeStatus.walk = walking?.status === 'unavailable' ? walking.reason : 'walk_query_failed';
  }
  result.status = MODES.some(mode => result.base[mode] !== null) ? 'ok' : result.status;
  return result;
}
function errorWeight(edge, nodes, errorCode, direction = 'a-to-b') {
  const result = blank(edge, nodes, direction);
  result.status = 'error'; result.error = errorCode;
  return result;
}
module.exports = { blank, parseWeight, errorWeight, setWalking };
