const fs = require('fs');
const path = require('path');
const { loadCard } = require('./ufc_card_loader');
const { modelFight, adjustProbability, buildMoneyline, buildTotals, probabilityToAmerican } = require('./ufc_model');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function normalizeSampleEvent(event = {}){
  return {
    id: event.id,
    league: event.league,
    home: event.home,
    away: event.away,
    start: event.start,
    markets: {
      spread: event.lines?.spread || null,
      total: event.lines?.total || null,
      moneyline: event.lines?.moneyline || null,
      props: Array.isArray(event.lines?.props) ? event.lines.props : []
    }
  };
}

function loadSampleEvents(bookName){
  const samplePath = path.join(process.cwd(), 'data', 'sample_feeds', `${bookName}.json`);
  try {
    const payload = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    return (payload.events || [])
      .filter(evt => String(evt.league || '').toUpperCase() !== 'UFC')
      .map(normalizeSampleEvent);
  } catch {
    return [];
  }
}

function buildFightProps(fight, model, totals) {
  const [home, away] = fight.competitors;
  const goDistanceProb = clamp(model.decisionBias, 0.05, 0.95);
  const finishProb = clamp(1 - goDistanceProb, 0.05, 0.95);
  const homeInside = clamp(model.homeWinProb * finishProb * 1.25, 0.05, 0.95);
  const awayInside = clamp(model.awayWinProb * finishProb * 1.25, 0.05, 0.95);
  return [
    {
      market: 'Fight goes distance',
      runner: `${home.name} vs ${away.name}`,
      line: null,
      over: probabilityToAmerican(goDistanceProb),
      under: probabilityToAmerican(finishProb)
    },
    {
      market: 'Home inside distance',
      runner: home.name,
      line: null,
      over: probabilityToAmerican(homeInside),
      under: probabilityToAmerican(1 - homeInside)
    },
    {
      market: 'Away inside distance',
      runner: away.name,
      line: null,
      over: probabilityToAmerican(awayInside),
      under: probabilityToAmerican(1 - awayInside)
    },
    {
      market: 'Model total (rounds)',
      runner: 'Alt line',
      line: totals.line,
      over: totals.over,
      under: totals.under
    }
  ].filter(prop => prop.over !== null || prop.under !== null);
}

function eventFromFight(fight, bookName) {
  const [home, away] = fight.competitors;
  const baseModel = modelFight(fight);
  const adjustedHomeProb = adjustProbability(baseModel.homeWinProb, bookName, fight.id);
  const moneyline = buildMoneyline(adjustedHomeProb);
  const totals = buildTotals(fight, baseModel.decisionBias);
  const props = buildFightProps(fight, baseModel, totals);

  return {
    id: fight.id,
    league: 'UFC',
    event: fight.eventName,
    home: home.name,
    away: away.name,
    start: fight.start,
    weightClass: fight.weightClass,
    cardSegment: fight.cardSegment,
    markets: {
      spread: null,
      total: totals,
      moneyline,
      props
    },
    meta: {
      rounds: fight.rounds,
      homeRecord: home.record,
      awayRecord: away.record
    }
  };
}

async function buildBookSnapshot(bookName) {
  const card = await loadCard();
  const ufcEvents = card.fights.map(fight => eventFromFight(fight, bookName));
  const sampleEvents = loadSampleEvents(bookName);
  const events = [...ufcEvents, ...sampleEvents];
  return {
    book: bookName,
    source: sampleEvents.length ? 'espn-scoreboard+sample' : 'espn-scoreboard',
    polledAt: new Date().toISOString(),
    events
  };
}

function writeBookSnapshot(bookName, snapshot) {
  const outPath = path.join(process.cwd(), 'data', 'books', `${bookName}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  return outPath;
}

module.exports = {
  buildBookSnapshot,
  writeBookSnapshot
};
