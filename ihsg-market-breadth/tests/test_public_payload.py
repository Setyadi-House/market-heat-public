"""Validate the reviewed aggregate snapshot without executing JavaScript or APIs.

Run from any directory:
    python3 ihsg-market-breadth/tests/test_public_payload.py

The date/count checkpoint is intentional: extend it only after a newer aggregate
payload has been validated by the private pipeline. This public test does not
calculate breadth or substitute for provider/source validation.
"""

import datetime
import json
import math
from pathlib import Path
import re
import unittest


PAYLOAD_PATH = Path(__file__).resolve().parents[1] / "data.js"
EXPECTED_START = "2001-06-18"
EXPECTED_END = "2026-09-29"
EXPECTED_POINTS = 6147
NUMERIC_FIELDS = {
    "ihsg", "ihsg_1y", "macd", "ma", "st", "composite", "target",
    "eligible", "coverage", "volume_index", "volume_balance", "volume_spike",
    "volume_valid",
}
META_FIELDS = {
    "classification", "market_as_of", "history_start", "display_points",
    "warmup", "universe_symbols", "price_coverage_pct", "cap_coverage_pct",
    "source_sha", "benchmark_provider", "source_priority", "methodology",
    "history_note",
}
BREADTH_FIELDS = ("macd", "ma", "st", "composite")
VOLUME_FIELDS = ("volume_index", "volume_balance", "volume_spike")
SECRET_PATTERN = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}"
    r"|\bgithub_pat_[A-Za-z0-9_]{20,}|(?:api_?key|api_token|access_token)=\S+",
    re.IGNORECASE,
)
STOCK_IDENTIFIER_PATTERN = re.compile(r"\b[A-Z0-9]{1,12}\.(?:JK|IDX|JKT)\b", re.IGNORECASE)
TOLERANCE = 0.00001  # Public aggregates are rounded to six decimals.


class PayloadError(ValueError):
    """The public payload violates a review requirement."""


def require(condition, message):
    if not condition:
        raise PayloadError(message)


def numeric(value):
    return type(value) in (int, float) and math.isfinite(value)


def count(value):
    return numeric(value) and value >= 0 and value == int(value)


def read_payload(path=PAYLOAD_PATH):
    # Parse the one supported assignment, rather than evaluating untrusted JS.
    source = path.read_text(encoding="utf-8")
    match = re.fullmatch(r"\s*window\.IHSG_PUBLIC_DATA\s*=\s*(\{.*\})\s*;\s*", source, re.DOTALL)
    require(match is not None, "data.js must contain only the aggregate JSON assignment")

    def reject_constant(value):
        raise PayloadError("non-JSON numeric constant: " + value)

    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON field: " + key)
            result[key] = value
        return result

    return json.loads(match.group(1), parse_constant=reject_constant, object_pairs_hook=unique_object)


