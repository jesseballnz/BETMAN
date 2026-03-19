#!/usr/bin/env python
"""Fetch Loveracing ratings + sectionals + comments by horse name.

Uses:
- POST /ServerScript/HorsesRatingAndReports.aspx/GetRatingSearchResultsJson
- EntryDetail modal by HorseID

Writes cache to memory/loveracing_horse_cache.json
"""
import json
import re
import time
from datetime import datetime, timezone
from urllib import request
from urllib.error import URLError, HTTPError
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RACES_PATH = ROOT / "frontend" / "data" / "races.json"
CACHE_PATH = ROOT / "memory" / "loveracing_horse_cache.json"

SEARCH_URL = "https://loveracing.nz/ServerScript/HorsesRatingAndReports.aspx/GetRatingSearchResultsJson"
ENTRY_URL = "https://loveracing.nz/Common/SystemTemplates/Modal/EntryDetail.aspx?HorseID={horse_id}&DisplayContext=Modal"

MAX_AGE_HOURS = 24
REQUEST_DELAY_SEC = 0.35


def norm_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def load_json(path, fallback):
    try:
        return json.loads(Path(path).read_text())
    except Exception:
        return fallback


def save_json(path, payload):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(payload, indent=2))


def post_json(url, payload):
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Origin": "https://loveracing.nz",
        "Referer": "https://loveracing.nz/",
        "X-Requested-With": "XMLHttpRequest",
    }
    req = request.Request(url, data=data, headers=headers)
    with request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_html(url):
    req = request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def parse_rating_search(name):
    payload = {"horseName": name, "trainerName": "", "rating": ""}
    out = post_json(SEARCH_URL, payload)
    raw = out.get("d", "{}")
    try:
        data = json.loads(raw)
    except Exception:
        data = {"rows": []}
    rows = data.get("rows") or []
    if not rows:
        return None

    target = norm_name(name)
    # prefer exact normalized match
    for row in rows:
        if norm_name(row.get("Horse")) == target:
            return row
    return rows[0]


def parse_sectionals(html):
    # Extract sectionals rows (table-indepth entries inside sectionalsData)
    rows = []
    # find blocks with the 6 timing columns
    row_re = re.compile(
        r"<div class=\"table-indepth[^\"]*\">\s*"
        r"<div class=\"d-flex col-6[^>]*\">(?P<head>.*?)</div>\s*"
        r"<div class=\"px-1 col-1[^>]*\">(?P<time>[^<]+)</div>\s*"
        r"<div class=\"px-1 col-1[^>]*\">(?P<first400>[^<]+)</div>\s*"
        r"<div class=\"px-1 col-1[^>]*\">(?P<last800>[^<]+)</div>\s*"
        r"<div class=\"px-1 col-1[^>]*\">(?P<last600>[^<]+)</div>\s*"
        r"<div class=\"px-1 col-1[^>]*\">(?P<last400>[^<]+)</div>\s*"
        r"<div class=\"px-1 col-1[^>]*\">(?P<last200>[^<]+)</div>",
        re.S
    )
    date_re = re.compile(r"<div class=\"p-0 pr-1 d-flex col4[^>]*\">([^<]+)</div>")
    dist_re = re.compile(r"<div class=\"p-0 pr-1 d-flex col2[^>]*\">([^<]+)</div>")
    track_re = re.compile(r"<div class=\"p-0 d-flex col1 border-left[^>]*\">([^<]+)</div>")

    for m in row_re.finditer(html):
        head = m.group("head")
        date_match = date_re.search(head)
        dist_match = dist_re.search(head)
        track_match = track_re.search(head)
        date_raw = date_match.group(1).strip() if date_match else ""
        distance = dist_match.group(1).strip() if dist_match else ""
        track = track_match.group(1).strip() if track_match else ""
        rows.append({
            "date": date_raw,
            "distance": distance,
            "track": track,
            "time": m.group("time").strip(),
            "first400": m.group("first400").strip(),
            "last800": m.group("last800").strip(),
            "last600": m.group("last600").strip(),
            "last400": m.group("last400").strip(),
            "last200": m.group("last200").strip(),
        })
    return rows


def parse_comments(html):
    comments = []
    block_re = re.compile(r"<ul class=\"comments no-bullets column\">(.*?)</ul>", re.S)
    li_re = re.compile(r"<li[^>]*>(.*?)</li>", re.S)
    tag_re = re.compile(r"<[^>]+>")
    for block in block_re.findall(html):
        lines = []
        for li in li_re.findall(block):
            txt = tag_re.sub("", li).strip()
            txt = re.sub(r"\s+", " ", txt)
            if txt:
                lines.append(txt)
        if lines:
            comments.append(lines)
    return comments


def parse_date(date_str):
    for fmt in ("%d %b %y", "%d %B %y"):
        try:
            return datetime.strptime(date_str, fmt)
        except Exception:
            continue
    return None


