(function (global) {
  function normalizeLedgerResult(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return 'pending';
    if (raw === 'won') return 'win';
    if (raw === 'lost') return 'loss';
    if (raw === 'placed' || raw === 'place') return 'ew_place';
    return raw;
  }

  function countsAsSettledBet(row) {
    const type = String(row?.type || row?.betType || '').trim().toLowerCase();
    return type !== 'watch';
  }

  function summarizeSettledBets(rows = []) {
    const safeRows = Array.isArray(rows) ? rows : [];
    return safeRows.reduce((acc, row) => {
      if (!countsAsSettledBet(row)) return acc;
      const stake = Number(row?.stake_units);
      const returned = Number(row?.return_units);
      const profit = Number(row?.profit_units);
      acc.bets += 1;
      if (Number.isFinite(stake)) acc.stake += stake;
      if (Number.isFinite(returned)) acc.returnUnits += returned;
      if (Number.isFinite(profit)) acc.profitUnits += profit;
      const result = normalizeLedgerResult(row?.result);
      if (result === 'win' || result === 'ew_win' || result === 'ew_place') acc.hits += 1;
      return acc;
    }, { bets: 0, stake: 0, returnUnits: 0, profitUnits: 0, hits: 0 });
  }

  function groupSettledBetsByDate(rows = []) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const groups = new Map();
    safeRows.forEach((row) => {
      if (!countsAsSettledBet(row)) return;
      const date = String(row?.date || '').trim() || 'Unknown';
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date).push(row);
    });
    return Array.from(groups.entries())
      .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
      .map(([date, items]) => {
        const rowsForDay = [...items].sort((a, b) => {
          const keyA = `${String(a?.meeting || '')}|${String(a?.race || '').padStart(3, '0')}|${String(a?.selection || '')}`;
          const keyB = `${String(b?.meeting || '')}|${String(b?.race || '').padStart(3, '0')}|${String(b?.selection || '')}`;
          return keyA.localeCompare(keyB);
        });
        return {
          date,
          rows: rowsForDay,
          summary: summarizeSettledBets(rowsForDay)
        };
      });
  }

  function aggregateLastNDays(daily, days = 30) {
    if (!daily || typeof daily !== 'object') return null;
    const keys = Object.keys(daily).sort();
    const slice = keys.slice(-days);
    if (!slice.length) return null;
    const agg = {
      days: slice.length,
      total_bets: 0,
      total_stake: 0,
      roi_stake: 0,
      win_bets: 0,
      wins: 0,
      races_run: 0,
      races_won: 0,
      roi_rec_profit: 0,
      roi_sp_profit: 0,
      roi_sp_stake: 0,
      roi_tote_profit: 0,
      roi_tote_stake: 0,
      exotic_profit: 0,
      exotic_stake: 0,
      exotic: { bets: 0, hits: 0 },
      pick: {
        win: { bets: 0, stake_units: 0, roi_stake_units: 0, roi_sp_stake_units: 0, roi_tote_stake_units: 0, profit_rec: 0, profit_sp: 0, profit_tote: 0, wins: 0 },
        odds_runner: { bets: 0, stake_units: 0, roi_stake_units: 0, roi_sp_stake_units: 0, roi_tote_stake_units: 0, profit_rec: 0, profit_sp: 0, profit_tote: 0, wins: 0 },
        ew: { bets: 0, stake_units: 0, roi_stake_units: 0, roi_sp_stake_units: 0, roi_tote_stake_units: 0, profit_rec: 0, profit_sp: 0, profit_tote: 0, wins: 0 }
      },
      long: { bets: 0, stake_units: 0, roi_stake_units: 0, roi_sp_stake_units: 0, roi_tote_stake_units: 0, profit_rec: 0, wins: 0 }
    };
    slice.forEach(key => {
      const r = daily[key] || {};
      const bets = r.total_bets ?? r.win_bets ?? 0;
      const stake = r.total_stake ?? bets;
      const roiStake = r.roi_stake ?? stake;
      const winBets = r.win_bets ?? 0;
      const wins = r.wins ?? Math.round((r.win_rate ?? 0) * winBets);
      agg.total_bets += bets;
      agg.total_stake += stake;
      agg.roi_stake += roiStake;
      agg.win_bets += winBets;
      agg.wins += wins;
      agg.races_run += r.races_run ?? 0;
      agg.races_won += r.races_won ?? 0;
      if (Number.isFinite(r.roi_rec)) agg.roi_rec_profit += r.roi_rec * roiStake;
      if (Number.isFinite(r.roi_sp)) {
        agg.roi_sp_profit += r.roi_sp * roiStake;
        agg.roi_sp_stake += roiStake;
      }
      if (Number.isFinite(r.roi_tote)) {
        agg.roi_tote_profit += r.roi_tote * roiStake;
        agg.roi_tote_stake += roiStake;
      }
      if (Number.isFinite(r.exotic_roi_tote) && Number.isFinite(r.exotic_roi_stake) && r.exotic_roi_stake) {
        agg.exotic_profit += r.exotic_roi_tote * r.exotic_roi_stake;
        agg.exotic_stake += r.exotic_roi_stake;
      }
      const exoticBreakdown = r.exotic_breakdown || {};
      const exoticBets = Object.values(exoticBreakdown).reduce((a, b) => a + (b?.bets || 0), 0);
      if (exoticBets) {
        agg.exotic.bets += exoticBets;
        agg.exotic.hits += Number.isFinite(r.exotic_hit_rate) ? r.exotic_hit_rate * exoticBets : 0;
      }
      const applyPick = (target, source = {}) => {
        const bets = source.bets ?? 0;
        const stakeUnits = source.stake_units ?? bets ?? 0;
        const roiStakeUnits = source.roi_stake_units ?? stakeUnits ?? bets ?? 0;
        const roiSpStakeUnits = source.roi_sp_stake_units ?? 0;
        const roiToteStakeUnits = source.roi_tote_stake_units ?? 0;
        const wins = Number.isFinite(source.wins)
          ? source.wins
          : (Number.isFinite(source.win_rate) ? source.win_rate * bets : 0);
        const profitRec = Number.isFinite(source.profit_rec)
          ? source.profit_rec
          : (Number.isFinite(source.roi_rec) ? source.roi_rec * roiStakeUnits : 0);
        const profitSp = Number.isFinite(source.profit_sp)
          ? source.profit_sp
          : (Number.isFinite(source.roi_sp) ? source.roi_sp * (roiSpStakeUnits || roiStakeUnits) : 0);
        const profitTote = Number.isFinite(source.profit_tote)
          ? source.profit_tote
          : (Number.isFinite(source.roi_tote) ? source.roi_tote * (roiToteStakeUnits || roiStakeUnits) : 0);
        target.bets += bets;
        target.stake_units += stakeUnits;
        target.roi_stake_units += roiStakeUnits;
        target.roi_sp_stake_units += roiSpStakeUnits;
        target.roi_tote_stake_units += roiToteStakeUnits;
        target.profit_rec += profitRec;
        target.profit_sp += profitSp;
        target.profit_tote += profitTote;
        target.wins += wins;
      };
      applyPick(agg.pick.win, r.pick_breakdown?.win);
      applyPick(agg.pick.odds_runner, r.pick_breakdown?.odds_runner);
      applyPick(agg.pick.ew, r.pick_breakdown?.ew);
      applyPick(agg.long, r.long_breakdown);
    });
    return agg;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { aggregateLastNDays, normalizeLedgerResult, countsAsSettledBet, summarizeSettledBets, groupSettledBetsByDate };
  }
  global.aggregateLastNDays = aggregateLastNDays;
  global.normalizeLedgerResult = normalizeLedgerResult;
  global.countsAsSettledBet = countsAsSettledBet;
  global.summarizeSettledBets = summarizeSettledBets;
  global.groupSettledBetsByDate = groupSettledBetsByDate;
})(typeof window !== 'undefined' ? window : globalThis);
