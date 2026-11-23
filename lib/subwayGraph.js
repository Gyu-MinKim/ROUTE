'use strict';

// Builds a connected GAME graph only from directly adjacent stations on the
// verified partial 1/6/7 network. Never adds cross-line shortcut edges.
// This module does not supply measured train times or actual bus/walk routes.
const { network, getNeighbors, validateNetwork } = require('./subwayNetwork');

const W = 1000;
const H = 600;
const PAD = 42;
const DESTINATION_STATION_ID = 'gwangundae';
const MIN_STATIONS = 8;
const CHECKED_LINES = ['1', '6', '7'];

function shuffle(items, random = Math.random) {
  const copied = items.slice();
  for (let i = copied.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copied[i], copied[j]] = [copied[j], copied[i]];
  }
  return copied;
}

function stationConnections() {
  const entries = [];
  for (const [lineId, line] of Object.entries(network.lines)) {
    for (let i = 1; i < line.stationIds.length; i++) {
      const from = line.stationIds[i - 1];
      const to = line.stationIds[i];
      entries.push({ from, to, lineId });
    }
  }
  return entries;
}

function chooseStations(targetCount, random = Math.random) {
  // Keep both interchange stations and at least one adjacent station on each
  // line. Every mandatory connection exists in the Step 1 source data.
  const mustInclude = [
    DESTINATION_STATION_ID, 'seokgye', 'sinimun',
    'dolgoti', 'taereungipgu', 'gongneung'
  ];
  const selected = new Set(mustInclude);
  const target = Math.min(
    Object.keys(network.stations).length,
    Math.max(MIN_STATIONS, targetCount, mustInclude.length)
  );

  // Expand only along verified neighboring-station relations. This produces
  // a connected induced subgraph without making up any missing station links.
  while (selected.size < target) {
    const frontier = new Set();
    for (const stationId of selected) {
      for (const { stationId: next } of getNeighbors(stationId)) {
        if (!selected.has(next)) frontier.add(next);
      }
    }
    if (frontier.size === 0) {
      throw new Error('Connected subway network exhausted before station target was reached');
    }
    const candidates = shuffle([...frontier], random);
    selected.add(candidates[0]);
  }
  return selected;
}

function positionsFor(stationIds) {
  const stations = stationIds.map(id => network.stations[id]);
  const minLng = Math.min(...stations.map(s => s.lng));
  const maxLng = Math.max(...stations.map(s => s.lng));
  const minLat = Math.min(...stations.map(s => s.lat));
  const maxLat = Math.max(...stations.map(s => s.lat));
  const lngRange = Math.max(maxLng - minLng, 0.000001);
  const latRange = Math.max(maxLat - minLat, 0.000001);
  const positions = new Map();
  for (const id of stationIds) {
    const s = network.stations[id];
    positions.set(id, {
      x: Math.round(PAD + (s.lng - minLng) / lngRange * (W - PAD * 2)),
      y: Math.round(PAD + (maxLat - s.lat) / latRange * (H - PAD * 2))
    });
  }
  return positions;
}

function hopDistances(graph, destination) {
  const distance = new Array(graph.nodes.length).fill(-1);
  const queue = [destination];
  distance[destination] = 0;
  for (let head = 0; head < queue.length; head++) {
    const curr = queue[head];
    for (const edge of graph.adj[curr]) {
      const next = edge.a === curr ? edge.b : edge.a;
      if (distance[next] >= 0) continue;
      distance[next] = distance[curr] + 1;
      queue.push(next);
    }
  }
  return distance;
}

function buildSubwayGraph(params, mods, virtualEdgeTimes, random = Math.random) {
  if (typeof virtualEdgeTimes !== 'function') throw new TypeError('virtualEdgeTimes must be supplied by game engine');
  const errors = validateNetwork();
  if (errors.length) throw new Error(`Invalid subway network: ${errors.join('; ')}`);
  if (mods && mods.subwayOff) {
    throw new Error('subway graph preview does not support subwayOff: verified bus/walk routes are not loaded');
  }

  const stationIds = [...chooseStations(params.cols * params.rows, random)];
  const positions = positionsFor(stationIds);
  const nodes = stationIds.map((stationId, id) => {
    const s = network.stations[stationId];
    const { x, y } = positions.get(stationId);
    return {
      id, stationId, name: s.stationName, stationName: s.stationName,
      x, y, lat: s.lat, lng: s.lng,
      lineIds: s.lineIds.slice(),
      isTransfer: s.isTransfer,
      isTransferWithinNetwork: s.isTransferWithinNetwork,
      // Legacy col kept for compatibility with existing graph consumers;
      // starting positions are chosen using startCandidates instead.
      col: Math.max(0, Math.min(params.cols - 1, Math.floor(x / W * params.cols)))
    };
  });
  const byStation = new Map(nodes.map(n => [n.stationId, n.id]));
  const edges = [];
  const seenPairs = new Set();
  for (const { from, to, lineId } of stationConnections()) {
    const a = byStation.get(from), b = byStation.get(to);
    if (a === undefined || b === undefined) continue;
    const pairKey = [Math.min(a, b), Math.max(a, b)].join(':');
    if (seenPairs.has(pairKey)) {
      throw new Error(`Unexpected duplicate line edge ${from} <-> ${to}`);
    }
    seenPairs.add(pairKey);
    const len = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
    const virtual = virtualEdgeTimes(len, params, mods || {});
    edges.push({
      id: edges.length, a, b, lineId,
      opts: { walk: null, bus: null, subway: virtual.subway },
      // Provenance is explicit: virtual subway duration is NOT a measured
      // departure-to-arrival travel time. Real weights are a later step.
      weightSource: 'legacy-virtual'
    });
  }
  const adj = nodes.map(() => []);
  for (const edge of edges) {
    adj[edge.a].push(edge);
    adj[edge.b].push(edge);
  }
  const dest = byStation.get(DESTINATION_STATION_ID);
  const graph = { nodes, edges, adj };
  const hops = hopDistances(graph, dest);
  const minHops = Math.max(params.minHops || 3, 3);
  const starts = nodes.filter(node => node.id !== dest && hops[node.id] >= minHops).map(node => node.id);
  if (!starts.length) throw new Error(`No start station at least ${minHops} subway edges from destination`);
  graph.startCandidates = starts;
  graph.destCandidates = [dest];
  graph.graphSource = 'verified-subway-topology';
  graph.weightSource = 'legacy-virtual';
  return graph;
}

module.exports = { buildSubwayGraph, chooseStations, stationConnections, hopDistances };
