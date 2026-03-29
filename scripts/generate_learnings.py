#!/usr/bin/env python3
import json
import os
from collections import defaultdict
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DATA = os.path.join(ROOT, 'frontend', 'data')
TENANTS_DIR = os.path.join(ROOT, 'memory', 'tenants')


def load_json(path, fallback):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback


def summarize(name, rows):
    bets = len(rows)
    if not bets:
        return None
    wins = sum(1 for r in rows if str(r.get('result') or '').lower() in ('win', 'ew_win', 'ew_place'))
    stake = sum(float(r.get('stake_units') or 0) for r in rows)
    profit = sum(float(r.get('profit_units') or 0) for r in rows)
    ret = sum(float(r.get('return_units') or 0) for r in rows)
    odds_vals = [float(r.get('odds')) for r in rows if isinstance(r.get('odds'), (int, float))]
    return {
        'name': name,
        'bets': bets,
        'wins': wins,
        'win_rate': (wins / bets) if bets else None,
        'stake_units': stake,
        'profit_units': profit,
        'return_units': ret,
        'roi': (profit / stake) if stake else None,
        'avg_odds': (sum(odds_vals) / len(odds_vals)) if odds_vals else None,
    }


def odds_band(odds):
    try:
        o = float(odds)
    except Exception:
        return 'unknown'
    if o < 3:
        return '<3'
    if o < 5:
        return '3-5'
    if o < 8:
        return '5-8'
    if o < 12:
        return '8-12'
    return '12+'


