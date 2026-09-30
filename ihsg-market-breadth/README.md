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
responsive groups below the chart title. Each chart has independent **+**, **−**
and **Reset** controls. Drag across the plot to select dates, or use Ctrl + mouse
wheel over the plot. Ordinary scrolling still scrolls the page. Reset restores
the selected History range; choosing a new History range resets all three charts.
Zoom changes the visible dates only. Smoothing is calculated from full available
history before the chart is sliced, and the underlying aggregate data is unchanged.

## What Coverage means

`Coverage = 100 × valid indicator stocks / warmed target stocks`.

Stocks need sufficient observed history and usable MACD, MA100 and Supertrend
observations. Coverage measures indicator-data availability. A low value means
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
python -m unittest discover -s ihsg-market-breadth/tests -v
```

Run the commands from the repository root. Set `IHSG_BROWSER` to an existing
Chromium executable when the managed download is unavailable. Tests serve only
local files, reject external browser requests, and require no provider credentials.
Optional `IHSG_SCREENSHOT_DIR` saves UI evidence outside the source tree.
