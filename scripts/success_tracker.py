#!/usr/bin/env python3
import json
import os
import re
import subprocess
from datetime import datetime, date, timezone, timedelta
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, 'data', 'tab')
FRONTEND_DATA = os.path.join(ROOT, 'frontend', 'data')
MEMORY_DIR = os.path.join(ROOT, 'memory')
TENANTS_DIR = os.path.join(MEMORY_DIR, 'tenants')
MIN_BETS_PER_DAY = int(os.environ.get('BETMAN_MIN_DAY_BETS', '0'))
MIN_ROI_STAKE_PER_DAY = float(os.environ.get('BETMAN_MIN_DAY_STAKE', '0'))
MIN_ROI_COVERAGE = float(os.environ.get('BETMAN_MIN_DAY_ROI_COVERAGE', '0'))
RECENT_DAYS = int(os.environ.get('BETMAN_RECENT_DAYS', '5'))


def parse_date(value):
  try:
    return datetime.strptime(value, '%Y-%m-%d').date()
  except Exception:
    return None


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


def parse_runner_list(selection):
    if not selection:
        return []
    cleaned = selection.replace(' / ', ',').replace('/', ',')
    parts = [p.strip() for p in cleaned.split(',') if p.strip()]
    return parts


def parse_trifecta(selection):
    if not selection:
        return None
    m = re.search(r'1st\s+(.+?)\s*/\s*2nd-3rd\s+box\s+(.+)$', selection, re.IGNORECASE)
    if not m:
        return None
    first = m.group(1).strip()
    box = [p.strip() for p in m.group(2).split(',') if p.strip()]
    return { 'first': first, 'box': box }


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


def detect_tenant_id(path):
    marker = os.path.join('memory', 'tenants') + os.sep
    if marker in path:
        tail = path.split(marker, 1)[1]
        return tail.split(os.sep, 1)[0]
    return 'default'


def load_bets_by_tenant():
    bets = defaultdict(dict)
    for path in load_audit_files():
        tenant_id = detect_tenant_id(path)
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
                ts = row.get('ts') or row.get('timestamp') or ''
                try:
                    ts_val = datetime.fromisoformat(ts.replace('Z','+00:00')) if ts else datetime.min
                except Exception:
                    ts_val = datetime.min
                const_suggested = row.get('suggestedAll') or row.get('suggestedTop') or []
                for item in const_suggested:
                    meeting = item.get('meeting') or ''
                    race = item.get('race')
                    selection = item.get('selection') or ''
                    bet_type = item.get('type') or ''
                    odds = item.get('odds') if item.get('odds') is not None else parse_odds(item.get('reason') or '')
                    place_odds = item.get('place_odds') if item.get('place_odds') is not None else None
                    key = f"{date}|{meeting}|{race}|{selection}|{bet_type}"
                    existing = bets[tenant_id].get(key)
                    if not existing or ts_val > existing['ts']:
                        bets[tenant_id][key] = {
                            'date': date,
                            'meeting': meeting,
                            'race': str(race).replace('R','') if race is not None else '',
                            'selection': selection,
                            'type': bet_type,
                            'odds': odds,
                            'place_odds': place_odds,
                            'pedigreeTag': item.get('pedigreeTag'),
                            'pedigreeScore': item.get('pedigreeScore'),
                            'pedigreeConfidence': item.get('pedigreeConfidence'),
                            'pedigreeRelativeEdge': item.get('pedigreeRelativeEdge'),
                            'pedigreeArchetype': item.get('pedigreeArchetype'),
                            'ts': ts_val
                        }
                for item in row.get('interestingTop', []) or []:
                    meeting = item.get('meeting') or ''
                    race = item.get('race')
                    selection = item.get('runner') or item.get('selection') or ''
                    bet_type = 'odds_runner'
                    odds = item.get('odds')
                    key = f"{date}|{meeting}|{race}|{selection}|{bet_type}"
                    existing = bets[tenant_id].get(key)
                    if not existing or ts_val > existing['ts']:
                        bets[tenant_id][key] = {
                            'date': date,
                            'meeting': meeting,
                            'race': str(race).replace('R','') if race is not None else '',
                            'selection': selection,
                            'type': bet_type,
                            'odds': odds,
                            'ts': ts_val
                        }
    return {k: list(v.values()) for k, v in bets.items()}


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
            positions = {r.get('position'): r.get('name') for r in res if r.get('position') and r.get('name')}
            if not positions:
                continue
            dividends_raw = (data.get('data') or {}).get('dividends') or []
            dividends = {}
            for d in dividends_raw:
                name = str(d.get('product_name') or '').lower()
                div = d.get('dividend')
                if not isinstance(div, (int, float)):
                    continue
                if 'quinella' in name:
                    dividends['quinella'] = div
                elif 'trifecta' in name:
                    dividends['trifecta'] = div
                elif 'first4' in name or 'first 4' in name:
                    dividends['first4'] = div
            key = (norm(meeting), str(race_no))
            results[key] = { 'positions': positions, 'dividends': dividends }
    return results


