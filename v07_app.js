const D = window.V07_DASHBOARD_DATA;
if(!D){document.body.innerHTML=`<main style="max-width:760px;margin:60px auto;padding:24px;font-family:Arial,sans-serif"><h1>Dashboard data unavailable</h1><p>Run the Update Market Heat Data workflow to generate docs/v07_data.js.</p></main>`;throw new Error("V07_DASHBOARD_DATA is missing");}
const ZONES=[{lo:0,hi:30,c:'#6e9b5e'},{lo:30,hi:60,c:'#c2a23c'},{lo:60,hi:75,c:'#d18c20'},{lo:75,hi:85,c:'#c45f31'},{lo:85,hi:100,c:'#a53822'}];
const PILLAR_LABELS={valuation:'Valuation',momentum:'Momentum',sentiment:'Sentiment',credit_liq:'Credit / Liquidity',macro_gap:'Macro Gap'};
let heatYears=0, expYears=10, showRaw=true, showMA=true, explorerMode='indicator';

function zoneColor(v){for(const z of ZONES){if(v<z.hi)return z.c}return ZONES[4].c}
function regime(v){return v<30?'Cold':v<60?'Normal':v<75?'Warm':v<85?'Overheated':'Extreme'}
function fmtDate(s){if(!s)return '—';const d=new Date(s+'T00:00:00Z');return d.toLocaleDateString('en-GB',{month:'short',year:'numeric',timeZone:'UTC'})}
function fmtNum(v,d=1){return v==null?'—':Number(v).toFixed(d)}
function filterYears(arr,years){if(!years||!arr.length)return arr;const max=new Date(arr[arr.length-1].date+'T00:00:00Z');const cut=new Date(Date.UTC(max.getUTCFullYear()-years,max.getUTCMonth(),max.getUTCDate()));return arr.filter(x=>new Date(x.date+'T00:00:00Z')>=cut)}
function esc(s){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}

function buildKpis(){
 const t=D.tactical, net=t.net*100;
 const items=[
  ['Current provisional',fmtNum(D.current,1),D.current_regime,'watch','Provisional'],
  ['Last completed',fmtNum(D.last_completed,1),fmtDate(D.last_completed_date),'ok','Decision anchor'],
  ['12M moving average',fmtNum(D.ma12,1),'Visual smoothing only','info','Display layer'],
  ['Tactical asymmetry',(net>=0?'+':'')+fmtNum(net,1)+' pts',`Rally ${fmtNum(t.p_rally*100,1)}/100 · Decline ${fmtNum(t.p_decline*100,1)}/100`,net<-5?'stale':net>5?'ok':'info','Uncalibrated scores'],
  ['Validation',`${D.validation.passed} pass`,`${D.validation.warnings} warning · ${D.validation.failures} fail`,D.validation.failures?'stale':D.validation.warnings?'watch':'ok',D.validation.failures?'Needs attention':D.validation.warnings?'Warnings disclosed':'Validated']
 ];
 document.getElementById('kpis').innerHTML=items.map(x=>`<div class="kpi"><div class="kpi-label">${x[0]}</div><div class="kpi-value">${x[1]}</div><div class="kpi-meta">${x[2]}</div><span class="pill ${x[3]}">${x[4]}</span></div>`).join('');
}
function drawGauge(){
 const score=D.current, svg=document.getElementById('gauge'),cx=130,cy=146,r=105;
 const polar=a=>{const q=a*Math.PI/180;return [cx+r*Math.cos(q),cy-r*Math.sin(q)]};
 const ang=v=>180*(1-v/100);
 const arc=(a0,a1)=>{const s=polar(a0),e=polar(a1);return `M ${s[0]} ${s[1]} A ${r} ${r} 0 0 1 ${e[0]} ${e[1]}`};
 let out='';ZONES.forEach(z=>out+=`<path d="${arc(ang(z.lo),ang(z.hi))}" fill="none" stroke="${z.c}" stroke-width="18" stroke-linecap="butt"/>`);
 const a=ang(score)*Math.PI/180,nx=cx+83*Math.cos(a),ny=cy-83*Math.sin(a);
 out+=`<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" stroke="#3b2d20" stroke-width="4"/><circle cx="${cx}" cy="${cy}" r="7" fill="#3b2d20"/>`;
 svg.innerHTML=out;document.getElementById('gaugeNumber').textContent=fmtNum(score,1);const p=document.getElementById('regimePill');p.textContent=D.current_regime;p.style.background=zoneColor(score);p.style.color='#fff';document.getElementById('gaugeSub').textContent=`As of ${fmtDate(D.as_of)} · ${D.current_is_provisional?'provisional':'completed'}`;
}
function buildPillars(){
 const list=document.getElementById('pillarList');
 list.innerHTML=D.pillars.map(p=>`<button class="pillar-row" data-key="${p.key}" style="border:0;background:transparent;padding:0;text-align:left;cursor:pointer;width:100%" title="Open ${esc(p.label)} history"><div class="pillar-name">${esc(p.label)}</div><div class="bar-track"><div class="bar-fill" style="width:${p.value}%;background:${zoneColor(p.value)}"></div></div><div class="bar-value">${p.value.toFixed(1)}</div><div class="delta ${p.delta>=0?'pos':'neg'}">${p.delta>=0?'+':''}${p.delta.toFixed(1)}</div><div class="contrib">${p.contribution.toFixed(1)}</div></button>`).join('');
 list.querySelectorAll('.pillar-row').forEach(b=>b.addEventListener('click',()=>{explorerMode='pillar';document.querySelectorAll('.explorer-mode').forEach(x=>x.classList.toggle('active',x.dataset.mode==='pillar'));populateExplorerSelect(b.dataset.key);document.getElementById('explorerCard').scrollIntoView({behavior:'smooth',block:'start'})}));
}

