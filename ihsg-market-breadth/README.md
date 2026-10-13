# IHSG Market Breadth — Public Display

Direct dashboard:

https://setyadi-house.github.io/market-heat-public/ihsg-market-breadth/

The page has three sections, chosen with the tabs under the title (keyboard:
ArrowLeft/ArrowRight, Home, End) or directly by address:

| Section | Address | Shows |
|---|---|---|
| Market Breadth | `…/ihsg-market-breadth/` or `#breadth` | Aggregate MACD, MA100 and Supertrend breadth, IHSG, volume participation and coverage (unchanged). |
| Margin Monitor | `#margin`, or `#margin/BBCA` for one stock | Daily transaction value of the official IDX Margin section: aggregate chart, stock chart, daily and period tables. |
| Data Status | `#status` | Freshness and quality of each dataset, stated separately. |

The calculation pipeline, its source archives and the stock-level vendor
observations remain private in:

https://github.com/Setyadi-House/ihsg-market-breadth

**Public/private boundary.** Market Breadth stays aggregate-only: `data.js`
carries no tickers or per-stock arrays and no stock-level IDX/EODHD data.
Historical breadth uses the current provider-covered universe, so it is a
research view with survivorship limitations rather than an official
point-in-time IDX breadth index.

The Margin Monitor is the one explicit stock-level exception, and only for
official IDX Margin records: `margin-data.js` holds, per verified session, the
stock code and the source's own Nilai (value, IDR), Volume and Frekuensi of the
Margin section of the IDX daily stock summary (Ringkasan Saham), plus session
totals, counts and status. It never contains vendor prices or volumes, breadth
inputs, private caches or archives, repair ledgers, proxy or network details, or
credentials. All nine original columns stay in the private archive.

## How the data is updated

Each dataset has its own file, its own validation and its own guard, so one can
never hold back or overwrite the other.

`data.js` (Market Breadth) is written automatically by the private production
workflow after a validated release: only the release's aggregate
`public-data.js`, byte for byte, after its checksum and the aggregate-only schema
are verified. An older or equal market date never replaces a newer one, and the
workflow fails visibly when this page does not serve the latest validated output.
The displayed sources and dates come from the file's own metadata. From
2026-10-08 the IDX official daily stock summary is the primary source of new
sessions, with EODHD as a fallback labelled per row; the history starts on
2006-12-08 (active dataset from 2005-07-01 after 350 observed warm-up bars).

`margin-data.js` (Margin Monitor) is a separately versioned snapshot. Revision 1,
deployed with this page, is the verified historical archive: 503 sessions and
98,986 stock records from 2024-09-02 to 2026-10-13 (433 stock codes). After the
owner enables Margin updates, the same daily private workflow collects only new
sessions from the Margin section of
https://www.idx.co.id/id/data-pasar/ringkasan-perdagangan/ringkasan-saham/,
verifies each file (its date, structure and values) and then replaces this file
only with a validated snapshot whose latest session or revision is newer; equal
content is not rewritten and the file is never created by the update (it ships
with the page). Its guard is independent of the breadth market date. When
collection is not enabled, refused, held or failed, the last verified data stays
and the page shows that status; Margin values are never estimated, and a missing
file is never treated as a holiday or as zero Margin trading. Loading the page
does not download `margin-data.js`: it is fetched only when Margin Monitor or
Data Status is first opened.

## Chart controls

Indicator, smoothing, IHSG comparison and history controls appear in labelled,
responsive groups below the chart title. Scroll the mouse wheel over a plot to
zoom in or out at the latest available date, with or without Ctrl. Scrolling
returns the view to the latest available dates even after moving into earlier
history. Scrolling outside the plot still scrolls the page.

Click and hold inside a plot, then drag horizontally to move its date window
continuously through the full available history. The grab cursor changes to a
grabbing hand while moving. Each chart moves independently and keeps its session
count, so a 1Y view can move into earlier years without first zooming. The History
preset sets the maximum window length; **Reset zoom** restores its latest period.
Choosing a new History range resets all three charts.

