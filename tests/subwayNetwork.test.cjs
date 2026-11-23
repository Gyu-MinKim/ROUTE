'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { network, validateNetwork, getStation, getNeighbors, getLineEdges, getTransfers }=require('../lib/subwayNetwork');
const edges=getLineEdges();
const idOf=name=>Object.keys(network.stations).find(id=>network.stations[id].stationName===name+'역' || network.stations[id].stationName===name);
const has=(a,b,line)=>getNeighbors(idOf(a)).some(x=>x.stationId===idOf(b)&&x.lineId===line);

test('275 source-backed Seoul-area stations and all nine line memberships satisfy schema',()=>{
  assert.deepEqual(validateNetwork(),[]);
  assert.deepEqual(Object.keys(network.lines).sort(),['1','2','3','4','5','6','7','8','9']);
  assert.equal(Object.keys(network.stations).length,275);
  assert.equal(edges.length,321);
  assert.equal(Object.values(network.stations).filter(x=>x.isTransferWithinNetwork).length,50);
  assert.equal(network.transfers.length,56);
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
  assert.deepEqual(getStation(idOf('왕십리')).lineIds,['2','5']);
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
