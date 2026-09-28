"""Generate aggregate-only IHSG breadth data for the public Pages dashboard.

No stock-level observations are written. API keys stay in GitHub Actions secrets.
"""
import concurrent.futures, json, math, os, re, time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from pathlib import Path

OUT=Path(__file__).with_name("data.js")
TZ=timezone(timedelta(hours=7))
LOOKBACK_DAYS=1200
DISPLAY_POINTS=504

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None

class API:
    def __init__(self,provider):
        self.provider=provider
        self.key=os.environ.get(provider+"_API_KEY","")
        self.base="https://eodhd.com" if provider=="EODHD" else "https://financialmodelingprep.com"
        self.opener=build_opener(ProxyHandler({}),NoRedirect())
    def get(self,path,**params):
        if not self.key: raise RuntimeError("MISSING_SECRETS")
        params["api_token" if self.provider=="EODHD" else "apikey"]=self.key
        if self.provider=="EODHD": params["fmt"]="json"
        url=self.base+path+"?"+urlencode(params)
        try:
            with self.opener.open(Request(url,headers={"Accept":"application/json"}),timeout=25) as r:
                body=r.read(8_000_001)
                if len(body)>8_000_000: raise RuntimeError("RESPONSE_TOO_LARGE")
                obj=json.loads(body)
                if isinstance(obj,dict) and any(k.lower() in ("error","error message","message") for k in obj):
                    raise RuntimeError("PROVIDER_ERROR")
                return obj
        except HTTPError as e:
            raise RuntimeError("HTTP_"+str(e.code)) from None

def num(v):
    return float(v) if type(v) in (int,float) and math.isfinite(v) else None

def ema(values,span):
    a=2/(span+1);out=[];p=None
    for v in values:
        if v is None: out.append(None);p=None
        else:
            p=v if p is None else a*v+(1-a)*p
            out.append(p)
    return out

def sma(values,n):
    out=[None]*len(values);q=[];s=0.0
    for i,v in enumerate(values):
        q.append(v)
        if v is not None:s+=v
        if len(q)>n:
            old=q.pop(0)
            if old is not None:s-=old
        if len(q)==n and all(x is not None for x in q):out[i]=s/n
    return out

def supertrend(high,low,close,period=10,mult=3.0):
    n=len(close);out=[None]*n
    if n<period:return out
    tr=[]
    for i in range(n):
        prev=close[i-1] if i else close[0]
        tr.append(max(high[i]-low[i],abs(high[i]-prev),abs(low[i]-prev)))
    atr=[None]*n
    atr[period-1]=sum(tr[:period])/period
    for i in range(period,n):atr[i]=((period-1)*atr[i-1]+tr[i])/period
    fu=[None]*n;fl=[None]*n;bull=False
    for i in range(period-1,n):
        mid=(high[i]+low[i])/2
        u=mid+mult*atr[i];l=mid-mult*atr[i]
        if i>period-1:
            if not (u<fu[i-1] or close[i-1]>fu[i-1]):u=fu[i-1]
            if not (l>fl[i-1] or close[i-1]<fl[i-1]):l=fl[i-1]
            bull=close[i]>=l if bull else close[i]>u
        fu[i]=u;fl[i]=l;out[i]=1 if bull else 0
    return out

def adjust_bars(prices,splits):
    events=[]
    for r in splits if isinstance(splits,list) else []:
        try:
            n,d=map(float,str(r.get("split","")).split("/"));ratio=n/d
            if ratio>0 and math.isfinite(ratio):events.append((str(r["date"]),ratio))
        except Exception: pass
    events.sort()
    rows=[]
    for r in prices if isinstance(prices,list) else []:
        d=str(r.get("date",""))
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}",d):continue
        o,h,l,c,v=[num(r.get(k)) for k in ("open","high","low","close","volume")]
        if None in (o,h,l,c) or min(o,h,l,c)<=0:continue
        factor=1.0
        for sd,ratio in events:
            if d<sd:factor*=ratio
        if not math.isfinite(factor) or factor<=0:continue
        rows.append((d,o/factor,h/factor,l/factor,c/factor,v))
    rows.sort()
    return rows

