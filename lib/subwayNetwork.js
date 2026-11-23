'use strict';

// Verified Seoul 1–9 and Gyeongui–Jungang line topology. No implicit edges across branches or line changes.
const network = require('../data/subwayNetwork.json');

function sectionsFor(line) {
  return [
    { stationIds: line.stationIds, closed: Boolean(line.closed), name: 'main' },
    ...(line.branches || []).map(branch => ({
      stationIds: branch.stationIds, closed: Boolean(branch.closed), name: branch.name
    }))
  ];
}

function getLineEdges(data = network) {
  const result = [], seen = new Set();
  for (const [lineId, line] of Object.entries(data.lines || {})) {
    for (const section of sectionsFor(line)) {
      const ids = section.stationIds || [];
      const pairs = [];
      for (let i = 1; i < ids.length; i++) pairs.push([ids[i - 1], ids[i]]);
      if (section.closed && ids.length > 2) pairs.push([ids[ids.length - 1], ids[0]]);
      for (const [from, to] of pairs) {
        const key = `${lineId}|${[from, to].sort().join('|')}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ from, to, lineId });
        }
      }
    }
  }
  return result;
}

function validateNetwork(data = network) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['Network must be an object'];
  const lines = data.lines || {}, stations = data.stations || {}, transfers = data.transfers || [];
  if (!Object.keys(lines).length) errors.push('No lines');
  if (!Object.keys(stations).length) errors.push('No stations');
  const membership = new Map();
  for (const [lineId, line] of Object.entries(lines)) {
    if (!/^(?:[1-9]|K)$/.test(lineId)) errors.push(`Unsupported line ${lineId}`);
    for (const section of sectionsFor(line)) {
      const ids = section.stationIds;
      if (!Array.isArray(ids) || ids.length < 2) {
        errors.push(`Line ${lineId} section ${section.name}: less than two stations`);
        continue;
      }
      const distinct = new Set(ids);
      // 6호선 응암 순환 segment intentionally starts AND ends at 응암.
      const hasLegalReturn = section.name.includes('응암 순환') &&
        ids[0] === ids[ids.length - 1] && distinct.size === ids.length - 1;
      if (distinct.size !== ids.length && !hasLegalReturn) {
        errors.push(`Line ${lineId} section ${section.name}: unexpected duplicate station`);
      }
      if (ids.some(id => !stations[id])) errors.push(`Line ${lineId} section ${section.name}: missing station`);
      for (const id of ids) {
        if (!membership.has(id)) membership.set(id, new Set());
        membership.get(id).add(lineId);
      }
    }
  }
  for (const [id, s] of Object.entries(stations)) {
    if (typeof s.name !== 'string' || !s.name.trim() || s.name.endsWith('역역')) errors.push(`Station ${id}: invalid name`);
    if (s.stationName !== `${s.name}역`) errors.push(`Station ${id}: inconsistent stationName`);
    if (!(Number.isFinite(s.lat) && s.lat >= -90 && s.lat <= 90 && Number.isFinite(s.lng) && s.lng >= -180 && s.lng <= 180)) {
      errors.push(`Station ${id}: invalid coordinates`);
    }
    const expected = [...(membership.get(id) || [])].sort();
    const actual = Array.isArray(s.lineIds) ? [...s.lineIds].sort() : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`Station ${id}: line membership mismatch`);
    if (!Array.isArray(s.knownOtherTransferLines)) errors.push(`Station ${id}: invalid knownOtherTransferLines`);
    if (s.isTransferWithinNetwork !== (expected.length >= 2)) errors.push(`Station ${id}: invalid transfer flag`);
    if (s.isTransfer !== (expected.length >= 2 || Boolean(s.knownOtherTransferLines?.length))) {
      errors.push(`Station ${id}: invalid isTransfer`);
    }
  }
  const expectedPairs = new Set();
  for (const [id, s] of Object.entries(stations)) {
    const lines = [...(s.lineIds || [])].sort();
    for (let a=0; a<lines.length; a++) for(let b=a+1; b<lines.length; b++){
      expectedPairs.add(`${id}|${lines[a]}|${lines[b]}`);
    }
  }
  for (const t of transfers) {
    if (!stations[t.stationId]) { errors.push(`Transfer unknown station ${t.stationId}`); continue; }
    if (!Array.isArray(t.betweenLineIds) || t.betweenLineIds.length !== 2) {
      errors.push(`Transfer ${t.stationId}: invalid line pair`); continue;
    }
    const pair = [...t.betweenLineIds].sort();
    const key = `${t.stationId}|${pair.join('|')}`;
    if (!expectedPairs.has(key)) errors.push(`Transfer ${key}: line mismatch or duplicate`);
    expectedPairs.delete(key);
    if (t.transferMinutes !== null && (!Number.isFinite(t.transferMinutes) || t.transferMinutes < 0)) {
      errors.push(`Transfer ${t.stationId}: invalid transferMinutes`);
    }
  }
  for (const key of expectedPairs) errors.push(`Missing transfer ${key}`);
  for (const edge of getLineEdges(data)) {
    if (!stations[edge.from] || !stations[edge.to] || edge.from === edge.to) {
      errors.push(`Invalid edge ${edge.from} <-> ${edge.to} line ${edge.lineId}`);
    }
  }
  return errors;
}

const edgeIndex = new Map();
for (const {from, to, lineId} of getLineEdges()) {
  for (const [a,b] of [[from,to],[to,from]]) {
    if (!edgeIndex.has(a)) edgeIndex.set(a, []);
    const neighbors = edgeIndex.get(a);
    if (!neighbors.some(v=>v.stationId===b && v.lineId===lineId)) {
      neighbors.push({stationId:b,lineId});
    }
  }
}
function getStation(id) { return network.stations[id] || null; }
function getNeighbors(id) { return getStation(id) ? (edgeIndex.get(id) || []).slice() : []; }
function getTransfers(id) { return getStation(id) ? network.transfers.filter(t => t.stationId === id) : []; }

module.exports = { network, getStation, getNeighbors, getTransfers, getLineEdges, sectionsFor, validateNetwork };
