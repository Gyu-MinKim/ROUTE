// Run with a test-only DOM module; no production dependencies are changed.
const { parseHTML } = require(process.env.ROUTE_UI_DOM || 'linkedom');
const vm = require('node:vm');
const fs = require('node:fs');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
// Never write test play history into the shared workspace.
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'route-ui-test-'));
fs.cpSync(path.join(root, 'lib'), path.join(runtime, 'lib'), { recursive: true });
fs.mkdirSync(path.join(runtime, 'data'));
fs.copyFileSync(path.join(root, 'data', 'subwayNetwork.json'), path.join(runtime, 'data', 'subwayNetwork.json'));
for (const file of ['server.js', 'routes.json']) fs.copyFileSync(path.join(root, file), path.join(runtime, file));
fs.cpSync(path.join(root, 'node_modules'), path.join(runtime, 'node_modules'), { recursive: true });
// This suite exercises deterministic fallback; never inherit live provider
// credentials when running UI automation from a configured developer shell.
delete process.env.GEMINI_API_KEY;
delete process.env.GEMINI_MODEL;
const app = require(path.join(runtime, 'server.js'));
process.on('exit', () => fs.rmSync(runtime, { recursive: true, force: true }));
const calls=[];
let failure=null;
async function apiFetch(url, options={}) {
  calls.push({url, body:options.body ? JSON.parse(options.body) : null});
  if(failure && url===failure) { failure=null; throw new Error('offline'); }
  return new Promise((resolve,reject)=>{
    const req=new http.IncomingMessage(new PassThrough());
    Object.assign(req,{method:options.method||'GET',url,headers:{},body:options.body?JSON.parse(options.body):{}});
    const res=new http.ServerResponse(req);let body='';
    res.write=(chunk)=>{body+=String(chunk);return true;};
    res.end=(chunk)=>{if(chunk)body+=String(chunk);resolve({ok:res.statusCode<400,status:res.statusCode,json:async()=>JSON.parse(body)});};
    app.handle(req,res,reject);
  });
}
const {window,document}=parseHTML(fs.readFileSync(root+'/public/index.html','utf8'));
let active=document.body;
Object.defineProperty(document,'activeElement',{get:()=>active});
window.HTMLElement.prototype.focus=function(){active=this;};
window.SVGElement.prototype.focus=function(){active=this;};
const storage=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k)};};
window.localStorage=storage(); window.sessionStorage=storage();
window.localStorage.setItem('route.settings',JSON.stringify({reduce:true,tut:false}));
window.matchMedia=()=>({matches:false});
window.history={state:null,replaceState(s){this.state=s;},pushState(s){this.state=s;}};
window.location={href:'http://route.test/'};
const context=vm.createContext({window,document,localStorage:window.localStorage,sessionStorage:window.sessionStorage,fetch:apiFetch,Event:window.Event,MouseEvent:window.Event,performance,AbortController,requestAnimationFrame:(cb)=>setTimeout(()=>cb(performance.now()+2000),0),setTimeout,clearTimeout,console});
const run=s=>vm.runInContext(s,context);
for(const f of ['game.js','ui.js'])run(fs.readFileSync(root+'/public/'+f,'utf8'));
const el=s=>document.querySelector(s);
const click=async(s)=>{const target=typeof s==='string'?el(s):s;assert.ok(target,'missing target '+s);target.dispatchEvent(new window.Event('click',{bubbles:true}));await settle();};
const settle=async()=>{for(let i=0;i<5;i++) await new Promise(r=>setTimeout(r,0));};
const action=t=>[...document.querySelectorAll('#modal-actions button')].find(b=>b.textContent.includes(t));
let count=0;const ok=t=>{count++;console.log('PASS',t);};
(async()=>{
 await settle();
 assert.equal(run('levels.length'),15);assert.equal(document.querySelectorAll('[id]').length,new Set([...document.querySelectorAll('[id]')].map(n=>n.id)).size);ok('initialization and unique HTML IDs');
 const originalFetch = context.fetch;
 let releaseStart, pendingSignal;
 context.fetch = (url, options) => {
   if (url !== '/api/simulate/start') return originalFetch(url, options);
   pendingSignal = options.signal;
   return new Promise(resolve => { releaseStart = resolve; });
 };
 const pending = run('startRound()');
 assert.match(el('#modal-title').textContent, /준비 중/);
 await run('startRound()');
 await click(action('홈으로'));
 assert.equal(pendingSignal.aborted, true);
 releaseStart({ ok: true, json: async () => ({}) });
 await pending;
 assert.equal(run('S'), null);
 assert.equal(run('busy'), false);
 assert.equal(el('#start').classList.contains('active'), true);
 assert.equal(el('#modal').classList.contains('hidden'), true);
 context.fetch = originalFetch;
 ok('pending start can be canceled and a late response cannot reopen the game');
 context.fetch = async () => ({ ok: false, json: async () => ({ error: 'kakao_upstream_error', upstreamStatus: 503 }) });
 await run('startRound()');
 assert.match(el('#modal-body').textContent, /카카오.*HTTP 503/);
 context.fetch = originalFetch;
 await click(action('홈으로'));
 ok('round failure identifies provider status');
 await click('#btn-play'); assert.match(el('#modal-title').textContent,/Level 1/); await click(action('시작하기'));
 assert.equal(run('S.status'),'active'); assert.equal(el('#game').classList.contains('active'),true);assert.match(el('#modal-title').textContent,/첫 등교/);ok('recommended level starts through one mission briefing');
 await click('#modal-close'); assert.equal(el('#modal').classList.contains('hidden'),true);assert.equal(run('busy'),false);assert.equal(el('#game').inert,false);ok('briefing close releases gameplay and inert state');
 const id=run('availableDestinations()[0]'); await click(el(`#map [data-id="${id}"] .label`));assert.equal(run('sel'),id);assert.equal(el('#station-options').children.length,run('availableDestinations().length'));assert.match(el('#selection-route').textContent,/→/);ok('station name selects the route and updates destination');
 const mode=run(`MODE_ORDER.find(m=>S.quotes[\`${id}:\${m}\`]&&!moveUnavailable(S.quotes[\`${id}:\${m}\`]))`);assert.ok(mode);
 assert.equal(el('#btn-go'),null);assert.equal(el(`[data-mode="${mode}"]`).disabled,false);assert.match(el(`[data-mode="${mode}"]`).textContent,/분/);assert.match(el('#selection-step').textContent,/바로 이동/);ok('transport cards show minutes and costs, and no confirm button exists');
 {const before=run('S.path.length');await click(`[data-mode="${mode}"]`);assert.equal(run('S.path.length'),before);assert.equal(run('sel'),id);ok('card press right after station selection is ignored (misclick guard)');run('MOVE_GUARD_MS=0');}
 const session=run('S.sessionId');await click('#btn-home');assert.equal(el('#start').classList.contains('active'),true);assert.equal(el('#btn-resume').classList.contains('hidden'),false);await click('#btn-resume');assert.equal(run('S.sessionId'),session);assert.equal(run('sel'),id);ok('home and resume preserve the same session and selection');
 await click('#btn-home');await click('#btn-endless');assert.match(el('#modal-title').textContent,/進行|진행/);await click(action('취소'));assert.equal(run('S.sessionId'),session);assert.equal(run('ctx.kind'),'level');ok('cancel new-game confirmation preserves current context');
 await click('#btn-settings');await click('#m-reset');assert.match(el('#modal-title').textContent,/지울/);window.localStorage.setItem('route.progress','{"1":3}');await click(action('취소'));assert.equal(window.localStorage.getItem('route.progress'),'{"1":3}');await click('#m-reset');await click(action('기록 삭제'));assert.equal(window.localStorage.getItem('route.progress'),null);assert.ok(window.localStorage.getItem('route.settings'));ok('progress reset needs confirmation and preserves settings');
 await click('#modal-close');await click('#btn-resume');
 run('S.quotes[`${sel}:walk`]={time:S.limit+1,cost:0,stam:0}; updateFooter()');assert.equal(el('[data-mode="walk"]').disabled,true);assert.match(el('[data-mode="walk"]').textContent,/초과/);{const before=run('S.path.length');await run('moveBy("walk")');assert.equal(run('S.path.length'),before);}ok('time-overrun reason is explicit and cannot be moved');
 // Reproduce a blocked station with another option, then a round with no affordable moves.
 run('globalThis.blockedQuotes = Object.fromEntries(Object.keys(S.quotes).map(key => [key, {time:S.limit+1,cost:0,stam:0}])); S.quotes={...blockedQuotes, [sel+":walk"]:{time:S.limit+1,cost:0,stam:0}}; const alternate=S.edges.filter(e=>e.a===S.cur || e.b===S.cur).map(e=>e.a===S.cur?e.b:e.a).find(id=>id!==sel); if(alternate!=null) S.quotes[alternate+":walk"]={time:1,cost:0,stam:0}; updateFooter()');
 if (run('alternate!=null')) {
  assert.match(el('#move-warning').textContent,/선택한 역으로 갈 수 없어요/);
  assert.ok(el('#move-warning').textContent.includes(run('S.nodes[alternate].name')));
 }
 assert.ok(![...el('#station-options').children].some(button => button.textContent === run('S.nodes[sel].name')));
 assert.equal(el('#btn-giveup').classList.contains('primary'),true);
 run('S.quotes=blockedQuotes; sel=null; updateFooter()');
 assert.match(el('#move-warning').textContent,/이동할 수 있는 역이 없어요/);
 assert.equal(el('#btn-giveup').disabled,false);
 await click('#btn-giveup');await click(action('취소'));assert.equal(run('S.status'),'active');
 await click('#btn-giveup');await click(action('포기'));assert.equal(run('S.status'),'fail');
 for (const scope of ['#modal-body', '#panel-result']) {
  assert.equal(el(`${scope} [data-coach-source]`).textContent, '기본 피드백');
  assert.deepEqual([...el(`${scope} [data-coach-sections]`).querySelectorAll('h3')].map(node => node.textContent), ['플레이 평가', '최적 경로와의 비교', '다음 플레이 TIP']);
  for (const key of ['evaluation', 'comparison', 'tip']) {
   const text = el(`${scope} [data-coach-field="${key}"]`).textContent;
   assert.ok(text.trim()); assert.doesNotMatch(text, /기본 피드백|시간\/자원\/체력 부족|undefined/);
  }
  assert.equal(el(`${scope} [data-coach-feedback]`).getAttribute('aria-busy'), 'false');
 }
 ok('fallback coaching uses three readable sections and a separate source label');
 await click(action('같은 지도 재도전'));assert.equal(run('S.status'),'active');
 assert.equal(el('#btn-giveup').classList.contains('primary'),false);
 ok('blocked movement explains alternatives and offers give up with same-map retry');
 // Recover the real quotes by starting a new round after explicit confirmation.
 await click('#btn-home');await click('#btn-endless');await click(action('새 게임 시작'));await click('#modal-close');assert.equal(run('ctx.kind'),'endless');
 await click('#btn-giveup');await click(action('포기'));assert.equal(run('S.status'),'fail');assert.ok(action('같은 지도 재도전'));assert.ok(action('홈으로'));ok('failed round provides direct retry and exit');
 const graph=run('JSON.stringify(S.nodes)');await click(action('같은 지도 재도전'));assert.equal(run('JSON.stringify(S.nodes)'),graph);assert.equal(run('S.path.length'),0);assert.equal(run('S.status'),'active');ok('same-map retry retains graph and clears movement');
 await click('#btn-subway');assert.equal(el('#subway').classList.contains('hidden'),false);document.dispatchEvent(Object.assign(new window.Event('keydown',{bubbles:true}),{key:'Escape'}));assert.equal(el('#subway').classList.contains('hidden'),true);assert.equal(el('#game').inert,false);ok('route overlay Escape restores interaction');
 await click('#btn-home');failure='/api/simulate/start';await click('#btn-endless');await click(action('새 게임 시작'));assert.match(el('#modal-title').textContent,/始|시작하지/);assert.equal(run('S.status'),'active');assert.equal(run('busy'),false);ok('failed request leaves previous session recoverable');
 assert.equal(run('ctx.kind'),run('S.mode'));ok('failed new game preserves the previous mode context');
 // Ensure the campaign entry points remain available.
 await click('#modal-close');await click('#btn-week');assert.ok(el('#modal-title').textContent.length);assert.ok(action('출발'));ok('week campaign entry and day briefing remain available');
 await click(action('출발'));if(action('새 게임 시작'))await click(action('새 게임 시작'));assert.equal(run('S.mode'),'week');assert.ok(run('S.week'));ok('week session starts with the correct API payload');
 await click('#modal-close');assert.match(el('#game-context').textContent,/일주일/);assert.match(el('#mission-sub').textContent,/./);ok('week context and mission details render');
 // Keep feedback pending while the player advances to another day.
 let releaseFeedback;
 context.fetch = (url, options) => url === '/api/feedback'
   ? new Promise(resolve => { releaseFeedback = resolve; })
   : originalFetch(url, options);
 await click('#btn-giveup');await click(action('포기'));assert.ok(action('다음 날'));
 assert.match(el('#modal-body [data-coach-feedback]').textContent, /분석하고 있어요/);
 await click(action('다음 날'));assert.equal(run('weekBriefing.day'),2);
 await click('#modal-close');assert.equal(el('#btn-resume').classList.contains('hidden'),false);
 await click('#btn-resume');assert.equal(run('weekBriefing.day'),2);
 const oldFeedback = releaseFeedback;
 context.fetch = originalFetch;
 ok('failed week day can advance while feedback is pending and its briefing can be resumed');
 await click(action('출발'));await click('#modal-close');assert.ok(run('S.errand'));assert.match(el('#mission-sub').textContent,/민수/);assert.match(el('#map').textContent,/📚|📖|📒|📕|✔/);ok('errand marker and instructions survive UI integration');
 const oldCoachText = el('#panel-result [data-coach-feedback]').textContent;
 oldFeedback({ ok: true, json: async () => ({ source: 'gemini', feedback: { evaluation: '이전 평가예요.', comparison: '이전 비교예요.', tip: '이전 조언이에요.' } }) });
 await settle();
 assert.equal(el('#panel-result [data-coach-feedback]').textContent, oldCoachText);
 ok('a previous day cannot overwrite feedback after the next round starts');
 await click('#btn-giveup');await click(action('포기'));const plan=JSON.parse(run('JSON.stringify(result.optimal.steps)'));await click(action('같은 지도 재도전'));
 const coachText = '<img src=x onerror=alert(1)> 기준 경로를 잘 따라갔어요.';
 const coachFeedback = { evaluation: coachText, comparison: '기준 경로와 같은 수단을 이용했어요.', tip: '다음에도 갈림길의 이동 시간을 먼저 확인해 보세요.' };
 context.fetch = (url, options) => url === '/api/feedback'
   ? Promise.resolve({ ok: true, json: async () => ({ source: 'gemini', feedback: coachFeedback }) })
   : originalFetch(url, options);
 for(const step of plan){await click(el(`#map [data-id="${step.to}"] .label`));const n=run('S.status==="active"?S.path.length:-1');await click(`[data-mode="${step.mode}"]`);assert.equal(run('S.path.length'),n+1);}
 assert.equal(run('S.status'),'success');assert.ok(run('result.story'));assert.match(el('#modal-body').textContent,/民|민수|교재|친구/);ok('real movement completes an errand and preserves story result');
 for (const scope of ['#modal-body', '#panel-result']) {
  for (const key of ['evaluation', 'comparison', 'tip']) assert.equal(el(`${scope} [data-coach-field="${key}"]`).textContent, coachFeedback[key]);
  assert.equal(el(`${scope} [data-coach-source]`).textContent, 'Gemini 생성');
 }
 assert.equal(el('#modal-body [data-coach-feedback] img'), null);
 context.fetch = originalFetch;
 ok('AI coaching is displayed as plain text in the result and comparison panels');
 context.fetch = async () => ({ ok: true, json: async () => ({ source: 'gemini', feedback: { evaluation: '빠진 항목이 있어요.' } }) });
 await run('loadRoundFeedback(S.sessionId)');
 assert.match(el('#panel-result [data-coach-state]').textContent, /불러오지 못했어요/);
 assert.equal(el('#panel-result [data-coach-sections]').hidden, true);
 context.fetch = async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); };
 await run('loadRoundFeedback(S.sessionId)');
 assert.doesNotMatch(el('#panel-result [data-coach-feedback]').textContent, /PRIVATE_PROVIDER_ERROR/);
 context.fetch = originalFetch;
 await run('loadRoundFeedback(S.sessionId)');
 ok('malformed responses and transport failures never render partial data or provider errors');
 await click('#modal-close');assert.equal(el('#panel-compare').classList.contains('hidden'),false);assert.ok(el('#btn-retry'));ok('dismissing results leaves comparison and retry controls accessible');
 // Start an event level directly for integration coverage independent of saved unlocks.
 await run("ctx={kind:'level',levelId:5,round:1}; startRound()");await settle();assert.ok(run('S.event'));assert.equal(el('#event-banner').classList.contains('hidden'),false);assert.ok(el('#modal-body').textContent.includes(run('S.event.text')));await click('#modal-close');ok('traffic event forecast is visible in briefing and map banner');
 context.fetch = (url, options) => url === '/api/feedback'
   ? new Promise(resolve => { releaseFeedback = resolve; })
   : originalFetch(url, options);
 await click('#btn-giveup');await click(action('포기'));await click('#modal-close');
 const pendingText = el('#panel-result [data-coach-feedback]').textContent;
 await click('#btn-retry');
 releaseFeedback({ ok: true, json: async () => ({ source: 'gemini', feedback: coachFeedback }) });
 await settle();
 assert.equal(run('S.status'),'active');assert.equal(el('#modal').classList.contains('hidden'),true);
 assert.equal(el('#panel-result [data-coach-feedback]').textContent, pendingText);
 context.fetch = originalFetch;
 ok('comparison retry skips repeated intro and ignores late feedback');
 // Resource failures explain their cause and survive keyboard selection.
 const target=run('availableDestinations()[0]');const station=el(`#map [data-id="${target}"]`);station.dispatchEvent(Object.assign(new window.Event('keydown',{bubbles:true}),{key:'Enter'}));await settle();assert.equal(run('sel'),target);ok('keyboard can select a reachable station');
 run("S.quotes[`${sel}:subway`]={time:1,cost:S.resLeft+300,stam:0};S.quotes[`${sel}:bus`]={time:1,cost:0,stam:S.stamina.left+4};updateFooter()");assert.match(el('[data-mode="subway"]').textContent,/300.*부족/);assert.match(el('[data-mode="bus"]').textContent,/체력 4 부족/);ok('unavailable transport explains money and stamina shortages');
 document.dispatchEvent(Object.assign(new window.Event('keydown',{bubbles:true}),{key:'Escape'}));assert.equal(run('sel'),null);ok('Escape clears selection');
 console.log(`\n${count} checks passed; ${calls.length} API calls used real Express handlers without opening a port.`);
 clearTimeout(run('notify.timer'));
})().catch(e=>{console.error(e);process.exitCode=1;});
