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
