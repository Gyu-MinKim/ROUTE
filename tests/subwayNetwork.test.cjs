'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { network, validateNetwork, getStation, getNeighbors, getTransfers } = require('../lib/subwayNetwork');

test('all station records, coordinates, lines and transfers satisfy schema', () => {
  assert.deepEqual(validateNetwork(), []);
  assert.equal(Object.keys(network.stations).length, 21);
  assert.deepEqual(Object.keys(network.lines).sort(), ['1', '6', '7']);
});

test('interchange stations connect the same physical station across the captured lines', () => {
  assert.deepEqual(getStation('seokgye').lineIds, ['1', '6']);
  assert.deepEqual(getStation('taereungipgu').lineIds, ['6', '7']);
  assert.equal(getTransfers('seokgye').length, 1);
  assert.equal(getTransfers('taereungipgu').length, 1);
  assert.equal(getTransfers('gwangundae').length, 0);
  assert.equal(getTransfers('seokgye')[0].transferMinutes, null); // not invented
});

test('adjacent stations remain line-specific, never shortcut over an interchange', () => {
  const neighbors = getNeighbors('seokgye');
  assert.deepEqual(neighbors, [
    { stationId: 'sinimun', lineId: '1' },
    { stationId: 'gwangundae', lineId: '1' },
    { stationId: 'dolgoti', lineId: '6' },
    { stationId: 'taereungipgu', lineId: '6' }
  ]);
  assert.equal(getNeighbors('gwangundae').some(n => n.stationId === 'taereungipgu'), false);
});

test('real transfers outside the captured lines are not usable as in-network transfers', () => {
  const nowon = getStation('nowon');
  assert.equal(nowon.isTransfer, true);
  assert.equal(nowon.isTransferWithinNetwork, false);
  assert.deepEqual(nowon.knownOtherTransferLines, ['4호선']);
  assert.equal(getTransfers('nowon').length, 0);
});

test('station naming does not duplicate 역 suffix', () => {
  for (const s of Object.values(network.stations)) {
    assert.equal(s.stationName, `${s.name}역`);
    assert.equal(s.stationName.endsWith('역역'), false);
  }
});

test('metadata explicitly distinguishes source-derived data and in-scope transfer coverage', () => {
  assert.equal(network.metadata.incompleteExternalLines, true);
  assert.match(network.metadata.idConvention, /NOT official/);
  assert.match(network.metadata.coordinates, /not platform\/entrance/);
});
