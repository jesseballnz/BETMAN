#!/usr/bin/env python3
import json, os, re
from collections import defaultdict
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_PATH = os.path.join(ROOT, 'data', 'pedigree', 'bloodlines.v1.json')
MEMORY_DIR = os.path.join(ROOT, 'memory')
TENANTS_DIR = os.path.join(MEMORY_DIR, 'tenants')
DATA_DIR = os.path.join(ROOT, 'data', 'tab')
OUT_REPORT = os.path.join(MEMORY_DIR, 'pedigree-female-family-report.json')


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
            data = load_json(path, {}) or {}
            race = (data.get('data') or {}).get('race') or {}
            runners = (data.get('data') or {}).get('runners') or []
            res = (data.get('data') or {}).get('results') or []
            meeting = race.get('meeting_name') or race.get('display_meeting_name') or ''
            race_no = race.get('race_number')
            if not meeting or race_no is None:
                continue
            winner = None
            for r in res:
                if r.get('position') == 1:
                    winner = norm(r.get('name'))
                    break
            runner_map = {}
            for rr in runners:
                runner_map[norm(rr.get('runner_name') or rr.get('name'))] = {
                    'dam': rr.get('dam'),
                    'dam_sire': rr.get('dam_sire') or rr.get('damSire')
                }
            results[(norm(meeting), str(race_no))] = {'winner': winner, 'runner_map': runner_map}
    return results


def main():
    library = load_json(LIB_PATH, {'bloodlines': {}, 'femaleFamilies': {}, 'crosses': {}})
    family_stats = defaultdict(lambda: {'bets': 0, 'wins': 0})
    results_cache = {}

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
                    if item.get('pedigreeTag') != 'Pedigree Advantage':
                        continue
                    meeting = norm(item.get('meeting'))
                    race = str(item.get('race') or '').replace('R', '')
                    selection = norm(item.get('selection'))
                    result = results.get((meeting, race))
                    if not result:
                        continue
                    runner_meta = result['runner_map'].get(selection) or {}
                    dam = norm(runner_meta.get('dam'))
                    if not dam:
                        continue
                    family_stats[dam]['bets'] += 1
                    if selection == result.get('winner'):
                        family_stats[dam]['wins'] += 1

    updates = []
    for fam, stats in family_stats.items():
        if stats['bets'] < 3:
            continue
        win_rate = stats['wins'] / stats['bets'] if stats['bets'] else 0
        traits = (library.setdefault('femaleFamilies', {}).setdefault(fam, {}).setdefault('traits', {}))
        current_elite = float(traits.get('elite', 0) or 0)
        delta = 0.0
        if win_rate >= 0.30:
            delta = 1.0
        elif win_rate >= 0.20:
            delta = 0.5
        elif win_rate <= 0.05:
            delta = -0.5
        if delta:
            traits['elite'] = round(max(0, current_elite + delta), 2)
            updates.append({'family': fam, 'bets': stats['bets'], 'wins': stats['wins'], 'winRate': round(win_rate, 4), 'newElite': traits['elite']})

    library['updatedAt'] = datetime.utcnow().isoformat() + 'Z'
    with open(LIB_PATH, 'w', encoding='utf-8') as f:
        json.dump(library, f, indent=2)
    report = {'generatedAt': datetime.utcnow().isoformat() + 'Z', 'updates': updates, 'familiesTracked': len(family_stats)}
    with open(OUT_REPORT, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
