"""Read-only check of the deployed public dashboard against the checked-out commit.

Run by .github/workflows/ihsg-live-page-check.yml (manual dispatch on main):

  python ihsg-market-breadth/tests/live_page_check.py --out out/live-page-check

It fetches every shipped file of the live page with a cache-busting query and compares its SHA-256 with this commit,
waiting up to --wait seconds for GitHub Pages to finish a deployment, so a pass proves the page serves exactly these
bytes. It checks the served margin-data.js (the official IDX Margin archive: content hash, the verified 2024-09-02 ->
2026-10-13 archive, the latest session) and drives Chromium on the live page at desktop and mobile width: the Market
Breadth charts, the Margin Monitor (charts, KPIs and the latest session's table) and Data Status for each dataset,
without a script error or a failed request. It writes a report and screenshots to --out and prints one verdict line.
No secret is used and nothing is written anywhere else. Not a unit test (not collected by unittest discover).
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request


DASHBOARD = Path(__file__).resolve().parents[1]
PAGE = "https://setyadi-house.github.io/market-heat-public/ihsg-market-breadth/"
FILES = ("index.html", "app.js", "charts.js", "help.js", "margin.js", "shell.js", "styles.css", "data.js", "margin-data.js")
BREADTH_PREFIX, MARGIN_PREFIX = "window.IHSG_PUBLIC_DATA=", "window.IHSG_MARGIN_DATA="
ARCHIVE = {"first_date": "2024-09-02", "last_date": "2026-10-13", "sessions": 503, "records": 98986, "codes": 433}
ARCHIVE_TEXT = "503 sessions, 98,986 stock records, 433 stock codes, 2024-09-02 → 2026-10-13"
BREADTH_CHARTS = ("combinedChart", "volumeChart", "coverageChart")
MARGIN_CHARTS = ("marginAggChart", "marginStockChart")
MARGIN_TEXT = ("mkValue", "mkValueSub", "mkIndex", "mkIndexSub", "mkSessions", "mkSessionsSub", "marginStatusLine")
STATUS_TEXT = ("sbChip", "sbMarket", "sbSources", "smUpdateChip", "smUpdate", "smState", "smArchive", "smPending",
               "smSuccess")


def fetch(url: str) -> tuple[int, bytes]:
    """(status, body); 0 when the page could not be reached. Never raises, so a verdict is always written."""
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "ihsg-live-page-check"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, b""
    except (urllib.error.URLError, OSError, TimeoutError, ValueError):
        return 0, b""


def served_files(base: str, wait: int) -> tuple[dict, dict]:
    """Per file: status, served and committed SHA-256; polls until every file matches or the wait ends."""
    committed = {name: hashlib.sha256((DASHBOARD / name).read_bytes()).hexdigest() for name in FILES}
    deadline = time.monotonic() + wait
    while True:
        result, bodies = {}, {}
        for name in FILES:
            status, body = fetch(base + name + f"?check={time.time_ns()}")
            bodies[name] = body
            result[name] = {"status": status, "served_sha256": hashlib.sha256(body).hexdigest(),
                            "committed_sha256": committed[name]}
            result[name]["matches"] = status == 200 and result[name]["served_sha256"] == committed[name]
        if all(item["matches"] for item in result.values()) or time.monotonic() >= deadline:
            return result, bodies
        time.sleep(20)


def payload(body: bytes, prefix: str):
    text = body.decode("utf-8")
    if not text.startswith(prefix):
        raise ValueError("prefix")
    return json.loads(text[len(prefix):].strip().removesuffix(";"))


def margin_facts(body: bytes) -> dict:
    """The served Margin file as published: one assignment, its own content hash, the verified archive intact."""
    facts = {"parsed": False}
    try:
        text = body.decode("utf-8")
        data = payload(body, MARGIN_PREFIX)
        meta = data["meta"]
        unhashed = copy.deepcopy(data)
        claimed = unhashed["meta"]["snapshot"].pop("content_sha256", None)
        canonical = json.dumps(unhashed, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        dates = list(data.get("dates") or [])
    except (UnicodeDecodeError, ValueError, KeyError, TypeError, AttributeError):
        return facts
    facts.update({
        "parsed": True,
        "single_assignment": text.startswith(MARGIN_PREFIX) and text.endswith(";\n"),
        "kind": meta.get("kind"),
        "schema_version": meta.get("schema_version"),
        "content_hash_matches": claimed == hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
        "revision": (meta.get("snapshot") or {}).get("revision"),
        "first_date": meta.get("first_date"),
        "latest_date": meta.get("latest_date"),
        "sessions": meta.get("sessions"),
        "unverified_sessions": meta.get("unverified_sessions"),
        "records": meta.get("records"),
        "archive": meta.get("archive"),
        "update": meta.get("update"),
        "dates_ascending": all(a < b for a, b in zip(dates, dates[1:])),
        "latest_in_dates": meta.get("latest_date") in dates,
        "monthly_rows": len(data.get("monthly") or []),
    })
    return facts


def drawn(page, charts) -> dict:
    result = {}
    for chart in charts:
        shapes = [path.get_attribute("d") or "" for path in page.locator(f"#{chart} path").all()]
        result[chart] = {"paths": len(shapes), "drawn": sum(1 for d in shapes if len(d) > 20),
                         "bad": sum(1 for d in shapes if "NaN" in d or "Infinity" in d)}
    return result


def texts(page, ids) -> dict:
    return {key: page.locator("#" + key).inner_text() for key in ids}


def settle(page) -> None:
    page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")


def browse(base: str, out: Path, report: dict) -> None:
    from playwright.sync_api import sync_playwright
    errors, failed = [], []
    with sync_playwright() as playwright:
        executable = os.environ.get("IHSG_BROWSER")            # a local Chromium; the workflow installs its own
        browser = playwright.chromium.launch(**({"executable_path": executable} if executable else {}))
        for width, height, name in ((1440, 1100, "desktop"), (390, 900, "mobile")):
            context = browser.new_context(viewport={"width": width, "height": height})
            page = context.new_page()
            page.on("pageerror", lambda error, name=name: errors.append(f"{name} pageerror: {error}"))
            # the browser's own favicon request is not part of the page (the site has none)
            page.on("console", lambda message, name=name: message.type == "error"
                    and not (message.location or {}).get("url", "").endswith("/favicon.ico")
                    and errors.append(f"{name} console: {message.text}"))
            page.on("requestfailed", lambda request, name=name: failed.append(f"{name} {request.url}"))
            page.on("response", lambda response, name=name: response.status >= 400
                    and not response.url.endswith("/favicon.ico") and failed.append(f"{name} {response.status} {response.url}"))
            view = {}
            page.goto(base + f"?check={time.time_ns()}", wait_until="load", timeout=120_000)
            page.wait_for_function("!!window.__IHSG_TEST__ && !!window.IHSG_PUBLIC_DATA", timeout=60_000)
            settle(page)
            view["breadth_market_as_of"] = page.evaluate("window.IHSG_PUBLIC_DATA.meta.market_as_of")
            view["breadth_charts"] = drawn(page, BREADTH_CHARTS)
            page.screenshot(path=str(out / f"{name}-breadth.png"), full_page=True)
            page.locator("#tab-margin").click()
            page.wait_for_function("() => { const s = window.IHSGMargin.state(); return s.ready || !!s.error; }",
                                   timeout=120_000)
            settle(page)
            view["margin_ready"] = page.evaluate("window.IHSGMargin.state().ready === true")
            view["margin_error"] = page.evaluate("String(window.IHSGMargin.state().error || '')")
            view["margin_charts"] = drawn(page, MARGIN_CHARTS)
            view["margin_text"] = texts(page, MARGIN_TEXT)
            view["margin_daily_date"] = page.locator("#marginDailyDate").input_value()
            view["margin_daily_rows"] = page.locator("#marginDailyTable tbody tr").count()
            page.screenshot(path=str(out / f"{name}-margin.png"), full_page=True)
            page.locator("#tab-status").click()
            settle(page)
            view["status_text"] = texts(page, STATUS_TEXT)
            view["status_monthly_rows"] = page.locator("#smMonthly tbody tr").count()
            page.screenshot(path=str(out / f"{name}-status.png"), full_page=True)
            page.locator("#tab-breadth").click()
            settle(page)
            view["breadth_charts_after_tabs"] = drawn(page, BREADTH_CHARTS)
            report["views"][name] = view
            context.close()
        browser.close()
    report["script_errors"] = errors
    report["failed_requests"] = failed


def charts_ok(charts: dict) -> bool:
    return bool(charts) and all(item["drawn"] > 0 and item["bad"] == 0 for item in charts.values())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base", default=PAGE, help="page URL ending in / (default: the live public page)")
    parser.add_argument("--out", default="out/live-page-check", help="report and screenshot directory")
    parser.add_argument("--wait", type=int, default=600, help="seconds to wait for Pages to serve this commit")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report: dict = {"page_url": args.base, "commit": os.environ.get("GITHUB_SHA"),
                    "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "views": {},
                    "script_errors": [], "failed_requests": []}
    report["files"], bodies = served_files(args.base, args.wait)
    margin = report["margin_file"] = margin_facts(bodies["margin-data.js"])
    try:
        breadth_date = payload(bodies["data.js"], BREADTH_PREFIX)["meta"]["market_as_of"]
    except (UnicodeDecodeError, ValueError, KeyError, TypeError):
        breadth_date = None
    report["breadth_market_as_of"] = breadth_date
    if report["files"]["index.html"]["status"] == 200:       # a missing data file is reported by the page itself
        try:
            browse(args.base, out, report)
        except Exception as error:                      # the verdict is still written, with the failure named
            report["script_errors"].append("browser check stopped: " + type(error).__name__ + ": " + str(error)[:300])
    views = report["views"]
    latest = margin.get("latest_date")
    checks = {
        "files_served_as_committed": all(item["matches"] for item in report["files"].values()),
        "margin_file_intact": margin.get("parsed") is True and margin.get("single_assignment") is True
                              and margin.get("content_hash_matches") is True and margin.get("schema_version") == 1
                              and margin.get("kind") == "ihsg-idx-margin-public",
        "margin_history_complete": margin.get("archive") == ARCHIVE and margin.get("first_date") == ARCHIVE["first_date"]
                                   and isinstance(margin.get("sessions"), int) and margin["sessions"] >= ARCHIVE["sessions"]
                                   and isinstance(latest, str) and latest >= ARCHIVE["last_date"]
                                   and margin.get("dates_ascending") is True and margin.get("latest_in_dates") is True,
        "breadth_shown": len(views) == 2 and all(
            view["breadth_market_as_of"] == breadth_date and charts_ok(view["breadth_charts"])
            and charts_ok(view["breadth_charts_after_tabs"]) for view in views.values()),
        "margin_shown": len(views) == 2 and all(
            view["margin_ready"] and not view["margin_error"] and charts_ok(view["margin_charts"])
            and view["margin_daily_date"] == latest and view["margin_daily_rows"] > 0 for view in views.values()),
        "data_status_shown": len(views) == 2 and all(
            view["status_text"]["sbChip"] == "VALID" and view["status_text"]["sbMarket"] == breadth_date
            and view["status_text"]["smUpdateChip"] == (margin.get("update") or {}).get("status")
            and ARCHIVE_TEXT in view["status_text"]["smArchive"] and f"→ {latest}" in view["status_text"]["smState"]
            and view["status_monthly_rows"] == margin.get("monthly_rows") for view in views.values()),
        "no_script_errors": not report["script_errors"],
        "no_failed_requests": not report["failed_requests"],
    }
    report["checks"] = checks
    report["verdict"] = "PASS" if all(checks.values()) else "FAIL"
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    summary = {key: report[key] for key in ("verdict", "checks", "breadth_market_as_of", "script_errors", "failed_requests")}
    summary["margin"] = {key: margin.get(key) for key in ("latest_date", "sessions", "unverified_sessions", "records",
                                                          "revision", "update")}
    summary["served_sha256"] = {name: item["served_sha256"] for name, item in report["files"].items()
                                if name in ("data.js", "margin-data.js")}
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
            stream.write("## IHSG live page check\n\n" + "\n".join(f"- {'PASS' if v else 'FAIL'}: {k}" for k, v in checks.items())
                         + f"\n\nMarket Breadth {breadth_date}; Margin latest session {latest}, "
                           f"{margin.get('sessions')} verified sessions, revision {margin.get('revision')}.\n")
    print("LIVE_PAGE_CHECK " + json.dumps(summary, sort_keys=True, ensure_ascii=False), flush=True)
    return 0 if report["verdict"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
