#!/usr/bin/env python3
import json
import re
from pathlib import Path
from datetime import datetime
from collections import defaultdict

ROOT = Path(__file__).resolve().parents[1]
MEMORY_DIR = ROOT / 'memory'
DATA_DIR = ROOT / 'data' / 'tab'
OUT_PATH = MEMORY_DIR / 'roi_optimization.json'


def norm(text):
    return re.sub(r'[^a-z0-9]+', ' ', (text or '').lower()).strip()


def parse_odds(reason):
    if not reason:
        return None
    m = re.search(r'@\s*([0-9]+(?:\.[0-9]+)?)', reason)
    if not m:
        return None
    try:
        return float(m.group(1))
    except Exception:
        return None


def parse_prob(reason):
    if not reason:
        return None
    m = re.search(r'p=\s*([0-9]+(?:\.[0-9]+)?)%?', reason)
    if not m:
        return None
    try:
        return float(m.group(1)) / 100.0
    except Exception:
        return None


def load_results_for_date(date):
    results = {}
    date_dir = DATA_DIR / date
    if not date_dir.is_dir():
        return results
    for path in date_dir.rglob('event.json'):
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        race = (data.get('data') or {}).get('race') or {}
        meeting = race.get('meeting_name') or race.get('display_meeting_name') or ''
        race_no = race.get('race_number')
        if not meeting or race_no is None:
            continue
        res = (data.get('data') or {}).get('results') or []
        positions = {r.get('position'): r.get('name') for r in res if r.get('position') and r.get('name')}
        if not positions:
            continue
        key = (norm(meeting), str(race_no))
        results[key] = positions
    return results


def load_audit_files():
    files = []
    main = MEMORY_DIR / 'bet-plan-audit.jsonl'
    if main.exists():
        files.append(main)
    tenants_dir = MEMORY_DIR / 'tenants'
    if tenants_dir.is_dir():
        for path in tenants_dir.rglob('bet-plan-audit.jsonl'):
            files.append(path)
    return files


def load_latest_bets():
    latest = {}
    files = load_audit_files()
    if not files:
        return []
    for path in files:
        try:
            lines = path.read_text().splitlines()
        except Exception:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            date = row.get('date')
            if not date:
                continue
            ts = row.get('ts') or row.get('timestamp') or ''
            try:
                ts_val = datetime.fromisoformat(ts.replace('Z','+00:00')) if ts else datetime.min
            except Exception:
                ts_val = datetime.min
            items = row.get('suggestedAll') or row.get('suggestedTop') or []
            for item in items:
                meeting = item.get('meeting') or ''
                race = item.get('race')
                selection = item.get('selection') or ''
                bet_type = (item.get('type') or '').strip().lower()
                odds = item.get('odds') if item.get('odds') is not None else parse_odds(item.get('reason'))
                prob = parse_prob(item.get('reason'))
                key = f"{date}|{meeting}|{race}|{selection}|{bet_type}"
                existing = latest.get(key)
                if not existing or ts_val > existing['ts']:
                    latest[key] = {
                        'date': date,
                        'meeting': meeting,
                        'race': str(race).replace('R','') if race is not None else '',
                        'selection': selection,
                        'type': bet_type,
                        'odds': odds,
                        'prob': prob,
                        'ts': ts_val
                    }
    return list(latest.values())


def build_results_cache(bets):
    results_cache = {}
    dates = sorted({b.get('date') for b in bets if b.get('date')})
    for d in dates:
        results_cache[d] = load_results_for_date(d)
    return results_cache


