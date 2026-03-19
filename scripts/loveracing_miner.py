#!/usr/bin/env python3
import os
import re
import json
import time
import hashlib
from datetime import datetime, timedelta
from urllib.request import Request, urlopen

BASE = 'https://loveracing.nz'
CALENDAR_URL = BASE + '/ServerScript/RaceInfo.aspx/GetCalendarEvents'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'data', 'loveracing')
MEETINGS_DIR = os.path.join(OUT_DIR, 'meetings')
ENTRIES_DIR = os.path.join(OUT_DIR, 'entries')
CALENDAR_DIR = os.path.join(OUT_DIR, 'calendar')

RATE_PER_SEC = 3.0
SLEEP = 1.0 / RATE_PER_SEC

ENTRY_RE = re.compile(r"/Common/SystemTemplates/Modal/EntryDetail.aspx\?[^\"' >]+")


def ensure_dirs():
    for d in [OUT_DIR, MEETINGS_DIR, ENTRIES_DIR, CALENDAR_DIR]:
        os.makedirs(d, exist_ok=True)


def http_post_json(url, payload):
    data = json.dumps(payload).encode('utf-8')
    headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'Mozilla/5.0',
        'Referer': BASE + '/RaceInfo.aspx'
    }
    req = Request(url, data=data, headers=headers)
    with urlopen(req) as resp:
        return resp.read().decode('utf-8')


def http_get(url):
    req = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': BASE + '/RaceInfo.aspx'})
    with urlopen(req) as resp:
        return resp.read().decode('utf-8', errors='ignore')


def month_range(start, end):
    cur = datetime(start.year, start.month, 1)
    while cur <= end:
        next_month = (cur.replace(day=28) + timedelta(days=4)).replace(day=1)
        month_end = next_month - timedelta(days=1)
        yield cur, min(month_end, end)
        cur = next_month


def fmt_date(dt):
    return dt.strftime('%d-%b-%Y')


def cache_path(directory, name):
    return os.path.join(directory, name)


def write_file(path, content):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)


def load_json(path):
    if not os.path.isfile(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json(path, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)


def fetch_calendar(start, end):
    payload = {'start': fmt_date(start), 'end': fmt_date(end)}
    raw = http_post_json(CALENDAR_URL, payload)
    doc = json.loads(raw)
    items = json.loads(doc.get('d') or '[]')
    return items


def fetch_meeting(day_id):
    url = f"{BASE}/RaceInfo/{day_id}/Meeting-Overview.aspx"
    return http_get(url)


def fetch_entry(url):
    full = url if url.startswith('http') else f"{BASE}{url}"
    return http_get(full)


def run(start_date=None, end_date=None, rate_per_sec=3.0):
    global RATE_PER_SEC, SLEEP
    RATE_PER_SEC = rate_per_sec
    SLEEP = 1.0 / RATE_PER_SEC
    ensure_dirs()

    today = datetime.utcnow().date()
    if end_date is None:
        end_date = today
    if start_date is None:
        start_date = end_date - timedelta(days=730)

    start_dt = datetime.combine(start_date, datetime.min.time())
    end_dt = datetime.combine(end_date, datetime.min.time())

    all_events = []
    for mstart, mend in month_range(start_dt, end_dt):
        cache_name = f"calendar_{mstart.strftime('%Y_%m')}.json"
        cache_file = cache_path(CALENDAR_DIR, cache_name)
        cached = load_json(cache_file)
        if cached is None:
            items = fetch_calendar(mstart, mend)
            save_json(cache_file, items)
            time.sleep(SLEEP)
        else:
            items = cached
        all_events.extend(items)

    day_ids = sorted({int(ev.get('DayID')) for ev in all_events if ev.get('DayID')})
    print(f"Meetings found: {len(day_ids)}")

    for day_id in day_ids:
        meet_file = cache_path(MEETINGS_DIR, f"{day_id}.html")
        if not os.path.isfile(meet_file):
            html = fetch_meeting(day_id)
            write_file(meet_file, html)
            time.sleep(SLEEP)
        else:
            html = open(meet_file, 'r', encoding='utf-8').read()

        entry_links = sorted(set(ENTRY_RE.findall(html)))
        for link in entry_links:
            h = hashlib.md5(link.encode('utf-8')).hexdigest()
            entry_file = cache_path(ENTRIES_DIR, f"{h}.html")
            if os.path.isfile(entry_file):
                continue
            entry_html = fetch_entry(link)
            write_file(entry_file, entry_html)
            time.sleep(SLEEP)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', help='YYYY-MM-DD')
    parser.add_argument('--end', help='YYYY-MM-DD')
    parser.add_argument('--rate', type=float, default=3.0)
    args = parser.parse_args()

    def parse_date(s):
        if not s:
            return None
        return datetime.strptime(s, '%Y-%m-%d').date()

    run(start_date=parse_date(args.start), end_date=parse_date(args.end), rate_per_sec=args.rate)
