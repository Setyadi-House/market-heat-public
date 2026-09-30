(()=>{'use strict';
const D=window.IHSG_PUBLIC_DATA||null;
const banner=document.getElementById('staleBanner');
if(!D||!Array.isArray(D.dates)||!D.dates.length){
  banner.textContent='Validated aggregate history could not be loaded.';
  banner.className='banner show';
  return;
}
const n=D.dates.length;
const spikeThresholds=[.5,1,1.25,1.5,1.75,2,2.5,3,4,5];
const spikePeriods=[5,10,20,50,100,200];
const aligned=Object.entries(D).filter(([k,v])=>k!=='meta'&&Array.isArray(v));
if(aligned.some(([,v])=>v.length!==n)||D.meta?.display_points!==n){
  banner.textContent='Aggregate payload failed alignment validation.';
  banner.className='banner show';
  return;
}
const hasHighVolume=Object.hasOwn(D,'high_volume');
function objectKeys(value,expected){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key))}
function highVolumeAligned(){
  const table=D.high_volume;
  if(!objectKeys(table,['schema_version','periods'])||table.schema_version!==1||!objectKeys(table.periods,spikePeriods.map(String)))return false;
  for(const period of spikePeriods){
    const row=table.periods[period];
    if(!objectKeys(row,['valid','counts'])||!Array.isArray(row.valid)||row.valid.length!==n||!objectKeys(row.counts,spikeThresholds.map(String)))return false;
    if(row.valid.some((value,index)=>!Number.isInteger(value)||value<0||!Number.isInteger(D.eligible?.[index])||value>D.eligible[index]))return false;
    let previous=row.valid;
    for(const threshold of spikeThresholds){
      const counts=row.counts[threshold];
      if(!Array.isArray(counts)||counts.length!==n||counts.some((value,index)=>!Number.isInteger(value)||value<0||value>previous[index]))return false;
      previous=counts;
    }
  }
  const defaults=table.periods[20];
  return defaults.valid.every((value,index)=>value===D.volume_valid?.[index]&&(value===0?D.volume_spike?.[index]===null:Number.isFinite(D.volume_spike?.[index])&&Math.abs(D.volume_spike[index]-100*defaults.counts['1.5'][index]/value)<=.0000005001));
}
if(hasHighVolume&&!highVolumeAligned()){
  banner.textContent='High-volume aggregate data failed alignment validation.';
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
let spikeThreshold=Number(localStorage.getItem('ihsg-spike-threshold')||1.5);
let spikePeriod=Number(localStorage.getItem('ihsg-spike-period')||20);
if(!['6M','1Y','3Y','5Y','ALL'].includes(range))range='1Y';
if(!['EMA','SMA'].includes(smoothType))smoothType='EMA';
if(!['EMA','SMA'].includes(volSmoothType))volSmoothType='SMA';
if(!['activity','balance','spike'].includes(volMode))volMode='activity';
if(!spikeThresholds.includes(spikeThreshold))spikeThreshold=1.5;
if(!spikePeriods.includes(spikePeriod))spikePeriod=20;
if(!hasHighVolume){spikeThreshold=1.5;spikePeriod=20}

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
function observedSmoothing(a,n,type){
  // Directional balance can be undefined when every valid RVOL weight is zero.
  // Keep that session missing, but do not discard neighbouring observations.
  const out=Array(a.length).fill(null),window=[];let sum=0,previous=null;
  const alpha=2/(n+1);
  a.forEach((value,index)=>{
    if(!finite(value))return;
    if(type==='EMA'){previous=previous===null?value:alpha*value+(1-alpha)*previous;out[index]=previous}
    else{window.push(value);sum+=value;if(window.length>n)sum-=window.shift();if(window.length===n)out[index]=sum/n}
  });
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
const views=new Map(),scenes=new Map(),interactionModes=new Map();
function view(id){
  const base=startIndex();
  if(!views.has(id))views.set(id,{start:base,end:n});
  return views.get(id);
}
function V(a,id){const v=view(id);return a.slice(v.start,v.end)}
function VD(id){return V(D.dates,id)}
function isZoomed(id){const v=view(id);return v.start!==startIndex()||v.end!==n}
function S(tag,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e}

function hideTip(id){const tip=document.getElementById(id.replace('Chart','Tip'));if(tip)tip.style.display='none'}
function finishDrag(id){
  const scene=scenes.get(id);if(!scene?.drag)return;
  const el=document.getElementById(id),drag=scene.drag;
  scene.drag=null;drag.selection?.remove();el.classList.remove('is-panning');
  if(el.hasPointerCapture?.(drag.pointerId))el.releasePointerCapture(drag.pointerId);
}
function syncInteractionMode(id){
  const mode=interactionModes.get(id)||'pan',el=document.getElementById(id);
  el.dataset.interactionMode=mode;
  document.querySelectorAll('.box-zoom-control').forEach(button=>{
    if(button.dataset.chart!==id)return;
    button.setAttribute('aria-pressed',String(mode==='zoom'));
    button.classList.toggle('active',mode==='zoom');
  });
}
function bindBoxZoomControls(){
  document.querySelectorAll('.box-zoom-control').forEach(button=>button.addEventListener('click',()=>{
    const id=button.dataset.chart;if(!chartIds.includes(id))return;
    finishDrag(id);hideTip(id);
    interactionModes.set(id,(interactionModes.get(id)||'pan')==='pan'?'zoom':'pan');
    syncInteractionMode(id);document.getElementById(id).focus({preventScroll:true});
  }));
}
function resetViews(){chartIds.forEach(id=>{finishDrag(id);views.delete(id);hideTip(id)})}
function redrawChart(id){if(id==='combinedChart')drawCombined();else if(id==='volumeChart')drawVolume();else if(id==='coverageChart')drawCoverage()}
function setView(id,start,end){
  const base=startIndex(),minimum=Math.min(5,n-base),count=Math.max(minimum,Math.min(n-base,Math.round(end-start)));
  start=Math.max(0,Math.min(n-count,Math.round(start)));
  const current=view(id);if(current.start===start&&current.end===start+count)return false;
  views.set(id,{start,end:start+count});redrawChart(id);
  return true;
}
function zoom(id,direction){
  const v=view(id),count=v.end-v.start,base=startIndex();
  if(direction==='reset')return setView(id,base,n);
  const factor=direction==='in'?.5:direction==='out'?2:direction;
  const size=Math.max(Math.min(5,n-base),Math.min(n-base,Math.round(count*factor)));
  // Wheel and keyboard zoom always return to the newest available sessions.
  // Box zoom is the separate way to inspect a selected historical period.
  return setView(id,n-size,n);
}
function pan(id,direction){
  const v=view(id),count=v.end-v.start,step=Math.max(1,Math.round(count*.2));
  const start=Math.max(0,Math.min(n-count,v.start+(direction==='left'?-step:step)));
  if(start===v.start)return;
  finishDrag(id);setView(id,start,start+count);
}
function rangeStatus(id){
  const v=view(id),count=v.end-v.start,base=startIndex(),el=document.getElementById(id);
  el.dataset.start=String(v.start);el.dataset.end=String(v.end);el.dataset.count=String(count);
  el.dataset.firstDate=D.dates[v.start];el.dataset.lastDate=D.dates[v.end-1];
  set(id+'Range',D.dates[v.start]+' → '+D.dates[v.end-1]+' · '+count.toLocaleString()+' sessions');
  document.querySelectorAll('.zoom-control').forEach(b=>{
    if(b.dataset.chart!==id)return;
    b.disabled=b.dataset.zoom==='in'?count<=Math.min(5,n-base):b.dataset.zoom==='reset'?v.start===base&&v.end===n:count===n-base;
  });
}
function geometry(el,scene,ev){
  const {W,H,p}=scene,matrix=el.getScreenCTM();
  if(!matrix)return {px:0,py:0,fraction:0,inside:false};
  // Screen-to-SVG coordinates also account for letterboxing and CSS transforms.
  const point=new DOMPoint(ev.clientX,ev.clientY).matrixTransform(matrix.inverse()),px=point.x,py=point.y;
  return {px,py,fraction:Math.max(0,Math.min(1,(px-p.l)/(W-p.l-p.r))),inside:px>=p.l&&px<=W-p.r&&py>=p.t&&py<=H-p.b};
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
  hideTip(id);
  const el=document.getElementById(id),previous=scenes.get(id),bound=previous?.bound;
  // The SVG itself owns capture. Keep the gesture's original anchor while its
  // series are redrawn so successive pan moves do not release capture or jump.
  const drag=previous?.drag||null;
  scenes.set(id,{...scene,bound:true,drag,wheelDelta:previous?.wheelDelta||0});
  if(drag?.selection)el.appendChild(drag.selection);
  el.classList.toggle('is-panning',drag?.mode==='pan');
  rangeStatus(id);syncInteractionMode(id);
  el.dataset.yMin=String(scene.yDomain[0]);el.dataset.yMax=String(scene.yDomain[1]);
  el.dataset.autoScale=String(isZoomed(id));
  if(scene.benchmarkDomain){el.dataset.benchmarkMin=String(scene.benchmarkDomain[0]);el.dataset.benchmarkMax=String(scene.benchmarkDomain[1])}
  if(bound)return;
  // Listeners live on the persistent SVG, so replacing its series cannot accumulate them.
  el.addEventListener('pointerdown',ev=>{
    const s=scenes.get(id),g=geometry(el,s,ev);
    if(ev.button!==0||ev.isPrimary===false||!g.inside)return;
    ev.preventDefault();
    el.focus({preventScroll:true});
    hideTip(id);
    const mode=interactionModes.get(id)||'pan',v=view(id);
    const selection=mode==='zoom'?S('rect',{x:g.px,y:g.py,width:0,height:0,class:'zoom-selection'}):null;
    if(selection)el.appendChild(selection);
    s.drag={pointerId:ev.pointerId,mode,start:g.fraction,startX:g.px,startY:g.py,clientX:ev.clientX,viewStart:v.start,count:v.end-v.start,plotWidth:s.W-s.p.l-s.p.r,selection};
    el.classList.toggle('is-panning',mode==='pan');
    el.setPointerCapture?.(ev.pointerId);
  });
  el.addEventListener('pointermove',ev=>{
    const s=scenes.get(id),drag=s.drag;
    if(!drag){if(ev.buttons)hideTip(id);else showTip(id,ev);return}
    if(ev.pointerId!==drag.pointerId)return;
    ev.preventDefault();hideTip(id);
    const g=geometry(el,s,ev);
    if(drag.mode==='pan'){
      const start=drag.viewStart-(g.px-drag.startX)*(drag.count-1)/drag.plotWidth;
      setView(id,start,start+drag.count);return;
    }
    const x=Math.max(s.p.l,Math.min(s.W-s.p.r,g.px)),y=Math.max(s.p.t,Math.min(s.H-s.p.b,g.py));
    drag.selection.setAttribute('x',Math.min(drag.startX,x));
    drag.selection.setAttribute('y',Math.min(drag.startY,y));
    drag.selection.setAttribute('width',Math.abs(drag.startX-x));
    drag.selection.setAttribute('height',Math.abs(drag.startY-y));
  });
  el.addEventListener('pointerup',ev=>{
    const s=scenes.get(id),drag=s.drag;if(!drag||ev.pointerId!==drag.pointerId)return;
    const g=geometry(el,s,ev),v=view(id),length=v.end-v.start;
    const first=Math.round(Math.min(drag.start,g.fraction)*(length-1));
    const last=Math.round(Math.max(drag.start,g.fraction)*(length-1));
    const selected=drag.mode==='zoom'&&Math.abs(ev.clientX-drag.clientX)>=8;
    finishDrag(id);
    if(selected)setView(id,v.start+first,v.start+last+1);
  });
  ['pointercancel','lostpointercapture'].forEach(type=>el.addEventListener(type,ev=>{
    if(scenes.get(id)?.drag?.pointerId!==ev.pointerId)return;
    finishDrag(id);hideTip(id);
  }));
  el.addEventListener('pointerleave',()=>hideTip(id));
  el.addEventListener('wheel',ev=>{
    if(!ev.deltaY)return;
    const s=scenes.get(id),g=geometry(el,s,ev);if(!g.inside)return;
    // Ordinary wheel and Ctrl+wheel zoom only over the plot. Small trackpad
    // movements zoom gradually; scrolling over labels or the page stays native.
    const delta=ev.deltaY*(ev.deltaMode===1?16:ev.deltaMode===2?s.H:1);
    ev.preventDefault();finishDrag(id);
    const current=view(id),count=current.end-current.start,baseCount=n-startIndex();
    if(current.end===n&&((delta<0&&count===Math.min(5,baseCount))||(delta>0&&count===baseCount))){s.wheelDelta=0;return}
    if(Math.sign(s.wheelDelta)!==Math.sign(delta))s.wheelDelta=0;
    // Keep sub-session movements until their combined delta changes the date
    // window. Otherwise tiny outward trackpad events could stay at five forever.
    s.wheelDelta+=delta;
    if(zoom(id,Math.exp(Math.max(-.4,Math.min(.4,s.wheelDelta*.002)))))scenes.get(id).wheelDelta=0;
  },{passive:false});
  el.addEventListener('keydown',ev=>{
    if(ev.key==='+'||ev.key==='='){ev.preventDefault();finishDrag(id);zoom(id,'in')}
    else if(ev.key==='-'){ev.preventDefault();finishDrag(id);zoom(id,'out')}
    else if(ev.key==='Home'){ev.preventDefault();finishDrag(id);zoom(id,'reset')}
    else if(ev.key==='ArrowLeft'||ev.key==='ArrowRight'){ev.preventDefault();pan(id,ev.key==='ArrowLeft'?'left':'right')}
    else if(ev.key==='Escape'){ev.preventDefault();finishDrag(id);hideTip(id);interactionModes.set(id,'pan');syncInteractionMode(id)}
  });
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
function visibleDomain(values,{min=-Infinity,max=Infinity,minSpan=1,fallback=[0,1]}={}){
  const observed=values.filter(finite);
  if(!observed.length)return [...fallback];
  let lo=Math.min(...observed),hi=Math.max(...observed);
  const padding=Math.max((hi-lo)*.08,minSpan/2);
  lo=Math.max(min,lo-padding);hi=Math.min(max,hi+padding);
  if(!(hi>lo))return [...fallback];
  return [lo,hi];
}
function axisValue(value,span){
  const decimals=Math.max(0,Math.min(4,1-Math.floor(Math.log10(Math.abs(span/4)||1))));
  return fmt(value,decimals);
}

function drawCombined(){
  const id='combinedChart',el=document.getElementById(id);
  const dates=VD(id),raw=V(D[metric],id),smoothAll=smoothing(D[metric],smoothN,smoothType),smooth=V(smoothAll,id);
  const bench=V(benchMode==='abs'?D.ihsg:D.ihsg_1y,id);
  const W=1100,H=420,p={l:54,r:64,t:18,b:32};el.replaceChildren();
  const x=i=>p.l+(W-p.l-p.r)*(i/Math.max(1,dates.length-1));
  const [lo,hi]=isZoomed(id)?visibleDomain([...raw,...smooth],{min:0,max:100,minSpan:1,fallback:[0,100]}):[0,100];
  const yL=v=>p.t+(H-p.t-p.b)*(1-(v-lo)/(hi-lo));
  const bvals=bench.filter(finite);let blo=Math.min(...bvals),bhi=Math.max(...bvals);
  if(!finite(blo)||!finite(bhi)){blo=0;bhi=1}if(blo===bhi){blo-=1;bhi+=1}
  const pad=(bhi-blo)*.08||1;blo-=pad;bhi+=pad;
  const yR=v=>p.t+(H-p.t-p.b)*(1-(v-blo)/(bhi-blo));
  [[0,30,'#d9534f'],[30,70,'#d9a620'],[70,100,'#2ca36c']].forEach(([bandLo,bandHi,c])=>{
    const bottom=Math.max(lo,bandLo),top=Math.min(hi,bandHi);if(top<=bottom)return;
    el.appendChild(S('rect',{x:p.l,y:yL(top),width:W-p.l-p.r,height:yL(bottom)-yL(top),fill:c,opacity:.09}));
  });
  for(let q=0;q<=4;q++){const v=lo+(hi-lo)*q/4,yy=yL(v);el.appendChild(S('line',{x1:p.l,x2:W-p.r,y1:yy,y2:yy,class:'gridline'}));const t=S('text',{x:p.l-8,y:yy+3,'text-anchor':'end',class:'axis'});t.textContent=isZoomed(id)?axisValue(v,hi-lo):String(v);el.appendChild(t)}
  for(let q=0;q<=4;q++){const v=blo+(bhi-blo)*q/4,yy=yR(v);const t=S('text',{x:W-p.r+8,y:yy+3,'text-anchor':'start',class:'axis benchmark-axis'});t.textContent=(isZoomed(id)?axisValue(v,bhi-blo):fmt(v,benchMode==='abs'?0:1))+(benchMode==='abs'?'':'%');el.appendChild(t)}
  ticksFor(dates).forEach((i,k,a)=>{const t=S('text',{x:x(i),y:H-7,'text-anchor':k===0?'start':k===a.length-1?'end':'middle',class:'axis'});t.textContent=dateTick(dates,i);el.appendChild(t)});
  const series=seriesGroup(el,id,W,H,p);
  series.appendChild(S('path',{d:linePath(raw,x,yL),class:'line raw',stroke:'#8da5ff'}));
  series.appendChild(S('path',{d:linePath(smooth,x,yL),class:'line',stroke:'#4b6bfb'}));
  series.appendChild(S('path',{d:linePath(bench,x,yR),class:'line benchmark',stroke:'#c06b18'}));
  el.appendChild(S('rect',{x:p.l,y:p.t,width:W-p.l-p.r,height:H-p.t-p.b,fill:'transparent',class:'plot-hit-area'}));
  registerScene(id,{W,H,p,dates,raw,smoothed:smooth,benchmark:bench,yDomain:[lo,hi],benchmarkDomain:[blo,bhi],tooltip:i=>dates[i]+' | raw '+(finite(raw[i])?fmt(raw[i])+'%':'—')+' | '+smoothType+smoothN+' '+(finite(smooth[i])?fmt(smooth[i])+'%':'—')+' | IHSG '+(finite(bench[i])?(benchMode==='abs'?fmt(bench[i],0):fmt(bench[i])+'%'):'—')});
}

function drawSingle(id,rawAll,smoothAll,opt){
  const el=document.getElementById(id),dates=VD(id),raw=V(rawAll,id),smooth=V(smoothAll,id);
  const W=1100,H=300,p={l:52,r:18,t:16,b:30};el.replaceChildren();
  let lo=opt.min,hi=opt.max;
  if(lo==null||hi==null){const vals=[...raw,...smooth].filter(finite);lo=lo??Math.min(...vals);hi=hi??Math.max(...vals)}
  if(!finite(lo)||!finite(hi)){lo=0;hi=1}if(lo===hi){lo-=1;hi+=1}
  if(isZoomed(id))[lo,hi]=visibleDomain([...raw,...smooth],{min:opt.domainMin??-Infinity,max:opt.domainMax??Infinity,minSpan:opt.minSpan??1,fallback:[lo,hi]});
  const x=i=>p.l+(W-p.l-p.r)*(i/Math.max(1,dates.length-1)),y=v=>p.t+(H-p.t-p.b)*(1-(v-lo)/(hi-lo));
  for(let q=0;q<=4;q++){const v=lo+(hi-lo)*q/4,yy=y(v);el.appendChild(S('line',{x1:p.l,x2:W-p.r,y1:yy,y2:yy,class:'gridline'}));const t=S('text',{x:p.l-8,y:yy+3,'text-anchor':'end',class:'axis'});t.textContent=opt.axis?opt.axis(v):isZoomed(id)?axisValue(v,hi-lo):fmt(v);el.appendChild(t)}
  if(finite(opt.ref)&&opt.ref>=lo&&opt.ref<=hi){el.appendChild(S('line',{x1:p.l,x2:W-p.r,y1:y(opt.ref),y2:y(opt.ref),class:'reference-line'}))}
  ticksFor(dates).forEach((i,k,a)=>{const t=S('text',{x:x(i),y:H-7,'text-anchor':k===0?'start':k===a.length-1?'end':'middle',class:'axis'});t.textContent=dateTick(dates,i);el.appendChild(t)});
  const series=seriesGroup(el,id,W,H,p);
  series.appendChild(S('path',{d:linePath(raw,x,y),class:'line raw',stroke:opt.color||'#8da5ff'}));
  series.appendChild(S('path',{d:linePath(smooth,x,y),class:'line',stroke:opt.color||'#4b6bfb'}));
  el.appendChild(S('rect',{x:p.l,y:p.t,width:W-p.l-p.r,height:H-p.t-p.b,fill:'transparent',class:'plot-hit-area'}));
  registerScene(id,{W,H,p,dates,raw,smoothed:smooth,yDomain:[lo,hi],tooltip:i=>opt.tooltip?opt.tooltip(i+view(id).start):dates[i]+' | raw '+(finite(raw[i])?opt.tip(raw[i]):'—')+' | smoothed '+(finite(smooth[i])?opt.tip(smooth[i]):'—')});
}

function highVolumeSelection(){
  const row=hasHighVolume?D.high_volume.periods[spikePeriod]:null;
  const valid=row?.valid||D.volume_valid,hits=row?.counts[spikeThreshold]||null;
  const raw=spikePeriod===20&&spikeThreshold===1.5?D.volume_spike:valid.map((count,index)=>count>0?100*hits[index]/count:null);
  return {raw,valid,hits,threshold:spikeThreshold,period:spikePeriod};
}
function syncSpikeSettings(){
  const group=document.getElementById('spikeSettings'),threshold=document.getElementById('spikeThreshold'),period=document.getElementById('spikePeriod');
  if(group)group.hidden=volMode!=='spike';
  if(threshold){threshold.value=String(spikeThreshold);threshold.disabled=!hasHighVolume}
  if(period){period.value=String(spikePeriod);period.disabled=!hasHighVolume}
  set('spikeSettingsNote',hasHighVolume?'Updates high-volume breadth immediately. Activity and Directional balance keep their prior-20-bar baseline.':'Default 1.5× / 20 bars is available. Configurable options await a validated aggregate data update.');
}
function volumeFields(){
  if(volMode==='balance')return {raw:D.volume_balance,help:'Relative-volume-weighted balance: positive favours rising stocks; negative favours falling stocks.',min:-100,max:100,ref:0,tip:v=>fmt(v,1),color:'#d9534f'};
  if(volMode==='spike'){
    const criterion=highVolumeSelection();
    return {raw:criterion.raw,criterion,help:'High-volume breadth: percentage of volume-valid stocks with RVOL ≥ '+criterion.threshold+'×, using the prior '+criterion.period+' observed volume bars.',min:0,max:100,ref:25,tip:v=>fmt(v,1)+'%',color:'#8b5cf6'};
  }
  return {raw:D.volume_index,help:'Activity index: 100 = normal aggregate relative volume. Above 100 = above-normal activity; below 100 = below-normal.',min:0,max:null,ref:100,tip:v=>fmt(v,1),color:'#4b6bfb'};
}
function balanceSmoothingLabel(){return volSmoothType+volSmoothN+(volSmoothType==='EMA'?' valid-observation span':' valid observations')}
function drawVolume(){
  syncSpikeSettings();
  const f=volumeFields(),sm=volMode==='balance'?observedSmoothing(f.raw,volSmoothN,volSmoothType):smoothing(f.raw,volSmoothN,volSmoothType),vals=[...V(f.raw,'volumeChart'),...V(sm,'volumeChart')].filter(finite);
  let max=f.max;if(max==null)max=Math.max(160,(vals.length?Math.max(...vals):160)*1.05);
  document.getElementById('volumeHelp').textContent=f.help;
  const label=volMode==='balance'?balanceSmoothingLabel():volSmoothType+volSmoothN+' sessions';
  const criterion=f.criterion,visibleLast=view('volumeChart').end-1;
  const criterionText=criterion?' RVOL ≥ '+criterion.threshold+'×; prior '+criterion.period+' observed volume bars.'+(criterion.hits?' Last visible session: '+criterion.hits[visibleLast]+' high-volume / '+criterion.valid[visibleLast]+' volume-valid stocks.':''):'';
  document.getElementById('volumeNote').textContent='Smoothing: '+label+'. '+(volMode==='balance'?'Undefined balance dates stay blank; smoothing resumes at the next valid observation.':'Unavailable volume comparisons stay blank and are not filled with zero.')+criterionText;
  drawSingle('volumeChart',f.raw,sm,{min:f.min,max,domainMin:f.min,domainMax:volMode==='activity'?500:f.max,ref:f.ref,tip:f.tip,color:f.color,tooltip:i=>D.dates[i]+' | raw '+(finite(f.raw[i])?f.tip(f.raw[i]):'—')+' | '+label+' '+(finite(sm[i])?f.tip(sm[i]):'—')+(criterion?' | RVOL ≥ '+criterion.threshold+'× prior '+criterion.period+' observed bars'+(criterion.hits?' | High-volume '+criterion.hits[i]+' / '+criterion.valid[i]+' volume-valid stocks.':' | Volume-valid stocks '+(criterion.valid?.[i]??'—')):'')+(!finite(f.raw[i])&&volMode==='balance'?(D.volume_valid?.[i]>0&&D.volume_index?.[i]===0?' | No directional reading: all valid relative-volume weights are zero.':' | No usable directional observation.'):'')});
}
function drawCoverage(){
  drawSingle('coverageChart',coverageValues,coverageValues,{min:0,max:100,domainMin:0,domainMax:100,minSpan:.1,ref:95,tip:v=>fmt(v,1)+'%',color:'#2ca36c',tooltip:i=>D.dates[i]+' | Coverage '+(finite(coverageValues[i])?fmt(coverageValues[i],2)+'%':'N/A')+' | Valid '+(D.eligible?.[i]??'—')+' / target '+(D.target?.[i]??'—')+(finite(coverageValues[i])&&coverageValues[i]<95?' | Incomplete observations; not a market decline.':'')});
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
  const vb=observedSmoothing(D.volume_balance,volSmoothN,volSmoothType);
  set('kVolBal',fmt(last(vb)));set('kVolSub',balanceSmoothingLabel());
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
bindBoxZoomControls();
document.querySelectorAll('.volume-mode').forEach(b=>b.onclick=()=>{volMode=b.dataset.volume;localStorage.setItem('ihsg-volume-mode',volMode);document.querySelectorAll('.volume-mode').forEach(x=>x.classList.toggle('active',x===b));drawVolume()});
document.getElementById('spikeThreshold')?.addEventListener('change',ev=>{
  const selected=Number(ev.target.value);
  if(!hasHighVolume||!spikeThresholds.includes(selected)){syncSpikeSettings();return}
  spikeThreshold=selected;localStorage.setItem('ihsg-spike-threshold',selected);drawVolume();
});
document.getElementById('spikePeriod')?.addEventListener('change',ev=>{
  const selected=Number(ev.target.value);
  if(!hasHighVolume||!spikePeriods.includes(selected)){syncSpikeSettings();return}
  spikePeriod=selected;localStorage.setItem('ihsg-spike-period',selected);drawVolume();
});
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
