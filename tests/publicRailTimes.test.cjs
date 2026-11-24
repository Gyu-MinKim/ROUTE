const test = require('node:test');
const assert = require('node:assert/strict');
const { publicRailSegments } = require('../lib/segmentRounds');

test('official line 4 time replaces old estimates only in the published direction', () => {
  const walk = { seconds: 100 };
  const edge = { from: 'changdong', to: 'ssangmun', lineId: '4', stationPath: ['changdong', 'ssangmun'],
    forward: { subway: { seconds: 500 }, walk }, reverse: { subway: { seconds: 600 } } };
  const [record] = publicRailSegments([edge]);
  assert.equal(record.forward.subway.seconds, 90);
  assert.equal(record.forward.walk, walk);
  assert.equal(record.reverse.subway, undefined);
  assert.equal(edge.reverse.subway.seconds, 600);
});
