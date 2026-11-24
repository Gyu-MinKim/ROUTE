'use strict';

// REST API 키는 서버 환경변수에만 보관한다.
const STATION_SEARCH_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const TRANSIT_URL = 'https://apis-navi.kakaomobility.com/affiliate/publictransit/v1/multimodal/directions';
const WALK_URL = 'https://apis-navi.kakaomobility.com/affiliate/walking/v1/directions';

class KakaoTransitError extends Error {
  constructor(code, status = 502) { super(code); this.name = 'KakaoTransitError'; this.status = status; }
}

function stationName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[가-힣0-9\s]{2,20}$/.test(name)) throw new KakaoTransitError('invalid_station_name', 400);
  return name.endsWith('역') ? name : name + '역';
}
function validCoord(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 124 && x <= 132 && y >= 33 && y <= 39;
}
function checkedPoint(point) {
  const x = Number(point?.lng ?? point?.x);
  const y = Number(point?.lat ?? point?.y);
  if (!validCoord(x, y)) throw new KakaoTransitError('invalid_coordinates', 400);
  const name = stationName(point?.stationName ?? point?.name ?? '출발역');
  return { x, y, name };
}

async function requestKakao(url, apiKey, fetcher = globalThis.fetch) {
  if (!apiKey) throw new KakaoTransitError('kakao_key_missing', 503);
  let response;
  try {
    response = await fetcher(url, {
      headers: { Authorization: `KakaoAK ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(9000),
    });
  } catch (error) {
    const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new KakaoTransitError(timeout ? 'kakao_timeout' : 'kakao_unreachable', 504);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new KakaoTransitError('kakao_auth_failed', 502);
    if (response.status === 429) throw new KakaoTransitError('kakao_rate_limited', 429);
    if (response.status === 400) {
      const body = await response.json().catch(() => null);
      if (body?.code === -10 && [body.message, body.msg].includes('API limit has been exceeded.'))
        throw new KakaoTransitError('kakao_rate_limited', 429);
    }
    const error = new KakaoTransitError('kakao_upstream_error', 502);
    error.upstreamStatus = response.status;
    throw error;
  }
  try { return await response.json(); }
  catch { throw new KakaoTransitError('kakao_invalid_response', 502); }
}

async function searchStation(value, apiKey, fetcher) {
  const name = stationName(value);
  const url = new URL(STATION_SEARCH_URL);
  url.searchParams.set('query', name);
  url.searchParams.set('category_group_code', 'SW8');
  url.searchParams.set('size', '15');
  const data = await requestKakao(url, apiKey, fetcher);
  const norm = (s) => String(s || '').replace(/\s|\([^)]*\)/g, '');
  const docs = Array.isArray(data.documents) ? data.documents : [];
  // 기존 코드의 동명이역 검색 문제에 대비해 좌표 기반 조회를 우선 권장한다.
  const place = docs.find(d => norm(d.place_name) === norm(name)) ||
    docs.find(d => norm(d.place_name).startsWith(norm(name)));
  const x = Number(place?.x), y = Number(place?.y);
  if (!place || !validCoord(x, y)) throw new KakaoTransitError('station_not_found', 404);
  return { name: place.place_name, x, y };
}

function routeUrl(base, start, end, originKey, destinationKey) {
  const a = checkedPoint(start), b = checkedPoint(end);
  if (a.x === b.x && a.y === b.y) throw new KakaoTransitError('same_station', 400);
  const url = new URL(base);
  url.searchParams.set(originKey, [a.x, a.y].join(','));
  url.searchParams.set(destinationKey, [b.x, b.y].join(','));
  return url;
}

function summarizeRoute(journey, index) {
  const summary = journey.summary;
  if (!Number.isInteger(summary?.total_time) || summary.total_time <= 0 ||
      !Number.isInteger(summary.transfer_count) || summary.transfer_count < 0 ||
      !Array.isArray(journey.sections) || !journey.sections.length ||
      !Array.isArray(summary.transport_type) || summary.transport_type.some(type => typeof type !== 'string')) return null;
  if (journey.sections.some(section => !section || (section.passing_stops != null && !Array.isArray(section.passing_stops)))) return null;
  const result = {
    index, type: summary.transport_type.join('+'),
    totalSeconds: summary.total_time, totalMinutes: Math.ceil(summary.total_time / 60),
    distanceMeters: summary.distance, transfers: summary.transfer_count, fare: null,
    steps: journey.sections.map(section => {
      const route = section.route || {};
      const mode = route.route_short_name === 'Walk' ? 'walk'
        : route.branch_id ? 'subway' : route.route_id && !route.train_type ? 'bus' : 'unknown';
      const stops = [section.departure_stop, ...(section.passing_stops || []), section.arrival_stop];
      const path = Array.isArray(section.path) ? section.path : [];
      const points = [];
      for (let i = 0; i + 1 < path.length && i < 8000; i += 2) {
        if (validCoord(path[i], path[i + 1])) points.push([path[i], path[i + 1]]);
      }
      return { mode, guidance: route.route_full_name || '', seconds: section.time,
        distanceMeters: section.distance, stops: stops.map(stop => stop?.stop_name || ''),
        boardable: section.departure_stop?.boardable === true && section.arrival_stop?.boardable === true,
        vehicles: [route.route_short_name], vehicleTypes: [route.vehicle_type_name],
        routeId: route.route_id, points };
    }),
  };
  const declared = new Set(summary.transport_type.map(type => type.toLowerCase()).filter(type => type !== 'walk'));
  const transit = new Set(result.steps.map(step => step.mode).filter(mode => mode !== 'walk'));
  return declared.size === transit.size && [...transit].every(mode => declared.has(mode)) ? result : null;
}

async function getTransitRoutesFromCoords(start, end, apiKey, fetcher, routeType = 'All') {
  const origin = checkedPoint(start), destination = checkedPoint(end);
  const url = routeUrl(TRANSIT_URL, start, end, 'start', 'goal');
  url.searchParams.set('route_type', routeType);
  const data = await requestKakao(url, apiKey, fetcher);
  if (!Number.isInteger(data?.result_code)) throw new KakaoTransitError('kakao_invalid_response');
  if (data.result_code !== 0) return { source: 'kakao-publictraffic', origin, destination,
    routes: [], providerResultCode: data.result_code };
  if (!Array.isArray(data.journeys)) throw new KakaoTransitError('kakao_invalid_response');
  const routes = data.journeys.map(summarizeRoute).filter(Boolean);
  if (!routes.length && data.journeys.length) throw new KakaoTransitError('kakao_invalid_response');
  return { source: 'kakao-publictraffic', origin, destination, routes,
    evidence: { url: url.href, observedAt: new Date().toISOString() } };
}

// 기존 호출 형태 유지: 서버의 /api/kakao/transit에서 계속 사용.
async function getTransitRoutes(from, to, apiKey, fetcher) {
  if (!apiKey) throw new KakaoTransitError('kakao_key_missing', 503);
  const [origin, destination] = await Promise.all([
    searchStation(from, apiKey, fetcher), searchStation(to, apiKey, fetcher),
  ]);
  return getTransitRoutesFromCoords({ ...origin, stationName: from }, { ...destination, stationName: to }, apiKey, fetcher);
}

async function getWalkRouteFromCoords(start, end, apiKey, fetcher) {
  const url = routeUrl(WALK_URL, start, end, 'origin', 'destination');
  url.searchParams.set('summary', 'true');
  const data = await requestKakao(url, apiKey, fetcher);
  const route = data?.routes?.[0];
  if (!Number.isInteger(route?.result_code)) throw new KakaoTransitError('kakao_invalid_walk_response');
  if (route.result_code !== 0) return { source: 'kakao-walk', status: 'unavailable',
    reason: 'kakao_walk_result_' + route.result_code, totalMinutes: null, totalSeconds: null, distanceMeters: null };
  const { duration, distance } = route.summary || {};
  if (!Number.isInteger(duration) || duration <= 0) throw new KakaoTransitError('kakao_invalid_walk_response');
  return { source: 'kakao-walk', status: 'ok', totalSeconds: duration, totalMinutes: Math.ceil(duration / 60),
    distanceMeters: Number.isFinite(distance) && distance >= 0 ? distance : null,
    evidence: { url: url.href, observedAt: new Date().toISOString() } };
}

module.exports = {
  KakaoTransitError, requestKakao, stationName, getTransitRoutes, getTransitRoutesFromCoords,
  getWalkRouteFromCoords, summarizeRoute, checkedPoint, searchStation,
};
