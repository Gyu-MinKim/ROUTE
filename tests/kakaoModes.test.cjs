'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../lib/kakaoTransit');
const B = require('../lib/baseWeights');
const F = require('../lib/farePolicy');
const stations = [
  { id:0, stationName:'공덕역', lng:126.951, lat:37.544 },
  { id:1, stationName:'홍대입구역', lng:126.925, lat:37.557 },
];
const edge = { id:0,a:0,b:1,lineId:'K',opts:{walk:null,bus:null,subway:12}};
const walkResponse = { routes: [{ result_code: 0, summary: { duration: 961, distance: 1104 } }] };
const mockJson = (data) => ({ok:true,status:200,json:async()=>data});

test('Kakao dedicated walking API requests coordinates and reads seconds', async () => {
  let url;
  const fetcher = async (u, options) => {url = u;assert.equal(options.headers.Authorization, 'KakaoAK test');return mockJson(walkResponse);};
  const result = await K.getWalkRouteFromCoords(stations[0], stations[1], 'test', fetcher);
  assert.equal(new URL(url).pathname, '/affiliate/walking/v1/directions');
  assert.equal(new URL(url).searchParams.get('origin'), [stations[0].lng, stations[0].lat].join(','));
  assert.equal(result.totalSeconds, 961);
  assert.equal(result.totalMinutes, 17);
  assert.equal(result.distanceMeters, 1104);
});

test('Unsuccessful Kakao walking result is not replaced with invented time', async () => {
  const out = await K.getWalkRouteFromCoords(stations[0],stations[1],'test',async()=>mockJson({ routes: [{ result_code: 104 }] }));
  assert.equal(out.status,'unavailable');
  assert.equal(out.totalMinutes,null);
});

test('transit API retains vehicle types required to distinguish bus fare category', async () => {
  const stop = { boardable: true };
  const mock = { result_code: 0, journeys: [{
    summary: { total_time: 1200, transport_type: ['Bus'], transfer_count: 0 },
    sections: [{ route: { route_short_name: 'Walk' } },
      { route: { route_id: 'test', route_short_name: '7016', vehicle_type_name: 'GREEN' },
        departure_stop: stop, arrival_stop: stop, time: 1080 }],
  }] };
  const out = await K.getTransitRoutesFromCoords(stations[0], stations[1], 'test', async url => {
    assert.equal(url.pathname, '/affiliate/publictransit/v1/multimodal/directions');
    assert.equal(url.searchParams.get('goal'), [stations[1].lng, stations[1].lat].join(','));
    return mockJson(mock);
  });
  assert.equal(out.routes[0].steps[1].vehicleTypes[0], 'GREEN');
  assert.equal(out.routes[0].totalMinutes, 20);
  const record = B.parseWeight(edge, stations, out);
  assert.equal(record.base.bus, 20);
  assert.equal(record.fare.bus, null);
  assert.equal(record.gameFare.bus, 1500);
  assert.equal(record.officialBusBaseFare, 1500);
  assert.equal(record.base.walk,null); // a bus route's approach walk is not standalone walking
});

test('walking time only comes from dedicated walking endpoint result', () => {
  const rec=B.parseWeight(edge,stations,{routes:[{totalMinutes:12,steps:[{mode:'walk'},{mode:'bus'}],transfers:0,fare:1500}]});
  B.setWalking(rec,{source:'kakao-walk',status:'ok',totalMinutes:8});
  assert.deepEqual(rec.base,{walk:8,bus:12,subway:null});
  assert.equal(rec.fare.walk,0);
  assert.equal(edge.opts.bus,null);
});

test('do not hide bus transfers or mixed bus-subway transfers inside one game edge', () => {
  const rec=B.parseWeight(edge,stations,{routes:[
    {totalMinutes:7,steps:[{mode:'bus'},{mode:'bus'}],transfers:1,fare:1500},
    {totalMinutes:8,steps:[{mode:'bus'},{mode:'subway'}],transfers:1,fare:1550},
  ]});
  assert.equal(rec.base.bus,null);
  assert.equal(rec.base.subway,null);
  assert.equal(rec.status,'no_single_mode_route');
});

test('walking failure does not erase a verified bus base time', () => {
  const rec=B.parseWeight(edge,stations,{routes:[{totalMinutes:10,steps:[{mode:'bus',vehicleTypes:['간선']}],transfers:0,fare:1500}]});
  B.setWalking(rec,{status:'unavailable',reason:'TOO_FAR_AWAY'});
  assert.equal(rec.base.bus,10);
  assert.equal(rec.base.walk,null);
  assert.equal(rec.modeStatus.walk,'TOO_FAR_AWAY');
  assert.equal(rec.status,'ok');
});

test('official 2026 adult card minimum tariffs and Shinbundang premium table', () => {
  assert.deepEqual(F.ADULT_CARD_BASE,{subway:1550,bus:1500,walk:0});
  assert.equal(F.SEOUL_BUS_CARD['마을'],1200);
  assert.equal(F.SEOUL_BUS_CARD['광역'],3000);
  assert.equal(F.SHINBUNDANG_EXTRA['all-three'],2200);
  const cfg = require('../routes.json');
  assert.equal(cfg.modes.subway.fare,1550);
  assert.equal(cfg.modes.bus.fare,1500);
});

test('bidirectional parser keeps per-direction base distinct',()=>{
  const data={routes:[{totalMinutes:13,fare:1500,steps:[{mode:'bus',vehicleTypes:['간선']}],transfers:0}]};
  const fw=B.parseWeight(edge,stations,data,'a-to-b');
  const rv=B.parseWeight(edge,stations,{routes:[{...data.routes[0],totalMinutes:19}]},'b-to-a');
  assert.equal(fw.base.bus,13);
  assert.equal(rv.base.bus,19);
  assert.equal(rv.from,'홍대입구역');
});
