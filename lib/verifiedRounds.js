"use strict";

const fs = require('node:fs/promises');
const { network, getNeighbors } = require('./subwayNetwork');
const { positionsFor, allowedLinesFor } = require('./subwayGraph');
const { blank } = require('./baseWeights');
const { ADULT_CARD_BASE, shinbundangSections } = require('./farePolicy');
const { MODE_IDS, roundParams, roundCandidates } = require('./engine');

class VerifiedRoundError extends Error {
  constructor(code, status = 422) {
    super(code);
    this.status = status;
  }
}

function check(condition) {
  if (!condition) throw new VerifiedRoundError('verified_data_invalid');
}

function evidence(value) {
  check(typeof value?.url === 'string' && typeof value.observedAt === 'string' &&
    Number.isFinite(Date.parse(value.observedAt)));
  let url;
  try { url = new URL(value.url); }
  catch { throw new VerifiedRoundError('verified_data_invalid'); }
  check(url.protocol === 'https:' && !url.username && !url.password &&
    ![...url.searchParams.keys()].some(key => /key|token|secret|auth|password/i.test(key)));
  return { url: value.url, observedAt: value.observedAt };
}

function directionalWeight(edge, nodes, record, direction) {
  const result = blank(edge, nodes, direction);
  result.source = 'stored-verified-route';
  for (const mode of MODE_IDS) {
    const route = record?.[mode];
    result.modeStatus[mode] = 'not_recorded';
    if (route == null) continue;
    if (route.status === 'no_route' || route.status === 'lookup_failed') {
      result.modeStatus[mode] = route.status;
      continue;
    }
    check(Number.isSafeInteger(route.seconds) && route.seconds > 0);
    result.evidence ??= {};
    result.evidence[mode] = evidence(route.evidence);
    result.base[mode] = Math.ceil(route.seconds / 60);
    if (mode === 'subway') {
      check(edge.lineId && Number.isSafeInteger(route.rideSeconds) &&
        route.rideSeconds > 0 && route.rideSeconds <= route.seconds);
      result.rideMinutes = Math.ceil(route.rideSeconds / 60);
      result.gameFare.subway = ADULT_CARD_BASE.subway;
      result.gameFareSource.subway = 'official-card-base';
    } else if (mode === 'bus') {
      check(typeof route.routeId === 'string' && route.routeId.trim());
      result.busRouteId = route.routeId;
      if (route.routeFare != null) {
        check(Number.isSafeInteger(route.routeFare) && route.routeFare > 0);
        result.fare.bus = result.gameFare.bus = route.routeFare;
        result.fareSource.bus = result.gameFareSource.bus = 'kakao-route';
      } else if (route.cardBaseFare != null) {
        check(Number.isSafeInteger(route.cardBaseFare) && route.cardBaseFare > 0);
        result.evidence.busFare = evidence(route.fareEvidence);
        result.gameFare.bus = route.cardBaseFare;
        result.gameFareSource.bus = 'verified-card-base';
      }
    } else {
      result.fare.walk = result.gameFare.walk = 0;
      result.fareSource.walk = result.gameFareSource.walk = 'walking-free';
    }
    result.modeStatus[mode] = result.gameFare[mode] == null ? 'fare_unverified' : 'ok';
  }
  result.status = Object.values(result.modeStatus).includes('ok') ? 'ok' : 'no_verified_route';
  return result;
}

