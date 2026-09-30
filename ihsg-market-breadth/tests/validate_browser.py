#!/usr/bin/env python3
"""Validate the public IHSG dashboard in Chromium, locally or on GitHub Pages.

Requires Python Playwright and Chromium. No private data or credentials are used.
Example: python ihsg-market-breadth/tests/validate_browser.py --output-dir /tmp/ihsg-review
"""

import argparse
import copy
import datetime as dt
import json
import math
import os
import re
import shutil
import statistics
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

from playwright.sync_api import sync_playwright


PATH_POINT = re.compile(r"([ML])\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)", re.I)


def finite(value):
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)


def smooth(values, period, kind):
    """Independent reference: SMA needs a complete window; EMA reseeds after a gap."""
    result = []
    previous = None
    for index, value in enumerate(values):
        if kind == "SMA":
            window = values[max(0, index - period + 1):index + 1]
            result.append(statistics.fmean(window) if len(window) == period and all(map(finite, window)) else None)
        elif not finite(value):
            previous = None
            result.append(None)
        else:
            previous = value if previous is None else previous + (value - previous) * 2 / (period + 1)
            result.append(previous)
    return result


def range_start(dates, label):
    if label == "ALL":
        return 0
    last = dt.date.fromisoformat(dates[-1])
    months = {"6M": 6, "1Y": 12, "3Y": 36, "5Y": 60}[label]
    total = last.year * 12 + last.month - 1 - months
    year, month0 = divmod(total, 12)
    month = month0 + 1
    # JavaScript calendar subtraction overflows a short target month, rather than clamping.
    target = dt.date(year, month, 1) + dt.timedelta(days=last.day - 1)
    return next((i for i, date in enumerate(dates) if date >= target.isoformat()), len(dates) - 1)


