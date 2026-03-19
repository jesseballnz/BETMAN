#!/usr/bin/env python3
import json
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIT = os.path.join(ROOT, 'memory', 'bet-plan-audit.jsonl')
OUT = os.path.join(ROOT, 'frontend', 'data', 'fringe_threshold_report.json')

rows = []
if os.path.exists(AUDIT):
    with open(AUDIT, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            for x in row.get('fringeSignals') or []:
                if isinstance(x, dict):
                    rows.append(x)

summary = defaultdict(lambda: {'count': 0, 'above': 0, 'below': 0, 'avgSignalPct': 0.0})
for r in rows:
    key = str(r.get('type') or 'unknown').lower()
    s = summary[key]
    s['count'] += 1
    sig = r.get('signalPct')
    if isinstance(sig, (int, float)):
        s['avgSignalPct'] += sig
    if r.get('fringeBucket') == 'above-threshold':
        s['above'] += 1
    else:
        s['below'] += 1

for v in summary.values():
    if v['count']:
        v['avgSignalPct'] = round(v['avgSignalPct'] / v['count'], 2)

payload = {
    'rows': rows[-500:],
    'summary': dict(summary),
    'count': len(rows)
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(payload, f, indent=2)
print(f'fringe_threshold_report.json updated ({len(rows)} rows)')