function buildStoredGraph(map, params, mods) {
  check(Array.isArray(map.stationIds) && Array.isArray(map.edges) &&
    map.stationIds.length >= 2 && map.stationIds.length <= 35 && map.edges.length <= 120);
  const ids = map.stationIds;
  check(new Set(ids).size === ids.length && ids.every(id => typeof id === 'string' && Object.hasOwn(network.stations, id)));
  const positions = positionsFor(ids);
  const nodes = ids.map((stationId, id) => {
    const { stationName, lat, lng, lineIds, isTransfer, isTransferWithinNetwork } = network.stations[stationId];
    return { id, stationId, name: stationName, stationName, lat, lng, lineIds,
      isTransfer, isTransferWithinNetwork, ...positions.get(stationId) };
  });
  const start = ids.indexOf(map.start), dest = ids.indexOf(map.dest);
  check(start >= 0 && dest >= 0 && start !== dest);
  const allowedLines = allowedLinesFor(params);
  const adj = nodes.map(() => []), verifiedWeights = [], pairs = new Set();
  const edges = map.edges.map((record, id) => {
    const a = ids.indexOf(record?.from), b = ids.indexOf(record?.to);
    check(a >= 0 && b >= 0 && a !== b);
    const lineId = record.lineId ?? null, stationPath = record.stationPath ?? null;
    const pair = [Math.min(a, b), Math.max(a, b), lineId].join(':');
    check(!pairs.has(pair));
    pairs.add(pair);
    if (lineId !== null) {
      check(allowedLines.has(lineId) && Array.isArray(stationPath) &&
        stationPath[0] === record.from && stationPath.at(-1) === record.to &&
        new Set(stationPath).size === stationPath.length &&
        stationPath.slice(1).every((next, i) => getNeighbors(stationPath[i])
          .some(arc => arc.stationId === next && arc.lineId === lineId)));
    } else check(stationPath === null);
    const edge = { id, a, b, lineId, stationPath, opts: {}, weightSource: 'stored-verified-route' };
    if (lineId === 'S') edge.premiumSections = shinbundangSections(stationPath);
    const forward = directionalWeight(edge, nodes, record.forward, 'a-to-b');
    const reverse = directionalWeight(edge, nodes, record.reverse, 'b-to-a');
    const times = direction => Object.fromEntries(MODE_IDS.map(mode =>
      [mode, direction.gameFare[mode] == null ||
        (mode === 'subway' && mods.subwayOff) ||
        (mode === 'bus' && !params.busEnabled && !mods.subwayOff) ? null : direction.base[mode]]));
    edge.directionalOpts = { forward: times(forward), reverse: times(reverse) };
    for (const mode of MODE_IDS) edge.opts[mode] = edge.directionalOpts.forward[mode] ?? edge.directionalOpts.reverse[mode];
    verifiedWeights.push({ ...forward, reverse, appliedToGame: true });
    adj[a].push(edge);
    adj[b].push(edge);
    return edge;
  });
  return { nodes, edges, adj, verifiedWeights, startCandidates: [start], destCandidates: [dest] };
}

async function readVerifiedData(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new VerifiedRoundError('verified_data_missing', 503);
    throw new VerifiedRoundError('verified_data_unreadable', 503);
  }
  let archive;
  try { archive = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new VerifiedRoundError('verified_data_invalid'); }
  return archive;
}

async function newStoredRound(file, { mode, round, scenario }) {
  const archive = await readVerifiedData(file);
  check(archive?.version === 1 && Array.isArray(archive.maps));
  const matching = archive.maps.filter(map => map?.mode === mode &&
    (mode === 'endless' ? map.round === round : map.scenarioId === scenario?.id ||
      (mode === 'level' && map.levelId === scenario?.id)));
  if (!matching.length) throw new VerifiedRoundError('verified_level_data_missing', 422);
  const params = roundParams(scenario?.round ?? round);
  const graphs = matching.slice(0, 8).map(map => buildStoredGraph(map, params, scenario?.mods || {}));
  const result = roundCandidates({ round, scenario, verified: true, storedGraphs: graphs }).next().value;
  if (result) return result;
  const statuses = new Set(graphs.flatMap(graph => graph.verifiedWeights.flatMap(weight =>
    [weight, weight.reverse].flatMap(direction => Object.values(direction.modeStatus)))));
  if (statuses.has('lookup_failed')) throw new VerifiedRoundError('verified_lookup_incomplete');
  if (statuses.has('ok') || statuses.has('fare_unverified')) throw new VerifiedRoundError('no_playable_verified_route');
  throw new VerifiedRoundError(statuses.has('no_route') ? 'no_verified_route' : 'verified_level_weights_missing');
}

function archiveFromSession(session) {
  const { graph, mode, levelId, scenario, round, start, dest } = session;
  const ids = graph.nodes.map(node => node.stationId);
  const map = {
    mode, ...(mode === 'level' ? { levelId } : mode === 'endless' ? { round } : { scenarioId: scenario.id }),
    stationIds: ids, start: ids[start], dest: ids[dest],
    edges: graph.edges.map(edge => {
      const weight = graph.verifiedWeights[edge.id];
      const dir = result => {
        const records = { ...result?.capture };
        for (const mode of MODE_IDS) {
          if (!records[mode] && (result?.status === 'error' || result?.modeStatus[mode]?.startsWith('error:')))
            records[mode] = { status: 'lookup_failed' };
        }
        return records;
      };
      return { from: ids[edge.a], to: ids[edge.b],
        ...(edge.lineId ? { lineId: edge.lineId, stationPath: edge.stationPath } : {}),
        forward: dir(weight), reverse: dir(weight?.reverse) };
    }),
  };
  return { version: 1, maps: [map] };
}

module.exports = { readVerifiedData, buildStoredGraph, newStoredRound, VerifiedRoundError, archiveFromSession };
