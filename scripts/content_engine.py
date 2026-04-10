#!/usr/bin/env python3
import json
import re
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = BASE_DIR / 'frontend' / 'data'
OUT_QUEUE = DATA_DIR / 'content_queue.json'
OUT_DAILY = DATA_DIR / 'content_daily.json'
OUT_WEEKLY = DATA_DIR / 'content_weekly.json'


def load_json(path, fallback):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2)


def to_float(value):
    try:
        return float(value)
    except Exception:
        return None


def to_int(value):
    try:
        return int(value)
    except Exception:
        return None


def ensure_rows(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ('items', 'rows', 'alerts', 'data', 'marketMovers', 'suggestedBets', 'interestingRunners', 'upcomingRaces'):
            value = payload.get(key)
            if isinstance(value, list):
                return value
        return []
    return []


def parse_minutes(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().lower()
    if not text or text in {'jumped', 'closed', 'live', 'now'}:
        return 0.0
    m = re.search(r'(-?\d+(?:\.\d+)?)\s*m', text)
    if m:
        return float(m.group(1))
    return None


def norm_meeting(value):
    return str(value or '').strip()


def norm_race(value):
    iv = to_int(value)
    return str(iv) if iv is not None else str(value or '').strip()


def runner_key(meeting, race, selection, kind=''):
    return '|'.join([
        norm_meeting(meeting).lower(),
        norm_race(race).lower(),
        str(selection or '').strip().lower(),
        kind.lower(),
    ])


def race_key(meeting, race):
    return f"{norm_meeting(meeting).lower()}|{norm_race(race).lower()}"


def top_wins(settled_rows, limit=5):
    winners = []
    for row in settled_rows:
        profit = to_float(row.get('profit_units'))
        odds = to_float(row.get('odds'))
        if profit is None or profit <= 0:
            continue
        winners.append({
            'date': row.get('date') or row.get('settled_at'),
            'meeting': row.get('meeting'),
            'race': row.get('race'),
            'selection': row.get('selection'),
            'type': row.get('type') or row.get('betType'),
            'odds': odds,
            'profit': profit,
            'stake': to_float(row.get('stake_units')),
            'result': row.get('result'),
        })
    winners.sort(key=lambda x: (x['profit'] or 0, x['odds'] or 0), reverse=True)
    return winners[:limit]


def top_alerts(alert_rows, limit=5):
    scored = []
    seen = set()
    severity_score = {'critical': 4, 'hot': 3, 'watch': 2, 'action': 2, 'info': 1}
    for row in ensure_rows(alert_rows):
        meeting = row.get('meeting')
        race = row.get('race') or row.get('raceNumber')
        runner = row.get('runner') or row.get('selection')
        severity = str(row.get('severity') or row.get('level') or '').lower() or 'info'
        mins = parse_minutes(row.get('minsToJump'))
        status = str(row.get('status') or '').lower()
        reason = row.get('reason') or row.get('message')
        if status == 'settled':
            continue
        if mins is not None and mins < -10:
            continue
        key = runner_key(meeting, race, runner, severity)
        if key in seen:
            continue
        seen.add(key)
        score = severity_score.get(severity, 1) * 100
        if mins is not None:
            score += max(0, 30 - mins)
        if status == 'live':
            score += 15
        move_pct = abs(to_float(row.get('movePct')) or 0)
        score += min(60, move_pct)
        scored.append({
            'timestamp': row.get('timestamp') or row.get('createdAt') or row.get('ts'),
            'meeting': meeting,
            'race': norm_race(race),
            'runner': runner,
            'reason': reason,
            'severity': severity,
            'score': round(score, 1),
            'minsToJump': mins,
            'status': row.get('status'),
            'action': row.get('action'),
            'betmanRole': row.get('betmanRole'),
            'movePct': to_float(row.get('movePct')),
        })
    scored.sort(key=lambda x: ((x['score'] or 0), -(x.get('minsToJump') if x.get('minsToJump') is not None else 9999)), reverse=True)
    return scored[:limit]


def select_upcoming_edges(status_payload, limit=6):
    rows = ensure_rows(status_payload.get('suggestedBets') if isinstance(status_payload, dict) else [])
    selected = []
    seen_races = set()
    for row in sorted(rows, key=lambda x: ((to_float(x.get('signal_score')) or 0), (to_float(x.get('aiWinProb')) or 0)), reverse=True):
        bet_type = str(row.get('betType') or row.get('type') or '').lower()
        if bet_type not in {'top2', 'top3', 'trifecta', 'top4'}:
            continue
        if bet_type not in {'top2', 'trifecta'}:
            continue
        meeting = row.get('meeting')
        race = row.get('race') or row.get('raceNumber')
        rk = race_key(meeting, race)
        if rk in seen_races:
            continue
        seen_races.add(rk)
        selected.append({
            'meeting': meeting,
            'race': norm_race(race),
            'selection': row.get('selection'),
            'type': bet_type,
            'signalScore': to_float(row.get('signal_score')),
            'aiWinProb': to_float(row.get('aiWinProb')),
            'jumpsInMin': parse_minutes(row.get('jumpsIn')),
            'reason': row.get('reason'),
            'country': row.get('country'),
        })
        if len(selected) >= limit:
            break
    return selected


def select_interesting_runners(status_payload, limit=6):
    rows = ensure_rows(status_payload.get('interestingRunners') if isinstance(status_payload, dict) else [])
    scored = []
    seen = set()
    for row in rows:
        odds = to_float(row.get('odds'))
        mins = parse_minutes(row.get('eta'))
        if odds is None or odds < 7 or odds > 80:
            continue
        if mins is not None and mins <= 0:
            continue
        meeting = row.get('meeting')
        race = row.get('race')
        runner = row.get('runner')
        key = runner_key(meeting, race, runner, 'interesting')
        if key in seen:
            continue
        seen.add(key)
        score = min(50, odds) + max(0, 60 - (mins or 999))
        if 'watchlist' in str(row.get('reason') or '').lower():
            score += 10
        scored.append({
            'meeting': meeting,
            'race': norm_race(race),
            'runner': runner,
            'odds': odds,
            'eta': row.get('eta'),
            'minsToJump': mins,
            'reason': row.get('reason'),
            'country': row.get('country'),
            'score': round(score, 1),
        })
    scored.sort(key=lambda x: (x['score'], -x['odds']), reverse=True)
    return scored[:limit]


def select_market_movers(movers_payload, limit=6):
    rows = ensure_rows(movers_payload.get('marketMovers') if isinstance(movers_payload, dict) else movers_payload)
    scored = []
    seen = set()
    nowish_cutoff = -5
    stale_cutoff = 180
    for row in rows:
        pct = to_float(row.get('pctMove'))
        to_odds = to_float(row.get('toOdds'))
        mins = to_float(row.get('minsToJump'))
        fresh = row.get('fresh')
        if pct is None or to_odds is None:
            continue
        if abs(pct) < 8 or abs(pct) > 200:
            continue
        if to_odds < 1.4 or to_odds > 100:
            continue
        if mins is not None and mins < nowish_cutoff:
            continue
        if mins is not None and mins > stale_cutoff:
            continue
        if fresh is False:
            continue
        meeting = row.get('meeting')
        race = row.get('race')
        runner = row.get('runner')
        key = runner_key(meeting, race, runner, 'mover')
        if key in seen:
            continue
        seen.add(key)
        score = abs(pct) + max(0, 40 - (mins or 999))
        if str(row.get('direction') or '').lower() == 'firm':
            score += 10
        scored.append({
            'meeting': meeting,
            'race': norm_race(race),
            'runner': runner,
            'direction': row.get('direction'),
            'fromOdds': to_float(row.get('fromOdds')),
            'toOdds': to_odds,
            'pctMove': pct,
            'minsToJump': mins,
            'eta': row.get('eta'),
            'country': row.get('country'),
            'score': round(score, 1),
        })
    scored.sort(key=lambda x: (x['score'], -abs(x['pctMove'] or 0)), reverse=True)
    return scored[:limit]


def select_live_race_radar(status_payload, alerts, upcoming_edges=None, movers=None, interesting_runners=None, limit=5):
    upcoming = ensure_rows(status_payload.get('upcomingRaces') if isinstance(status_payload, dict) else [])
    alert_races = {race_key(a.get('meeting'), a.get('race')) for a in (alerts or [])}
    edge_races = {race_key(a.get('meeting'), a.get('race')) for a in (upcoming_edges or [])}
    mover_races = {race_key(a.get('meeting'), a.get('race')) for a in (movers or [])}
    runner_races = {race_key(a.get('meeting'), a.get('race')) for a in (interesting_runners or [])}
    selected = []
    seen = set()
    for row in upcoming:
        meeting = row.get('meeting')
        race = row.get('race')
        rk = race_key(meeting, race)
        if rk in seen:
            continue
        seen.add(rk)
        score = 0
        if rk in alert_races:
            score += 40
        if rk in edge_races:
            score += 30
        if rk in mover_races:
            score += 20
        if rk in runner_races:
            score += 15
        if meeting:
            score += 5
        selected.append({
            'meeting': meeting,
            'race': norm_race(race),
            'name': row.get('name'),
            'start': row.get('start'),
            'status': row.get('status'),
            'hasLiveSignal': rk in alert_races,
            'score': score,
        })
    selected.sort(key=lambda x: (x['score'], x['meeting'] or '', x['race'] or ''), reverse=True)
    return selected[:limit]


def daily_summary(success_daily):
    if not isinstance(success_daily, dict) or not success_daily:
        return None
    latest_key = sorted(success_daily.keys())[-1]
    row = success_daily.get(latest_key) or {}
    return {
        'date': latest_key,
        'total_bets': row.get('total_bets'),
        'win_bets': row.get('win_bets'),
        'win_rate': row.get('win_rate'),
        'roi_rec': row.get('roi_rec'),
        'exotic_hit_rate': row.get('exotic_hit_rate'),
        'exotic_roi_tote': row.get('exotic_roi_tote'),
    }


def build_post_from_win(item):
    meeting = item.get('meeting') or 'Unknown meeting'
    race = item.get('race') or '?'
    selection = item.get('selection') or 'Unknown runner'
    odds = item.get('odds')
    profit = item.get('profit')
    odds_text = f"${odds:.2f}" if isinstance(odds, (int, float)) else 'priced up'
    profit_text = f"+{profit:.1f}u" if isinstance(profit, (int, float)) else 'positive return'
    return {
        'kind': 'win-highlight',
        'headline': f"BETMAN found a winner at {meeting} R{race}",
        'short': f"{selection} landed at {odds_text} for {profit_text}.",
        'post': f"BETMAN flagged {selection} in {meeting} R{race}. It landed at {odds_text} for {profit_text}. Clear race context, faster signal handling, better race-day execution. Try BETMAN.",
        'cta': 'Try BETMAN',
    }


def build_post_from_alert(item):
    meeting = item.get('meeting') or 'Unknown meeting'
    race = item.get('race') or '?'
    runner = item.get('runner') or 'runner'
    reason = item.get('reason') or 'signal event'
    severity = str(item.get('severity') or 'signal').upper()
    return {
        'kind': 'signal-proof',
        'headline': f"BETMAN Pulse surfaced a {severity} signal",
        'short': f"{meeting} R{race} — {runner}",
        'post': f"BETMAN Pulse surfaced a {severity.lower()} signal for {runner} in {meeting} R{race}. Reason: {reason}. Pulse is built to focus attention when timing matters.",
        'cta': 'See how BETMAN works',
    }


def build_post_from_edge(item):
    return {
        'kind': 'upcoming-edge',
        'headline': f"Upcoming edge — {item.get('meeting')} R{item.get('race')}",
        'short': f"{item.get('selection')} ({item.get('type')}) · {item.get('aiWinProb')}% model confidence.",
        'post': f"BETMAN has {item.get('meeting')} R{item.get('race')} on the radar: {item.get('selection')} via {item.get('type')} with model confidence around {item.get('aiWinProb')}% and signal score {item.get('signalScore')}.",
        'cta': 'Open the race board',
    }


def build_post_from_runner(item):
    return {
        'kind': 'interesting-runner',
        'headline': f"Interesting runner — {item.get('meeting')} R{item.get('race')}",
        'short': f"{item.get('runner')} at ${item.get('odds'):.2f}.",
        'post': f"{item.get('runner')} is on the BETMAN watchlist in {item.get('meeting')} R{item.get('race')} at ${item.get('odds'):.2f}. Reason: {item.get('reason')}.",
        'cta': 'Review runner profile',
    }


def build_post_from_mover(item):
    move = abs(item.get('pctMove') or 0)
    direction = str(item.get('direction') or 'move').lower()
    return {
        'kind': 'market-mover',
        'headline': f"Market mover — {item.get('meeting')} R{item.get('race')}",
        'short': f"{item.get('runner')} {direction} {move:.1f}% to ${item.get('toOdds'):.2f}.",
        'post': f"{item.get('runner')} in {item.get('meeting')} R{item.get('race')} has {direction}ed {move:.1f}% from ${item.get('fromOdds'):.2f} to ${item.get('toOdds'):.2f}. BETMAN surfaces this before the board goes stale.",
        'cta': 'Track the move',
    }


def build_post_from_radar(item):
    suffix = ' with live signal overlap' if item.get('hasLiveSignal') else ''
    return {
        'kind': 'live-race-radar',
        'headline': f"Live race radar — {item.get('meeting')} R{item.get('race')}",
        'short': f"{item.get('name')} · {item.get('start')}{suffix}.",
        'post': f"{item.get('meeting')} R{item.get('race')} is on live radar: {item.get('name')} at {item.get('start')}{suffix}. BETMAN keeps race context, movers, and signals in one view.",
        'cta': 'View live radar',
    }


def build_daily_recap(summary, highlights):
    if not summary:
        return None
    date = summary.get('date')
    total = summary.get('total_bets') or 0
    wins = summary.get('win_bets') or 0
    win_rate = summary.get('win_rate')
    roi = summary.get('roi_rec')
    roi_pct = f"{roi * 100:.1f}%" if isinstance(roi, (int, float)) else '—'
    win_rate_pct = f"{win_rate * 100:.1f}%" if isinstance(win_rate, (int, float)) else '—'
    joined = ' | '.join(highlights[:3]) if highlights else 'Signals and results tracked inside BETMAN.'
    return {
        'kind': 'daily-recap',
        'date': date,
        'headline': f"BETMAN daily recap — {date}",
        'post': f"{date}: {wins} wins from {total} bets, win rate {win_rate_pct}, base ROI {roi_pct}. Highlights: {joined}",
        'cta': 'Try BETMAN',
    }


def compose_balanced_queue(buckets, max_items=12):
    order = ['winHighlights', 'signalProof', 'upcomingEdges', 'interestingRunners', 'marketMovers', 'liveRaceRadar']
    working = {k: list(v or []) for k, v in buckets.items()}
    queue = []
    used = set()
    per_meeting = {}
    while len(queue) < max_items:
        added = False
        for bucket in order:
            items = working.get(bucket) or []
            while items:
                item = items.pop(0)
                meeting = norm_meeting(item.get('meeting'))
                race = norm_race(item.get('race'))
                selection = item.get('selection') or item.get('runner') or item.get('headline')
                key = runner_key(meeting, race, selection, item.get('kind') or bucket)
                if key in used:
                    continue
                if meeting and per_meeting.get(meeting, 0) >= 3:
                    continue
                used.add(key)
                per_meeting[meeting] = per_meeting.get(meeting, 0) + 1
                queue.append(item)
                added = True
                break
        if not added:
            break
    return queue


def summarize_queue(queue):
    by_kind = {}
    by_meeting = {}
    for item in queue:
        by_kind[item.get('kind') or 'unknown'] = by_kind.get(item.get('kind') or 'unknown', 0) + 1
        meeting = norm_meeting(item.get('meeting')) or 'Unknown'
        by_meeting[meeting] = by_meeting.get(meeting, 0) + 1
    return {
        'totalItems': len(queue),
        'byKind': by_kind,
        'byMeeting': by_meeting,
    }


def main():
    settled = load_json(DATA_DIR / 'settled_bets.json', [])
    alerts_feed = load_json(DATA_DIR / 'alerts_feed.json', [])
    alerts_history = load_json(DATA_DIR / 'alerts_history.json', [])
    success_daily = load_json(DATA_DIR / 'success_daily.json', {})
    market_movers = load_json(DATA_DIR / 'market_movers_cache.json', {})
    status = load_json(DATA_DIR / 'status.json', {})

    wins = top_wins(settled, limit=5)
    alerts = top_alerts(ensure_rows(alerts_feed) + ensure_rows(alerts_history), limit=6)
    upcoming_edges = select_upcoming_edges(status, limit=6)
    interesting_runners = select_interesting_runners(status, limit=6)
    movers_source = {'marketMovers': ensure_rows(status.get('marketMovers') if isinstance(status, dict) else [])}
    movers = select_market_movers(movers_source, limit=6)
    live_radar = select_live_race_radar(status, alerts, upcoming_edges, movers, interesting_runners, limit=5)

    win_posts = [build_post_from_win(item) for item in wins]
    for post, item in zip(win_posts, wins):
        post.update({'meeting': item.get('meeting'), 'race': norm_race(item.get('race')), 'selection': item.get('selection')})
    alert_posts = [build_post_from_alert(item) for item in alerts]
    for post, item in zip(alert_posts, alerts):
        post.update({'meeting': item.get('meeting'), 'race': norm_race(item.get('race')), 'runner': item.get('runner')})
    edge_posts = [build_post_from_edge(item) for item in upcoming_edges]
    for post, item in zip(edge_posts, upcoming_edges):
        post.update({'meeting': item.get('meeting'), 'race': norm_race(item.get('race')), 'selection': item.get('selection')})
    runner_posts = [build_post_from_runner(item) for item in interesting_runners]
    for post, item in zip(runner_posts, interesting_runners):
        post.update({'meeting': item.get('meeting'), 'race': norm_race(item.get('race')), 'runner': item.get('runner')})
    mover_posts = [build_post_from_mover(item) for item in movers]
    for post, item in zip(mover_posts, movers):
        post.update({'meeting': item.get('meeting'), 'race': norm_race(item.get('race')), 'runner': item.get('runner')})
    radar_posts = [build_post_from_radar(item) for item in live_radar]
    for post, item in zip(radar_posts, live_radar):
        post.update({'meeting': item.get('meeting'), 'race': norm_race(item.get('race')), 'selection': item.get('name')})

    mixed_queue = compose_balanced_queue({
        'winHighlights': win_posts,
        'signalProof': alert_posts,
        'upcomingEdges': edge_posts,
        'interestingRunners': runner_posts,
        'marketMovers': mover_posts,
        'liveRaceRadar': radar_posts,
    }, max_items=12)

    recap = build_daily_recap(
        daily_summary(success_daily),
        [item.get('short') for item in mixed_queue if item.get('short')]
    )

    queue = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'wins': wins,
        'alerts': alerts,
        'upcomingEdges': upcoming_edges,
        'interestingRunners': interesting_runners,
        'marketMovers': movers,
        'liveRaceRadar': live_radar,
        'queue': mixed_queue,
        'composition': summarize_queue(mixed_queue),
        'drafts': {
            'winHighlights': win_posts,
            'signalProof': alert_posts,
            'upcomingEdges': edge_posts,
            'interestingRunners': runner_posts,
            'marketMovers': mover_posts,
            'liveRaceRadar': radar_posts,
            'dailyRecap': recap,
        }
    }

    daily = {
        'generatedAt': queue['generatedAt'],
        'dailyRecap': recap,
        'topWin': win_posts[0] if win_posts else None,
        'topSignal': alert_posts[0] if alert_posts else None,
        'topUpcomingEdge': edge_posts[0] if edge_posts else None,
        'topInterestingRunner': runner_posts[0] if runner_posts else None,
        'topMarketMover': mover_posts[0] if mover_posts else None,
        'topRadar': radar_posts[0] if radar_posts else None,
        'composition': queue['composition'],
    }

    weekly = {
        'generatedAt': queue['generatedAt'],
        'summary': 'Weekly content engine scaffold now balances wins, signals, edges, runners, movers, and live radar.',
        'topWins': win_posts[:3],
        'topSignals': alert_posts[:3],
        'topUpcomingEdges': edge_posts[:3],
        'topInterestingRunners': runner_posts[:3],
        'topMarketMovers': mover_posts[:3],
        'topRadar': radar_posts[:3],
        'composition': queue['composition'],
    }

    write_json(OUT_QUEUE, queue)
    write_json(OUT_DAILY, daily)
    write_json(OUT_WEEKLY, weekly)
    print(json.dumps({'ok': True, 'queue': str(OUT_QUEUE), 'daily': str(OUT_DAILY), 'weekly': str(OUT_WEEKLY), 'composition': queue['composition']}, indent=2))


if __name__ == '__main__':
    main()
