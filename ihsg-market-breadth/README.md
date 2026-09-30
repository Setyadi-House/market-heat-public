# IHSG Market Breadth — Public Display

Direct dashboard:

https://setyadi-house.github.io/market-heat-public/ihsg-market-breadth/

This directory is the public, aggregate-only display layer for the IHSG Market
Breadth project. It shows derived market-participation indicators such as MACD
breadth, MA100 breadth, Supertrend breadth, IHSG performance, volume participation
and coverage.

The calculation pipeline and stock-level vendor observations remain private in:

https://github.com/Setyadi-House/ihsg-market-breadth

The public display intentionally does not publish API keys or stock-level raw
FMP/EODHD payloads. Historical breadth uses the current provider-covered universe,
so it is a research view with survivorship limitations rather than an official
point-in-time IDX breadth index.

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
breadth can correctly be zero. The validated snapshot has 18 such dates since
2023. Source evidence does not establish whether these dates were exchange
closures or vendor anomalies.

Directional balance display SMA uses the last N **valid observations**, including
the current value. Undefined dates stay gaps, but do not erase the moving-average
history: SMA50 resumes on the next valid date rather than hiding another 49
sessions. EMA uses N as its smoothing span and retains its previous valid state
across those gaps, with older observations receiving decreasing weight.
This affects only balance display smoothing; raw series, provider calculations,
other smoothing and the full 6,147-session history are preserved.

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

In the validated 2026-09-29 snapshot, 2023-06-28 and 2023-06-30 each have
8 valid stocks / 713 target stocks (1.1220196353436185%). These isolated declines
look nearly vertical when 25 years are compressed into one chart. Available
calendar evidence does not establish whether the sparse vendor observations
reflect exchange closures or source outages, so these nonzero values are retained.

## Offline UI checks

Use Python 3.12, Node.js and Playwright 1.63.0:

```sh
python -m pip install playwright==1.63.0
python -m playwright install chromium
node --check ihsg-market-breadth/app.js
node --check ihsg-market-breadth/help.js
python -m unittest discover -s ihsg-market-breadth/tests -v
```

Run the commands from the repository root. Set `IHSG_BROWSER` to an existing
Chromium executable when the managed download is unavailable. Tests serve only
local files, reject external browser requests, and require no provider credentials.
Optional `IHSG_SCREENSHOT_DIR` saves UI evidence outside the source tree.