def stock_states(rows):
    if not rows:return {},None
    dates=[r[0] for r in rows];high=[r[2] for r in rows];low=[r[3] for r in rows];close=[r[4] for r in rows];vol=[r[5] for r in rows]
    fast=ema(close,40);slow=ema(close,70)
    mac=[fast[i]-slow[i] for i in range(len(close))]
    sig=ema(mac,9);ma=sma(close,100);st=supertrend(high,low,close)
    vmean=sma(vol,20)
    out={}
    for i,d in enumerate(dates):
        if i<349:continue
        m=1 if mac[i]>sig[i] else 0
        a=1 if ma[i] is not None and close[i]>ma[i] else 0
        s=st[i]
        rv=None;bal=None;spike=None
        if i>=20 and vmean[i-1] not in (None,0) and vol[i] is not None:
            rv=vol[i]/vmean[i-1]
            bal=(1 if close[i]>close[i-1] else -1 if close[i]<close[i-1] else 0)*min(rv,5)
            spike=1 if rv>=1.5 else 0
        out[d]=(m,a,s,rv,bal,spike)
    return out,dates[349] if len(dates)>349 else None

def trailing_year(dates,values):
    out=[];pos={d:i for i,d in enumerate(dates)}
    for i,d in enumerate(dates):
        dt=datetime.strptime(d,"%Y-%m-%d")
        try:t=dt.replace(year=dt.year-1)
        except ValueError:t=dt.replace(year=dt.year-1,day=28)
        target=t.strftime("%Y-%m-%d")
        j=i
        while j>=0 and dates[j]>target:j-=1
        out.append(None if j<0 or values[j]<=0 else 100*(values[i]/values[j]-1))
    return out

def smooth_ema(a,n=10):
    alpha=2/(n+1);p=None;out=[]
    for v in a:
        if v is None:p=None;out.append(None)
        else:
            p=v if p is None else alpha*v+(1-alpha)*p
            out.append(p)
    return out

def smooth_sma(a,n=3):
    out=[]
    for i in range(len(a)):
        q=a[max(0,i-n+1):i+1]
        out.append(sum(q)/n if len(q)==n and all(v is not None for v in q) else None)
    return out

