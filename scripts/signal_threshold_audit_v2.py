#!/usr/bin/env python3
import json, os, re, math
from collections import defaultdict
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MEMORY_DIR = os.path.join(ROOT, 'memory')
TENANTS_DIR = os.path.join(MEMORY_DIR, 'tenants')
DATA_DIR = os.path.join(ROOT, 'data', 'tab')
OUT = os.path.join(MEMORY_DIR, 'signal-threshold-audit-v2.json')


def norm(text):
    return re.sub(r'[^a-z0-9]+', ' ', (text or '').lower()).strip()


def load_json(path, fallback=None):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback


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


def parse_prob(reason):
    raw = str(reason or '')
    m = re.search(r'p=\s*([0-9]+(?:\.[0-9]+)?)%?', raw, re.I)
    if m:
        return float(m.group(1)) / 100.0
    return None


def load_results_for_date(date):
    out = {}
    date_dir = os.path.join(DATA_DIR, date)
    if not os.path.isdir(date_dir):
        return out
    for root, _, files in os.walk(date_dir):
        for name in files:
            if name != 'event.json':
                continue
            data = load_json(os.path.join(root, name), {}) or {}
            race = (data.get('data') or {}).get('race') or {}
            results = (data.get('data') or {}).get('results') or []
            meeting = race.get('meeting_name') or race.get('display_meeting_name') or ''
            race_no = race.get('race_number')
            if not meeting or race_no is None:
                continue
            winner = None
            for r in results:
                if r.get('position') == 1:
                    winner = norm(r.get('name'))
                    break
            if winner:
                out[(norm(meeting), str(race_no))] = winner
    return out


def bucket_prob(p):
    if p is None: return 'unknown'
    pct = p * 100
    if pct < 10: return '0-10'
    if pct < 15: return '10-15'
    if pct < 20: return '15-20'
    if pct < 25: return '20-25'
    if pct < 30: return '25-30'
    if pct < 35: return '30-35'
    return '35+'


def bucket_edge(edge_pts):
    if edge_pts is None: return 'unknown'
    if edge_pts < 0: return '<0'
    if edge_pts < 2: return '0-2'
    if edge_pts < 4: return '2-4'
    if edge_pts < 6: return '4-6'
    if edge_pts < 10: return '6-10'
    return '10+'


def bucket_conf(c):
    if c is None: return 'unknown'
    if c < 50: return '<50'
    if c < 58: return '50-58'
    if c < 65: return '58-65'
    return '65+'


def bucket_odds(odds):
    if odds is None: return 'unknown'
    if odds < 3: return '<3'
    if odds < 5: return '3-5'
    if odds < 8: return '5-8'
    if odds < 12: return '8-12'
    return '12+'


def ensure(d, key):
    if key not in d:
        d[key] = {'bets': 0, 'wins': 0, 'profit': 0.0, 'odds_sum': 0.0}
    return d[key]


def add_row(store, key, win, profit, odds):
    rec = ensure(store, key)
    rec['bets'] += 1
    rec['wins'] += 1 if win else 0
    rec['profit'] += float(profit)
    rec['odds_sum'] += float(odds or 0)


def summarize(store):
    out = {}
    for key, rec in store.items():
        bets = rec['bets']
        out[key] = {
            'bets': bets,
            'wins': rec['wins'],
            'winRate': (rec['wins'] / bets) if bets else None,
            'roi': (rec['profit'] / bets) if bets else None,
            'avgOdds': (rec['odds_sum'] / bets) if bets else None
        }
    return out


def main():
    results_cache = {}
    by_prob = {}
    by_edge = {}
    by_conf = {}
    by_odds = {}
    by_archetype = {}
    intersections = {}
    rows_seen = 0

    for audit_path in load_audit_files():
        with open(audit_path, 'r', encoding='utf-8') as f:
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
                for item in (row.get('suggestedAll') or row.get('suggestedTop') or []):
                    bet_type = str(item.get('type') or '').lower()
                    if bet_type not in ('win', 'ew', 'odds_runner'):
                        continue
                    meeting = norm(item.get('meeting'))
                    race = str(item.get('race') or '').replace('R', '')
                    sel = norm(item.get('selection'))
                    winner = results.get((meeting, race))
                    if not winner:
                        continue
                    rows_seen += 1
                    win = sel == winner
                    odds = item.get('odds')
                    try:
                        odds = float(odds) if odds is not None else None
                    except Exception:
                        odds = None
                    prob = parse_prob(item.get('reason'))
                    implied = (1.0 / odds) if odds and odds > 0 else None
                    edge_pts = ((prob - implied) * 100.0) if (prob is not None and implied is not None) else None
                    conf = item.get('pedigreeConfidence')
                    try:
                        conf = float(conf) if conf is not None else None
                    except Exception:
                        conf = None
                    archetype = item.get('pedigreeArchetype') or 'unknown'
                    if odds and bet_type == 'ew':
                        place_odds = item.get('place_odds')
                        try:
                            place_odds = float(place_odds) if place_odds is not None else max(1.6, round(odds * 0.25, 2))
                        except Exception:
                            place_odds = max(1.6, round(odds * 0.25, 2))
                        profit = (odds - 1.0) + (place_odds - 1.0) if win else -2.0
                    else:
                        profit = (odds - 1.0) if (win and odds) else -1.0
                    add_row(by_prob, bucket_prob(prob), win, profit, odds or 0)
                    add_row(by_edge, bucket_edge(edge_pts), win, profit, odds or 0)
                    add_row(by_conf, bucket_conf(conf), win, profit, odds or 0)
                    add_row(by_odds, bucket_odds(odds), win, profit, odds or 0)
                    add_row(by_archetype, str(archetype), win, profit, odds or 0)
                    inter_key = f"{bucket_prob(prob)} | {bucket_edge(edge_pts)} | {bucket_odds(odds)}"
                    add_row(intersections, inter_key, win, profit, odds or 0)

    summary = {
        'generatedAt': datetime.utcnow().isoformat() + 'Z',
        'rows': rows_seen,
        'byProbabilityBand': summarize(by_prob),
        'byEdgeBand': summarize(by_edge),
        'byConfidenceBand': summarize(by_conf),
        'byOddsBand': summarize(by_odds),
        'byArchetype': summarize(by_archetype),
        'topIntersections': dict(sorted(summarize(intersections).items(), key=lambda kv: ((kv[1].get('roi') if kv[1].get('roi') is not None else -999), kv[1].get('bets', 0)), reverse=True)[:20])
    }

    recommendations = []
    prob_20_25 = summary['byProbabilityBand'].get('20-25')
    if prob_20_25 and prob_20_25.get('roi') is not None and prob_20_25['roi'] < 0:
        recommendations.append('Raise caution on 20-25% model band; require stronger confirming signals before betting.')
    edge_0_2 = summary['byEdgeBand'].get('0-2')
    if edge_0_2 and edge_0_2.get('roi') is not None and edge_0_2['roi'] < 0:
        recommendations.append('Do not bet 0-2pt edge bands; they are noise, not edge.')
    edge_2_4 = summary['byEdgeBand'].get('2-4')
    if edge_2_4 and edge_2_4.get('roi') is not None and edge_2_4['roi'] < 0:
        recommendations.append('Raise minimum edge threshold above 2 points; current edge floor is too permissive.')
    summary['recommendations'] = recommendations

    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
