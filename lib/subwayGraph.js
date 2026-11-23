'use strict';

// Seoul 1–9 lines: game graph is composed only of verified consecutive station links.
// Long same-line runs can be *compressed* into one game edge; viaStationIds records
// every omitted stop, so there is never a hidden line transfer or imaginary shortcut.
const { network, getNeighbors, getLineEdges, validateNetwork } = require('./subwayNetwork');

const W = 1000, H = 600, PAD = 45;
const DESTINATION_STATION_ID = 'gwangundae';
const MAX_ALTERNATE_HOP_RATIO = 1.8;
const CHECKED_LINES = Object.keys(network.lines);
const CYCLE_CORES = []; // Historical static templates are replaced by verified dynamic cycles.
const fullEdges = getLineEdges();
const NOT_BIDIRECTIONAL = new Set(['역촌', '독바위', '구산']); // Do not generate preview routes in the one-way Eungam loop.

function shuffle(arr, random = Math.random) {
  const copy = arr.slice();
  for (let i=copy.length-1; i>0; i--) {
    const r = Math.max(0, Math.min(0.999999999999, random()));
    const j = Math.floor(r*(i+1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const edgeKey=(a,b,lineId)=>`${lineId}|${[a,b].sort().join('|')}`;

function bfsPath(start, dest, blocked = null) {
  if (start===blocked || dest===blocked) return null;
  const q=[start], parent=new Map([[start,null]]);
  if (NOT_BIDIRECTIONAL.has(network.stations[start]?.name)) return null;
  for(let h=0;h<q.length;h++){
    const cur=q[h];
    if(cur===dest) break;
    for(const {stationId:next} of getNeighbors(cur)){
      if(next===blocked || parent.has(next) || NOT_BIDIRECTIONAL.has(network.stations[next]?.name)) continue;
      parent.set(next,cur);
      q.push(next);
    }
  }
  if(!parent.has(dest)) return null;
  const path=[];
  for(let cur=dest; cur!==null; cur=parent.get(cur)) path.unshift(cur);
  return path;
}

function distinctRouteChoices(start, dest=DESTINATION_STATION_ID) {
  const options=[];
  if (NOT_BIDIRECTIONAL.has(network.stations[start]?.name)) return [];
  const neighbors=getNeighbors(start).filter(n=>!NOT_BIDIRECTIONAL.has(network.stations[n.stationId]?.name)), used=new Set();
  for(const {stationId:first} of neighbors){
    if(used.has(first)) continue;
    used.add(first);
    const suffix=bfsPath(first,dest,start);
    if(suffix) options.push([start,...suffix]);
  }
  options.sort((a,b)=>a.length-b.length || a.join('').localeCompare(b.join('')));
  return options;
}

function physicalEdge(a,b) {
  const available=getNeighbors(a).filter(x=>x.stationId===b);
  if(!available.length) throw new Error(`Unverified subway segment ${a} → ${b}`);
  // If a pair is served by more than one line, preserving the actual first
  // listed line is conservative; it does NOT assert a through-service schedule.
  return {from:a,to:b,lineId:available[0].lineId};
}

const candidateRows = (()=>{
  const rows=[];
  for(const stationId of Object.keys(network.stations)){
    if(stationId===DESTINATION_STATION_ID) continue;
    const paths=distinctRouteChoices(stationId);
    if(paths.length<2) continue;
    const shortest=paths[0].length-1;
    // Prefer plausible, visibly different routing decisions, not 100-stop detours.
    const second=paths.find(p => {
      if((p.length-1)/shortest>1.45) return false;
      return p[1]!==paths[0][1] && new Set(p.slice(1,-1)).size>0;
    });
    if(!second) continue;
    rows.push({stationId,shortest,paths:[paths[0],second]});
  }
  return rows;
})();

function regionBand(targetCount) {
  if (targetCount <= 12) return [5,14];
  if (targetCount <= 15) return [7,19];
  if (targetCount <= 18) return [10,23];
  if (targetCount <= 21) return [12,29];
  if (targetCount <= 24) return [16,38];
  return [20,80];
}
function stationConnections() { return fullEdges.slice(); }

function positionsFor(ids) {
  const stations=ids.map(id=>network.stations[id]);
  const minLng=Math.min(...stations.map(x=>x.lng)), maxLng=Math.max(...stations.map(x=>x.lng));
  const minLat=Math.min(...stations.map(x=>x.lat)), maxLat=Math.max(...stations.map(x=>x.lat));
  const w=Math.max(1e-6,maxLng-minLng),h=Math.max(1e-6,maxLat-minLat);
  return new Map(ids.map(id=>{
    const s=network.stations[id];
    return [id,{x:Math.round(PAD+(s.lng-minLng)/w*(W-PAD*2)),
                y:Math.round(PAD+(maxLat-s.lat)/h*(H-PAD*2))}];
  }));
}

function hopDistances(graph, destination, blocked=-1) {
  const dist=new Array(graph.nodes.length).fill(-1);
  if(destination===blocked) return dist;
  const q=[destination];dist[destination]=0;
  for(let head=0;head<q.length;head++){
    const cur=q[head];
    for(const edge of graph.adj[cur]){
      const next=edge.a===cur?edge.b:edge.a;
      if(next===blocked || dist[next]>=0)continue;
      dist[next]=dist[cur]+1;q.push(next);
    }
  }
  return dist;
}
function alternativeFirstStepLengths(graph, start, dest) {
  const remain=hopDistances(graph,dest,start), choices=new Map();
  for(const edge of graph.adj[start]){
    const next=edge.a===start?edge.b:edge.a;
    if(remain[next]>=0)choices.set(next,1+remain[next]);
  }
  return [...choices.values()].sort((a,b)=>a-b);
}

function addOptionalLoops(pairEdges, count, maxNodes, random) {
  // Connect two distinct existing stations via another real physical corridor.
  // Every added route creates an actual cycle; never fabricate short-cuts.
  for(let iteration=0; iteration<count; iteration++) {
    const occupied=new Set();
    for(const edge of pairEdges.values()){occupied.add(edge.from);occupied.add(edge.to);}
    const proposals=[];
    const seeds=shuffle([...occupied],random);
    for(const seed of seeds){
      if(NOT_BIDIRECTIONAL.has(network.stations[seed]?.name))continue;
      for(const neighbor of getNeighbors(seed)){
        const first=neighbor.stationId;
        if(NOT_BIDIRECTIONAL.has(network.stations[first]?.name))continue;
        if(pairEdges.has(edgeKey(seed,first,neighbor.lineId)))continue;
        // BFS from the unused exit until it reaches another point on the
        // already selected corridor. Avoid retracing the start station.
        const parent=new Map([[first,null]]),q=[first];
        let meet=null;
        for(let head=0;head<q.length && head<120;head++){
          const v=q[head];
          if(occupied.has(v) && v!==seed){meet=v;break;}
          for(const n of getNeighbors(v)){
            const to=n.stationId;
            if(to===seed || parent.has(to) || NOT_BIDIRECTIONAL.has(network.stations[to]?.name))continue;
            parent.set(to,v);q.push(to);
          }
        }
        if(!meet)continue;
        const rev=[];
        for(let v=meet;v!==null;v=parent.get(v))rev.push(v);
        const path=[seed,...rev.reverse()];
        const newNodes=path.filter(id=>!occupied.has(id)).length;
        if(path.length<3 || path.length>22 || newNodes>Math.max(2,maxNodes))continue;
        const newPhysical=[];
        for(let i=1;i<path.length;i++){
          const edge=physicalEdge(path[i-1],path[i]);
          if(!pairEdges.has(edgeKey(edge.from,edge.to,edge.lineId)))newPhysical.push(edge);
        }
        if(!newPhysical.length)continue;
        proposals.push({path,newNodes,newPhysical,score:newNodes + random()*1.5});
      }
    }
    if(!proposals.length)break;
    proposals.sort((a,b)=>a.newNodes-b.newNodes || b.score-a.score);
    const alternatives=proposals.slice(0,Math.min(12,proposals.length));
    const choice=alternatives[Math.floor(Math.min(0.999999,random())*alternatives.length)];
    for(const e of choice.newPhysical)pairEdges.set(edgeKey(e.from,e.to,e.lineId),e);
  }
}

function assemble(candidate, targetCount, params, mods, virtualEdgeTimes, random) {
  const [aPath,bPath]=candidate.paths;
  const pairEdges=new Map();
  for(const route of [aPath,bPath]){
    for(let i=1;i<route.length;i++){
      const e=physicalEdge(route[i-1],route[i]);
      pairEdges.set(edgeKey(e.from,e.to,e.lineId),e);
    }
  }
  const extraLoops=targetCount>=28 ? 2 : targetCount>=21 ? 1 : 0;
  if(extraLoops)addOptionalLoops(pairEdges,extraLoops,targetCount,random);
  const union=[...pairEdges.values()], adjacency=new Map();
  for(const e of union){
    for(const [a,b] of [[e.from,e.to],[e.to,e.from]]){
      if(!adjacency.has(a)) adjacency.set(a,[]);
      adjacency.get(a).push({stationId:b,lineId:e.lineId,key:edgeKey(e.from,e.to,e.lineId)});
    }
  }
  const stationIds=[...adjacency.keys()];
  const essential=new Set([candidate.stationId, DESTINATION_STATION_ID]);
  for(const id of stationIds){
    const arcs=adjacency.get(id);
    const distinctLines=new Set(arcs.map(x=>x.lineId));
    if(arcs.length!==2 || distinctLines.size>1) essential.add(id);
  }
  // A different first hop MUST be a different selectable UI node.
  essential.add(aPath[1]); essential.add(bPath[1]);
  // A network-level interchange can be shown even if the ride continues on
  // the same line, but this is optional when node budget is tight.
  if(essential.size>targetCount) return null;
  const retained=new Set(essential);
  const positionsRaw=positionsFor(stationIds);
  const remaining=stationIds.filter(id=>!retained.has(id));
  // Spread extra gameplay choices across the real routes rather than choosing
  // random adjacent stations clustered at one place.
  while(retained.size<Math.min(targetCount,stationIds.length) && remaining.length){
    const top=[];
    let best=-Infinity;
    for(const id of remaining){
      const p=positionsRaw.get(id);
      let score=Infinity;
      for(const keep of retained){
        const q=positionsRaw.get(keep);
        score=Math.min(score,(p.x-q.x)**2+(p.y-q.y)**2);
      }
      if(score>best){best=score;top.length=0;top.push(id);}
      else if(score===best)top.push(id);
    }
    const id=top[Math.floor(Math.min(0.999999,random())*top.length)];
    retained.add(id);
    remaining.splice(remaining.indexOf(id),1);
  }
  const chosen=[...retained];
  const positions=positionsFor(chosen);
  const nodes=chosen.map((stationId,id)=>{
    const s=network.stations[stationId],{x,y}=positions.get(stationId);
    return {id,stationId,name:s.stationName,stationName:s.stationName,
      x,y,lat:s.lat,lng:s.lng,lineIds:s.lineIds.slice(),
      isTransfer:s.isTransfer,isTransferWithinNetwork:s.isTransferWithinNetwork,
      col:Math.max(0,Math.min(params.cols-1,Math.floor(x/W*params.cols)))};
  });
  const byStation=new Map(nodes.map(n=>[n.stationId,n.id]));
  const edges=[], usedPhysical=new Set();
  for(const from of chosen){
    for(const arc of adjacency.get(from)||[]){
      if(usedPhysical.has(arc.key)) continue;
      const path=[from], segments=[], direction=[];
      let prev=from, cur=arc.stationId, lineId=arc.lineId;
      usedPhysical.add(arc.key);
      path.push(cur);segments.push(arc);
      while(!retained.has(cur)){
        const nextArcs=(adjacency.get(cur)||[]).filter(x=>x.stationId!==prev);
        if(nextArcs.length!==1 || nextArcs[0].lineId!==lineId){
          throw new Error(`Unmarked junction or transfer at ${cur}`);
        }
        const next=nextArcs[0];
        if(usedPhysical.has(next.key))throw new Error('Subway corridor loop without a visible node');
        usedPhysical.add(next.key);
        prev=cur;cur=next.stationId;
        path.push(cur);segments.push(next);
      }
      if(cur===from)throw new Error('Unexpected self-loop after compression');
      const a=byStation.get(from),b=byStation.get(cur);
      if(a===undefined||b===undefined)throw new Error('Missing game node');
      let len=0;
      for(let i=1;i<path.length;i++){
        const pa=positionsRaw.get(path[i-1]),pb=positionsRaw.get(path[i]);
        len+=Math.hypot(pa.x-pb.x,pa.y-pb.y);
      }
      const virtual=virtualEdgeTimes(len,params,mods||{});
      edges.push({id:edges.length,a,b,lineId,
        viaStationIds:path.slice(1,-1),stationPath:path,
        opts:{walk:null,bus:null,subway:virtual.subway},
        weightSource:'legacy-virtual'});
    }
  }
  if(usedPhysical.size!==pairEdges.size)throw new Error('Some real segments were lost during compression');
  const adj=nodes.map(()=>[]);
  for(const e of edges){adj[e.a].push(e);adj[e.b].push(e);}
  const start=byStation.get(candidate.stationId),dest=byStation.get(DESTINATION_STATION_ID);
  const graph={nodes,edges,adj,startCandidates:[start],destCandidates:[dest],
    graphSource:'verified-subway-topology',weightSource:'legacy-virtual',
    cycleTemplate:'dynamic-real-rail-loop',
    graphRegion:regionBand(targetCount),
    rawStationCount:stationIds.length, physicalCycleCount: pairEdges.size - stationIds.length + 1};
  const lengths=alternativeFirstStepLengths(graph,start,dest);
  if(lengths.length<2 || lengths[0]<Math.max(4,params.minHops||3) || lengths[1]/lengths[0]>MAX_ALTERNATE_HOP_RATIO)return null;
  return graph;
}

function chooseStations(targetCount,random=Math.random) {
  const params={cols:Math.max(10,targetCount),rows:1,minHops:3};
  const graph=buildSubwayGraph(params,{},len=>({subway:Math.max(1,Math.round(2+len/20))}),random);
  return new Set(graph.nodes.map(n=>n.stationId));
}

function buildSubwayGraph(params,mods,virtualEdgeTimes,random=Math.random) {
  if(typeof virtualEdgeTimes!=='function')throw new TypeError('virtualEdgeTimes must be supplied');
  if(mods?.subwayOff)throw new Error('subway graph preview cannot support subwayOff without verified bus/walk network');
  const errors=validateNetwork();
  if(errors.length)throw new Error('Invalid subway network: '+errors.slice(0,5).join('; '));
  const targetCount=Math.max(10,params.cols*params.rows);
  const [minimum,maximum]=regionBand(targetCount);
  const candidates=candidateRows.filter(x=>x.shortest>=minimum && x.shortest<=maximum);
  if(!candidates.length)throw new Error(`No verified candidate start for region ${minimum}-${maximum}`);
  for(const candidate of shuffle(candidates,random).slice(0,Math.min(100,candidates.length))){
    const graph=assemble(candidate,targetCount,params,mods,virtualEdgeTimes,random);
    if(graph)return graph;
  }
  throw new Error(`Failed to generate two-route subway round within ${targetCount} game nodes`);
}
module.exports={buildSubwayGraph,chooseStations,stationConnections,hopDistances,
  alternativeFirstStepLengths,distinctRouteChoices,CYCLE_CORES,MAX_ALTERNATE_HOP_RATIO,CHECKED_LINES};
