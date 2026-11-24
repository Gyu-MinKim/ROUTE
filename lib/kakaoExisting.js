"use strict";

// This adapter uses the request and response format from ROUTE's Step 7
// integration. The documented Kakao Mobility affiliate API has a separate adapter.
const { KakaoTransitError, checkedPoint, requestKakao, searchStation } = require('./kakaoTransit');
const modeNames = { WALKING: 'walk', BUS: 'bus', SUBWAY: 'subway' };
const host = 'https://dapi.kakao.com';

function routeRequest(mode, start, end) {
  const url = new URL('/v2/routing/' + mode, host);
  if (start.x === end.x && start.y === end.y) throw new KakaoTransitError('same_station', 400);
  for (const [key, value] of Object.entries({
    start_x: start.x, start_y: start.y, end_x: end.x, end_y: end.y,
    s_name: start.name, e_name: end.name,
  })) url.searchParams.set(key, value);
  return url;
}

function summarize(route, index) {
  const p = route?.properties;
  if (!Number.isSafeInteger(p?.totalTime) || p.totalTime <= 0 ||
      !Number.isInteger(p.transfers) || p.transfers < 0 || !Array.isArray(route.steps) || !route.steps.length) return null;
  const fare = p.fare?.value;
  return {
    index, type: p.type, totalSeconds: p.totalTime, totalMinutes: Math.ceil(p.totalTime / 60),
    distanceMeters: p.totalDistance, transfers: p.transfers,
    fare: Number.isSafeInteger(fare) && fare > 0 ? fare : null,
    steps: route.steps.map(step => {
      const s = step?.properties || {};
      const stops = Array.isArray(s.stops) ? s.stops : [];
      const vehicles = Array.isArray(s.vehicles) ? s.vehicles : [];
      return {
        mode: modeNames[s.type] || 'unknown', guidance: s.guidance || '', seconds: s.time,
        distanceMeters: s.distance, stops: stops.map(stop => stop?.name || ''),
        vehicles: vehicles.map(vehicle => vehicle?.name || ''),
        vehicleTypes: vehicles.map(vehicle => vehicle?.type || ''),
        routeId: vehicles[0]?.name,
        boardable: stops.length >= 2 && Boolean(stops[0]?.name && stops.at(-1)?.name) &&
          vehicles.some(vehicle => vehicle?.name),
        points: Array.isArray(step?.path?.points) ? step.path.points.filter(point =>
          Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) : [],
      };
    }),
  };
}

async function transit(start, end, key, fetcher) {
  const origin = checkedPoint(start), destination = checkedPoint(end);
  const url = routeRequest('publictraffic', origin, destination);
  const data = await requestKakao(url, key, fetcher);
  if (data?.status !== 'OK' || !Array.isArray(data.routes)) throw new KakaoTransitError('kakao_invalid_response');
  const routes = data.routes.map(summarize).filter(Boolean);
  if (data.routes.length && !routes.length) throw new KakaoTransitError('kakao_invalid_response');
  return { source: 'kakao-existing-transit', origin, destination, routes,
    evidence: { url: url.href, observedAt: new Date().toISOString() } };
}

async function byStation(from, to, key, fetcher) {
  const [origin, destination] = await Promise.all([searchStation(from, key, fetcher), searchStation(to, key, fetcher)]);
  return transit({ ...origin, stationName: from }, { ...destination, stationName: to }, key, fetcher);
}

async function walk(start, end, key, fetcher) {
  const url = routeRequest('walk', checkedPoint(start), checkedPoint(end));
  const data = await requestKakao(url, key, fetcher);
  if (data?.status === 'TOO_FAR_AWAY') return { status: 'unavailable', reason: 'no_route' };
  const { totalTime, totalDistance } = data?.route?.properties || {};
  if (data?.status !== 'OK' || !Number.isSafeInteger(totalTime) || totalTime <= 0)
    throw new KakaoTransitError('kakao_invalid_walk_response');
  return { status: 'ok', totalSeconds: totalTime, totalMinutes: Math.ceil(totalTime / 60),
    distanceMeters: Number.isFinite(totalDistance) && totalDistance >= 0 ? totalDistance : null,
    evidence: { url: url.href, observedAt: new Date().toISOString() } };
}

module.exports = { transit, walk, byStation };
