'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { network, getNeighbors }=require('../lib/subwayNetwork');
const { buildSubwayGraph,stationConnections,alternativeFirstStepLengths,chooseStations,CHECKED_LINES }=require('../lib/subwayGraph');
const {newRound,roundParams}=require('../lib/engine');
const virtual=len=>({subway:Math.max(1,Math.round(2+len/20))});
function verify(g,p){
  assert.ok(g.nodes.length<=Math.max(10,p.cols*p.rows));
  assert.equal(g.nodes.length,new Set(g.nodes.map(n=>n.stationId)).size);
  const n=g.nodes.length;
  assert.ok(g.edges.length>=n);
  const dest=g.destCandidates[0],start=g.startCandidates[0];
  assert.equal(g.nodes[dest].stationId,'gwangundae');
  assert.ok(g.nodes[start].stationId!=='gwangundae');
  assert.equal(g.graphSource,'verified-subway-topology');
  assert.equal(g.weightSource,'legacy-virtual');
  assert.ok(g.physicalCycleCount>= (n>=28 ? 3 : n>=21 ? 2 : 1));
  for(const node of g.nodes){
    const station=network.stations[node.stationId];
    assert.ok(station);
    assert.equal(node.stationName,station.stationName);
    assert.equal(node.lat,station.lat);
    assert.equal(node.lng,station.lng);
    assert.deepEqual(node.lineIds,station.lineIds);
  }
  for(const edge of g.edges){
    const path=edge.stationPath;
    assert.deepEqual(path.slice(1,-1),edge.viaStationIds);
    assert.equal(path[0],g.nodes[edge.a].stationId);
    assert.equal(path[path.length-1],g.nodes[edge.b].stationId);
    assert.ok(path.length>=2);
    for(let i=1;i<path.length;i++){
      assert.ok(getNeighbors(path[i-1]).some(x=>x.stationId===path[i]&&x.lineId===edge.lineId),
        `Fake shortcut ${path[i-1]}=>${path[i]} line ${edge.lineId}`);
      assert.ok(!['역촌','독바위','구산'].includes(network.stations[path[i]].name));
    }
    assert.deepEqual(Object.keys(edge.opts).sort(),['bus','subway','walk']);
    assert.ok(edge.opts.subway>0);
    assert.equal(edge.opts.walk,null);
    assert.equal(edge.opts.bus,null);
  }
  const choices=alternativeFirstStepLengths(g,start,dest);
  assert.ok(choices.length>=2);
  assert.ok(choices[0]>=4);
  assert.ok(choices[1]/choices[0]<=1.8);
  const q=[dest],seen=new Set(q);
  for(let i=0;i<q.length;i++)for(const edge of g.adj[q[i]]){
    const next=edge.a===q[i]?edge.b:edge.a;
    if(!seen.has(next)){seen.add(next);q.push(next);}
  }
  assert.equal(seen.size,n);
}
test('all nine physical lines produce only source-adjacent segments',()=>{
  assert.deepEqual(CHECKED_LINES,['1','2','3','4','5','6','7','8','9']);
  assert.equal(stationConnections().length,321);
  for(const e of stationConnections())assert.ok(getNeighbors(e.from).some(n=>n.stationId===e.to&&n.lineId===e.lineId));
});
test('hundreds of seeded-like randomized levels stay connected and preserve two valid paths',()=>{
  for(let round=1;round<=14;round++)for(let k=0;k<12;k++){
    const p=roundParams(round);
    verify(buildSubwayGraph(p,{},virtual),p);
  }
});
test('late levels get 3 verified loops and early levels remain smaller',()=>{
  const easy=buildSubwayGraph(roundParams(1),{},virtual);
  const hard=buildSubwayGraph(roundParams(14),{},virtual);
  assert.equal(easy.physicalCycleCount,1);
  assert.equal(hard.physicalCycleCount,3);
  assert.ok(hard.nodes.length>easy.nodes.length);
  assert.ok(chooseStations(35).size<=35);
});
test('subway-only mode does not pretend a subway shutdown has a bus fallback',()=>{
  assert.throws(()=>buildSubwayGraph(roundParams(3),{subwayOff:true},virtual),/subwayOff/);
});
test('engine session generation works with new topology and legacy cost solver',()=>{
  const prev=process.env.ROUTE_GRAPH_MODE;
  try{
    process.env.ROUTE_GRAPH_MODE='subway';
    for(const round of [1,3,6,9,14]){
      const s=newRound({round});
      verify(s.graph,s.params);
      assert.equal(s.graph.nodes[s.dest].stationId,'gwangundae');
      assert.ok(s.opt.steps.length>=4);
      assert.ok(s.opt.steps.every(e=>e.mode==='subway'));
    }
    const sc={round:2,startName:'집',destName:'광운대역',mods:{}};
    const state=newRound({scenario:sc});
    assert.equal(state.graph.nodes[state.start].name,'집');
    assert.equal(state.graph.nodes[state.start].stationName.endsWith('역'),true);
  }finally{
    if(prev===undefined)delete process.env.ROUTE_GRAPH_MODE;
    else process.env.ROUTE_GRAPH_MODE=prev;
  }
});
