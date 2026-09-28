(()=>{'use strict';
const D=window.IHSG_PUBLIC_DATA;
if(!D){const b=document.getElementById('staleBanner');b.textContent='Latest aggregate data are not available yet.';b.className='banner show';return;}
const last=a=>a&&a.length?a[a.length-1]:null;
const fmt=(v,d=1)=>Number.isFinite(v)?Number(v).toFixed(d):'—';
const reg=v=>!Number.isFinite(v)?'Unavailable':v<30?'Low participation':v>70?'Broad participation':'Mixed participation';
const set=(id,t)=>{const e=document.getElementById(id);if(e)e.textContent=t};
set('kMacd',fmt(last(D.macd_smooth))+'%');set('kMacdSub',reg(last(D.macd_smooth)));
set('kMa',fmt(last(D.ma_smooth))+'%');set('kMaSub',reg(last(D.ma_smooth)));
set('kSt',fmt(last(D.st_smooth))+'%');set('kStSub',reg(last(D.st_smooth)));
set('kComp',fmt(last(D.composite_smooth))+'%');set('kCompSub',reg(last(D.composite_smooth)));
set('kValid',String(last(D.eligible)??'—'));set('kCoverage',fmt(last(D.coverage))+'% coverage');
set('kVolBal',fmt(last(D.volume_balance_smooth)));
set('fDate',D.meta.market_as_of);
set('fHistory',(D.meta.history_start||D.dates[0])+' → '+D.meta.market_as_of+' ('+D.dates.length.toLocaleString()+' sessions)');
set('fRoster',D.meta.universe_symbols+' stocks');set('fPrice',fmt(D.meta.price_coverage_pct,2)+'%');set('fCap',fmt(D.meta.cap_coverage_pct,2)+'%');
set('fSources',D.meta.sources.join(' · '));set('fMethod',D.meta.methodology);
set('footerText','Aggregate-only public display · market date '+D.meta.market_as_of+' · '+D.dates.length.toLocaleString()+' breadth sessions');
const age=Math.floor((Date.now()-new Date(D.meta.market_as_of+'T00:00:00Z'))/86400000);
if(age>4){const b=document.getElementById('staleBanner');b.className='banner show';b.textContent='Data may be stale: last market observation is '+D.meta.market_as_of+'.';}
const themeBtn=document.getElementById('themeBtn');
if(localStorage.getItem('ihsg-theme')==='dark')document.body.classList.add('dark');
function themeText(){themeBtn.textContent=document.body.classList.contains('dark')?'Light mode':'Dark mode'}themeText();
themeBtn.addEventListener('click',()=>{document.body.classList.toggle('dark');localStorage.setItem('ihsg-theme',document.body.classList.contains('dark')?'dark':'light');themeText();drawAll();});

function S(tag,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e}
function cutoff(range){
  if(range==='ALL')return D.dates[0];
  const d=new Date(D.dates[D.dates.length-1]+'T12:00:00Z');
  if(range==='6M')d.setUTCMonth(d.getUTCMonth()-6);
  else if(range==='1Y')d.setUTCFullYear(d.getUTCFullYear()-1);
  else if(range==='3Y')d.setUTCFullYear(d.getUTCFullYear()-3);
  else if(range==='5Y')d.setUTCFullYear(d.getUTCFullYear()-5);
  return d.toISOString().slice(0,10);
}
function startIndex(){
  const key=cutoff(range);
  let lo=0,hi=D.dates.length;
  while(lo<hi){const m=(lo+hi)>>1;if(D.dates[m]<key)lo=m+1;else hi=m}
  return Math.min(lo,D.dates.length-1);
}
function view(values){return values.slice(startIndex())}
function viewDates(){return D.dates.slice(startIndex())}

function draw(id,dates,series,opt){
 const el=document.getElementById(id),W=1100,H=opt.h||300,p={l:52,r:16,t:14,b:28};el.replaceChildren();
 const all=[];series.forEach(s=>s.values.forEach(v=>{if(Number.isFinite(v))all.push(v)}));
 let lo=opt.min!=null?opt.min:Math.min(...all),hi=opt.max!=null?opt.max:Math.max(...all);
 if(!Number.isFinite(lo)||!Number.isFinite(hi)){lo=0;hi=1}if(lo===hi){lo-=1;hi+=1}const sp=hi-lo;
 const x=i=>p.l+(W-p.l-p.r)*(i/Math.max(1,dates.length-1)),y=v=>p.t+(H-p.t-p.b)*(1-(v-lo)/sp);
 (opt.bands||[]).forEach(b=>el.appendChild(S('rect',{x:p.l,y:y(b.hi),width:W-p.l-p.r,height:Math.max(0,y(b.lo)-y(b.hi)),fill:b.fill,opacity:.10})));
 for(let q=0;q<=4;q++){const v=lo+sp*q/4,yy=y(v);el.appendChild(S('line',{x1:p.l,x2:W-p.r,y1:yy,y2:yy,class:'gridline'}));const t=S('text',{x:p.l-8,y:yy+3,'text-anchor':'end',class:'axis'});t.textContent=opt.axis?opt.axis(v):fmt(v);el.appendChild(t)}
 const tickCount=dates.length>900?7:dates.length>400?6:dates.length>120?5:3;
 for(let k=0;k<tickCount;k++){const i=Math.round((dates.length-1)*k/Math.max(1,tickCount-1));const t=S('text',{x:x(i),y:H-6,'text-anchor':k===0?'start':k===tickCount-1?'end':'middle',class:'axis'});t.textContent=dates[i].slice(0,7);el.appendChild(t)}
 series.forEach((srs,j)=>{let d='',on=false;srs.values.forEach((v,i)=>{if(Number.isFinite(v)){d+=(on?'L':'M')+x(i)+' '+y(v)+' ';on=true}else on=false});el.appendChild(S('path',{d,class:'line '+(srs.raw?'raw':''),stroke:srs.color||['#4b6bfb','#d9534f','#2ca36c'][j%3]}));});
 const ov=S('rect',{x:p.l,y:p.t,width:W-p.l-p.r,height:H-p.t-p.b,fill:'transparent'});el.appendChild(ov);
 const tip=document.getElementById(id.replace('Chart','Tip'));
 ov.addEventListener('mousemove',ev=>{const r=el.getBoundingClientRect(),px=(ev.clientX-r.left)/r.width*W,i=Math.max(0,Math.min(dates.length-1,Math.round((px-p.l)/(W-p.l-p.r)*(dates.length-1))));tip.style.display='block';tip.style.left=Math.min(r.width-220,ev.clientX-r.left+12)+'px';tip.style.top=(ev.clientY-r.top+8)+'px';const lines=[dates[i]];series.forEach(s=>lines.push(s.name+': '+(Number.isFinite(s.values[i])?(opt.tip?opt.tip(s.values[i]):fmt(s.values[i])):'—')));tip.textContent=lines.join(' | ');});
 ov.addEventListener('mouseleave',()=>tip.style.display='none');
}
let metric='macd',bench='abs',range=localStorage.getItem('ihsg-range')||'1Y';
if(!['6M','1Y','3Y','5Y','ALL'].includes(range))range='1Y';

function breadth(){const dates=viewDates();draw('breadthChart',dates,[{name:'Smoothed',values:view(D[metric+'_smooth']),color:'#4b6bfb'},{name:'Raw',values:view(D[metric]),color:'#4b6bfb',raw:true}],{h:360,min:0,max:100,bands:[{lo:0,hi:30,fill:'#d9534f'},{lo:30,hi:70,fill:'#d9a620'},{lo:70,hi:100,fill:'#2ca36c'}],axis:v=>fmt(v,0),tip:v=>fmt(v)+'%'});}
function ihsg(){const dates=viewDates(),vals=bench==='abs'?view(D.ihsg):view(D.ihsg_1y);draw('ihsgChart',dates,[{name:bench==='abs'?'IHSG':'1Y return',values:vals,color:'#4b6bfb'}],{tip:v=>bench==='abs'?fmt(v,0):fmt(v)+'%'});}
function volume(){const dates=viewDates();draw('volumeChart',dates,[{name:'Activity index',values:view(D.volume_index_smooth),color:'#4b6bfb'},{name:'Directional balance',values:view(D.volume_balance_smooth),color:'#d9534f'}],{min:-100,max:160});}
function coverage(){const dates=viewDates();draw('coverageChart',dates,[{name:'Coverage',values:view(D.coverage),color:'#2ca36c'}],{h:260,min:0,max:100,axis:v=>fmt(v,0),tip:v=>fmt(v)+'%'});}
function drawAll(){breadth();ihsg();volume();coverage();}
function syncRangeButtons(){document.querySelectorAll('.range').forEach(b=>b.classList.toggle('active',b.dataset.range===range));}
syncRangeButtons();
document.querySelectorAll('.metric').forEach(b=>b.addEventListener('click',()=>{metric=b.dataset.metric;document.querySelectorAll('.metric').forEach(x=>x.classList.toggle('active',x===b));breadth();}));
document.querySelectorAll('.range').forEach(b=>b.addEventListener('click',()=>{range=b.dataset.range;localStorage.setItem('ihsg-range',range);syncRangeButtons();drawAll();}));
document.getElementById('absBtn').addEventListener('click',()=>{bench='abs';document.getElementById('absBtn').classList.add('active');document.getElementById('retBtn').classList.remove('active');ihsg();});
document.getElementById('retBtn').addEventListener('click',()=>{bench='ret';document.getElementById('retBtn').classList.add('active');document.getElementById('absBtn').classList.remove('active');ihsg();});
drawAll();
})();