const fs = require('fs');
const path = require('path');

function buildStatus(state, balanceData, stakePerRace=10) {
  const rawBetPlans = (state.bet_plans || []);
  const rawEarlyPlans = (state.early_plans || []);
  let aiWindowMin = 10;
  try {
    const stake = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'frontend', 'data', 'stake.json'), 'utf8'));
    if (typeof stake.aiWindowMin === 'number' && Number.isFinite(stake.aiWindowMin)) aiWindowMin = stake.aiWindowMin;
  } catch {}

  const betPlans = rawBetPlans.map(b=>{
    const parts = (b.race || '').split(':');
    if (parts.length < 3) {
      if (b.race) console.warn('Invalid race format in bet plan:', b.race);
      return null;
    }
    const [country, meeting, race] = parts;
    return {
      meeting,
      race: (race || '').replace('R',''),
      selection: b.selection,
      stake: b.stake,
      type: b.bet_type,
      odds: b.odds,
      eta: `${b.mins_to_start}m`
    };
  }).filter(Boolean);

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
    upcomingRaces,
    activity: [
      `Poller updated: ${state.ts}`,
      betPlans.length
        ? `Bet plans ready now (<=${aiWindowMin}m): ${betPlans.length}`
        : (rawEarlyPlans.length
            ? `Early queue plans: ${rawEarlyPlans.length}`
            : 'No bet plans in window.')
    ]
  };
}

module.exports = { buildStatus };