def compute_latest_and_avg(rows):
    if not rows:
        return None, None, None, None
    with_dates = [(parse_date(r.get("date", "")), r) for r in rows]
    with_dates = [(d, r) for d, r in with_dates if d is not None]
    if not with_dates:
        return rows[0], None, None, None
    with_dates.sort(key=lambda x: x[0], reverse=True)
    latest = with_dates[0][1]
    recent = [r for _, r in with_dates[:3]]

    def to_seconds(val):
        if not val:
            return None
        parts = re.split(r"[.:]", str(val))
        try:
            parts = [int(p) for p in parts if p != ""]
        except Exception:
            return None
        if len(parts) == 3:
            m, s, hs = parts
            return (m * 60) + s + (hs / 100)
        if len(parts) == 2:
            m, s = parts
            return (m * 60) + s
        if len(parts) == 1:
            return float(parts[0])
        return None

    def avg(field):
        vals = []
        for r in recent:
            sec = to_seconds(r.get(field))
            if sec is not None:
                vals.append(sec)
        if not vals:
            return None
        return round(sum(vals) / len(vals), 3)

    def trend_and_forecast(field):
        # oldest -> newest
        with_dates_sorted = sorted([(parse_date(r.get("date", "")), r) for r in recent], key=lambda x: x[0])
        series = [to_seconds(r.get(field)) for _, r in with_dates_sorted if r]
        series = [s for s in series if s is not None]
        if len(series) < 2:
            return None, None, None
        slope = (series[-1] - series[0]) / (len(series) - 1)
        forecast = series[-1] + slope
        improving = slope < 0
        return round(slope, 3), round(forecast, 3), improving

    avg3 = {
        "first400": avg("first400"),
        "last800": avg("last800"),
        "last600": avg("last600"),
        "last400": avg("last400"),
        "last200": avg("last200")
    }

    trend = {}
    forecast = {}
    improving = {}
    for field in ["first400", "last800", "last600", "last400", "last200"]:
        slope, fc, imp = trend_and_forecast(field)
        if slope is not None:
            trend[field] = slope
        if fc is not None:
            forecast[field] = fc
        if imp is not None:
            improving[field] = imp

    return latest, avg3, trend, {"seconds": forecast, "improving": improving}


def main():
    races_payload = load_json(RACES_PATH, {})
    races = races_payload.get("races", [])

    # Fallback: if active races.json has no NZ races, inspect dated races snapshots.
    if not any(str(r.get("country", "")).upper() == "NZ" for r in races):
        dated = sorted((ROOT / "frontend" / "data").glob("races-*.json"), reverse=True)
        for p in dated:
            payload = load_json(p, {})
            candidate = payload.get("races", [])
            if any(str(r.get("country", "")).upper() == "NZ" for r in candidate):
                races = candidate
                break

    cache = load_json(CACHE_PATH, {})
    now = datetime.now(timezone.utc)

    horses = set()
    for race in races:
        if str(race.get("country", "")).upper() != "NZ":
            continue
        for runner in race.get("runners", []) or []:
            name = runner.get("name") or runner.get("runner_name")
            if name:
                horses.add(name)

    updated = 0
    matched = 0
    skipped_fresh = 0
    errors = 0

    for name in sorted(horses):
        key = norm_name(name)
        if not key:
            continue
        existing = cache.get(key)
        if existing:
            updated_at = existing.get("updatedAt")
            try:
                ts = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
                age_hours = (now - ts).total_seconds() / 3600
                if age_hours < MAX_AGE_HOURS:
                    skipped_fresh += 1
                    continue
            except Exception:
                pass

        try:
            rating_row = parse_rating_search(name)
            if not rating_row:
                continue
            horse_id = rating_row.get("HorseID")
            if not horse_id:
                continue
            matched += 1
            html = get_html(ENTRY_URL.format(horse_id=horse_id))
            sectionals = parse_sectionals(html)
            comments = parse_comments(html)
            latest, avg3, trend, forecast = compute_latest_and_avg(sectionals)

            cache[key] = {
                "name": name,
                "horse_id": horse_id,
                "trainer": rating_row.get("Trainer"),
                "domestic_rating": rating_row.get("DomesticRating"),
                "hurdles_rating": rating_row.get("HurdlesRating"),
                "steeples_rating": rating_row.get("SteeplesRating"),
                "sectionals": {
                    "latest": latest,
                    "avg3": avg3,
                    "trend_per_race_seconds": trend,
                    "forecast_next": forecast,
                    "rows": sectionals[:8]
                },
                "comments": comments[:6],
                "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            }
            updated += 1
            time.sleep(REQUEST_DELAY_SEC)
        except (HTTPError, URLError, Exception):
            errors += 1
            continue

    save_json(CACHE_PATH, cache)
    # refresh race cache to merge loveracing fields
    try:
        import subprocess
        subprocess.run(["node", str(ROOT / "scripts" / "race_cache_writer.js")], check=False)
    except Exception:
        pass
    print(f"loveracing cache updated: {updated} horses | matched {matched}/{len(horses)} | fresh-skip {skipped_fresh} | errors {errors}")


if __name__ == "__main__":
    main()
