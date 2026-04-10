const schedulePill = document.getElementById('schedulePill');
const marketPill = document.getElementById('marketPill');
const sportFilterEl = document.getElementById('sportFilter');
const betWindowInput = document.getElementById('betWindowInput');
const applyWindowBtn = document.getElementById('applyWindowBtn');
const overviewCardsEl = document.getElementById('overviewCards');
const edgeBoardEl = document.getElementById('edgeBoard');
const drawerEl = document.getElementById('eventDrawer');
const drawerTitle = document.getElementById('drawerTitle');
const drawerMeta = document.getElementById('drawerMeta');
const drawerConsensus = document.getElementById('drawerConsensus');
const drawerBooks = document.getElementById('drawerBooks');
const drawerProps = document.getElementById('drawerProps');
const drawerCloseBtn = document.getElementById('drawerClose');
const edgeModeButtons = document.querySelectorAll('[data-edge-mode]');

const EDGE_MODES = ['overlay', 'fade', 'all'];
let scheduleLeagues = [];
let marketEvents = [];
let marketBooks = [];
let liveScores = {};
let selectedSport = localStorage.getItem('sporterSelectedSport') || 'ALL';
let betWindowHours = Number(localStorage.getItem('sporterBetWindowHours')) || 12;
let selectedEventId = null;
let edgeMode = localStorage.getItem('sporterEdgeMode') || 'overlay';
let drawerFocusReturn = null;
if (!EDGE_MODES.includes(edgeMode)) edgeMode = 'overlay';

sportFilterEl.value = selectedSport;
betWindowInput.value = betWindowHours;

function syncEdgeModeButtons(){
  edgeModeButtons.forEach(btn => {
    const mode = btn.dataset.edgeMode;
    btn.classList.toggle('active', mode === edgeMode);
  });
}

syncEdgeModeButtons();
edgeModeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.edgeMode;
    if (!mode || !EDGE_MODES.includes(mode) || mode === edgeMode) return;
    edgeMode = mode;
    localStorage.setItem('sporterEdgeMode', edgeMode);
    syncEdgeModeButtons();
    renderEdgeBoard();
  });
});

drawerCloseBtn?.addEventListener('click', () => openEventDrawer(null));
document.addEventListener('keydown', evt => {
  if (evt.key === 'Escape') openEventDrawer(null);
});

const pageTabs = document.querySelectorAll('.page-tab');
const pageSections = document.querySelectorAll('.page-section');

pageTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.page;
    pageTabs.forEach(btn => btn.classList.toggle('active', btn === tab));
    pageSections.forEach(section => {
      section.style.display = section.dataset.page === target ? '' : 'none';
    });
  });
});

async function fetchSchedule(){
  schedulePill.textContent = 'Loading schedule…';
  try {
    const res = await fetch('/api/schedule');
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    scheduleLeagues = data.leagues || [];
    schedulePill.textContent = `Schedule · ${new Date(data.updatedAt || Date.now()).toLocaleTimeString()}`;
    refreshSportOptions();
    renderSchedule();
    renderOverview();
  } catch (err) {
    console.error(err);
    schedulePill.textContent = 'Schedule unavailable';
  }
}

async function fetchMarket(){
  marketPill.textContent = 'Loading markets…';
  try {
    const res = await fetch('/api/market');
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    marketEvents = data.events || [];
    marketBooks = data.books || [];
    marketPill.textContent = `Markets · ${new Date(data.generatedAt || Date.now()).toLocaleTimeString()}`;
    const windowExpanded = expandWindowToIncludeNextEvent();
    refreshSportOptions();
    renderMarket();
    renderEdgeBoard();
    renderOverview();
    syncDrawer();
    if (windowExpanded) renderSchedule();
  } catch (err) {
    console.error(err);
    marketPill.textContent = 'Markets unavailable';
  }
}

