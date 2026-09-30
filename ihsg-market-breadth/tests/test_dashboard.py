"""Offline regressions for the shipped aggregate dashboard.

Run: python -m unittest discover -s ihsg-market-breadth/tests -v
Install playwright==1.63.0 and its Chromium, or set IHSG_BROWSER to a browser path.
IHSG_SCREENSHOT_DIR optionally saves responsive previews outside the checkout.
No providers, credentials, or external web resources are used.
"""

from __future__ import annotations

import json
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


def moving_average(values, length, method, observed=False):
    """Independent reference; optional balance smoothing uses finite observations."""
    result = []
    previous = None
    observations = []
    for index, value in enumerate(values):
        if observed and value is None:
            result.append(None)
            continue
        if observed:
            observations.append(value)
        if method == "EMA":
            if value is None:
                previous = None
            elif previous is None:
                previous = value
            else:
                previous += 2 / (length + 1) * (value - previous)
            result.append(previous)
        else:
            window = observations[-length:] if observed else values[max(0, index - length + 1) : index + 1]
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

    def point(self, chart, fraction=.5, height=.5):
        """Map the actual SVG plot through its CTM, including letterboxing."""
        element = self.page.locator(f"#{chart} .plot-hit-area")
        element.scroll_into_view_if_needed()
        return element.evaluate("""(el, fractions) => {
            const box = el.getBBox();
            const point = new DOMPoint(
                box.x + box.width * fractions[0],
                box.y + box.height * fractions[1]
            ).matrixTransform(el.getScreenCTM());
            return {x:point.x, y:point.y};
        }""", [fraction, height])

    def settle(self):
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")

    def wheel(self, chart, delta=-180, control=False, fraction=.5, expect_change=True):
        before = self.view(chart)["count"]
        point = self.point(chart, fraction)
        self.page.mouse.move(point["x"], point["y"])
        if control:
            self.page.keyboard.down("Control")
        try:
            self.page.mouse.wheel(0, delta)
        finally:
            if control:
                self.page.keyboard.up("Control")
        if expect_change:
            self.page.wait_for_function(
                "args => window.__IHSG_TEST__.getView(args.id).count !== args.old",
                arg={"id": chart, "old": before},
                timeout=3000,
            )
        self.settle()
        return self.view(chart)

    def drag(self, chart, start=.2, end=.7):
        first = self.point(chart, start, .4)
        last = self.point(chart, end, .4)
        self.page.mouse.move(first["x"], first["y"])
        self.page.mouse.down()
        self.page.mouse.move(last["x"], last["y"], steps=5)
        self.assertEqual(self.page.locator(f"#{chart} .zoom-selection").count(), 1)
        self.page.mouse.up()
        self.settle()
        self.assertEqual(self.page.locator(f"#{chart} .zoom-selection").count(), 0)
        return self.view(chart)

    def domain(self, chart, kind="y"):
        element = self.page.locator(f"#{chart}")
        low = float(element.get_attribute(f"data-{kind}-min"))
        high = float(element.get_attribute(f"data-{kind}-max"))
        self.assertTrue(low < high)
        return low, high

    def assert_domain_contains(self, domain, values):
        low, high = domain
        observed = [value for value in values if value is not None]
        for value in observed:
            self.assertGreaterEqual(value, low - 1e-8)
            self.assertLessEqual(value, high + 1e-8)

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
        point = self.point("coverageChart", minimum / (len(expected) - 1))
        self.page.mouse.move(point["x"], point["y"])
        text = self.page.locator("#coverageTip").inner_text()
        self.assertIn(data["dates"][minimum], text)
        self.assertIn(f'Valid {data["eligible"][minimum]:g} / target {data["target"][minimum]:g}', text)
        self.assertIn("Incomplete observations", text)

    def test_scroll_zoom_is_independent_and_respects_bounds(self):
        self.history("ALL")
        full = self.counts()
        self.assertEqual(self.page.locator('.zoom-control[data-zoom="in"], .zoom-control[data-zoom="out"]').count(), 0)
        for chart in CHARTS:
            with self.subTest(chart=chart):
                self.assertTrue(self.button(chart, "reset").is_disabled())
                before = self.view(chart)
                zoomed = self.wheel(chart)
                self.assertGreaterEqual(zoomed["count"], 5)
                self.assertLess(zoomed["count"], before["count"])
                self.assert_slice(before, zoomed)
                for other in CHARTS:
                    if other != chart:
                        self.assertEqual(self.counts()[other], full[other])
                # Equal wheel distances are reciprocal, within integer rounding.
                self.wheel(chart, 180)
                if self.view(chart)["count"] < full[chart]:
                    self.wheel(chart, 180)
                self.assertEqual(self.counts(), full)
                for _ in range(50):
                    if self.view(chart)["count"] == 5:
                        break
                    self.wheel(chart, -400)
                self.assertEqual(self.view(chart)["count"], 5)
                bounded = self.view(chart)
                self.wheel(chart, -400, expect_change=False)
                self.assertEqual(self.view(chart), bounded)
                self.assertTrue(self.button(chart, "reset").is_enabled())
                status = self.page.locator(f"#{chart}Range").inner_text()
                self.assertIn(self.view(chart)["dates"][0], status)
                self.assertIn(self.view(chart)["dates"][-1], status)
                self.assertIn("5 sessions", status)
                self.button(chart, "reset").click()
                self.assertEqual(self.counts(), full)

    def test_tiny_trackpad_deltas_accumulate_at_minimum_without_stale_direction(self):
        self.history("ALL")
        for chart in CHARTS:
            with self.subTest(chart=chart):
                self.page.locator(f"#{chart}").focus()
                for _ in range(20):
                    self.page.keyboard.press("+")
                self.assertEqual(self.view(chart)["count"], 5)
                for _ in range(12):
                    self.wheel(chart, 10, expect_change=False)
                    if self.view(chart)["count"] > 5:
                        break
                self.assertGreater(self.view(chart)["count"], 5, "Small trackpad deltas could not zoom out at the minimum")
                self.wheel(chart, -400)
                self.assertEqual(self.view(chart)["count"], 5)
                for _ in range(3):
                    self.wheel(chart, -10, expect_change=False)
                for _ in range(12):
                    self.wheel(chart, 10, expect_change=False)
                    if self.view(chart)["count"] > 5:
                        break
                self.assertGreater(self.view(chart)["count"], 5, "Opposite wheel direction kept stale bounded deltas")
                self.button(chart, "reset").click()
                full = self.view(chart)["count"]
                for _ in range(3):
                    self.wheel(chart, 10, expect_change=False)
                self.assertEqual(self.view(chart)["count"], full)
                self.wheel(chart, -10)
                self.assertLess(self.view(chart)["count"], full)

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
                    self.wheel(chart)
                    self.wheel(chart, 180)
                    if self.view(chart)["count"] < base["count"]:
                        self.wheel(chart, 180)
                    self.assertEqual(self.view(chart), base)
                    self.assertTrue(self.button(chart, "reset").is_disabled())
                    self.wheel(chart)
                self.history(preset)
                self.assertEqual(self.counts(), counts)

    def test_plain_and_ctrl_wheel_zoom_actual_plots_at_all_sizes(self):
        self.history("ALL")
        for width in (375, 768, 1440, 1920):
            self.page.set_viewport_size({"width": width, "height": 1080})
            for chart in CHARTS:
                for control in (False, True):
                    with self.subTest(width=width, chart=chart, control=control):
                        self.history("ALL")
                        before = self.view(chart)
                        others = self.counts()
                        self.point(chart, .65)
                        scroll_before = self.page.evaluate("scrollY")
                        after = self.wheel(chart, control=control, fraction=.65)
                        self.assertLess(after["count"], before["count"])
                        self.assert_slice(before, after)
                        self.assertAlmostEqual(self.page.evaluate("scrollY"), scroll_before, delta=1)
                        self.assertEqual(self.page.evaluate("visualViewport.scale"), 1)
                        for other in CHARTS:
                            if other != chart:
                                self.assertEqual(self.counts()[other], others[other])

    def test_wheel_outside_actual_plot_preserves_page_scrolling(self):
        self.history("ALL")
        for width in (375, 768, 1440, 1920):
            self.page.set_viewport_size({"width": width, "height": 1080})
            for chart in CHARTS:
                with self.subTest(width=width, chart=chart):
                    before = self.view(chart)
                    point = self.point(chart, .5, -.03)
                    self.assertGreater(self.page.evaluate("scrollY"), 0)
                    self.page.mouse.move(point["x"], point["y"])
                    scroll_before = self.page.evaluate("scrollY")
                    self.page.mouse.wheel(0, -180)
                    self.page.wait_for_function("old => scrollY < old", arg=scroll_before)
                    self.assertEqual(self.view(chart), before)

    def test_redraws_do_not_accumulate_wheel_listeners(self):
        self.history("ALL")
        for chart in CHARTS:
            self.wheel(chart, fraction=.65)
        baseline = {chart: self.view(chart) for chart in CHARTS}
        self.history("ALL")
        for _ in range(3):
            self.page.locator('.metric[data-metric="ma"]').click()
            self.page.locator('.metric[data-metric="macd"]').click()
            self.page.locator("#themeBtn").click()
        for chart in CHARTS:
            self.wheel(chart, fraction=.65)
            self.assertEqual(self.view(chart), baseline[chart])

    def test_drag_selection_zooms_to_aligned_inclusive_sessions(self):
        self.history("ALL")
        for chart in CHARTS:
            with self.subTest(chart=chart):
                before = self.view(chart)
                after = self.drag(chart)
                self.assertLess(after["count"], before["count"])
                self.assertGreaterEqual(after["count"], 5)
                self.assert_slice(before, after)
                self.assertEqual(after["count"], after["end"] - after["start"])
                self.assertEqual(after["start"], round(.2 * (before["count"] - 1)))
                self.assertEqual(after["end"], round(.7 * (before["count"] - 1)) + 1)
                self.screenshot(f"zoom-{chart}")

    def test_cancel_and_lost_capture_leave_no_selection_or_range_change(self):
        self.history("ALL")
        for chart in CHARTS:
            for cancel in ("cancel", "lostcapture"):
                with self.subTest(chart=chart, cancellation=cancel):
                    before = self.view(chart)
                    first = self.point(chart, .3)
                    last = self.point(chart, .6)
                    self.page.locator(f"#{chart}").evaluate("el => el.addEventListener('pointerdown', ev => window.__pointerId = ev.pointerId, {once:true})")
                    self.page.mouse.move(first["x"], first["y"])
                    self.page.mouse.down()
                    self.page.mouse.move(last["x"], last["y"], steps=3)
                    self.assertEqual(self.page.locator(f"#{chart} .zoom-selection").count(), 1)
                    if cancel == "cancel":
                        self.page.locator(f"#{chart}").evaluate("el => el.dispatchEvent(new PointerEvent('pointercancel', {pointerId:window.__pointerId, bubbles:true}))")
                    else:
                        self.page.locator(f"#{chart}").evaluate("el => el.releasePointerCapture(window.__pointerId)")
                        point = self.point(chart, .65)
                        self.page.mouse.move(point["x"], point["y"])
                    self.page.mouse.up()
                    self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                    self.assertEqual(self.page.locator(f"#{chart} .zoom-selection").count(), 0)
                    self.assertEqual(self.view(chart), before)

    def test_transformed_mobile_svg_pointer_and_wheel_geometry(self):
        self.page.set_viewport_size({"width": 375, "height": 1080})
        self.history("ALL")
        for chart in CHARTS:
            with self.subTest(chart=chart):
                # The native aspect-ratio transform introduces empty SVG space.
                self.page.locator(f"#{chart}").evaluate("el => el.setAttribute('preserveAspectRatio', 'xMidYMid meet')")
                before = self.view(chart)
                after = self.drag(chart, .2, .7)
                self.assertEqual(after["start"], round(.2 * (before["count"] - 1)))
                self.assertEqual(after["end"], round(.7 * (before["count"] - 1)) + 1)
                self.assert_slice(before, after)
                self.button(chart, "reset").click()
                self.wheel(chart, control=True, fraction=.75)
                self.assertLess(self.view(chart)["count"], before["count"])
                self.assertGreater(self.view(chart)["start"], 0)
                self.button(chart, "reset").click()
                # Wheel in the letterbox scrolls the page without zooming.
                box = self.page.locator(f"#{chart}").bounding_box()
                self.page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 2)
                scroll_before = self.page.evaluate("scrollY")
                self.page.mouse.wheel(0, -180)
                self.page.wait_for_function("old => scrollY < old", arg=scroll_before)
                self.assertEqual(self.view(chart), before)

    def test_visible_data_adjusts_both_combined_axes_and_reset_restores_domain(self):
        self.history("ALL")
        full_domain = self.domain("combinedChart")
        self.assertEqual(full_domain, (0, 100))
        for mode, field in (("absBtn", "ihsg"), ("retBtn", "ihsg_1y")):
            with self.subTest(mode=mode):
                self.history("ALL")
                self.page.locator(f"#{mode}").click()
                original_benchmark = self.domain("combinedChart", "benchmark")
                zoomed = self.drag("combinedChart", .99, 1)
                primary = self.domain("combinedChart")
                benchmark = self.domain("combinedChart", "benchmark")
                self.assertLess(primary[1] - primary[0], 100)
                self.assertLess(benchmark[1] - benchmark[0], original_benchmark[1] - original_benchmark[0])
                self.assert_domain_contains(primary, zoomed["raw"] + zoomed["smoothed"])
                self.assert_domain_contains(benchmark, zoomed["benchmark"])
                self.assertEqual(zoomed["benchmark"], self.payload[field][zoomed["start"] : zoomed["end"]])
                self.button("combinedChart", "reset").click()
                self.assertEqual(self.domain("combinedChart"), full_domain)
                self.assertEqual(self.domain("combinedChart", "benchmark"), original_benchmark)

    def test_each_volume_mode_and_coverage_adjust_visible_scale(self):
        for mode in ("activity", "balance", "spike"):
            with self.subTest(mode=mode):
                self.history("ALL")
                self.page.locator(f'.volume-mode[data-volume="{mode}"]').click()
                original = self.domain("volumeChart")
                zoomed = self.drag("volumeChart", .97, 1)
                adjusted = self.domain("volumeChart")
                self.assertLess(adjusted[1] - adjusted[0], original[1] - original[0])
                self.assert_domain_contains(adjusted, zoomed["raw"] + zoomed["smoothed"])
                self.button("volumeChart", "reset").click()
                self.assertEqual(self.domain("volumeChart"), original)
        self.history("ALL")
        self.assertEqual(self.domain("coverageChart"), (0, 100))
        zoomed = self.drag("coverageChart", .97, 1)
        adjusted = self.domain("coverageChart")
        self.assertGreater(adjusted[0], 0)
        self.assertLess(adjusted[1] - adjusted[0], 100)
        self.assert_domain_contains(adjusted, zoomed["raw"])
        self.button("coverageChart", "reset").click()
        self.assertEqual(self.domain("coverageChart"), (0, 100))

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
                    zoomed = self.wheel(chart)
                    self.assert_slice(full, zoomed)
                    self.assertGreater(zoomed["start"], 50)
                    self.assert_series(zoomed["smoothed"], reference[zoomed["start"] : zoomed["end"]])
                    if method == "SMA":
                        self.assertIsNotNone(zoomed["smoothed"][0], "Zoom discarded pre-window SMA warmup")

    def test_metric_benchmark_and_volume_switches_preserve_selected_window(self):
        self.history("ALL")
        self.wheel("combinedChart")
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
        self.wheel("volumeChart")
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
        self.assert_series(visible["smoothed"], moving_average(visible["raw"], 3, "SMA", observed=True))
        runs = sum(value is not None and (index == 0 or visible["raw"][index - 1] is None) for index, value in enumerate(visible["raw"]))
        path = self.page.locator("#volumeChart path.raw").get_attribute("d")
        self.assertEqual(path.count("M"), runs, "Path bridged missing volume observations")
        for chart in CHARTS:
            self.assertEqual(self.page.locator(f"#{chart} g[clip-path]").count(), 1)
            self.assertEqual(self.page.locator(f"#{chart} clipPath rect").count(), 1)
            for path in self.page.locator(f"#{chart} path").all():
                self.assertNotIn("NaN", path.get_attribute("d"))
                self.assertNotIn("Infinity", path.get_attribute("d"))

    def test_balance_smoothing_resumes_at_next_real_observation(self):
        self.history("ALL")
        self.page.locator('.volume-mode[data-volume="balance"]').click()
        self.page.locator("#volSmoothN").fill("50")
        source = self.payload["volume_balance"]
        recent_start = next(index for index, date in enumerate(self.payload["dates"]) if date >= "2023-01-01")
        # The legacy 50-calendar-slot rule hid 289 sessions after sparse holes.
        legacy = moving_average(source, 50, "SMA")
        recent_missing = source[recent_start:].count(None)
        self.assertGreaterEqual(legacy[recent_start:].count(None), recent_missing)
        frozen_checkpoint = self.payload["meta"]["source_sha"] == "5e030093c66215dfed8f5eb60276f1fcdb3033ed" and self.payload["dates"][-1] == "2026-09-29"
        if frozen_checkpoint:
            self.assertEqual(legacy[recent_start:].count(None), 289)
            self.assertEqual(recent_missing, 18)
        for method in ("SMA", "EMA"):
            with self.subTest(method=method):
                self.page.locator("#volSmoothType").select_option(method)
                self.page.locator("#applyVolSmooth").click()
                visible = self.view("volumeChart")
                expected = moving_average(source, 50, method, observed=True)
                self.assertEqual(visible["raw"], source, "Raw directional balance changed")
                self.assert_series(visible["smoothed"], expected)
                self.assertEqual(visible["smoothed"][recent_start:].count(None), recent_missing)
                for index in range(recent_start, len(source)):
                    if source[index] is None:
                        self.assertIsNone(visible["smoothed"][index], "Smoothed line filled a real missing observation")
                    else:
                        self.assertIsNotNone(visible["smoothed"][index], "A valid session after a hole remained hidden")
                self.wheel("volumeChart")
                self.assert_slice(visible, self.view("volumeChart"))
                self.button("volumeChart", "reset").click()
                if method == "SMA" and frozen_checkpoint:
                    july = self.payload["dates"].index("2023-07-03")
                    self.assertAlmostEqual(visible["smoothed"][july], 1.51823432, places=7)
                    self.assertAlmostEqual(visible["smoothed"][-1], 10.37746432, places=7)
        self.assertEqual(self.page.evaluate("window.IHSG_PUBLIC_DATA"), self.payload)

    def test_help_dialogs_explain_volume_modes_and_coverage_terms(self):
        self.page.locator("#volumeHelpBtn").click()
        dialog = self.page.locator("#volumeHelpDialog")
        self.assertTrue(dialog.is_visible())
        self.assertEqual(dialog.locator(".help-definition h3").all_text_contents(), ["Activity", "Directional balance", "High-volume breadth"])
        text = dialog.inner_text()
        for term in ("100", "+100", "−100", "1.5", "20"):
            self.assertIn(term, text)
        self.assertNotIn("above-normal portion", text, "Balance explanation wrongly excludes ordinary RVOL weights")
        dialog.locator(".dialog-close").click()
        self.page.locator("#coverageHelpBtn").click()
        dialog = self.page.locator("#coverageHelpDialog")
        text = dialog.inner_text()
        self.assertIn("Target stocks (warmed up)", text)
        self.assertIn("Valid stocks", text)
        self.assertIn("350", text)
        for value in ("810", "900", "90%"):
            self.assertIn(value, text)
        self.assertIn("MACD", text)
        self.assertIn("MA100", text)
        self.assertIn("Supertrend", text)
        self.page.keyboard.press("Escape")
        self.assertFalse(dialog.is_visible())

    def test_help_dialogs_keyboard_escape_backdrop_and_focus_return(self):
        for opener, dialog_id in (("volumeHelpBtn", "volumeHelpDialog"), ("coverageHelpBtn", "coverageHelpDialog")):
            with self.subTest(dialog=dialog_id):
                button = self.page.locator(f"#{opener}")
                dialog = self.page.locator(f"#{dialog_id}")
                button.focus()
                self.page.keyboard.press("Enter")
                self.assertTrue(dialog.is_visible())
                self.assertEqual(self.page.evaluate("document.activeElement.closest('dialog').id"), dialog_id)
                for _ in range(6):
                    self.page.keyboard.press("Tab")
                    # Native dialogs may hand focus to browser chrome (BODY),
                    # but must never activate a control on the inert page.
                    self.assertTrue(self.page.evaluate("id => document.activeElement === document.body || !!document.activeElement.closest('#' + id)", dialog_id))
                self.page.keyboard.press("Escape")
                self.assertFalse(dialog.is_visible())
                self.assertTrue(button.evaluate("el => document.activeElement === el"))
                button.click()
                dialog.locator(".dialog-close").click()
                self.assertTrue(button.evaluate("el => document.activeElement === el"))
                button.click()
                box = dialog.bounding_box()
                self.page.mouse.click(max(1, box["x"] - 4), box["y"] + box["height"] / 2)
                self.assertFalse(dialog.is_visible())
                self.assertTrue(button.evaluate("el => document.activeElement === el"))

    def test_help_dialogs_fit_mobile_and_dark_theme(self):
        for width in (320, 375, 768, 1440, 1920):
            self.page.set_viewport_size({"width": width, "height": 900})
            for dark in (False, True):
                currently_dark = "dark" in (self.page.locator("body").get_attribute("class") or "")
                if currently_dark != dark:
                    self.page.locator("#themeBtn").click()
                for opener, dialog_id in (("volumeHelpBtn", "volumeHelpDialog"), ("coverageHelpBtn", "coverageHelpDialog")):
                    with self.subTest(width=width, dark=dark, dialog=dialog_id):
                        self.page.locator(f"#{opener}").click()
                        dialog = self.page.locator(f"#{dialog_id}")
                        box = dialog.bounding_box()
                        self.assertGreaterEqual(box["x"], 0)
                        self.assertGreaterEqual(box["y"], 0)
                        self.assertLessEqual(box["x"] + box["width"], width + 1)
                        self.assertLessEqual(box["y"] + box["height"], 901)
                        self.assertFalse(dialog.evaluate("el => el.scrollWidth > el.clientWidth"))
                        self.screenshot(f"help-{dialog_id}-{width}-{'dark' if dark else 'light'}")
                        self.page.keyboard.press("Escape")

    def test_responsive_controls_do_not_overlap_or_overflow(self):
        for width in (320, 375, 390, 768, 1440, 1920):
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
                        point = self.point(chart, fraction)
                        self.page.mouse.move(point["x"], point["y"])
                        tip = self.page.locator(f'#{chart.replace("Chart", "Tip")}')
                        self.assertTrue(tip.is_visible())
                        tip_box = tip.bounding_box()
                        wrap_box = self.page.locator(f"#{chart}").bounding_box()
                        self.assertGreaterEqual(tip_box["x"], wrap_box["x"] - 1)
                        self.assertLessEqual(tip_box["x"] + tip_box["width"], wrap_box["x"] + wrap_box["width"] + 1)
                        self.assertGreaterEqual(tip_box["y"], wrap_box["y"] - 1)
                        self.assertLessEqual(tip_box["y"] + tip_box["height"], wrap_box["y"] + wrap_box["height"] + 1)
                    self.page.locator(f"#{chart}").focus()
                    self.page.keyboard.press("+")
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
            self.page.locator(f"#{chart}").focus()
            self.page.keyboard.press("+")
            self.assertLess(self.view(chart)["count"], before[chart]["count"])
            self.page.keyboard.press("Home")
            self.assertEqual(self.view(chart), before[chart])

    def test_click_plot_focuses_keyboard_zoom_and_home_resets(self):
        self.history("ALL")
        for chart in CHARTS:
            with self.subTest(chart=chart):
                before = self.view(chart)
                point = self.point(chart)
                self.page.mouse.click(point["x"], point["y"])
                self.assertEqual(self.page.evaluate("document.activeElement.id"), chart)
                self.page.keyboard.press("+")
                self.assertLess(self.view(chart)["count"], before["count"])
                self.page.keyboard.press("-")
                self.assertEqual(self.view(chart), before)
                self.page.keyboard.press("+")
                self.page.keyboard.press("Home")
                self.assertEqual(self.view(chart), before)

    def test_constant_extreme_and_missing_volume_windows_have_safe_scales(self):
        fixtures = (
            {"volume_index": 0, "volume_balance": None, "volume_spike": 0},
            {"volume_index": 100, "volume_balance": 0, "volume_spike": 0},
            {"volume_index": 500, "volume_balance": 100, "volume_spike": 100},
            {"volume_index": None, "volume_balance": None, "volume_spike": None},
        )
        for values in fixtures:
            with self.subTest(values=values):
                fixture = dict(self.payload)
                for field, value in values.items():
                    fixture[field] = [value] * len(fixture["dates"])
                script = "window.IHSG_PUBLIC_DATA=" + json.dumps(fixture, allow_nan=False) + ";"
                self.page.route("**/data.js", lambda route: route.fulfill(status=200, content_type="application/javascript", body=script))
                try:
                    self.page.reload(wait_until="load")
                    self.page.wait_for_function("!!window.__IHSG_TEST__")
                    self.history("ALL")
                    for mode, field, lower, upper in (
                        ("activity", "volume_index", 0, 500),
                        ("balance", "volume_balance", -100, 100),
                        ("spike", "volume_spike", 0, 100),
                    ):
                        self.history("ALL")
                        self.page.locator(f'.volume-mode[data-volume="{mode}"]').click()
                        visible = self.drag("volumeChart", .97, 1)
                        domain = self.domain("volumeChart")
                        self.assertGreaterEqual(domain[0], lower)
                        self.assertLessEqual(domain[1], upper)
                        self.assert_domain_contains(domain, visible["raw"] + visible["smoothed"])
                        self.assertEqual(visible["raw"], [values[field]] * visible["count"])
                        for path in self.page.locator("#volumeChart path").all():
                            self.assertNotIn("NaN", path.get_attribute("d"))
                            self.assertNotIn("Infinity", path.get_attribute("d"))
                        if values[field] is None:
                            self.assertEqual(self.page.locator("#volumeChart path.raw").get_attribute("d"), "")
                finally:
                    self.page.unroute("**/data.js")
        self.page.reload(wait_until="load")
        self.assertEqual(self.page.evaluate("window.IHSG_PUBLIC_DATA"), self.payload)


if __name__ == "__main__":
    unittest.main()
