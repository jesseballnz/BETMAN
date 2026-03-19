#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { loadCard } = require('./lib/ufc_card_loader');
const { modelFight, probabilityToAmerican } = require('./lib/ufc_model');

function loadSupplementalEvents() {
  const samplePath = path.join(process.cwd(), 'data', 'sample_feeds', 'tab_sports.json');
  try {
    const payload = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    return (payload.events || []).filter(evt => String(evt.league || '').toUpperCase() !== 'UFC');
  } catch {
    return [];
  }
}

function groupSupplementalLeagues() {
  const extras = loadSupplementalEvents();
  const grouped = new Map();
  extras.forEach(evt => {
    const code = String(evt.league || 'OTHER').toUpperCase();
    if (!grouped.has(code)) {
      grouped.set(code, { code, name: code, events: [] });
    }
    grouped.get(code).events.push({
      id: evt.id,
      home: evt.home,
      away: evt.away,
      start: evt.start,
      market: {
        spread: evt.lines?.spread || null,
        total: evt.lines?.total || null,
        moneyline: evt.lines?.moneyline || null
      }
    });
  });
  return Array.from(grouped.values());
}

async function main() {
  const card = await loadCard();
  const leagues = [
    {
      code: 'UFC',
      name: card.event.name,
      events: card.fights.map(fight => {
        const [home, away] = fight.competitors;
        const model = modelFight(fight);
        return {
          id: fight.id,
          home: home.name,
          away: away.name,
          start: fight.start,
          market: {
            moneyline: {
              home: probabilityToAmerican(model.homeWinProb),
              away: probabilityToAmerican(model.awayWinProb)
            },
            total: {
              line: model.roundsLine
            }
          }
        };
      })
    }
  ];

  const supplemental = groupSupplementalLeagues();
  supplemental.forEach(league => {
    league.events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    leagues.push(league);
  });

  const schedule = {
    updatedAt: new Date().toISOString(),
    leagues
  };

  const outPath = path.join(process.cwd(), 'data', 'sample-schedule.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(schedule, null, 2));
  console.log(`Schedule updated -> ${outPath}`);
}

main().catch(err => {
  console.error('build_schedule failed', err.message);
  process.exit(1);
});