def count_races_for_date(date):
    date_dir = os.path.join(DATA_DIR, date)
    if not os.path.isdir(date_dir):
        return 0
    seen = set()
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
            seen.add((norm(meeting), str(race_no)))
    return len(seen)


def evaluate_bets(bets):
    results_cache = {}
    daily = {}
    races_seen = defaultdict(set)
    races_won = defaultdict(set)
    races_total = {}

    def ensure_day(date):
        if date not in daily:
            daily[date] = {
                'total_bets': 0,
                'total_stake': 0,
                'roi_stake': 0,
                'win_bets': 0,
                'wins': 0,
                'roi_rec_profit': 0.0,
                'roi_sp_profit': 0.0,
                'roi_tote_profit': 0.0,
                'roi_ew_profit': 0.0,
                'exotic_bets': 0,
                'exotic_hits': 0,
                'exotic_roi_profit': 0.0,
                'exotic_roi_stake': 0.0,
                'pick_breakdown': {
                    'win': { 'bets': 0, 'stake_units': 0, 'roi_stake_units': 0, 'wins': 0, 'roi_rec_profit': 0.0, 'roi_sp_profit': 0.0, 'roi_tote_profit': 0.0, 'roi_ew_profit': 0.0 },
                    'odds_runner': { 'bets': 0, 'stake_units': 0, 'roi_stake_units': 0, 'wins': 0, 'roi_rec_profit': 0.0, 'roi_sp_profit': 0.0, 'roi_tote_profit': 0.0, 'roi_ew_profit': 0.0 },
                    'ew': { 'bets': 0, 'stake_units': 0, 'roi_stake_units': 0, 'wins': 0, 'roi_rec_profit': 0.0, 'roi_sp_profit': 0.0, 'roi_tote_profit': 0.0, 'roi_ew_profit': 0.0 }
                },
                'exotic_breakdown': {
                    'top2': { 'bets': 0, 'hits': 0, 'roi_profit': 0.0, 'roi_stake': 0.0 },
                    'top3': { 'bets': 0, 'hits': 0, 'roi_profit': 0.0, 'roi_stake': 0.0 },
                    'top4': { 'bets': 0, 'hits': 0, 'roi_profit': 0.0, 'roi_stake': 0.0 },
                    'trifecta': { 'bets': 0, 'hits': 0, 'roi_profit': 0.0, 'roi_stake': 0.0 }
                },
                'long_breakdown': { 'bets': 0, 'stake_units': 0, 'roi_stake_units': 0, 'wins': 0, 'roi_rec_profit': 0.0, 'roi_sp_profit': 0.0, 'roi_tote_profit': 0.0, 'roi_ew_profit': 0.0 },
                'pedigree_breakdown': {
                    'bets': 0, 'stake_units': 0, 'roi_stake_units': 0, 'wins': 0, 'roi_rec_profit': 0.0,
                    'score_sum': 0.0, 'score_count': 0, 'confidence_sum': 0.0, 'confidence_count': 0,
                    'edge_sum': 0.0, 'edge_count': 0, 'archetypes': {}
                }
            }
        return daily[date]

    for bet in bets:
        date = bet['date']
        meeting = bet['meeting']
        race = bet['race']
        if not date or not meeting or not race:
            continue
        if date not in results_cache:
            results_cache[date] = load_results_for_date(date)
            races_total[date] = count_races_for_date(date)
        results = results_cache[date]
        race_key = (norm(meeting), str(race))
        race_result = results.get(race_key)
        if not race_result:
            continue
        positions = race_result.get('positions') or {}
        dividends = race_result.get('dividends') or {}
        if not positions:
            continue

        race_id = f"{race_key[0]}|{race_key[1]}"
        races_seen[date].add(race_id)

        day = ensure_day(date)
        bet_type = (bet.get('type') or '').strip().lower()
        selection = bet.get('selection') or ''
        odds = bet.get('odds')
        if odds is None:
            odds = parse_odds(bet.get('reason'))
        if bet_type == 'win' and odds is not None and odds >= 8:
            bet_type = 'ew'

        def add_profit(target, profit, stake_units):
            day['roi_rec_profit'] += profit
            day['roi_stake'] += stake_units
            target['roi_rec_profit'] += profit
            target['roi_stake_units'] += stake_units

        if bet_type in ['win', 'odds_runner', 'ew']:
            stake_units = 2 if bet_type == 'ew' else 1
            day['total_bets'] += 1
            day['total_stake'] += stake_units
            day['win_bets'] += 1
            pick_key = bet_type if bet_type in day['pick_breakdown'] else 'win'
            pick = day['pick_breakdown'][pick_key]
            pick['bets'] += 1
            pick['stake_units'] += stake_units

            pos_by_name = { norm(name): pos for pos, name in positions.items() }
            winner = positions.get(1)
            if bet_type == 'ew':
                sel_pos = pos_by_name.get(norm(selection))
                hit = bool(sel_pos and sel_pos <= 3)
            else:
                hit = norm(selection) == norm(winner)
            if hit:
                day['wins'] += 1
                pick['wins'] += 1
                races_won[date].add(race_id)
            profit = None
            if odds is not None:
                if bet_type == 'ew':
                    place_odds = bet.get('place_odds')
                    # Fallback proxy when place price is missing in audit payload:
                    # use a conservative quarter-odds approximation so EW metrics remain populated.
                    if place_odds is None and odds is not None:
                        place_odds = max(1.6, round(float(odds) * 0.25, 2))
                    if place_odds is not None:
                        if pos_by_name.get(norm(selection)) == 1:
                            profit = (odds - 1.0) + (place_odds - 1.0)
                        elif hit:
                            profit = (place_odds - 1.0) - 1.0
                        else:
                            profit = -2.0
                else:
                    profit = (odds - 1.0) if hit else -1.0
            if profit is not None:
                add_profit(pick, profit, stake_units)
                if bet.get('pedigreeTag') == 'Pedigree Advantage':
                    ped = day['pedigree_breakdown']
                    ped['bets'] += 1
                    ped['stake_units'] += stake_units
                    ped['roi_stake_units'] += stake_units
                    if hit:
                        ped['wins'] += 1
                    ped['roi_rec_profit'] += profit
                    try:
                        score = float(bet.get('pedigreeScore'))
                        ped['score_sum'] += score
                        ped['score_count'] += 1
                    except Exception:
                        pass
                    try:
                        conf = float(bet.get('pedigreeConfidence'))
                        ped['confidence_sum'] += conf
                        ped['confidence_count'] += 1
                    except Exception:
                        pass
                    try:
                        edge = float(bet.get('pedigreeRelativeEdge'))
                        ped['edge_sum'] += edge
                        ped['edge_count'] += 1
                    except Exception:
                        pass
                    arch = bet.get('pedigreeArchetype')
                    if arch:
                        bucket = ped['archetypes'].setdefault(arch, { 'bets': 0, 'wins': 0, 'profit': 0.0 })
                        bucket['bets'] += 1
                        if hit:
                            bucket['wins'] += 1
                        bucket['profit'] += profit
                if odds is not None and odds >= 12:
                    long_pick = day['long_breakdown']
                    long_pick['bets'] += 1
                    long_pick['stake_units'] += stake_units
                    long_pick['roi_stake_units'] += stake_units
                    if hit:
                        long_pick['wins'] += 1
                    long_pick['roi_rec_profit'] += profit
        elif bet_type.startswith('top'):
            try:
                top_n = int(re.sub(r'[^0-9]', '', bet_type))
            except Exception:
                top_n = None
            if top_n:
                picks = [norm(x) for x in parse_runner_list(selection)]
                top_positions = {norm(name) for pos, name in positions.items() if pos and pos <= top_n}
                hit = picks and all(p in top_positions for p in picks)
                day['exotic_bets'] += 1
                day['total_bets'] += 1
                day['total_stake'] += 1
                key = f'top{top_n}'
                if key in day['exotic_breakdown']:
                    day['exotic_breakdown'][key]['bets'] += 1
                    if hit:
                        day['exotic_breakdown'][key]['hits'] += 1
                        day['exotic_hits'] += 1
                        races_won[date].add(race_id)
                roi_profit = None
                if hit:
                    payout = None
                    if top_n == 2:
                        payout = dividends.get('quinella')
                    elif top_n == 3:
                        payout = dividends.get('trifecta')
                    elif top_n == 4:
                        payout = dividends.get('first4')
                    if isinstance(payout, (int, float)):
                        roi_profit = payout - 1.0
                else:
                    roi_profit = -1.0
                if roi_profit is not None:
                    day['exotic_roi_profit'] += roi_profit
                    day['exotic_roi_stake'] += 1.0
                    if key in day['exotic_breakdown']:
                        day['exotic_breakdown'][key]['roi_profit'] += roi_profit
                        day['exotic_breakdown'][key]['roi_stake'] += 1.0
        elif bet_type == 'trifecta':
            parsed = parse_trifecta(selection)
            if parsed:
                first = norm(parsed['first'])
                box = {norm(x) for x in parsed['box']}
                pos1 = norm(positions.get(1, ''))
                pos2 = norm(positions.get(2, ''))
                pos3 = norm(positions.get(3, ''))
                hit = pos1 == first and pos2 in box and pos3 in box
                day['exotic_bets'] += 1
                day['total_bets'] += 1
                day['total_stake'] += 1
                day['exotic_breakdown']['trifecta']['bets'] += 1
                if hit:
                    day['exotic_breakdown']['trifecta']['hits'] += 1
                    day['exotic_hits'] += 1
                    races_won[date].add(race_id)
                roi_profit = None
                if hit:
                    payout = dividends.get('trifecta')
                    if isinstance(payout, (int, float)):
                        roi_profit = payout - 1.0
                else:
                    roi_profit = -1.0
                if roi_profit is not None:
                    day['exotic_roi_profit'] += roi_profit
                    day['exotic_roi_stake'] += 1.0
                    day['exotic_breakdown']['trifecta']['roi_profit'] += roi_profit
                    day['exotic_breakdown']['trifecta']['roi_stake'] += 1.0

    # finalize daily stats
    out = {}
    for date, d in daily.items():
        total = d['total_bets']
        win_bets = d.get('win_bets', 0)
        wins = d.get('wins', 0)
        win_rate = (wins / win_bets) if win_bets else None
        total_stake = d.get('total_stake', total)
        roi_stake_base = d.get('roi_stake', total_stake)
        exotic_roi_stake = d.get('exotic_roi_stake', 0)
        roi_stake_total = roi_stake_base + exotic_roi_stake
        roi_rec_profit_total = d['roi_rec_profit'] + d.get('exotic_roi_profit', 0)
        roi_rec_base = (d['roi_rec_profit'] / roi_stake_base) if roi_stake_base else None
        roi_rec = (roi_rec_profit_total / roi_stake_total) if roi_stake_total else None
        roi_sp = None
        roi_tote = None
        roi_ew = None
        exotic_hit_rate = (d['exotic_hits'] / d['exotic_bets']) if d['exotic_bets'] else None
        exotic_roi = (d['exotic_roi_profit'] / d['exotic_roi_stake']) if d['exotic_roi_stake'] else None

        pick_breakdown = {}
        for key, pdata in d['pick_breakdown'].items():
            pbets = pdata['bets']
            pwins = pdata['wins']
            stake_units = pdata.get('stake_units', pbets)
            roi_stake = pdata.get('roi_stake_units', stake_units)
            pick_breakdown[key] = {
                'bets': pbets,
                'stake_units': stake_units,
                'roi_stake_units': roi_stake,
                'win_rate': (pwins / pbets) if pbets else None,
                'roi_rec': (pdata['roi_rec_profit'] / roi_stake) if roi_stake else None,
                'roi_sp': None,
                'roi_tote': None,
                'roi_ew': None
            }

        exotic_breakdown = {}
        for key, pdata in d['exotic_breakdown'].items():
            ebets = pdata['bets']
            ehits = pdata['hits']
            roi_stake = pdata.get('roi_stake', 0)
            roi_profit = pdata.get('roi_profit', 0)
            exotic_breakdown[key] = {
                'bets': ebets,
                'hit_rate': (ehits / ebets) if ebets else None,
                'roi_tote': (roi_profit / roi_stake) if roi_stake else None
            }

        long_pick = d.get('long_breakdown') or {}
        long_bets = long_pick.get('bets', 0)
        long_wins = long_pick.get('wins', 0)
        long_stake = long_pick.get('stake_units', long_bets)
        long_roi_stake = long_pick.get('roi_stake_units', long_stake)
        long_breakdown = {
            'bets': long_bets,
            'stake_units': long_stake,
            'roi_stake_units': long_roi_stake,
            'win_rate': (long_wins / long_bets) if long_bets else None,
            'roi_rec': (long_pick.get('roi_rec_profit', 0) / long_roi_stake) if long_roi_stake else None,
            'roi_sp': None,
            'roi_tote': None,
            'roi_ew': None
        }

        pedigree_pick = d.get('pedigree_breakdown') or {}
        pedigree_bets = pedigree_pick.get('bets', 0)
        pedigree_wins = pedigree_pick.get('wins', 0)
        pedigree_stake = pedigree_pick.get('stake_units', pedigree_bets)
        pedigree_roi_stake = pedigree_pick.get('roi_stake_units', pedigree_stake)
        pedigree_breakdown = {
            'bets': pedigree_bets,
            'stake_units': pedigree_stake,
            'roi_stake_units': pedigree_roi_stake,
            'win_rate': (pedigree_wins / pedigree_bets) if pedigree_bets else None,
            'roi_rec': (pedigree_pick.get('roi_rec_profit', 0) / pedigree_roi_stake) if pedigree_roi_stake else None,
            'avg_score': (pedigree_pick.get('score_sum', 0) / pedigree_pick.get('score_count', 1)) if pedigree_pick.get('score_count', 0) else None,
            'avg_confidence': (pedigree_pick.get('confidence_sum', 0) / pedigree_pick.get('confidence_count', 1)) if pedigree_pick.get('confidence_count', 0) else None,
            'avg_edge': (pedigree_pick.get('edge_sum', 0) / pedigree_pick.get('edge_count', 1)) if pedigree_pick.get('edge_count', 0) else None,
            'archetypes': pedigree_pick.get('archetypes', {})
        }

        out[date] = {
            'total_bets': total,
            'total_stake': total_stake,
            'roi_stake': roi_stake_total,
            'roi_stake_base': roi_stake_base,
            'win_bets': win_bets,
            'wins': wins,
            'win_rate': win_rate,
            'races_run': races_total.get(date, len(results_cache.get(date, {}))),
            'races_played': len(races_seen.get(date, set())),
            'races_won': len(races_won.get(date, set())),
            'roi_rec': roi_rec,
            'roi_rec_base': roi_rec_base,
            'roi_sp': roi_sp,
            'roi_tote': roi_tote,
            'roi_ew': roi_ew,
            'exotic_hit_rate': exotic_hit_rate,
            'exotic_roi_tote': exotic_roi,
            'exotic_roi_stake': d.get('exotic_roi_stake', 0),
            'pick_breakdown': pick_breakdown,
            'exotic_breakdown': exotic_breakdown,
            'long_breakdown': long_breakdown,
            'pedigree_breakdown': pedigree_breakdown
        }

    filtered = {}
    for k, v in out.items():
        total_bets = v.get('total_bets', 0)
        roi_stake = v.get('roi_stake', 0)
        total_stake = v.get('total_stake', 0)
        coverage = (roi_stake / total_stake) if total_stake else 0
        if total_bets < MIN_BETS_PER_DAY:
            continue
        if roi_stake < MIN_ROI_STAKE_PER_DAY:
            continue
        if coverage < MIN_ROI_COVERAGE:
            continue
        filtered[k] = v

    cutoff = datetime.now(timezone.utc).date() - timedelta(days=RECENT_DAYS)
    recent = {}
    for k, v in filtered.items():
        d = parse_date(k)
        if d and d < cutoff:
            continue
        recent[k] = v
    return recent