function svgBase(svg,w,h){svg.setAttribute('viewBox',`0 0 ${w} ${h}`);svg.innerHTML='';}
function linePath(points,x,y,key){let path='',started=false;for(const p of points){const v=p[key];if(v==null){started=false;continue}const cmd=started?'L':'M';path+=`${cmd}${x(new Date(p.date+'T00:00:00Z').getTime()).toFixed(2)},${y(v).toFixed(2)} `;started=true}return path}
function tickDates(data,n=7){if(!data.length)return[];const out=[];for(let i=0;i<n;i++){out.push(data[Math.round(i*(data.length-1)/(n-1))])}return [...new Map(out.map(x=>[x.date,x])).values()]}
function attachTooltip(wrap,svg,data,keys,formatters,tooltip){
 svg.onmousemove=e=>{const rect=svg.getBoundingClientRect(),px=(e.clientX-rect.left)/rect.width*1000;const left=55,right=980;const ratio=Math.max(0,Math.min(1,(px-left)/(right-left)));const idx=Math.round(ratio*(data.length-1));const d=data[idx];if(!d)return;tooltip.innerHTML=`<strong>${fmtDate(d.date)}</strong><br>`+keys.map((k,i)=>d[k]==null?'':`${formatters[i][0]}: ${formatters[i][1](d[k])}`).filter(Boolean).join('<br>');tooltip.style.left=(e.clientX-wrap.getBoundingClientRect().left)+'px';tooltip.style.top=(e.clientY-wrap.getBoundingClientRect().top)+'px';tooltip.style.opacity=1};
 svg.onmouseleave=()=>tooltip.style.opacity=0;
}
function drawPercentChart(svg,wrap,tooltip,data,key,label,years,height=250){
 data=filterYears(data,years);const W=1000,H=height,L=55,R=20,T=18,B=36;svgBase(svg,W,H);
 const dates=data.map(d=>new Date(d.date+'T00:00:00Z').getTime()),xmin=Math.min(...dates),xmax=Math.max(...dates);const x=v=>L+(v-xmin)/(xmax-xmin||1)*(W-L-R),y=v=>T+(100-v)/100*(H-T-B);
 let html='';ZONES.forEach(z=>html+=`<rect x="${L}" y="${y(z.hi)}" width="${W-L-R}" height="${y(z.lo)-y(z.hi)}" fill="${z.c}" opacity=".11"/>`);
 [0,20,40,60,80,100].forEach(v=>html+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#e5dac8"/><text x="${L-10}" y="${y(v)+4}" text-anchor="end" font-size="10" fill="#857766">${v}</text>`);
 tickDates(data).forEach(d=>{const xx=x(new Date(d.date+'T00:00:00Z').getTime());html+=`<text x="${xx}" y="${H-10}" text-anchor="middle" font-size="10" fill="#857766">${new Date(d.date+'T00:00:00Z').getUTCFullYear()}</text>`});
 html+=`<path d="${linePath(data,x,y,key)}" fill="none" stroke="#6a4c2d" stroke-width="2.5" stroke-linejoin="round"/>`;
 svg.innerHTML=html;attachTooltip(wrap,svg,data,[key],[[label,v=>v.toFixed(1)]],tooltip);
}
function drawRawChart(svg,wrap,tooltip,data,key,label,formatter,years,height=250){
 data=filterYears(data,years).filter(d=>d[key]!=null);const W=1000,H=height,L=63,R=20,T=18,B=36;svgBase(svg,W,H);if(!data.length){svg.innerHTML='<text x="50%" y="50%" text-anchor="middle" fill="#857766">No data</text>';return}
 const dates=data.map(d=>new Date(d.date+'T00:00:00Z').getTime()),xmin=Math.min(...dates),xmax=Math.max(...dates);let vals=data.map(d=>d[key]),vmin=Math.min(...vals),vmax=Math.max(...vals);if(vmin===vmax){vmin-=1;vmax+=1}let pad=(vmax-vmin)*.12;vmin-=pad;vmax+=pad;const x=v=>L+(v-xmin)/(xmax-xmin||1)*(W-L-R),y=v=>T+(vmax-v)/(vmax-vmin)*(H-T-B);
 let html='';for(let i=0;i<=5;i++){const v=vmin+(vmax-vmin)*i/5;html+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#e5dac8"/><text x="${L-9}" y="${y(v)+4}" text-anchor="end" font-size="10" fill="#857766">${formatter(v,true)}</text>`}if(vmin<0&&vmax>0)html+=`<line x1="${L}" x2="${W-R}" y1="${y(0)}" y2="${y(0)}" stroke="#b8a58a" stroke-dasharray="4 4"/>`;
 tickDates(data).forEach(d=>{const xx=x(new Date(d.date+'T00:00:00Z').getTime());html+=`<text x="${xx}" y="${H-10}" text-anchor="middle" font-size="10" fill="#857766">${new Date(d.date+'T00:00:00Z').getUTCFullYear()}</text>`});
 const p=linePath(data,x,y,key);html+=`<path d="${p}" fill="none" stroke="#8a622f" stroke-width="2.2" stroke-linejoin="round"/>`;svg.innerHTML=html;attachTooltip(wrap,svg,data,[key],[[label,v=>formatter(v,false)]],tooltip);
}
function drawHeat(){
 const data=filterYears(D.heat,heatYears),svg=document.getElementById('heatChart'),wrap=document.getElementById('heatChartWrap'),tip=document.getElementById('heatTooltip'),W=1000,H=370,L=55,R=20,T=18,B=38;svgBase(svg,W,H);const dates=data.map(d=>new Date(d.date+'T00:00:00Z').getTime()),xmin=Math.min(...dates),xmax=Math.max(...dates);const x=v=>L+(v-xmin)/(xmax-xmin||1)*(W-L-R),y=v=>T+(100-v)/100*(H-T-B);
 let html='';ZONES.forEach(z=>html+=`<rect x="${L}" y="${y(z.hi)}" width="${W-L-R}" height="${y(z.lo)-y(z.hi)}" fill="${z.c}" opacity=".11"/>`);[0,20,40,60,80,100].forEach(v=>html+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#e4d8c6"/><text x="${L-10}" y="${y(v)+4}" text-anchor="end" font-size="10" fill="#857766">${v}</text>`);tickDates(data,9).forEach(d=>{const xx=x(new Date(d.date+'T00:00:00Z').getTime());html+=`<text x="${xx}" y="${H-11}" text-anchor="middle" font-size="10" fill="#857766">${new Date(d.date+'T00:00:00Z').getUTCFullYear()}</text>`});if(showRaw)html+=`<path d="${linePath(data,x,y,'raw')}" fill="none" stroke="#9a8268" stroke-width="1.35" opacity=".72"/>`;if(showMA)html+=`<path d="${linePath(data,x,y,'ma12')}" fill="none" stroke="#5d4124" stroke-width="3.1" stroke-linejoin="round"/>`;svg.innerHTML=html;const keys=[],fmts=[];if(showRaw){keys.push('raw');fmts.push(['Raw',v=>v.toFixed(1)])}if(showMA){keys.push('ma12');fmts.push(['MA12',v=>v.toFixed(1)])}attachTooltip(wrap,svg,data,keys,fmts,tip);
}
function currentOptions(){
 if(explorerMode==='indicator')return Object.entries(D.indicators).map(([k,v])=>({k,label:`${v.pillar} · ${v.label}`}));
 return Object.entries(PILLAR_LABELS).map(([k,v])=>({k,label:v}));
}
function populateExplorerSelect(selected){const s=document.getElementById('explorerSelect'),opts=currentOptions();s.innerHTML=opts.map(o=>`<option value="${o.k}" ${o.k===selected?'selected':''}>${esc(o.label)}</option>`).join('');if(!selected||!opts.some(o=>o.k===selected))s.value=opts[0].k;drawExplorer()}
function rawFormatter(meta){return (v,axis=false)=>{const d=axis?Math.min(meta.decimals,1):meta.decimals;let out=Number(v).toFixed(d);return meta.unit==='%'?out+'%':meta.unit==='pp'?out+' pp':meta.unit==='x'?out+'x':out}}
function drawExplorer(){
 const key=document.getElementById('explorerSelect').value;
 const rawTitle=document.getElementById('rawChartTitle'),pctPanel=document.getElementById('pctPanel'),metricRaw=document.getElementById('metricRaw'),metricPct=document.getElementById('metricPct'),metricSource=document.getElementById('metricSource'),metricWhy=document.getElementById('metricWhy'),metricValid=document.getElementById('metricValid');
 if(explorerMode==='indicator'){
   const m=D.indicators[key],f=rawFormatter(m);rawTitle.textContent=`Raw history · ${m.label}`;pctPanel.style.display='block';metricRaw.textContent=f(m.latest_raw,false);metricPct.textContent=m.latest_pct==null?'—':m.latest_pct.toFixed(1)+'th pct';metricSource.textContent=`Source: ${m.source} · latest actual observation ${m.source_date}`;metricWhy.textContent=m.why;metricValid.textContent=`Percentile valid from ${fmtDate(m.valid_from)}`;
   drawRawChart(document.getElementById('rawChart'),document.getElementById('rawChartWrap'),document.getElementById('rawTooltip'),m.data,'raw',m.label,f,expYears);drawPercentChart(document.getElementById('pctChart'),document.getElementById('pctChartWrap'),document.getElementById('pctTooltip'),m.data,'pct','Heat percentile',expYears);
 } else {
   const rows=D.heat.map(x=>({date:x.date,value:x[key]})).filter(x=>x.value!=null),latest=rows[rows.length-1];rawTitle.textContent=`Pillar history · ${PILLAR_LABELS[key]}`;pctPanel.style.display='none';metricRaw.textContent=latest.value.toFixed(1);metricPct.textContent=regime(latest.value);metricSource.textContent='Weighted mean of the underlying indicator heat percentiles';metricWhy.textContent='Use this view to see whether a pillar is persistently hot or only briefly elevated.';metricValid.textContent=`Full 5-pillar comparability from ${fmtDate(D.comparable_from)}`;
   drawPercentChart(document.getElementById('rawChart'),document.getElementById('rawChartWrap'),document.getElementById('rawTooltip'),rows,'value',PILLAR_LABELS[key],expYears);
 }
 document.getElementById('explorerCompareNote').textContent=expYears?`Showing last ${expYears} years`:'Showing all available history';
}
function buildFreshness(){
 const labels={current:'Current',expected_publication_lag:'Expected publication lag',operationally_late:'Operationally late',license_delayed:'License-delayed',stale:'Stale',missing:'Missing'};
 const classes={current:'ok',expected_publication_lag:'info',operationally_late:'watch',license_delayed:'info',stale:'stale',missing:'stale'};
 const counts=D.freshness_classification_counts||{};
 const order=['current','expected_publication_lag','operationally_late','license_delayed','stale','missing'];
 document.getElementById('freshnessSummary').innerHTML=order.filter(k=>Number(counts[k]||0)>0).map(k=>`<span class="freshness-chip ${classes[k]}"><strong>${counts[k]}</strong> ${labels[k]}</span>`).join('');
 document.getElementById('freshnessBody').innerHTML=D.freshness.map(r=>`<tr><td><strong>${esc(r.source)}</strong><div class="table-sub">${esc(r.provider||'')}</div></td><td>${esc(r.used_for)}</td><td class="date-cell">${esc(r.latest)}</td><td><div class="update-path">${esc(r.delivery||'Source policy')}</div></td><td><span class="pill ${r.class}">${esc(r.status)}</span><div class="lag-detail">${esc(r.detail||'')}</div></td></tr>`).join('');
 const action=D.freshness.filter(r=>r.action_required).length;
 const disclosed=Number(counts.expected_publication_lag||0)+Number(counts.license_delayed||0);
 const badge=document.getElementById('freshnessBadge');
 if(action){badge.textContent=`${action} operational gap${action===1?'':'s'}`;badge.className='pill watch'}
 else if(disclosed){badge.textContent=`No operational gaps · ${disclosed} disclosed constraint${disclosed===1?'':'s'}`;badge.className='pill info'}
 else{badge.textContent='All sources current';badge.className='pill ok'}
}

function buildTactical(){
 const t=D.tactical,net=t.net*100;
 document.getElementById('rallyProb').textContent=(t.p_rally*100).toFixed(1)+' / 100';
 document.getElementById('declineProb').textContent=(t.p_decline*100).toFixed(1)+' / 100';
 document.getElementById('tacticalNet').textContent=(net>=0?'+':'')+net.toFixed(1)+' pts';
 document.getElementById('tacticalNet').style.color=net<0?'var(--bad)':'var(--good)';
 document.getElementById('tacticalAuc').textContent=`Ranking AUC · rally ${Number(t.auc_rally).toFixed(3)} · decline ${Number(t.auc_decline).toFixed(3)} · as of ${t.as_of}. AUC does not test calibration.`;
 const names={sp_3m_mom:'S&P 500 3M momentum',credit:'Credit spread',credit_3m_chg:'Credit spread 3M change',dgs2_3m_chg:'2Y yield 3M change',nfci:'Financial conditions',breakeven:'10Y breakeven',curve_10y2y:'Yield curve',vix:'VIX'};const entries=Object.entries(t.contributions||{}).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])),mx=Math.max(1e-9,...entries.map(x=>Math.abs(x[1])));document.getElementById('tacticalBars').innerHTML=entries.map(([k,v])=>{const w=Math.abs(v)/mx*48,l=v>=0?50:50-w;return `<div class="tactical-row"><div>${esc(names[k]||k.replaceAll('_',' '))}</div><div class="tactical-track"><div class="tactical-bar" style="left:${l}%;width:${w}%;background:${v>=0?'var(--good)':'var(--bad)'}"></div></div><div class="tactical-value">${v>=0?'+':''}${Number(v).toFixed(3)}</div></div>`}).join('');
}