def validate_payload(data):
    require(type(data) is dict, "payload must be an object")
    require(set(data) == {"meta", "dates"} | NUMERIC_FIELDS,
            "public fields must use the reviewed aggregate-only schema")
    meta = data["meta"]
    require(type(meta) is dict and set(meta) == META_FIELDS,
            "metadata must use the reviewed aggregate-only schema")
    require(meta["classification"] == "AGGREGATE_DERIVED_DATA", "aggregate classification is required")
    for key, value in meta.items():
        require(type(value) is str or numeric(value),
                "metadata must contain scalar public values: " + key)
        if isinstance(value, str):
            require(SECRET_PATTERN.search(value) is None, "credential-like metadata: " + key)
            require(STOCK_IDENTIFIER_PATTERN.search(value) is None, "stock identifier in public metadata: " + key)

    dates = data["dates"]
    require(type(dates) is list and len(dates) == EXPECTED_POINTS,
            "reviewed date checkpoint must contain 6147 sessions")
    require(all(type(value) is str for value in dates), "dates must contain only ISO date strings")
    for value in dates:
        try:
            parsed = datetime.date.fromisoformat(value)
        except ValueError:
            raise PayloadError("invalid calendar date: " + value) from None
        require(parsed.isoformat() == value, "dates must use YYYY-MM-DD format")
    require(dates == sorted(set(dates)), "dates must be strictly increasing and unique")
    require(dates[0] == EXPECTED_START and dates[-1] == EXPECTED_END,
            "reviewed history endpoints must remain 2001-06-18 through 2026-09-29")
    require(meta["history_start"] == dates[0] and meta["market_as_of"] == dates[-1],
            "metadata endpoints must match the date array")
    require(type(meta["display_points"]) is int and meta["display_points"] == len(dates),
            "meta.display_points must equal dates.length")
    require(count(meta["warmup"]) and count(meta["universe_symbols"]), "metadata counts must be nonnegative integers")
    for key in ("price_coverage_pct", "cap_coverage_pct"):
        require(numeric(meta[key]) and 0 <= meta[key] <= 100, key + " must be a percentage")
    require(type(meta["source_sha"]) is str and re.fullmatch(r"[0-9a-f]{40}", meta["source_sha"]) is not None,
            "source_sha must identify the validated private source commit")

    for key in NUMERIC_FIELDS:
        values = data[key]
        require(type(values) is list and len(values) == len(dates), "array alignment: " + key)
        for index, value in enumerate(values):
            require(value is None or numeric(value),
                    f"{key}[{index}] must be a finite aggregate number or null")

    for index, date in enumerate(dates):
        def value(key):
            return data[key][index]

        target, eligible, coverage = value("target"), value("eligible"), value("coverage")
        for key in ("target", "eligible", "volume_valid"):
            require(value(key) is None or count(value(key)), f"{key} must be a nonnegative integer at {date}")
        if target is not None:
            require(target <= meta["universe_symbols"], "target exceeds current universe at " + date)
        if target is not None and eligible is not None:
            require(eligible <= target, "eligible exceeds target at " + date)

        # An absent entire-market cross-section is a gap, never a false 0%.
        cross_section = target is not None and target > 0 and eligible is not None and eligible > 0
        if cross_section:
            require(coverage is not None and abs(coverage - 100 * eligible / target) <= TOLERANCE,
                    "coverage must equal 100 * eligible / target at " + date)
        else:
            require(coverage is None, "missing cross-section coverage must be null, not zero, at " + date)
            require(all(value(key) is None for key in BREADTH_FIELDS),
                    "missing cross-section breadth must remain null gaps at " + date)

        for key in (*BREADTH_FIELDS, "coverage", "volume_spike"):
            require(value(key) is None or 0 <= value(key) <= 100, key + " outside percentage bounds at " + date)
        require(value("ihsg") is None or value("ihsg") > 0, "IHSG level must be positive at " + date)
        require(value("volume_index") is None or value("volume_index") >= 0,
                "volume activity cannot be negative at " + date)
        require(value("volume_balance") is None or -100 <= value("volume_balance") <= 100,
                "volume balance outside -100..100 at " + date)

        breadth = [value(key) for key in BREADTH_FIELDS[:3]]
        if all(item is not None for item in breadth):
            require(value("composite") is not None and abs(value("composite") - sum(breadth) / 3) <= TOLERANCE,
                    "composite must equal the mean of available three breadth measures at " + date)
        else:
            require(value("composite") is None, "missing breadth inputs must not produce a composite at " + date)

        volume_valid = value("volume_valid")
        if volume_valid is not None and eligible is not None:
            require(volume_valid <= eligible, "volume_valid exceeds eligible at " + date)
        if not cross_section or volume_valid in (None, 0):
            require(all(value(key) is None for key in VOLUME_FIELDS),
                    "missing volume observations must remain null gaps at " + date)
        # Positive volume_valid permits genuine 0 activity/spike values. Direction
        # remains unavailable when the aggregate relative-volume denominator is 0.
        if value("volume_index") == 0:
            require(value("volume_balance") is None, "zero aggregate activity has no directional balance at " + date)

    return {
        "sessions": len(dates),
        "numeric_arrays": len(NUMERIC_FIELDS),
        "coverage_gaps": data["coverage"].count(None),
        "volume_balance_gaps": data["volume_balance"].count(None),
        "zero_volume_activity": data["volume_index"].count(0),
    }


class PublicPayloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = read_payload()

    def changed(self, **fields):
        data = self.payload.copy()
        data.update(fields)
        return data

    def row(self, **fields):
        data = self.payload.copy()
        for key, value in fields.items():
            data[key] = data[key].copy()
            data[key][0] = value
        return data

    def assert_rejected(self, data, message):
        with self.assertRaisesRegex(PayloadError, message):
            validate_payload(data)

    def test_reviewed_snapshot(self):
        result = validate_payload(self.payload)
        self.assertEqual(result["sessions"], EXPECTED_POINTS)
        self.assertEqual(result["numeric_arrays"], 13)

    def test_display_points_cannot_be_missing_or_wrong(self):
        for bad_value in (None, EXPECTED_POINTS - 1, str(EXPECTED_POINTS)):
            with self.subTest(bad_value=bad_value):
                meta = self.payload["meta"].copy()
                meta["display_points"] = bad_value
                self.assert_rejected(self.changed(meta=meta), "meta.display_points|scalar public")

    def test_every_array_must_be_aligned(self):
        for field in NUMERIC_FIELDS:
            with self.subTest(field=field):
                self.assert_rejected(self.changed(**{field: self.payload[field][:-1]}), "array alignment")

    def test_history_cannot_be_extended_without_review(self):
        dates = self.payload["dates"].copy()
        dates[-1] = "2026-09-30"
        self.assert_rejected(self.changed(dates=dates), "reviewed history endpoints")

    def test_duplicate_session_is_rejected(self):
        dates = self.payload["dates"].copy()
        dates[1] = dates[0]
        self.assert_rejected(self.changed(dates=dates), "strictly increasing and unique")

    def test_coverage_uses_same_session_counts(self):
        self.assert_rejected(self.row(coverage=0), "coverage must equal")

    def test_missing_cross_section_stays_a_gap(self):
        fields = {key: None for key in (*BREADTH_FIELDS, *VOLUME_FIELDS)}
        fields.update(eligible=0, coverage=None, volume_valid=0)
        validate_payload(self.row(**fields))
        fields["coverage"] = 0
        self.assert_rejected(self.row(**fields), "missing cross-section coverage must be null")

    def test_missing_breadth_is_not_zero_filled(self):
        self.assert_rejected(self.row(eligible=0, coverage=None), "missing cross-section breadth")

    def test_missing_volume_is_not_zero_filled(self):
        fields = {key: None for key in VOLUME_FIELDS}
        fields["volume_valid"] = 0
        validate_payload(self.row(**fields))
        fields["volume_index"] = 0
        self.assert_rejected(self.row(**fields), "missing volume observations")

    def test_genuine_volume_zero_is_preserved(self):
        validate_payload(self.row(volume_valid=1, volume_index=0, volume_balance=None, volume_spike=0))

    def test_partial_missing_indicator_requires_null_composite(self):
        validate_payload(self.row(macd=None, composite=None))
        self.assert_rejected(self.row(macd=None), "missing breadth inputs")

    def test_privacy_rejects_stock_records_and_identifiers(self):
        self.assert_rejected(self.changed(stocks=[{"symbol": "EXAMPLE.JK", "close": 100}]), "aggregate-only schema")
        self.assert_rejected(self.row(ihsg={"symbol": "EXAMPLE.JK", "close": 100}), "finite aggregate number or null")
        self.assert_rejected(self.row(macd="EXAMPLE.JK"), "finite aggregate number or null")
        meta = self.payload["meta"].copy()
        meta["symbols"] = ["EXAMPLE.JK"]
        self.assert_rejected(self.changed(meta=meta), "metadata must use")
        meta = self.payload["meta"].copy()
        meta["source_priority"] = "EXAMPLE.JK"
        self.assert_rejected(self.changed(meta=meta), "stock identifier in public metadata")

    def test_privacy_rejects_credential_like_metadata(self):
        meta = self.payload["meta"].copy()
        meta["source_priority"] = "https://provider.example/?apikey=example-secret"
        self.assert_rejected(self.changed(meta=meta), "credential-like metadata")

    def test_nonfinite_boolean_or_nested_numbers_are_rejected(self):
        for bad_value in (float("nan"), float("inf"), True, [1, 2]):
            with self.subTest(bad_value=bad_value):
                self.assert_rejected(self.row(macd=bad_value), "finite aggregate number or null")


if __name__ == "__main__":
    print("Public aggregate checkpoint:", validate_payload(read_payload()), flush=True)
    unittest.main(verbosity=2)