async function fetchLiveScores(){
  try {
    const res = await fetch(`/data/live_scores.json?_ts=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    liveScores = data.scores || {};
  } catch (err) {
    console.error('live_scores unavailable', err.message);
    liveScores = {};
  }
  renderSchedule();
}

function refreshSportOptions(){
  const sports = new Set();
  marketEvents.forEach(evt => {
    const sport = normalizeSport(evt.league);
    if (sport) sports.add(sport);
  });
  scheduleLeagues.forEach(league => {
    const sport = normalizeSport(league.code || league.name);
    if (sport) sports.add(sport);
  });
  const options = ['ALL', ...[...sports].sort()];
  const currentOptions = [...sportFilterEl.options].map(opt => opt.value);
  if (currentOptions.length === options.length && currentOptions.every((val, idx) => val === options[idx])) return;
  sportFilterEl.innerHTML = options.map(opt => `<option value="${opt}">${opt}</option>`).join('');
  if (!options.includes(selectedSport)) {
    selectedSport = 'ALL';
    localStorage.setItem('sporterSelectedSport', selectedSport);
  }
  sportFilterEl.value = selectedSport;
}

sportFilterEl.addEventListener('change', () => {
  selectedSport = sportFilterEl.value || 'ALL';
  localStorage.setItem('sporterSelectedSport', selectedSport);
  expandWindowToIncludeNextEvent();
  renderMarket();
  renderEdgeBoard();
  renderOverview();
  renderSchedule();
  syncDrawer();
});

applyWindowBtn.addEventListener('click', () => {
  const next = Number(betWindowInput.value);
  if (!Number.isFinite(next) || next < 1) return;
  betWindowHours = Math.min(96, Math.max(1, Math.round(next)));
  betWindowInput.value = betWindowHours;
  localStorage.setItem('sporterBetWindowHours', betWindowHours);
  renderSchedule();
  renderMarket();
  renderEdgeBoard();
  renderOverview();
  syncDrawer();
});

function renderSchedule(){
  const wrap = document.getElementById('schedule');
  wrap.innerHTML = '';
  const flatEvents = scheduleLeagues.flatMap(league =>
    (league.events || [])
      .filter(evt => !hasEventPassed(evt.start))
      .map(evt => ({ ...evt, league: evt.league || league.code || league.name }))
  );
  if (!scheduleLeagues.length || !flatEvents.length) {
    wrap.innerHTML = '<div class="empty">No events available</div>';
    return;
  }
  const bypassWindow = shouldBypassWindowFor(flatEvents);
  const ignoreWindow = bypassWindow || selectedSport === 'ALL';
  scheduleLeagues.forEach(league => {
    const futureEvents = (league.events || []).filter(evt => !hasEventPassed(evt.start));
    const events = futureEvents.filter(evt =>
      eventMatchesFilters({ ...evt, league: evt.league || league.code || league.name }, { ignoreWindow })
    );
    if (!events.length) return;
    const card = document.createElement('div');
    card.className = 'league-card';
    card.innerHTML = `<h2>${league.name || league.code}</h2>`;
    events.forEach(event => {
      const row = document.createElement('div');
      row.className = 'event-row';
      const inPlay = isEventInPlay(event.start);
      const scoreSource = liveScores && liveScores[event.id] ? liveScores[event.id] : null;
      const scoreLabel = inPlay ? scoreChipMarkup(scoreSource) : '';
      row.innerHTML = `
        <div>
          <div class="title">${event.away} @ ${event.home}${inPlay ? ' <span class="in-play-pill">IN PLAY</span>' : ''}</div>
          <div class="meta">${new Date(event.start).toLocaleString()}${scoreLabel ? ` ${scoreLabel}` : ''}</div>
        </div>
        <div class="market">Spread: ${formatSpread(event.market?.spread)}</div>
        <div class="market">Total: ${formatTotal(event.market?.total)}</div>
      `;
      if (event.id) {
        row.dataset.eventId = event.id;
        row.classList.add('clickable');
        row.addEventListener('click', () => openEventDrawerById(event.id));
      }
      card.appendChild(row);
    });
    wrap.appendChild(card);
  });
  if (!wrap.children.length) {
    wrap.innerHTML = '<div class="empty">No events match the current sport filter.</div>';
    return;
  }
  if (bypassWindow && selectedSport !== 'ALL') {
    wrap.prepend(buildWindowHint('Schedule window override'));
  }
}

function renderMarket(){
  const wrap = document.getElementById('marketMoves');
  wrap.innerHTML = '';
  if (!marketEvents.length) {
    wrap.innerHTML = '<div class="empty">No market data available</div>';
    return;
  }
  const bypassWindow = shouldBypassWindowFor(marketEvents);
  const ignoreWindow = bypassWindow || selectedSport === 'ALL';
  const filtered = marketEvents.filter(evt => eventMatchesFilters(evt, { ignoreWindow }));
  if (!filtered.length) {
    wrap.innerHTML = '<div class="empty">No events match the current sport filter.</div>';
    return;
  }
  if (bypassWindow && selectedSport !== 'ALL') {
    wrap.appendChild(buildWindowHint('Market window override'));
  }
  const ordered = filtered
    .slice()
    .sort((a, b) => maxMove(b) - maxMove(a))
    .slice(0, 8);

  ordered.forEach(evt => {
    const card = document.createElement('div');
    card.className = 'market-card';
    if (evt.id === selectedEventId) card.classList.add('active');
    card.addEventListener('click', () => openEventDrawer(evt));
    const startLabel = formatStart(evt.start);
    const propsCount = evt.propsAvailable || 0;
    const spreadMove = formatMove(evt.moves?.spread);
    const totalMove = formatMove(evt.moves?.total);
    const bestSpread = bestEdge(evt, 'spread');
    const bestTotal = bestEdge(evt, 'total');

    card.innerHTML = `
      <div class="title">${evt.away} @ ${evt.home}</div>
      <div class="market-meta">
        <span>${evt.league || '—'} · ${startLabel}</span>
        <span>${propsCount} props</span>
      </div>
      <div class="market-grid">
        <div class="market-pill">Consensus spread: ${formatNumber(evt.consensus?.spread)} ${spreadMove}</div>
        <div class="market-pill">Consensus total: ${formatNumber(evt.consensus?.total)} ${totalMove}</div>
        <div class="market-pill">Model spread: ${formatNumber(evt.model?.spread)} ${formatDelta(evt.modelEdge?.spread)}</div>
        <div class="market-pill">Model total: ${formatNumber(evt.model?.total)} ${formatDelta(evt.modelEdge?.total)}</div>
        <div class="market-pill ${edgeClass(bestSpread)}">Best spread edge: ${formatEdge(bestSpread)}</div>
        <div class="market-pill ${edgeClass(bestTotal)}">Best total edge: ${formatEdge(bestTotal)}</div>
      </div>
    `;
    wrap.appendChild(card);
  });
}

function renderOverview(){
  if (!overviewCardsEl) return;
  const totalEvents = marketEvents.length;
  const uniqueSports = new Set(marketEvents.map(evt => normalizeSport(evt.league)).filter(Boolean)).size;
  const windowEvents = marketEvents.filter(eventMatchesFilters).length;
  const modeledEvents = marketEvents.filter(evt => evt.model).length;
  const nextStart = nextEventStartLabel();
  const bookLines = marketBooks.map(book => `<div>${book.book.toUpperCase()} · ${formatAgo(book.polledAt)}</div>`).join('');
  const windowScopeLabel = selectedSport === 'ALL' ? 'ALL markets' : `${betWindowHours}h window`;

  overviewCardsEl.innerHTML = `
    <div class="overview-card">
      <h3>Tracked events</h3>
      <p>${totalEvents || 'No data'}</p>
      <small>${uniqueSports || 0} sports</small>
    </div>
    <div class="overview-card">
      <h3>Inside window (${windowScopeLabel})</h3>
      <p>${windowEvents}</p>
      <small>${nextStart || 'No eligible events'}</small>
    </div>
    <div class="overview-card">
      <h3>Model coverage</h3>
      <p>${modeledEvents}/${totalEvents || 0}</p>
      <small>${modeledEvents ? 'Live overlays enabled' : 'Awaiting model data'}</small>
    </div>
    <div class="overview-card">
      <h3>Books polled</h3>
      <p>${marketBooks.length ? `${marketBooks.length} feeds` : 'No feeds'}</p>
      <small>${bookLines || 'Awaiting feeds'}</small>
    </div>
  `;
}

function renderEdgeBoard(){
  if (!edgeBoardEl) return;
  updateEdgeModeHint();
  const bypassWindow = shouldBypassWindowFor(marketEvents);
  const ignoreWindow = bypassWindow || selectedSport === 'ALL';
  const configs = [
    { key: 'spread', title: 'Spread edges', formatter: edge => `Line ${formatNumber(edge.line)} vs cons ${formatNumber(edge.consensus)}` },
    { key: 'total', title: 'Total edges', formatter: edge => `Line ${formatNumber(edge.line)} vs cons ${formatNumber(edge.consensus)}` },
    { key: 'moneyline', title: 'Moneyline edges', formatter: edge => `${formatPercent(edge.consensus)} vs book ${formatPercent(edge.bookValue)} (${formatMoneyline(edge.moneyline)})` }
  ];
  edgeBoardEl.innerHTML = '';
  if (bypassWindow && selectedSport !== 'ALL') {
    edgeBoardEl.appendChild(buildWindowHint('Edge board window override'));
  }
  configs.forEach(cfg => {
    const column = document.createElement('div');
    column.className = 'edge-column';
    column.innerHTML = `<h3>${cfg.title}</h3>`;
    const edges = collectEdges(cfg.key, ignoreWindow);
    if (!edges.length) {
      column.innerHTML += '<div class="empty">No qualifying edges</div>';
    } else {
      edges.forEach(edge => column.appendChild(buildEdgeItem(edge, cfg.formatter)));
    }
    edgeBoardEl.appendChild(column);
  });
}

function updateEdgeModeHint(){
  const hint = document.querySelector('.edge-toolbar-hint');
  if (!hint) return;
  const copy = {
    overlay: 'Showing overlays (books lagging model/consensus).',
    fade: 'Showing fades (books rich vs fair).',
    all: 'Showing both overlays and fades (ranked by magnitude).'
  };
  hint.textContent = copy[edgeMode] || copy.overlay;
}

function collectEdges(key, ignoreWindow = false){
  const edges = [];
  const windowOverride = ignoreWindow || selectedSport === 'ALL';
  marketEvents.forEach(evt => {
    if (!eventMatchesFilters(evt, { ignoreWindow: windowOverride })) return;
    (evt.books || []).forEach(book => {
      const hasModel = evt.model && Number.isFinite(book.modelEdges?.[key]);
      const value = hasModel ? book.modelEdges?.[key] : book.edges?.[key];
      if (!Number.isFinite(value) || value === 0) return;
      if (!matchesEdgeBias(value)) return;
      const line = key === 'spread' ? book.spread?.home : key === 'total' ? book.total?.line : null;
      const consensusValue = key === 'spread' ? evt.consensus?.spread : key === 'total' ? evt.consensus?.total : evt.consensus?.moneylineHomeProb;
      const modelValue = evt.model ? (key === 'spread' ? evt.model.spread : key === 'total' ? evt.model.total : evt.model.moneylineHomeProb) : null;
      const bookValue = key === 'moneyline' ? americanToImplied(book.moneyline?.home) : null;
      edges.push({
        eventId: evt.id,
        label: `${evt.away} @ ${evt.home}`,
        league: evt.league || '—',
        start: evt.start,
        book: book.book,
        value,
        line,
        consensus: consensusValue,
        modelValue,
        bookValue,
        moneyline: book.moneyline,
        market: key,
        source: hasModel ? 'model' : 'consensus'
      });
    });
  });
  const precision = key === 'moneyline' ? 4 : 3;
  return sortEdgesByBias(edges)
    .slice(0, 5)
    .map(edge => ({ ...edge, precision }));
}

function matchesEdgeBias(value){
  if (!Number.isFinite(value) || value === 0) return false;
  if (edgeMode === 'overlay') return value > 0;
  if (edgeMode === 'fade') return value < 0;
  return true;
}

function sortEdgesByBias(list){
  const copy = list.slice();
  if (edgeMode === 'overlay') {
    return copy.sort((a, b) => b.value - a.value);
  }
  if (edgeMode === 'fade') {
    return copy.sort((a, b) => a.value - b.value);
  }
  return copy.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

function buildEdgeItem(edge, formatter){
  const div = document.createElement('div');
  div.className = 'edge-item';
  const sourceBadge = edge.source === 'model' ? '<span class=\"edge-source\">MODEL</span>' : '<span class=\"edge-source\">CONS</span>';
  const valueClass = edge.value >= 0 ? 'positive' : 'negative';
  const valueLabel = `${edge.value > 0 ? '+' : ''}${edge.value.toFixed(edge.precision)}`;
  div.innerHTML = `
    <div class="edge-head">
      <span>${edge.book.toUpperCase()}</span>
      ${sourceBadge}
      <span class="edge-value ${valueClass}">${valueLabel}</span>
    </div>
    <div class="edge-meta">${edge.label} · ${edge.league} · ${formatStart(edge.start)}</div>
    <div class="edge-line">${formatter(edge)}</div>
  `;
  div.addEventListener('click', () => openEventDrawerById(edge.eventId));
  return div;
}

function eventMatchesFilters(evt, opts){
  const options = (opts && typeof opts === 'object') ? opts : {};
  const ignoreWindow = options.ignoreWindow === true;
  const sport = normalizeSport(evt.league);
  const sportOk = selectedSport === 'ALL' || sport === selectedSport;
  if (!sportOk) return false;
  if (ignoreWindow) return true;
  return withinBetWindow(evt.start);
}

function shouldBypassWindowFor(events){
  if (!Array.isArray(events) || !events.length) return false;
  const matchesSport = events.some(evt => eventMatchesFilters(evt, { ignoreWindow: true }));
  if (!matchesSport) return false;
  return !events.some(evt => eventMatchesFilters(evt));
}

const SCHEDULE_PASS_GRACE_MS = 60 * 60 * 1000; // keep in-play events visible for up to 60 minutes

function withinBetWindow(start){
  if (!start || !betWindowHours) return true;
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return true;
  const minutes = (date.getTime() - Date.now()) / 60000;
  return minutes <= betWindowHours * 60 && minutes >= -60;
}

function hasEventPassed(start){
  if (!start) return false;
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() < (Date.now() - SCHEDULE_PASS_GRACE_MS);
}

function isEventInPlay(start){
  if (!start) return false;
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return false;
  const now = Date.now();
  return date.getTime() <= now && !hasEventPassed(start);
}

function scoreChipMarkup(score){
  if (!score || typeof score !== 'object') return '';
  const home = Number.isFinite(Number(score.home)) ? Number(score.home) : '—';
  const away = Number.isFinite(Number(score.away)) ? Number(score.away) : '—';
  const status = score.status ? ` · ${escapeHtml(String(score.status))}` : '';
  return `<span class="score-chip">${home} – ${away}${status}</span>`;
}

function expandWindowToIncludeNextEvent(){
  if (!marketEvents.length) return false;
  const sportFiltered = marketEvents.filter(evt => {
    const sport = normalizeSport(evt.league);
    return selectedSport === 'ALL' || sport === selectedSport;
  });
  if (!sportFiltered.length) return false;
  const inWindow = sportFiltered.filter(evt => eventMatchesFilters(evt));
  if (inWindow.length) return false;
  const futureStarts = sportFiltered
    .map(evt => new Date(evt.start))
    .filter(date => !Number.isNaN(date.getTime()) && date.getTime() >= Date.now());
  if (!futureStarts.length) return false;
  futureStarts.sort((a, b) => a.getTime() - b.getTime());
  const hoursToNext = Math.ceil((futureStarts[0].getTime() - Date.now()) / 3600000);
  if (!Number.isFinite(hoursToNext) || hoursToNext <= betWindowHours) return false;
  const nextWindow = Math.min(96, Math.max(betWindowHours, hoursToNext + 1));
  if (nextWindow === betWindowHours) return false;
  betWindowHours = nextWindow;
  betWindowInput.value = betWindowHours;
  localStorage.setItem('sporterBetWindowHours', betWindowHours);
  return true;
}

function normalizeSport(value){
  if (!value) return null;
  return String(value).trim().toUpperCase();
}

function maxMove(evt){
  const spread = Math.abs(evt.moves?.spread || 0);
  const total = Math.abs(evt.moves?.total || 0);
  return Math.max(spread, total);
}

function formatNumber(value){
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.abs(value) >= 1 ? value.toFixed(1) : value.toFixed(2);
  if (value > 0) return `+${rounded}`;
  return rounded;
}

function formatMove(value){
  if (!Number.isFinite(value) || value === 0) return '';
  const sign = value > 0 ? '+' : '';
  return `<span class="${value > 0 ? 'positive' : 'negative'}">Δ ${sign}${value.toFixed(2)}</span>`;
}

const formatDelta = (value) => formatMove(value);

function bestEdge(evt, key){
  if (!evt?.books) return null;
  let best = null;
  evt.books.forEach(book => {
    const hasModel = evt.model && Number.isFinite(book.modelEdges?.[key]);
    const val = hasModel ? book.modelEdges?.[key] : book.edges?.[key];
    if (!Number.isFinite(val)) return;
    if (!best || Math.abs(val) > Math.abs(best.value)) {
      best = { book: book.book, value: val, source: hasModel ? 'model' : 'consensus' };
    }
  });
  return best;
}

function formatEdge(edge){
  if (!edge) return '—';
  const precision = edge.value > 0.999 ? 2 : 3;
  const sign = edge.value > 0 ? '+' : '';
  const source = edge.source === 'model' ? ' · model' : '';
  return `${edge.book || '—'} ${sign}${edge.value.toFixed(precision)}${source}`;
}

function edgeClass(edge){
  if (!edge || edge.value === 0) return '';
  return edge.value > 0 ? 'positive' : 'negative';
}

function formatStart(value){
  if (!value) return 'TBD';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60000);
  if (diffMinutes <= 0) return 'in play / final';
  if (diffMinutes < 60) return `in ${diffMinutes}m`;
  const hours = Math.round(diffMinutes / 60);
  return `in ${hours}h`;
}

function formatSpread(spread){
  if (!spread || typeof spread.home !== 'number') return '—';
  const price = typeof spread.price === 'number' ? spread.price : 'EVEN';
  return `${spread.home > 0 ? '+' : ''}${spread.home} (${price})`;
}

function formatTotal(total){
  if (!total || typeof total.line !== 'number') return '—';
  const over = typeof total.over === 'number' ? total.over : null;
  const under = typeof total.under === 'number' ? total.under : null;
  if (over !== null && under !== null) return `${total.line} (O ${over} / U ${under})`;
  return `${total.line}`;
}

function openEventDrawerById(id){
  const evt = marketEvents.find(event => event.id === id);
  if (!evt) {
    openEventDrawer(null);
    return;
  }
  openEventDrawer(evt);
}

function openEventDrawer(evt){
  if (!drawerEl) return;
  if (!evt) {
    selectedEventId = null;
    drawerEl.classList.remove('open');
    drawerEl.setAttribute('aria-hidden', 'true');
    if (drawerFocusReturn?.isConnected && !drawerFocusReturn.hasAttribute('disabled')) {
      try { drawerFocusReturn.focus({ preventScroll: true }); } catch {}
    }
    drawerFocusReturn = null;
    renderMarket();
    return;
  }
  if (!drawerEl.classList.contains('open')) {
    drawerFocusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  selectedEventId = evt.id;
  drawerEl.classList.add('open');
  drawerEl.setAttribute('aria-hidden', 'false');
  drawerTitle.textContent = `${evt.away} @ ${evt.home}`;
  drawerMeta.textContent = `${evt.league || '—'} · ${new Date(evt.start).toLocaleString()}`;
  drawerConsensus.innerHTML = `
    <div><strong>Cons. spread</strong><br/>${formatNumber(evt.consensus?.spread)}</div>
    <div><strong>Model spread</strong><br/>${formatNumber(evt.model?.spread)} ${formatDelta(evt.modelEdge?.spread)}</div>
    <div><strong>Cons. total</strong><br/>${formatNumber(evt.consensus?.total)}</div>
    <div><strong>Model total</strong><br/>${formatNumber(evt.model?.total)} ${formatDelta(evt.modelEdge?.total)}</div>
    <div><strong>Home win</strong><br/>${formatPercent(evt.consensus?.moneylineHomeProb)}</div>
    <div><strong>Model home</strong><br/>${formatPercent(evt.model?.moneylineHomeProb)} ${formatDelta(evt.modelEdge?.moneylineHomeProb)}</div>
  `;
  drawerBooks.innerHTML = buildBookTable(evt);
  drawerProps.innerHTML = buildPropsList(evt);
  renderMarket();
  requestAnimationFrame(() => {
    try { drawerCloseBtn?.focus({ preventScroll: true }); } catch {}
  });
}

function syncDrawer(){
  if (!selectedEventId) return;
  const evt = marketEvents.find(event => event.id === selectedEventId);
  const bypassWindow = shouldBypassWindowFor(marketEvents);
  if (!evt || !eventMatchesFilters(evt, { ignoreWindow: bypassWindow })) {
    openEventDrawer(null);
    return;
  }
  openEventDrawer(evt);
}

function buildBookTable(evt){
  const books = evt.books || [];
  if (!books.length) return '<div class="empty">No book data</div>';
  const rows = books.map(book => `
    <tr>
      <td>${book.book.toUpperCase()}</td>
      <td>${formatSpread(book.spread)}</td>
      <td>${formatTotal(book.total)}</td>
      <td>${formatMoneyline(book.moneyline)}</td>
      <td>${formatEdgeValue(book.edges?.spread)}</td>
      <td>${formatEdgeValue(book.modelEdges?.spread)}</td>
      <td>${formatEdgeValue(book.edges?.total)}</td>
      <td>${formatEdgeValue(book.modelEdges?.total)}</td>
      <td>${formatEdgeValue(book.edges?.moneyline, 4)}</td>
      <td>${formatEdgeValue(book.modelEdges?.moneyline, 4)}</td>
    </tr>
  `).join('');
  return `
    <table>
      <thead>
        <tr>
          <th>Book</th>
          <th>Spread</th>
          <th>Total</th>
          <th>Moneyline</th>
          <th>Edge (S)</th>
          <th>Model Edge (S)</th>
          <th>Edge (T)</th>
          <th>Model Edge (T)</th>
          <th>Edge (ML)</th>
          <th>Model Edge (ML)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildPropsList(evt){
  const props = [];
  (evt.books || []).forEach(book => {
    (book.props || []).forEach(prop => {
      props.push({ ...prop, book: book.book });
    });
  });
  if (!props.length) return '<div class="empty">No props published</div>';
  return props.map(prop => {
    const line = Number.isFinite(prop.line) ? `Line ${prop.line}` : 'No line';
    const over = Number.isFinite(prop.over) ? `O ${prop.over}` : null;
    const under = Number.isFinite(prop.under) ? `U ${prop.under}` : null;
    const price = [over, under].filter(Boolean).join(' / ');
    return `
      <div class="drawer-prop-row">
        <strong>${prop.market} · ${prop.runner}</strong>
        <span>${prop.book.toUpperCase()} · ${line}</span>
        <span>${price || 'Prices unavailable'}</span>
      </div>
    `;
  }).join('');
}

function formatEdgeValue(value, precision = 3){
  if (!Number.isFinite(value) || value === 0) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(precision)}`;
}

function formatMoneyline(moneyline){
  if (!moneyline) return '—';
  const home = typeof moneyline.home === 'number' ? moneyline.home : null;
  const away = typeof moneyline.away === 'number' ? moneyline.away : null;
  const draw = typeof moneyline.draw === 'number' ? moneyline.draw : null;
  const parts = [];
  if (home !== null) parts.push(`H ${home > 0 ? '+' : ''}${home}`);
  if (away !== null) parts.push(`A ${away > 0 ? '+' : ''}${away}`);
  if (draw !== null) parts.push(`D ${draw > 0 ? '+' : ''}${draw}`);
  return parts.join(' / ') || '—';
}

function formatPercent(prob){
  if (!Number.isFinite(prob)) return '—';
  return `${(prob * 100).toFixed(1)}%`;
}

function nextEventStartLabel(){
  const future = marketEvents
    .filter(eventMatchesFilters)
    .map(evt => new Date(evt.start))
    .filter(date => !Number.isNaN(date.getTime()) && date.getTime() >= Date.now());
  if (!future.length) return null;
  const soonest = future.sort((a, b) => a.getTime() - b.getTime())[0];
  const diffMinutes = Math.round((soonest.getTime() - Date.now()) / 60000);
  if (diffMinutes <= 0) return 'In play';
  if (diffMinutes < 60) return `Next in ${diffMinutes}m`;
  const hours = Math.round(diffMinutes / 60);
  return `Next in ${hours}h`;
}

function formatAgo(iso){
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const diffMinutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const hours = Math.round(diffMinutes / 60);
  return `${hours}h ago`;
}

function americanToImplied(odds){
  const num = Number(odds);
  if (!Number.isFinite(num)) return null;
  if (num > 0) return Number((100 / (num + 100)).toFixed(4));
  return Number(((-num) / ((-num) + 100)).toFixed(4));
}

function buildWindowHint(label){
  const div = document.createElement('div');
  div.className = 'window-hint';
  const sportLabel = selectedSport === 'ALL' ? 'tracked events' : `${selectedSport} events`;
  div.innerHTML = `
    <strong>${label}</strong>
    <span>No ${sportLabel} fall inside the next ${betWindowHours}h window. Showing the full board so you maintain context. Adjust the bet-window filter to tighten the scope.</span>
  `;
  return div;
}

async function init(){
  await Promise.all([fetchSchedule(), fetchMarket(), fetchLiveScores()]);
  setInterval(fetchSchedule, 60000);
  setInterval(fetchMarket, 60000);
  setInterval(fetchLiveScores, 30000);
}

init();