def build_learnings(rows):
    if not rows:
        return {
            'window': {},
            'summary': {},
            'by_type': [],
            'by_odds_band': [],
            'by_meeting': [],
            'edge_sources': [],
            'leak_sources': [],
            'recommendations': [],
            'top_bets': [],
            'worst_bets': []
        }

    latest = max((str(r.get('date') or '') for r in rows), default='')
    latest_d = date.fromisoformat(latest)
    start = (latest_d - timedelta(days=6)).isoformat()
    rows = [r for r in rows if str(r.get('date') or '') >= start]

    by_type = defaultdict(list)
    by_odds = defaultdict(list)
    by_meeting = defaultdict(list)
    for r in rows:
        by_type[str(r.get('type') or 'unknown').lower()].append(r)
        by_odds[odds_band(r.get('odds'))].append(r)
        by_meeting[str(r.get('meeting') or 'Unknown')].append(r)

    type_rows = [summarize(k, v) for k, v in by_type.items()]
    type_rows = [x for x in type_rows if x]
    odds_rows = [summarize(k, by_odds[k]) for k in ['<3', '3-5', '5-8', '8-12', '12+', 'unknown'] if by_odds.get(k)]
    meeting_rows = [summarize(k, v) for k, v in by_meeting.items() if len(v) >= 3]
    meeting_rows = [x for x in meeting_rows if x]

    top_bets = sorted(rows, key=lambda r: (float(r.get('profit_units') or -9999), float(r.get('return_units') or -9999)), reverse=True)[:10]
    worst_bets = sorted(rows, key=lambda r: (float(r.get('profit_units') or 9999), float(r.get('return_units') or 9999)))[:10]

    best_type = sorted(type_rows, key=lambda x: (x.get('roi') if x.get('roi') is not None else -999, x.get('profit_units', -999)), reverse=True)
    worst_type = sorted(type_rows, key=lambda x: (x.get('roi') if x.get('roi') is not None else 999, x.get('profit_units', 999)))
    best_bands = sorted(odds_rows, key=lambda x: (x.get('roi') if x.get('roi') is not None else -999, x.get('profit_units', -999)), reverse=True)
    worst_meetings = sorted(meeting_rows, key=lambda x: x.get('profit_units', 999))[:8]
    best_meetings = sorted(meeting_rows, key=lambda x: x.get('profit_units', -999), reverse=True)[:8]

    edge_sources = []
    if best_type:
        x = best_type[0]
        edge_sources.append(f"Best strategy by ROI: {x['name']} — ROI {x['roi']*100:.1f}% from {x['bets']} bets")
    if best_bands:
        x = best_bands[0]
        edge_sources.append(f"Best odds band: {x['name']} — ROI {x['roi']*100:.1f}% from {x['bets']} bets")
    if best_meetings:
        x = best_meetings[0]
        edge_sources.append(f"Top meeting by profit: {x['name']} — {x['profit_units']:+.1f}u from {x['bets']} bets")

    leak_sources = []
    if worst_type:
        x = worst_type[0]
        leak_sources.append(f"Worst strategy by ROI: {x['name']} — ROI {x['roi']*100:.1f}% from {x['bets']} bets")
    if worst_meetings:
        x = worst_meetings[0]
        leak_sources.append(f"Worst meeting by profit: {x['name']} — {x['profit_units']:+.1f}u from {x['bets']} bets")
    short = next((x for x in odds_rows if x['name'] == '3-5'), None)
    if short and short.get('roi') is not None:
        leak_sources.append(f"Short-mid odds are weak: 3-5 band ROI {short['roi']*100:.1f}%")

    recommendations = []
    win_type = next((x for x in type_rows if x['name'] == 'win'), None)
    odds_type = next((x for x in type_rows if x['name'] == 'odds_runner'), None)
    band_812 = next((x for x in odds_rows if x['name'] == '8-12'), None)
    if win_type and (win_type.get('roi') or 0) < 0:
        recommendations.append(f"Tighten WIN selection criteria immediately — current ROI {win_type['roi']*100:.1f}%")
    if odds_type and (odds_type.get('roi') or 0) >= 0:
        recommendations.append(f"Keep ODDS RUNNER active — current ROI {odds_type['roi']*100:.1f}% across {odds_type['bets']} bets")
    if band_812 and (band_812.get('roi') or 0) > 0:
        recommendations.append(f"Bias toward 8-12 odds band — current ROI {band_812['roi']*100:.1f}%")
    for x in worst_meetings[:5]:
        recommendations.append(f"Throttle meeting exposure: {x['name']} ({x['profit_units']:+.1f}u, ROI {x['roi']*100:.1f}%)")

    total_bets = len(rows)
    total_stake = sum(float(r.get('stake_units') or 0) for r in rows)
    total_profit = sum(float(r.get('profit_units') or 0) for r in rows)
    total_return = sum(float(r.get('return_units') or 0) for r in rows)
    wins = sum(1 for r in rows if str(r.get('result') or '').lower() in ('win', 'ew_win', 'ew_place'))

    return {
        'window': {'from': start, 'to': latest, 'days': 7},
        'summary': {
            'bets': total_bets,
            'wins': wins,
            'win_rate': (wins / total_bets) if total_bets else None,
            'stake_units': total_stake,
            'profit_units': total_profit,
            'return_units': total_return,
            'roi': (total_profit / total_stake) if total_stake else None,
        },
        'by_type': sorted(type_rows, key=lambda x: x.get('profit_units', 0), reverse=True),
        'by_odds_band': odds_rows,
        'by_meeting': sorted(meeting_rows, key=lambda x: x.get('profit_units', 0), reverse=True),
        'edge_sources': edge_sources,
        'leak_sources': leak_sources,
        'recommendations': recommendations,
        'top_bets': top_bets,
        'worst_bets': worst_bets,
    }


def write_learnings(base_dir):
    settled = load_json(os.path.join(base_dir, 'settled_bets.json'), [])
    learnings = build_learnings(settled)
    with open(os.path.join(base_dir, 'learnings_report.json'), 'w', encoding='utf-8') as f:
        json.dump(learnings, f, indent=2)


def main():
    write_learnings(FRONTEND_DATA)
    if os.path.isdir(TENANTS_DIR):
        for tenant in os.listdir(TENANTS_DIR):
            td = os.path.join(TENANTS_DIR, tenant, 'frontend-data')
            if os.path.isdir(td):
                write_learnings(td)


if __name__ == '__main__':
    main()