class Review:
    def __init__(self, base_url, output_dir):
        self.base_url = base_url.rstrip("/") + "/"
        self.output_dir = Path(output_dir) if output_dir else None
        self.checks = []
        self.errors = []
        self.failed_assets = []
        self.requests = []
        if self.output_dir:
            self.output_dir.mkdir(parents=True, exist_ok=True)

    def check(self, name, condition, detail=""):
        if not condition:
            raise AssertionError(f"{name}: {detail or 'failed'}")
        self.checks.append(name)

    def open(self, context):
        page = context.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        page.on("request", lambda request: self.requests.append(request.url))
        page.on("requestfailed", lambda request: self.failed_assets.append(f"{request.url}: {request.failure}"))
        page.on("response", lambda response: self.failed_assets.append(f"{response.url}: HTTP {response.status}") if response.status >= 400 else None)
        response = page.goto(self.base_url, wait_until="networkidle")
        self.check("dashboard HTTP success", response is not None and response.ok)
        page.wait_for_selector("#combinedChart path.line")
        return page

    def snapshot(self, page, chart):
        return page.locator(f"#{chart}").evaluate("""el => {
          const plot = [...el.querySelectorAll('rect')].find(x => x.getAttribute('fill') === 'transparent');
          return {
            plot: {x: +plot.getAttribute('x'), y: +plot.getAttribute('y'), w: +plot.getAttribute('width'), h: +plot.getAttribute('height')},
            paths: [...el.querySelectorAll('path')].map(x => ({classes: x.getAttribute('class'), d: x.getAttribute('d')})),
            axes: [...el.querySelectorAll('text')].map(x => ({text: x.textContent, x: +x.getAttribute('x'), y: +x.getAttribute('y'), benchmark: x.classList.contains('benchmark-axis')}))
          };
        }""")

    def path(self, name, snapshot, index, values, limits=None):
        points = [(command.upper(), float(x), float(y)) for command, x, y in PATH_POINT.findall(snapshot["paths"][index]["d"])]
        expected = [(i, value) for i, value in enumerate(values) if finite(value)]
        self.check(name + " observation count", len(points) == len(expected), f"{len(points)} rendered vs {len(expected)} finite observations")
        plot = snapshot["plot"]
        if limits is None:
            raise ValueError("A numeric axis mapping is required")
        low, high = limits
        previous_index = None
        for (command, x, y), (i, value) in zip(points, expected):
            wanted_command = "L" if previous_index is not None and i == previous_index + 1 else "M"
            wanted_x = plot["x"] + plot["w"] * i / max(1, len(values) - 1)
            wanted_y = plot["y"] + plot["h"] * (1 - (value - low) / (high - low))
            if command != wanted_command or not math.isclose(x, wanted_x, abs_tol=1e-6) or not math.isclose(y, wanted_y, abs_tol=1e-6):
                raise AssertionError(f"{name}: point {i} got {command}({x},{y}), expected {wanted_command}({wanted_x},{wanted_y}) for {value}")
            previous_index = i
        self.check(name + " numeric values and gap boundaries", True)

    def benchmark_limits(self, values):
        available = list(filter(finite, values))
        low, high = (min(available), max(available)) if available else (0, 1)
        if low == high:
            low, high = low - 1, high + 1
        padding = (high - low) * 0.08 or 1
        return low - padding, high + padding

    def combined(self, page, payload, label, metric="macd", kind="EMA", period=10, benchmark="ihsg", name=None):
        start = range_start(payload["dates"], label)
        dates = payload["dates"][start:]
        chart = self.snapshot(page, "combinedChart")
        prefix = name or f"{label} {metric} {kind}{period}"
        self.check(prefix + " combined three series and separate axes", len(chart["paths"]) == 3 and len([x for x in chart["axes"] if x["benchmark"]]) == 5)
        self.path(prefix + " raw breadth", chart, 0, payload[metric][start:], (0, 100))
        self.path(prefix + " smoothed breadth", chart, 1, smooth(payload[metric], period, kind)[start:], (0, 100))
        self.path(prefix + " benchmark", chart, 2, payload[benchmark][start:], self.benchmark_limits(payload[benchmark][start:]))
        ticks = [x["text"] for x in chart["axes"] if re.fullmatch(r"\d{4}-\d{2}", x["text"])]
        self.check(prefix + " rendered date bounds", ticks[0] == dates[0][:7] and ticks[-1] == dates[-1][:7], str(ticks))
        self.check(prefix + " benchmark axis unit", all(("%" in x["text"]) == (benchmark == "ihsg_1y") for x in chart["axes"] if x["benchmark"]))

    def volume(self, page, payload, label, mode, kind="SMA", period=3, name=None):
        start = range_start(payload["dates"], label)
        field = {"activity": "volume_index", "balance": "volume_balance", "spike": "volume_spike"}[mode]
        values = payload[field][start:]
        high = max(160, max(filter(finite, values), default=160) * 1.05) if mode == "activity" else 100
        limits = (-100 if mode == "balance" else 0, high)
        chart = self.snapshot(page, "volumeChart")
        prefix = name or f"{label} volume {mode} {kind}{period}"
        self.path(prefix + " raw", chart, 0, values, limits)
        self.path(prefix + " smoothed", chart, 1, smooth(payload[field], period, kind)[start:], limits)
        self.check(prefix + " explanation", {"activity": "Activity index", "balance": "Directional balance", "spike": "High-volume breadth"}[mode] in page.locator("#volumeHelp").inner_text())

    def coverage(self, page, payload, label, name=None):
        start = range_start(payload["dates"], label)
        values = [None if finite(t) and t > 0 and e == 0 else c for c, t, e in zip(payload["coverage"], payload["target"], payload["eligible"])][start:]
        chart = self.snapshot(page, "coverageChart")
        self.path((name or label) + " coverage", chart, 0, values, (0, 100))

    def tooltip(self, page, chart, endpoint, expected_date, missing=False):
        svg = page.locator(f"#{chart}")
        svg.evaluate("""(el, end) => {
          const plot = [...el.querySelectorAll('rect')].find(x => x.getAttribute('fill') === 'transparent');
          const matrix = el.getScreenCTM();
          const point = new DOMPoint(+plot.getAttribute('x') + (end ? +plot.getAttribute('width') : 0), +plot.getAttribute('y') + 20).matrixTransform(matrix);
          plot.dispatchEvent(new MouseEvent('mousemove', {bubbles: true, clientX: point.x, clientY: point.y}));
        }""", endpoint)
        text = page.locator(f"#{chart.replace('Chart', 'Tip')}").inner_text()
        self.check(f"{chart} exact tooltip {'last' if endpoint else 'first'} date", text.startswith(expected_date + " |"), text)
        if missing:
            self.check(f"{chart} missing tooltip", "raw —" in text, text)
        svg.locator("rect[fill=transparent]").dispatch_event("mouseleave")

    def smoothing_controls(self, page, volume, kind, period):
        prefix = "volSmooth" if volume else "smooth"
        page.locator(f"#{prefix}Type").select_option(kind)
        page.locator(f"#{prefix}N").fill(str(period))
        page.locator("#applyVolSmooth" if volume else "#applySmooth").click()

    def render(self, page, mobile, dark, filename):
        page.evaluate("window.scrollTo(0, 0)")
        info = page.evaluate("""() => ({
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          dark: document.body.classList.contains('dark'),
          background: getComputedStyle(document.body).backgroundColor,
          charts: [...document.querySelectorAll('svg.chart')].map(el => {
            const rect = el.getBoundingClientRect(), view = el.viewBox.baseVal;
            const labels = [...el.querySelectorAll('text')].map(t => {
              const r = t.getBoundingClientRect();
              return {text: t.textContent, font: parseFloat(getComputedStyle(t).fontSize) * rect.height / view.height,
                glyphWidthScale: r.width / t.getComputedTextLength(),
                outside: r.left < rect.left - 2 || r.right > rect.right + 2};
            });
            return {width: rect.width, height: rect.height, viewWidth: view.width, labels};
          }),
          controls: [...document.querySelectorAll('button, select, input')].map(el => {
            const r = el.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width,height:r.height};
          })
        })""")
        name = ("mobile" if mobile else "desktop") + (" dark" if dark else " light")
        self.check(name + " no horizontal overflow", not info["overflow"])
        self.check(name + " theme", info["dark"] == dark and info["background"] == ("rgb(14, 20, 33)" if dark else "rgb(245, 247, 251)"))
        self.check(name + " chart dimensions", all(x["width"] > 200 and x["height"] > 250 for x in info["charts"]))
        self.check(name + " readable uncut axes", all(t["font"] >= 9 and not t["outside"] for chart in info["charts"] for t in chart["labels"]))
        self.check(name + " axis glyphs retain readable width", all(t["glyphWidthScale"] >= 0.9 for chart in info["charts"] for t in chart["labels"]))
        self.check(name + " chart viewBox follows available width", all(math.isclose(x["width"], x["viewWidth"], abs_tol=1) for x in info["charts"]))
        self.check(name + " controls fit viewport", all(x["left"] >= 0 and x["right"] <= page.viewport_size["width"] + 1 and x["width"] > 0 and x["height"] > 0 for x in info["controls"]))
        if self.output_dir:
            page.screenshot(path=str(self.output_dir / filename), full_page=True)

    def run(self, browser):
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=1, has_touch=True)
        page = self.open(context)
        payload = page.evaluate("window.IHSG_PUBLIC_DATA")
        self.check("single aligned aggregate payload", payload["meta"]["display_points"] == len(payload["dates"]) and all(len(v) == len(payload["dates"]) for v in payload.values() if isinstance(v, list)))
        self.check("only validated data and app scripts", [urlsplit(s).path.rsplit("/", 1)[-1] for s in page.locator("script[src]").evaluate_all("elements => elements.map(e => e.src)")] == ["data.js", "app.js"])
        for label in ("6M", "1Y", "3Y", "5Y", "ALL"):
            page.locator(f'.range[data-range="{label}"]').click()
            self.combined(page, payload, label)
            self.volume(page, payload, label, "activity")
            self.coverage(page, payload, label)
            start = range_start(payload["dates"], label)
            self.tooltip(page, "combinedChart", 0, payload["dates"][start])
            self.tooltip(page, "combinedChart", 1, payload["dates"][-1])

        for metric in ("macd", "ma", "st", "composite"):
            page.locator(f'.metric[data-metric="{metric}"]').click()
            for kind, period in (("SMA", 37), ("EMA", 19)):
                self.smoothing_controls(page, False, kind, period)
                self.combined(page, payload, "ALL", metric, kind, period)
        for kind, period in (("SMA", 1), ("EMA", 1260)):
            self.smoothing_controls(page, False, kind, period)
            self.combined(page, payload, "ALL", "composite", kind, period)
        page.locator("#retBtn").click()
        self.combined(page, payload, "ALL", "composite", "EMA", 1260, "ihsg_1y", "IHSG 1Y return")
        page.locator("#absBtn").click()

        for mode in ("activity", "balance", "spike"):
            page.locator(f'.volume-mode[data-volume="{mode}"]').click()
            for kind, period in (("SMA", 11), ("EMA", 23)):
                self.smoothing_controls(page, True, kind, period)
                self.volume(page, payload, "ALL", mode, kind, period)
        for volume in (False, True):
            prefix = "volSmooth" if volume else "smooth"
            before = page.locator("#volumeChart" if volume else "#combinedChart").inner_html()
            for invalid in (0, 1261, 2.5):
                dialogs = []
                handler = lambda dialog: (dialogs.append(dialog.message), dialog.accept())
                page.on("dialog", handler)
                page.locator(f"#{prefix}N").fill(str(invalid))
                page.locator("#applyVolSmooth" if volume else "#applySmooth").click()
                page.remove_listener("dialog", handler)
                self.check(f"{prefix} rejects {invalid}", len(dialogs) == 1 and "1 to 1260" in dialogs[0])
                self.check(f"{prefix} invalid {invalid} preserves plotted result", before == page.locator("#volumeChart" if volume else "#combinedChart").inner_html())

        self.smoothing_controls(page, False, "SMA", 37)
        self.smoothing_controls(page, True, "EMA", 23)
        page.locator('.range[data-range="3Y"]').click()
        self.render(page, False, False, "desktop-light.png")
        page.locator("#themeBtn").click()
        self.render(page, False, True, "desktop-dark.png")
        page.reload(wait_until="networkidle")
        self.check("preferences survive reload", page.locator("#smoothN").input_value() == "37" and page.locator("#smoothType").input_value() == "SMA" and page.locator("#volSmoothN").input_value() == "23" and page.locator("#volSmoothType").input_value() == "EMA" and page.locator('.range.active').get_attribute("data-range") == "3Y" and page.locator('.volume-mode.active').get_attribute("data-volume") == "spike" and page.locator("body").evaluate("el => el.classList.contains('dark')"))
        self.combined(page, payload, "3Y", "macd", "SMA", 37, name="restored smoothing")
        self.volume(page, payload, "3Y", "spike", "EMA", 23, name="restored volume")
        desktop_width = page.locator("#combinedChart").evaluate("el => el.viewBox.baseVal.width")
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(100)
        mobile_width = page.locator("#combinedChart").evaluate("el => el.viewBox.baseVal.width")
        self.check("resize redraw changes chart geometry", desktop_width > mobile_width and math.isclose(mobile_width, page.locator("#combinedChart").bounding_box()["width"], abs_tol=1))
        self.render(page, True, True, "mobile-dark.png")
        page.locator("#themeBtn").click()
        self.render(page, True, False, "mobile-light.png")
        self.combined(page, payload, "3Y", "macd", "SMA", 37, name="mobile resized")
        for label in ("6M", "1Y", "3Y", "5Y", "ALL"):
            page.locator(f'.range[data-range="{label}"]').click()
            self.combined(page, payload, label, "macd", "SMA", 37, name=f"mobile {label}")
        for chart in ("combinedChart", "volumeChart", "coverageChart"):
            overlay = page.locator(f"#{chart} rect[fill=transparent]")
            overlay.scroll_into_view_if_needed()
            box = overlay.bounding_box()
            # Chromium rounds touch coordinates to pixels. On All, half a pixel can
            # represent many sessions, so derive the reference date from the exact tap.
            tap_x = round(box["x"] + box["width"] * 0.75)
            page.touchscreen.tap(tap_x, round(box["y"] + min(20, box["height"] / 2)))
            tip = page.locator(f"#{chart.replace('Chart', 'Tip')}")
            index = math.floor((len(payload["dates"]) - 1) * (tap_x - box["x"]) / box["width"] + 0.5)
            self.check(chart + " mobile touch tooltip", tip.is_visible() and tip.inner_text().split(" |", 1)[0] == payload["dates"][index], tip.inner_text())
        context.close()

        # Malformed stored settings must recover finite defaults rather than empty/NaN paths.
        for bad in ("NaN", "Infinity", "2.5", "0", "1261", "garbage"):
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            context.add_init_script(f"localStorage.setItem('ihsg-smooth-n', {json.dumps(bad)}); localStorage.setItem('ihsg-vol-smooth-n', {json.dumps(bad)});")
            page = self.open(context)
            self.check(f"stored {bad} restores finite defaults", page.locator("#smoothN").input_value() == "10" and page.locator("#volSmoothN").input_value() == "3")
            self.combined(page, payload, "1Y", name=f"stored {bad} breadth")
            self.volume(page, payload, "1Y", "activity", name=f"stored {bad} volume")
            context.close()

        # Route only this public payload response; actual repository data remains untouched.
        missing = copy.deepcopy(payload)
        gaps = [len(payload["dates"]) - 18, len(payload["dates"]) - 12, len(payload["dates"]) - 11, len(payload["dates"]) - 1]
        for field, values in missing.items():
            if isinstance(values, list) and field != "dates":
                for i in gaps:
                    values[i] = None
        missing["macd"][-7] = 0  # Real zero is valid; a null observation must not become this.
        missing["composite"][-7] = statistics.fmean(missing[field][-7] for field in ("macd", "ma", "st"))
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        context.route(urljoin(self.base_url, "data.js"), lambda route: route.fulfill(status=200, content_type="application/javascript", body="window.IHSG_PUBLIC_DATA=" + json.dumps(missing) + ";"))
        page = self.open(context)
        for kind in ("SMA", "EMA"):
            self.smoothing_controls(page, False, kind, 3)
            self.combined(page, missing, "1Y", "macd", kind, 3, name=f"injected gaps {kind}")
            for mode in ("activity", "balance", "spike"):
                page.locator(f'.volume-mode[data-volume="{mode}"]').click()
                self.smoothing_controls(page, True, kind, 3)
                self.volume(page, missing, "1Y", mode, kind, 3, name=f"injected gaps {mode} {kind}")
        self.coverage(page, missing, "1Y", "injected gaps")
        self.tooltip(page, "combinedChart", 1, missing["dates"][-1], missing=True)
        self.tooltip(page, "volumeChart", 1, missing["dates"][-1], missing=True)
        self.tooltip(page, "coverageChart", 1, missing["dates"][-1], missing=True)
        self.check("missing latest KPI displays unavailable", page.locator("#kMacd").inner_text() == "—%" and page.locator("#kVolBal").inner_text() == "—")
        missing["eligible"][-8] = 0
        missing["coverage"][-8] = 0
        page.reload(wait_until="networkidle")
        self.coverage(page, missing, "1Y", "zero-eligible cross-section stays a gap")
        context.close()

        self.check("no browser exceptions", not self.errors, str(self.errors))
        self.check("no failed page assets", not self.failed_assets, str(self.failed_assets))
        self.check("no obsolete yearly payload requests", not any(re.search(r"(?:data[-_]?\d{4}|\d{4}[-_]?data|year[-_]\d{4})", urlsplit(url).path, re.I) for url in self.requests))
        report = {"base_url": self.base_url, "checks_passed": len(self.checks), "history_start": payload["dates"][0], "market_as_of": payload["dates"][-1], "rows": len(payload["dates"]), "checks": self.checks}
        if self.output_dir:
            (self.output_dir / "browser-validation.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({key: value for key, value in report.items() if key != "checks"}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/ihsg-market-breadth/")
    parser.add_argument("--output-dir", help="Optional screenshots and JSON report (prefer a directory outside the checkout)")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        executable = shutil.which("chromium") or shutil.which("chromium-browser")
        launch = {"executable_path": executable} if executable else {}
        if urlsplit(args.base_url).hostname not in ("localhost", "127.0.0.1", "::1"):
            configured_proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
            if configured_proxy:
                parsed = urlsplit(configured_proxy)
                proxy = {"server": f"{parsed.scheme}://{parsed.hostname}" + (f":{parsed.port}" if parsed.port else ""), "bypass": "localhost,127.0.0.1"}
                if parsed.username:
                    proxy["username"] = unquote(parsed.username)
                if parsed.password:
                    proxy["password"] = unquote(parsed.password)
                launch["proxy"] = proxy
        browser = playwright.chromium.launch(**launch, args=["--no-sandbox"])
        try:
            Review(args.base_url, args.output_dir).run(browser)
        finally:
            browser.close()


if __name__ == "__main__":
    main()
