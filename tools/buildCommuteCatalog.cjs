'use strict';

// Run from any directory. Rebuild the local game catalog before starting the server.
const fs = require('node:fs');
const path = require('node:path');
const { publicRailSegments } = require('../lib/segmentRounds');

const dataDir = path.join(__dirname, '..', 'data');
const input = path.join(dataDir, 'verifiedSegments.json');
const observations = fs.existsSync(input) ? JSON.parse(fs.readFileSync(input, 'utf8')).segments : [];
const segments = publicRailSegments(observations);
const counts = { subway: 0, bus: 0, walk: 0 };
for (const edge of segments) {
  for (const direction of [edge.forward, edge.reverse]) {
    for (const mode of Object.keys(counts)) {
      const record = direction[mode];
      if (!record?.seconds) continue;
      counts[mode]++;
      record.timeBasis = mode === 'subway' ? 'standard_running_time' : 'observation';
      record.verifiedForWeekdayMorning = false;
    }
  }
}
const catalog = {
  version: 1,
  target: { timezone: 'Asia/Seoul', dayType: 'non_holiday_weekday', from: '08:00', until: '09:00', disruption: 'none' },
  segments,
};
const output = path.join(dataDir, 'commuteSegments.json');
const temporary = output + '.' + process.pid + '.tmp';
fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2) + '\n');
fs.renameSync(temporary, output);
console.log('Saved directional records:', counts);