def group_periods(daily, mode):
    grouped = defaultdict(lambda: {
        'total_bets': 0,
        'total_stake': 0,
        'roi_stake': 0,
        'win_bets': 0,
        'wins': 0,
        'races_run': 0,
        'races_played': 0,
        'races_won': 0,
        'roi_rec_profit': 0.0,
        'roi_sp_profit': 0.0,
        'roi_tote_profit': 0.0,
        'roi_ew_profit': 0.0,
        'exotic_bets': 0,
        'exotic_hits': 0,
        'exotic_roi_profit': 0.0,
        'exotic_roi_stake': 0.0
    })

    for date, d in daily.items():
        try:
            dt = datetime.strptime(date, '%Y-%m-%d').date()
        except Exception:
            continue
        if mode == 'weekly':
            year, week, _ = dt.isocalendar()
            key = f"{year}-W{week:02d}"
        else:
            key = f"{dt.year}-{dt.month:02d}"

        g = grouped[key]
        g['total_bets'] += d.get('total_bets', 0)
        g['total_stake'] += d.get('total_stake', d.get('total_bets', 0))
        g['roi_stake'] += d.get('roi_stake', d.get('total_stake', d.get('total_bets', 0)))
        g['win_bets'] += d['win_bets']
        g['wins'] += d['wins']
        g['races_run'] += d.get('races_run', 0)
        g['races_played'] += d.get('races_played', d.get('races_run', 0))
        g['races_won'] += d.get('races_won', 0)
        if isinstance(d['roi_rec'], (int, float)):
            g['roi_rec_profit'] += d['roi_rec'] * (d.get('roi_stake', d.get('total_stake', d.get('total_bets', 0))) or 0)
        if isinstance(d['exotic_hit_rate'], (int, float)):
            g['exotic_hits'] += d['exotic_hit_rate'] * (d.get('exotic_bets') or 0)
        g['exotic_bets'] += d.get('exotic_bets') or 0
        if isinstance(d.get('exotic_roi_tote'), (int, float)) and d.get('exotic_roi_stake'):
            g['exotic_roi_profit'] += d['exotic_roi_tote'] * d.get('exotic_roi_stake')
            g['exotic_roi_stake'] += d.get('exotic_roi_stake')

    out = {}
    for key, g in grouped.items():
        total = g['total_bets']
        total_stake = g.get('total_stake', total)
        roi_stake = g.get('roi_stake', total_stake)
        win_bets = g['win_bets']
        wins = g['wins']
        out[key] = {
            'total_bets': total,
            'total_stake': total_stake,
            'roi_stake': roi_stake,
            'win_bets': win_bets,
            'wins': wins,
            'races_run': g.get('races_run', 0),
            'races_played': g.get('races_played', 0),
            'races_won': g.get('races_won', 0),
            'win_rate': (wins / win_bets) if win_bets else None,
            'roi_rec': (g['roi_rec_profit'] / roi_stake) if roi_stake else None,
            'roi_sp': None,
            'roi_tote': None,
            'roi_ew': None,
            'exotic_hit_rate': (g['exotic_hits'] / g['exotic_bets']) if g['exotic_bets'] else None,
            'exotic_roi_tote': (g['exotic_roi_profit'] / g['exotic_roi_stake']) if g['exotic_roi_stake'] else None
        }
    return out


