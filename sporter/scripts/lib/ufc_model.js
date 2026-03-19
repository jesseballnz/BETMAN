const crypto = require('crypto');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

function fighterRating(fighter) {
  const { wins = 0, losses = 0, draws = 0 } = fighter.record || {};
  const fights = wins + losses + draws;
  const winPct = fights ? wins / fights : 0.5;
  const experienceBoost = Math.log10(fights + 1) * 0.08;
  const durability = (fights - losses) / Math.max(1, fights) * 0.05;
  return winPct + experienceBoost + durability;
}

function modelFight(fight) {
  const [home, away] = fight.competitors;
  const diff = fighterRating(home) - fighterRating(away);
  const homeWinProb = clamp(logistic(diff), 0.05, 0.95);
  const rounds = fight.rounds || 3;
  const roundsLine = rounds >= 5 ? 4.5 : 2.5;
  const parity = 1 - Math.abs(homeWinProb - 0.5);
  const decisionBias = clamp(0.4 + parity * 0.4, 0.2, 0.8);
  return {
    homeWinProb,
    awayWinProb: 1 - homeWinProb,
    roundsLine,
    decisionBias
  };
}

function hashOffset(book, fightId) {
  const hash = crypto.createHash('md5').update(`${book}:${fightId}`).digest('hex');
  const value = parseInt(hash.slice(0, 4), 16) / 0xffff; // 0..1
  return (value - 0.5) * 0.04; // +/-2%
}

function adjustProbability(prob, book, fightId) {
  const offset = hashOffset(book, fightId);
  return clamp(prob + offset, 0.02, 0.98);
}

function probabilityToAmerican(prob) {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) {
    return Math.round((-prob / (1 - prob)) * 100);
  }
  return Math.round(((1 - prob) / prob) * 100);
}

function buildMoneyline(prob) {
  return {
    home: probabilityToAmerican(prob),
    away: probabilityToAmerican(1 - prob)
  };
}

function buildTotals(fight, decisionBias) {
  const roundsLine = fight.rounds >= 5 ? 4.5 : 2.5;
  const overProb = clamp(decisionBias, 0.1, 0.9);
  const underProb = 1 - overProb;
  return {
    line: roundsLine,
    over: probabilityToAmerican(overProb),
    under: probabilityToAmerican(underProb)
  };
}

module.exports = {
  modelFight,
  adjustProbability,
  probabilityToAmerican,
  buildMoneyline,
  buildTotals
};