def main():
    fmp,eod=API("FMP"),API("EODHD")
    if not fmp.key or not eod.key:raise SystemExit("MISSING_SECRETS")
    today=datetime.now(TZ).date();end=(today-timedelta(days=1)).isoformat();start=(today-timedelta(days=LOOKBACK_DAYS)).isoformat()
    roster_raw=eod.get("/api/exchange-symbol-list/JK")
    roster=[]
    for r in roster_raw if isinstance(roster_raw,list) else []:
        code=str(r.get("Code",""));kind=str(r.get("Type",""));cur=str(r.get("Currency",""))
        if re.fullmatch(r"[A-Z]{4}",code) and kind in ("Common Stock","Stock") and cur=="IDR":roster.append(code+".JK")
    roster=sorted(set(roster))
    if len(roster)<500:raise SystemExit("ROSTER_TOO_SMALL")
    bench=fmp.get("/stable/historical-price-eod/full",symbol="^JKSE",**{"from":start,"to":end})
    b=[(str(r.get("date")),num(r.get("close"))) for r in bench if isinstance(r,dict) and num(r.get("close"))]
    b=sorted((d,v) for d,v in b if re.fullmatch(r"\d{4}-\d{2}-\d{2}",d))
    if len(b)<500:raise SystemExit("BENCHMARK_TOO_SHORT")
    bdates=[x[0] for x in b];bvals=[x[1] for x in b]
    states={};warm={}
    def load(sym):
        try:
            p=eod.get("/api/eod/"+sym,**{"from":start,"to":end,"period":"d","order":"a"})
            sp=eod.get("/api/splits/"+sym,**{"from":start,"to":end})
            return sym,*stock_states(adjust_bars(p,sp))
        except Exception:
            return sym,{},None
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for sym,st,w in pool.map(load,roster):
            states[sym]=st
            if w:warm[sym]=w
    dates=bdates[-DISPLAY_POINTS:];bvals=bvals[-DISPLAY_POINTS:]
    macd=[];ma=[];sup=[];comp=[];cov=[];eligible=[];target=[];vi=[];vb=[];vs=[]
    for d in dates:
        t=0;valid=0;cm=ca=cs=0;rvsum=0.0;balsum=0.0;spikes=0;vn=0
        for sym in roster:
            if sym not in warm or warm[sym]>d:continue
            t+=1
            x=states[sym].get(d)
            if x is None:continue
            valid+=1;m,a,s,rv,bal,sp=x;cm+=m;ca+=a;cs+=s
            if rv is not None and bal is not None:
                rvsum+=min(rv,5);balsum+=bal;spikes+=sp or 0;vn+=1
        target.append(t);eligible.append(valid);cov.append(None if not t else 100*valid/t)
        if valid:
            m=100*cm/valid;a=100*ca/valid;s=100*cs/valid
            macd.append(m);ma.append(a);sup.append(s);comp.append((m+a+s)/3)
        else:macd.append(None);ma.append(None);sup.append(None);comp.append(None)
        vi.append(None if not vn else 100*rvsum/vn)
        vb.append(None if not rvsum else 100*balsum/rvsum)
        vs.append(None if not vn else 100*spikes/vn)
    screener=fmp.get("/stable/company-screener",country="ID",limit=10000)
    caps={r.get("symbol"):num(r.get("marketCap")) for r in screener if isinstance(r,dict) and num(r.get("marketCap"))}
    capcov=100*sum(1 for s in roster if s in caps)/len(roster)
    latest_cov=cov[-1] if cov else None
    data={"meta":{"market_as_of":dates[-1],"built_date":datetime.now(timezone.utc).isoformat(),"universe_symbols":len(roster),
          "price_coverage_pct":round(latest_cov or 0,2),"cap_coverage_pct":round(capcov,2),
          "methodology":"Current provider-covered IDX common-stock roster; historical breadth is retrospective and has survivorship bias.",
          "sources":["EODHD OHLCV/splits/current JK roster","FMP ^JKSE benchmark/current cap screener"],"status":"live aggregate public refresh"},
          "dates":dates,"ihsg":[round(x,2) for x in bvals],"ihsg_1y":trailing_year(dates,bvals),
          "macd":macd,"macd_smooth":smooth_ema(macd),"ma":ma,"ma_smooth":smooth_ema(ma),"st":sup,"st_smooth":smooth_ema(sup),
          "composite":comp,"composite_smooth":smooth_ema(comp),"coverage":cov,"eligible":eligible,"target":target,
          "volume_index":vi,"volume_index_smooth":smooth_sma(vi),"volume_balance":vb,"volume_balance_smooth":smooth_sma(vb),
          "volume_spike":vs,"volume_spike_smooth":smooth_sma(vs)}
    def scrub(x):
        if isinstance(x,float):
            return None if not math.isfinite(x) else round(x,4)
        if isinstance(x,list):return [scrub(v) for v in x]
        if isinstance(x,dict):return {k:scrub(v) for k,v in x.items()}
        return x
    OUT.write_text("window.IHSG_PUBLIC_DATA="+json.dumps(scrub(data),separators=(",",":"))+";\n",encoding="utf-8")
    print("updated",dates[-1],"roster",len(roster),"valid",eligible[-1],"coverage",round(cov[-1] or 0,2))

if __name__=="__main__":
    main()