Each chart has a magnifying-glass **Box zoom** button beside **Reset zoom**.
Activate it to switch that chart to a crosshair cursor, then click and hold to
draw a rectangle around the period to inspect. Releasing narrows the date window
and fits its numerical axes. Box zoom is independent for each chart; its button
shows the active state. Click it again or press **Escape** on the focused chart to
return to drag navigation. Escape also cancels an unfinished rectangle.

Focus a chart to use **+** and **−** for zoom, **ArrowLeft** and **ArrowRight** for
moving dates, and **Home** for reset.

While zoomed or moved, numerical axes fit the visible raw and smoothed observations, with
padding and the metric's mathematical bounds. The IHSG axis uses its own visible
values. Reset restores the original breadth, balance and percentage scales.
Smoothing is calculated from full available history before the chart is sliced,
and the underlying aggregate data is unchanged.

## What Volume participation means

The **What do these mean?** popup explains all three volume views. Relative volume
(RVOL) compares today's observed volume with the prior 20 observed volume bars,
excluding today. Activity is 100 times the mean RVOL, with each RVOL capped at 5.
Directional balance weights rising and falling stocks by that capped RVOL;
unchanged stocks contribute to the denominator. High-volume breadth is the share
of volume-valid stocks meeting its selected RVOL threshold.

High-volume breadth has a dedicated, responsive settings row with thresholds
0.5, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4 and 5× and baselines of 5, 10, 20, 50, 100
or 200 prior observed volume bars. The default is unchanged at 1.5× and 20 bars.
Selections update the chart immediately and persist locally, preserving its zoom.
Today's volume is excluded from every baseline. Activity and Directional balance
continue to use their original 20-bar baseline.

The private pipeline calculates each setting's aggregate high-volume stock count
and valid comparison count. The public chart derives `100 × count / valid`; it
contains no per-stock RVOL values. Valid denominators can differ by baseline,
and a zero denominator produces a gap. The popup explains the settings and the
tooltip shows the selected parameters and counts.

If all recorded volume weights are zero, Directional balance is undefined because
its denominator is zero. Its raw value stays missing; Activity and high-volume
breadth can correctly be zero. The 2026-09-29 snapshot had 18 such dates since
2023; later snapshots, with the private quarantine of unverified rows, can have
none. Source evidence does not establish whether these dates were exchange
closures or vendor anomalies.

Directional balance display SMA uses the last N **valid observations**, including
the current value. Undefined dates stay gaps, but do not erase the moving-average
history: SMA50 resumes on the next valid date rather than hiding another 49
sessions. EMA uses N as its smoothing span and retains its previous valid state
across those gaps, with older observations receiving decreasing weight.
This affects only balance display smoothing; raw series, provider calculations,
other smoothing and the full available history are preserved.

## What Coverage means

`Coverage = 100 × valid indicator stocks / warmed target stocks`.

The **What is Coverage?** popup defines both counts with a numerical example.
Target stocks have at least 350 observed stock trading bars; valid stocks are
those targets with usable MACD, MA100 and Supertrend observations on that date.
Coverage measures indicator-data availability. A low value means
the breadth sample is incomplete; it is not the percentage of bullish stocks.
The dashed 95% line marks a data-quality warning. Dates without a usable stock
cross-section are excluded rather than published as 0%.

The chart derives the exact percentage from the public integer counts, including
older exports that rounded the percentage. Its tooltip shows the date and valid
/ target counts; the note below summarizes low-coverage sessions in the view.

In the earlier 2026-09-29 snapshot, 2023-06-28 and 2023-06-30 each had
8 valid stocks / 713 target stocks (1.1220196353436185%). Isolated declines like
these look nearly vertical when two decades are compressed into one chart. Available
calendar evidence does not establish whether the sparse vendor observations
reflect exchange closures or source outages, so these nonzero values are retained.

## Margin Monitor

All values are the Margin section of the official IDX daily stock summary.

- **Nilai (Margin value):** the reported transaction value, in rupiah, of a
  stock's Margin-section trades on one session. It is not outstanding margin
  debt, broker receivables, net buying or leverage.
- **Daily Margin value:** the sum of Nilai over every verified Margin record of
  the session.
