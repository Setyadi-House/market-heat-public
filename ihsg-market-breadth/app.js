(()=>{'use strict';
const D=window.IHSG_PUBLIC_DATA||null;
const banner=document.getElementById('staleBanner');
if(!D||!Array.isArray(D.dates)||!D.dates.length){
  banner.textContent='Validated aggregate history could not be loaded.';
  banner.className='banner show';
  return;
}
const n=D.dates.length;
const aligned=Object.entries(D).filter(([k,v])=>k!=='meta'&&Array.isArray(v));
if(aligned.some(([,v])=>v.length!==n)||D.meta?.display_points!==n){
  banner.textContent='Aggregate payload failed alignment validation.';
  banner.className='banner show';
  return;
}
const last=a=>a&&a.length?a[a.length-1]:null;
const finite=Number.isFinite;
// Reconcile legacy rounded exports from the public aggregate counts.
const coverageValues=D.dates.map((_,i)=>{
  const target=D.target?.[i],eligible=D.eligible?.[i];
  return Number.isInteger(target)&&target>0&&Number.isInteger(eligible)&&eligible>0&&eligible<=target?100*eligible/target:null;
});
const fmt=(v,d=1)=>finite(v)?Number(v).toFixed(d):'—';
const reg=v=>!finite(v)?'Unavailable':v<30?'Low participation':v>70?'Broad participation':'Mixed participation';
const set=(id,t)=>{const e=document.getElementById(id);if(e)e.textContent=t};

let metric='macd';
let benchMode='abs';
let range=localStorage.getItem('ihsg-range')||'1Y';
let smoothType=localStorage.getItem('ihsg-smooth-type')||'EMA';
let smoothN=Math.max(1,Math.min(1260,Number(localStorage.getItem('ihsg-smooth-n')||10)));
let volMode=localStorage.getItem('ihsg-volume-mode')||'activity';
let volSmoothType=localStorage.getItem('ihsg-vol-smooth-type')||'SMA';
let volSmoothN=Math.max(1,Math.min(1260,Number(localStorage.getItem('ihsg-vol-smooth-n')||3)));
if(!['6M','1Y','3Y','5Y','ALL'].includes(range))range='1Y';
if(!['EMA','SMA'].includes(smoothType))smoothType='EMA';
if(!['EMA','SMA'].includes(volSmoothType))volSmoothType='SMA';
if(!['activity','balance','spike'].includes(volMode))volMode='activity';

function smoothing(a,n,type){
  const out=Array(a.length).fill(null);
  if(type==='EMA'){
    const alpha=2/(n+1);let p=null;
    a.forEach((v,i)=>{if(!finite(v)){p=null;return}p=p===null?v:alpha*v+(1-alpha)*p;out[i]=p});
  }else{
    let sum=0,count=0;
    for(let i=0;i<a.length;i++){
      if(finite(a[i])){sum+=a[i];count++}
      if(i>=n&&finite(a[i-n])){sum-=a[i-n];count--}
      if(i>=n-1&&count===n)out[i]=sum/n;
    }
  }
  return out;
}
function cutoff(){
  if(range==='ALL')return D.dates[0];
  const d=new Date(D.dates.at(-1)+'T12:00:00Z');
  if(range==='6M')d.setUTCMonth(d.getUTCMonth()-6);
  else if(range==='1Y')d.setUTCFullYear(d.getUTCFullYear()-1);
  else if(range==='3Y')d.setUTCFullYear(d.getUTCFullYear()-3);
  else if(range==='5Y')d.setUTCFullYear(d.getUTCFullYear()-5);
  return d.toISOString().slice(0,10);
}
function startIndex(){
  const key=cutoff();let lo=0,hi=D.dates.length;
  while(lo<hi){const m=(lo+hi)>>1;if(D.dates[m]<key)lo=m+1;else hi=m}
  return Math.min(lo,D.dates.length-1);
}
const chartIds=['combinedChart','volumeChart','coverageChart'];
const views=new Map(),scenes=new Map();
function view(id){
  const base=startIndex();
  if(!views.has(id))views.set(id,{start:base,end:n});
  return views.get(id);
}
function V(a,id){const v=view(id);return a.slice(v.start,v.end)}
function VD(id){return V(D.dates,id)}
function S(tag,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e}

function hideTip(id){const tip=document.getElementById(id.replace('Chart','Tip'));if(tip)tip.style.display='none'}
function finishDrag(id){
  const scene=scenes.get(id);if(!scene?.drag)return;
  const el=document.getElementById(id),drag=scene.drag;
  scene.drag=null;drag.selection.remove();
  if(el.hasPointerCapture?.(drag.pointerId))el.releasePointerCapture(drag.pointerId);
}
function resetViews(){chartIds.forEach(id=>{finishDrag(id);views.delete(id);hideTip(id)})}
function redrawChart(id){if(id==='combinedChart')drawCombined();else if(id==='volumeChart')drawVolume();else if(id==='coverageChart')drawCoverage()}
function setView(id,start,end){
  const base=startIndex(),minimum=Math.min(5,n-base),count=Math.max(minimum,Math.min(n-base,Math.round(end-start)));
  start=Math.max(base,Math.min(n-count,Math.round(start)));
  views.set(id,{start,end:start+count});redrawChart(id);
}
function zoom(id,direction,anchor=.5){
  const v=view(id),count=v.end-v.start,base=startIndex();
  if(direction==='reset'){setView(id,base,n);return}
  const factor=direction==='in'?.5:direction==='out'?2:direction;
  const size=Math.max(Math.min(5,n-base),Math.min(n-base,Math.round(count*factor)));
  if(size===count)return;
  // Keep the pointed-at session in the same relative position after zooming.
  setView(id,v.start+anchor*(count-1)-anchor*(size-1),v.start+anchor*(count-1)-anchor*(size-1)+size);
}
function rangeStatus(id){
  const v=view(id),count=v.end-v.start,base=startIndex(),el=document.getElementById(id);
  el.dataset.start=String(v.start);el.dataset.end=String(v.end);el.dataset.count=String(count);
  el.dataset.firstDate=D.dates[v.start];el.dataset.lastDate=D.dates[v.end-1];
  set(id+'Range',D.dates[v.start]+' → '+D.dates[v.end-1]+' · '+count.toLocaleString()+' sessions');
  document.querySelectorAll('.zoom-control').forEach(b=>{
    if(b.dataset.chart!==id)return;
    b.disabled=b.dataset.zoom==='in'?count<=Math.min(5,n-base):count===n-base;
  });
}
function geometry(el,scene,ev){
  const r=el.getBoundingClientRect(),{W,H,p}=scene;
  const px=(ev.clientX-r.left)/r.width*W,py=(ev.clientY-r.top)/r.height*H;
  return {r,px,py,fraction:Math.max(0,Math.min(1,(px-p.l)/(W-p.l-p.r))),inside:px>=p.l&&px<=W-p.r&&py>=p.t&&py<=H-p.b};
}
function showTip(id,ev){
  const el=document.getElementById(id),scene=scenes.get(id),tip=document.getElementById(id.replace('Chart','Tip'));
  if(!scene||!tip||scene.drag)return;
  const g=geometry(el,scene,ev);if(!g.inside){hideTip(id);return}
  const i=Math.round(g.fraction*(scene.dates.length-1));
  tip.textContent=scene.tooltip(i);tip.style.display='block';
  const wrap=el.parentElement.getBoundingClientRect(),padding=6;
  // Size the text before positioning, including on narrow mobile screens.
  tip.style.boxSizing='border-box';tip.style.maxWidth=Math.max(0,wrap.width-padding*2)+'px';
  let left=ev.clientX-wrap.left+12,top=ev.clientY-wrap.top+12;
  if(left+tip.offsetWidth>wrap.width-padding)left=ev.clientX-wrap.left-tip.offsetWidth-12;
  if(top+tip.offsetHeight>wrap.height-padding)top=ev.clientY-wrap.top-tip.offsetHeight-12;
  tip.style.left=Math.max(padding,Math.min(wrap.width-tip.offsetWidth-padding,left))+'px';
  tip.style.top=Math.max(padding,Math.min(wrap.height-tip.offsetHeight-padding,top))+'px';
}
function registerScene(id,scene){
  finishDrag(id);hideTip(id);
  const el=document.getElementById(id),bound=scenes.get(id)?.bound;
  scenes.set(id,{...scene,bound:true,drag:null});rangeStatus(id);
  if(bound)return;
  // Listeners live on the persistent SVG, so replacing its series cannot accumulate them.
  el.addEventListener('pointerdown',ev=>{
    const s=scenes.get(id),g=geometry(el,s,ev);
    if(ev.button!==0||ev.isPrimary===false||!g.inside)return;
    ev.preventDefault();
    hideTip(id);
    const selection=S('rect',{x:g.px,y:s.p.t,width:0,height:s.H-s.p.t-s.p.b,fill:'#4b6bfb','fill-opacity':'.16',stroke:'#4b6bfb','stroke-width':1,'pointer-events':'none',class:'zoom-selection'});
    el.appendChild(selection);
    s.drag={pointerId:ev.pointerId,start:g.fraction,clientX:ev.clientX,selection};
    el.setPointerCapture?.(ev.pointerId);
  });
  el.addEventListener('pointermove',ev=>{
    const s=scenes.get(id),drag=s.drag;
    if(!drag){showTip(id,ev);return}
    if(ev.pointerId!==drag.pointerId)return;
    const g=geometry(el,s,ev),left=Math.min(drag.start,g.fraction),width=Math.abs(drag.start-g.fraction);
    drag.selection.setAttribute('x',s.p.l+left*(s.W-s.p.l-s.p.r));
    drag.selection.setAttribute('width',width*(s.W-s.p.l-s.p.r));
  });
  el.addEventListener('pointerup',ev=>{
    const s=scenes.get(id),drag=s.drag;if(!drag||ev.pointerId!==drag.pointerId)return;
    const g=geometry(el,s,ev),v=view(id),length=v.end-v.start;
    const first=Math.round(Math.min(drag.start,g.fraction)*(length-1));
    const last=Math.round(Math.max(drag.start,g.fraction)*(length-1));
    const selected=Math.abs(ev.clientX-drag.clientX)>=8;
    finishDrag(id);
    if(selected)setView(id,v.start+first,v.start+last+1);else showTip(id,ev);
  });
  ['pointercancel','lostpointercapture'].forEach(type=>el.addEventListener(type,()=>{finishDrag(id);hideTip(id)}));
  el.addEventListener('pointerleave',()=>hideTip(id));
  el.addEventListener('wheel',ev=>{
    if(!ev.ctrlKey||!ev.deltaY)return;
    const s=scenes.get(id),g=geometry(el,s,ev);if(!g.inside)return;
    ev.preventDefault();finishDrag(id);zoom(id,ev.deltaY<0?.8:1.25,g.fraction);
  },{passive:false});
}
function seriesGroup(el,id,W,H,p){
  const defs=S('defs',{}),clip=S('clipPath',{id:id+'Clip'});
  clip.appendChild(S('rect',{x:p.l,y:p.t,width:W-p.l-p.r,height:H-p.t-p.b}));
  defs.appendChild(clip);el.appendChild(defs);
  const group=S('g',{'clip-path':'url(#'+id+'Clip)'});el.appendChild(group);return group;
}

function ticksFor(dates){
  const n=dates.length>1200?8:dates.length>700?7:dates.length>350?6:dates.length>150?5:3;
  return Array.from({length:n},(_,k)=>Math.round((dates.length-1)*k/Math.max(1,n-1)));
}
function dateTick(dates,i){return dates.length<=60?dates[i]:dates[i].slice(0,7)}
function linePath(values,x,y){
  let d='',on=false;
  values.forEach((v,i)=>{if(finite(v)){d+=(on?'L':'M')+x(i)+' '+y(v)+' ';on=true}else on=false});
  return d;
}

function drawCombined(){
  const id='combinedChart',el=document.getElementById(id);
  const dates=VD(id),raw=V(D[metric],id),smoothAll=smoothing(D[metric],smoothN,smoothType),smooth=V(smoothAll,id);
  const bench=V(benchMode==='abs'?D.ihsg:D.ihsg_1y,id);
  const W=1100,H=420,p={l:54,r:64,t:18,b:32};el.replaceChildren();
  const x=i=>p.l+(W-p.l-p.r)*(i/Math.max(1,dates.length-1));
  const yL=v=>p.t+(H-p.t-p.b)*(1-v/100);
  const bvals=bench.filter(finite);let blo=Math.min(...bvals),bhi=Math.max(...bvals);
  if(!finite(blo)||!finite(bhi)){blo=0;bhi=1}if(blo===bhi){blo-=1;bhi+=1}
  const pad=(bhi-blo)*.08||1;blo-=pad;bhi+=pad;
  const yR=v=>p.t+(H-p.t-p.b)*(1-(v-blo)/(bhi-blo));
  [[0,30,'#d9534f'],[30,70,'#d9a620'],[70,100,'#2ca36c']].forEach(([lo,hi,c])=>el.appendChild(S('rect',{x:p.l,y:yL(hi),width:W-p.l-p.r,height:yL(lo)-yL(hi),fill:c,opacity:.09})));
  [0,25,50,75,100].forEach(v=>{const yy=yL(v);el.appendChild(S('line',{x1:p.l,x2:W-p.r,y1:yy,y2:yy,class:'gridline'}));const t=S('text',{x:p.l-8,y:yy+3,'text-anchor':'end',class:'axis'});t.textContent=v;el.appendChild(t)});
  for(let q=0;q<=4;q++){const v=blo+(bhi-blo)*q/4,yy=yR(v);const t=S('text',{x:W-p.r+8,y:yy+3,'text-anchor':'start',class:'axis benchmark-axis'});t.textContent=benchMode==='abs'?fmt(v,0):fmt(v,1)+'%';el.appendChild(t)}
  ticksFor(dates).forEach((i,k,a)=>{const t=S('text',{x:x(i),y:H-7,'text-anchor':k===0?'start':k===a.length-1?'end':'middle',class:'axis'});t.textContent=dateTick(dates,i);el.appendChild(t)});
  const series=seriesGroup(el,id,W,H,p);
  series.appendChild(S('path',{d:linePath(raw,x,yL),class:'line raw',stroke:'#8da5ff'}));
  series.appendChild(S('path',{d:linePath(smooth,x,yL),class:'line',stroke:'#4b6bfb'}));
  series.appendChild(S('path',{d:linePath(bench,x,yR),class:'line benchmark',stroke:'#c06b18'}));
  el.appendChild(S('rect',{x:p.l,y:p.t,width:W-p.l-p.r,height:H-p.t-p.b,fill:'transparent',class:'plot-hit-area',style:'cursor:crosshair;touch-action:pan-y'}));
  registerScene(id,{W,H,p,dates,raw,smoothed:smooth,benchmark:bench,tooltip:i=>dates[i]+' | raw '+(finite(raw[i])?fmt(raw[i])+'%':'—')+' | '+smoothType+smoothN+' '+(finite(smooth[i])?fmt(smooth[i])+'%':'—')+' | IHSG '+(finite(bench[i])?(benchMode==='abs'?fmt(bench[i],0):fmt(bench[i])+'%'):'—')});
}

function drawSingle(id,rawAll,smoothAll,opt){
  const el=document.getElementById(id),dates=VD(id),raw=V(rawAll,id),smooth=V(smoothAll,id);
  const W=1100,H=300,p={l:52,r:18,t:16,b:30};el.replaceChildren();
  let lo=opt.min,hi=opt.max;
  if(lo==null||hi==null){const vals=[...raw,...smooth].filter(finite);lo=lo??Math.min(...vals);hi=hi??Math.max(...vals)}
  if(!finite(lo)||!finite(hi)){lo=0;hi=1}if(lo===hi){lo-=1;hi+=1}
  const x=i=>p.l+(W-p.l-p.r)*(i/Math.max(1,dates.length-1)),y=v=>p.t+(H-p.t-p.b)*(1-(v-lo)/(hi-lo));
  for(let q=0;q<=4;q++){const v=lo+(hi-lo)*q/4,yy=y(v);el.appendChild(S('line',{x1:p.l,x2:W-p.r,y1:yy,y2:yy,class:'gridline'}));const t=S('text',{x:p.l-8,y:yy+3,'text-anchor':'end',class:'axis'});t.textContent=opt.axis?opt.axis(v):fmt(v);el.appendChild(t)}
  if(finite(opt.ref)&&opt.ref>=lo&&opt.ref<=hi){el.appendChild(S('line',{x1:p.l,x2:W-p.r,y1:y(opt.ref),y2:y(opt.ref),class:'reference-line'}))}
  ticksFor(dates).forEach((i,k,a)=>{const t=S('text',{x:x(i),y:H-7,'text-anchor':k===0?'start':k===a.length-1?'end':'middle',class:'axis'});t.textContent=dateTick(dates,i);el.appendChild(t)});
  const series=seriesGroup(el,id,W,H,p);
  series.appendChild(S('path',{d:linePath(raw,x,y),class:'line raw',stroke:opt.color||'#8da5ff'}));
  series.appendChild(S('path',{d:linePath(smooth,x,y),class:'line',stroke:opt.color||'#4b6bfb'}));
  el.appendChild(S('rect',{x:p.l,y:p.t,width:W-p.l-p.r,height:H-p.t-p.b,fill:'transparent',class:'plot-hit-area',style:'cursor:crosshair;touch-action:pan-y'}));
  registerScene(id,{W,H,p,dates,raw,smoothed:smooth,tooltip:i=>opt.tooltip?opt.tooltip(i+view(id).start):dates[i]+' | raw '+(finite(raw[i])?opt.tip(raw[i]):'—')+' | smoothed '+(finite(smooth[i])?opt.tip(smooth[i]):'—')});
}

function volumeFields(){
  if(volMode==='balance')return {raw:D.volume_balance,help:'Directional balance: +100 means abnormal volume is entirely on rising stocks, -100 entirely on falling stocks, 0 is balanced.',min:-100,max:100,ref:0,tip:v=>fmt(v,1),color:'#d9534f'};
  if(volMode==='spike')return {raw:D.volume_spike,help:'High-volume breadth: percentage of valid stocks with RVOL ≥ 1.5× their own prior-20-observed-session average.',min:0,max:100,ref:25,tip:v=>fmt(v,1)+'%',color:'#8b5cf6'};
  return {raw:D.volume_index,help:'Activity index: 100 = normal aggregate relative volume. Above 100 = above-normal activity; below 100 = below-normal.',min:0,max:null,ref:100,tip:v=>fmt(v,1),color:'#4b6bfb'};
}
function drawVolume(){
  const f=volumeFields(),sm=smoothing(f.raw,volSmoothN,volSmoothType),vals=[...V(f.raw,'volumeChart'),...V(sm,'volumeChart')].filter(finite);
  let max=f.max;if(max==null)max=Math.max(160,(vals.length?Math.max(...vals):160)*1.05);
  document.getElementById('volumeHelp').textContent=f.help;
  document.getElementById('volumeNote').textContent='Smoothing: '+volSmoothType+volSmoothN+'. Gaps mean source observations were unavailable; they are not filled with zero or interpolated.';
  drawSingle('volumeChart',f.raw,sm,{min:f.min,max,ref:f.ref,tip:f.tip,color:f.color});
}
function drawCoverage(){
  drawSingle('coverageChart',coverageValues,coverageValues,{min:0,max:100,ref:95,tip:v=>fmt(v,1)+'%',color:'#2ca36c',tooltip:i=>D.dates[i]+' | Coverage '+(finite(coverageValues[i])?fmt(coverageValues[i],2)+'%':'N/A')+' | Valid '+(D.eligible?.[i]??'—')+' / target '+(D.target?.[i]??'—')+(finite(coverageValues[i])&&coverageValues[i]<95?' | Incomplete observations; not a market decline.':'')});
  const v=view('coverageChart');let low=0,minimum=null;
  for(let i=v.start;i<v.end;i++){
    if(!finite(coverageValues[i]))continue;
    if(coverageValues[i]<95)low++;
    if(minimum===null||coverageValues[i]<coverageValues[minimum])minimum=i;
  }
  set('coverageStatus',minimum===null?'No usable indicator observations in this view.':low.toLocaleString()+' sessions below 95% in this view. Lowest: '+fmt(coverageValues[minimum],2)+'% on '+D.dates[minimum]+' ('+D.eligible[minimum]+' valid / '+D.target[minimum]+' target stocks).');
}

function updateKpis(){
  const mb=smoothing(D.macd,smoothN,smoothType),ma=smoothing(D.ma,smoothN,smoothType),st=smoothing(D.st,smoothN,smoothType),cp=smoothing(D.composite,smoothN,smoothType);
  set('kMacd',fmt(last(mb))+'%');set('kMacdSub',reg(last(mb)));
  set('kMa',fmt(last(ma))+'%');set('kMaSub',reg(last(ma)));
  set('kSt',fmt(last(st))+'%');set('kStSub',reg(last(st)));
  set('kComp',fmt(last(cp))+'%');set('kCompSub',reg(last(cp)));
  set('kValid',String(last(D.eligible)??'—'));set('kCoverage',fmt(last(coverageValues))+'% coverage');
  const vb=smoothing(D.volume_balance,volSmoothN,volSmoothType);
  set('kVolBal',fmt(last(vb)));set('kVolSub',volSmoothType+volSmoothN+' smoothed');
}
function updateFacts(){
  set('fDate',D.meta.market_as_of);
  set('fHistory',D.meta.history_start+' → '+D.meta.market_as_of+' ('+D.dates.length.toLocaleString()+' sessions)');
  set('fRoster',(D.meta.universe_symbols||D.meta.symbols||'—')+' stocks');
  set('fPrice',fmt(D.meta.price_coverage_pct??D.meta.last_price_coverage_pct,2)+'%');
  set('fCap',fmt(D.meta.cap_coverage_pct??D.meta.last_cap_coverage_pct,2)+'%');
  set('fSources',D.meta.source_priority||((D.meta.sources||[]).map(x=>typeof x==='string'?x:x.name).join(' · '))||D.meta.benchmark_provider||'—');
  set('fMethod',D.meta.methodology||D.meta.universe||'Current-roster retrospective breadth; survivorship bias applies.');
  set('footerText','Aggregate-only public display · market date '+D.meta.market_as_of+' · '+D.dates.length.toLocaleString()+' valid breadth sessions');
}
function drawAll(){drawCombined();drawVolume();drawCoverage();updateKpis()}

const themeBtn=document.getElementById('themeBtn');
if(localStorage.getItem('ihsg-theme')==='dark')document.body.classList.add('dark');
function themeText(){themeBtn.textContent=document.body.classList.contains('dark')?'Light mode':'Dark mode'}themeText();
themeBtn.onclick=()=>{document.body.classList.toggle('dark');localStorage.setItem('ihsg-theme',document.body.classList.contains('dark')?'dark':'light');themeText();drawAll()};

document.getElementById('smoothType').value=smoothType;document.getElementById('smoothN').value=smoothN;
document.getElementById('volSmoothType').value=volSmoothType;document.getElementById('volSmoothN').value=volSmoothN;
document.querySelectorAll('.range').forEach(b=>b.classList.toggle('active',b.dataset.range===range));
document.querySelectorAll('.volume-mode').forEach(b=>b.classList.toggle('active',b.dataset.volume===volMode));

document.querySelectorAll('.metric').forEach(b=>b.onclick=()=>{metric=b.dataset.metric;document.querySelectorAll('.metric').forEach(x=>x.classList.toggle('active',x===b));drawCombined()});
document.querySelectorAll('.range').forEach(b=>b.onclick=()=>{range=b.dataset.range;localStorage.setItem('ihsg-range',range);document.querySelectorAll('.range').forEach(x=>x.classList.toggle('active',x===b));resetViews();drawAll()});
document.querySelectorAll('.zoom-control').forEach(b=>b.addEventListener('click',()=>{if(chartIds.includes(b.dataset.chart)&&['in','out','reset'].includes(b.dataset.zoom))zoom(b.dataset.chart,b.dataset.zoom)}));
document.querySelectorAll('.volume-mode').forEach(b=>b.onclick=()=>{volMode=b.dataset.volume;localStorage.setItem('ihsg-volume-mode',volMode);document.querySelectorAll('.volume-mode').forEach(x=>x.classList.toggle('active',x===b));drawVolume()});
document.getElementById('absBtn').onclick=()=>{benchMode='abs';document.getElementById('absBtn').classList.add('active');document.getElementById('retBtn').classList.remove('active');drawCombined()};
document.getElementById('retBtn').onclick=()=>{benchMode='ret';document.getElementById('retBtn').classList.add('active');document.getElementById('absBtn').classList.remove('active');drawCombined()};
document.getElementById('applySmooth').onclick=()=>{const n=Number(document.getElementById('smoothN').value),t=document.getElementById('smoothType').value;if(!Number.isInteger(n)||n<1||n>1260)return alert('Enter a smoothing length from 1 to 1260.');smoothN=n;smoothType=t;localStorage.setItem('ihsg-smooth-n',n);localStorage.setItem('ihsg-smooth-type',t);drawCombined();updateKpis()};
document.getElementById('applyVolSmooth').onclick=()=>{const n=Number(document.getElementById('volSmoothN').value),t=document.getElementById('volSmoothType').value;if(!Number.isInteger(n)||n<1||n>1260)return alert('Enter a smoothing length from 1 to 1260.');volSmoothN=n;volSmoothType=t;localStorage.setItem('ihsg-vol-smooth-n',n);localStorage.setItem('ihsg-vol-smooth-type',t);drawVolume();updateKpis()};

const age=Math.floor((Date.now()-new Date(D.meta.market_as_of+'T00:00:00Z'))/86400000);
if(age>4){const b=document.getElementById('staleBanner');b.className='banner show';b.textContent='Data may be stale: last market observation is '+D.meta.market_as_of+'.';}
updateFacts();drawAll();
// Inspection exposes only the aggregate chart view, never stock-level observations.
window.__IHSG_TEST__=Object.freeze({getView:id=>{
  if(!chartIds.includes(id))return null;
  const v=view(id),scene=scenes.get(id);
  return {start:v.start,end:v.end,count:v.end-v.start,dates:[...scene.dates],raw:[...scene.raw],smoothed:[...scene.smoothed],...(scene.benchmark?{benchmark:[...scene.benchmark]}:{})};
}});
})();
