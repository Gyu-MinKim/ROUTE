'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { network, validateNetwork, getStation, getNeighbors, getLineEdges, getTransfers }=require('../lib/subwayNetwork');
const edges=getLineEdges();
const idOf=name=>Object.keys(network.stations).find(id=>network.stations[id].stationName===name+'역' || network.stations[id].stationName===name);
const has=(a,b,line)=>getNeighbors(idOf(a)).some(x=>x.stationId===idOf(b)&&x.lineId===line);

test('Gyeongui–Jungang extends the 1–9 network without changing its schema',()=>{
  assert.deepEqual(validateNetwork(),[]);
  assert.deepEqual(Object.keys(network.lines).sort(),['1','2','3','4','5','6','7','8','9','B','K','S']);
  assert.equal(Object.keys(network.stations).length,351);
  assert.equal(edges.length,421);
  assert.equal(Object.values(network.stations).filter(x=>x.isTransferWithinNetwork).length,72);
  assert.equal(network.transfers.length,89);
  for(const s of Object.values(network.stations)){
    assert.ok(Number.isFinite(s.lat)&&Number.isFinite(s.lng));
    assert.equal(s.stationName,`${s.name}역`);
    assert.ok(!s.stationName.endsWith('역역'));
  }
});

test('historical Step3 identifiers remain stable including destination',()=>{
  const expected=['gwangundae','seokgye','changdong','taereungipgu','dongdaemun','dongmyoap','nowon','bomun','sinnae'];
  for(const id of expected)assert.ok(network.stations[id],id);
  assert.equal(getStation('gwangundae').stationName,'광운대역');
  assert.equal(getStation(idOf('서울역')).stationName,'서울역');
});

test('verified branches and circular lines have real links but no imagined jumps',()=>{
  assert.ok(has('시청','충정로','2')); // Genuine 2호선 circular closing segment.
  assert.ok(has('성수','용답','2'));
  assert.ok(has('신도림','도림천','2'));
  assert.equal(has('성수','도림천','2'),false);
  assert.ok(has('구로','구일','1'));
  assert.ok(has('구로','가산디지털단지','1'));
  assert.equal(has('온수','가산디지털단지','1'),false);
  assert.ok(has('강동','둔촌동','5'));
  assert.ok(has('강동','길동','5'));
  assert.equal(has('강일','둔촌동','5'),false);
  assert.ok(has('응암','새절','6'));
  assert.ok(has('구산','응암','6')); // One-way Eungam loop topology, game generator restricts reverse usage.
  assert.equal(has('구산','새절','6'),false);
});

test('real interchange identity matches lines without false auto-merge',()=>{
  assert.deepEqual(getStation(idOf('석계')).lineIds,['1','6']);
  assert.deepEqual(getStation(idOf('태릉입구')).lineIds,['6','7']);
  assert.deepEqual(getStation(idOf('왕십리')).lineIds,['2','5','B','K']);
  assert.deepEqual(getStation(idOf('종로3가')).lineIds,['1','3','5']);
  assert.equal(getTransfers(idOf('종로3가')).length,3);
  assert.deepEqual(getStation(idOf('이수')).lineIds,['4','7']);
  assert.ok(getStation(idOf('이수')).aliases.includes('총신대입구(이수)'));
  for(const t of network.transfers)assert.equal(t.transferMinutes,null);
});

test('network spans western, southern, eastern and northern parts of Seoul',()=>{
  for(const name of ['광운대','김포공항','개화','온수','신림','강남','잠실','천호','도봉산','가락시장','여의도','남태령','암사역사공원','중앙보훈병원']){
    assert.ok(idOf(name),name);
  }
  const queue=['gwangundae'],seen=new Set(queue);
  for(let i=0;i<queue.length;i++)for(const {stationId} of getNeighbors(queue[i])){
    if(!seen.has(stationId)){seen.add(stationId);queue.push(stationId);}
  }
  assert.equal(seen.size,Object.keys(network.stations).length);
  assert.equal(network.lines['2'].closed,true);
  assert.ok(Array.isArray(network.lines['5'].branches));
});


test('Gyeongui–Jungang runs in checked Seoul-area order, with a separate Seoul Station branch',()=>{
  const line=network.lines.K;
  const name = id => getStation(id).name;
  const names = line.stationIds.map(name);
  assert.deepEqual(names,[
    '한국항공대','수색','디지털미디어시티','가좌','홍대입구','서강대',
    '공덕','효창공원앞','용산','이촌','서빙고','한남','옥수','응봉',
    '왕십리','청량리','회기','중랑','상봉','망우','양원','구리'
  ]);
  assert.equal(line.branches.length,1);
  assert.deepEqual(line.branches[0].stationIds.map(name),['가좌','신촌(경의선)','서울']);
  assert.equal(edges.filter(e=>e.lineId==='K').length,23);
  assert.ok(has('수색','디지털미디어시티','K'));
  assert.ok(has('가좌','홍대입구','K'));
  assert.ok(has('가좌','신촌(경의선)','K'));
  assert.ok(has('신촌(경의선)','서울역','K') || has('신촌(경의선)','서울','K'));
  assert.equal(has('신촌','신촌(경의선)','K'),false);
  assert.equal(has('홍대입구','서울역','K'),false);
});

