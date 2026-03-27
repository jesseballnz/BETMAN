const fs = require('fs');
const path = require('path');

function buildStatus(state, balanceData, stakePerRace=10) {
  const rawBetPlans = (state.bet_plans || []);
  const rawEarlyPlans = (state.early_plans || []);
  const rawExoticPlans = (state.exotic_plans || []);
  let aiWindowMin = 10;
  try {
    const stake = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'frontend', 'data', 'stake.json'), 'utf8'));
    if (typeof stake.aiWindowMin === 'number') aiWindowMin = stake.aiWindowMin;
  } catch {}

  const betPlans = rawBetPlans.map(b=>{
    const [country, meeting, race] = b.race.split(':');
    return {
      meeting,
      race: race.replace('R',''),
      selection: b.selection,
      stake: b.stake,
      type: b.bet_type,
      odds: b.odds,
      winProb: b.win_prob ?? null,
      edgePct: b.edge_pct ?? null,
      standout: b.standout || false,
      tags: b.tags || [],
      eta: `${b.mins_to_start}m`
    };
  });

  const earlyPlans = rawEarlyPlans.map(b=>{
    const [country, meeting, race] = b.race.split(':');
    return {
      meeting,
      race: race.replace('R',''),
      selection: b.selection,
      stake: b.stake,
      type: b.bet_type,
      odds: b.odds,
      winProb: b.win_prob ?? null,
      edgePct: b.edge_pct ?? null,
      tags: b.tags || [],
      eta: `${b.mins_to_start}m`
    };
  });

  const exoticPlans = rawExoticPlans.map(x=>{
    const [country, meeting, raceCode] = x.race.split(':');
    const race = String(raceCode || '').replace('R','');
    let selection = '';
    if (x.selections && x.selections.length) {
      selection = x.selections.map(s => s.selection).join(' / ');
    } else if (x.structure) {
      selection = `${x.structure.first} > ${(x.structure.second_third_box || []).join(' / ')}`;
    }
    return {
      meeting,
      race,
      selection,
      type: x.market,
      stake: x.stake ?? null,
      selections: x.selections || null,
      structure: x.structure || null,
      eta: `${x.mins_to_start}m`,
      note: x.note || null
    };
  });

  const upcomingRaces = Object.entries(state.races || {})
    .filter(([_, r]) => !['final','closed','abandoned','resulted'].includes((r.race_status || '').toLowerCase()))
    .map(([key, r])=>({
      key,
      meeting: r.meeting,
      race: r.race_number,
      name: r.description,
      start: r.start_time_nz,
      status: r.race_status || 'Unknown'
    }))
    .slice(0, 40);

  const betchaBal = balanceData.betcha?.balance ?? null;
  const tabBal = balanceData.tab?.balance ?? null;
  const openBets = (balanceData.betcha?.openBets || 0) + (balanceData.tab?.openBets || 0);
  const totalBalance = (betchaBal || 0) + (tabBal || 0);

  const upcomingBets = betPlans.length ? betPlans : [];

  return {
    updatedAt: state.ts,
    balance: totalBalance,
    bank: 'Betcha+TAB',
    openBets,
    todaysStake: 0,
    stakePerRace,
    upcomingBets,
    earlyPlans,
    exoticPlans,
    upcomingRaces,
    activity: [
      `Poller updated: ${state.ts}`,
      betPlans.length
        ? `Bet plans ready now (<=${aiWindowMin}m): ${betPlans.length}`
        : (rawEarlyPlans.length
            ? `Early queue plans: ${rawEarlyPlans.length}`
            : 'No bet plans in window.'),
      exoticPlans.length ? `Exotic plans: ${exoticPlans.length}` : null
    ].filter(Boolean)
  };
}

module.exports = { buildStatus };