def evaluate(bets, min_edge=0.0, odds_min=0.0, odds_max=999.0, include_types=('win','odds_runner'), results_cache=None):
    results_cache = results_cache or {}
    total = 0
    wins = 0
    profit = 0.0
    for bet in bets:
        if bet['type'] not in include_types:
            continue
        odds = bet.get('odds')
        prob = bet.get('prob')
        if odds is None or prob is None or odds <= 0:
            continue
        implied = 1.0 / odds
        edge = prob - implied
        if edge < min_edge:
            continue
        if odds < odds_min or odds > odds_max:
            continue
        date = bet['date']
        meeting = bet['meeting']
        race = bet['race']
        if not date or not meeting or not race:
            continue
        positions = results_cache.get(date, {}).get((norm(meeting), str(race)))
        if not positions:
            continue
        winner = positions.get(1)
        if not winner:
            continue
        total += 1
        hit = norm(winner) == norm(bet['selection'])
        if hit:
            wins += 1
            profit += (odds - 1.0)
        else:
            profit -= 1.0
    roi = (profit / total) if total else None
    win_rate = (wins / total) if total else None
    return { 'bets': total, 'wins': wins, 'win_rate': win_rate, 'profit': profit, 'roi': roi }


def evaluate_with_prob(bets, prob_min=0.0, odds_max=999.0, include_types=('win','odds_runner'), results_cache=None):
    results_cache = results_cache or {}
    total = 0
    wins = 0
    profit = 0.0
    for bet in bets:
        if bet['type'] not in include_types:
            continue
        odds = bet.get('odds')
        prob = bet.get('prob')
        if odds is None or prob is None or odds <= 0:
            continue
        if prob < prob_min:
            continue
        if odds > odds_max:
            continue
        date = bet['date']
        meeting = bet['meeting']
        race = bet['race']
        if not date or not meeting or not race:
            continue
        positions = results_cache.get(date, {}).get((norm(meeting), str(race)))
        if not positions:
            continue
        winner = positions.get(1)
        if not winner:
            continue
        total += 1
        hit = norm(winner) == norm(bet['selection'])
        if hit:
            wins += 1
            profit += (odds - 1.0)
        else:
            profit -= 1.0
    roi = (profit / total) if total else None
    win_rate = (wins / total) if total else None
    return { 'bets': total, 'wins': wins, 'win_rate': win_rate, 'profit': profit, 'roi': roi }


def optimize(bets, results_cache):
    baseline = evaluate(bets, min_edge=-1.0, results_cache=results_cache)
    best = None
    grid_edge = [0.00, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.10]
    grid_odds_min = [2.0, 2.5, 3.0, 4.0]
    grid_odds_max = [8.0, 10.0, 12.0, 15.0]
    min_bets_list = [800, 600, 400, 300, 200, 150, 100, 75, 50]

    for min_bets in min_bets_list:
        best = None
        for e in grid_edge:
            for omin in grid_odds_min:
                for omax in grid_odds_max:
                    if omin >= omax:
                        continue
                    r = evaluate(bets, min_edge=e, odds_min=omin, odds_max=omax, results_cache=results_cache)
                    if not r['bets'] or r['bets'] < min_bets:
                        continue
                    if best is None or (r['roi'] or -999) > (best['roi'] or -999):
                        best = {**r, 'min_edge': e, 'odds_min': omin, 'odds_max': omax, 'min_bets': min_bets}
        if best and best['roi'] and best['roi'] > 0:
            return baseline, best

    # fallback: prob-only tightening if no positive edge found
    best_alt = None
    prob_grid = [0.15, 0.20, 0.25, 0.30, 0.35]
    odds_max_grid = [4.0, 5.0, 6.0, 8.0]
    for min_bets in min_bets_list:
        best_alt = None
        for pmin in prob_grid:
            for omax in odds_max_grid:
                r = evaluate_with_prob(bets, prob_min=pmin, odds_max=omax, results_cache=results_cache)
                if not r['bets'] or r['bets'] < min_bets:
                    continue
                if best_alt is None or (r['roi'] or -999) > (best_alt['roi'] or -999):
                    best_alt = {**r, 'prob_min': pmin, 'odds_max': omax, 'min_bets': min_bets}
        if best_alt and best_alt['roi'] and best_alt['roi'] > 0:
            return baseline, {**best_alt, 'mode': 'prob_only'}

    return baseline, best


def main():
    bets = load_latest_bets()
    results_cache = build_results_cache(bets)
    baseline, best = optimize(bets, results_cache)
    out = {
        'baseline': baseline,
        'best': best,
        'notes': 'baseline excludes exotics; optimized filters use p= and odds only; small-sample risk if min_bets drops.'
    }
    OUT_PATH.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == '__main__':
    main()
