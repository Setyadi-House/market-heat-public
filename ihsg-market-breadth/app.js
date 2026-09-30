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
function V(a){return a.slice(startIndex())}
function VD(){return D.dates.slice(startIndex())}
function S(tag,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e}

function ticksFor(dates){
  const n=dates.length>1200?8:dates.length>700?7:dates.length>350?6:dates.length>150?5:3;
  return Array.from({length:n},(_,k)=>Math.round((dates.length-1)*k/Math.max(1,n-1)));
}
function linePath(values,x,y){
  let d='',on=false;
  values.forEach((v,i)=>{if(finite(v)){d+=(on?'L':'M')+x(i)+' '+y(v)+' ';on=true}else on=false});
  return d;
}

function drawCombined(){
  const el=document.getElementById('combinedChart'),tip=document.getElementById('combinedTip');
  const dates=VD(),raw=V(D[metric]),smoothAll=smoothing(D[metric],smoothN,smoothType),smooth=V(smoothAll);
  const bench=V(benchMode==='abs'?D.ihsg:D.ihsg_1y);
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
  ticksFor(dates).forEach((i,k,a)=>{const t=S('text',{x:x(i),y:H-7,'text-anchor':k===0?'start':k===a.length-1?'end':'middle',class:'axis'});t.textContent=dates[i].slice(0,7);el.appendChild(t)});
  el.appendChild(S('path',{d:linePath(raw,x,yL),class:'line raw',stroke:'#8da5ff'}));
  el.appendChild(S('path',{d:linePath(smooth,x,yL),class:'line',stroke:'#4b6bfb'}));
  el.appendChild(S('path',{d:linePath(bench,x,yR),class:'line benchmark',stroke:'#c06b18'}));
  const ov=S('rect',{x:p.l,y:p.t,width:W-p.l-p.r,height:H-p.t-p.b,fill:'transparent'});el.appendChild(ov);
  ov.addEventListener('mousemove',ev=>{
    const r=el.getBoundingClientRect(),px=(ev.clientX-r.left)/r.width*W,i=Math.max(0,Math.min(dates.length-1,Math.round((px-p.l)/(W-p.l-p.r)*(dates.length-1))));
    tip.style.display='block';tip.style.left=Math.min(r.width-260,ev.clientX-r.left+12)+'px';tip.style.top=(ev.clientY-r.top+8)+'px';
    tip.textContent=dates[i]+' | raw '+(finite(raw[i])?fmt(raw[i])+'%':'—')+' | '+smoothType+smoothN+' '+(finite(smooth[i])?fmt(smooth[i])+'%':'—')+' | IHSG '+(finite(bench[i])?(benchMode==='abs'?fmt(bench[i],0):fmt(bench[i])+'%'):'—');
  });
  ov.addEventListener('mouseleave',()=>tip.style.display='none');
}

function drawSingle(id,rawAll,smoothAll,opt){
  const el=document.getElementById(id),tip=document.getElementById(id.replace('Chart','Tip')),dates=VD(),raw=V(rawAll),smooth=V(smoothAll);
  const W=1100,H=300,p={l:52,r:18,t:16,b:30};el.replaceChildren();
  let lo=opt.min,hi=opt.max;
  if(lo==null||hi==null){const vals=[...raw,...smooth].filter(finite);lo=lo??Math.min(...vals);hi=hi??Math.max(...vals)}
  if(!finite(lo)||!finite(hi)){lo=0;hi=1}if(lo===hi){lo-=1;hi+=1}
  const x=i=>p.l+(W-p.l-p.r)*(i/Math.max(1,dates.length-1)),y=v=>p.t+(H-p.t-p.b)*(1-(v-lo)/(hi-lo));
  for(let q=0;q<=4;q++){const v=lo+(hi-lo)*q/4,yy=y(v);el.appendChild(S('line',{x1:p.l,x2:W-p.r,y1:yy,y2:yy,class:'gridline'}));const t=S('text',{x:p.l-8,y:yy+3,'text-anchor':'end',class:'axis'});t.textContent=opt.axis?opt.axis(v):fmt(v);el.appendChild(t)}
  if(finite(opt.ref)&&opt.ref>=lo&&opt.ref<=hi){el.appendChild(S('line',{x1:p.l,x2:W-p.r,y1:y(opt.ref),y2:y(opt.ref),class:'reference-line'}))}
  ticksFor(dates).forEach((i,k,a)=>{const t=S('text',{x:x(i),y:H-7,'text-anchor':k===0?'start':k===a.length-1?'end':'middle',class:'axis'});t.textContent=dates[i].slice(0,7);el.appendChild(t)});
  el.appendChild(S('path',{d:linePath(raw,x,y),class:'line raw',stroke:opt.color||'#8da5ff'}));
  el.appendChild(S('path',{d:linePath(smooth,x,y),class:'line',stroke:opt.color||'#4b6bfb'}));
  const ov=S('rect',{x:p.l,y:p.t,width:W-p.l-p.r,height:H-p.t-p.b,fill:'transparent'});el.appendChild(ov);
  ov.addEventListener('mousemove',ev=>{const r=el.getBoundingClientRect(),px=(ev.clientX-r.left)/r.width*W,i=Math.max(0,Math.min(dates.length-1,Math.round((px-p.l)/(W-p.l-p.r)*(dates.length-1))));tip.style.display='block';tip.style.left=Math.min(r.width-220,ev.clientX-r.left+12)+'px';tip.style.top=(ev.clientY-r.top+8)+'px';tip.textContent=dates[i]+' | raw '+(finite(raw[i])?opt.tip(raw[i]):'—')+' | smoothed '+(finite(smooth[i])?opt.tip(smooth[i]):'—')});ov.addEventListener('mouseleave',()=>tip.style.display='none');
}