test('Gyeongui Sinchon and line-2 Sinchon are not false interchanges',()=>{
  const lower=idOf('신촌');
  const ground=idOf('신촌(경의선)');
  assert.ok(lower&&ground);
  assert.notEqual(lower,ground);
  assert.deepEqual(getStation(lower).lineIds,['2']);
  assert.deepEqual(getStation(ground).lineIds,['K']);
  assert.equal(getTransfers(lower).length,0);
  assert.equal(getTransfers(ground).length,0);
  assert.ok(Math.abs(getStation(lower).lat-getStation(ground).lat)>0.003);
});

test('actual connected interchanges reuse their Step4 IDs and unknown times remain null',()=>{
  for(const [name, expected] of [
    ['공덕',['5','6','K']], ['왕십리',['2','5','B','K']],
    ['효창공원앞',['6','K']], ['용산',['1','K']],
    ['회기',['1','K']], ['상봉',['7','K']], ['서울역',['1','4','K']]
  ]) {
    const station=getStation(idOf(name));
    assert.deepEqual(station.lineIds, expected, name);
    assert.ok(!station.knownOtherTransferLines.includes('경의중앙선'));
  }
  for(const t of network.transfers)assert.equal(t.transferMinutes,null);
  assert.ok(has('청량리','회기','K'));
  assert.ok(has('청량리','회기','1'));
  assert.equal(network.metadata.virtualWeightWarning.includes('미검증'),true);
});

test('Suin–Bundang has 63 consecutive source-checked stations and no invented shortcuts',()=>{
  const ids=network.lines.B.stationIds;
  assert.equal(ids.length,63);
  assert.equal(ids[0],idOf('청량리'));
  assert.equal(ids[1],idOf('왕십리'));
  assert.equal(ids[ids.length-1],idOf('인천'));
  assert.equal(edges.filter(e=>e.lineId==='B').length,62);
  for(let i=1;i<ids.length;i++){
    assert.ok(getNeighbors(ids[i-1]).some(n=>n.stationId===ids[i]&&n.lineId==='B'));
  }
  assert.equal(has('왕십리','강남구청','B'),false);
  assert.ok(has('정자','미금','B'));
  assert.equal(network.stations[idOf('능길')].aliases.includes('신길온천'),true);
});

test('Shinbundang has 16 stations, real interchange identity, and an unfinished separate fare',()=>{
  const ids=network.lines.S.stationIds;
  assert.equal(ids.length,16);
  assert.equal(ids[0],idOf('신사'));
  assert.equal(ids[ids.length-1],idOf('광교'));
  assert.equal(edges.filter(e=>e.lineId==='S').length,15);
  assert.ok(has('신사','논현','S'));
  assert.ok(has('강남','양재','S'));
  assert.ok(has('정자','미금','S'));
  assert.equal(has('강남','판교','S'),false);
  assert.deepEqual(getStation(idOf('정자')).lineIds,['B','S']);
  assert.deepEqual(getStation(idOf('미금')).lineIds,['B','S']);
  assert.ok(getTransfers(idOf('정자')).some(t=>t.betweenLineIds.includes('B')&&t.betweenLineIds.includes('S')));
  assert.equal(network.lines.S.farePolicy,'separate-fare-required');
  assert.equal(network.lines.S.additionalFareWon,null);
  assert.ok(network.metadata.premiumFareWarning.includes('미계산'));
});

test('pre-existing 287 stations and all prior line edges are unmodified',()=>{
  // Key stations should keep their Step5 route-facing IDs and display coordinates.
  for(const [id,name] of [
    ['gwangundae','광운대'],['seokgye','석계'],['s2_loop_208','왕십리'],
    ['s3_337','신사'],['s7_734','논현'],['s9_925','신논현']
  ]) {
    assert.equal(network.stations[id].name,name);
    assert.ok(Number.isFinite(network.stations[id].lat));
  }
  assert.equal(edges.filter(e=>e.lineId==='K').length,23);
  assert.equal(edges.filter(e=>e.lineId!=='B'&&e.lineId!=='S').length,344);
  assert.ok(!getTransfers(idOf('신촌')).length);
  assert.ok(!getTransfers(idOf('신촌(경의선)')).length);
});
