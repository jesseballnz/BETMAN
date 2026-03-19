#!/usr/bin/env python3
"""Calibrate BETMAN win probabilities using historical results."""
import json
import os
import re
from datetime import datetime
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, 'data', 'tab')
MEMORY_DIR = os.path.join(ROOT, 'memory')
TENANTS_DIR = os.path.join(MEMORY_DIR, 'tenants')
OUT = os.path.join(MEMORY_DIR, 'betman_prob_calibration.json')


def norm(text):
    return re.sub(r'[^a-z0-9]+', ' ', (text or '').lower()).strip()


def parse_prob(reason):
    if not reason:
        return None
    m = re.search(r'p=\s*([0-9]+(?:\.[0-9]+)?)%?', reason, re.IGNORECASE)
    if not m:
        return None
    try:
        val = float(m.group(1)) / 100.0
        return val if 0 <= val <= 1 else None
    except Exception:
        return None


def load_audit_files():
    files = []
    main = os.path.join(MEMORY_DIR, 'bet-plan-audit.jsonl')
    if os.path.exists(main):
        files.append(main)
    if os.path.isdir(TENANTS_DIR):
        for root, _, filenames in os.walk(TENANTS_DIR):
            for name in filenames:
                if name == 'bet-plan-audit.jsonl':
                    files.append(os.path.join(root, name))
    return files


def load_results_for_date(date):
    results = {}
    date_dir = os.path.join(DATA_DIR, date)
    if not os.path.isdir(date_dir):
        return results
    for root, _, files in os.walk(date_dir):
        for name in files:
            if name != 'event.json':
                continue
            path = os.path.join(root, name)
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
            except Exception:
                continue
            race = (data.get('data') or {}).get('race') or {}
            meeting = race.get('meeting_name') or race.get('display_meeting_name') or ''
            race_no = race.get('race_number')
            if not meeting or race_no is None:
                continue
            res = (data.get('data') or {}).get('results') or []
            winner = None
            for r in res:
                if r.get('position') == 1:
                    winner = r.get('name')
                    break
            if not winner:
                continue
            key = (norm(meeting), str(race_no))
            results[key] = winner
    return results


def build_samples():
    samples = []
    results_cache = {}
    for path in load_audit_files():
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except Exception:
                    continue
                date = row.get('date')
                if not date:
                    continue
                if date not in results_cache:
                    results_cache[date] = load_results_for_date(date)
                results = results_cache[date]
                for item in row.get('suggestedTop', []) or []:
                    if str(item.get('type') or '').lower() != 'win':
                        continue
                    meeting = item.get('meeting') or ''
                    race = str(item.get('race') or '').replace('R','')
                    selection = item.get('selection') or ''
                    prob = parse_prob(item.get('reason') or '')
                    if prob is None:
                        continue
                    winner = results.get((norm(meeting), race))
                    if not winner:
                        continue
                    win = 1 if norm(selection) == norm(winner) else 0
                    samples.append({"p": prob, "win": win})
    return samples


def main():
    samples = build_samples()
    if not samples:
        print('No samples available for calibration.')
        return

    bins = []
    step = 0.05
    edges = [round(x * step, 2) for x in range(int(1 / step) + 1)]
    for i in range(len(edges) - 1):
        bins.append({"min": edges[i], "max": edges[i+1], "samples": 0, "wins": 0, "avg_pred": 0.0})

    for s in samples:
        p = s['p']
        idx = min(int(p / step), len(bins) - 1)
        b = bins[idx]
        b['samples'] += 1
        b['wins'] += s['win']
        b['avg_pred'] += p

    for b in bins:
        if b['samples']:
            b['avg_pred'] = b['avg_pred'] / b['samples']
            actual_rate = b['wins'] / b['samples']
        else:
            b['avg_pred'] = None
            actual_rate = None
        if b['avg_pred'] and actual_rate is not None and b['avg_pred'] > 0:
            mult = actual_rate / b['avg_pred']
        else:
            mult = 1.0
        b['actual_rate'] = actual_rate
        b['multiplier'] = max(0.5, min(1.5, mult))

    out = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "samples": len(samples),
        "step": step,
        "bins": bins
    }
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
    print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()
