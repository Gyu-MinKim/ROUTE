'use strict';

const { network, getLineEdges } = require('./subwayNetwork');
const { allowedLinesFor } = require('./subwayGraph');
const { roundParams, roundCandidates } = require('./engine');
const { readVerifiedData, buildStoredGraph, VerifiedRoundError } = require('./verifiedRounds');

function shuffled(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// OA-12034 gives running time to the station in the current row.
function publicRailSegments(catalog) {
  const source = require('../data/seoulMetroTimes.json');
  const times = new Map(source.legs.map(([line, from, to, seconds]) =>
    [JSON.stringify([line, from, to]), seconds]));
  const name = id => network.stations[id].name;
  const records = catalog.map(edge => ({ ...edge, forward: { ...edge.forward }, reverse: { ...edge.reverse } }));
  const key = (line, a, b) => [line, ...[a, b].sort()].join('|');
  const covered = new Set(records.filter(e => e.lineId && e.stationPath?.length === 2)
    .map(e => key(e.lineId, e.from, e.to)));
  for (const { from, to, lineId } of getLineEdges()) {
    if (!covered.has(key(lineId, from, to)))
      records.push({ from, to, lineId, stationPath: [from, to], forward: {}, reverse: {} });
  }
  for (const edge of records) {
    for (const direction of ['forward', 'reverse']) {
      const modes = edge[direction];
      delete modes.subway;
      if (!edge.lineId || !edge.stationPath?.length) continue;
      const path = direction === 'forward' ? edge.stationPath : [...edge.stationPath].reverse();
      const legs = path.slice(1).map((to, i) => times.get(JSON.stringify([edge.lineId, name(path[i]), name(to)])));
      if (!legs.length || !legs.every(Number.isFinite)) continue;
      const seconds = legs.reduce((sum, duration) => sum + duration, 0);
      modes.subway = { seconds, rideSeconds: seconds, evidence: { url: source.url, observedAt: source.publishedAt } };
    }
  }
  return records.filter(e => Object.keys(e.forward).length || Object.keys(e.reverse).length);
}

async function newSegmentRound(file, round, scenario) {
  const catalog = await readVerifiedData(file);
  if (catalog?.version !== 1 || !Array.isArray(catalog.segments))
    throw new VerifiedRoundError('verified_data_invalid');
  const params = roundParams(scenario?.round ?? round);
  const lines = allowedLinesFor(params);
  const segments = catalog.segments.filter(edge => {
    if (!edge || !Object.hasOwn(network.stations, edge.from) || !Object.hasOwn(network.stations, edge.to))
      throw new VerifiedRoundError('verified_data_invalid');
    return !edge.lineId || lines.has(edge.lineId);
  });
  const dest = 'gwangundae';
  const neighbors = new Map();
  for (const { from, to } of segments) {
    for (const [a, b] of [[from, to], [to, from]]) {
      if (!neighbors.has(a)) neighbors.set(a, new Set());
      neighbors.get(a).add(b);
    }
  }
  if (!neighbors.has(dest)) throw new VerifiedRoundError('segment_coverage_missing');
  for (let attempt = 0; attempt < 8; attempt++) {
    const selected = new Set([dest]);
    const frontier = new Set(neighbors.get(dest));
    const cap = Math.min(35, params.cols * params.rows, neighbors.size);
    // Try smaller connected subsets first, then allow the full node budget.
    const target = attempt < 3 ? Math.max(params.minHops + 2, cap - 1) : cap;
    while (frontier.size && selected.size < target) {
      const next = shuffled(frontier)[0];
      frontier.delete(next);
      selected.add(next);
      for (const id of neighbors.get(next)) if (!selected.has(id)) frontier.add(id);
    }
    const stationIds = [...selected];
    const edges = segments.filter(e => selected.has(e.from) && selected.has(e.to));
    if (!edges.length) continue;
    const startIds = shuffled(stationIds.filter(id => id !== dest));
    const graph = buildStoredGraph({ stationIds, edges, start: startIds[0], dest }, params, scenario?.mods || {});
    graph.graphSource = 'verified-segments';
    for (const start of startIds) {
      graph.startCandidates = [stationIds.indexOf(start)];
      const result = roundCandidates({ round, scenario, verified: true, storedGraphs: [graph] }).next().value;
      if (result) return result;
    }
  }
  throw new VerifiedRoundError('segment_coverage_missing');
}

module.exports = { newSegmentRound, publicRailSegments };