function volumeFields(){
  if(volMode==='balance')return {raw:D.volume_balance,help:'Directional balance: +100 means abnormal volume is entirely on rising stocks, -100 entirely on falling stocks, 0 is balanced.',min:-100,max:100,ref:0,tip:v=>fmt(v,1),color:'#d9534f'};
  if(volMode==='spike')return {raw:D.volume_spike,help:'High-volume breadth: percentage of valid stocks with RVOL ≥ 1.5× their own prior-20-observed-session average.',min:0,max:100,ref:25,tip:v=>fmt(v,1)+'%',color:'#8b5cf6'};
  return {raw:D.volume_index,help:'Activity index: 100 = normal aggregate relative volume. Above 100 = above-normal activity; below 100 = below-normal.',min:0,max:null,ref:100,tip:v=>fmt(v,1),color:'#4b6bfb'};
}
function drawVolume(){
  const f=volumeFields(),sm=smoothing(f.raw,volSmoothN,volSmoothType),vals=V(f.raw).filter(finite);
  let max=f.max;if(max==null)max=Math.max(160,(vals.length?Math.max(...vals):160)*1.05);
  document.getElementById('volumeHelp').textContent=f.help;
  document.getElementById('volumeNote').textContent='Smoothing: '+volSmoothType+volSmoothN+'. Gaps mean source observations were unavailable; they are not filled with zero or interpolated.';
  drawSingle('volumeChart',f.raw,sm,{min:f.min,max,ref:f.ref,tip:f.tip,color:f.color});
}
function drawCoverage(){
  const cleaned=D.coverage.map((v,i)=>(D.target?.[i]>0&&D.eligible?.[i]===0)?null:v);
  drawSingle('coverageChart',cleaned,cleaned,{min:0,max:100,ref:95,tip:v=>fmt(v,1)+'%',color:'#2ca36c'});
}

function updateKpis(){
  const mb=smoothing(D.macd,smoothN,smoothType),ma=smoothing(D.ma,smoothN,smoothType),st=smoothing(D.st,smoothN,smoothType),cp=smoothing(D.composite,smoothN,smoothType);
  set('kMacd',fmt(last(mb))+'%');set('kMacdSub',reg(last(mb)));
  set('kMa',fmt(last(ma))+'%');set('kMaSub',reg(last(ma)));
  set('kSt',fmt(last(st))+'%');set('kStSub',reg(last(st)));
  set('kComp',fmt(last(cp))+'%');set('kCompSub',reg(last(cp)));
  set('kValid',String(last(D.eligible)??'—'));set('kCoverage',fmt(last(D.coverage))+'% coverage');
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
document.querySelectorAll('.range').forEach(b=>b.onclick=()=>{range=b.dataset.range;localStorage.setItem('ihsg-range',range);document.querySelectorAll('.range').forEach(x=>x.classList.toggle('active',x===b));drawAll()});
document.querySelectorAll('.volume-mode').forEach(b=>b.onclick=()=>{volMode=b.dataset.volume;localStorage.setItem('ihsg-volume-mode',volMode);document.querySelectorAll('.volume-mode').forEach(x=>x.classList.toggle('active',x===b));drawVolume()});
document.getElementById('absBtn').onclick=()=>{benchMode='abs';document.getElementById('absBtn').classList.add('active');document.getElementById('retBtn').classList.remove('active');drawCombined()};
document.getElementById('retBtn').onclick=()=>{benchMode='ret';document.getElementById('retBtn').classList.add('active');document.getElementById('absBtn').classList.remove('active');drawCombined()};
document.getElementById('applySmooth').onclick=()=>{const n=Number(document.getElementById('smoothN').value),t=document.getElementById('smoothType').value;if(!Number.isInteger(n)||n<1||n>1260)return alert('Enter a smoothing length from 1 to 1260.');smoothN=n;smoothType=t;localStorage.setItem('ihsg-smooth-n',n);localStorage.setItem('ihsg-smooth-type',t);drawCombined();updateKpis()};
document.getElementById('applyVolSmooth').onclick=()=>{const n=Number(document.getElementById('volSmoothN').value),t=document.getElementById('volSmoothType').value;if(!Number.isInteger(n)||n<1||n>1260)return alert('Enter a smoothing length from 1 to 1260.');volSmoothN=n;volSmoothType=t;localStorage.setItem('ihsg-vol-smooth-n',n);localStorage.setItem('ihsg-vol-smooth-type',t);drawVolume();updateKpis()};

const age=Math.floor((Date.now()-new Date(D.meta.market_as_of+'T00:00:00Z'))/86400000);
if(age>4){const b=document.getElementById('staleBanner');b.className='banner show';b.textContent='Data may be stale: last market observation is '+D.meta.market_as_of+'.';}
updateFacts();drawAll();
})();