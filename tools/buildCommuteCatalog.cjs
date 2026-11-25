'use strict';

// Run from any directory. Rebuild the local game catalog before starting the server.
const fs = require('node:fs');
const path = require('node:path');
const { SEOUL_BUS_CARD, SOURCES } = require('../lib/farePolicy');
const { network: { stations } } = require('../lib/subwayNetwork');
const pedestrian = require('../source/seoulPedestrianRoutes.json');
const cityBus = require('../source/seoulWeekdayBus.json');
const weekdayBusPilot = require('../source/weekdayBusPilot.json');
const { publicRailSegments } = require('../lib/segmentRounds');

const dataDir = path.join(__dirname, '..', 'data');
const input = path.join(dataDir, 'verifiedSegments.json');
const publicOnly = process.argv.includes('--public-only');
const observations = !publicOnly && fs.existsSync(input) ? JSON.parse(fs.readFileSync(input, 'utf8')).segments : [];
const segments = publicRailSegments(observations);
const { gameSegment: pilot } = weekdayBusPilot;
const { from, to, accessWalkSeconds, egressWalkSeconds, walkBasis } = pilot;
const rideSeconds = weekdayBusPilot.meanOfCompleteDays;
const pilotBus = {
  seconds: Math.ceil(rideSeconds + accessWalkSeconds + egressWalkSeconds),
  routeId: weekdayBusPilot.routeId,
  evidence: { url: weekdayBusPilot.source, observedAt: weekdayBusPilot.samples.at(-1).date },
  cardBaseFare: pilot.fare.cardBaseFare,
  fareEvidence: pilot.fare.evidence,
  timeBasis: 'weekday_08h_ride_with_assumed_walk',
  verifiedForWeekdayMorning: false,
  components: { rideSeconds, accessWalkSeconds, egressWalkSeconds, walkBasis, waitSeconds: null },
};
const edgeByPair = new Map(segments.map(edge => [[edge.from, edge.to].sort().join('|'), edge]));
function addMode(from, to, mode, record) {
  const pair = [from, to].sort().join('|');
  let edge = edgeByPair.get(pair);
  if (!edge) {
    edge = { from, to, forward: {}, reverse: {} };
    segments.push(edge);
    edgeByPair.set(pair, edge);
  }
  edge[edge.from === from ? 'forward' : 'reverse'][mode] = record;
}

addMode(from, to, 'bus', pilotBus);
for (const [origin, destination, routeId, routeNumber, type, boardStopId, alightStopId, , , seconds, dates] of cityBus.rows) {
  if (origin === from && destination === to) continue;
  const fare = SEOUL_BUS_CARD[type];
  if (!fare || !Number.isFinite(seconds) || seconds <= 0 || !dates.length)
    throw new Error(`Invalid Seoul bus record: ${origin} → ${destination}`);
  const date = dates.at(-1).replace(/^(....)(..)(..)$/, '$1-$2-$3');
  addMode(origin, destination, 'bus', {
    seconds: Math.ceil(seconds + accessWalkSeconds + egressWalkSeconds),
    routeId,
    cardBaseFare: fare,
    evidence: { url: cityBus.source, observedAt: date },
    fareEvidence: { url: SOURCES.bus, observedAt: '2026-11-24' },
    routeNumber, boardStopId, alightStopId,
    timeBasis: 'weekday_08h_ride_with_assumed_walk',
    verifiedForWeekdayMorning: false,
    components: { rideSeconds: seconds, accessWalkSeconds, egressWalkSeconds, walkBasis, waitSeconds: null },
  });
}

for (const [origin, destination, distanceMeters, seconds, method] of pedestrian.routes) {
  const coordinates = [origin, destination].map(id => {
    const { lng, lat } = stations[id];
    return `${lng},${lat}`;
  }).join(';');
  addMode(origin, destination, 'walk', {
    seconds, distanceMeters,
    timeBasis: 'osm_pedestrian_estimate',
    evidence: {
      url: method === 'osm_extract' ? pedestrian.extractSource : pedestrian.path + coordinates + pedestrian.query,
      observedAt: pedestrian.checkedAt,
    },
  });
}

// Keep rail connections and only a few useful street links for each station.
const walkable = segments.filter(edge => edge.forward.walk?.seconds && edge.reverse.walk?.seconds);
const retained = new Set(walkable.filter(edge => edge.lineId ||
  (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from)));
const streetLinks = new Map();
for (const edge of walkable) {
  if (edge.lineId) continue;
  for (const [station, direction] of [[edge.from, edge.forward], [edge.to, edge.reverse]]) {
    if (!streetLinks.has(station)) streetLinks.set(station, []);
    streetLinks.get(station).push({ edge, walk: direction.walk.seconds, bus: direction.bus?.seconds });
  }
}
for (const links of streetLinks.values()) {
  links.sort((a, b) => a.walk - b.walk);
  for (const link of links.slice(0, 2)) retained.add(link.edge);
  const fastestBus = links.filter(link => link.bus).sort((a, b) => a.bus - b.bus)[0];
  if (fastestBus) retained.add(fastestBus.edge);
}
const coreSegments = walkable.filter(edge => retained.has(edge));

const counts = { subway: 0, bus: 0, walk: 0 };
for (const edge of coreSegments) {
  for (const direction of [edge.forward, edge.reverse]) {
    for (const mode of Object.keys(counts)) {
      const record = direction[mode];
      if (!record?.seconds) continue;
      counts[mode]++;
      record.timeBasis ??= mode === 'subway' ? 'standard_running_time' : 'observation';
      record.verifiedForWeekdayMorning ??= false;
    }
  }
}
const catalog = {
  version: 1,
  target: { timezone: 'Asia/Seoul', dayType: 'non_holiday_weekday', from: '08:00', until: '09:00', disruption: 'none' },
  segments: coreSegments,
};
const output = path.join(dataDir, publicOnly ? 'commuteSegments.public.json' : 'commuteSegments.json');
const temporary = output + '.' + process.pid + '.tmp';
fs.writeFileSync(temporary, JSON.stringify(catalog, null, 2) + '\n');
fs.renameSync(temporary, output);
console.log('Saved', coreSegments.length, 'core edges with directional records:', counts);
