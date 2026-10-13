"""Offline regressions for the Margin Monitor and Data Status views of the shipped dashboard.

Run: python -m unittest discover -s ihsg-market-breadth/tests -v
Install playwright==1.63.0 and its Chromium, or set IHSG_BROWSER to a browser path.
IHSG_SCREENSHOT_DIR optionally saves previews outside the checkout.
The shipped margin-data.js is read as published (official IDX Margin records only); fixtures derived from it are
served through local routes and never written. No providers, credentials, IDX pages or external web resources are used.
Assertions are invariants of the format and of the verified archive, so they hold for every later synced revision.
"""

from __future__ import annotations

import copy
import csv
from datetime import date, datetime, timezone
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import shutil
import threading
import unittest
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


DASHBOARD = Path(__file__).resolve().parents[1]
PREFIX = "window.IHSG_MARGIN_DATA="
SOURCE_URL = "https://www.idx.co.id/id/data-pasar/ringkasan-perdagangan/ringkasan-saham/"
TOP_KEYS = {"meta", "dates", "status", "records", "total_value", "offsets", "codes", "code", "value", "volume",
            "frequency", "monthly"}
META_KEYS = {"schema_version", "kind", "title", "source", "source_url", "definitions", "currency", "first_date",
             "latest_date", "sessions", "unverified_sessions", "records", "codes", "base_date", "base_value",
             "public_fields", "private_columns", "archive", "snapshot", "update", "qc"}
ARCHIVE = {"first_date": "2024-09-02", "last_date": "2026-10-13", "sessions": 503, "records": 98986, "codes": 433}
TABS = ("breadth", "margin", "status")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def content_hash(payload) -> str:
    body = copy.deepcopy(payload)
    body["meta"]["snapshot"].pop("content_sha256", None)
    return hashlib.sha256(canonical(body)).hexdigest()


def encode(payload) -> str:
    payload = copy.deepcopy(payload)
    payload["meta"]["snapshot"]["content_sha256"] = content_hash(payload)
    return PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"


def moving_average(values, n, method, basis):
    """Independent reference: 'observed' uses the last n observations (gaps skipped, EMA state kept);
    'session' needs n consecutive observed sessions (a gap breaks the window and restarts the EMA)."""
    out, alpha = [None] * len(values), 2 / (n + 1)
    window, previous, seen = [], None, 0
    for index, value in enumerate(values):
        if value is None:
            if basis == "session":
                window, previous, seen = [], None, 0
            continue
        seen += 1
        if method == "EMA":
            previous = value if previous is None else alpha * value + (1 - alpha) * previous
            if seen >= n:
                out[index] = previous
        else:
            window.append(value)
            window = window[-n:]
            if len(window) == n:
                out[index] = sum(window) / n
    return out


def with_gap(payload, day):
    """The shipped payload with one verified session turned into an unverified gap (the format of a session whose
    file was never accepted): no records, no totals, listed in unverified_dates."""
    fixture = copy.deepcopy(payload)
    i = fixture["dates"].index(day)
    start, end = fixture["offsets"][i], fixture["offsets"][i + 1]
    removed = end - start
    for key in ("code", "value", "volume", "frequency"):
        del fixture[key][start:end]
    fixture["offsets"] = fixture["offsets"][: i + 1] + [offset - removed for offset in fixture["offsets"][i + 1 :]]
    fixture["status"][i], fixture["records"][i], fixture["total_value"][i] = "U", None, None
    meta = fixture["meta"]
    meta["sessions"] -= 1
    meta["records"] -= removed
    meta["unverified_sessions"] += 1
    meta["qc"]["sessions_pass"] -= 1
    meta["update"]["unverified_dates"] = sorted(meta["update"]["unverified_dates"] + [day])
    month = next(item for item in fixture["monthly"] if item["month"] == day[:7])
    month["verified"] -= 1
    month["unverified"] += 1
    month["records"] -= removed
    return fixture


class MarginDashboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        text = (DASHBOARD / "margin-data.js").read_text(encoding="utf-8")
        if not text.startswith(PREFIX) or not text.endswith(";\n"):
            raise AssertionError("margin-data.js must contain exactly the Margin JSON assignment")
        cls.text = text
        cls.payload = json.loads(text[len(PREFIX) : -2])
        breadth = (DASHBOARD / "data.js").read_text(encoding="utf-8")
        cls.breadth = json.loads(breadth[len("window.IHSG_PUBLIC_DATA=") :].strip().removesuffix(";"))
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(DASHBOARD)))
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/index.html"
        cls.playwright = sync_playwright().start()
        configured = os.environ.get("IHSG_BROWSER")
        bundled = cls.playwright.chromium.executable_path
        executable = configured or (bundled if Path(bundled).is_file() else None) or shutil.which("chromium") or \
            shutil.which("chromium-browser") or shutil.which("google-chrome")
        cls.browser = cls.playwright.chromium.launch(executable_path=executable, headless=True,
                                                     args=["--no-sandbox", "--disable-dev-shm-usage"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=5)

    def setUp(self):
        self.errors, self.external_requests, self.margin_requests = [], [], []
        self.context = None
        self.new_page()

    def new_page(self):
        if self.context is not None:
            self.context.close()
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 1080}, accept_downloads=True)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.on("request", lambda request: self.margin_requests.append(request.url)
                     if urlsplit(request.url).path.endswith("/margin-data.js") else None)

        def local_only(route):
            if urlsplit(route.request.url).hostname != "127.0.0.1":
                self.external_requests.append(route.request.url)
                route.abort()
            else:
                route.continue_()

        self.page.route("**/*", local_only)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [], "Dashboard raised browser errors")
        self.assertEqual(self.external_requests, [], "Offline dashboard requested external resources")

    # ------------------------------------------------------------------------------------------------- helpers

    def open(self, fragment="#margin", payload=None, body=None, status=200, wait=True):
        if payload is not None or body is not None:
            script = body if body is not None else encode(payload)
            self.page.route("**/margin-data.js", lambda route: route.fulfill(
                status=status, content_type="application/javascript", body=script))
        response = self.page.goto(self.url + fragment, wait_until="load")
        if response is None:                                  # same URL and fragment: a same-document navigation
            response = self.page.reload(wait_until="load")
        self.assertEqual(response.status, 200)
        self.page.wait_for_function("!!window.IHSGMargin")
        if wait:
            self.page.wait_for_function("() => { const s = window.IHSGMargin.state(); return s.ready || !!s.error; }")
            self.settle()

    def settle(self):
        self.page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")

    def state(self):
        return self.page.evaluate("window.IHSGMargin.test()")

    def point(self, chart, fraction=.5, height=.5):
        element = self.page.locator(f"#{chart} .plot-hit-area")
        element.scroll_into_view_if_needed()
        return element.evaluate("""(el, f) => { const b = el.getBBox();
            const p = new DOMPoint(b.x + b.width * f[0], b.y + b.height * f[1]).matrixTransform(el.getScreenCTM());
            return {x: p.x, y: p.y}; }""", [fraction, height])

    def table(self, table_id):
        return self.page.locator(f"#{table_id}").evaluate("""t => ({
            head: [...t.querySelectorAll('thead th')].map(th => th.textContent.replace(/ [↑↓]$/, '')),
            rows: [...t.querySelectorAll('tbody tr')].map(tr => [...tr.cells].map(td => td.textContent)) })""")

    def screenshot(self, name):
        destination = os.environ.get("IHSG_SCREENSHOT_DIR")
        if destination:
            path = Path(destination)
            path.mkdir(parents=True, exist_ok=True)
            self.page.screenshot(path=str(path / f"{name}.png"), full_page=True)

    def download(self, button):
        with self.page.expect_download() as info:
            self.page.locator(f"#{button}").click()
        download = info.value
        return download.suggested_filename, Path(download.path()).read_text(encoding="utf-8")

    def stock_values(self, code, payload=None):
        payload = payload or self.payload
        position = payload["codes"].index(code)
        values = [None] * len(payload["dates"])
        for i in range(len(payload["dates"])):
            for r in range(payload["offsets"][i], payload["offsets"][i + 1]):
                if payload["code"][r] == position:
                    values[i] = payload["value"][r]
        return values

    def assert_series(self, actual, expected, tolerance=1e-6):
        self.assertEqual(len(actual), len(expected))
        for index, (got, wanted) in enumerate(zip(actual, expected)):
            if wanted is None:
                self.assertIsNone(got, f"value created at {index}")
            else:
                self.assertIsNotNone(got, f"value lost at {index}")
                self.assertLessEqual(abs(got - wanted), tolerance * max(1, abs(wanted)), f"value changed at {index}")

    # ------------------------------------------------------------------------------------------- the payload

    def test_shipped_payload_is_the_allowlisted_reconciled_official_margin_snapshot(self):
        data = self.payload
        self.assertEqual(set(data), TOP_KEYS)
        meta = data["meta"]
        self.assertEqual(set(meta), META_KEYS)
        self.assertEqual((meta["kind"], meta["schema_version"], meta["source_url"], meta["currency"]),
                         ("ihsg-idx-margin-public", 1, SOURCE_URL, "IDR"))
        self.assertEqual(meta["public_fields"], ["Kode Saham", "Nilai", "Volume", "Frekuensi"])
        self.assertEqual(meta["archive"], ARCHIVE)
        self.assertEqual(meta["snapshot"]["content_sha256"], content_hash(data))
        # nothing but the official source URL; no credentials, hosts, accounts or other providers
        self.assertEqual(self.text.count("://"), self.text.count(SOURCE_URL))
        self.assertNotIn("@", self.text)
        for forbidden in ("proxy", "eodhd", "tradingview", "webshare", "password", "token", "breadth"):
            self.assertNotIn(forbidden, self.text.lower())
        n, dates = len(data["dates"]), data["dates"]
        self.assertEqual(dates, sorted(set(dates)))
        self.assertTrue(all(date.fromisoformat(day).weekday() < 5 for day in dates))
        self.assertEqual((dates[0], meta["latest_date"]), (ARCHIVE["first_date"], dates[-1]))
        for key in ("status", "records", "total_value"):
            self.assertEqual(len(data[key]), n)
        self.assertEqual(len(data["offsets"]), n + 1)
        self.assertEqual({len(data[key]) for key in ("code", "value", "volume", "frequency")}, {meta["records"]})
        for i in range(n):
            start, end = data["offsets"][i], data["offsets"][i + 1]
            block = data["code"][start:end]
            if data["status"][i] == "U":
                self.assertEqual((end - start, data["records"][i], data["total_value"][i]), (0, None, None))
                continue
            self.assertEqual(block, sorted(set(block)), "duplicate date-code key")
            self.assertEqual(data["records"][i], end - start)
            self.assertEqual(data["total_value"][i], sum(data["value"][start:end]))
        for key in ("value", "volume", "frequency"):
            self.assertTrue(all(isinstance(v, int) and v >= 0 for v in data[key]))
        # the verified archive: 503 sessions, 98,986 records and 433 codes from 2024-09-02 to 2026-10-13
        archive = [i for i, day in enumerate(dates) if day <= ARCHIVE["last_date"]]
        self.assertEqual(sum(data["status"][i] == "V" for i in archive), ARCHIVE["sessions"])
        self.assertEqual(data["offsets"][archive[-1] + 1], ARCHIVE["records"])
        self.assertEqual(len({data["code"][r] for r in range(ARCHIVE["records"])}), ARCHIVE["codes"])
        base = dates.index(meta["base_date"])
        self.assertEqual((meta["base_date"], meta["base_value"]), ("2024-09-02", data["total_value"][base]))
        self.assertGreater(meta["base_value"], 0)

    # ----------------------------------------------------------------------------------------- navigation

    def test_tabs_load_margin_only_when_opened_and_keep_breadth_unchanged(self):
        self.open("", wait=False)
        self.page.wait_for_function("!!window.__IHSG_TEST__")
        self.assertEqual(self.page.locator('[role="tab"][aria-selected="true"]').get_attribute("id"), "tab-breadth")
        self.assertTrue(self.page.locator("#panel-breadth").is_visible())
        self.assertFalse(self.page.locator("#panel-margin").is_visible())
        self.settle()
        self.assertEqual(self.margin_requests, [], "Market Breadth must not download the Margin data")
        before = self.page.evaluate("window.__IHSG_TEST__.getView('combinedChart')")
        self.page.locator("#tab-margin").click()
        self.page.wait_for_function("window.IHSGMargin.state().ready")
        self.assertTrue(self.page.locator("#panel-margin").is_visible())
        self.assertFalse(self.page.locator("#panel-breadth").is_visible())
        self.assertTrue(self.page.url.endswith("#margin"))
        self.page.locator("#tab-status").click()
        self.page.locator("#tab-breadth").click()
        self.assertEqual(len(self.margin_requests), 1)
        self.assertEqual(self.page.evaluate("window.__IHSG_TEST__.getView('combinedChart')"), before)

    def test_hash_routes_and_keyboard_tabs(self):
        self.open("#margin/BBCA")
        self.assertEqual(self.state()["code"], "BBCA")
        self.assertEqual(self.page.locator('[role="tab"][aria-selected="true"]').get_attribute("id"), "tab-margin")
        self.page.locator("#tab-margin").focus()
        for key, expected in (("ArrowRight", "status"), ("ArrowRight", "breadth"), ("ArrowLeft", "status"),
                              ("Home", "breadth"), ("End", "status")):
            self.page.keyboard.press(key)
            focused = self.page.evaluate("document.activeElement.id")
            self.assertEqual(focused, f"tab-{expected}")
            self.assertEqual(self.page.locator(f"#tab-{expected}").get_attribute("aria-selected"), "true")
            self.assertEqual(self.page.locator(f"#tab-{expected}").get_attribute("tabindex"), "0")
            for other in TABS:
                self.assertEqual(self.page.locator(f"#panel-{other}").is_visible(), other == expected)
        self.page.evaluate("location.hash = '#margin'")
        self.page.wait_for_function("document.getElementById('tab-margin').getAttribute('aria-selected') === 'true'")

    # ------------------------------------------------------------------------------------- aggregate chart

    def test_activity_index_is_100_at_its_base_and_is_never_rebased_by_the_view(self):
        self.open()
        data = self.payload
        self.page.locator('.margin-view[data-view="index"]').click()
        self.page.locator('.marginAgg-range[data-range="ALL"]').click()
        state = self.state()
        self.assertEqual((state["view"], state["base"]), ("index", "2024-09-02"))
        base = state["agg"]["dates"].index("2024-09-02")
        self.assertEqual(state["agg"]["raw"][base], 100)
        reference = data["total_value"][data["dates"].index("2024-09-02")]
        expected = [None if v is None else 100 * v / reference for v in data["total_value"]]
        self.assert_series(state["agg"]["raw"], expected)
        self.assertIn("base 2024-09-02 = 100", self.page.locator("#marginAggTitle").inner_text())
        self.assertEqual(self.page.locator("#marginAggChart .base-marker").count(), 1)
        # panning, zooming and other date ranges never rebase it
        self.page.locator('.marginAgg-range[data-range="3M"]').click()
        self.page.locator("#marginAggChart").focus()
        self.page.keyboard.press("+")
        self.page.keyboard.press("ArrowLeft")
        state = self.state()
        self.assertEqual(state["base"], "2024-09-02")
        offset = state["agg"]["start"]
        self.assert_series(state["agg"]["raw"], expected[offset : offset + len(state["agg"]["raw"])])
        # another verified session can be the base; a date without a verified session is refused
        self.page.locator("#marginBase").fill("2025-01-02")
        self.page.locator("#marginBaseApply").click()
        state = self.state()
        self.assertEqual(state["base"], "2025-01-02")
        self.assertEqual(self.page.locator("#marginBaseNow").inner_text(), "2025-01-02")
        new_reference = data["total_value"][data["dates"].index("2025-01-02")]
        self.assert_series(state["agg"]["raw"], [None if v is None else 100 * v / new_reference
                                                 for v in data["total_value"]][offset : offset + len(state["agg"]["raw"])])
        for invalid in ("2025-01-04", "2024-08-30"):                 # a Saturday; a date before the history
            self.page.locator("#marginBase").fill(invalid)
            self.page.locator("#marginBaseApply").click()
            self.assertIn("verified session", self.page.locator("#marginBaseError").inner_text())
            self.assertEqual(self.state()["base"], "2025-01-02")
        self.page.locator('.margin-view[data-view="value"]').click()
        self.assertTrue(self.page.locator("#marginBaseGroup").is_hidden())
        self.assertEqual(self.page.locator("#marginAggChart .axis-unit").text_content(), "IDR billion")

    def test_moving_averages_match_the_reference_and_do_not_change_with_zoom(self):
        self.open()
        totals = self.payload["total_value"]
        for method, length in (("SMA", 20), ("EMA", 20), ("SMA", 5), ("EMA", 60)):
            with self.subTest(method=method, length=length):
                self.page.locator("#marginAggType").select_option(method)
                self.page.locator("#marginAggN").fill(str(length))
                self.page.locator("#marginAggSmooth").click()
                full = self.state()["agg"]["full"]
                self.assert_series(full, moving_average(totals, length, method, "observed"))
                self.assertTrue(all(v is None for v in full[: length - 1]), "insufficient history must stay empty")
                for action in ("+", "+", "ArrowLeft", "-"):
                    self.page.locator("#marginAggChart").focus()
                    self.page.keyboard.press(action)
                    state = self.state()
                    self.assertEqual(state["agg"]["full"], full)
                    self.assertEqual(state["agg"]["smoothed"], full[state["agg"]["start"] : state["agg"]["end"]])
        for bad in ("0", "1261", "2.5", ""):
            self.page.locator("#marginAggN").fill(bad)
            self.page.locator("#marginAggSmooth").click()
            self.assertIn("whole number", self.page.locator("#marginAggSmoothError").inner_text())
        # the stock chart has its own method, length and basis
        code = self.state()["code"]
        values = self.stock_values(code)
        for method, length, basis in (("SMA", 20, "observed"), ("EMA", 10, "observed"), ("SMA", 10, "session"),
                                      ("EMA", 5, "session")):
            with self.subTest(stock=code, method=method, length=length, basis=basis):
                self.page.locator("#marginStockType").select_option(method)
                self.page.locator("#marginStockN").fill(str(length))
                self.page.locator("#marginStockBasis").select_option(basis)
                self.page.locator("#marginStockSmooth").click()
                state = self.state()
                self.assertEqual(state["stockMa"], {"type": method, "n": length, "basis": basis})
                self.assert_series(state["stock"]["full"], moving_average(values, length, method, basis))
                self.assertEqual(state["aggMa"]["type"], "EMA")                # the aggregate setting is untouched

    def test_gaps_stay_gaps_in_both_charts_and_their_averages(self):
        dates = self.payload["dates"]
        gap = "2026-07-15" if "2026-07-15" in dates else dates[len(dates) - 60]
        fixture = with_gap(self.payload, gap)
        self.open("#margin/BBCA", payload=fixture)
        i = dates.index(gap)
        self.page.locator('.marginAgg-range[data-range="6M"]').click()
        state = self.state()
        self.assertIsNone(state["agg"]["raw"][state["agg"]["dates"].index(gap)])
        self.assertEqual(self.page.locator("#marginAggChart .gap-line").count(), 1)
        self.assert_series(state["agg"]["full"], moving_average(fixture["total_value"], 20, "SMA", "observed"))
        values = self.stock_values("BBCA", fixture)
        self.assertIsNone(values[i])
        self.page.locator("#marginStockBasis").select_option("session")
        self.page.locator("#marginStockN").fill("5")
        self.page.locator("#marginStockSmooth").click()
        state = self.state()
        self.assert_series(state["stock"]["full"], moving_average(values, 5, "SMA", "session"))
        self.assertTrue(all(v is None for v in state["stock"]["full"][i : i + 5]), "a gap must break the session window")
        self.page.locator("#marginStockBasis").select_option("observed")
        self.page.locator("#marginStockSmooth").click()
        self.assert_series(self.state()["stock"]["full"], moving_average(values, 5, "SMA", "observed"))
        # the tooltip names the gap instead of a value
        view = self.state()["agg"]
        fraction = (view["dates"].index(gap)) / (len(view["dates"]) - 1)
        point = self.point("marginAggChart", fraction)
        self.page.mouse.move(point["x"], point["y"])
        self.assertIn("not verified", self.page.locator("#marginAggTip").inner_text())
        self.page.locator("#tab-status").click()
        self.assertIn(gap, self.page.locator("#smUnverified").inner_text())
        self.assertIn("1 expected sessions in this range have no verified file", self.page.locator("#smState").inner_text())

    def test_date_controls_are_independent(self):
        self.open()
        initial = self.state()
        self.page.locator('.marginAgg-range[data-range="3M"]').click()
        after = self.state()
        self.assertNotEqual((after["agg"]["start"], after["agg"]["end"]), (initial["agg"]["start"], initial["agg"]["end"]))
        self.assertEqual(after["stock"], initial["stock"])
        self.assertEqual((after["daily"], after["period"]), (initial["daily"], initial["period"]))
        self.page.locator("#marginStockFrom").fill("2025-03-03")
        self.page.locator("#marginStockTo").fill("2025-06-30")
        self.page.locator("#marginStockApply").click()
        moved = self.state()
        inside = [day for day in self.payload["dates"] if "2025-03-03" <= day <= "2025-06-30"]
        self.assertEqual(moved["stock"]["dates"], inside)
        self.assertEqual(moved["agg"], after["agg"])
        self.page.locator("#marginDailyPrev").click()
        self.page.locator("#marginPeriodStart").fill("2025-01-02")
        self.page.locator("#marginPeriodEnd").fill("2025-01-31")
        self.page.locator("#marginPeriodApply").click()
        last = self.state()
        self.assertEqual((last["agg"], last["stock"]), (moved["agg"], moved["stock"]))
        self.assertEqual((last["period"]["start"], last["period"]["end"]), ("2025-01-02", "2025-01-31"))
        self.page.locator("#marginStockFrom").fill("2025-06-30")
        self.page.locator("#marginStockTo").fill("2025-03-03")
        self.page.locator("#marginStockApply").click()
        self.assertIn("start date on or before", self.page.locator("#marginStockRangeError").inner_text())
        self.assertEqual(self.state()["stock"], last["stock"])
        self.screenshot("margin-independent-controls-1440-light")

    # ------------------------------------------------------------------------------------------------ tables

    def test_daily_table_lists_every_record_of_the_selected_session(self):
        self.open()
        data, latest = self.payload, self.payload["meta"]["latest_date"]
        i = data["dates"].index(latest)
        table = self.table("marginDailyTable")
        self.assertEqual(table["head"][:2], ["Trade Date", "Stock Code"])
        self.assertIn("Margin Value (IDR)", table["head"])
        self.assertEqual(len(table["rows"]), data["records"][i])
        self.assertEqual({row[0] for row in table["rows"]}, {latest})
        values = [int(row[2].replace(",", "")) for row in table["rows"]]
        self.assertEqual(values, sorted(values, reverse=True))
        self.assertEqual(sum(values), data["total_value"][i])
        expected = {data["codes"][data["code"][r]]: data["value"][r] for r in range(data["offsets"][i], data["offsets"][i + 1])}
        self.assertEqual({row[1]: int(row[2].replace(",", "")) for row in table["rows"]}, expected)
        self.assertAlmostEqual(sum(float(row[3].rstrip("%")) for row in table["rows"]), 100, delta=0.005 * len(values) + 0.01)
        self.page.locator("#marginDailyTable thead button", has_text="Stock Code").click()
        codes = [row[1] for row in self.table("marginDailyTable")["rows"]]
        self.assertEqual(codes, sorted(codes))
        self.page.locator("#marginDailyTable thead button", has_text="Stock Code").click()
        self.assertEqual([row[1] for row in self.table("marginDailyTable")["rows"]], sorted(codes, reverse=True))
        self.assertEqual(self.page.locator("#marginDailyTable thead th").nth(1).get_attribute("aria-sort"), "descending")
        self.page.locator("#marginDailySearch").fill("bb")
        rows = self.table("marginDailyTable")["rows"]
        self.assertTrue(rows and all("BB" in row[1] for row in rows))
        self.page.locator("#marginDailySearch").fill("")
        self.page.locator("#marginDailyPrev").click()
        previous = data["dates"][max(j for j in range(i) if data["status"][j] == "V")]
        self.assertEqual(self.page.locator("#marginDailyDate").input_value(), previous)
        self.assertEqual({row[0] for row in self.table("marginDailyTable")["rows"]}, {previous})
        self.page.locator("#marginDailyDate").fill("2026-10-11")                       # a Sunday
        self.assertIn("not a verified Margin session", self.page.locator("#marginDailyError").inner_text())
        self.assertEqual(self.page.locator("#marginDailyDate").input_value(), previous)
        # a code opens its own history in the stock chart
        self.page.locator("#marginDailyTable .code-button").first.click()
        code = self.table("marginDailyTable")["rows"][0][1]
        self.assertEqual(self.state()["code"], code)
        self.assertIn(code, self.page.locator("#marginStockTitle").inner_text())

    def test_period_table_sums_source_values_with_observation_counts(self):
        self.open()
        data = self.payload
        self.page.locator("#marginPeriodStart").fill("2025-01-01")
        self.page.locator("#marginPeriodEnd").fill("2025-03-31")
        self.page.locator("#marginPeriodApply").click()
        table = self.table("marginPeriodTable")
        self.assertEqual(table["head"][:3], ["Period Start", "Period End", "Stock Code"])
        for column in ("Period Value (IDR)", "Share of Period Total", "Observations", "Verified Sessions"):
            self.assertIn(column, table["head"])
        inside = [i for i, day in enumerate(data["dates"]) if "2025-01-01" <= day <= "2025-03-31" and data["status"][i] == "V"]
        sums, counts = {}, {}
        for i in inside:
            for r in range(data["offsets"][i], data["offsets"][i + 1]):
                code = data["codes"][data["code"][r]]
                sums[code] = sums.get(code, 0) + data["value"][r]
                counts[code] = counts.get(code, 0) + 1
        rows = {row[2]: row for row in table["rows"]}
        self.assertEqual(set(rows), set(sums))
        for code, row in rows.items():
            self.assertEqual((row[0], row[1]), ("2025-01-01", "2025-03-31"))
            self.assertEqual(int(row[3].replace(",", "")), sums[code])
            self.assertEqual((int(row[5]), int(row[6]), int(row[7])), (counts[code], len(inside), len(inside) - counts[code]))
        self.assertAlmostEqual(sum(float(row[4].rstrip("%")) for row in table["rows"]), 100, delta=0.005 * len(rows) + 0.01)
        summary = self.page.locator("#marginPeriodSummary").inner_text()
        self.assertIn(f"{len(inside)} verified sessions", summary)
        self.assertIn("not a balance", summary)
        self.page.locator("#marginPeriodEnd").fill("2024-12-31")
        self.page.locator("#marginPeriodApply").click()
        self.assertIn("start date on or before", self.page.locator("#marginPeriodError").inner_text())

    def test_exports_are_source_labelled_csv_of_the_shown_selection(self):
        self.open()
        data, latest = self.payload, self.payload["meta"]["latest_date"]
        name, text = self.download("marginDailyCsv")
        self.assertEqual(name, f"ihsg-margin-daily-{latest}.csv")
        lines = text.splitlines()
        self.assertTrue(lines[0].startswith("# IHSG Margin Monitor"))
        self.assertIn("IDX official daily stock summary", lines[1])
        self.assertIn(SOURCE_URL, lines[1])
        self.assertIn(data["meta"]["snapshot"]["content_sha256"], lines[2])
        self.assertIn("not outstanding margin debt", lines[3])
        rows = list(csv.reader(io.StringIO("\n".join(lines[4:]))))
        self.assertEqual(rows[0][:3], ["Trade Date", "Stock Code", "Margin Value (IDR)"])
        self.assertEqual(len(rows) - 1, data["records"][data["dates"].index(latest)])
        self.assertEqual(sum(int(row[2]) for row in rows[1:]), data["total_value"][data["dates"].index(latest)])
        name, text = self.download("marginAggCsv")
        rows = list(csv.reader(io.StringIO("\n".join(text.splitlines()[4:]))))
        self.assertEqual(name, "ihsg-margin-aggregate.csv")
        self.assertEqual(len(rows) - 1, len(data["dates"]))
        self.assertEqual(rows[1][0], data["dates"][0])
        self.assertEqual(float(rows[1][3]), 100.0)                                     # the base, 2024-09-02
        code = self.state()["code"]
        name, text = self.download("marginStockCsv")
        self.assertEqual(name, f"ihsg-margin-stock-{code}.csv")
        rows = list(csv.reader(io.StringIO("\n".join(text.splitlines()[4:]))))
        self.assertEqual(len(rows) - 1, sum(v is not None for v in self.stock_values(code)))
        name, text = self.download("marginPeriodCsv")
        self.assertTrue(name.startswith("ihsg-margin-period-") and name.endswith(".csv"))
        self.assertEqual(list(csv.reader(io.StringIO(text.splitlines()[4])))[0][:3], ["Period Start", "Period End", "Stock Code"])

    # ------------------------------------------------------------------------------------- interaction, UI

    def test_chart_zoom_pan_reset_box_tooltip_and_expanded_view(self):
        self.open()
        for chart, tip in (("marginAggChart", "marginAggTip"), ("marginStockChart", "marginStockTip")):
            with self.subTest(chart=chart):
                key = "agg" if chart == "marginAggChart" else "stock"
                before = self.state()[key]
                self.page.locator(f"#{chart}").focus()
                self.page.keyboard.press("+")
                zoomed = self.state()[key]
                self.assertLess(zoomed["end"] - zoomed["start"], before["end"] - before["start"])
                self.assertEqual(zoomed["end"], before["end"])
                self.page.keyboard.press("ArrowLeft")
                self.assertLess(self.state()[key]["start"], zoomed["start"])
                self.page.keyboard.press("Home")
                self.assertEqual((self.state()[key]["start"], self.state()[key]["end"]), (before["start"], before["end"]))
                point = self.point(chart, .5)
                self.page.mouse.move(point["x"], point["y"])
                tooltip = self.page.locator(f"#{tip}")
                self.assertTrue(tooltip.is_visible())
                self.assertRegex(tooltip.inner_text(), r"\d{4}-\d{2}-\d{2} \|")
                tip_box, chart_box = tooltip.bounding_box(), self.page.locator(f"#{chart}").bounding_box()
                self.assertGreaterEqual(tip_box["x"], chart_box["x"] - 1)
                self.assertLessEqual(tip_box["x"] + tip_box["width"], chart_box["x"] + chart_box["width"] + 1)
                box = "marginAggBox" if key == "agg" else "marginStockBox"
                self.page.locator(f"#{box}").click()
                self.assertEqual(self.page.locator(f"#{box}").get_attribute("aria-pressed"), "true")
                first, last = self.point(chart, .25, .3), self.point(chart, .5, .7)
                self.page.mouse.move(first["x"], first["y"])
                self.page.mouse.down()
                self.page.mouse.move(last["x"], last["y"], steps=4)
                self.page.mouse.up()
                boxed = self.state()[key]
                self.assertLess(boxed["end"] - boxed["start"], before["end"] - before["start"])
                self.page.keyboard.press("Escape")
                self.assertEqual(self.page.locator(f"#{box}").get_attribute("aria-pressed"), "false")
                self.page.locator("#marginAggReset" if key == "agg" else "#marginStockReset").click()
                self.assertEqual((self.state()[key]["start"], self.state()[key]["end"]), (before["start"], before["end"]))
        normal = self.page.locator("#marginAggChart").bounding_box()["height"]
        self.page.locator("#marginAggExpand").click()
        self.settle()
        self.assertIn("expanded", self.page.locator("#marginAggCard").get_attribute("class"))
        self.assertEqual(self.page.locator("#marginAggExpand").get_attribute("aria-pressed"), "true")
        expanded = self.page.locator("#marginAggChart").bounding_box()["height"]
        self.assertGreater(expanded, normal)
        self.assertLessEqual(abs(int(self.page.locator("#marginAggChart").get_attribute("viewBox").split()[3]) - expanded), 1)
        self.screenshot("margin-expanded-1440")
        self.page.keyboard.press("Escape")
        self.assertNotIn("expanded", self.page.locator("#marginAggCard").get_attribute("class"))
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "marginAggExpand")

    def test_large_charts_and_layout_fit_desktop_and_mobile_in_both_themes(self):
        self.open()
        for width in (320, 375, 390, 768, 1440, 1920):
            self.page.set_viewport_size({"width": width, "height": 900})
            for dark in (False, True):
                if ("dark" in (self.page.locator("body").get_attribute("class") or "")) != dark:
                    self.page.locator("#themeBtn").click()
                for tab in ("margin", "status"):
                    with self.subTest(width=width, dark=dark, tab=tab):
                        self.page.locator(f"#tab-{tab}").click()
                        self.settle()
                        self.assertFalse(self.page.evaluate("document.documentElement.scrollWidth > innerWidth"))
                        controls = self.page.locator(f"#panel-{tab} button:visible, #panel-{tab} input:visible, "
                                                     f"#panel-{tab} select:visible").evaluate_all(
                            "els => els.filter(el => !el.closest('.table-wrap')).map(el => { const r = el.getBoundingClientRect(); return [r.x, r.width]; })")
                        for x, w in controls:
                            self.assertGreaterEqual(x, -0.5)
                            self.assertLessEqual(x + w, width + 0.5)
                        if tab == "margin":
                            height = self.page.locator("#marginAggChart").bounding_box()["height"]
                            self.assertGreaterEqual(height, 420 if width > 900 else 300)
                            self.assertLessEqual(height, 520)
                            view_box = self.page.locator("#marginStockChart").get_attribute("viewBox").split()
                            box = self.page.locator("#marginStockChart").bounding_box()
                            self.assertLessEqual(abs(int(view_box[2]) - box["width"]), 1)     # text is never stretched
                            self.assertLessEqual(abs(int(view_box[3]) - box["height"]), 1)
                        self.screenshot(f"{tab}-{width}-{'dark' if dark else 'light'}")

    def test_theme_persists_and_gives_the_charts_their_own_contrast(self):
        self.open()
        colours = {}
        for dark in (False, True):
            if ("dark" in (self.page.locator("body").get_attribute("class") or "")) != dark:
                self.page.locator("#themeBtn").click()
            colours[dark] = self.page.evaluate("""() => ({
                line: getComputedStyle(document.querySelector('#marginAggChart .margin-smooth')).stroke,
                ma: getComputedStyle(document.querySelector('#marginStockChart .margin-smooth')).stroke,
                bar: getComputedStyle(document.querySelector('#marginStockChart .stock-bar')).fill,
                panel: getComputedStyle(document.querySelector('#marginAggCard')).backgroundColor,
                scheme: getComputedStyle(document.body).colorScheme })""")
        self.assertEqual(colours[False]["line"], "rgb(75, 107, 251)")
        self.assertEqual(colours[True]["line"], "rgb(142, 162, 255)")
        self.assertEqual(colours[True]["panel"], "rgb(21, 30, 46)")
        self.assertEqual((colours[False]["scheme"], colours[True]["scheme"]), ("light", "dark"))
        for theme in colours.values():
            self.assertNotEqual(theme["line"], theme["ma"])
            self.assertNotEqual(theme["bar"], theme["panel"])
        self.assertEqual(self.page.evaluate("localStorage.getItem('ihsg-theme')"), "dark")
        self.page.reload(wait_until="load")
        self.page.wait_for_function("window.IHSGMargin.state().ready")
        self.assertIn("dark", self.page.locator("body").get_attribute("class"))
        self.assertEqual(self.page.locator("#themeBtn").inner_text(), "Light mode")

    def test_settings_persist_but_an_unknown_remembered_code_or_range_falls_back(self):
        self.open()
        self.page.locator("#marginStockCode").fill("tlkm")
        self.page.keyboard.press("Enter")
        self.assertEqual(self.state()["code"], "TLKM")
        self.page.locator("#marginStockCode").fill("NOPE")
        self.page.locator("#marginStockGo").click()
        self.assertIn("Unknown stock code", self.page.locator("#marginStockError").inner_text())
        self.assertEqual(self.state()["code"], "TLKM")
        self.page.locator("#marginStockNext").click()
        codes = self.payload["codes"]
        self.assertEqual(self.state()["code"], codes[(codes.index("TLKM") + 1) % len(codes)])
        self.page.evaluate("localStorage.setItem('ihsg-margin-stock', 'ZZZZ'); localStorage.setItem('ihsg-margin-agg-range', 'X');"
                           "localStorage.setItem('ihsg-margin-agg-n', '-3'); history.replaceState(null, '', '#margin')")
        self.page.reload(wait_until="load")
        self.page.wait_for_function("window.IHSGMargin.state().ready")
        state = self.state()
        latest = self.payload["dates"].index(self.payload["meta"]["latest_date"])
        top = max(range(self.payload["offsets"][latest], self.payload["offsets"][latest + 1]), key=lambda r: self.payload["value"][r])
        self.assertEqual(state["code"], codes[self.payload["code"][top]])
        self.assertEqual(state["aggMa"]["n"], 20)
        self.assertEqual(self.page.locator(".marginAgg-range.active").get_attribute("data-range"), "1Y")

    # ------------------------------------------------------------------------------------------ data status

    def test_data_status_reports_each_dataset_on_its_own(self):
        self.open("#status")
        meta = self.payload["meta"]
        self.assertEqual(self.page.locator("#sbChip").inner_text(), "VALID")
        self.assertEqual(self.page.locator("#sbMarket").inner_text(), self.breadth["meta"]["market_as_of"])
        self.assertEqual(self.page.locator("#smUpdateChip").inner_text(), meta["update"]["status"])
        state = self.page.locator("#smState").inner_text()
        self.assertIn(f"{meta['sessions']} verified sessions", state)
        self.assertIn(f"{meta['records']:,} stock records", state)
        self.assertIn(f"→ {meta['latest_date']}", state)
        self.assertIn("503 sessions, 98,986 stock records, 433 stock codes, 2024-09-02 → 2026-10-13",
                      self.page.locator("#smArchive").inner_text())
        self.assertIn("dataset completeness counts sessions, not stocks", self.page.locator("#smParticipation").inner_text())
        rows = self.table("smMonthly")["rows"]
        self.assertEqual(len(rows), len(self.payload["monthly"]))
        self.assertEqual(rows[0][0], self.payload["monthly"][-1]["month"])
        self.assertEqual(sum(int(row[2]) for row in rows), meta["sessions"])
        self.assertEqual(sum(int(row[4].replace(",", "")) for row in rows), meta["records"])
        self.assertNotIn("..", self.page.locator("#smUpdate").inner_text())
        self.screenshot("status-1440-light")

    def test_status_never_comes_from_the_device_clock(self):
        texts = []
        for moment in (None, datetime(2028, 6, 1, tzinfo=timezone.utc)):
            if moment is not None:
                self.new_page()
                self.page.clock.set_fixed_time(moment)                    # Date only; timers keep running
            self.open("#status")
            texts.append([self.page.locator(f"#{name}").inner_text() for name in
                          ("smUpdateChip", "smUpdate", "smRecorded", "smState", "smPending", "smSuccess", "marginStatusLine")])
        self.assertEqual(texts[0], texts[1])

    def test_a_margin_failure_never_touches_market_breadth(self):
        broken = copy.deepcopy(self.payload)
        broken["total_value"][5] += 1                                       # a total that no longer reconciles
        cases = (("invalid", dict(payload=broken), "failed validation (MARGIN_TOTALS)"),
                 ("garbage", dict(body="window.IHSG_MARGIN_DATA={\"meta\":{}};"), "failed validation (MARGIN_KEYS)"),
                 ("missing", dict(body="not found", status=404), "could not be loaded"))
        for name, options, message in cases:
            with self.subTest(case=name):
                self.page.unroute("**/margin-data.js")
                self.open("#margin", **options)
                self.page.wait_for_function("!!window.__IHSG_TEST__")
                self.assertTrue(self.page.locator("#marginError").is_visible())
                self.assertIn(message, self.page.locator("#marginError").inner_text())
                self.assertIn("Market Breadth is unaffected", self.page.locator("#marginError").inner_text())
                self.assertTrue(self.page.locator("#marginContent").is_hidden())
                self.assertEqual(self.page.locator("#marginStatusChip").inner_text(), "NOT SHOWN")
                self.page.locator("#tab-status").click()
                self.assertEqual(self.page.locator("#sbChip").inner_text(), "VALID")
                self.assertEqual(self.page.locator("#smUpdateChip").inner_text(), "NOT SHOWN")
                self.page.locator("#tab-breadth").click()
                self.assertGreater(self.page.locator("#combinedChart path").count(), 0)
                view = self.page.evaluate("window.__IHSG_TEST__.getView('combinedChart')")
                self.assertEqual(view["dates"][-1], self.breadth["meta"]["market_as_of"])

    def test_loading_state_is_shown_until_the_data_arrives(self):
        held = []
        self.page.route("**/margin-data.js", lambda route: held.append(route))      # answered only below
        self.page.goto(self.url + "#margin", wait_until="domcontentloaded")
        self.page.wait_for_function("!!window.IHSGMargin")
        for _ in range(100):
            if held:
                break
            self.page.wait_for_timeout(50)
        self.assertEqual(len(held), 1)
        self.assertTrue(self.page.locator("#marginLoading").is_visible())
        self.assertIn("Loading IDX Margin data", self.page.locator("#marginLoading").inner_text())
        self.assertTrue(self.page.locator("#marginContent").is_hidden())
        self.assertEqual(self.page.locator("#smUpdateChip").inner_text(), "—")
        held[0].continue_()
        self.page.wait_for_function("window.IHSGMargin.state().ready")
        self.assertTrue(self.page.locator("#marginLoading").is_hidden())
        self.assertTrue(self.page.locator("#marginContent").is_visible())

    def test_html_ids_and_scripts_are_complete(self):
        html = (DASHBOARD / "index.html").read_text(encoding="utf-8")
        ids = re.findall(r'id="([^"]+)"', html)
        self.assertEqual(len(ids), len(set(ids)), "duplicate element ids")
        script = (DASHBOARD / "margin.js").read_text(encoding="utf-8")
        used = set(re.findall(r"\$\('([A-Za-z]+)'\)", script)) | set(re.findall(r"(?<!store\.)\bset\('([A-Za-z]+)'", script))
        self.assertGreater(len(used), 60)
        for name in sorted(used):
            self.assertIn(name, ids)
        self.assertLess(html.index('src="data.js"'), html.index('src="app.js"'))
        self.assertLess(html.index('src="charts.js"'), html.index('src="margin.js"'))
        self.assertLess(html.index('src="margin.js"'), html.index('src="shell.js"'))
        self.assertNotIn('src="margin-data.js"', html, "the Margin data is loaded on demand")


if __name__ == "__main__":
    unittest.main()
