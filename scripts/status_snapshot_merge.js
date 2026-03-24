function normMeeting(val = ''){
  return String(val || '').trim().toLowerCase();
}

function normRace(val = ''){
  return String(val || '').replace(/^R/i, '').trim();
}

function normText(val = ''){
  return String(val || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function mergeRows(globalRows, tenantRows, keyBuilder) {
  const rows = new Map();
  (Array.isArray(globalRows) ? globalRows : []).forEach(row => {
    const dedupe = keyBuilder(row);
    if (dedupe) rows.set(dedupe, row);
  });
  (Array.isArray(tenantRows) ? tenantRows : []).forEach(row => {
    const dedupe = keyBuilder(row);
    if (dedupe) rows.set(dedupe, row);
  });
  return Array.from(rows.values());
}

function mergePublicStatusLists(globalStatus = {}, tenantStatus = {}) {
  const merged = { ...(tenantStatus || {}) };
  const specs = [
    {
      key: 'marketMovers',
      keyBuilder: row => {
        const meeting = normMeeting(row?.meeting);
        const race = normRace(row?.race);
        const runner = normText(row?.runner);
        if (!meeting || !race || !runner) return null;
        return `${meeting}|${race}|${runner}`;
      }
    },
    {
      key: 'suggestedBets',
      keyBuilder: row => {
        const meeting = normMeeting(row?.meeting);
        const race = normRace(row?.race);
        const selection = normText(row?.selection);
        const type = normText(row?.type);
        if (!meeting || !race || !selection || !type) return null;
        return `${meeting}|${race}|${selection}|${type}`;
      }
    },
    {
      key: 'nextPlans',
      keyBuilder: row => {
        const meeting = normMeeting(row?.meeting);
        const race = normRace(row?.race);
        const selection = normText(row?.selection);
        const type = normText(row?.type);
        const state = normText(row?.state || row?.status || 'pending');
        if (!meeting || !race || !selection) return null;
        return `${meeting}|${race}|${selection}|${type}|${state}`;
      }
    },
    {
      key: 'betPlans',
      keyBuilder: row => {
        const meeting = normMeeting(row?.meeting);
        const race = normRace(row?.race);
        const selection = normText(row?.selection);
        const type = normText(row?.type);
        if (!meeting || !race || !selection) return null;
        return `${meeting}|${race}|${selection}|${type}`;
      }
    },
    {
      key: 'interestingRunners',
      keyBuilder: row => {
        const meeting = normMeeting(row?.meeting);
        const race = normRace(row?.race);
        const runner = normText(row?.runner);
        if (!meeting || !race || !runner) return null;
        return `${meeting}|${race}|${runner}`;
      }
    }
  ];

  specs.forEach(({ key, keyBuilder }) => {
    const rows = mergeRows(globalStatus?.[key], tenantStatus?.[key], keyBuilder);
    if (rows.length || Array.isArray(globalStatus?.[key]) || Array.isArray(tenantStatus?.[key])) {
      merged[key] = rows;
    }
  });

  return merged;
}

module.exports = {
  mergePublicStatusLists
};
