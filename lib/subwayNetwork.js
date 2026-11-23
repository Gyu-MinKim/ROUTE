'use strict';

// ROUTE subway source data accessor. Does not change the existing game graph.
const network = require('../data/subwayNetwork.json');

function validateNetwork(data = network) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['Network must be an object'];
  const lines = data.lines || {};
  const stations = data.stations || {};
  const transfers = data.transfers || [];
  if (!Object.keys(lines).length) errors.push('No lines');
  if (!Object.keys(stations).length) errors.push('No stations');
  const fromLines = new Map();

  for (const [lineId, line] of Object.entries(lines)) {
    const ids = line && line.stationIds;
    if (!Array.isArray(ids) || ids.length < 2) {
      errors.push(`Line ${lineId}: stationIds must have >= 2 entries`);
      continue;
    }
    const unique = new Set();
    for (const id of ids) {
      if (unique.has(id)) errors.push(`Line ${lineId}: duplicate station ${id}`);
      unique.add(id);
      if (!stations[id]) errors.push(`Line ${lineId}: unknown station ${id}`);
      if (!fromLines.has(id)) fromLines.set(id, new Set());
      fromLines.get(id).add(lineId);
    }
  }

  for (const [id, s] of Object.entries(stations)) {
    if (typeof s.name !== 'string' || !s.name || s.name.endsWith('역역')) errors.push(`Station ${id}: invalid name`);
    if (s.stationName !== `${s.name}역`) errors.push(`Station ${id}: stationName must be normalized once`);
    if (!Number.isFinite(s.lat) || s.lat < -90 || s.lat > 90 || !Number.isFinite(s.lng) || s.lng < -180 || s.lng > 180) {
      errors.push(`Station ${id}: invalid coordinates`);
    }
    const lineIds = Array.isArray(s.lineIds) ? s.lineIds : [];
    const expected = [...(fromLines.get(id) || [])].sort();
    if (JSON.stringify([...lineIds].sort()) !== JSON.stringify(expected)) errors.push(`Station ${id}: lineIds mismatch`);
    if (!Array.isArray(s.knownOtherTransferLines)) errors.push(`Station ${id}: knownOtherTransferLines must be an array`);
    else if (s.knownOtherTransferLines.some(x => lineIds.includes(x))) errors.push(`Station ${id}: outside lines contain an in-scope line`);
    if (s.isTransferWithinNetwork !== (expected.length > 1)) errors.push(`Station ${id}: incorrect isTransferWithinNetwork`);
    if (s.isTransfer !== (expected.length > 1 || (Array.isArray(s.knownOtherTransferLines) && s.knownOtherTransferLines.length > 0))) {
      errors.push(`Station ${id}: incorrect isTransfer`);
    }
  }

  const coveredTransferStations = new Set();
  for (const t of transfers) {
    const station = stations[t.stationId];
    if (!station) { errors.push(`Unknown transfer station ${t.stationId}`); continue; }
    const between = t.betweenLineIds;
    if (!Array.isArray(between) || between.length !== 2 || between[0] === between[1] || between.some(id => !station.lineIds.includes(id))) {
      errors.push(`Transfer ${t.stationId}: invalid line pair`);
    }
    if (t.transferMinutes !== null && (!Number.isFinite(t.transferMinutes) || t.transferMinutes < 0)) {
      errors.push(`Transfer ${t.stationId}: invalid transferMinutes`);
    }
    coveredTransferStations.add(t.stationId);
  }
  for (const [id,s] of Object.entries(stations)) {
    if (s.isTransferWithinNetwork && !coveredTransferStations.has(id)) errors.push(`Station ${id}: no in-scope transfer entry`);
  }
  return errors;
}

function getStation(stationId) {
  return network.stations[stationId] || null;
}

function getNeighbors(stationId) {
  if (!getStation(stationId)) return [];
  const result = [];
  for (const [lineId, line] of Object.entries(network.lines)) {
    const index = line.stationIds.indexOf(stationId);
    if (index < 0) continue;
    if (index > 0) result.push({ stationId: line.stationIds[index - 1], lineId });
    if (index < line.stationIds.length - 1) result.push({ stationId: line.stationIds[index + 1], lineId });
  }
  return result;
}

function getTransfers(stationId) {
  if (!getStation(stationId)) return [];
  return network.transfers.filter(x => x.stationId === stationId);
}

module.exports = { network, getStation, getNeighbors, getTransfers, validateNetwork };