def write_outputs(base_dir, daily, weekly, monthly):
    os.makedirs(base_dir, exist_ok=True)
    with open(os.path.join(base_dir, 'success_daily.json'), 'w', encoding='utf-8') as f:
        json.dump(daily, f, indent=2)
    with open(os.path.join(base_dir, 'success_weekly.json'), 'w', encoding='utf-8') as f:
        json.dump(weekly, f, indent=2)
    with open(os.path.join(base_dir, 'success_monthly.json'), 'w', encoding='utf-8') as f:
        json.dump(monthly, f, indent=2)


def sync_to_db(tenant_id):
    db_url = os.environ.get('BETMAN_DATABASE_URL') or os.environ.get('DATABASE_URL')
    if not db_url:
        return
    try:
        subprocess.run(
            [
                'node',
                os.path.join(ROOT, 'scripts', 'db_sync.js'),
                f'--tenant={tenant_id}',
                '--keys=success_daily.json,success_weekly.json,success_monthly.json',
                '--audit=none'
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False
        )
    except Exception:
        pass


def main():
    bets_by_tenant = load_bets_by_tenant()
    if not bets_by_tenant:
        return
    for tenant_id, bets in bets_by_tenant.items():
        daily = evaluate_bets(bets)
        weekly = group_periods(daily, 'weekly')
        monthly = group_periods(daily, 'monthly')
        if tenant_id == 'default':
            write_outputs(FRONTEND_DATA, daily, weekly, monthly)
        else:
            tenant_dir = os.path.join(TENANTS_DIR, tenant_id, 'frontend-data')
            write_outputs(tenant_dir, daily, weekly, monthly)

        sync_to_db(tenant_id)

        today = datetime.now(timezone.utc).date()
        latest_daily_key = max(daily.keys()) if daily else None
        if latest_daily_key:
            latest_daily_date = parse_date(latest_daily_key)
            if latest_daily_date:
                delta = (today - latest_daily_date).days
                if delta > 1:
                    print(f"[success_tracker][WARN] {tenant_id}: latest settled date {latest_daily_key} is {delta} days old")
        else:
            print(f"[success_tracker][WARN] {tenant_id}: no settled days recorded")

        audit_dates = [bet.get('date') for bet in bets if bet.get('date')]
        if audit_dates:
            latest_audit_key = max(audit_dates)
            audit_date = parse_date(latest_audit_key)
            if audit_date:
                audit_delta = (today - audit_date).days
                if audit_delta > 1:
                    print(f"[success_tracker][WARN] {tenant_id}: no audit entries since {latest_audit_key}")
        else:
            print(f"[success_tracker][WARN] {tenant_id}: no audit log entries found")


if __name__ == '__main__':
    main()