buildKpis();drawGauge();buildPillars();buildFreshness();buildTactical();drawHeat();populateExplorerSelect();document.getElementById('commit').textContent=String(D.repo_commit||'unknown').slice(0,10);document.getElementById('generatedAt').textContent=new Date(D.generated_at_utc).toLocaleString('en-GB',{timeZone:'UTC',dateStyle:'medium',timeStyle:'short'})+' UTC';
document.getElementById('comparableStart').textContent=`From ${fmtDate(D.comparable_from)}`;
document.getElementById('toggleMA').onclick=e=>{showMA=!showMA;e.currentTarget.classList.toggle('active',showMA);e.currentTarget.textContent=`12M MA ${showMA?'On':'Off'}`;drawHeat()};
document.getElementById('toggleRaw').onclick=e=>{showRaw=!showRaw;e.currentTarget.classList.toggle('active',showRaw);e.currentTarget.textContent=`Raw ${showRaw?'On':'Off'}`;drawHeat()};
document.querySelectorAll('.heat-range').forEach(b=>b.onclick=()=>{heatYears=Number(b.dataset.years);document.querySelectorAll('.heat-range').forEach(x=>x.classList.toggle('active',x===b));drawHeat()});
document.querySelectorAll('.exp-range').forEach(b=>b.onclick=()=>{expYears=Number(b.dataset.years);document.querySelectorAll('.exp-range').forEach(x=>x.classList.toggle('active',x===b));drawExplorer()});
document.querySelectorAll('.explorer-mode').forEach(b=>b.onclick=()=>{explorerMode=b.dataset.mode;document.querySelectorAll('.explorer-mode').forEach(x=>x.classList.toggle('active',x===b));populateExplorerSelect()});
document.getElementById('explorerSelect').onchange=drawExplorer;
window.addEventListener('resize',()=>{drawHeat();drawExplorer()});
