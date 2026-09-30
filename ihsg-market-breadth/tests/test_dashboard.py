"""Offline regressions for the shipped aggregate dashboard.

Run: python -m unittest discover -s ihsg-market-breadth/tests -v
Install playwright==1.63.0 and its Chromium, or set IHSG_BROWSER to a browser path.
IHSG_SCREENSHOT_DIR optionally saves responsive previews outside the checkout.
No providers, credentials, or external web resources are used.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


DASHBOARD = Path(__file__).resolve().parents[1]
CHARTS = ("combinedChart", "volumeChart", "coverageChart")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def moving_average(values, length, method):
    """Independent reference: nulls break EMA and invalidate an SMA window."""
    result = []
    previous = None
    for index, value in enumerate(values):
        if method == "EMA":
            if value is None:
                previous = None
            elif previous is None:
                previous = value
            else:
                previous += 2 / (length + 1) * (value - previous)
            result.append(previous)
        else:
            window = values[max(0, index - length + 1) : index + 1]
            result.append(
                sum(window) / length
                if len(window) == length and None not in window
                else None
            )
    return result


class DashboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        text = (DASHBOARD / "data.js").read_text(encoding="utf-8")
        prefix = "window.IHSG_PUBLIC_DATA="
        if not text.startswith(prefix):
            raise AssertionError("data.js must contain the aggregate JSON assignment")
        cls.payload = json.loads(text[len(prefix) :].strip().removesuffix(";"))
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietHandler, directory=str(DASHBOARD))
        )
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/index.html"
        cls.playwright = sync_playwright().start()
        configured = os.environ.get("IHSG_BROWSER")
        bundled = cls.playwright.chromium.executable_path
        executable = configured or (
            bundled if Path(bundled).is_file() else None
        ) or shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
        cls.browser = cls.playwright.chromium.launch(
            executable_path=executable,
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=5)

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1920, "height": 1080})
        self.page = self.context.new_page()
        self.errors = []
        self.external_requests = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))

        def local_only(route):
            if urlsplit(route.request.url).hostname != "127.0.0.1":
                self.external_requests.append(route.request.url)
                route.abort()
            else:
                route.continue_()

        self.page.route("**/*", local_only)
        response = self.page.goto(self.url, wait_until="load")
        self.assertEqual(response.status, 200)
        self.page.wait_for_function("!!window.__IHSG_TEST__")

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Dashboard raised browser errors")
        self.assertEqual(self.external_requests, [], "Offline dashboard requested external resources")

    def view(self, chart):
        return self.page.evaluate("id => window.__IHSG_TEST__.getView(id)", chart)

    def counts(self):
        return self.page.evaluate(
            "ids => Object.fromEntries(ids.map(id => [id, window.__IHSG_TEST__.getView(id).count]))",
            list(CHARTS),
        )

    def history(self, preset):
        self.page.locator(f'.range[data-range="{preset}"]').click()

    def button(self, chart, action):
        return self.page.locator(f'.zoom-control[data-chart="{chart}"][data-zoom="{action}"]')

    def plot(self, chart):
        element = self.page.locator(f"#{chart} .plot-hit-area")
        element.scroll_into_view_if_needed()
        return element.bounding_box()

    def screenshot(self, name):
        destination = os.environ.get("IHSG_SCREENSHOT_DIR")
        if destination:
            path = Path(destination)
            path.mkdir(parents=True, exist_ok=True)
            self.page.screenshot(path=str(path / f"{name}.png"), full_page=True)

    def assert_series(self, actual, expected):
        self.assertEqual(len(actual), len(expected))
        for index, (got, wanted) in enumerate(zip(actual, expected)):
            if wanted is None:
                self.assertIsNone(got, f"Missing observation was filled at {index}")
            else:
                self.assertIsNotNone(got, f"Observation disappeared at {index}")
                self.assertAlmostEqual(got, wanted, delta=1e-8, msg=f"Value changed at {index}")

    def assert_slice(self, before, after):
        offset = after["start"] - before["start"]
        self.assertGreaterEqual(offset, 0)
        self.assertLessEqual(after["end"], before["end"])
        for field in ("dates", "raw", "smoothed", "benchmark"):
            if field in before:
                self.assertEqual(after[field], before[field][offset : offset + after["count"]], field)

    def test_real_payload_alignment_and_full_history(self):
        data = self.payload
        dates = data["dates"]
        self.assertGreaterEqual(len(dates), 6147, "Validated available history was truncated")
        self.assertEqual(dates[0], "2001-06-18")
        self.assertEqual(dates, sorted(set(dates)))
        self.assertEqual(data["meta"]["history_start"], dates[0])
        self.assertEqual(data["meta"]["market_as_of"], dates[-1])
        self.assertEqual(data["meta"]["display_points"], len(dates))
        self.assertEqual(data["meta"]["classification"], "AGGREGATE_DERIVED_DATA")
        allowed_arrays = {
            "dates", "ihsg", "ihsg_1y", "macd", "ma", "st", "composite",
            "target", "eligible", "coverage", "volume_index", "volume_balance",
            "volume_spike", "volume_valid",
        }
        for field, values in data.items():
            if isinstance(values, list):
                self.assertIn(field, allowed_arrays, "Unexpected public data array")
                self.assertEqual(len(values), len(dates), field)
                if field != "dates":
                    self.assertTrue(all(value is None or isinstance(value, (int, float)) for value in values))
        self.history("ALL")
        for chart in CHARTS:
            visible = self.view(chart)
            self.assertEqual(visible["dates"], dates)
            self.assertEqual(visible["start"], 0)
            self.assertEqual(visible["end"], len(dates))
            self.assertEqual(int(self.page.locator(f"#{chart}").get_attribute("data-count")), len(dates))
        self.assertEqual(self.page.evaluate("window.IHSG_PUBLIC_DATA"), data)

    def test_coverage_exact_counts_and_genuine_nonzero_dips(self):
        data = self.payload
        self.history("ALL")
        expected = []
        for target, eligible, coverage in zip(data["target"], data["eligible"], data["coverage"]):
            self.assertTrue(isinstance(target, (int, float)) and float(target).is_integer())
            self.assertTrue(isinstance(eligible, (int, float)) and float(eligible).is_integer())
            self.assertGreater(target, 0)
            self.assertGreater(eligible, 0, "Public source contains a false-zero coverage row")
            self.assertLessEqual(eligible, target)
            calculated = 100 * eligible / target
            self.assertAlmostEqual(coverage, calculated, delta=1e-6)
            expected.append(calculated)
        visible = self.view("coverageChart")
        self.assert_series(visible["raw"], expected)
        self.assert_series(visible["smoothed"], expected)
        minimum = min(range(len(expected)), key=expected.__getitem__)
        self.assertGreater(expected[minimum], 0)
        self.assertLess(expected[minimum], 95)
        box = self.plot("coverageChart")
        self.page.mouse.move(box["x"] + box["width"] * minimum / (len(expected) - 1), box["y"] + box["height"] / 2)
        text = self.page.locator("#coverageTip").inner_text()
        self.assertIn(data["dates"][minimum], text)
        self.assertIn(f'Valid {data["eligible"][minimum]:g} / target {data["target"][minimum]:g}', text)
        self.assertIn("Incomplete observations", text)

    def test_zoom_buttons_are_independent_and_respect_bounds(self):
        self.history("ALL")
        full = self.counts()
        for chart in CHARTS:
            with self.subTest(chart=chart):
                self.assertTrue(self.button(chart, "out").is_disabled())
                self.assertTrue(self.button(chart, "reset").is_disabled())
                before = self.view(chart)
                self.button(chart, "in").click()
                zoomed = self.view(chart)
                self.assertGreaterEqual(zoomed["count"], 5)
                self.assertLess(zoomed["count"], before["count"])
                self.assert_slice(before, zoomed)
                for other in CHARTS:
                    if other != chart:
                        self.assertEqual(self.counts()[other], full[other])
                self.button(chart, "out").click()
                self.assertEqual(self.counts(), full)
                for _ in range(20):
                    if self.button(chart, "in").is_disabled():
                        break
                    self.button(chart, "in").click()
                self.assertEqual(self.view(chart)["count"], 5)
                self.assertTrue(self.button(chart, "in").is_disabled())
                self.assertTrue(self.button(chart, "reset").is_enabled())
                status = self.page.locator(f"#{chart}Range").inner_text()
                self.assertIn(self.view(chart)["dates"][0], status)
                self.assertIn(self.view(chart)["dates"][-1], status)
                self.assertIn("5 sessions", status)
                self.button(chart, "reset").click()
                self.assertEqual(self.counts(), full)

    def test_history_presets_reset_every_chart_and_bound_zoom_out(self):
        previous = 0
        for preset in ("6M", "1Y", "3Y", "5Y", "ALL"):
            with self.subTest(preset=preset):
                self.history(preset)
                counts = self.counts()
                self.assertEqual(len(set(counts.values())), 1)
                self.assertGreater(counts[CHARTS[0]], previous)
                previous = counts[CHARTS[0]]
                for chart in CHARTS:
                    base = self.view(chart)
                    self.assertEqual(base["dates"][-1], self.payload["dates"][-1])
                    self.button(chart, "in").click()
                    self.button(chart, "out").click()
                    self.assertEqual(self.view(chart), base)
                    self.assertTrue(self.button(chart, "out").is_disabled())
                    self.button(chart, "in").click()
                self.history(preset)
                self.assertEqual(self.counts(), counts)

    def test_ctrl_wheel_zooms_once_after_redraws_and_plain_wheel_scrolls(self):
        self.history("ALL")
        # Metric/theme redraws must not attach duplicate SVG listeners.
        for _ in range(3):
            self.page.locator('.metric[data-metric="ma"]').click()
            self.page.locator('.metric[data-metric="macd"]').click()
            self.page.locator("#themeBtn").click()
        for chart in CHARTS:
            with self.subTest(chart=chart):
                before = self.view(chart)
                others = self.counts()
                box = self.plot(chart)
                self.page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                scroll_before = self.page.evaluate("scrollY")
                self.page.mouse.wheel(0, 180)
                self.page.wait_for_function("old => scrollY > old", arg=scroll_before)
                self.assertEqual(self.view(chart), before)
                box = self.plot(chart)
                self.page.mouse.move(box["x"] + box["width"] * .65, box["y"] + box["height"] / 2)
                self.page.keyboard.down("Control")
                self.page.mouse.wheel(0, -180)
                self.page.keyboard.up("Control")
                self.page.wait_for_function("args => window.__IHSG_TEST__.getView(args.id).count < args.old", arg={"id": chart, "old": before["count"]})
                after = self.view(chart)
                self.assertEqual(after["count"], math.floor(before["count"] * .8 + .5))
                self.assert_slice(before, after)
                for other in CHARTS:
                    if other != chart:
                        self.assertEqual(self.counts()[other], others[other])

    def test_drag_selection_zooms_to_aligned_inclusive_sessions(self):
        self.history("ALL")
        for chart in CHARTS:
            with self.subTest(chart=chart):
                before = self.view(chart)
                box = self.plot(chart)
                y = box["y"] + box["height"] * .4
                self.page.mouse.move(box["x"] + box["width"] * .2, y)
                self.page.mouse.down()
                self.page.mouse.move(box["x"] + box["width"] * .7, y, steps=5)
                self.assertEqual(self.page.locator(f"#{chart} .zoom-selection").count(), 1)
                self.page.mouse.up()
                after = self.view(chart)
                self.assertLess(after["count"], before["count"])
                self.assertGreaterEqual(after["count"], 5)
                self.assert_slice(before, after)
                self.assertEqual(after["count"], after["end"] - after["start"])
                self.assertEqual(self.page.locator(f"#{chart} .zoom-selection").count(), 0)
                self.screenshot(f"zoom-{chart}")

    def test_cancel_and_lost_capture_leave_no_selection_or_range_change(self):
        self.history("ALL")
        for chart in CHARTS:
            for cancel in ("cancel", "lostcapture"):
                with self.subTest(chart=chart, cancellation=cancel):
                    before = self.view(chart)
                    box = self.plot(chart)
                    self.page.locator(f"#{chart}").evaluate("el => el.addEventListener('pointerdown', ev => window.__pointerId = ev.pointerId, {once:true})")
                    y = box["y"] + box["height"] / 2
                    self.page.mouse.move(box["x"] + box["width"] * .3, y)
                    self.page.mouse.down()
                    self.page.mouse.move(box["x"] + box["width"] * .6, y, steps=3)
                    self.assertEqual(self.page.locator(f"#{chart} .zoom-selection").count(), 1)
                    if cancel == "cancel":
                        self.page.locator(f"#{chart}").evaluate("el => el.dispatchEvent(new PointerEvent('pointercancel', {pointerId:window.__pointerId, bubbles:true}))")
                    else:
                        self.page.locator(f"#{chart}").evaluate("el => el.releasePointerCapture(window.__pointerId)")
                        self.page.mouse.move(box["x"] + box["width"] * .65, y)
                    self.page.mouse.up()
                    self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                    self.assertEqual(self.page.locator(f"#{chart} .zoom-selection").count(), 0)
                    self.assertEqual(self.view(chart), before)

    def test_smoothing_uses_full_history_before_viewport_slicing(self):
        for chart, source, type_id, length_id, apply_id in (
            ("combinedChart", "macd", "smoothType", "smoothN", "applySmooth"),
            ("volumeChart", "volume_index", "volSmoothType", "volSmoothN", "applyVolSmooth"),
        ):
            for method in ("SMA", "EMA"):
                with self.subTest(chart=chart, method=method):
                    self.history("ALL")
                    self.page.locator(f"#{type_id}").select_option(method)
                    self.page.locator(f"#{length_id}").fill("50")
                    self.page.locator(f"#{apply_id}").click()
                    reference = moving_average(self.payload[source], 50, method)
                    full = self.view(chart)
                    self.assert_series(full["smoothed"], reference)
                    self.button(chart, "in").click()
                    zoomed = self.view(chart)
                    self.assert_slice(full, zoomed)
                    self.assertGreater(zoomed["start"], 50)
                    self.assert_series(zoomed["smoothed"], reference[zoomed["start"] : zoomed["end"]])
                    if method == "SMA":
                        self.assertIsNotNone(zoomed["smoothed"][0], "Zoom discarded pre-window SMA warmup")

    def test_metric_benchmark_and_volume_switches_preserve_selected_window(self):
        self.history("ALL")
        self.button("combinedChart", "in").click()
        selected = self.view("combinedChart")
        for metric in ("macd", "ma", "st", "composite"):
            self.page.locator(f'.metric[data-metric="{metric}"]').click()
            actual = self.view("combinedChart")
            self.assertEqual((actual["start"], actual["end"]), (selected["start"], selected["end"]))
            self.assertEqual(actual["raw"], self.payload[metric][actual["start"] : actual["end"]])
        for button, source in (("retBtn", "ihsg_1y"), ("absBtn", "ihsg")):
            self.page.locator(f"#{button}").click()
            actual = self.view("combinedChart")
            self.assertEqual(actual["benchmark"], self.payload[source][actual["start"] : actual["end"]])
            self.assertEqual(actual["dates"], selected["dates"])
        self.button("volumeChart", "in").click()
        selected = self.view("volumeChart")
        for mode, source in (("activity", "volume_index"), ("balance", "volume_balance"), ("spike", "volume_spike")):
            self.page.locator(f'.volume-mode[data-volume="{mode}"]').click()
            actual = self.view("volumeChart")
            self.assertEqual(actual["dates"], selected["dates"])
            self.assertEqual(actual["raw"], self.payload[source][actual["start"] : actual["end"]])

    def test_missing_volume_gaps_break_paths_and_series_are_clipped(self):
        self.history("ALL")
        self.page.locator('.volume-mode[data-volume="balance"]').click()
        visible = self.view("volumeChart")
        self.assertEqual(visible["raw"], self.payload["volume_balance"])
        self.assertGreater(visible["raw"].count(None), 0)
        self.assert_series(visible["smoothed"], moving_average(visible["raw"], 3, "SMA"))
        runs = sum(value is not None and (index == 0 or visible["raw"][index - 1] is None) for index, value in enumerate(visible["raw"]))
        path = self.page.locator("#volumeChart path.raw").get_attribute("d")
        self.assertEqual(path.count("M"), runs, "Path bridged missing volume observations")
        for chart in CHARTS:
            self.assertEqual(self.page.locator(f"#{chart} g[clip-path]").count(), 1)
            self.assertEqual(self.page.locator(f"#{chart} clipPath rect").count(), 1)
            for path in self.page.locator(f"#{chart} path").all():
                self.assertNotIn("NaN", path.get_attribute("d"))
                self.assertNotIn("Infinity", path.get_attribute("d"))

    def test_responsive_controls_do_not_overlap_or_overflow(self):
        for width in (320, 390, 768, 1440, 1920):
            with self.subTest(width=width):
                self.page.set_viewport_size({"width": width, "height": 1080})
                self.assertFalse(self.page.evaluate("document.documentElement.scrollWidth > innerWidth"))
                rectangles = self.page.locator(".chart-controls button, .chart-controls input, .chart-controls select").evaluate_all("elements => elements.map(el => { const r=el.getBoundingClientRect(); return {text:el.textContent||el.id,x:r.x,y:r.y,width:r.width,height:r.height}; })")
                for rect in rectangles:
                    self.assertGreaterEqual(rect["x"], 0, rect)
                    self.assertLessEqual(rect["x"] + rect["width"], width + 1, rect)
                for index, left in enumerate(rectangles):
                    for right in rectangles[index + 1 :]:
                        overlap_x = min(left["x"] + left["width"], right["x"] + right["width"]) - max(left["x"], right["x"])
                        overlap_y = min(left["y"] + left["height"], right["y"] + right["height"]) - max(left["y"], right["y"])
                        self.assertFalse(overlap_x > 1 and overlap_y > 1, (left, right))
                self.screenshot(f"layout-{width}")

    def test_tooltips_fit_mobile_charts_and_hide_after_redraw(self):
        for width in (320, 390, 768):
            self.page.set_viewport_size({"width": width, "height": 900})
            for chart in CHARTS:
                with self.subTest(width=width, chart=chart):
                    for fraction in (.01, .99):
                        box = self.plot(chart)
                        self.page.mouse.move(box["x"] + box["width"] * fraction, box["y"] + box["height"] * .5)
                        tip = self.page.locator(f'#{chart.replace("Chart", "Tip")}')
                        self.assertTrue(tip.is_visible())
                        tip_box = tip.bounding_box()
                        wrap_box = self.page.locator(f"#{chart}").bounding_box()
                        self.assertGreaterEqual(tip_box["x"], wrap_box["x"] - 1)
                        self.assertLessEqual(tip_box["x"] + tip_box["width"], wrap_box["x"] + wrap_box["width"] + 1)
                        self.assertGreaterEqual(tip_box["y"], wrap_box["y"] - 1)
                        self.assertLessEqual(tip_box["y"] + tip_box["height"], wrap_box["y"] + wrap_box["height"] + 1)
                    self.button(chart, "in").click()
                    self.assertFalse(tip.is_visible(), "Redraw retained a stale tooltip")

    def test_defaults_theme_and_keyboard_zoom(self):
        self.assertEqual(self.page.locator(".range.active").get_attribute("data-range"), "1Y")
        self.assertEqual(self.page.locator("#smoothType").input_value(), "EMA")
        self.assertEqual(self.page.locator("#smoothN").input_value(), "10")
        self.assertEqual(self.page.locator("#volSmoothType").input_value(), "SMA")
        self.assertEqual(self.page.locator("#volSmoothN").input_value(), "3")
        self.assertEqual(self.page.locator(".volume-mode.active").get_attribute("data-volume"), "activity")
        before = {chart: self.view(chart) for chart in CHARTS}
        self.page.locator("#themeBtn").click()
        self.assertIn("dark", self.page.locator("body").get_attribute("class"))
        self.assertEqual({chart: self.view(chart) for chart in CHARTS}, before)
        self.screenshot("dark-1920")
        self.page.locator("#themeBtn").click()
        self.assertNotIn("dark", self.page.locator("body").get_attribute("class") or "")
        for chart in CHARTS:
            self.button(chart, "in").focus()
            self.page.keyboard.press("Enter")
            self.assertLess(self.view(chart)["count"], before[chart]["count"])


if __name__ == "__main__":
    unittest.main()