- **Activity index:** `100 × daily Margin value ÷ daily Margin value of the base
  session`. The default base is 2024-09-02 = 100. Another verified session with a
  positive total can be chosen and is always shown; dates without a verified
  session are refused. Zooming, moving or changing the visible dates never
  rebases it. It measures transaction activity, not a price return.
- **Period value:** each stock's sum of daily Nilai over the verified sessions
  of the selected period (cumulative transaction value, not a balance), with its
  share of the period total and the number of sessions with and without a record.

Controls, each independent of the others:

- The **aggregate chart** (full width, 480 px on desktop) switches between the
  nominal daily value (IDR) and the activity index, and has its own date range
  (1M, 3M, 6M, YTD, 1Y, All, or start and end dates), drag/scroll/Box zoom
  navigation, Reset zoom and moving average.
- The **stock chart** (full width, 480 px) shows the selected stock's daily Nilai
  as bars with its own moving average and date range. Choose the stock by code
  (with suggestions, previous/next buttons) or by clicking a code in either
  table; the address `#margin/CODE` opens it directly.
- **Expand** shows either chart full screen; Escape or the button closes it.
- The **daily stock snapshot** table defaults to the latest verified session and
  lists Trade Date, Stock Code, value, share of the day, volume, frequency and
  value per trade. The **period stock breakdown** has its own Period Start and
  Period End (default: the last month). Both sort by any column and filter by
  code.
- **Export CSV** on each chart and table downloads the shown selection with a
  header naming the source, the snapshot revision and its SHA-256.

Moving averages (SMA or EMA, a whole number of sessions from 1 to 1260, default
SMA20) are set separately for the aggregate and the stock chart. They are
computed on the full history before the visible dates are cut, so zooming never
changes them, and they use only past and current sessions. The aggregate
average skips sessions without a verified file. For a stock, **Observed records**
uses its last N records and skips sessions without one; **Consecutive sessions**
needs a record on each of the last N sessions, so a session without one breaks
it. Until enough history exists the average is not drawn. The raw series stays
visible (the aggregate's can be hidden). A stock without a record on a verified
session had no Margin trades reported that day: it stays empty, never zero. An
expected session without a verified file is drawn as a dashed line and named in
the tooltip; it is never filled.

## Data Status

Data Status states each dataset's own status. For Market Breadth: whether its
file validated in the browser, the market date, history, latest coverage,
source priority and the publication rule. For IDX Margin: the update status
recorded by the last run (for example *Verified checkpoint*, *Up to date*,
*Update unavailable* with the reason), when it was recorded and the latest
expected session at that time, the verified dataset, the imported archive and
what daily updates added, pending sessions, gaps, the last successful update,
quality checks, stock participation per session and the snapshot revision, plus
completeness by month. Dataset completeness counts sessions; a stock's daily
participation is a separate matter. Nothing on the page derives freshness from
the device clock.

## Themes

**Dark mode / Light mode** in the header switches every section, including chart
colours, tooltips and native date controls, and the choice is remembered in this
browser. Margin settings (chart series, moving averages, aggregate range, last
stock) are remembered too and fall back to the defaults when invalid.

## Offline UI checks

Use Python 3.12, Node.js and Playwright 1.63.0:

```sh
python -m pip install playwright==1.63.0
python -m playwright install chromium
for file in app help charts margin shell; do node --check ihsg-market-breadth/$file.js; done
python -m unittest discover -s ihsg-market-breadth/tests -v
```

Run the commands from the repository root. Set `IHSG_BROWSER` to an existing
Chromium executable when the managed download is unavailable. Tests serve only
local files, reject external browser requests, and require no provider credentials.
`tests/test_dashboard.py` covers Market Breadth; `tests/test_margin_dashboard.py`
covers the Margin Monitor, Data Status and the navigation (payload invariants,
the index base, moving averages against an independent reference, gaps, the
independent date controls, tables, exports, themes, mobile widths, tooltips, the
expanded view, loading and failure states). Optional `IHSG_SCREENSHOT_DIR` saves
UI evidence outside the source tree.
