#!/usr/bin/env python3
import csv
import json
import os
import re
import sys
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE = "https://api.tab.co.nz/affiliates/v1"

DEFAULT_EVENT_PARAMS = {
    "with_money_tracker": "true",
    "with_big_bets": "true",
    "with_biggest_bet": "true",
    "with_tote_trends_data": "true",
    "present_overlay": "false",
}


def http_get_json(url: str):
    req = Request(url, headers={"User-Agent": "openclaw-tab-puller/1.0"})
    with urlopen(req, timeout=20) as resp:
        data = resp.read()
    return json.loads(data)


def safe_slug(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return re.sub(r"(^-|-$)", "", s) or "_"


def meetings(country: str, type_: str = "T", date_from: str = "today", date_to: str = "today", limit: int = 200, offset: int = 0):
    qs = urlencode({
        "country": country,
        "type": type_,
        "date_from": date_from,
        "date_to": date_to,
        "limit": str(limit),
        "offset": str(offset),
    })
    url = f"{BASE}/racing/meetings?{qs}"
    return http_get_json(url)


def event(event_id: str, extra_params=None):
    params = dict(DEFAULT_EVENT_PARAMS)
    if extra_params:
        params.update(extra_params)
    qs = urlencode(params)
    url = f"{BASE}/racing/events/{event_id}?{qs}" if qs else f"{BASE}/racing/events/{event_id}"
    return http_get_json(url)


def extract_runners(evt: dict):
    data = evt.get("data", {})
    race = data.get("race", {})
    runners = data.get("runners") or []

    def odds_get(r):
        o = r.get("odds") or {}
        return (
            o.get("fixed_win"),
            o.get("fixed_place"),
            o.get("pool_win"),
            o.get("pool_place"),
        )

    rows = []
    for r in runners:
        fw, fp, tw, tp = odds_get(r)
        weight = r.get("weight") or {}
        form_inds = r.get("form_indicators") or []
        form_ind_names = ";".join([fi.get("name", "") for fi in form_inds if fi.get("name")])
        rows.append({
            "event_id": race.get("event_id"),
            "meeting": race.get("meeting_name"),
            "race_number": race.get("race_number"),
            "race_name": race.get("description"),
            "race_status": race.get("status"),
            "start_time_nz": race.get("start_time_nz"),
            "track_condition": race.get("track_condition"),
            "distance": race.get("distance"),
            "runner_number": r.get("runner_number"),
            "runner_name": r.get("name"),
            "barrier": r.get("barrier"),
            "jockey": r.get("jockey"),
            "trainer": r.get("trainer_name"),
            "weight_allocated": weight.get("allocated"),
            "weight_total": weight.get("total"),
            "fixed_win": fw,
            "fixed_place": fp,
            "tote_win": tw,
            "tote_place": tp,
            "gear": r.get("gear"),
            "mover": r.get("mover"),
            "is_scratched": r.get("is_scratched"),
            "last_twenty_starts": r.get("last_twenty_starts"),
            "sire": r.get("sire"),
            "dam": r.get("dam"),
            "dam_sire": r.get("dam_sire"),
            "form_indicators": form_ind_names,
        })

    # Sort by runner number if possible
    def sort_key(x):
        try:
            return int(x.get("runner_number") or 0)
        except Exception:
            return 0

    rows.sort(key=sort_key)
    return rows


def main():
    if len(sys.argv) < 2:
        print("usage: tab_affiliates_pull.py YYYY-MM-DD [--countries NZ,AUS,HK] [--meetings randwick,flemington] [--status Open]", file=sys.stderr)
        sys.exit(2)

    day = sys.argv[1]
    countries = "NZ,AUS,HK"
    meeting_filters = None
    status_filter = "Open"

    for arg in sys.argv[2:]:
        if arg.startswith("--countries="):
            countries = arg.split("=", 1)[1]
        elif arg.startswith("--meetings="):
            meeting_filters = [m.strip().lower() for m in arg.split("=", 1)[1].split(",") if m.strip()]
        elif arg.startswith("--status="):
            status_filter = arg.split("=", 1)[1]

    out_base = os.path.join(os.getcwd(), "data", "tab", day)
    os.makedirs(out_base, exist_ok=True)

    pulled = []
    for country in [c.strip() for c in countries.split(",") if c.strip()]:
        m = meetings(country=country, type_="T", date_from=day, date_to=day, limit=200, offset=0)
        meetings_list = (((m.get("data") or {}).get("meetings")) or [])

        # persist meetings index
        idx_dir = os.path.join(out_base, country)
        os.makedirs(idx_dir, exist_ok=True)
        with open(os.path.join(idx_dir, "meetings.json"), "w", encoding="utf-8") as f:
            json.dump(m, f, ensure_ascii=False, indent=2)

        for mtg in meetings_list:
            name = mtg.get("name", "")
            if meeting_filters and name.strip().lower() not in meeting_filters:
                continue

            races = mtg.get("races") or []
            for race in races:
                if status_filter and (race.get("status") != status_filter):
                    continue
                event_id = race.get("id")
                if not event_id:
                    continue

                evt = event(event_id)

                mtg_slug = safe_slug(name)
                race_no = race.get("race_number")
                race_dir = os.path.join(out_base, country, mtg_slug, f"R{race_no:02d}-{event_id}")
                os.makedirs(race_dir, exist_ok=True)

                # persist raw
                with open(os.path.join(race_dir, "event.json"), "w", encoding="utf-8") as f:
                    json.dump(evt, f, ensure_ascii=False, indent=2)

                # normalized runners csv
                rows = extract_runners(evt)
                csv_path = os.path.join(race_dir, "runners.csv")
                if rows:
                    with open(csv_path, "w", newline="", encoding="utf-8") as f:
                        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                        w.writeheader()
                        w.writerows(rows)

                pulled.append((country, name, race_no, event_id, len(rows)))

    # summary
    print(f"Pulled {len(pulled)} races")
    for country, name, race_no, event_id, n in pulled[:50]:
        print(f"- {country} {name} R{race_no}: {event_id} runners={n}")


if __name__ == "__main__":
    main()
