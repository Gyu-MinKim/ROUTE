'use strict';

// 카카오 REST API 접근은 서버에서만 수행한다.
const STATION_SEARCH_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';
const TRANSIT_URL = 'https://dapi.kakao.com/v2/routing/publictraffic';

class KakaoTransitError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = 'KakaoTransitError';
    this.status = status;
  }
}

function stationName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[가-힣0-9\s]{2,20}$/.test(name)) throw new KakaoTransitError('invalid_station_name', 400);
  return name.endsWith('역') ? name : name + '역';
}

function isValidCoord(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) && x >= 124 && x <= 132 && y >= 33 && y <= 39;
}

async function requestKakao(url, apiKey, fetcher = fetch) {
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
    throw new KakaoTransitError('kakao_upstream_error', 502);
  }
  try {
    return await response.json();
  } catch {
    throw new KakaoTransitError('kakao_invalid_response', 502);
  }
}

async function searchStation(value, apiKey, fetcher) {
  const name = stationName(value);
  const url = new URL(STATION_SEARCH_URL);
  url.searchParams.set('query', name);
  url.searchParams.set('category_group_code', 'SW8'); // 지하철역
  url.searchParams.set('size', '15');
  const data = await requestKakao(url, apiKey, fetcher);
  const docs = Array.isArray(data.documents) ? data.documents : [];
  const norm = (s) => String(s || '').replace(/\s|\([^)]*\)/g, '');
  // 같은 이름을 우선 사용하고, 없다면 실제 역으로 식별되는 검색 결과만 허용한다.
  const place = docs.find((d) => norm(d.place_name) === norm(name)) ||
    docs.find((d) => norm(d.place_name).startsWith(norm(name)));
  const x = Number(place?.x), y = Number(place?.y);
  if (!place || !isValidCoord(x, y)) throw new KakaoTransitError('station_not_found', 404);
  return { name: place.place_name, x, y };
}

function summarizeRoute(route, index) {
  const props = route.properties || {};
  const modeMap = { SUBWAY: 'subway', BUS: 'bus', WALKING: 'walk' };
  return {
    index,
    type: props.type || null,
    totalSeconds: Number(props.totalTime) || 0,
    totalMinutes: Math.ceil((Number(props.totalTime) || 0) / 60),
    distanceMeters: Number(props.totalDistance) || 0,
    transfers: Number(props.transfers) || 0,
    fare: Number(props.fare?.value ?? props.fare?.min ?? 0),
    steps: (Array.isArray(route.steps) ? route.steps : []).slice(0, 100).map((step) => {
      const p = step.properties || {};
      const points = Array.isArray(step.path?.points) ? step.path.points : [];
      return {
        mode: modeMap[p.type] || 'unknown',
        guidance: typeof p.guidance === 'string' ? p.guidance.slice(0, 200) : '',
        seconds: Number(p.time) || 0,
        distanceMeters: Number(p.distance) || 0,
        stops: Array.isArray(p.stops) ? p.stops.slice(0, 40).map((s) => String(s.name || '')) : [],
        vehicles: Array.isArray(p.vehicles) ? p.vehicles.slice(0, 12).map((v) => String(v.name || '')) : [],
        points: points.slice(0, 4000).filter((xy) => Array.isArray(xy) && isValidCoord(Number(xy[0]), Number(xy[1])))
          .map((xy) => [Number(xy[0]), Number(xy[1])]),
      };
    }),
  };
}

async function getTransitRoutes(from, to, apiKey, fetcher) {
  if (!apiKey) throw new KakaoTransitError('kakao_key_missing', 503);
  const [origin, destination] = await Promise.all([
    searchStation(from, apiKey, fetcher),
    searchStation(to, apiKey, fetcher),
  ]);
  if (origin.x === destination.x && origin.y === destination.y) {
    throw new KakaoTransitError('same_station', 400);
  }

  const url = new URL(TRANSIT_URL);
  url.searchParams.set('start_x', String(origin.x));
  url.searchParams.set('start_y', String(origin.y));
  url.searchParams.set('end_x', String(destination.x));
  url.searchParams.set('end_y', String(destination.y));
  url.searchParams.set('s_name', stationName(from));
  url.searchParams.set('e_name', stationName(to));
  const data = await requestKakao(url, apiKey, fetcher);
  if (data.status !== 'OK' || !Array.isArray(data.routes) || !data.routes.length) {
    throw new KakaoTransitError('transit_no_results', 404);
  }
  return {
    source: 'kakao',
    origin, destination,
    routes: data.routes.slice(0, 3).map(summarizeRoute),
  };
}

module.exports = { KakaoTransitError, stationName, getTransitRoutes, summarizeRoute };
