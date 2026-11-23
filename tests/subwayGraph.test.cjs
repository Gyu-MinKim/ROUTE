'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { network } = require('../lib/subwayNetwork');
const { buildSubwayGraph } = require('../lib/subwayGraph');
const { roundParams, newRound } = require('../lib/engine');

const virtualEdgeTimes = len => ({ subway: Math.max(1, Math.round(2 + len / 20)) });
const params = round => roundParams(round);

function checkGraph(g, p) {
  const available = new Set(Object.keys(network.stations));
  const ids = new Set(g.nodes.map(n => n.stationId));
  assert.equal(g.nodes.length, Math.min(21, Math.max(8, p.cols * p.rows)));
  assert.equal(ids.size, g.nodes.length);
  assert.equal(g.edges.length, g.nodes.length - 1, 'selected partial network has a tree topology');
  for (const node of g.nodes) {
    assert.ok(available.has(node.stationId));
    const st = network.stations[node.stationId];
    assert.equal(node.name, st.stationName);
    assert.equal(node.stationName, st.stationName);
    assert.deepEqual(node.lineIds, st.lineIds);
    assert.equal(node.isTransferWithinNetwork, st.isTransferWithinNetwork);
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    assert.equal(node.lat, st.lat);
    assert.equal(node.lng, st.lng);
    assert.ok(node.name.endsWith('역') && !node.name.endsWith('역역'));
  }
  const graphLinks = new Set();
  for (const line of Object.values(network.lines)) {
    const lineId = Object.entries(network.lines).find(([,v]) => v === line)[0];
    for (let i = 1; i < line.stationIds.length; i++) {
      graphLinks.add(`${[line.stationIds[i-1],line.stationIds[i]].sort().join(':')}:${lineId}`);
    }
  }
  for (const edge of g.edges) {
    const from = g.nodes[edge.a].stationId;
    const to = g.nodes[edge.b].stationId;
    assert.ok(graphLinks.has(`${[from,to].sort().join(':')}:${edge.lineId}`), `invented edge: ${from}-${to}`);
    assert.deepEqual(Object.keys(edge.opts).sort(), ['bus','subway','walk']);
    assert.equal(edge.opts.bus, null);
    assert.equal(edge.opts.walk, null);
    assert.ok(edge.opts.subway > 0);
    assert.equal(edge.weightSource, 'legacy-virtual');
  }
  const dest = g.destCandidates[0];
  assert.equal(g.nodes[dest].stationId, 'gwangundae');
  const visited = new Set([dest]);
  const todo = [dest];
  for(let pos=0; pos<todo.length; pos++) {
    const at = todo[pos];
    for(const e of g.adj[at]) {
      const next = at === e.a ? e.b : e.a;
      if(!visited.has(next)){visited.add(next); todo.push(next);}
    }
  }
  assert.equal(visited.size, g.nodes.length, 'all chosen nodes connected');
  assert.ok(g.startCandidates.length > 0);
  for (const s of g.startCandidates) {
    const dist = new Array(g.nodes.length).fill(-1);
    dist[s]=0;
    const queue=[s];
    for(let j=0;j<queue.length;j++) for(const e of g.adj[queue[j]]){
      const to=e.a===queue[j]?e.b:e.a;
      if(dist[to]===-1) {dist[to]=dist[queue[j]]+1;queue.push(to);}
    }
    assert.ok(dist[dest]>=3);
  }
  assert.deepEqual(new Set(g.edges.map(e=>e.lineId)), new Set(['1','6','7']));
}

test('many randomized graphs preserve genuine adjacent stations and connect to Gwangundae', () => {
  for (let round = 1; round <= 14; round++) {
    for (let i = 0; i < 18; i++) {
      const p = params(round);
      const g = buildSubwayGraph(p, {}, virtualEdgeTimes);
      checkGraph(g,p);
    }
  }
});

test('there is no invented direct edge that hides the Seokgye or Taereung transfer', () => {
  const g = buildSubwayGraph(params(1), {}, virtualEdgeTimes);
  const has = (x, y) => g.edges.some(e => [g.nodes[e.a].stationId,g.nodes[e.b].stationId].sort().join(':') === [x,y].sort().join(':'));
  assert.equal(has('gwangundae','taereungipgu'),false);
  assert.equal(has('seokgye','taereungipgu'),true);
  assert.equal(has('seokgye','gwangundae'),true);
  assert.equal(has('taereungipgu','gongneung'),true);
});

test('subway-only verified network refuses unsupported subway shutdown scenarios', () => {
  assert.throws(() => buildSubwayGraph(params(3), {subwayOff:true}, virtualEdgeTimes), /subwayOff/);
});

test('engine newRound supports opt-in subway graph without changing default mode', () => {
  const saved = process.env.ROUTE_GRAPH_MODE;
  try {
    delete process.env.ROUTE_GRAPH_MODE;
    const legacy = newRound({round:1});
    assert.ok(legacy.graph.nodes.length > 0);
    assert.equal(legacy.graph.graphSource, undefined);

    process.env.ROUTE_GRAPH_MODE='subway';
    for (let round=1; round<=3; round++) {
      const state = newRound({round});
      assert.equal(state.graph.graphSource, 'verified-subway-topology');
      assert.equal(state.graph.weightSource, 'legacy-virtual');
      assert.equal(state.graph.nodes[state.dest].stationId, 'gwangundae');
      assert.ok(state.opt && state.opt.steps.length >= 3);
      assert.ok(state.opt.steps.every(x=>x.mode === 'subway'));
    }
    const scenario = newRound({scenario:{ round:2, startName:'집', destName:'광운대역', mods:{} }});
    assert.equal(scenario.graph.nodes[scenario.start].name,'집');
    assert.equal(scenario.graph.nodes[scenario.start].stationName.endsWith('역'),true);
    assert.equal(scenario.graph.nodes[scenario.dest].name,'광운대역');
    assert.throws(() => newRound({scenario:{round:3,mods:{subwayOff:true}}}), /subwayOff/);
    assert.throws(() => newRound({scenario:{round:3,mods:{},event:{mode:'subway',off:true,frac:0.5}}}), /subway shutdown events/);
  } finally {
    if(saved === undefined) delete process.env.ROUTE_GRAPH_MODE;
    else process.env.ROUTE_GRAPH_MODE = saved;
  }
});
