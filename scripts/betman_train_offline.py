#!/usr/bin/env python
"""Offline tuner for BETMAN win selections.
Optimizes thresholds for win-rate and ROI on historical ledger.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "memory" / "success_ledger.jsonl"
OUT = ROOT / "memory" / "betman_tuning.json"


def load_ledger(path):
    rows = []
    if not path.exists():
        return rows
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except Exception:
                continue
    return rows


def main():
    rows = load_ledger(LEDGER)
    # use only finalized win bets
    data = [r for r in rows if str(r.get("status", "")).lower() == "final" and str(r.get("category", "")).lower() == "win"]
    if not data:
        print("No final win bets available.")
        return

    # normalize
    samples = []
    for r in data:
        stake = float(r.get("stake") or 0)
        if stake <= 0:
            continue
        win = 1 if r.get("win") else 0
        prob = float(r.get("aiWinProb") or 0) / 100.0
        odds = float(r.get("rec_odds") or 0) or None
        roi = float(r.get("rec_win_profit") or 0) / stake
        samples.append({"prob": prob, "odds": odds, "win": win, "roi": roi, "stake": stake})

    if not samples:
        print("No usable samples after filtering.")
        return

    def evaluate(min_prob, max_odds=None, min_odds=None):
        subset = []
        for s in samples:
            if s["prob"] < min_prob:
                continue
            if min_odds is not None and s["odds"] is not None and s["odds"] < min_odds:
                continue
            if max_odds is not None and s["odds"] is not None and s["odds"] > max_odds:
                continue
            subset.append(s)
        if not subset:
            return None
        total = len(subset)
        wins = sum(s["win"] for s in subset)
        win_rate = wins / total if total else 0
        roi = sum(s["roi"] for s in subset) / total if total else 0
        return {"total": total, "wins": wins, "win_rate": win_rate, "roi": roi}

    # grid search
    results = []
    for min_prob in [x / 100 for x in range(5, 51, 2)]:
        for max_odds in [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, None]:
            res = evaluate(min_prob, max_odds=max_odds)
            if not res:
                continue
            res.update({"min_prob": min_prob, "max_odds": max_odds})
            results.append(res)

    if not results:
        print("No results from grid.")
        return

    best_win = sorted(results, key=lambda r: (r["win_rate"], r["roi"], r["total"]), reverse=True)[0]
    best_roi = sorted(results, key=lambda r: (r["roi"], r["win_rate"], r["total"]), reverse=True)[0]

    out = {
        "samples": len(samples),
        "best_by_win_rate": best_win,
        "best_by_roi": best_roi
    }
    OUT.write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
