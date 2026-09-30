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

## Public payload contract

`data.js` is the single validated, aligned aggregate payload. The checkpoint at
`8b7e8dfe9ab5dd176af0dea69bdfb653f1183e17` contains 6,147 sessions from
2001-06-18 through 2026-09-29. Keep that full history unless a newer validated
private export explicitly extends it. Do not rebuild it from separate yearly
files or fetch stock-level vendor data in the browser.

Every public array must align with `dates`, and `meta.display_points` must equal
the number of dates. Coverage is `100 * eligible / target` for usable
cross-sections; unavailable observations must remain `null`. A missing whole
cross-section is a gap, not 0% coverage. Breadth and volume smoothing also retain
gaps: SMA requires a complete window, and EMA restarts after a missing value.
An observed numeric zero remains a zero.

Use the committed payload for display development. `update.py` is a legacy
short-history generator, not a replacement for the validated private export:
it retains only 504 points and omits metadata required by the current display.
Do not run it to refresh this dashboard. The private calculation repository is
outside the public display review.

## Validation

From the repository root, run the payload regression checks without third-party
dependencies:

```bash
python3 ihsg-market-breadth/tests/test_public_payload.py
```

For browser checks, install Python Playwright and its Chromium browser in your
development environment, or use an existing system Chromium. Start a static
server from the repository root in a separate terminal:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Then run the browser validator:

```bash
python3 ihsg-market-breadth/tests/validate_browser.py
```

The validator exercises history ranges, custom breadth and volume smoothing,
all volume modes, the two axes, theme persistence, desktop/mobile layout, and
missing-data rendering. It also tests malformed saved preferences and invalid
smoothing inputs. Use `--output-dir` to save screenshots outside the checkout.

To inspect the deployed dashboard with the same browser checks:

```bash
python3 ihsg-market-breadth/tests/validate_browser.py \
  --base-url https://setyadi-house.github.io/market-heat-public/ihsg-market-breadth/
```

A successful local run does not establish that a pull request is deployed.
Check the GitHub Pages build/deployment status and validate the public URL after
the reviewed change reaches the configured publishing branch.
