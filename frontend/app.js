const $ = (id)=>document.getElementById(id);
let authRedirectInFlight = false;
const scheduleAuthRedirect = (reason = 'expired') => {
  if (authRedirectInFlight) return;
  authRedirectInFlight = true;
  try {
    sessionStorage.setItem('betmanAuthReturn', window.location.pathname + window.location.search);
  } catch {}
  const qs = new URLSearchParams({ [reason]: '1', ts: String(Date.now()) });
  window.location.href = `/login?${qs.toString()}`;
};
const fetchLocal = async (u, opts = {}) => {
  const res = await fetch(new URL(u, window.location.origin).toString(), { credentials: 'same-origin', ...opts });
  if (res.status === 401) {
    const headerReason = (res.headers.get('x-auth-reason') || '').toLowerCase();
    const reasonKey = headerReason === 'logout' ? 'logout' : 'expired';
    scheduleAuthRedirect(reasonKey);
    throw new Error('auth_required');
  }
  return res;
};

const readJsonSafe = async (res) => {
  const text = await res.text();
  try {
    return { data: JSON.parse(text), raw: text };
  } catch {
    return { data: null, raw: text };
  }
};
const BETMAN_BUILD = '20260319-0936';
const STRATEGY_MIN_BETS = 30;
const SIGNAL_GLOSSARY = {
  implied: 'Market-implied probability from current odds (100 / odds).',
  model: 'BETMAN simulation-based probability estimate.',
  edge: 'Edge = Model % - Implied %. Positive suggests potential value; negative suggests price may be too short.',
  recommended: 'Primary win selection after policy checks. Forced fallback can apply when enabled.',
  oddsRunner: 'Longer-price runner tracked for upside. Qualified requires positive edge and minimum odds.',
  ew: 'Each-way candidate requiring place profile support and minimum win chance.'
};
const STRATEGY_MIN_ROI_COVERAGE = 0.7;
const lastOddsSnapshot = new Map();
const ODDS_SIGNAL_TTL_MS = 45000;
let feelGoodChart = null;
let roiTrendChart = null;
let winRateTrendChart = null;
let returnUnitsChart = null;
let returnRoiChart = null;
let analysisEdgeChart = null;
let analysisMonteChart = null;
let currentUserDisplayName = 'User';
let latestStrategyContext = { picks: [], stats: null, type: 'win', meeting: '—', aiSummaryHtml: '' };
const STRATEGY_AI_CACHE_TTL_MS = 10 * 60 * 1000;
const STRATEGY_AI_COOLDOWN_MS = 3 * 60 * 1000;
let userMeetingBias = {};
let aiUserNotes = [];
let strategyRaceModelCache = new Map();
let runnerMetricsIndex = new Map();
let runnerMetricsMeta = { loadedAt: 0, rows: 0 };

async function loadRunnerMetrics(force = false){
  if (!force && runnerMetricsMeta.loadedAt && (Date.now() - runnerMetricsMeta.loadedAt) < 60_000) return;
  try {
    const res = await fetchLocal('./data/runner_key_metrics.json', { cache: 'no-store' });
    if (!res.ok) return;
    const payload = await res.json();
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    const next = new Map();
    rows.forEach(row => {
      const meeting = String(row?.meeting || '').trim().toLowerCase();
      const race = String(row?.race || '').replace(/^R/i,'').trim();
      const runner = normalizeRunnerName(row?.runner || row?.selection || '');
      if (!meeting || !race || !runner) return;
      next.set(`${meeting}|${race}|${runner}`, row);
    });
    runnerMetricsIndex = next;
    runnerMetricsMeta = { loadedAt: Date.now(), rows: rows.length };
  } catch {}
}

function renderAnalysisVisuals(){
  if (typeof Chart === 'undefined') return;

  const edgeCanvas = $('analysisEdgeChart');
  const edgeRows = Array.isArray(latestAnalysisSignals?.edgeRows) ? latestAnalysisSignals.edgeRows : [];
  if (edgeCanvas && edgeRows.length) {
    const labels = edgeRows.map(r => r.name);
    const implied = edgeRows.map(r => Number.isFinite(r.impliedPct) ? r.impliedPct : null);
    const modeled = edgeRows.map(r => Number.isFinite(r.modeledPct) ? r.modeledPct : null);
    const edge = edgeRows.map(r => Number.isFinite(r.edgePct) ? r.edgePct : null);

    if (analysisEdgeChart) {
      analysisEdgeChart.destroy();
      analysisEdgeChart = null;
    }

    analysisEdgeChart = new Chart(edgeCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { type: 'line', label: 'Implied %', data: implied, borderColor: '#7aa3c7', backgroundColor: '#7aa3c7', borderWidth: 2, pointRadius: 2, yAxisID: 'y' },
          { type: 'line', label: 'Model %', data: modeled, borderColor: '#c5ff00', backgroundColor: '#c5ff00', borderWidth: 2, pointRadius: 2, yAxisID: 'y' },
          { type: 'bar', label: 'Edge %', data: edge, backgroundColor: edge.map(v => (Number(v) >= 0 ? 'rgba(41,214,124,0.7)' : 'rgba(255,107,107,0.7)')), borderColor: edge.map(v => (Number(v) >= 0 ? '#29d67c' : '#ff6b6b')), borderWidth: 1, yAxisID: 'y1' }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { position: 'left', title: { display: true, text: 'Probability %' }, ticks: { callback: (v)=>`${v}%` } },
          y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Edge %' }, ticks: { callback: (v)=>`${v}%` } }
        },
        plugins: {
          legend: { labels: { color: '#c9d5e3' } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const value = Number(ctx.raw);
                if (ctx.dataset.label === 'Implied %') return `Implied %: ${value.toFixed(1)}% (${SIGNAL_GLOSSARY.implied})`;
                if (ctx.dataset.label === 'Model %') return `Model %: ${value.toFixed(1)}% (${SIGNAL_GLOSSARY.model})`;
                if (ctx.dataset.label === 'Edge %') return `Edge %: ${value.toFixed(1)} pts (${SIGNAL_GLOSSARY.edge})`;
                return `${ctx.dataset.label}: ${value.toFixed(1)}%`;
              },
              footer: (items) => {
                const edgePoint = items.find(i => i.dataset?.label === 'Edge %');
                if (!edgePoint) return '';
                const edge = Number(edgePoint.raw || 0);
                if (edge > 0) return 'Positive edge: model rates this better than market price.';
                if (edge < 0) return 'Negative edge: market price is shorter than model value.';
                return 'Neutral edge: model and market aligned.';
              }
            }
          }
        }
      }
    });
  }

  const monteCanvas = $('analysisMonteChart');
  const monteRows = Array.isArray(latestAnalysisSignals?.monteRows) ? latestAnalysisSignals.monteRows : [];
  if (monteCanvas && monteRows.length) {
    if (analysisMonteChart) {
      analysisMonteChart.destroy();
      analysisMonteChart = null;
    }
    const mapTag = (rawTag) => rawTag === 'tag.win' ? 'Recommended Bet'
      : rawTag === 'tag.ai-winner' ? 'AI Winner'
      : rawTag === 'tag.model' ? 'Model Leader'
      : rawTag === 'tag.value' ? 'Value'
      : rawTag === 'tag.ew' ? 'EW'
      : rawTag === 'tag.long' ? 'Long'
      : 'Other';
    const compactRows = monteRows.slice(0, 8);
    analysisMonteChart = new Chart(monteCanvas, {
      type: 'bar',
      data: {
        labels: compactRows.map(r => `${r.name} · ${mapTag(r.tag || 'other')}`),
        datasets: [{
          label: 'Monte Carlo Win %',
          data: compactRows.map(r => Number(r.winPct || 0)),
          backgroundColor: 'rgba(197,255,0,0.35)',
          borderColor: '#c5ff00',
          borderWidth: 1.2,
          borderRadius: 4,
          barThickness: 12,
          maxBarThickness: 14
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, ticks: { callback: (v)=>`${v}%`, color: '#9fb0c3' }, grid: { color: 'rgba(130,150,170,0.18)' } },
          y: { ticks: { color: '#c9d5e3' }, grid: { display: false } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `Win %: ${Number(ctx.raw || 0).toFixed(1)}%` } }
        }
      }
    });
  }
}

function setTableLoading(id, text='Loading…'){
  const el = $(id);
  if (!el) return;
  el.innerHTML = `<div class='row'><div style='grid-column:1/-1'>${text}</div></div>`;
}

function setBakeoffRunIndicator(state, message){
  const indicator = $('bakeoffRunIndicator');
  if (!indicator) return;
  indicator.classList.remove('active','running','success','error');
  if (!message) {
    indicator.textContent = '';
    return;
  }
  indicator.textContent = message;
  indicator.classList.add('active');
  if (state && ['running','success','error'].includes(state)) {
    indicator.classList.add(state);
  }
}

function applyTheme(theme){
  const t = (theme === 'light') ? 'light' : 'dark';
  document.body.setAttribute('data-theme', t);
  localStorage.setItem('betmanTheme', t);
  const btn = $('themeToggleBtn');
  if (btn) btn.textContent = (t === 'light') ? 'Dark Mode' : 'Light Mode';
}

function initTheme(){
  const saved = localStorage.getItem('betmanTheme') || 'dark';
  applyTheme(saved);
}


function inferProviderFromModel(model){
  const m = String(model || '').toLowerCase();
  return (m.includes('gpt') || m.includes('o1') || m.includes('o3')) ? 'openai' : 'ollama';
}

function loadSavedAiModel(){
  try {
    const saved = JSON.parse(localStorage.getItem('betmanAiModel') || '{}');
    if (saved && saved.model) selectedAiModel = { provider: saved.provider || inferProviderFromModel(saved.model), model: saved.model };
  } catch {}
  try {
    const stored = localStorage.getItem('betmanAiModelManualLock');
    if (stored === null) {
      aiModelManualLock = true;
    } else {
      aiModelManualLock = stored === '1';
    }
  } catch {
    aiModelManualLock = true;
  }
}

function persistAiModel(){
  try {
    localStorage.setItem('betmanAiModel', JSON.stringify(selectedAiModel));
    localStorage.setItem('betmanAiModelManualLock', aiModelManualLock ? '1' : '0');
  } catch {}
}

function setAiModelManualLock(state){
  aiModelManualLock = !!state;
  persistAiModel();
  updateAiModelLockUi();
}

function updateAiModelLockUi(){
  const note = $('aiModelManualLockNote');
  const resetBtn = $('aiModelAutoResetBtn');
  if (note) {
    note.style.display = aiModelManualLock ? 'block' : 'none';
  }
  if (resetBtn) {
    resetBtn.disabled = !aiModelManualLock;
    resetBtn.onclick = () => {
      if (!aiModelManualLock) return;
      setAiModelManualLock(false);
      refreshAiAnalyseButtonState();
      updateAnalysisAiModelNote();
    };
  }
}

function renderAiModelSelect(){
  const sel = $('aiModelSelect');
  if (!sel) return;
  const groups = [];
  const ollamaModels = aiModelCatalog.ollamaModels || [];
  const openAiTestable = (aiModelCatalog.capabilities?.openaiPermitted ? (aiModelCatalog.openaiModels || []) : []);
  if (ollamaModels.length) groups.push(['Ollama','ollama', ollamaModels]);
  if (openAiTestable.length) groups.push(['OpenAI','openai', openAiTestable]);
  if (!groups.length) {
    sel.innerHTML = '<option disabled>Models unavailable</option>';
    sel.disabled = true;
    const warning = $('aiModelWarning');
    if (warning) {
      warning.textContent = aiModelCatalog.openaiBlockedReason || 'No AI providers are configured.';
      warning.style.display = 'block';
    }
    return;
  }
  sel.disabled = false;
  sel.innerHTML = '';
  groups.forEach(([label, provider, models]) => {
    const og = document.createElement('optgroup');
    og.label = label;
    models.forEach(model => {
      const o = document.createElement('option');
      o.value = `${provider}::${model}`;
      o.textContent = model;
      if (selectedAiModel.provider === provider && selectedAiModel.model === model) o.selected = true;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  const warning = $('aiModelWarning');
  if (warning) {
    if (aiModelCatalog.openaiBlockedReason && !openAiTestable.length && (aiModelCatalog.openaiModels || []).length) {
      warning.textContent = aiModelCatalog.openaiBlockedReason;
      warning.style.display = 'block';
    } else {
      warning.textContent = '';
      warning.style.display = 'none';
    }
  }
  sel.onchange = (e)=>{
    const [provider, model] = String(e.target.value || '').split('::');
    if (!model) return;
    selectedAiModel = { provider: provider || inferProviderFromModel(model), model };
    aiModelManualLock = true;
    persistAiModel();
    updateAiModelLockUi();
    refreshAiAnalyseButtonState();
    updateAnalysisAiModelNote();
  };
  refreshAiAnalyseButtonState();
  updateAnalysisAiModelNote();
  updateAiModelLockUi();
}

async function loadAiModels(){
  loadSavedAiModel();
  const sel = $('aiModelSelect');
  if (sel) { sel.innerHTML = '<option>Loading…</option>'; sel.disabled = true; }
  try {
    const data = await fetchLocal('./api/ai-models', { cache: 'no-store' }).then(r=>r.json());
    let ollamaModels = Array.isArray(data.ollamaModels) ? data.ollamaModels : [];
    const openaiModels = Array.isArray(data.openaiModels) ? data.openaiModels : [];
    const openaiAllowed = !!data.openaiAllowed;
    const hasOpenAiKey = !!data.hasOpenAiKey;
    const defaultOllamaModel = 'deepseek-r1:8b';
    const normalizeName = (val) => String(val || '').trim().toLowerCase();
    const prioritized = ollamaModels.find(m => normalizeName(m) === normalizeName(defaultOllamaModel));
    if (prioritized) {
      ollamaModels = [prioritized, ...ollamaModels.filter(m => normalizeName(m) !== normalizeName(defaultOllamaModel))];
    }
    let openaiPermitted = openaiAllowed && hasOpenAiKey;
    if (!openaiPermitted && isAdminUser && hasOpenAiKey) {
      openaiPermitted = true;
    }
    aiModelCatalog = {
      providerDefault: data.providerDefault || 'ollama',
      ollamaModels,
      openaiModels,
      capabilities: {
        openaiAllowed,
        hasOpenAiKey,
        openaiPermitted,
        openaiUiEnabled: !!data.openAiUiEnabled
      },
      openaiBlockedReason: ''
    };
    if (!openaiPermitted && openaiModels.length) {
      aiModelCatalog.openaiBlockedReason = hasOpenAiKey ? 'OpenAI usage is disabled for this login.' : 'OpenAI API key missing on server.';
    }
    const openAiTestable = openaiPermitted ? openaiModels : [];
    const all = [...ollamaModels, ...openAiTestable];
    if (aiModelCatalog.providerDefault === 'openai' && openAiTestable.length && selectedAiModel.provider === 'ollama') {
      selectedAiModel = { provider: 'openai', model: openAiTestable[0] };
      persistAiModel();
    }
    if (!selectedAiModel.model || !all.includes(selectedAiModel.model)) {
      const preferred = (aiModelCatalog.providerDefault === 'openai' && openAiTestable.length) ? openAiTestable[0] : ollamaModels[0];
      const fallback = preferred || ollamaModels[0] || openAiTestable[0] || 'deepseek-r1:8b';
      selectedAiModel = { provider: inferProviderFromModel(fallback), model: fallback };
      persistAiModel();
    }
  } catch {}
  renderAiModelSelect();
}


let analysisProgressInterval = null;
let analysisProgressPct = 0;

function setAnalysisProgress(pct){
  analysisProgressPct = Math.max(0, Math.min(100, pct));
  const bar = $('analysisProgressBar');
  const label = $('analysisProgressPct');
  if (bar) bar.style.width = `${analysisProgressPct}%`;
  if (label) label.textContent = `${Math.round(analysisProgressPct)}%`;
}

function startAnalysisProgressMeter(){
  stopAnalysisProgressMeter();
  analysisProgressPct = 0;
  setAnalysisProgress(0);
  const startedAt = Date.now();
  const expectedMs = 12000; // typical AI response time
  analysisProgressInterval = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    // Ease to ~90% over expectedMs, then slow to cap at 92% until real completion
    const raw = (elapsed / expectedMs) * 90;
    const eased = raw < 60 ? raw : 60 + (raw - 60) * 0.3;
    setAnalysisProgress(Math.min(92, eased));
  }, 200);
}

function stopAnalysisProgressMeter(complete){
  if (analysisProgressInterval) {
    clearInterval(analysisProgressInterval);
    analysisProgressInterval = null;
  }
  if (complete) setAnalysisProgress(100);
}

function showAnalysisProcessingHint(msg){
  const hint = $('analysisProcessingHint');
  if (!hint) return;
  hint.classList.add('active');
  hint.style.display = '';
  if (msg) {
    const text = $('analysisProcessingText');
    if (text) text.textContent = msg;
    stopAnalysisProcessingStages();
  } else {
    startAnalysisProcessingStages();
  }
  startAnalysisProgressMeter();
}

function hideAnalysisProcessingHint(){
  const hint = $('analysisProcessingHint');
  if (!hint) return;
  stopAnalysisProcessingStages();
  stopAnalysisProgressMeter(true);
  setTimeout(() => {
    hint.classList.remove('active');
    hint.style.display = 'none';
    setAnalysisProgress(0);
  }, 400);
}

function startAnalysisProcessingStages(){
  stopAnalysisProcessingStages();
  const text = $('analysisProcessingText');
  if (!text) return;
  const modelLabel = selectedAiModel.model || '—';
  const setStageText = (label) => {
    text.textContent = `${label} · ${modelLabel}`;
  };
  analysisProcessingStageIndex = 0;
  setStageText(AI_ANALYSIS_PROGRESS_STAGES[analysisProcessingStageIndex]);
  const scheduleNext = () => {
    analysisProcessingStageTimer = setTimeout(()=>{
      analysisProcessingStageIndex += 1;
      if (analysisProcessingStageIndex >= AI_ANALYSIS_PROGRESS_STAGES.length) {
        analysisProcessingStageTimer = null;
        return;
      }
      setStageText(AI_ANALYSIS_PROGRESS_STAGES[analysisProcessingStageIndex]);
      scheduleNext();
    }, 1400);
  };
  scheduleNext();
}

function stopAnalysisProcessingStages(){
  if (analysisProcessingStageTimer) {
    clearTimeout(analysisProcessingStageTimer);
    analysisProcessingStageTimer = null;
  }
  analysisProcessingStageIndex = 0;
}

function refreshBetWindowUi(){
  const hint = $('betWindowHint');
  const input = $('betWindowInput');
  if (hint) hint.textContent = `Current: ${earlyWindowMin}m`;
  if (input) input.value = String(earlyWindowMin);
}

function detectClientPlatform(){
  const body = document.body;
  if (!body) return;
  const ua = navigator.userAgent || '';
  const isSafari = /safari/i.test(ua) && !/chrome|crios|android/i.test(ua);
  const isMobile = /Mobi|Android/i.test(ua);
  if (isSafari) body.classList.add('safari-browser');
  if (isMobile) body.classList.add('mobile-device');
}

let racesCache = [];
let selectedRace = null;
let selectedRaceKey = null;

let confidenceSignalThreshold = 40;
let confidenceBaseStakeUnit = 1;
let confidenceBoostStakeUnit = 2;
let stakePerRace = 10;
let exoticStakePerRace = 1;
let earlyWindowMin = 1800;
let aiWindowMin = 10;
let activePage = 'workspace';
let latestSuggestedBets = [];
let latestFilteredSuggested = [];
let latestInterestingRows = [];
let latestMarketMovers = [];
let latestMarketOddsHistory = {};
let latestMarketOddsSnapshot = {};
let latestUpcomingBets = [];
let latestDataVersion = 0;
let pulseEligible = false;
let apiKeyEligible = false;
let apiKeyCreatedAt = null;
let apiKeyPreview = null;
let latestGeneratedApiKey = null;
function loadAiUserNotes(){
  try {
    const raw = localStorage.getItem('aiUserNotes');
    aiUserNotes = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(aiUserNotes)) aiUserNotes = [];
  } catch {
    aiUserNotes = [];
  }
}

function saveAiUserNotes(){
  try { localStorage.setItem('aiUserNotes', JSON.stringify(aiUserNotes.slice(-200))); } catch {}
}

function addAiUserNote(text, meeting){
  const note = String(text || '').trim();
  if (!note) return null;
  const entry = {
    text: note,
    meeting: String(meeting || selectedMeeting || '').trim() || null,
    createdAt: Date.now()
  };
  aiUserNotes.push(entry);
  saveAiUserNotes();
  renderMeetingIntelPanel();
  return entry;
}

function queryAiUserNotes(query, meeting){
  const q = String(query || '').trim().toLowerCase();
  const mtg = String(meeting || selectedMeeting || '').trim().toLowerCase();
  return aiUserNotes
    .slice()
    .reverse()
    .filter(n => !mtg || !n.meeting || String(n.meeting).toLowerCase() === mtg)
    .filter(n => !q || String(n.text || '').toLowerCase().includes(q))
    .slice(0, 8);
}

function renderMeetingIntelPanel(){
  const panel = $('meetingIntelPanel');
  if (!panel) return;
  const meeting = String(selectedMeeting || '').trim();
  if (!meeting || meeting === 'ALL') {
    panel.style.display = 'none';
    return;
  }
  const notes = queryAiUserNotes('', meeting);
  const bias = userMeetingBias[normalizeMeetingNameText(meeting)] || null;
  const noteRows = notes.length
    ? notes.map(n => `<li>${escapeHtml(n.text)}</li>`).join('')
    : '<li>No meeting intel notes yet.</li>';

  panel.style.display = '';
  panel.innerHTML = `
    <div class='analysis-header' style='margin-bottom:8px'>
      <h4 style='margin:0'>Meeting Intel — ${escapeHtml(meeting)}</h4>
      <button id='meetingIntelAddBtn' class='btn btn-ghost compact-btn' type='button'>Add Note</button>
    </div>
    ${bias ? `<div class='sub' style='margin-bottom:6px'>Track bias: ${bias.insideRail ? 'inside rail' : ''}${bias.insideRail && (bias.swoopers || bias.leaders) ? ' + ' : ''}${bias.swoopers ? 'swoopers/off-speed' : ''}${(bias.insideRail || bias.swoopers) && bias.leaders ? ' + ' : ''}${bias.leaders ? 'leaders/on-pace' : ''} (from AI chat)</div>` : ''}
    <ul style='margin:0;padding-left:18px;display:grid;gap:5px'>${noteRows}</ul>
  `;

  $('meetingIntelAddBtn')?.addEventListener('click', () => {
    const text = String(prompt(`Add intel note for ${meeting}:`) || '').trim();
    if (!text) return;
    addAiUserNote(text, meeting);
    renderMeetingIntelPanel();
  });
}

function loadMeetingBiasPrefs(){
  try {
    const raw = localStorage.getItem('meetingBiasSignals');
    userMeetingBias = raw ? JSON.parse(raw) : {};
  } catch {
    userMeetingBias = {};
  }
}

function persistMeetingBiasPrefs(){
  try {
    localStorage.setItem('meetingBiasSignals', JSON.stringify(userMeetingBias || {}));
  } catch {}
}

function extractBiasSignals(text){
  const t = String(text || '').toLowerCase();
  const signals = {
    insideRail: /(inside\s+rail|rail\s+is\s+playing|on\s+rail)/.test(t),
    swoopers: /(swooper|off\s+the\s+speed|backmarker|coming\s+from\s+off\s+the\s+speed)/.test(t),
    leaders: /(leaders?\s+(are\s+)?playing|on[-\s]?pace\s+advantage|leader bias|front runners?)/.test(t)
  };
  return signals;
}

function registerMeetingBiasFromUserText(text, meeting){
  const mtg = String(meeting || selectedMeeting || '').trim();
  if (!mtg || mtg === 'ALL') return null;
  const signals = extractBiasSignals(text);
  if (!signals.insideRail && !signals.swoopers && !signals.leaders) return null;
  const key = normalizeMeetingNameText(mtg);
  userMeetingBias[key] = {
    ...signals,
    note: String(text || '').trim(),
    updatedAt: Date.now()
  };
  persistMeetingBiasPrefs();
  renderMeetingIntelPanel();
  return userMeetingBias[key];
}

function loadConfidenceStakePrefs(){
  try {
    const threshold = Number(localStorage.getItem('confidenceSignalThreshold'));
    const base = Number(localStorage.getItem('confidenceBaseStakeUnit'));
    const boost = Number(localStorage.getItem('confidenceBoostStakeUnit'));
    confidenceSignalThreshold = Number.isFinite(threshold) && threshold >= 0 ? threshold : 40;
    confidenceBaseStakeUnit = Number.isFinite(base) && base >= 0 ? base : 1;
    confidenceBoostStakeUnit = Number.isFinite(boost) && boost >= 0 ? boost : 2;
  } catch {
    confidenceSignalThreshold = 40;
    confidenceBaseStakeUnit = 1;
    confidenceBoostStakeUnit = 2;
  }
}

const filterCache = {
  suggested: { key: '', version: 0, result: [] },
  interesting: { key: '', version: 0, result: [] },
  movers: { key: '', version: 0, result: [] }
};
let latestAiCompare = [];
let draggedSelections = [];
let moversMode = (localStorage.getItem('moversMode') === 'drifters') ? 'drifters' : 'firmers';
let aiModelCatalog = {
  ollamaModels: [],
  openaiModels: [],
  providerDefault: 'ollama',
  capabilities: { openaiPermitted: false, openaiAllowed: false, hasOpenAiKey: false },
  openaiBlockedReason: ''
};
let selectedAiModel = { provider: 'ollama', model: 'deepseek-r1:8b' };
let aiModelManualLock = false;
let analysisViewMode = 'engine';
let latestAnalysisSignals = null;
let performanceCooldownUntil = 0;
let performanceCooldownTimer = null;
let meetingSearchRunId = 0;
let aiCooldownInterval = null;
let instructionsTemplate = '';
let instructionsLoadPromise = null;
let isAdminUser = false;
let betPlanPerfWindow = 'day';
let performanceDailyCache = null;

function summarizeInstructions(raw){
  if (!raw || raw.length < 10) return '';
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1 && /no additional/i.test(raw)) return '';
  const condensed = lines
    .filter(l => !/^#+\s/.test(l) && !/^```/.test(l) && !/^---/.test(l))
    .map(l => l.replace(/^[-•·]\s*/, '').trim())
    .filter(Boolean)
    .join(' ');
  const summary = condensed.length > 800 ? `${condensed.slice(0, 800)}…` : condensed;
  return summary;
}

function ensureInstructionsLoaded(){
  if (!instructionsLoadPromise) {
    instructionsLoadPromise = fetch('./api/instructions')
      .then(res => res.ok ? res.text() : '')
      .then(text => {
        instructionsTemplate = summarizeInstructions(text || '');
        return instructionsTemplate;
      })
      .catch(err => {
        console.warn('instructions_fetch_failed', err);
        return '';
      });
  }
  return instructionsLoadPromise;
}

ensureInstructionsLoaded();

function refreshTabAccess(){
  const meetingSelect = $('meetingSelect');
  const hasSpecificMeetingOption = !!(meetingSelect && Array.from(meetingSelect.options || []).some(o => o.value && o.value !== 'ALL'));
  const unlocked = (selectedMeeting !== 'ALL') || !hasSpecificMeetingOption;
  const pagesAllowedWithoutMeeting = new Set(['workspace', 'help', 'autobet', 'tracked', 'heatmap', 'suggested', 'interesting']);
  document.querySelectorAll('.page-tab').forEach(btn=>{
    const p = btn.dataset.page;
    if (p === 'bakeoff') {
      btn.style.display = isAdminUser ? '' : 'none';
      btn.disabled = !isAdminUser;
      btn.title = isAdminUser ? '' : 'Admin only';
      return;
    }
    if (p === 'performance') {
      btn.style.display = isAdminUser ? '' : 'none';
      btn.disabled = !isAdminUser;
      btn.title = isAdminUser ? '' : 'Admin only';
      return;
    }
    if (p === 'pulse') {
      btn.style.display = pulseEligible ? '' : 'none';
      btn.disabled = !pulseEligible || !unlocked;
      btn.title = !pulseEligible ? 'Sign in to use BETMAN Pulse.' : (unlocked ? '' : 'Select a meeting in Meeting Workspace first');
      return;
    }
    if (pagesAllowedWithoutMeeting.has(p)) {
      btn.disabled = false;
      btn.title = '';
      return;
    }
    btn.disabled = !unlocked;
    btn.title = unlocked ? '' : 'Select a meeting in Meeting Workspace first';
  });
}

function alertTypeTag(type){
  const t = String(type || '').toLowerCase();
  if (t === 'hot_drift') return 'HOT DRIFT';
  if (t === 'hot_plunge') return 'HOT PLUNGE';
  if (t === 'market_conflict') return 'MARKET CONFLICT';
  if (t === 'selection_flip_recommended') return 'RECOMMENDED FLIP';
  if (t === 'selection_flip_odds_runner') return 'ODDS RUNNER FLIP';
  if (t === 'selection_flip_ew') return 'EW FLIP';
  if (t === 'tracked_upgrade') return 'TRACK UPGRADE';
  if (t === 'tracked_downgrade') return 'TRACK DOWNGRADE';
  if (t === 'prejump_heat') return 'PRE-JUMP HEAT';
  if (t === 'jump_pulse') return 'JUMP PULSE';
  return 'MARKET ALERT';
}

function alertTypeImage(type){
  const t = String(type || '').toLowerCase();
  if (t === 'hot_plunge' || t === 'tracked_upgrade') return '/assets/firming.png';
  if (t === 'hot_drift' || t === 'tracked_downgrade') return '/assets/drifting.png';
  return '';
}

function marketMoverImage(row){
  const move = Number(row?.pctMove || 0);
  if (!Number.isFinite(move) || move === 0) return '';
  return move < 0 ? '/assets/firming.png' : '/assets/drifting.png';
}

const PULSE_SEVERITY_LEVELS = ['WATCH', 'HOT', 'CRITICAL', 'ACTION'];

const DEFAULT_PULSE_CONFIG = {
  enabled: true,
  alertTypes: {
    plunges: true,
    drifts: true,
    conflicts: true,
    selectionFlips: true,
    preJumpHeat: true,
    jumpPulse: true,
  },
  thresholds: {
    minSeverity: 'HOT',
    maxMinsToJump: null,
    minMovePct: null,
    trackedRunnerOverride: true,
  },
  targeting: {
    mode: 'all',
    countries: [],
    meetings: [],
    races: [],
  },
  updatedAt: null,
  updatedBy: null,
};

let pulseConfigState = {
  ...DEFAULT_PULSE_CONFIG,
  alertTypes: { ...DEFAULT_PULSE_CONFIG.alertTypes },
  thresholds: { ...DEFAULT_PULSE_CONFIG.thresholds },
};

function normalizePulseSeverity(value){
  const upper = String(value || '').trim().toUpperCase();
  return PULSE_SEVERITY_LEVELS.includes(upper) ? upper : DEFAULT_PULSE_CONFIG.thresholds.minSeverity;
}

function normalizePulseThresholds(payload){
  const thresholds = payload && typeof payload.thresholds === 'object' ? payload.thresholds : payload || {};
  const maxMinsToJump = Number(thresholds?.maxMinsToJump);
  const minMovePct = Number(thresholds?.minMovePct);
  return {
    minSeverity: normalizePulseSeverity(thresholds?.minSeverity),
    maxMinsToJump: Number.isFinite(maxMinsToJump) && maxMinsToJump >= 0 ? maxMinsToJump : null,
    minMovePct: Number.isFinite(minMovePct) && minMovePct >= 0 ? minMovePct : null,
    trackedRunnerOverride: thresholds?.trackedRunnerOverride !== false,
  };
}

function normalizePulseTargetList(values, mapper){
  const items = Array.isArray(values) ? values : [];
  return Array.from(new Set(items.map(mapper).filter(Boolean)));
}

function normalizePulseCountry(value){
  const upper = String(value || '').trim().toUpperCase();
  return upper === 'HKG' ? 'HK' : upper;
}

function normalizeUiCountry(value, fallback = 'NZ'){
  const normalized = normalizePulseCountry(value);
  return ['NZ', 'AUS', 'HK', 'ALL'].includes(normalized) ? normalized : fallback;
}

function normalizePulseMeetingName(value){
  return String(value || '').trim();
}

function normalizePulseRaceTarget(value){
  if (value == null) return null;
  if (typeof value === 'object') {
    const meeting = normalizePulseMeetingName(value.meeting);
    const race = String(value.race || value.race_number || '').trim().replace(/^R/i, '');
    if (!meeting || !race) return null;
    return `${meeting}::${race}`;
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/\s*\|\s*/g, '::').replace(/\s*[—-]\s*R?/gi, '::');
  const parts = normalized.split('::').map(part => String(part || '').trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const race = String(parts.pop() || '').replace(/^R/i, '');
  const meeting = parts.join('::').trim();
  if (!meeting || !race) return null;
  return `${meeting}::${race}`;
}

function normalizePulseTargeting(payload){
  const targeting = payload && typeof payload.targeting === 'object' ? payload.targeting : payload || {};
  const mode = String(targeting?.mode || 'all').trim().toLowerCase();
  return {
    mode: ['all', 'countries', 'meetings', 'races', 'mixed'].includes(mode) ? mode : 'all',
    countries: normalizePulseTargetList(targeting?.countries, normalizePulseCountry),
    meetings: normalizePulseTargetList(targeting?.meetings, normalizePulseMeetingName),
    races: normalizePulseTargetList(targeting?.races, normalizePulseRaceTarget),
  };
}

function pulseSeverityRank(value){
  return PULSE_SEVERITY_LEVELS.indexOf(normalizePulseSeverity(value));
}

function normalizePulseConfig(payload){
  const alertTypes = payload && typeof payload.alertTypes === 'object' ? payload.alertTypes : {};
  return {
    enabled: payload?.enabled !== false,
    alertTypes: {
      plunges: alertTypes.plunges !== false,
      drifts: alertTypes.drifts !== false,
      conflicts: alertTypes.conflicts !== false,
      selectionFlips: alertTypes.selectionFlips !== false,
      preJumpHeat: alertTypes.preJumpHeat !== false,
      jumpPulse: alertTypes.jumpPulse !== false,
    },
    thresholds: normalizePulseThresholds(payload),
    targeting: normalizePulseTargeting(payload),
    updatedAt: payload?.updatedAt || null,
    updatedBy: payload?.updatedBy || null,
  };
}

function pulseConfigKeyForAlertType(type){
  const t = String(type || '').toLowerCase();
  if (t === 'hot_plunge') return 'plunges';
  if (t === 'hot_drift') return 'drifts';
  if (t === 'market_conflict') return 'conflicts';
  if (t === 'selection_flip_recommended' || t === 'selection_flip_odds_runner' || t === 'selection_flip_ew') return 'selectionFlips';
  if (t === 'tracked_upgrade' || t === 'tracked_downgrade') return 'selectionFlips';
  if (t === 'prejump_heat') return 'preJumpHeat';
  if (t === 'jump_pulse') return 'jumpPulse';
  return null;
}

function pulseAlertPassesThresholds(row){
  const thresholds = normalizePulseThresholds(pulseConfigState?.thresholds || {});
  if (thresholds.trackedRunnerOverride && row?.trackedRunner) return true;
  if (pulseSeverityRank(row?.severity) < pulseSeverityRank(thresholds.minSeverity)) return false;

  const maxMinsToJump = Number(thresholds.maxMinsToJump);
  const minsToJump = Number(row?.minsToJump);
  if (Number.isFinite(maxMinsToJump) && Number.isFinite(minsToJump) && minsToJump >= 0 && minsToJump > maxMinsToJump) return false;

  const minMovePct = Number(thresholds.minMovePct);
  const movePct = Math.abs(Number(row?.movePct));
  if (Number.isFinite(minMovePct) && Number.isFinite(movePct) && movePct < minMovePct) return false;

  return true;
}

function filterPulseAlerts(rows){
  if (pulseConfigState?.enabled === false) return [];
  return (Array.isArray(rows) ? rows : []).filter(row => {
    const key = pulseConfigKeyForAlertType(row?.type);
    if (key && pulseConfigState?.alertTypes?.[key] === false) return false;
    return pulseAlertPassesThresholds(row);
  });
}

function pulseTargetingModeLabel(mode){
  if (mode === 'countries') return 'Countries';
  if (mode === 'meetings') return 'Meetings';
  if (mode === 'races') return 'Races';
  if (mode === 'mixed') return 'Mixed';
  return 'All races';
}

function pulseTargetingSummary(targeting = {}){
  const normalized = normalizePulseTargeting({ targeting });
  const meetingSet = new Set(normalized.meetings.map(value => normalizePulseMeetingName(value).toLowerCase()).filter(Boolean));
  const extraRaces = normalized.races.filter(value => !meetingSet.has(normalizePulseMeetingName(String(value).split('::')[0] || '').toLowerCase()));
  const segments = [];
  if (normalized.countries.length) segments.push(`Countries: ${normalized.countries.join(', ')}`);
  if (normalized.meetings.length) segments.push(`Meetings: ${normalized.meetings.join(', ')} (all future races)`);
  if (extraRaces.length) segments.push(`${normalized.meetings.length ? 'Extra races' : 'Races'}: ${extraRaces.map(value => value.replace('::', ' | R')).join(', ')}`);
  return segments.length ? segments.join(' · ') : 'No specific follow list. Pulse runs across the full premium feed.';
}

function pulseRaceStatusBits(race){
  return [
    race?.race_status,
    race?.status,
    race?.resultStatus,
    race?.state,
    race?.raceState,
  ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
}

function isPulseRaceFinished(race){
  const statusBits = pulseRaceStatusBits(race);
  if (statusBits.some(value => ['closed','final','finalized','resulted','settled','complete','completed','abandoned'].includes(value))) {
    return true;
  }
  if (race?.hasResult === true || race?.resulted === true || race?.isResulted === true || race?.isFinished === true || race?.raceSettled === true) {
    return true;
  }
  if (Array.isArray(race?.results) && race.results.length) return true;
  if (race?.result && typeof race.result === 'object' && Object.keys(race.result || {}).length) return true;
  return false;
}

function isPulseRaceStarted(race){
  return pulseRaceStatusBits(race).some(value => ['jumped','running','inrunning','in-running','live'].includes(value));
}

function pulseRaceAdvertisedStartMs(race){
  const advertised = race?.advertised_start;
  if (typeof advertised === 'number' && Number.isFinite(advertised)) return advertised > 1e12 ? advertised : advertised * 1000;
  if (typeof advertised === 'string' && advertised.trim()) {
    const asNumber = Number(advertised);
    if (Number.isFinite(asNumber)) return asNumber > 1e12 ? asNumber : asNumber * 1000;
    const parsed = Date.parse(advertised);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

function isPulseRaceTargetable(race, nowMs = Date.now()){
  if (isPulseRaceFinished(race) || isPulseRaceStarted(race)) return false;
  const startMs = pulseRaceAdvertisedStartMs(race);
  return Number.isFinite(startMs) ? startMs >= nowMs : true;
}

function prunePulseTargetingPastRaces(targeting = {}, rows = [], nowMs = Date.now()){
  const normalized = normalizePulseTargeting({ targeting });
  const byRace = new Map((Array.isArray(rows) ? rows : []).map(r => {
    const key = `${normalizePulseMeetingName(r?.meeting)}::${String(r?.race_number || r?.race || '').replace(/^R/i, '').trim()}`;
    return [key, r];
  }).filter(([key]) => !!key && !key.startsWith('::')));
  return {
    ...normalized,
    races: normalized.races.filter(key => {
      const row = byRace.get(key);
      return row ? isPulseRaceTargetable(row, nowMs) : true;
    }),
  };
}

function prunePulseRacesForMeetings(races = [], meetings = []){
  const meetingSet = new Set((Array.isArray(meetings) ? meetings : []).map(value => normalizePulseMeetingName(value).toLowerCase()).filter(Boolean));
  return (Array.isArray(races) ? races : []).filter(value => !meetingSet.has(normalizePulseMeetingName(String(value).split('::')[0] || '').toLowerCase()));
}

function pulseMeetingPriority(meeting = '', country = '', activeRaceCount = 0){
  const meetingName = String(meeting || '').trim().toLowerCase();
  const selected = String(selectedMeeting || '').trim().toLowerCase();
  if (!meetingName) return 99;
  if (selected && selected !== 'all' && meetingName === selected) return 0;
  if (activeRaceCount > 0) return 1;
  if (String(country || '').trim().toUpperCase() === String(selectedCountry || '').trim().toUpperCase()) return 2;
  if (String(country || '').trim().toUpperCase() === 'NZ') return 3;
  return 4;
}

let pulseConfigFlash = '';

function setPulseConfigFlash(message = ''){
  pulseConfigFlash = String(message || '').trim();
  const status = $('pulseConfigStatus');
  if (status && pulseConfigFlash) status.textContent = pulseConfigFlash;
}

function updatePulseMeetingAwareUi(){
  const quickBtn = $('pulseQuickSelectedMeetingBtn');
  if (quickBtn) {
    const meetingLabel = String(selectedMeeting || '').trim();
    quickBtn.textContent = meetingLabel && meetingLabel !== 'ALL' ? `Use ${meetingLabel}` : 'Select a meeting first';
    quickBtn.disabled = !meetingLabel || meetingLabel === 'ALL';
  }
  const quickEmpty = $('pulseQuickSelectedMeetingEmpty');
  if (quickEmpty) quickEmpty.style.display = (selectedMeeting && selectedMeeting !== 'ALL') ? 'none' : '';
  const liveRules = $('pulseLiveRulesSummary');
  if (liveRules) liveRules.textContent = pulseTargetingSummary(pulseConfigState?.targeting || {});
}

function pulseFocusedMeetingFromTargeting(targeting = {}){
  const normalized = normalizePulseTargeting({ targeting });
  if (normalized.mode === 'meetings' && normalized.meetings.length === 1) return normalized.meetings[0];
  if (normalized.mode === 'races' && normalized.races.length === 1) return String(normalized.races[0]).split('::')[0] || '';
  if (normalized.mode === 'mixed' && normalized.meetings.length === 1) return normalized.meetings[0];
  return '';
}

function buildPulseMeetingCards(rows = [], seedMeetings = []){
  const meetingStats = new Map();
  const ensureMeeting = (meeting, country = '') => {
    const label = normalizePulseMeetingName(meeting);
    if (!label) return null;
    if (!meetingStats.has(label)) {
      meetingStats.set(label, { meeting: label, country: String(country || '').trim(), activeRaceCount: 0, nextRace: null });
    }
    const item = meetingStats.get(label);
    if (!item.country && country) item.country = String(country || '').trim();
    return item;
  };
  (seedMeetings || []).forEach(raw => ensureMeeting(raw));
  (rows || []).forEach(r => {
    const item = ensureMeeting(r?.meeting, r?.country);
    if (!item) return;
    const raceNo = String(r?.race_number || r?.race || '').replace(/^R/i, '').trim();
    if (!raceNo) return;
    item.activeRaceCount += 1;
    const raceInt = Number(raceNo);
    if (Number.isFinite(raceInt)) item.nextRace = item.nextRace == null ? raceInt : Math.min(item.nextRace, raceInt);
  });
  return Array.from(meetingStats.values()).sort((a, b) => {
    const rankDiff = pulseMeetingPriority(a.meeting, a.country, a.activeRaceCount) - pulseMeetingPriority(b.meeting, b.country, b.activeRaceCount);
    if (rankDiff !== 0) return rankDiff;
    if ((a.nextRace ?? 999) !== (b.nextRace ?? 999)) return (a.nextRace ?? 999) - (b.nextRace ?? 999);
    return a.meeting.localeCompare(b.meeting);
  });
}

async function getPulseTargetOptions(targeting = {}){
  const all = await loadAllRacesUnfiltered();
  const selected = normalizePulseTargeting({ targeting });
  const liveRaces = (all || []).filter(r => isPulseRaceTargetable(r));
  const byCountry = selected.countries.length
    ? liveRaces.filter(r => selected.countries.includes(String(r.country || '').trim()))
    : liveRaces;
  const byMeeting = selected.meetings.length
    ? byCountry.filter(r => selected.meetings.includes(String(r.meeting || '').trim()))
    : byCountry;
  const candidateRaces = byMeeting;
  const countries = Array.from(new Set(liveRaces.map(r => String(r.country || '').trim()).filter(Boolean))).sort();
  const seedMeetings = [
    ...currentStatusMeetings(),
    ...selected.meetings,
    pulseFocusedMeetingFromTargeting(selected),
    normalizePulseMeetingName(selectedMeeting === 'ALL' ? '' : selectedMeeting),
  ].filter(Boolean);
  const meetingCards = buildPulseMeetingCards(candidateRaces, seedMeetings);
  const meetings = meetingCards.map(item => item.meeting);
  const races = candidateRaces
    .map(r => ({
      key: `${String(r.meeting || '').trim()}::${String(r.race_number || r.race || '').replace(/^R/i,'').trim()}`,
      label: `${String(r.country || '').trim() ? `${String(r.country || '').trim()} · ` : ''}${String(r.meeting || '').trim()} R${String(r.race_number || r.race || '').replace(/^R/i,'').trim()}`
    }))
    .filter(r => r.key && r.label)
    .sort((a,b) => a.label.localeCompare(b.label));
  return { countries, meetings, races, meetingCards };
}

async function loadPulseConfig(){
  const res = await fetchLocal('./api/v1/pulse-config', { cache: 'no-store' });
  const payload = await res.json().catch(() => ({}));
  pulseConfigState = normalizePulseConfig(payload?.config || payload || {});
  return pulseConfigState;
}

async function savePulseConfig(next = {}){
  const payload = {
    enabled: next.enabled ?? pulseConfigState.enabled,
    alertTypes: {
      ...pulseConfigState.alertTypes,
      ...(next.alertTypes || {}),
    },
    thresholds: {
      ...pulseConfigState.thresholds,
      ...(next.thresholds || {}),
    },
    targeting: normalizePulseTargeting(next.targeting || pulseConfigState.targeting || {}),
  };
  const res = await fetchLocal('./api/v1/pulse-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  pulseConfigState = normalizePulseConfig(data?.config || payload);
  return pulseConfigState;
}

function pulseTypeMeta(){
  return [
    { key: 'plunges', label: 'Plunges', desc: 'Hot plunges / firming moves.' },
    { key: 'drifts', label: 'Drifts', desc: 'Hot drifts / late weakness.' },
    { key: 'conflicts', label: 'Conflicts', desc: 'Market conflict alerts.' },
    { key: 'selectionFlips', label: 'Selection flips', desc: 'Recommended / odds runner / EW flips and tracked conviction changes.' },
    { key: 'preJumpHeat', label: 'Pre-jump heat', desc: 'Late pre-jump heat signals.' },
    { key: 'jumpPulse', label: 'Jump Pulse', desc: 'Tracked runner alert at jump window (3m or less).' },
  ];
}

function pulseThresholdSummary(thresholds = {}){
  const normalized = normalizePulseThresholds(thresholds);
  return [
    `Severity ${normalized.minSeverity || 'WATCH'}`,
    normalized.maxMinsToJump == null ? 'Time gate off' : `≤ ${normalized.maxMinsToJump}m`,
    normalized.minMovePct == null ? 'Move gate off' : `Move ≥ ${normalized.minMovePct}%`,
    normalized.trackedRunnerOverride ? 'Tracked override on' : 'Tracked override off'
  ].join(' · ');
}

function pulseChipValuesFromField(id, normalizeFn = (v) => v){
  return String($(id)?.value || '')
    .split(/[\n,]+/)
    .map(v => normalizeFn(v))
    .filter(Boolean);
}

function setPulseChipFieldValue(id, values = []){
  const field = $(id);
  if (!field) return;
  field.value = Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))).join('\n');
  field.dispatchEvent(new Event('change'));
}

function renderPulseChipField(id, values = [], emptyLabel = 'Nothing selected'){
  const root = $(`${id}Chips`);
  if (!root) return;
  const normalized = Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)));
  root.innerHTML = normalized.length
    ? normalized.map(value => `<button type='button' class='pulse-selection-chip is-selected' data-target='${escapeAttr(id)}' data-value='${escapeAttr(value)}'><span>${escapeHtml(value)}</span><strong aria-hidden='true'>×</strong></button>`).join('')
    : `<div class='pulse-selection-empty'>${escapeHtml(emptyLabel)}</div>`;
}

function renderPulseWatchFilterChips(selectId, containerId, allLabel){
  const sel = $(selectId);
  const root = $(containerId);
  if (!sel || !root) return;
  const current = String(sel.value || 'all');
  const options = Array.from(sel.options || [])
    .map(opt => ({ value: String(opt.value || ''), label: String(opt.textContent || opt.value || '').trim() }))
    .filter(opt => opt.value);
  root.innerHTML = options.map(opt => `<button type='button' class='pulse-filter-chip ${opt.value === current ? 'active' : ''}' data-select='${escapeAttr(selectId)}' data-value='${escapeAttr(opt.value)}'>${escapeHtml(opt.value === 'all' ? allLabel : opt.label)}</button>`).join('');
}

async function renderPulseConfigPanel(){
  const cfg = $('pulseConfigPanel') || $('alertsConfigPanel');
  if (!cfg) return;
  const meta = pulseTypeMeta();
  const thresholds = normalizePulseThresholds(pulseConfigState.thresholds || {});
  const targeting = normalizePulseTargeting(pulseConfigState.targeting || {});
  const targetOptions = await getPulseTargetOptions(targeting).catch(() => ({ countries: [], meetings: [], races: [], meetingCards: [] }));
  const updatedMeta = pulseConfigState.updatedAt
    ? `Saved ${new Date(pulseConfigState.updatedAt).toLocaleString()}${pulseConfigState.updatedBy ? ` by ${escapeHtml(String(pulseConfigState.updatedBy))}` : ''}`
    : 'Using default Pulse profile';
  const selectedMeetingLabel = String(selectedMeeting || '').trim();
  const quickMeetingReady = selectedMeetingLabel && selectedMeetingLabel !== 'ALL';
  const thresholdSummary = pulseThresholdSummary(thresholds);
  const alertTypeEnabledCount = meta.filter(item => pulseConfigState.alertTypes[item.key] !== false).length;
  const targetBucketCount = [targeting.countries.length, targeting.meetings.length, targeting.races.length].reduce((sum, count) => sum + count, 0);
  const severityPreset = thresholds.minSeverity || PULSE_SEVERITY_LEVELS[0];
  const minutePresets = [null, 5, 10, 15, 25, 45];
  const movePresets = [null, 1, 2, 4, 8];
  cfg.innerHTML = `
    <div class='row pulse-config-hero pulse-command-hero' style='grid-template-columns:1fr'>
      <div>
        <div class='pulse-eyebrow'>Pulse Control</div>
        <div class='pulse-config-title'>Run Pulse like an operator console</div>
        <div class='sub pulse-config-copy'>No dropdown soup. Scope, pressure gates, and feed personality are now visible at a glance and adjustable with chips, pills, and toggles.</div>
        <div class='sub pulse-config-meta'>${updatedMeta}</div>
      </div>
    </div>
    <div class='pulse-command-grid'>
      <label class='row pulse-config-card pulse-config-card-accent pulse-master-toggle-card' style='grid-template-columns:1fr auto;align-items:center;gap:12px'>
        <div>
          <div class='pulse-config-item-title'>Pulse master switch <span class='tag value'>PREMIUM</span></div>
          <div class='sub'>Master gate for the premium feed. If this is off, nothing downstream should surprise the operator.</div>
        </div>
        <span class='pulse-toggle'>
          <input id='pulseEnabledToggle' type='checkbox' ${pulseConfigState.enabled !== false ? 'checked' : ''} />
          <span class='pulse-toggle-ui' aria-hidden='true'></span>
        </span>
      </label>
      <div class='row pulse-config-card pulse-command-card' style='grid-template-columns:1fr'>
        <div class='pulse-config-item-title'>Current live rules</div>
        <div id='pulseLiveRulesSummary' class='sub'>${escapeHtml(pulseTargetingSummary(targeting))}</div>
        <div class='pulse-operator-summary'>
          <span class='pulse-inline-chip'>${escapeHtml(pulseTargetingModeLabel(targeting.mode))}</span>
          <span class='pulse-inline-chip'>${escapeHtml(thresholdSummary)}</span>
          <span class='pulse-inline-chip'>${alertTypeEnabledCount}/${meta.length} signal classes live</span>
        </div>
      </div>
      <div class='row pulse-config-card pulse-command-card' style='grid-template-columns:1fr'>
        <div class='pulse-config-item-title'>Fast setup</div>
        <div class='sub'>Anchor today’s book fast, then tighten gates only if the feed is getting too chatty.</div>
        <div class='pulse-quick-actions'>
          <button id='pulseQuickSelectedMeetingBtn' class='btn ${quickMeetingReady ? '' : 'btn-ghost'} compact-btn' ${quickMeetingReady ? '' : 'disabled'}>${quickMeetingReady ? `Focus ${escapeHtml(selectedMeetingLabel)}` : 'Select a meeting first'}</button>
          <button id='pulseClearScopeBtn' class='btn btn-ghost compact-btn'>Full Feed</button>
        </div>
      </div>
    </div>
    <div class='pulse-targeting-shell pulse-surface-block'>
      <div class='pulse-targeting-head'>
        <div>
          <div class='pulse-config-item-title'>Scope builder</div>
          <div class='sub'>Choose the coverage model first, then layer countries, meetings, or races using removable chips.</div>
        </div>
        <div class='pulse-operator-summary'>
          <span class='pulse-inline-chip'>${targetBucketCount} targets loaded</span>
          <span class='pulse-inline-chip'>${escapeHtml(pulseTargetingModeLabel(targeting.mode))}</span>
        </div>
      </div>
      <div class='pulse-quick-setup'>
        <div>
          <div class='pulse-config-item-title'>Meeting launchpad</div>
          <div class='sub'>Tap a live meeting chip to stage it instantly. Then apply meetings or races with one click.</div>
        </div>
        <div class='pulse-quick-actions'>
          <button id='pulseApplyMeetingsBtn' class='btn btn-ghost compact-btn'>Apply Meetings</button>
          <button id='pulseClearMeetingsBtn' class='btn btn-ghost compact-btn'>Clear Meetings</button>
          <button id='pulseApplyRacesBtn' class='btn btn-ghost compact-btn'>Apply Races</button>
        </div>
      </div>
      ${targetOptions.meetingCards.length ? `<div class='pulse-meeting-chip-row'>${targetOptions.meetingCards.slice(0, 10).map(item => `<button type='button' class='pulse-meeting-chip ${selectedMeetingLabel && normalizePulseMeetingName(selectedMeetingLabel) === normalizePulseMeetingName(item.meeting) ? 'is-primary' : ''}' data-meeting='${escapeAttr(item.meeting)}'>${escapeHtml(item.country ? `${item.country} · ` : '')}${escapeHtml(item.meeting)}${item.nextRace != null ? ` <span>R${escapeHtml(String(item.nextRace))}</span>` : ''}${item.activeRaceCount ? ` <span>${escapeHtml(String(item.activeRaceCount))} live</span>` : ''}</button>`).join('')}</div>` : ''}
      <div class='pulse-targeting-modes pulse-mode-pill-row'>
        ${['all','countries','meetings','races','mixed'].map(mode => `<label class='pulse-mode-pill ${targeting.mode === mode ? 'active' : ''}'><input type='radio' name='pulseTargetMode' value='${mode}' ${targeting.mode === mode ? 'checked' : ''} /> <span>${escapeHtml(pulseTargetingModeLabel(mode))}</span></label>`).join('')}
      </div>
      <div class='pulse-targeting-grid pulse-targeting-grid-operator'>
        <div class='pulse-target-block'>
          <div class='pulse-config-item-title'>Countries</div>
          <div class='sub'>Keep it broad by jurisdiction.</div>
          <div class='pulse-chip-input-row'>
            <input id='pulseTargetCountriesInput' list='pulseTargetCountriesList' placeholder='Add country' />
            <button type='button' class='btn btn-ghost compact-btn pulse-add-chip-btn' data-add-target='pulseTargetCountries'>Add</button>
          </div>
          <datalist id='pulseTargetCountriesList'>${targetOptions.countries.map(value => `<option value='${escapeAttr(value)}'></option>`).join('')}</datalist>
          <div id='pulseTargetCountriesChips' class='pulse-selection-chip-row'></div>
          <textarea id='pulseTargetCountries' class='hidden' rows='1'>${escapeHtml(targeting.countries.join('\n'))}</textarea>
        </div>
        <div class='pulse-target-block'>
          <div class='pulse-config-item-title'>Meetings</div>
          <div class='sub'>Tighten to the rooms you actually care about.</div>
          <div class='pulse-chip-input-row'>
            <input id='pulseTargetMeetingsInput' list='pulseTargetMeetingsList' placeholder='Add meeting' />
            <button type='button' class='btn btn-ghost compact-btn pulse-add-chip-btn' data-add-target='pulseTargetMeetings'>Add</button>
          </div>
          <datalist id='pulseTargetMeetingsList'>${targetOptions.meetings.map(value => `<option value='${escapeAttr(value)}'></option>`).join('')}</datalist>
          <div id='pulseTargetMeetingsChips' class='pulse-selection-chip-row'></div>
          <textarea id='pulseTargetMeetings' class='hidden' rows='1'>${escapeHtml(targeting.meetings.join('\n'))}</textarea>
        </div>
        <div class='pulse-target-block'>
          <div class='pulse-config-item-title'>Races</div>
          <div class='sub'>Pin exact races when you want hard surgical focus.</div>
          <div class='pulse-chip-input-row'>
            <input id='pulseTargetRacesInput' list='pulseTargetRacesList' placeholder='Add race' />
            <button type='button' class='btn btn-ghost compact-btn pulse-add-chip-btn' data-add-target='pulseTargetRaces'>Add</button>
          </div>
          <datalist id='pulseTargetRacesList'>${targetOptions.races.map(value => `<option value='${escapeAttr(value.label)}'></option>`).join('')}</datalist>
          <div id='pulseTargetRacesChips' class='pulse-selection-chip-row'></div>
          <textarea id='pulseTargetRaces' class='hidden' rows='1'>${escapeHtml(targeting.races.map(value => value.replace('::', ' | R')).join('\n'))}</textarea>
        </div>
      </div>
    </div>
    <div class='pulse-config-section'>
      <div class='pulse-section-headline'>
        <div>
          <div class='pulse-config-item-title'>Signal classes</div>
          <div class='sub'>Turn feed components on and off directly. No nested menus. No guessing.</div>
        </div>
        <div class='pulse-operator-summary'><span class='pulse-inline-chip'>${alertTypeEnabledCount} active</span></div>
      </div>
      <div class='pulse-alert-toggle-grid'>
        ${meta.map(item => `<label class='pulse-alert-toggle ${pulseConfigState.alertTypes[item.key] ? 'active' : ''}' data-key='${item.key}'>
          <input type='checkbox' class='pulse-config-toggle' data-key='${item.key}' ${pulseConfigState.alertTypes[item.key] ? 'checked' : ''} />
          <div class='pulse-alert-toggle-head'>
            <div class='pulse-config-item-title'>${item.label}</div>
            <span class='pulse-mini-state'>${pulseConfigState.alertTypes[item.key] ? 'On' : 'Off'}</span>
          </div>
          <div class='sub'>${item.desc}</div>
        </label>`).join('')}
      </div>
    </div>
    <div class='pulse-config-section'>
      <div class='pulse-section-headline'>
        <div>
          <div class='pulse-config-item-title'>Pressure gates</div>
          <div class='sub'>Decide how hard a signal must hit before it reaches the operator.</div>
        </div>
        <div class='pulse-operator-summary'><span class='pulse-inline-chip'>${escapeHtml(thresholdSummary)}</span></div>
      </div>
      <div class='pulse-threshold-grid'>
        <div class='pulse-threshold-card'>
          <div class='pulse-config-item-title'>Minimum severity</div>
          <div class='sub'>Everything below this stays out unless tracked override applies.</div>
          <div class='pulse-choice-row'>
            ${PULSE_SEVERITY_LEVELS.map(level => `<button type='button' class='pulse-choice-pill ${severityPreset === level ? 'active' : ''}' data-threshold-severity='${level}'>${escapeHtml(level)}</button>`).join('')}
          </div>
          <select id='pulseThresholdSeverity' class='hidden'>${PULSE_SEVERITY_LEVELS.map(level => `<option value='${level}' ${severityPreset === level ? 'selected' : ''}>${level}</option>`).join('')}</select>
        </div>
        <div class='pulse-threshold-card'>
          <div class='pulse-config-item-title'>Time to jump</div>
          <div class='sub'>Keep feed close to the jump or leave it fully open.</div>
          <div class='pulse-choice-row'>
            ${minutePresets.map(value => `<button type='button' class='pulse-choice-pill ${(value == null && thresholds.maxMinsToJump == null) || value === thresholds.maxMinsToJump ? 'active' : ''}' data-threshold-minutes='${value == null ? 'off' : value}'>${value == null ? 'Off' : `${value}m`}</button>`).join('')}
          </div>
          <div class='pulse-custom-input-row'>
            <label>
              <span>Custom minutes</span>
              <input id='pulseThresholdMinutes' type='number' min='0' step='1' value='${thresholds.maxMinsToJump ?? ''}' placeholder='Off' />
            </label>
          </div>
        </div>
        <div class='pulse-threshold-card'>
          <div class='pulse-config-item-title'>Minimum move</div>
          <div class='sub'>Cut weak drift / firming noise unless it clears this move filter.</div>
          <div class='pulse-choice-row'>
            ${movePresets.map(value => `<button type='button' class='pulse-choice-pill ${(value == null && thresholds.minMovePct == null) || value === thresholds.minMovePct ? 'active' : ''}' data-threshold-move='${value == null ? 'off' : value}'>${value == null ? 'Off' : `${value}%`}</button>`).join('')}
          </div>
          <div class='pulse-custom-input-row'>
            <label>
              <span>Custom move %</span>
              <input id='pulseThresholdMovePct' type='number' min='0' step='0.1' value='${thresholds.minMovePct ?? ''}' placeholder='Off' />
            </label>
          </div>
        </div>
        <label class='pulse-threshold-card pulse-threshold-card-toggle'>
          <div>
            <div class='pulse-config-item-title'>Tracked runner override</div>
            <div class='sub'>Tracked runners can bypass severity, time, and move gates when conviction matters more than housekeeping.</div>
          </div>
          <span class='pulse-toggle'>
            <input id='pulseThresholdTrackedOverride' type='checkbox' ${thresholds.trackedRunnerOverride ? 'checked' : ''} />
            <span class='pulse-toggle-ui' aria-hidden='true'></span>
          </span>
        </label>
      </div>
    </div>
    <div class='row pulse-config-savebar' style='grid-template-columns:auto 1fr;gap:10px;align-items:center'>
      <button id='savePulseConfigBtn' class='btn'>Save Pulse Profile</button>
      <div id='pulseConfigStatus' class='sub'>Changes are shared per tenant.</div>
    </div>`;

  const status = $('pulseConfigStatus');
  updatePulseMeetingAwareUi();
  if (status && pulseConfigFlash) status.textContent = pulseConfigFlash;
  const syncTargetChips = () => {
    renderPulseChipField('pulseTargetCountries', pulseChipValuesFromField('pulseTargetCountries', normalizePulseCountry), 'All countries');
    renderPulseChipField('pulseTargetMeetings', pulseChipValuesFromField('pulseTargetMeetings', normalizePulseMeetingName), 'All meetings');
    renderPulseChipField('pulseTargetRaces', pulseChipValuesFromField('pulseTargetRaces', normalizePulseRaceTarget).map(value => value.replace('::', ' | R')), 'All races');
    const selectedMeetings = new Set(pulseChipValuesFromField('pulseTargetMeetings', normalizePulseMeetingName).map(v => v.toLowerCase()));
    cfg.querySelectorAll('.pulse-meeting-chip').forEach(chip => {
      const meeting = normalizePulseMeetingName(chip.dataset.meeting || '').toLowerCase();
      const active = !!meeting && selectedMeetings.has(meeting);
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const summary = pulseTargetingSummary({
      mode: cfg.querySelector('input[name="pulseTargetMode"]:checked')?.value || targeting.mode,
      countries: pulseChipValuesFromField('pulseTargetCountries', normalizePulseCountry),
      meetings: pulseChipValuesFromField('pulseTargetMeetings', normalizePulseMeetingName),
      races: pulseChipValuesFromField('pulseTargetRaces', normalizePulseRaceTarget)
    });
    if ($('pulseLiveRulesSummary')) $('pulseLiveRulesSummary').textContent = summary;
  };
  const addPulseTargetValue = (inputId, targetId, transform = (v) => v) => {
    const input = $(inputId);
    const target = $(targetId);
    if (!input || !target) return;
    const commit = () => {
      const raw = String(input.value || '').trim();
      if (!raw) return;
      const next = transform(raw);
      if (!next) return;
      const existing = pulseChipValuesFromField(targetId, (v) => v);
      if (!existing.includes(next)) existing.push(next);
      setPulseChipFieldValue(targetId, existing);
      input.value = '';
      syncTargetChips();
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
    cfg.querySelector(`[data-add-target='${targetId}']`)?.addEventListener('click', commit);
  };
  addPulseTargetValue('pulseTargetCountriesInput', 'pulseTargetCountries', normalizePulseCountry);
  addPulseTargetValue('pulseTargetMeetingsInput', 'pulseTargetMeetings', normalizePulseMeetingName);
  addPulseTargetValue('pulseTargetRacesInput', 'pulseTargetRaces', (value) => normalizePulseRaceTarget(value.includes(' · ') ? value.split(' · ').slice(1).join(' · ').replace(/\s+R/i, ' | R') : value));

  const setPulseMeetingFocus = async (meetingName) => {
    const meeting = normalizePulseMeetingName(meetingName);
    if (!meeting) return;
    const btn = $('savePulseConfigBtn');
    if (btn) btn.disabled = true;
    if (status) status.textContent = `Saving ${meeting}…`;
    try {
      await savePulseConfig({
        enabled: true,
        targeting: {
          mode: 'meetings',
          countries: [],
          meetings: [meeting],
          races: [],
        },
      });
      await renderPulseConfigPanel();
      await renderAlertsShell();
      setPulseConfigFlash(`Saved · focused on ${meeting}`);
      updatePulseMeetingAwareUi();
    } catch (err) {
      if (status) status.textContent = `Save failed: ${err?.message || 'unknown error'}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  const inferPulseTargetMode = ({ countries = [], meetings = [], races = [] } = {}, fallbackMode = 'all') => {
    const hasCountries = countries.length > 0;
    const hasMeetings = meetings.length > 0;
    const hasRaces = races.length > 0;
    const activeBuckets = [hasCountries, hasMeetings, hasRaces].filter(Boolean).length;
    if (!activeBuckets) return 'all';
    if (activeBuckets > 1) return 'mixed';
    if (hasRaces) return 'races';
    if (hasMeetings) return 'meetings';
    if (hasCountries) return 'countries';
    return fallbackMode;
  };

  const applyPulseScope = async (kind = 'meetings') => {
    const btn = kind === 'races' ? $('pulseApplyRacesBtn') : $('pulseApplyMeetingsBtn');
    const meetings = pulseChipValuesFromField('pulseTargetMeetings', normalizePulseMeetingName);
    const races = pulseChipValuesFromField('pulseTargetRaces', normalizePulseRaceTarget);
    const countries = pulseChipValuesFromField('pulseTargetCountries', normalizePulseCountry);
    const raceRows = await loadAllRacesUnfiltered().catch(() => []);
    const nextTargeting = prunePulseTargetingPastRaces({
      mode: kind === 'races'
        ? (races.length ? 'races' : inferPulseTargetMode({ countries, meetings, races }, 'all'))
        : (meetings.length ? 'meetings' : inferPulseTargetMode({ countries, meetings, races }, 'all')),
      countries,
      meetings,
      races,
    }, raceRows);
    if (btn) btn.disabled = true;
    if (status) status.textContent = kind === 'races' ? 'Applying races…' : 'Applying meetings…';
    try {
      await savePulseConfig({ targeting: nextTargeting, enabled: !!$('pulseEnabledToggle')?.checked });
      const summary = pulseTargetingSummary(nextTargeting);
      if ($('pulseLiveRulesSummary')) $('pulseLiveRulesSummary').textContent = summary;
      setPulseConfigFlash(kind === 'races' ? `Applied races · ${summary}` : `Applied meetings · ${summary}`);
      await renderAlertsShell();
    } catch (err) {
      if (status) status.textContent = `Apply failed: ${err?.message || 'unknown error'}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  $('pulseApplyMeetingsBtn')?.addEventListener('click', () => applyPulseScope('meetings'));
  $('pulseClearMeetingsBtn')?.addEventListener('click', async () => {
    const btn = $('pulseClearMeetingsBtn');
    const currentTargeting = normalizePulseTargeting(pulseConfigState?.targeting || {});
    const countries = pulseChipValuesFromField('pulseTargetCountries', normalizePulseCountry);
    const meetingsToClear = Array.from(new Set([
      ...currentTargeting.meetings,
      ...pulseChipValuesFromField('pulseTargetMeetings', normalizePulseMeetingName),
    ]));
    const races = pulseChipValuesFromField('pulseTargetRaces', normalizePulseRaceTarget);
    const nextRaces = prunePulseRacesForMeetings(races, meetingsToClear);
    const removedRaceCount = Math.max(0, races.length - nextRaces.length);
    const nextTargeting = {
      countries,
      meetings: [],
      races: nextRaces,
      mode: ['meetings', 'mixed'].includes(currentTargeting.mode)
        ? inferPulseTargetMode({ countries, meetings: [], races: nextRaces }, 'all')
        : currentTargeting.mode,
    };
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Clearing meetings…';
    try {
      setPulseChipFieldValue('pulseTargetMeetings', []);
      if ($('pulseTargetRaces') && removedRaceCount > 0) $('pulseTargetRaces').value = nextRaces.map(value => value.replace('::', ' | R')).join('\n');
      syncTargetChips();
      await savePulseConfig({
        enabled: !!$('pulseEnabledToggle')?.checked,
        targeting: nextTargeting,
      });
      const summary = pulseTargetingSummary(nextTargeting);
      if ($('pulseLiveRulesSummary')) $('pulseLiveRulesSummary').textContent = summary;
      setPulseConfigFlash(removedRaceCount > 0 ? `Cleared meetings · removed ${removedRaceCount} linked race${removedRaceCount === 1 ? '' : 's'} · ${summary}` : `Cleared meetings · ${summary}`);
      await renderAlertsShell();
    } catch (err) {
      if (status) status.textContent = `Clear failed: ${err?.message || 'unknown error'}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  $('pulseApplyRacesBtn')?.addEventListener('click', () => applyPulseScope('races'));
  $('pulseClearScopeBtn')?.addEventListener('click', async () => {
    const btn = $('pulseClearScopeBtn');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Clearing live rules…';
    try {
      setPulseChipFieldValue('pulseTargetCountries', []);
      setPulseChipFieldValue('pulseTargetMeetings', []);
      setPulseChipFieldValue('pulseTargetRaces', []);
      const allMode = cfg.querySelector('input[name="pulseTargetMode"][value="all"]');
      if (allMode) allMode.checked = true;
      cfg.querySelectorAll('.pulse-mode-pill').forEach(pill => pill.classList.toggle('active', pill.querySelector('input')?.checked));
      syncTargetChips();
      await savePulseConfig({
        enabled: !!$('pulseEnabledToggle')?.checked,
        targeting: { mode: 'all', countries: [], meetings: [], races: [] },
      });
      if ($('pulseLiveRulesSummary')) $('pulseLiveRulesSummary').textContent = pulseTargetingSummary({ mode: 'all', countries: [], meetings: [], races: [] });
      setPulseConfigFlash('Cleared live rules · full premium feed active');
      await renderAlertsShell();
    } catch (err) {
      if (status) status.textContent = `Clear failed: ${err?.message || 'unknown error'}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  $('pulseQuickSelectedMeetingBtn')?.addEventListener('click', () => setPulseMeetingFocus(String(selectedMeeting || '').trim()));
  cfg.querySelectorAll('.pulse-meeting-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const meeting = normalizePulseMeetingName(btn.dataset.meeting || '');
      if (!meeting) return;
      setPulseChipFieldValue('pulseTargetMeetings', [meeting]);
      const modeInput = cfg.querySelector('input[name="pulseTargetMode"][value="meetings"]');
      if (modeInput) modeInput.checked = true;
      cfg.querySelectorAll('.pulse-mode-pill').forEach(pill => pill.classList.toggle('active', pill.querySelector('input')?.checked));
      syncTargetChips();
      if (status) status.textContent = `${meeting} staged — hit Apply Meetings to go live`;
    });
  });
  const syncThresholdPills = () => {
    const severity = $('pulseThresholdSeverity')?.value || thresholds.minSeverity;
    const minutesValue = $('pulseThresholdMinutes')?.value === '' ? null : Number($('pulseThresholdMinutes')?.value);
    const moveValue = $('pulseThresholdMovePct')?.value === '' ? null : Number($('pulseThresholdMovePct')?.value);
    cfg.querySelectorAll('[data-threshold-severity]').forEach(btn => btn.classList.toggle('active', btn.dataset.thresholdSeverity === severity));
    cfg.querySelectorAll('[data-threshold-minutes]').forEach(btn => {
      const val = btn.dataset.thresholdMinutes === 'off' ? null : Number(btn.dataset.thresholdMinutes);
      btn.classList.toggle('active', val === minutesValue || (val == null && minutesValue == null));
    });
    cfg.querySelectorAll('[data-threshold-move]').forEach(btn => {
      const val = btn.dataset.thresholdMove === 'off' ? null : Number(btn.dataset.thresholdMove);
      btn.classList.toggle('active', val === moveValue || (val == null && moveValue == null));
    });
  };

  cfg.querySelectorAll('.pulse-selection-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = String(btn.dataset.target || '');
      const rawValue = String(btn.dataset.value || '');
      if (!targetId || !rawValue) return;
      const normalizer = targetId === 'pulseTargetCountries' ? normalizePulseCountry : (targetId === 'pulseTargetMeetings' ? normalizePulseMeetingName : normalizePulseRaceTarget);
      const nextValues = pulseChipValuesFromField(targetId, normalizer).filter(value => value !== normalizer(rawValue));
      setPulseChipFieldValue(targetId, targetId === 'pulseTargetRaces' ? nextValues.map(value => value.replace('::', ' | R')) : nextValues);
      syncTargetChips();
      if (status) status.textContent = 'Unsaved changes';
    });
  });

  cfg.querySelectorAll('[data-threshold-severity]').forEach(btn => btn.addEventListener('click', () => {
    const sel = $('pulseThresholdSeverity');
    if (sel) sel.value = btn.dataset.thresholdSeverity || thresholds.minSeverity;
    syncThresholdPills();
    if (status) status.textContent = 'Unsaved changes';
  }));
  cfg.querySelectorAll('[data-threshold-minutes]').forEach(btn => btn.addEventListener('click', () => {
    const input = $('pulseThresholdMinutes');
    if (!input) return;
    input.value = btn.dataset.thresholdMinutes === 'off' ? '' : String(btn.dataset.thresholdMinutes || '');
    syncThresholdPills();
    if (status) status.textContent = 'Unsaved changes';
  }));
  cfg.querySelectorAll('[data-threshold-move]').forEach(btn => btn.addEventListener('click', () => {
    const input = $('pulseThresholdMovePct');
    if (!input) return;
    input.value = btn.dataset.thresholdMove === 'off' ? '' : String(btn.dataset.thresholdMove || '');
    syncThresholdPills();
    if (status) status.textContent = 'Unsaved changes';
  }));

  syncTargetChips();
  syncThresholdPills();

  cfg.querySelectorAll('.pulse-config-toggle').forEach(input => {
    input.addEventListener('change', () => {
      const shell = input.closest('.pulse-alert-toggle');
      if (shell) {
        shell.classList.toggle('active', !!input.checked);
        const state = shell.querySelector('.pulse-mini-state');
        if (state) state.textContent = input.checked ? 'On' : 'Off';
      }
      if (status) status.textContent = 'Unsaved changes';
    });
  });

    cfg.querySelectorAll('.pulse-config-toggle, #pulseEnabledToggle, input[name="pulseTargetMode"], #pulseTargetCountries, #pulseTargetMeetings, #pulseTargetRaces, #pulseThresholdSeverity, #pulseThresholdMinutes, #pulseThresholdMovePct, #pulseThresholdTrackedOverride').forEach(input => {
      input.addEventListener('change', () => {
        if (input.name === 'pulseTargetMode') {
          cfg.querySelectorAll('.pulse-mode-pill').forEach(pill => pill.classList.toggle('active', pill.querySelector('input')?.checked));
          syncTargetChips();
        }
        if (status) status.textContent = 'Unsaved changes';
      });
  });
  $('pulseThresholdMinutes')?.addEventListener('input', syncThresholdPills);
  $('pulseThresholdMovePct')?.addEventListener('input', syncThresholdPills);
  $('savePulseConfigBtn')?.addEventListener('click', async () => {
    const btn = $('savePulseConfigBtn');
    const nextAlertTypes = {};
    cfg.querySelectorAll('.pulse-config-toggle').forEach(input => {
      nextAlertTypes[input.dataset.key] = !!input.checked;
    });
    const nextTargeting = {
      mode: cfg.querySelector('input[name="pulseTargetMode"]:checked')?.value || targeting.mode,
      countries: pulseChipValuesFromField('pulseTargetCountries', normalizePulseCountry),
      meetings: pulseChipValuesFromField('pulseTargetMeetings', normalizePulseMeetingName),
      races: pulseChipValuesFromField('pulseTargetRaces', normalizePulseRaceTarget),
    };
    const nextThresholds = {
      minSeverity: $('pulseThresholdSeverity')?.value || thresholds.minSeverity,
      maxMinsToJump: $('pulseThresholdMinutes')?.value === '' ? null : Number($('pulseThresholdMinutes')?.value),
      minMovePct: $('pulseThresholdMovePct')?.value === '' ? null : Number($('pulseThresholdMovePct')?.value),
      trackedRunnerOverride: !!$('pulseThresholdTrackedOverride')?.checked,
    };
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Saving…';
    try {
      await savePulseConfig({ enabled: !!$('pulseEnabledToggle')?.checked, alertTypes: nextAlertTypes, thresholds: nextThresholds, targeting: nextTargeting });
      if ($('pulseLiveRulesSummary')) $('pulseLiveRulesSummary').textContent = pulseTargetingSummary(nextTargeting);
      setPulseConfigFlash(`Saved · ${pulseTargetingSummary(nextTargeting)}`);
      renderPulseConfigPanel();
    } catch (err) {
      if (status) status.textContent = `Save failed: ${err?.message || 'unknown error'}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

function setActivePerformanceTab(tab){
  document.querySelectorAll('.perf-subtab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.perfTab === tab);
  });
  document.querySelectorAll('.perf-subpanel').forEach(panel => {
    const active = panel.dataset.perfPanel === tab;
    panel.style.display = active ? '' : 'none';
    panel.classList.toggle('active', active);
  });
}

let trackedTab = 'active';
let trackedBetsCache = [];
let trackedBetsCacheLoadedAt = 0;

function formatTrackedOddsValue(value){
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num.toFixed(2) : '—';
}

function resolveTrackedOddsDisplay(row = {}, kind = 'current'){
  const current = Number(row?.currentOdds);
  const entry = Number(row?.entryOdds ?? row?.odds);
  const resolved = kind === 'entry'
    ? (Number.isFinite(entry) && entry > 0 ? entry : null)
    : (Number.isFinite(current) && current > 0
      ? current
      : (Number.isFinite(entry) && entry > 0 ? entry : null));
  return formatTrackedOddsValue(resolved);
}

function canonicalTrackedResultLabel(value){
  const raw = String(value || 'pending').trim().toLowerCase();
  if (raw === 'win') return 'won';
  if (raw === 'loss') return 'lost';
  if (raw === 'placed' || raw === 'place') return 'won';
  if (raw.startsWith('ew_')) return raw === 'ew_loss' ? 'lost' : 'won';
  if (raw === 'won' || raw === 'lost' || raw === 'void') return raw;
  return 'pending';
}

function trackedSummaryMetrics(rows = []){
  const filtered = Array.isArray(rows) ? rows : [];
  const meetings = new Set();
  const races = new Set();
  let activeCount = 0;
  filtered.forEach((row) => {
    const meeting = String(row?.meeting || '').trim();
    const race = String(row?.race || '').trim();
    if (meeting) meetings.add(meeting.toLowerCase());
    if (meeting || race) races.add(`${meeting.toLowerCase()}|${race.toLowerCase()}`);
    if (isTrackedRowActive(row)) activeCount += 1;
  });
  return { total: filtered.length, meetings: meetings.size, races: races.size, active: activeCount };
}

function isTrackedRaceFinishedForDisplay(row){
  const status = String(row?.status || '').toLowerCase();
  const raceStatus = String(row?.raceStatus || '').trim().toLowerCase();
  if (status === 'settled') return true;
  if (['final','closed','finalized','abandoned','resulted','settled','complete','completed','jumped','running','inrunning','in-running','live'].includes(raceStatus)) return true;
  const minsToJump = Number(row?.minsToJump);
  if (Number.isFinite(minsToJump) && minsToJump < 0) return true;
  const raceStartMs = Date.parse(String(row?.raceStartTime || ''));
  return Number.isFinite(raceStartMs) && raceStartMs < (Date.now() - (5 * 60 * 1000));
}

function isTrackedRowActive(row){
  return !isTrackedRaceFinishedForDisplay(row);
}

function renderTrackedSummary(rows = []){
  const summary = $('trackedSummaryStrip');
  const note = $('trackedSummaryNote');
  if (!summary) return;
  const metrics = trackedSummaryMetrics(rows);
  const cards = [
    { label: trackedTab === 'active' ? 'active runners in view' : 'still active overall', value: metrics.active },
    { label: trackedTab === 'active' ? 'tracked meetings' : 'meetings in view', value: metrics.meetings },
    { label: trackedTab === 'active' ? 'tracked races' : 'races in view', value: metrics.races },
    { label: trackedTab === 'active' ? 'rows in view' : 'rows in this tab', value: metrics.total },
  ];
  summary.innerHTML = cards.map(card => `<div class='perf-card'><div class='label'>${escapeHtml(card.label)}</div><div class='value'>${escapeHtml(String(card.value))}</div></div>`).join('');
  if (note) note.textContent = metrics.total ? `Tracking ${metrics.meetings} meeting${metrics.meetings === 1 ? '' : 's'} across ${metrics.races} race${metrics.races === 1 ? '' : 's'} in ${trackedTab}.` : `No ${trackedTab} tracked runners.`;
}

function normalizeSettledResultValue(value){
  if (typeof normalizeLedgerResult === 'function') return normalizeLedgerResult(value);
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'pending';
  if (raw === 'won') return 'win';
  if (raw === 'lost') return 'loss';
  if (raw === 'placed' || raw === 'place') return 'ew_place';
  return raw;
}

async function loadTrackedBetsCache(force = false){
  if (!force && trackedBetsCacheLoadedAt && (Date.now() - trackedBetsCacheLoadedAt) < 15_000) return trackedBetsCache;
  try {
    const payload = await fetchLocal('./api/v1/tracked-bets', { cache: 'no-store' }).then(r => r.json());
    trackedBetsCache = Array.isArray(payload?.trackedBets) ? payload.trackedBets : [];
    trackedBetsCacheLoadedAt = Date.now();
  } catch {
    trackedBetsCache = [];
    trackedBetsCacheLoadedAt = Date.now();
  }
  return trackedBetsCache;
}

function findTrackedBet(meeting, race, selection){
  const meetingKey = normalizeMeetingKey(meeting || '');
  const raceKey = normalizeRaceNumberValue(race || '');
  const selectionKey = normalizeRunnerName(selection || '');
  if (!meetingKey || !raceKey || !selectionKey) return null;
  return (trackedBetsCache || []).find(row =>
    normalizeMeetingKey(row?.meeting || '') === meetingKey &&
    normalizeRaceNumberValue(row?.race || '') === raceKey &&
    normalizeRunnerName(row?.selection || '') === selectionKey
  ) || null;
}

function computeTrackRunnerPayload(race, runner, extras = {}){
  const runnerName = cleanRunnerText(runner?.name || runner?.runner_name || runner?.selection || extras.selection || '');
  const raceNo = String(race?.race_number || race?.race || extras.race || '').replace(/^R/i, '').trim();
  const winOdds = Number(runner?.odds || runner?.fixed_win || runner?.tote_win || extras.odds || 0);
  const entryOdds = Number.isFinite(winOdds) && winOdds > 0 ? Number(winOdds.toFixed(2)) : null;
  const eta = computeRaceEta(race).eta;
  return {
    meeting: race?.meeting || extras.meeting || '',
    race: raceNo,
    selection: runnerName,
    betType: extras.betType || 'Win',
    odds: entryOdds,
    entryOdds,
    stake: extras.stake ?? null,
    jumpsIn: eta && eta !== '—' ? eta : (extras.jumpsIn ?? null),
    note: extras.note ?? null,
    source: extras.source || 'web-runner'
  };
}

function buildTrackTypeChooserHtml(options = {}){
  const {
    heading = 'Choose tracking mode',
    subheading = '',
    choices = [],
    cancelLabel = 'Cancel'
  } = options || {};
  const choiceButtons = (choices || [])
    .map(choice => `<button class='btn btn-ghost' type='button' data-track-choice='${escapeAttr(String(choice?.value || ''))}'>${escapeHtml(String(choice?.label || choice?.value || 'Option'))}</button>`)
    .join('');
  return `
    <div class='stack' data-track-chooser='1' style='gap:10px'>
      <div>
        <div style='font-weight:700'>${escapeHtml(String(heading || 'Choose tracking mode'))}</div>
        ${subheading ? `<div class='sub' style='margin-top:4px'>${escapeHtml(String(subheading))}</div>` : ''}
      </div>
      <div style='display:flex;flex-wrap:wrap;gap:8px'>${choiceButtons}</div>
      <div style='display:flex;justify-content:flex-end'>
        <button class='btn btn-ghost' type='button' data-track-choice-cancel='1'>${escapeHtml(String(cancelLabel || 'Cancel'))}</button>
      </div>
    </div>`;
}

function bindTrackTypeChooser(onSelect){
  const root = document.querySelector('[data-track-chooser="1"]');
  if (!root || typeof onSelect !== 'function') return;
  root.querySelectorAll('[data-track-choice]').forEach(btn => {
    btn.onclick = async (e) => {
      e.preventDefault();
      const choice = String(btn.getAttribute('data-track-choice') || '').trim();
      if (!choice) return;
      await onSelect(choice, btn);
    };
  });
  root.querySelector('[data-track-choice-cancel="1"]')?.addEventListener('click', () => closeSummaryPopup());
}

async function openTrackRaceChooser(race, options = {}){
  if (!race) return null;
  const {
    title = `${race.meeting || 'Race'} R${race.race_number || race.race || '—'} — Track`,
    sourcePrefix = 'web-race-track',
    notes = {}
  } = options || {};
  openSummaryPopup(title, buildTrackTypeChooserHtml({
    heading: 'Track this race',
    subheading: 'Choose whether to add every runner as tracked WIN entries or WATCH entries.',
    choices: [
      { value: 'Win', label: 'Track all runners' },
      { value: 'Watch', label: 'Watch race' }
    ]
  }));
  bindTrackTypeChooser(async (betType, btn) => {
    btn.disabled = true;
    const watchMode = String(betType || '').toLowerCase() === 'watch';
    const result = await trackAllRunnersInRace(race, {
      betType,
      source: watchMode ? `${sourcePrefix}-watch` : `${sourcePrefix}-all`,
      note: watchMode ? (notes.watch || 'Watch race') : (notes.win || 'Track all runners in race')
    }).catch(() => null);
    closeSummaryPopup();
    if (!result) return alert(watchMode ? 'Failed to watch race.' : 'Failed to track all runners.');
    alert(watchMode
      ? `Watch race: ${result.created} added, ${result.duplicates} already tracked.`
      : `Track all runners: ${result.created} added, ${result.duplicates} already tracked.`);
  });
  return true;
}

function buildTrackRunnerButtonsHtml(race, runner, trackedBet){
  const trackedMeta = trackedGroupMeta(trackedBet || {});
  const trackedButtonLabel = trackedBet ? 'TRACKED' : 'Track';
  const trackedButtonClass = trackedBet ? 'btn btn-ghost compact-btn track-runner-btn is-tracked' : 'btn btn-ghost compact-btn track-runner-btn';
  const baseAttrs = `data-meeting='${escapeAttr(String(race?.meeting || ''))}' data-race='${escapeAttr(String(race?.race_number || race?.race || ''))}' data-runner='${escapeAttr(String(runner?.name || runner?.runner_name || ''))}'`;
  const trackedMetaTag = trackedBet ? `<span class='tag tracked'>${trackedMeta.isMulti ? `${escapeHtml(trackedMeta.groupLabel)} · ` : ''}${escapeHtml(String(trackedBet.betType || 'Win').toUpperCase())} · Entry ${trackedBet.odds != null ? escapeHtml(Number(trackedBet.odds).toFixed(2)) : '—'}${trackedBet.jumpsIn ? ` · ${escapeHtml(String(trackedBet.jumpsIn))}` : ''}</span>` : '';
  return `
    <button class='${trackedButtonClass}' type='button' data-track-runner='1' data-track-bet-type='${trackedBet ? escapeAttr(String(trackedBet.betType || 'Win')) : ''}' ${baseAttrs}>${trackedButtonLabel}</button>
    ${trackedMetaTag}`;
}

function buildRaceTrackingPayloads(race, extras = {}){
  const runners = Array.isArray(race?.runners) ? race.runners : [];
  return runners
    .map(runner => computeTrackRunnerPayload(race, runner, extras))
    .filter(payload => payload?.meeting && payload?.race && payload?.selection);
}

async function trackAllRunnersInRace(race, extras = {}){
  if (!race) return { created: 0, duplicates: 0, attempted: 0 };
  const payloads = buildRaceTrackingPayloads(race, extras);
  let created = 0;
  let duplicates = 0;
  for (const payload of payloads) {
    const res = await fetchLocal('./api/v1/tracked-bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => null);
    const data = res ? await res.json().catch(() => null) : null;
    if (data?.duplicate) duplicates += 1;
    else if (res?.ok) created += 1;
  }
  await refreshTrackedUi({ force: true, rerenderAnalysis: true, rerenderTracked: true });
  return { created, duplicates, attempted: payloads.length };
}

function nextBestCandidates(decision = {}){
  const recommendedKey = normalizeRunnerName(decision?.recommendedKey || '');
  const recommendedName = cleanRunnerText(decision?.recommendedName || '');
  let oddsRunner = decision?.oddsRunner || null;
  const oddsRunnerKey = normalizeRunnerName(oddsRunner?.norm || oddsRunner?.runner?.name || oddsRunner?.runner?.runner_name || '');
  if (recommendedKey && oddsRunnerKey && recommendedKey === oddsRunnerKey) oddsRunner = null;
  return {
    recommendedName,
    recommendedKey,
    oddsRunner,
    oddsRunnerKey: oddsRunner ? normalizeRunnerName(oddsRunner?.norm || oddsRunner?.runner?.name || oddsRunner?.runner?.runner_name || '') : ''
  };
}

function trackedGroupMeta(row = {}){
  const groupType = String(row?.groupType || '').trim().toLowerCase();
  const groupId = String(row?.groupId || '').trim();
  const groupSize = Number(row?.groupSize);
  const legIndex = Number(row?.legIndex);
  return {
    isMulti: groupType === 'multi' && !!groupId,
    groupType,
    groupId,
    groupLabel: String(row?.groupLabel || '').trim() || (Number.isFinite(groupSize) && groupSize > 0 ? `${groupSize}-Leg Multi` : 'Multi'),
    groupSize: Number.isFinite(groupSize) && groupSize > 0 ? Math.round(groupSize) : null,
    legIndex: Number.isFinite(legIndex) && legIndex > 0 ? Math.round(legIndex) : null,
  };
}

function buildTrackedMultiTag(row = {}){
  const meta = trackedGroupMeta(row);
  if (!meta.isMulti) return '';
  const legText = meta.legIndex && meta.groupSize ? ` ${meta.legIndex}/${meta.groupSize}` : '';
  return `<span class='tag tracked'>MULTI${escapeHtml(legText)}</span>`;
}

function dedupeDraggedSelections(rows = []) {
  const seen = new Set();
  const out = [];
  for (const raw of rows) {
    const item = enrichDraggedSelection(raw);
    const meeting = String(item?.meeting || '').trim();
    const race = String(item?.race || '').replace(/^R/i, '').trim();
    const selection = cleanRunnerText(item?.selection || item?.runner || '');
    const key = `${meeting.toLowerCase()}|${race}|${normalizeRunnerName(selection)}`;
    if (!meeting || !race || !selection || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...item, meeting, race, selection });
  }
  return out;
}

async function trackDraggedSelectionsAsMulti(){
  const legs = dedupeDraggedSelections(draggedSelections);
  if (legs.length < 2) {
    alert('Drag at least two distinct selections before tracking a multi.');
    return;
  }
  const groupId = `multi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const groupLabel = `${legs.length}-Leg Multi`;
  const compactLegs = legs.map((leg, index) => ({
    meeting: leg.meeting,
    race: leg.race,
    selection: leg.selection,
    odds: Number.isFinite(Number(leg.odds)) ? Number(Number(leg.odds).toFixed(2)) : null,
    legIndex: index + 1,
  }));

  try {
    await Promise.all(compactLegs.map((leg) => fetchLocal('./api/v1/tracked-bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        meeting: leg.meeting,
        race: leg.race,
        selection: leg.selection,
        betType: 'Multi',
        odds: leg.odds,
        entryOdds: leg.odds,
        source: 'web-multi',
        groupType: 'multi',
        groupId,
        groupLabel,
        groupSize: compactLegs.length,
        legIndex: leg.legIndex,
        legs: compactLegs,
      })
    })));
    await refreshTrackedUi({ force: true, rerenderAnalysis: true, rerenderTracked: true });
    alert(`Tracked ${compactLegs.length}-leg multi.`);
  } catch (e) {
    alert('Failed to track multi.');
  }
}

async function refreshTrackedUi(opts = {}){
  const { force = true, rerenderAnalysis = true, rerenderTracked = true } = opts;
  await loadTrackedBetsCache(force);
  if (rerenderAnalysis && selectedRace && $('analysisBody')) {
    $('analysisBody').innerHTML = renderAnalysis(selectedRace, analysisViewMode || 'engine');
    updateAnalysisAiModelNote();
    attachAnalysisSelectionHandlers(selectedRace);
    makeSelectionsDraggable();
  }
  if (rerenderTracked && activePage === 'tracked') {
    renderTrackedShell();
  }
}

async function toggleTrackedRunner(race, runner, opts = {}){
  if (!race || !runner) return null;
  const payload = computeTrackRunnerPayload(race, runner, opts);
  if (!payload.meeting || !payload.race || !payload.selection) return null;
  const existing = findTrackedBet(payload.meeting, payload.race, payload.selection);
  if (existing) {
    await fetchLocal(`./api/v1/tracked-bets/${encodeURIComponent(existing.id)}`, { method: 'DELETE' }).catch(() => null);
    await refreshTrackedUi({ force: true });
    return { action: 'untracked', trackedBet: existing };
  }
  const res = await fetchLocal('./api/v1/tracked-bets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).catch(() => null);
  const trackedBet = res ? await res.json().catch(() => null) : null;
  await refreshTrackedUi({ force: true });
  return { action: 'tracked', trackedBet: trackedBet?.trackedBet || null };
}

function buildTrackedEditorHtml(row){
  const meeting = escapeHtml(String(row?.meeting || '—'));
  const race = escapeHtml(String(row?.race || '—'));
  const status = escapeHtml(String(row?.status || 'active'));
  const result = escapeHtml(canonicalTrackedResultLabel(row?.result).toUpperCase());
  const currentOdds = resolveTrackedOddsDisplay(row, 'current');
  const currentOddsMeta = row?.currentOddsSource ? ` <span class='sub'>(${escapeHtml(String(row.currentOddsSource))})</span>` : '';
  const jumpsIn = row?.jumpsIn ? escapeHtml(String(row.jumpsIn)) : '—';
  const settlementLine = String(row?.status || '') === 'settled'
    ? `<div><b>Settlement:</b> Return ${fmtUnits(row?.payout)} · P/L ${fmtUnits(row?.profit)} · ROI ${fmtPct(row?.roi)}</div>`
    : '';
  return `
    <div class='tracked-editor' data-tracked-edit-root='1' data-id='${escapeAttr(String(row?.id || ''))}'>
      <div class='horse-meta' style='margin-bottom:12px'>
        <div><b>Race:</b> ${meeting} R${race}</div>
        <div><b>Status:</b> ${status} · <b>Result:</b> ${result}</div>
        <div><b>Jumps In:</b> ${jumpsIn}</div>
        <div><b>Current Odds:</b> ${currentOdds}${currentOddsMeta}</div>
        ${settlementLine}
      </div>
      <div class='filters' style='align-items:flex-end'>
        <label style='display:flex;flex-direction:column;gap:6px;min-width:180px'>
          <span class='sub'>Selection</span>
          <input data-field='selection' type='text' value='${escapeAttr(String(row?.selection || ''))}' />
        </label>
        <label style='display:flex;flex-direction:column;gap:6px;min-width:110px'>
          <span class='sub'>Entry Odds</span>
          <input data-field='entryOdds' type='number' min='0' step='0.01' value='${escapeAttr(row?.entryOdds ?? row?.odds ?? '')}' />
        </label>
        <label style='display:flex;flex-direction:column;gap:6px;min-width:110px'>
          <span class='sub'>Stake</span>
          <input data-field='stake' type='number' min='0' step='0.01' value='${escapeAttr(row?.stake ?? '')}' />
        </label>
        <label style='display:flex;flex-direction:column;gap:6px;min-width:140px;flex:1 1 160px'>
          <span class='sub'>Jumps In</span>
          <input data-field='jumpsIn' type='text' value='${escapeAttr(String(row?.jumpsIn || ''))}' />
        </label>
      </div>
      <label style='display:flex;flex-direction:column;gap:6px;margin-top:12px'>
        <span class='sub'>Note</span>
        <textarea data-field='note' rows='3' placeholder='Optional note'>${escapeHtml(String(row?.note || ''))}</textarea>
      </label>
      <div class='btn-row' style='margin-top:12px'>
        <button class='btn' type='button' data-tracked-save='1'>Save</button>
        <button class='btn btn-ghost' type='button' data-tracked-untrack='1'>Untrack</button>
      </div>
    </div>`;
}

function bindTrackedEditor(root, row){
  if (!root || !row?.id) return;
  const readField = (name) => root.querySelector(`[data-field='${name}']`);
  root.querySelector('[data-tracked-save="1"]')?.addEventListener('click', async () => {
    const selection = String(readField('selection')?.value || '').trim();
    const oddsRaw = String(readField('entryOdds')?.value || '').trim();
    const stakeRaw = String(readField('stake')?.value || '').trim();
    const jumpsIn = String(readField('jumpsIn')?.value || '').trim();
    const note = String(readField('note')?.value || '').trim();
    const odds = oddsRaw === '' ? null : Number(oddsRaw);
    const stake = stakeRaw === '' ? null : Number(stakeRaw);
    await fetchLocal(`./api/v1/tracked-bets/${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selection: selection || row.selection,
        odds: Number.isFinite(odds) ? odds : null,
        entryOdds: Number.isFinite(odds) ? odds : null,
        stake: Number.isFinite(stake) ? stake : null,
        jumpsIn: jumpsIn || null,
        note: note || null
      })
    }).catch(() => null);
    closeSummaryPopup();
    await refreshTrackedUi({ force: true });
  });
  root.querySelector('[data-tracked-untrack="1"]')?.addEventListener('click', async () => {
    await fetchLocal(`./api/v1/tracked-bets/${encodeURIComponent(row.id)}`, { method: 'DELETE' }).catch(() => null);
    closeSummaryPopup();
    await refreshTrackedUi({ force: true });
  });
}

async function openTrackedEditorById(id){
  if (!id) return;
  const rows = await loadTrackedBetsCache(true);
  const row = (rows || []).find(x => String(x?.id || '') === String(id));
  if (!row) return;
  openSummaryPopup(`${row.meeting || 'Tracked'} R${row.race || '—'} — ${row.selection || 'Runner'}`, buildTrackedEditorHtml(row));
  bindTrackedEditor(document.querySelector('[data-tracked-edit-root="1"]'), row);
}

function setActivePulseTab(tab){
  document.querySelectorAll('.pulse-subtab, .alerts-subtab').forEach(btn => {
    const btnTab = btn.dataset.pulseTab || btn.dataset.alertsTab;
    btn.classList.toggle('active', btnTab === tab);
  });
  document.querySelectorAll('.pulse-subpanel, .alerts-subpanel').forEach(panel => {
    const panelTab = panel.dataset.pulsePanel || panel.dataset.alertsPanel;
    const active = panelTab === tab;
    panel.style.display = active ? '' : 'none';
    panel.classList.toggle('active', active);
  });
}

function setActiveAlertsTab(tab){
  setActivePulseTab(tab);
}

function setActiveTrackedTab(tab){
  trackedTab = tab || 'active';
  document.querySelectorAll('.tracked-subtab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.trackedTab === trackedTab);
  });
}

function trackedPriorityBand(row){
  const mins = Number(row?.minsToJump);
  const movePct = Math.abs(Number(row?.movePct || 0));
  const isTrackedJumpPulse = String(row?.lastPulseType || '').toLowerCase() === 'jump_pulse';
  if (isTrackedJumpPulse || (Number.isFinite(mins) && mins >= 0 && mins <= 3)) return 'PRIMARY';
  if (movePct >= 10 || (Number.isFinite(mins) && mins <= 15)) return 'ACTIVE';
  return 'PASSIVE';
}

function trackedPriorityRank(row){
  const band = trackedPriorityBand(row);
  if (band === 'PRIMARY') return 3;
  if (band === 'ACTIVE') return 2;
  return 1;
}

function trackedSettledBucket(row){
  const settledAt = row?.settledAt ? new Date(row.settledAt) : null;
  if (!settledAt || Number.isNaN(settledAt.getTime())) return 'settled';
  const now = new Date();
  const settledDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year:'numeric', month:'2-digit', day:'2-digit' }).format(settledAt);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year:'numeric', month:'2-digit', day:'2-digit' }).format(now);
  return settledDay === today ? 'settled' : 'history';
}

async function renderTrackedShell(){
  const table = $('trackedTable');
  if (!table) return;
  const rows = await loadTrackedBetsCache(true);
  const filtered = rows
    .filter(r => {
      const displaySettled = !isTrackedRowActive(r);
      if (trackedTab === 'active') return !displaySettled;
      if (trackedTab === 'settled') return displaySettled && trackedSettledBucket(r) === 'settled';
      if (trackedTab === 'history') return displaySettled && trackedSettledBucket(r) === 'history';
      return false;
    })
    .sort((a, b) => {
      const pr = trackedPriorityRank(b) - trackedPriorityRank(a);
      if (pr !== 0) return pr;
      const am = Number(a?.minsToJump);
      const bm = Number(b?.minsToJump);
      if (Number.isFinite(am) && Number.isFinite(bm) && am !== bm) return am - bm;
      return String(b?.settledAt || b?.trackedAt || '').localeCompare(String(a?.settledAt || a?.trackedAt || ''));
    });
  renderTrackedSummary(filtered);
  if (!filtered.length) {
    table.innerHTML = `<div class='row'><div style='grid-column:1/-1'>No ${trackedTab} tracked runners</div></div>`;
    return;
  }
  const groupedHistory = trackedTab === 'history'
    ? filtered.reduce((acc, row) => {
        const day = row?.settledAt ? new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', weekday:'short', day:'numeric', month:'short' }).format(new Date(row.settledAt)) : 'Unknown day';
        (acc[day] ||= []).push(row);
        return acc;
      }, {})
    : null;
  const renderRows = (items) => items.map((r, index) => {
    const result = canonicalTrackedResultLabel(r.result);
    const badge = result === 'won' ? 'value' : (result === 'lost' ? 'danger' : 'ew');
    const entryOdds = resolveTrackedOddsDisplay(r, 'entry');
    const currentOdds = resolveTrackedOddsDisplay(r, 'current');
    const currentSub = r.currentOddsSource
      ? `Current ${currentOdds} · ${escapeHtml(String(r.currentOddsSource))}`
      : `Current ${currentOdds}`;
    const settlementSub = String(r.status || '') === 'settled'
      ? `Return ${fmtUnits(r.payout)} · P/L ${fmtUnits(r.profit)} · ROI ${fmtPct(r.roi)}`
      : 'Awaiting result';
    const priorityBand = trackedPriorityBand(r);
    const priorityClass = priorityBand === 'PRIMARY' ? 'value' : (priorityBand === 'ACTIVE' ? 'ew' : '');
    const multiTag = buildTrackedMultiTag(r);
    const multiSub = trackedGroupMeta(r).isMulti ? ` · ${escapeHtml(trackedGroupMeta(r).groupLabel)}` : '';
    return `<div class='row tracked-row' draggable='true' data-index='${index}' data-id='${escapeAttr(String(r.id || ''))}' data-meeting='${escapeAttr(String(r.meeting || ''))}' data-race='${escapeAttr(String(r.race || ''))}' data-selection='${escapeAttr(String(r.selection || ''))}'>
      <div><span class='badge'>${escapeHtml(String(r.meeting || ''))}</span> R${escapeHtml(String(r.race || ''))}</div>
      <div>${escapeHtml(String(r.selection || ''))}${multiTag ? ` <span class='runner-tag-row'>${multiTag}</span>` : ''} <span class='tag ${priorityClass}'>${priorityBand}</span><div class='sub'>${escapeHtml(String(r.betType || 'Win'))}${multiSub}${r.jumpsIn ? ` · Jumps In ${escapeHtml(String(r.jumpsIn))}` : ''}</div></div>
      <div>${escapeHtml(String(r.status || 'active'))}<div class='sub'><span class='tag ${badge}'>${escapeHtml(result.toUpperCase())}</span></div></div>
      <div>Entry ${entryOdds}<div class='sub'>${currentSub}</div></div>
      <div class='right'>
        <div>${r.stake != null ? escapeHtml(String(r.stake)) : '—'}<div class='sub'>stake · ${settlementSub}</div></div>
        <button class='btn btn-ghost compact-btn tracked-priority-up-btn' data-id='${escapeAttr(String(r.id || ''))}' title='Raise priority'>↑</button>
        <button class='btn btn-ghost compact-btn tracked-priority-down-btn' data-id='${escapeAttr(String(r.id || ''))}' title='Lower priority'>↓</button>
        <button class='btn btn-ghost compact-btn tracked-edit-btn' data-id='${escapeAttr(String(r.id || ''))}' data-selection='${escapeAttr(String(r.selection || ''))}'>Edit</button>
        <button class='btn btn-ghost compact-btn tracked-remove-btn' data-id='${escapeAttr(String(r.id || ''))}'>Untrack</button>
      </div>
    </div>`;
  }).join('');
  if (trackedTab === 'history') {
    table.innerHTML = Object.entries(groupedHistory || {}).map(([day, rows]) => `<div class='row header'><div style='grid-column:1/-1'>${escapeHtml(day)}</div></div><div class='row header'><div>Race</div><div>Selection</div><div>Status</div><div>Odds</div><div class='right'>Stake / Settlement / Actions</div></div>${renderRows(rows)}`).join('');
    return;
  }
  table.innerHTML = `<div class='row header'><div>Race</div><div>Selection</div><div>Status</div><div>Odds</div><div class='right'>Stake / Settlement / Actions</div></div>` + renderRows(filtered);

  let draggedTrackedId = null;
  table.querySelectorAll('.tracked-row').forEach(row => {
    row.addEventListener('dragstart', (e) => {
      draggedTrackedId = row.getAttribute('data-id');
      row.classList.add('dragging');
      try { e.dataTransfer.effectAllowed = 'move'; } catch {}
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      draggedTrackedId = null;
      table.querySelectorAll('.tracked-row').forEach(n => n.classList.remove('drop-target'));
    });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!draggedTrackedId || draggedTrackedId === row.getAttribute('data-id')) return;
      table.querySelectorAll('.tracked-row').forEach(n => n.classList.remove('drop-target'));
      row.classList.add('drop-target');
      try { e.dataTransfer.dropEffect = 'move'; } catch {}
    });
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const targetId = row.getAttribute('data-id');
      if (!draggedTrackedId || !targetId || draggedTrackedId === targetId) return;
      const ordered = filtered.slice();
      const from = ordered.findIndex(item => String(item.id) === String(draggedTrackedId));
      const to = ordered.findIndex(item => String(item.id) === String(targetId));
      if (from === -1 || to === -1) return;
      const [moved] = ordered.splice(from, 1);
      ordered.splice(to, 0, moved);
      await Promise.all(ordered.map((item, idx) => fetchLocal(`./api/v1/tracked-bets/${encodeURIComponent(String(item.id))}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priorityRank: idx + 1 })
      }).catch(() => null)));
      await refreshTrackedUi({ force: true, rerenderAnalysis: false, rerenderTracked: true });
    });
    row.addEventListener('click', async () => {
      const id = row.getAttribute('data-id');
      if (!id) return;
      await openTrackedEditorById(id);
    });
  });

  table.querySelectorAll('.tracked-remove-btn').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.getAttribute('data-id');
    if (!id) return;
    await fetchLocal(`./api/v1/tracked-bets/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
    await refreshTrackedUi({ force: true, rerenderAnalysis: false, rerenderTracked: true });
  }));

  async function shiftTrackedPriority(id, delta) {
    const idx = filtered.findIndex(r => String(r.id) === String(id));
    if (idx === -1) return;
    const current = filtered[idx];
    const currentRank = Number.isFinite(Number(current?.priorityRank)) ? Number(current.priorityRank) : idx + 1;
    const nextRank = Math.max(1, currentRank + delta);
    await fetchLocal(`./api/v1/tracked-bets/${encodeURIComponent(String(id))}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priorityRank: nextRank })
    }).catch(() => null);
    await refreshTrackedUi({ force: true, rerenderAnalysis: false, rerenderTracked: true });
  }

  table.querySelectorAll('.tracked-priority-up-btn').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.getAttribute('data-id');
    if (!id) return;
    await shiftTrackedPriority(id, -1);
  }));

  table.querySelectorAll('.tracked-priority-down-btn').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.getAttribute('data-id');
    if (!id) return;
    await shiftTrackedPriority(id, 1);
  }));

  table.querySelectorAll('.tracked-edit-btn').forEach(btn => btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = btn.getAttribute('data-id');
    await openTrackedEditorById(id);
  }));
}

async function hydrateAlertsMeetingFilter(alerts){
  const sel = $('pulseMeetingFilter') || $('alertsMeetingFilter');
  if (!sel) return 'all';
  const prev = sel.value || 'all';
  let candidateMeetings = (alerts || []).map(a => String(a?.meeting || '').trim()).filter(Boolean);
  try {
    const options = await getPulseTargetOptions(pulseConfigState?.targeting || {});
    candidateMeetings = candidateMeetings.concat(options?.meetings || []);
  } catch {}
  candidateMeetings = candidateMeetings.concat(currentStatusMeetings());
  const focusedMeeting = pulseFocusedMeetingFromTargeting(pulseConfigState?.targeting || {});
  if (focusedMeeting) candidateMeetings.push(focusedMeeting);
  if (selectedMeeting && selectedMeeting !== 'ALL') candidateMeetings.push(String(selectedMeeting).trim());
  const meetings = Array.from(new Set(candidateMeetings.map(v => String(v || '').trim()).filter(Boolean))).sort((a,b) => a.localeCompare(b));
  sel.innerHTML = [`<option value="all">All meetings</option>`].concat(meetings.map(m => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`)).join('');
  const selectedMeetingLabel = selectedMeeting && selectedMeeting !== 'ALL' ? String(selectedMeeting).trim() : '';
  const preferred = meetings.includes(prev)
    ? prev
    : (focusedMeeting && meetings.includes(focusedMeeting) ? focusedMeeting : (selectedMeetingLabel && meetings.includes(selectedMeetingLabel) ? selectedMeetingLabel : 'all'));
  sel.value = preferred;
  renderPulseWatchFilterChips('pulseMeetingFilter', 'pulseMeetingFilterChips', 'All meetings');
  return preferred;
}

async function hydrateAlertsCountryFilter(alerts){
  const sel = $('pulseCountryFilter') || $('alertsCountryFilter');
  if (!sel) return 'all';
  const prev = sel.value || 'all';
  const seeded = [];
  if (selectedCountry && selectedCountry !== 'ALL') seeded.push(String(selectedCountry).trim());
  const targetingCountries = normalizePulseTargeting(pulseConfigState?.targeting || {}).countries || [];
  seeded.push(...targetingCountries);
  const countries = Array.from(new Set(seeded.concat((alerts || []).map(a => String(a?.country || '').trim())).filter(Boolean))).sort((a,b) => a.localeCompare(b));
  sel.innerHTML = [`<option value="all">All countries</option>`].concat(countries.map(country => `<option value="${escapeAttr(country)}">${escapeHtml(country)}</option>`)).join('');
  const preferred = countries.includes(prev)
    ? prev
    : (selectedCountry && selectedCountry !== 'ALL' && countries.includes(String(selectedCountry).trim()) ? String(selectedCountry).trim() : 'all');
  sel.value = preferred;
  renderPulseWatchFilterChips('pulseCountryFilter', 'pulseCountryFilterChips', 'All countries');
  return preferred;
}

function hydrateGenericAlertsSelect(selectId, values, allLabel){
  const sel = $(selectId);
  if (!sel) return;
  const prev = String(sel.value || 'all');
  const items = Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = [`<option value="all">${escapeHtml(allLabel)}</option>`].concat(items.map(value => `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`)).join('');
  sel.value = items.includes(prev) || prev === 'all' ? prev : 'all';
}

function genericAlertSortValue(row){
  const sev = pulseSeverityRank(row?.severity);
  const tracked = row?.trackedRunner ? 1 : 0;
  const absMove = Math.abs(Number(row?.movePct || 0));
  const mins = Number(row?.minsToJump);
  const minsRank = Number.isFinite(mins) ? Math.max(0, 120 - Math.min(120, mins)) : 0;
  return (sev * 100000) + (tracked * 10000) + (absMove * 100) + minsRank;
}

function formatAlertRelativeTime(ts){
  const time = parseTimeValue(ts);
  if (!Number.isFinite(time)) return '—';
  const diffMs = Date.now() - time;
  const absMinutes = Math.round(Math.abs(diffMs) / 60000);
  if (absMinutes < 1) return 'just now';
  if (absMinutes < 60) return diffMs >= 0 ? `${absMinutes}m ago` : `in ${absMinutes}m`;
  const absHours = Math.round(absMinutes / 60);
  if (absHours < 24) return diffMs >= 0 ? `${absHours}h ago` : `in ${absHours}h`;
  const absDays = Math.round(absHours / 24);
  return diffMs >= 0 ? `${absDays}d ago` : `in ${absDays}d`;
}

function buildGenericAlertsFilterSummary({ alerts = [], historyRows = [], countryFilter = 'all', meetingFilter = 'all', severityFilter = 'all', typeFilter = 'all', search = '' } = {}){
  const bits = [];
  if (countryFilter !== 'all') bits.push(countryFilter);
  if (meetingFilter !== 'all') bits.push(meetingFilter);
  if (severityFilter !== 'all') bits.push(severityFilter);
  if (typeFilter !== 'all') bits.push(typeFilter);
  if (search) bits.push(`search “${search}”`);
  const scope = bits.length ? bits.join(' · ') : 'full engine feed';
  return `Showing ${alerts.length} live / ${historyRows.length} history for ${scope}.`;
}

function buildAlertIdentityKey(row = {}){
  const meeting = normalizeMeetingKey(row?.meeting || '');
  const race = normalizeRaceNumberValue(row?.race || '');
  const selection = normalizeRunnerName(row?.selection || '');
  if (!meeting || !race || !selection) return '';
  return `${meeting}|${race}|${selection}`;
}

function alertRowBelongsInHistory(row, activeTrackedKeys = new Set()){
  const status = String(row?.status || '').trim().toLowerCase();
  if (status === 'live' || status === 'active' || status === 'pending') return false;
  if (row?.trackedRunner && activeTrackedKeys.has(buildAlertIdentityKey(row))) return false;
  if (row?.raceSettled === true) return true;
  if (status === 'settled' || status === 'closed' || status === 'history' || status === 'resolved') return true;
  return false;
}

function buildPulseHistoryCardMarkup(a){
  const sev = String(a?.severity || 'WATCH').toLowerCase();
  const result = String(a?.result || (a?.raceSettled ? 'settled' : a?.status || '') || '').trim();
  const winner = String(a?.winner || '').trim();
  const position = a?.position != null ? `Pos ${a.position}` : '';
  const resultBits = [result, position, winner ? `Winner ${winner}` : ''].filter(Boolean);
  const movePctNum = Number(a?.movePct);
  const movePct = Number.isFinite(movePctNum) ? `${movePctNum > 0 ? '+' : ''}${movePctNum.toFixed(1)}%` : '—';
  const jumpText = Number.isFinite(Number(a?.minsToJump)) ? `${Number(a.minsToJump)}m` : '—';
  return `<div class='pulse-history-card ${sev}'>
    <div class='pulse-history-top'>
      <div>
        <div class='pulse-history-title'>${escapeHtml(String(a?.meeting || '—'))} R${escapeHtml(String(a?.race || ''))} · ${escapeHtml(String(a?.selection || '—'))}</div>
        <div class='pulse-history-meta'>${escapeHtml(alertTypeTag(a?.type))} · ${escapeHtml(String(a?.country || '—'))} · ${escapeHtml(formatAlertRelativeTime(a?.ts))}</div>
      </div>
      <span class='alert-badge ${sev}'>${escapeHtml(String(a?.severity || 'WATCH'))}</span>
    </div>
    <div class='pulse-history-grid'>
      <div><span>Move</span><strong>${escapeHtml(String(a?.fromOdds ?? '—'))} → ${escapeHtml(String(a?.toOdds ?? '—'))}</strong><em>${escapeHtml(movePct)}</em></div>
      <div><span>Jump</span><strong>${escapeHtml(jumpText)}</strong><em>${escapeHtml(String(a?.status || '—'))}</em></div>
      <div><span>Outcome</span><strong>${escapeHtml(resultBits.join(' · ') || 'Pending')}</strong><em>${escapeHtml(String(a?.action || 'Watch'))}</em></div>
    </div>
    ${a?.interpretation ? `<div class='pulse-history-note'>${escapeHtml(String(a.interpretation))}</div>` : ''}
  </div>`;
}

function buildGenericAlertHistoryCardMarkup(a){
  const sev = String(a?.severity || 'WATCH').toLowerCase();
  const result = String(a?.result || (a?.raceSettled ? 'settled' : a?.status || '') || '').trim();
  const winner = String(a?.winner || '').trim();
  const position = a?.position != null ? `Pos ${a.position}` : '';
  const resultBits = [result, position, winner ? `Winner ${winner}` : ''].filter(Boolean);
  const movePctNum = Number(a?.movePct);
  const movePct = Number.isFinite(movePctNum) ? `${movePctNum > 0 ? '+' : ''}${movePctNum.toFixed(1)}%` : '—';
  const jumpText = Number.isFinite(Number(a?.minsToJump)) ? `${Number(a.minsToJump)}m` : '—';
  return `<div class='generic-alert-history-card ${sev}'>
    <div class='generic-alert-history-top'>
      <div>
        <div class='generic-alert-history-title'>${escapeHtml(String(a?.meeting || '—'))} R${escapeHtml(String(a?.race || ''))} · ${escapeHtml(String(a?.selection || '—'))}</div>
        <div class='generic-alert-history-meta'>${escapeHtml(alertTypeTag(a?.type))} · ${escapeHtml(String(a?.country || '—'))} · ${escapeHtml(formatAlertRelativeTime(a?.ts))}</div>
      </div>
      <span class='alert-badge ${sev}'>${escapeHtml(String(a?.severity || 'WATCH'))}</span>
    </div>
    <div class='generic-alert-history-grid'>
      <div><span>Move</span><strong>${escapeHtml(String(a?.fromOdds ?? '—'))} → ${escapeHtml(String(a?.toOdds ?? '—'))}</strong><em>${escapeHtml(movePct)}</em></div>
      <div><span>Jump</span><strong>${escapeHtml(jumpText)}</strong><em>${escapeHtml(String(a?.status || '—'))}</em></div>
      <div><span>Outcome</span><strong>${escapeHtml(resultBits.join(' · ') || 'Pending')}</strong><em>${escapeHtml(String(a?.action || 'Watch'))}</em></div>
    </div>
    ${a?.interpretation ? `<div class='generic-alert-history-note'>${escapeHtml(String(a.interpretation))}</div>` : ''}
  </div>`;
}

function buildAlertCardMarkup(a, options = {}){
  const sev = String(a?.severity || 'WATCH').toLowerCase();
  const title = escapeHtml(String(a?.title || `${a?.meeting || '—'} R${a?.race || ''}`));
  const runner = escapeHtml(String(a?.selection || '—'));
  const roleBase = String(a?.betmanRole || 'market');
  const role = escapeHtml(a?.trackedRunner ? `tracked · ${roleBase}` : roleBase);
  const interpretation = escapeHtml(String(a?.interpretation || (options.generic ? 'Market signal detected' : 'Pulse signal detected')));
  const action = escapeHtml(String(a?.action || 'Watch'));
  const note = escapeHtml(String(a?.note || ''));
  const signalNote = escapeHtml(String(a?.signalNote || a?.signal_note || ''));
  const moveText = `${escapeHtml(String(a?.fromOdds ?? '—'))} → ${escapeHtml(String(a?.toOdds ?? '—'))}`;
  const movePctNum = Number(a?.movePct);
  const movePct = Number.isFinite(movePctNum) ? `${movePctNum}%` : '—';
  const minsNum = Number(a?.minsToJump);
  const mins = Number.isFinite(minsNum) ? `${minsNum}m` : '—';
  const timeMeta = a?.ts ? formatAlertRelativeTime(a.ts) : '';
  const signalImg = alertTypeImage(a?.type);
  const typeLower = String(a?.type || '').toLowerCase();
  const directionClass = typeLower === 'hot_plunge' ? 'comp-green' : (typeLower === 'hot_drift' ? 'comp-red' : '');
  return `<div class='alert-card ${sev} ${directionClass} ${options.generic ? 'generic-alert-card' : ''} alert-row' data-meeting='${escapeAttr(String(a?.meeting || ''))}' data-race='${escapeAttr(String(a?.race || ''))}' style='cursor:pointer'>
    <div class='alert-card-hero'>
      ${signalImg ? `<img class='alert-signal-img' src='${signalImg}' alt='${escapeHtml(alertTypeTag(a?.type))}' />` : `<div class='alert-signal-img'></div>`}
      <div>
        <div class='alert-card-top'>
          <div>
            <div class='alert-card-title'>${title}</div>
            <div class='alert-card-sub'>${escapeHtml(String(a?.country || '—'))} • ${escapeHtml(String(a?.meeting || '—'))} R${escapeHtml(String(a?.race || ''))} • ${escapeHtml(alertTypeTag(a?.type))}${timeMeta ? ` • ${escapeHtml(timeMeta)}` : ''}</div>
          </div>
          <span class='alert-badge ${sev}'>${escapeHtml(String(a?.severity || 'WATCH'))}</span>
        </div>
        <div class='alert-card-msg'><b>${runner}</b> — ${escapeHtml(String(a?.message || interpretation))}</div>
      </div>
    </div>
    <div class='alert-card-grid'>
      <div><div class='k'>Role</div><div class='v'>${role}</div></div>
      <div><div class='k'>Move</div><div class='v'>${moveText}<div class='sub'>${escapeHtml(movePct)}</div></div></div>
      <div><div class='k'>Jump</div><div class='v'>${escapeHtml(mins)}</div></div>
    </div>
    <div class='alert-card-action'>
      <div>
        <div class='label'>Interpretation</div>
        <div class='value'>${interpretation}</div>
      </div>
      <div style='text-align:right'>
        <div class='label'>Action</div>
        <div class='value'>${action}</div>
      </div>
    </div>
    ${signalNote ? `<div class='alert-card-action'><div><div class='label'>Signal Note</div><div class='value'>${signalNote}</div></div></div>` : ''}
    ${note ? `<div class='alert-card-action'><div><div class='label'>Note</div><div class='value'>${note}</div></div></div>` : ''}
  </div>`;
}

function bindAlertCardClicks(root){
  root?.querySelectorAll('.alert-row').forEach(node => {
    node.addEventListener('click', async () => {
      const meeting = node.getAttribute('data-meeting') || '';
      const raceNum = node.getAttribute('data-race') || '';
      const race = await findRaceForButton(meeting, raceNum);
      if (!race) return;
      setActivePage('workspace');
      await selectRace(race.key, race.meeting, race.race_number);
    });
  });
}

async function renderGenericAlertsShell(){
  const live = $('genericAlertsLiveTable');
  const hist = $('genericAlertsHistoryTable');
  if (!live && !hist) return;
  const [feed, history, trackedRows] = await Promise.all([
    fetchLocal('./api/v1/alerts-feed', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ alerts: [] })),
    fetchLocal('./api/v1/alerts-history', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ alerts: [] })),
    loadTrackedBetsCache(true).catch(() => [])
  ]);
  const liveRows = Array.isArray(feed?.alerts) ? feed.alerts : [];
  const historyRowsRaw = Array.isArray(history?.alerts) ? history.alerts : (Array.isArray(history) ? history : []);
  const activeTrackedKeys = new Set((trackedRows || [])
    .filter(row => String(row?.status || '').trim().toLowerCase() !== 'settled')
    .map(buildAlertIdentityKey)
    .filter(Boolean));
  const combined = liveRows.concat(historyRowsRaw);
  hydrateGenericAlertsSelect('genericAlertsCountryFilter', combined.map(a => a?.country), 'All countries');
  hydrateGenericAlertsSelect('genericAlertsMeetingFilter', combined.map(a => a?.meeting), 'All meetings');
  hydrateGenericAlertsSelect('genericAlertsTypeFilter', combined.map(a => alertTypeTag(a?.type)), 'All alert types');
  const countryFilter = String($('genericAlertsCountryFilter')?.value || 'all');
  const meetingFilter = String($('genericAlertsMeetingFilter')?.value || 'all');
  const severityFilter = String($('genericAlertsSeverityFilter')?.value || 'all');
  const typeFilter = String($('genericAlertsTypeFilter')?.value || 'all');
  const search = String($('genericAlertsSearch')?.value || '').trim().toLowerCase();
  const matchesGenericFilter = (a) => {
    const haystack = [a?.selection, a?.meeting, a?.country, a?.message, a?.interpretation, a?.note, a?.signalNote, a?.signal_note, a?.title, alertTypeTag(a?.type)]
      .map(v => String(v || '').toLowerCase())
      .join(' | ');
    if (countryFilter !== 'all' && String(a?.country || '') !== countryFilter) return false;
    if (meetingFilter !== 'all' && String(a?.meeting || '') !== meetingFilter) return false;
    if (severityFilter !== 'all' && String(a?.severity || '') !== severityFilter) return false;
    if (typeFilter !== 'all' && alertTypeTag(a?.type) !== typeFilter) return false;
    if (search && !haystack.includes(search)) return false;
    return true;
  };
  const alerts = liveRows.filter(matchesGenericFilter).sort((a, b) => genericAlertSortValue(b) - genericAlertSortValue(a));
  const historyRows = historyRowsRaw
    .filter(a => alertRowBelongsInHistory(a, activeTrackedKeys))
    .filter(matchesGenericFilter)
    .sort((a, b) => String(b?.ts || '').localeCompare(String(a?.ts || '')));
  const actionCount = alerts.filter(a => String(a?.severity || '') === 'ACTION').length;
  const hotCount = alerts.filter(a => ['HOT', 'CRITICAL', 'ACTION'].includes(String(a?.severity || ''))).length;
  $('genericAlertsActionCount') && ($('genericAlertsActionCount').textContent = String(actionCount));
  $('genericAlertsHotCount') && ($('genericAlertsHotCount').textContent = String(hotCount));
  $('genericAlertsLiveCount') && ($('genericAlertsLiveCount').textContent = String(alerts.length));
  $('genericAlertsHistoryCount') && ($('genericAlertsHistoryCount').textContent = String(historyRows.length));
  $('genericAlertsLiveLabel') && ($('genericAlertsLiveLabel').textContent = alerts.length === 1 ? 'alert in feed' : 'alerts in feed');
  $('genericAlertsHistoryLabel') && ($('genericAlertsHistoryLabel').textContent = historyRows.length === 1 ? 'history match' : 'history matches');
  $('genericAlertsFilterSummary') && ($('genericAlertsFilterSummary').textContent = buildGenericAlertsFilterSummary({ alerts, historyRows, countryFilter, meetingFilter, severityFilter, typeFilter, search }));
  if (live) {
    live.innerHTML = alerts.length
      ? `<div class='alert-cards'>${alerts.map(a => buildAlertCardMarkup(a, { generic: true })).join('')}</div>`
      : `<div class='row'><div style='grid-column:1/-1'><div style='font-weight:700;color:#d9e4ef;margin-bottom:4px'>No live alerts match the current filters</div><div class='sub'>Clear filters or refresh to scan the broader engine feed.</div></div></div>`;
    bindAlertCardClicks(live);
  }
  if (hist) {
    hist.innerHTML = historyRows.length
      ? `<div class='generic-alert-history-list'>${historyRows.slice(0, 80).map(a => buildGenericAlertHistoryCardMarkup(a)).join('')}</div>`
      : `<div class='row'><div style='grid-column:1/-1'>No alert history yet</div></div>`;
  }
}

async function renderAlertsShell(){
  const live = $('pulseLiveTable') || $('alertsLiveTable');
  const hist = $('pulseHistoryTable') || $('alertsHistoryTable');
  const cfg = $('pulseConfigPanel') || $('alertsConfigPanel');
  try {
    await loadPulseConfig();
  } catch {}
  const [feed, history, trackedRows] = await Promise.all([
    fetchLocal('./api/v1/alerts-feed', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ alerts: [] })),
    fetchLocal('./api/v1/alerts-history', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ alerts: [] })),
    loadTrackedBetsCache(true).catch(() => [])
  ]);
  const activeTrackedKeys = new Set((trackedRows || [])
    .filter(row => String(row?.status || '').trim().toLowerCase() !== 'settled')
    .map(buildAlertIdentityKey)
    .filter(Boolean));
  const allAlerts = filterPulseAlerts(Array.isArray(feed?.alerts) ? feed.alerts : []);
  const [countryFilter, meetingFilter] = await Promise.all([
    hydrateAlertsCountryFilter(allAlerts),
    hydrateAlertsMeetingFilter(allAlerts)
  ]);
  const alerts = allAlerts.filter(a => (countryFilter === 'all' ? true : String(a?.country || '') === countryFilter) && (meetingFilter === 'all' ? true : String(a?.meeting || '') === meetingFilter));
  const critical = alerts.filter(a => String(a?.severity || '') === 'CRITICAL').length;
  const hot = alerts.filter(a => String(a?.severity || '') === 'HOT').length;
  $('pulseHotCount') && ($('pulseHotCount').textContent = String(hot));
  $('pulseCriticalCount') && ($('pulseCriticalCount').textContent = String(critical));
  $('pulseLiveCount') && ($('pulseLiveCount').textContent = String(alerts.length));
  $('alertsHotCount') && ($('alertsHotCount').textContent = String(hot));
  $('alertsCriticalCount') && ($('alertsCriticalCount').textContent = String(critical));
  $('alertsLiveCount') && ($('alertsLiveCount').textContent = String(alerts.length));
  if (live) {
    live.innerHTML = alerts.length
      ? `<div class='alert-cards'>${alerts.map(a => buildAlertCardMarkup(a)).join('')}</div>`
      : `<div class='pulse-empty-state'><div class='pulse-empty-title'>No live Pulse right now</div><div class='sub'>When a premium signal clears the bar, it will land here.</div></div>`;
    bindAlertCardClicks(live);
  }
  if (hist) {
    const historyRows = filterPulseAlerts(Array.isArray(history?.alerts) ? history.alerts : (Array.isArray(history) ? history : []))
      .filter(a => alertRowBelongsInHistory(a, activeTrackedKeys))
      .filter(a => (countryFilter === 'all' ? true : String(a?.country || '') === countryFilter) && (meetingFilter === 'all' ? true : String(a?.meeting || '') === meetingFilter));
    hist.innerHTML = historyRows.length
      ? `<div class='pulse-history-list'>${historyRows.slice(0, 50).map(a => buildPulseHistoryCardMarkup(a)).join('')}</div>`
      : `<div class='pulse-empty-state'><div class='pulse-empty-title'>No Pulse history yet</div><div class='sub'>Once the premium feed starts firing, the recent trail will appear here.</div></div>`;
  }
  if (cfg) renderPulseConfigPanel();
}

function setActivePage(page){
  const pagesAllowedWithoutMeeting = new Set(['workspace', 'help', 'autobet', 'tracked', 'heatmap', 'suggested', 'interesting']);
  if (page === 'pulse' && !pulseEligible) page = 'alerts';
  if ((page === 'bakeoff' || page === 'performance' || page === 'performance-ledger') && !isAdminUser) page = 'workspace';
  if (!pagesAllowedWithoutMeeting.has(page) && selectedMeeting === 'ALL') {
    if ((page !== 'performance' && page !== 'performance-ledger') || !isAdminUser) page = 'workspace';
  }
  activePage = page;
  try {
    const u = new URL(window.location.href);
    if (page && page !== 'workspace') u.searchParams.set('page', page);
    else u.searchParams.delete('page');
    history.replaceState(null, '', u.toString());
  } catch (_) {}
  document.querySelectorAll('.page-tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  document.querySelectorAll('.page-section').forEach(sec=>{
    sec.style.display = sec.dataset.page === page ? '' : 'none';
  });
  refreshTabAccess();
  renderMeetingIntelPanel();
  if (page === 'performance') {
    setActivePerformanceTab('overview');
    loadPerformance();
    loadRuntimeHealth();
  }
  if (page === 'performance-ledger') {
    loadPerformance();
  }
  if (page === 'workspace') {
    renderWorkspaceSignalPanels();
  }
  if (page === 'alerts') {
    renderGenericAlertsShell();
  }
  if (page === 'pulse') {
    setActivePulseTab('live');
    renderAlertsShell();
  }
  if (page === 'tracked') {
    setActiveTrackedTab(trackedTab || 'active');
    renderTrackedShell();
  }
  if (page === 'autobet') {
    loadPerformance();
  }
  if (page === 'bakeoff') {
    loadBakeoffLeaderboard();
    restoreBakeoffRunFeedback();
  }
}

function openSummaryPopup(title, html){
  const modal = $('summaryModal');
  if (!modal) return;
  $('summaryModalTitle').textContent = title || 'Bet Summary';
  $('summaryModalBody').innerHTML = html || '';
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeSummaryPopup(){
  const modal = $('summaryModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function statusMeetingsFromData(data){
  const out = new Set();
  (data?.suggestedBets || []).forEach(x => x?.meeting && out.add(String(x.meeting).trim()));
  (data?.interestingRunners || []).forEach(x => x?.meeting && out.add(String(x.meeting).trim()));
  (data?.marketMovers || []).forEach(x => x?.meeting && out.add(String(x.meeting).trim()));
  return [...out];
}

function currentStatusMeetings(){
  const out = new Set();
  (latestSuggestedBets || []).forEach(x => x?.meeting && out.add(String(x.meeting).trim()));
  (latestInterestingRows || []).forEach(x => x?.meeting && out.add(String(x.meeting).trim()));
  (latestMarketMovers || []).forEach(x => x?.meeting && out.add(String(x.meeting).trim()));
  if (selectedMeeting && selectedMeeting !== 'ALL') out.add(String(selectedMeeting).trim());
  return [...out];
}

async function hydrateRaceWithLoveracing(race){
  if (!race || !race.meeting) return;
  const raceKey = race.key || `${String(race.country||'').toLowerCase()}|${String(race.meeting||'').toLowerCase()}|${race.race_number || race.race || ''}`;
  if (!raceKey) return;
  if (race.loveracing) return;
  if (loveracingRaceCache.has(raceKey)) {
    const cached = loveracingRaceCache.get(raceKey);
    if (cached) race.loveracing = cached;
    return;
  }
  const countryCode = String(race.country || '').trim().toUpperCase();
  if (countryCode && countryCode !== 'NZ') {
    loveracingRaceCache.set(raceKey, null);
    return;
  }
  const slug = slugifyMeetingName(race.meeting);
  if (!slug) {
    loveracingRaceCache.set(raceKey, null);
    return;
  }
  const raceNo = String(race.race_number || race.race || '').padStart(2, '0');
  let folders = ['today'];
  if (selectedDay === 'tomorrow') {
    if (loveracingTomorrowAvailable === null) {
      try {
        const res = await fetchLocal('./data/loveracing/tomorrow/manifest.json', { cache: 'no-store' });
        if (res.ok) {
          const payload = await res.json().catch(() => ({}));
          loveracingTomorrowAvailable = payload?.available !== false;
        } else {
          loveracingTomorrowAvailable = false;
        }
      } catch {
        loveracingTomorrowAvailable = false;
      }
    }
    folders = loveracingTomorrowAvailable ? ['tomorrow','today'] : ['today'];
  }
  for (const folder of folders) {
    const url = `./data/loveracing/${folder}/${slug}/R${raceNo}.json`;
    try {
      const res = await fetchLocal(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const payload = await res.json();
      if (payload?.race) {
        const lr = {
          available: true,
          race_commentary: payload.race.comment || '',
          weather: payload.race.weather || null,
          track_condition: payload.race.track_condition || null,
          rail_position: payload.race.rail_position || null
        };
        race.loveracing = lr;
        loveracingRaceCache.set(raceKey, lr);
        return;
      }
    } catch (err) {
      console.warn('loveracing_fetch_failed', url, err?.message || err);
    }
  }
  loveracingRaceCache.set(raceKey, null);
}

async function loadStatus(){
  const meta = $('refreshMeta');
  try{
    const hasWarmData = ['suggestedTable','nextPlannedTable','multisTable','interestingTable','moversTable']
      .some(id => {
        const el = $(id);
        if (!el) return false;
        const txt = String(el.textContent || '').trim().toLowerCase();
        return txt && !txt.includes('loading');
      });

    if (!hasWarmData) {
      setTableLoading('suggestedTable', 'Loading suggested signals…');
      setTableLoading('nextPlannedTable', 'Loading next suggested signals…');
      setTableLoading('multisTable', 'Loading multis…');
      setTableLoading('interestingTable', 'Loading interesting runners…');
      setTableLoading('moversTable', 'Loading market movers…');
    }
    if (meta) meta.textContent = hasWarmData ? 'Refreshing (showing last snapshot)…' : 'Refreshing…';
    let data = null;
    let apiLiveOk = false;
    try {
      const apiRes = await fetchLocal('./api/status', { cache: 'no-store' });
      if (apiRes.ok) {
        data = await apiRes.json();
        apiLiveOk = true;
      }
    } catch (err) {
      console.warn('status_api_failed', err?.message || err);
    }
    if (!data) {
      const res = await fetchLocal('./data/status.json', { cache: 'no-store' });
      data = await res.json();
    }

    // sync UI state from status snapshot (persisted from stake.json)
    stakePerRace = (typeof data.stakePerRace === 'number') ? data.stakePerRace : (stakePerRace || 10);
    exoticStakePerRace = (typeof data.exoticStakePerRace === 'number') ? data.exoticStakePerRace : exoticStakePerRace;
    earlyWindowMin = (typeof data.earlyWindowMin === 'number') ? data.earlyWindowMin : earlyWindowMin;
    aiWindowMin = (typeof data.aiWindowMin === 'number') ? data.aiWindowMin : aiWindowMin;
    localStorage.setItem('stakePerRace', String(stakePerRace));
    localStorage.setItem('exoticStakePerRace', String(exoticStakePerRace));
    localStorage.setItem('earlyWindowMin', String(earlyWindowMin));
    localStorage.setItem('aiWindowMin', String(aiWindowMin));

    refreshBetWindowUi();
    $('aiWindowMin') && ($('aiWindowMin').textContent = `AI Bets to Place window: ${aiWindowMin}m`);
    $('lastUpdated').textContent = `Last update ${new Date(data.updatedAt).toLocaleString()} · build ${BETMAN_BUILD}`;
    const setPill = (id, label, value) => {
      const el = $(id);
      if (!el) return;
      const ok = String(value || '').toUpperCase() === 'OK';
      el.textContent = `${label} ${ok ? 'OK' : 'FAIL'}`;
      el.style.color = ok ? '#c5ff00' : '#ff8a8a';
      el.style.borderColor = ok ? 'rgba(102,245,161,.35)' : 'rgba(255,107,107,.35)';
    };
    setPill('apiStatusPublic', 'API Status', apiLiveOk ? 'OK' : (data.apiStatusPublic || data.apiStatus));

    latestSuggestedBets = (data.suggestedBets || []).map(sanitizeSuggestedRow);
    latestAiCompare = data.aiBetComparison || [];
    latestInterestingRows = (data.interestingRunners || []).map(sanitizeSuggestedRow);
    latestMarketMovers = (data.marketMovers || []).map(sanitizeSuggestedRow);
    latestMarketOddsHistory = data.marketOddsHistory || {};
    latestMarketOddsSnapshot = data.marketOddsSnapshot || {};
    latestDataVersion += 1;
    applyDerivedMovers();

    // Keep meeting selector aligned to loaded races + any meetings referenced in status datasets.
    const statusMeetings = statusMeetingsFromData(data);
    if (selectedMeeting && selectedMeeting !== 'ALL' && !statusMeetings.includes(selectedMeeting)) {
      statusMeetings.push(selectedMeeting);
    }
    const extraMeetings = (selectedCountry === 'ALL') ? statusMeetings : [];
    refreshMeetingOptions(racesCache || [], extraMeetings, lastRacesSnapshot || racesCache || []);
    renderMeetingList(racesCache || []); // refresh pill tags after latest* datasets update

    const filteredSuggested = filterSuggestedByWhy(latestSuggestedBets);
    latestFilteredSuggested = filteredSuggested;
    renderInteresting(latestInterestingRows);
    renderMarketMovers(latestMarketMovers);
    renderSuggested(filteredSuggested);
    renderWorkspaceSignalPanels();
    renderMultis(filteredSuggested);
    renderNextPlanned(filteredSuggested);
    renderRaces(racesCache);
    latestUpcomingBets = data.upcomingBets || [];
    renderBets(latestUpcomingBets);
    renderAutobetFeed(latestUpcomingBets);
    renderAiCompare(latestAiCompare);
    renderCompleted(data.completedBets || []);
    renderActivity(data.activity || []);
    refreshSelectedRaceAnalysis();
  }catch(e){
    console.error(e);
  } finally {
    if (meta && String(meta.textContent || '').includes('Refreshing')) {
      meta.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }
  }
}

function fmtDate(d){
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

let selectedDay = 'today';
let selectedCountry = 'NZ';
let selectedMeeting = 'ALL';
let selectedWhy = 'ALL';
const displayWhy = (why) => why === 'VALUE' ? 'ODDS' : String(why || 'ALL');
let lastRacesSnapshot = [];
let lastRacesMeta = { dateStr: null, fetchedAt: null };
let racesCacheWarning = '';
const MEETING_LOCK_KEY = 'betmanMeetingLock';
const RACE_CACHE_STORAGE_KEY = 'betmanRaceCache.v2';
const LAST_RACE_STORAGE_KEY = 'betmanLastRaceSelection';

function currentSelectedDateStr(){
  const base = new Date();
  if (selectedDay === 'tomorrow') base.setDate(base.getDate()+1);
  return fmtDate(base);
}

function persistRacesToLocalCache(dateStr, races){
  if (!dateStr || !Array.isArray(races) || !races.length) return;
  try {
    const existing = JSON.parse(localStorage.getItem(RACE_CACHE_STORAGE_KEY) || '{}');
    existing[dateStr] = { date: dateStr, savedAt: Date.now(), races };
    const keys = Object.keys(existing).sort();
    while (keys.length > 3) {
      const oldest = keys.shift();
      delete existing[oldest];
    }
    localStorage.setItem(RACE_CACHE_STORAGE_KEY, JSON.stringify(existing));
  } catch (err) {
    console.warn('race_cache_local_save_failed', err?.message || err);
    try {
      const existing = JSON.parse(localStorage.getItem(RACE_CACHE_STORAGE_KEY) || '{}');
      const keys = Object.keys(existing).sort();
      while (keys.length) {
        const oldest = keys.shift();
        delete existing[oldest];
        try {
          localStorage.setItem(RACE_CACHE_STORAGE_KEY, JSON.stringify(existing));
          console.warn('race_cache_local_pruned', oldest);
          return;
        } catch {
          continue;
        }
      }
    } catch {}
  }
}

function hydrateRacesFromLocalCache(dateStr){
  if (!dateStr) return null;
  try {
    const existing = JSON.parse(localStorage.getItem(RACE_CACHE_STORAGE_KEY) || '{}');
    const entry = existing?.[dateStr];
    if (!entry || !Array.isArray(entry.races) || !entry.races.length) return null;
    lastRacesSnapshot = entry.races.slice();
    lastRacesMeta = { dateStr: entry.date || dateStr, fetchedAt: entry.savedAt || null };
    racesCacheWarning = `Showing cached races from local storage — snapshot ${entry.savedAt ? new Date(entry.savedAt).toLocaleTimeString() : 'recent'}`;
    applyScopedRaces(lastRacesSnapshot);
    return entry;
  } catch (err) {
    console.warn('race_cache_local_load_failed', err?.message || err);
    return null;
  }
}

function persistLastRaceSelection(race){
  if (!race) return;
  const payload = {
    key: race.key || buildRaceCacheKey(race.meeting, race.race_number),
    meeting: race.meeting,
    race: race.race_number,
    day: selectedDay,
    country: selectedCountry,
    dateStr: lastRacesMeta?.dateStr || currentSelectedDateStr()
  };
  try { localStorage.setItem(LAST_RACE_STORAGE_KEY, JSON.stringify(payload)); } catch {}
}

let lastRaceRestorePending = true;
async function restoreLastRaceSelection(){
  if (!lastRaceRestorePending) return;
  lastRaceRestorePending = false;
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_RACE_STORAGE_KEY) || '{}');
    if (!saved || !saved.key) return;
    if (saved.day && saved.day !== selectedDay) return;
    if (saved.country && normalizeUiCountry(saved.country, selectedCountry) !== selectedCountry) return;
    const race = (racesCache || []).find(r => {
      if (r.key && r.key === saved.key) return true;
      const meets = String(r.meeting || '').trim().toLowerCase() === String(saved.meeting || '').trim().toLowerCase();
      const num = String(r.race_number || '') === String(saved.race || '');
      return meets && num;
    });
    if (race) await selectRace(race.key, race.meeting, race.race_number);
  } catch (err) {
    console.warn('last_race_restore_failed', err?.message || err);
  }
}
const aiWinnerState = new Map();
const aiRaceRuns = new Set();
const aiAnalysisCache = new Map();
const aiAnalysisCooldown = new Map();
const AI_ANALYSE_CACHE_TTL_MS = 5 * 60 * 1000;
const AI_ANALYSE_COOLDOWN_MS = 3 * 60 * 1000;
const AI_ANALYSIS_PROGRESS_STAGES = [
  'Gathering data…',
  'Running 999,999 simulations…',
  'Preparing results…'
];
const loveracingRaceCache = new Map();
let loveracingTomorrowAvailable = null;
let analysisProcessingStageTimer = null;
let analysisProcessingStageIndex = 0;

function hydrateAiAnalysisCacheFromStorage(){
  let changed = false;
  try {
    const stored = JSON.parse(localStorage.getItem('betmanAiAnalysisCache') || '[]');
    if (!Array.isArray(stored)) return;
    const now = Date.now();
    stored.forEach(entry => {
      if (!entry || typeof entry !== 'object') { changed = true; return; }
      const { key, answerHtml, modelName, timestamp, durationMs } = entry;
      if (!key || !answerHtml || !Number.isFinite(Number(timestamp))) { changed = true; return; }
      if ((now - Number(timestamp)) > AI_ANALYSE_CACHE_TTL_MS) { changed = true; return; }
      aiAnalysisCache.set(key, {
        answerHtml,
        modelName,
        timestamp: Number(timestamp),
        durationMs
      });
    });
    if (changed) persistAiAnalysisCache();
  } catch (err) {
    console.warn('ai_analysis_cache_hydrate_failed', err?.message || err);
  }
}

function persistAiAnalysisCache(){
  try {
    const rows = Array.from(aiAnalysisCache.entries()).map(([key, value]) => ({
      key,
      answerHtml: value?.answerHtml,
      modelName: value?.modelName,
      timestamp: value?.timestamp,
      durationMs: value?.durationMs
    }));
    localStorage.setItem('betmanAiAnalysisCache', JSON.stringify(rows));
  } catch (err) {
    console.warn('ai_analysis_cache_save_failed', err?.message || err);
  }
}

function persistAiCooldown(){
  try {
    const rows = Array.from(aiAnalysisCooldown.entries()).map(([key, until]) => ({ key, until }));
    localStorage.setItem('betmanAiCooldown', JSON.stringify(rows));
  } catch (err) {
    console.warn('ai_cooldown_save_failed', err?.message || err);
  }
}

function hydrateAiCooldownFromStorage(){
  try {
    const rows = JSON.parse(localStorage.getItem('betmanAiCooldown') || '[]');
    if (!Array.isArray(rows)) return;
    const now = Date.now();
    rows.forEach(row => {
      const key = String(row?.key || '').trim();
      const until = Number(row?.until || 0);
      if (!key || !Number.isFinite(until) || until <= now) return;
      aiAnalysisCooldown.set(key, until);
    });
  } catch (err) {
    console.warn('ai_cooldown_hydrate_failed', err?.message || err);
  }
}

hydrateAiAnalysisCacheFromStorage();
hydrateAiCooldownFromStorage();
(function restoreMeetingLock(){
  try {
    const saved = JSON.parse(localStorage.getItem(MEETING_LOCK_KEY) || '{}');
    if (saved && typeof saved === 'object') {
      if (saved.day && ['today','tomorrow'].includes(saved.day)) selectedDay = saved.day;
      selectedCountry = normalizeUiCountry(saved.country, selectedCountry);
      if (saved.meeting) selectedMeeting = saved.meeting;
    }
    const cs = $('countrySelect');
    if (cs) cs.value = selectedCountry;
    document.querySelectorAll('.pill[data-day]').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.day === selectedDay);
    });
  } catch {}
})();
(function hydrateRaceCacheOnBoot(){
  const cached = hydrateRacesFromLocalCache(currentSelectedDateStr());
  if (cached) {
    renderRaces(racesCache);
  }
})();
function persistMeetingLock(){
  try {
    localStorage.setItem(MEETING_LOCK_KEY, JSON.stringify({ day: selectedDay, country: selectedCountry, meeting: selectedMeeting }));
  } catch {}
}

async function loadStake(){
  // local fallback first
  const localStake = parseFloat(localStorage.getItem('stakePerRace') || '');
  const localExotic = parseFloat(localStorage.getItem('exoticStakePerRace') || '');
  const localWindow = parseFloat(localStorage.getItem('earlyWindowMin') || '');
  const localAiWindow = parseFloat(localStorage.getItem('aiWindowMin') || '');
  if (!Number.isNaN(localStake) && localStake > 0) {
    stakePerRace = localStake;
  }
  if (!Number.isNaN(localExotic) && localExotic >= 0) {
    exoticStakePerRace = localExotic;
  }
  if (!Number.isNaN(localWindow) && localWindow >= 1) {
    earlyWindowMin = localWindow;
    refreshBetWindowUi();
  }
  if (!Number.isNaN(localAiWindow) && localAiWindow >= 1) {
    aiWindowMin = localAiWindow;
    $('aiWindowMin') && ($('aiWindowMin').textContent = `AI Bets to Place window: ${aiWindowMin}m`);
  }

  try {
    const res = await fetchLocal('./data/stake.json', { cache: 'no-store' });
    const data = await res.json();
    stakePerRace = data.stakePerRace || stakePerRace || 10;
    exoticStakePerRace = (typeof data.exoticStakePerRace === 'number') ? data.exoticStakePerRace : (exoticStakePerRace ?? 1);
    earlyWindowMin = (typeof data.earlyWindowMin === 'number') ? data.earlyWindowMin : (earlyWindowMin ?? 180);
    aiWindowMin = (typeof data.aiWindowMin === 'number') ? data.aiWindowMin : (aiWindowMin ?? 10);
    localStorage.setItem('stakePerRace', String(stakePerRace));
    localStorage.setItem('exoticStakePerRace', String(exoticStakePerRace));
    localStorage.setItem('earlyWindowMin', String(earlyWindowMin));
    localStorage.setItem('aiWindowMin', String(aiWindowMin));
    refreshBetWindowUi();
    $('aiWindowMin') && ($('aiWindowMin').textContent = `AI Bets to Place window: ${aiWindowMin}m`);
  } catch {}
}

const CLIENT_FINISHED_RACE_STATUSES = new Set(['final', 'closed', 'finalized', 'abandoned', 'resulted', 'settled', 'complete', 'completed']);
const CLIENT_ACTIVE_RACE_STATUSES = new Set(['open', 'jumped', 'running', 'inrunning', 'in-running', 'live']);

function raceIsUpcoming(race, cutoffMs = Date.now() - 5 * 60 * 1000){
  if (!race) return false;
  const status = String(race?.race_status || '').trim().toLowerCase();
  if (CLIENT_FINISHED_RACE_STATUSES.has(status)) return false;
  if (CLIENT_ACTIVE_RACE_STATUSES.has(status)) return true;
  const rawTs = race?.advertised_start ?? race?.start_time_nz ?? race?.start_time_iso ?? race?.start_time;
  const ts = parseTimeValue(rawTs);
  if (!Number.isFinite(ts)) return true;
  return ts >= cutoffMs;
}

function refreshMeetingOptions(allRows, extraMeetings=[], fullRows=null){
  const sel = $('meetingSelect');
  if (!sel) return;
  const cutoff = Date.now() - 5 * 60 * 1000;
  const meetingMap = new Map();
  const addUpcomingMeetings = (rows) => {
    (rows || []).forEach(r => {
      const label = String(r.meeting || '').trim();
      const norm = normalizeMeetingKey(label);
      if (!norm || meetingMap.has(norm)) return;
      if (raceIsUpcoming(r, cutoff)) meetingMap.set(norm, label);
    });
  };
  addUpcomingMeetings(allRows);
  const lookupRows = fullRows || allRows;
  const hasUpcomingInAny = (label) => {
    const norm = normalizeMeetingKey(label);
    if (!norm) return false;
    if (meetingMap.has(norm)) return true;
    if (!lookupRows || !lookupRows.length) return false;
    return lookupRows.some(r => normalizeMeetingKey(r.meeting) === norm && raceIsUpcoming(r, cutoff));
  };
  (extraMeetings || []).forEach(raw => {
    const label = String(raw || '').trim();
    const norm = normalizeMeetingKey(label);
    if (!norm || meetingMap.has(norm)) return;
    if (hasUpcomingInAny(label)) meetingMap.set(norm, label);
  });
  const meetings = Array.from(meetingMap.values()).sort((a,b) => a.localeCompare(b));
  const currentNorm = normalizeMeetingKey(selectedMeeting);
  const hasSelected = selectedMeeting && selectedMeeting !== 'ALL' && meetingMap.has(currentNorm);
  if (!hasSelected && selectedMeeting && selectedMeeting !== 'ALL') {
    selectedMeeting = 'ALL';
    persistMeetingLock();
  }
  const opts = [`<option value="ALL">All Meetings</option>`, ...meetings.map(m => `<option value="${m}">${m}</option>`)];
  sel.innerHTML = opts.join('');
  if (selectedMeeting && selectedMeeting !== 'ALL' && meetings.length) {
    const match = meetings.find(m => normalizeMeetingKey(m) === normalizeMeetingKey(selectedMeeting));
    if (match) {
      sel.value = match;
      return;
    }
  }
  sel.value = 'ALL';
}


function applyScopedRaces(allRaces){
  const cleanRaces = (allRaces || []).slice();
  const upcomingCutoff = Date.now() - 5 * 60 * 1000;
  let effectiveCountry = normalizeUiCountry(selectedCountry, 'NZ');
  const hasRowsFor = (cc) => cleanRaces.some(r => normalizeUiCountry(r.country, '') === cc);
  if (effectiveCountry !== 'ALL' && !hasRowsFor(effectiveCountry)) {
    const order = ['NZ', 'AUS', 'HK'];
    const next = order.find(c => hasRowsFor(c));
    if (next) effectiveCountry = next;
    if (effectiveCountry !== selectedCountry) {
      selectedCountry = effectiveCountry;
      const cs = $('countrySelect');
      if (cs) cs.value = effectiveCountry;
    }
  }

  const byCountry = cleanRaces.filter(r => effectiveCountry === 'ALL'
    ? true
    : normalizeUiCountry(r.country, '') === effectiveCountry);

  if (selectedMeeting !== 'ALL') {
    const meetingNorm = normalizeMeetingKey(selectedMeeting);
    const hasSelectedMeeting = byCountry.some(r => normalizeMeetingKey(r.meeting) === meetingNorm && raceIsUpcoming(r, upcomingCutoff));
    if (!hasSelectedMeeting) {
      const globalHit = cleanRaces.find(r => normalizeMeetingKey(r.meeting) === meetingNorm && raceIsUpcoming(r, upcomingCutoff));
      if (globalHit) {
        const targetCountry = normalizeUiCountry(globalHit.country, '');
        if (targetCountry && targetCountry !== effectiveCountry) {
          selectedCountry = targetCountry;
          const cs = $('countrySelect');
          if (cs) cs.value = targetCountry;
          persistMeetingLock();
          return applyScopedRaces(allRaces);
        }
      }
      selectedMeeting = 'ALL';
      persistMeetingLock();
      const meetingSel = $('meetingSelect');
      if (meetingSel) meetingSel.value = 'ALL';
    }
  }

  const statusExtras = currentStatusMeetings();
  refreshMeetingOptions(byCountry, statusExtras, cleanRaces);
  racesCache = byCountry;
  strategyRaceModelCache.clear();
  renderMeetingList(racesCache);
  return racesCache;
}

async function loadRaces(options = {}){
  const { allowDayFallback = true } = options;
  const scroller = $('racesScroller');
  if (scroller) scroller.innerHTML = `<div class='race-card'>Loading races…</div>`;
  const meetingList = $('meetingList');
  if (meetingList) meetingList.innerHTML = `<button class='pill active'>Loading meetings…</button>`;
  const dateStr = currentSelectedDateStr();
  try{
    let data = null;
    try {
      const res = await fetchLocal(`./api/races?date=${dateStr}&limit=5000`, { cache: 'no-store' });
      if (res.ok) data = await res.json();
      else console.warn('races_api_response', res.status);
    } catch (err) {
      console.error('races_api_fetch_failed', err);
    }

    if (!data || !Array.isArray(data.races) || !data.races.length) {
      const fallbackPaths = [`./data/races-${dateStr}.json`, './data/races.json'];
      for (const path of fallbackPaths) {
        try {
          const fallback = await fetchLocal(path, { cache: 'no-store' });
          if (!fallback.ok) continue;
          const fbData = await fallback.json();
          if (fbData && Array.isArray(fbData.races) && fbData.races.length) {
            data = fbData;
            console.warn('races_fallback_static_used', path);
            break;
          }
        } catch (err) {
          console.error('races_fallback_failed', path, err);
        }
      }
    }

    if (!data || !Array.isArray(data.races) || !data.races.length) throw new Error('races_data_missing');

    let cleanRaces = (data.races || []).map(sanitizeRaceObject);

    // Midnight rollover support: include recent active races from yesterday when viewing "today".
    if (selectedDay === 'today') {
      try {
        const prev = new Date(baseDate);
        prev.setDate(prev.getDate() - 1);
        const prevStr = fmtDate(prev);
        const rPrev = await fetchLocal(`./api/races?date=${prevStr}&limit=5000`, { cache: 'no-store' });
        if (rPrev.ok) {
          const prevData = await rPrev.json();
          const nowMs = Date.now();
          const yesterdayActive = (prevData.races || [])
            .map(sanitizeRaceObject)
            .filter(r => {
              const st = String(r.race_status || '').toLowerCase();
              if (['final','closed','abandoned','resulted'].includes(st)) return false;
              const t = parseTimeValue(r.advertised_start || r.start_time_nz);
              if (!Number.isFinite(t)) return true;
              // keep races started within last 8h (or upcoming) across midnight
              return t >= (nowMs - 8 * 60 * 60 * 1000);
            });
          if (yesterdayActive.length) {
            const seen = new Set(cleanRaces.map(r => String(r.key || `${r.country}|${r.meeting}|${r.race_number}`)));
            for (const r of yesterdayActive) {
              const k = String(r.key || `${r.country}|${r.meeting}|${r.race_number}`);
              if (!seen.has(k)) {
                cleanRaces.push(r);
                seen.add(k);
              }
            }
          }
        }
      } catch {}
    }

    lastRacesSnapshot = cleanRaces.slice();
    lastRacesMeta = {
      dateStr,
      fetchedAt: data.updatedAt || data.generatedAt || new Date().toISOString()
    };
    loadRunnerMetrics().catch(()=>{});
    seedOddsSnapshotFromRaces(cleanRaces);
    persistRacesToLocalCache(dateStr, cleanRaces);
    racesCacheWarning = '';
    const scoped = applyScopedRaces(cleanRaces);
    if ((!scoped || !scoped.length) && allowDayFallback && selectedDay === 'tomorrow') {
      selectedDay = 'today';
      persistMeetingLock();
      document.querySelectorAll('.pill[data-day]').forEach(btn=>{
        btn.classList.toggle('active', btn.dataset.day === selectedDay);
      });
      return loadRaces({ allowDayFallback: false });
    }
  }catch(e){
    console.error('loadRaces_failed', e);
    if (lastRacesSnapshot.length) {
      const ts = lastRacesMeta.fetchedAt
        ? new Date(lastRacesMeta.fetchedAt).toLocaleTimeString()
        : (lastRacesMeta.dateStr || 'previous snapshot');
      racesCacheWarning = `Showing cached races from ${ts} — ${e.message || e}`;
      const fallbackScoped = applyScopedRaces(lastRacesSnapshot);
      if ((!fallbackScoped || !fallbackScoped.length) && allowDayFallback && selectedDay === 'tomorrow') {
        selectedDay = 'today';
        persistMeetingLock();
        document.querySelectorAll('.pill[data-day]').forEach(btn=>{
          btn.classList.toggle('active', btn.dataset.day === selectedDay);
        });
        return loadRaces({ allowDayFallback: false });
      }
    } else {
      racesCache = [];
      racesCacheWarning = '';
      renderMeetingList(racesCache);
    }
  }
}

async function loadAllRacesUnfiltered(){
  const baseDate = new Date();
  if (selectedDay === 'tomorrow') baseDate.setDate(baseDate.getDate()+1);
  const dateStr = fmtDate(baseDate);
  try {
    const res = await fetchLocal(`./api/races?date=${dateStr}&limit=5000`, { cache: 'no-store' });
    let data = null;
    if (res.ok) data = await res.json();
    if (!data || !Array.isArray(data.races) || !data.races.length) {
      const fallbackPaths = [`./data/races-${dateStr}.json`, './data/races.json'];
      for (const path of fallbackPaths) {
        try {
          const fallback = await fetchLocal(path, { cache: 'no-store' });
          if (!fallback.ok) continue;
          const payload = await fallback.json();
          if (payload && Array.isArray(payload.races) && payload.races.length) {
            data = payload;
            break;
          }
        } catch {}
      }
    }
    let rows = (data?.races || []).map(sanitizeRaceObject);
    if (selectedDay === 'today') {
      try {
        const prev = new Date(baseDate);
        prev.setDate(prev.getDate() - 1);
        const prevStr = fmtDate(prev);
        const rPrev = await fetchLocal(`./api/races?date=${prevStr}&limit=5000`, { cache: 'no-store' });
        if (rPrev.ok) {
          const prevData = await rPrev.json();
          const nowMs = Date.now();
          const yesterdayActive = (prevData.races || [])
            .map(sanitizeRaceObject)
            .filter(r => {
              const st = String(r.race_status || '').toLowerCase();
              if (['final','closed','abandoned','resulted'].includes(st)) return false;
              const t = parseTimeValue(r.advertised_start || r.start_time_nz);
              if (!Number.isFinite(t)) return true;
              return t >= (nowMs - 8 * 60 * 60 * 1000);
            });
          if (yesterdayActive.length) {
            const seen = new Set(rows.map(r => String(r.key || `${r.country}|${r.meeting}|${r.race_number}`)));
            yesterdayActive.forEach(r => {
              const key = String(r.key || `${r.country}|${r.meeting}|${r.race_number}`);
              if (seen.has(key)) return;
              rows.push(r);
              seen.add(key);
            });
          }
        }
      } catch {}
    }
    return rows;
  } catch {
    return (lastRacesSnapshot || []).slice();
  }
}

async function findRaceForButton(meeting, raceNum, country = ''){
  const target = { meeting, raceNumber: raceNum, country };
  if (!racesCache.length) await loadRaces();
  let race = racesCache.find(r => raceIdentityMatches(r, target));
  if (race) return race;

  // fallback: the card may be from another country than current filter
  const all = await loadAllRacesUnfiltered();
  race = all.find(r => raceIdentityMatches(r, target));
  return race || null;
}

function renderMeetingList(rows){
  const wrap = $('meetingList');
  if (!wrap) return;
  wrap.innerHTML = '';
  const cutoff = Date.now() - 5 * 60 * 1000;
  const meetingMap = new Map();
  (rows || []).forEach(r => {
    const label = String(r.meeting || '').trim();
    const norm = normalizeMeetingKey(label);
    if (!norm || meetingMap.has(norm)) return;
    if (raceIsUpcoming(r, cutoff)) meetingMap.set(norm, label);
  });
  if (selectedMeeting && selectedMeeting !== 'ALL') {
    const currentNorm = normalizeMeetingKey(selectedMeeting);
    if (!meetingMap.has(currentNorm)) {
      selectedMeeting = 'ALL';
      persistMeetingLock();
      const meetingSel = $('meetingSelect');
      if (meetingSel) meetingSel.value = 'ALL';
    }
  }
  const meetings = Array.from(meetingMap.values()).sort((a,b) => a.localeCompare(b));

  const meetingCounts = (name) => {
    const nm = String(name || '').trim().toLowerCase();
    const sig = (latestSuggestedBets || []).filter(x => String(x.meeting || '').trim().toLowerCase() === nm).length;
    const intr = (latestInterestingRows || []).filter(x => String(x.meeting || '').trim().toLowerCase() === nm).length;
    const mov = (latestMarketMovers || []).filter(x => String(x.meeting || '').trim().toLowerCase() === nm).length;
    return { sig, intr, mov };
  };

  const all = document.createElement('button');
  all.className = 'pill' + (selectedMeeting === 'ALL' ? ' active' : '');
  all.textContent = 'All Meetings';
  all.onclick = ()=>{
    invalidateMeetingSearch();
    selectedMeeting = 'ALL';
    persistMeetingLock();
    const sel = $('meetingSelect'); if (sel) sel.value = 'ALL';
    renderMeetingList(racesCache);
    renderRaces(racesCache);
    renderSuggested(latestFilteredSuggested || filterSuggestedByWhy(latestSuggestedBets || []));
    renderMultis(latestFilteredSuggested || filterSuggestedByWhy(latestSuggestedBets || []));
    renderNextPlanned(latestFilteredSuggested || filterSuggestedByWhy(latestSuggestedBets || []));
    renderInteresting(latestInterestingRows || []);
    renderMarketMovers(latestMarketMovers || []);
    refreshTabAccess();
    updatePulseMeetingAwareUi();
  };
  wrap.appendChild(all);

  meetings.forEach(m => {
    const b = document.createElement('button');
    b.className = 'pill' + (selectedMeeting === m ? ' active' : '');
    const c = meetingCounts(m);
    const tags = [
      `<span class='tag win'>S ${c.sig}</span>`,
      `<span class='tag value'>I ${c.intr}</span>`,
      `<span class='tag'>M ${c.mov}</span>`
    ].join(' ');
    b.innerHTML = `<span>${m}</span> <span>${tags}</span>`;
    b.onclick = ()=>{
      invalidateMeetingSearch();
      selectedMeeting = m;
      persistMeetingLock();
      const sel = $('meetingSelect'); if (sel) sel.value = m;
      renderMeetingList(racesCache);
      renderRaces(racesCache);
      renderSuggested(latestFilteredSuggested || filterSuggestedByWhy(latestSuggestedBets || []));
      renderMultis(latestFilteredSuggested || filterSuggestedByWhy(latestSuggestedBets || []));
      renderNextPlanned(latestFilteredSuggested || filterSuggestedByWhy(latestSuggestedBets || []));
      renderInteresting(latestInterestingRows || []);
      renderMarketMovers(latestMarketMovers || []);
      refreshTabAccess();
      updatePulseMeetingAwareUi();
    };
    wrap.appendChild(b);
  });
}


function renderRaces(rows){
  const scroller = $('racesScroller');
  scroller.innerHTML = '';

  if (racesCacheWarning) {
    const warn = document.createElement('div');
    warn.className = 'race-card notice';
    const snapshotTime = lastRacesMeta?.fetchedAt
      ? new Date(lastRacesMeta.fetchedAt).toLocaleString()
      : (lastRacesMeta?.dateStr || 'previous snapshot');
    warn.innerHTML = `<div class='title'>${racesCacheWarning}</div><div class='meta'>Snapshot: ${snapshotTime}</div>`;
    scroller.appendChild(warn);
  }

  const cutoff = Date.now() - 5 * 60 * 1000;
  const scoped = (rows || [])
    .filter(r => meetingMatches(r))
    .filter(r => raceIsUpcoming(r, cutoff))
    .slice()
    .sort((a,b) => parseTimeValue(a.advertised_start || a.start_time_nz) - parseTimeValue(b.advertised_start || b.start_time_nz));
  if (!scoped.length) {
    const empty = document.createElement('div');
    empty.className = 'race-card region-empty';
    const regionLabel = (selectedMeeting && selectedMeeting !== 'ALL')
      ? selectedMeeting
      : (selectedCountry === 'ALL' ? 'current filters' : `${selectedCountry}`);
    const dayLabel = selectedDay === 'today' ? 'today' : selectedDay;
    empty.innerHTML = `<div class='title'>No races found</div><div class='meta'>No ${regionLabel} races loaded for ${dayLabel}. Try Refresh or switch filters.</div>`;

    const upcoming = (rows || [])
      .filter(r => raceIsUpcoming(r, cutoff))
      .slice()
      .sort((a,b) => parseTimeValue(a.advertised_start || a.start_time_nz) - parseTimeValue(b.advertised_start || b.start_time_nz))
      .slice(0, 5);

    if (upcoming.length) {
      const next = document.createElement('div');
      next.className = 'next-races';
      next.innerHTML = `<div class='meta next-title'>Next to-do races</div>` + upcoming.map(r => {
        const meeting = r.meeting || 'Meeting';
        const raceNo = r.race_number || r.race || '?';
        const eta = r.start_time_nz || r.advertised_start || 'upcoming';
        const countryLabel = r.country || r.region || '';
        return `<button class='btn btn-ghost next-race-btn' data-key='${r.key || ''}' data-meeting='${meeting}' data-race='${raceNo}'>${countryLabel ? `<span class="badge">${countryLabel}</span> ` : ''}${meeting} R${raceNo} · ${eta}</button>`;
      }).join('');
      empty.appendChild(next);
    } else {
      const none = document.createElement('div');
      none.className = 'meta';
      none.style.marginTop = '12px';
      none.textContent = 'No upcoming races queued in any region.';
      empty.appendChild(none);
    }

    scroller.appendChild(empty);
    empty.querySelectorAll('.next-race-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await selectRace(btn.dataset.key, btn.dataset.meeting, btn.dataset.race);
      });
    });
    return;
  }

  scoped.forEach(r=>{
    const card = document.createElement('div');
    card.className = 'race-card' + (selectedRaceKey === r.key ? ' selected' : '');
    card.dataset.key = r.key || '';
    card.dataset.meeting = r.meeting || '';
    card.dataset.race = r.race_number || r.race || '';
    card.innerHTML = `
      <div class='title'>${r.meeting} R${r.race_number}</div>
      <div class='meta'>${r.description || ''}</div>
      <div class='meta'>${r.start_time_nz || '—'} · ${r.race_status || ''} · ${r.track_condition || ''}</div>
    `;
    card.onclick = () => selectRace(r.key, r.meeting, r.race_number || r.race);
    scroller.appendChild(card);
  });
}

function buildSnapshotMovers(meeting){
  if (!meeting || !racesCache || !racesCache.length) return [];
  const target = String(meeting).trim().toLowerCase();
  const out = [];
  racesCache
    .filter(r => String(r.meeting || '').trim().toLowerCase() === target)
    .forEach(race => {
      const eta = formatRaceEtaLabel(race);
      (race.runners || []).forEach(runner => {
        const key = buildRunnerOddsKey(race, runner);
        if (!key) return;
        const snap = lastOddsSnapshot.get(key);
        if (!snap || !snap.winDir || (Date.now() - Number(snap.winChangedAt || 0)) > ODDS_SIGNAL_TTL_MS) return;
        out.push({
          meeting: race.meeting,
          race: race.race_number,
          runner: runner.name || runner.runner_name,
          fromOdds: null,
          toOdds: Number.isFinite(Number(runner.odds || runner.fixed_win || runner.tote_win || 0)) ? Number(runner.odds || runner.fixed_win || runner.tote_win || 0) : null,
          pctMove: snap.winDir === 'odds-drifting' ? 2 : -2,
          direction: snap.winDir === 'odds-drifting' ? 'drift' : 'firm',
          eta,
          minsToJump: Number(race.minsToJump || race.minutes_to_jump || 0),
          fresh: true
        });
      });
    });
  return out;
}

function buildFallbackMovers(meeting){
  if (!meeting || !racesCache || !racesCache.length) return [];
  const target = String(meeting).trim().toLowerCase();
  const races = racesCache.filter(r => String(r.meeting || '').trim().toLowerCase() === target);
  const out = [];
  races.forEach(race => {
    const eta = formatRaceEtaLabel(race);
    (race.runners || []).forEach(runner => {
      if (!runner?.mover) return;
      const odds = Number(runner.odds || runner.fixed_win || runner.tote_win || 0);
      out.push({
        meeting: race.meeting,
        race: race.race_number,
        runner: runner.name || runner.runner_name,
        fromOdds: null,
        toOdds: Number.isFinite(odds) ? odds : null,
        pctMove: runner.mover === 'drift' ? 3 : -3,
        direction: runner.mover === 'drift' ? 'drift' : 'firm',
        eta,
        minsToJump: Number(race.minsToJump || race.minutes_to_jump || 0)
      });
    });
  });
  return out;
}

function renderMarketMovers(rows){
  const table = $('moversTable');
  if (!table) return;
  table.innerHTML = '';
  const controls = document.createElement('div');
  controls.className = 'movers-toggle';
  table.appendChild(controls);

  let baseRows = rows || [];
  let filteredByWhy = filterMoversByWhy(baseRows);
  let meetingRawRows = baseRows.filter(r => meetingMatches(r));
  if (!meetingRawRows.length && selectedMeeting && selectedMeeting !== 'ALL') {
    const snapshotMovers = buildSnapshotMovers(selectedMeeting);
    const fallback = snapshotMovers.length ? snapshotMovers : buildFallbackMovers(selectedMeeting);
    if (fallback.length) {
      baseRows = fallback;
      filteredByWhy = filterMoversByWhy(baseRows);
      meetingRawRows = baseRows.filter(r => meetingMatches(r));
    }
  }
  const filteredMeetingRows = filteredByWhy.filter(r => meetingMatches(r));
  const upcomingRaw = meetingRawRows.filter(r => {
    const mtj = Number(r.minsToJump);
    return !Number.isFinite(mtj) || mtj >= -5;
  });
  let meetingUpcomingMovers = filteredMeetingRows
    .filter(r => {
      const mtj = Number(r.minsToJump);
      return !Number.isFinite(mtj) || mtj >= -5;
    });
  if (!meetingUpcomingMovers.length) meetingUpcomingMovers = filteredMeetingRows.slice();
  if (!meetingUpcomingMovers.length && selectedMeeting && selectedMeeting !== 'ALL') {
    meetingUpcomingMovers = filteredByWhy.filter(r => {
      const mtj = Number(r.minsToJump);
      return !Number.isFinite(mtj) || mtj >= -5;
    });
  }
  const hasFirmers = meetingUpcomingMovers.some(r => Number(r.pctMove || 0) <= 0);
  const hasDrifters = meetingUpcomingMovers.some(r => Number(r.pctMove || 0) > 0);
  if (moversMode === 'firmers' && !hasFirmers && hasDrifters) {
    moversMode = 'drifters';
    localStorage.setItem('moversMode', moversMode);
  } else if (moversMode === 'drifters' && !hasDrifters && hasFirmers) {
    moversMode = 'firmers';
    localStorage.setItem('moversMode', moversMode);
  }

  const normalizeMeetingKey = (val) => String(val || '').trim().toLowerCase();
  const normalizeRaceNumber = (val) => String(val || '').replace(/^R/i,'').trim();
  const selectedRaceNumPref = selectedRace ? String(selectedRace.race_number || selectedRace.race || '').replace(/^R/i,'').trim() : '';
  const selectedMeetingKeyPref = selectedRace ? normalizeMeetingKey(selectedRace.meeting || '') : '';
  const totalFirmersRaw = upcomingRaw.filter(r => Number(r.pctMove || 0) <= 0).length;
  const totalDriftersRaw = upcomingRaw.filter(r => Number(r.pctMove || 0) > 0).length;

  controls.innerHTML = `<button data-mode="firmers" class="${moversMode === 'firmers' ? 'active' : ''}">Firmers (${totalFirmersRaw})</button><button data-mode="drifters" class="${moversMode === 'drifters' ? 'active' : ''}">Drifters (${totalDriftersRaw})</button>`;
  controls.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      moversMode = btn.dataset.mode === 'drifters' ? 'drifters' : 'firmers';
      localStorage.setItem('moversMode', moversMode);
      renderMarketMovers(rows);
    });
  });

  const selectedRaceNum = selectedRace ? String(selectedRace.race_number || selectedRace.race || '').replace(/^R/i,'').trim() : '';
  const selectedMeetingKey = selectedRace ? normalizeMeetingKey(selectedRace.meeting || '') : '';
  const scoped = meetingUpcomingMovers
    .filter(r => {
      const move = Number(r.pctMove || 0);
      return moversMode === 'drifters' ? move > 0 : move <= 0;
    })
    .slice()
    .sort((a,b) => {
      const aRace = Number(normalizeRaceNumber(a.race));
      const bRace = Number(normalizeRaceNumber(b.race));
      const selectedRaceNo = Number(selectedRaceNum || NaN);
      const aBucket = Number.isFinite(selectedRaceNo) && Number.isFinite(aRace)
        ? (aRace === selectedRaceNo ? 0 : (aRace > selectedRaceNo ? 1 : 2))
        : 3;
      const bBucket = Number.isFinite(selectedRaceNo) && Number.isFinite(bRace)
        ? (bRace === selectedRaceNo ? 0 : (bRace > selectedRaceNo ? 1 : 2))
        : 3;
      const aSelected = selectedMeetingKey && selectedRaceNum && normalizeMeetingKey(a.meeting) === selectedMeetingKey && String(normalizeRaceNumber(a.race)) === selectedRaceNum;
      const bSelected = selectedMeetingKey && selectedRaceNum && normalizeMeetingKey(b.meeting) === selectedMeetingKey && String(normalizeRaceNumber(b.race)) === selectedRaceNum;
      if (aSelected !== bSelected) return aSelected ? -1 : 1;
      if (aBucket !== bBucket) return aBucket - bBucket;
      if (Number.isFinite(aRace) && Number.isFinite(bRace) && aRace !== bRace) return aRace - bRace;
      const ma = Number(a.minsToJump);
      const mb = Number(b.minsToJump);
      const hasA = Number.isFinite(ma);
      const hasB = Number.isFinite(mb);
      if (hasA && hasB && ma !== mb) return ma - mb;
      const magA = Math.abs(Number(a.pctMove || 0));
      const magB = Math.abs(Number(b.pctMove || 0));
      if (magA !== magB) return magB - magA;
      return String(a.eta || '').localeCompare(String(b.eta || ''));
    })
    .slice(0, 120);
  const seenRaceKeys = new Set(upcomingRaw
    .map(r => {
      const raceNum = normalizeRaceNumber(r.race);
      if (!raceNum) return null;
      return `${normalizeMeetingKey(r.meeting)}|${raceNum}`;
    })
    .filter(Boolean)
  );

  const restOfMeetingRows = [];
  if (selectedMeeting !== 'ALL') {
    const meetingNorm = normalizeMeetingKey(selectedMeeting);
    const cutoffTs = Date.now() - 5 * 60 * 1000;
    (racesCache || []).forEach(race => {
      if (normalizeMeetingKey(race.meeting) !== meetingNorm) return;
      const raceNum = normalizeRaceNumber(race.race_number || race.race);
      if (!raceNum) return;
      const ts = parseTimeValue(race.advertised_start || race.start_time_nz);
      if (Number.isFinite(ts) && ts < cutoffTs) return;
      const key = `${meetingNorm}|${raceNum}`;
      if (seenRaceKeys.has(key)) return;
      restOfMeetingRows.push({
        meeting: race.meeting,
        race: raceNum,
        raceObj: race
      });
    });
    restOfMeetingRows.sort((a,b) => {
      const ta = parseTimeValue(a.raceObj?.advertised_start || a.raceObj?.start_time_nz);
      const tb = parseTimeValue(b.raceObj?.advertised_start || b.raceObj?.start_time_nz);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      const na = Number(a.race);
      const nb = Number(b.race);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return String(a.race).localeCompare(String(b.race));
    });
  }

  const header = document.createElement('div');
  header.className='row header';
  header.innerHTML = `<div>Race</div><div>Runner</div><div>Move</div><div>Horizons</div><div class='right'>Jumps In</div>`;
  table.appendChild(header);

  const meetingLabel = selectedMeeting === 'ALL' ? 'current filters' : selectedMeeting;
  if (!scoped.length && upcomingRaw.length) {
    let noteMessage = '';
    if (!filteredMeetingRows.length && selectedWhy !== 'ALL') {
      noteMessage = `Moves exist for ${meetingLabel}, but WHY filter (${displayWhy(selectedWhy)}) is hiding them.`;
    } else if (moversMode === 'firmers' && totalFirmersRaw === 0 && totalDriftersRaw > 0) {
      noteMessage = `${totalDriftersRaw} drifter${totalDriftersRaw === 1 ? '' : 's'} detected — switch to Drifters to view them.`;
    } else if (moversMode === 'drifters' && totalDriftersRaw === 0 && totalFirmersRaw > 0) {
      noteMessage = `${totalFirmersRaw} firmer${totalFirmersRaw === 1 ? '' : 's'} detected — switch to Firmers to view them.`;
    }
    if (noteMessage) {
      const note = document.createElement('div');
      note.className = 'row movers-note';
      note.innerHTML = `<div style='grid-column:1/-1;color:#7aa3c7'>${noteMessage}</div>`;
      table.appendChild(note);
    }
  }

  if (!scoped.length && !restOfMeetingRows.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    const totalAll = (rows || []).length;
    const totalAfterWhy = filteredByWhy.length;
    let message = '';
    if (selectedWhy !== 'ALL' && totalAfterWhy === 0) {
      message = `No market movers match WHY: ${displayWhy(selectedWhy)}.`;}
    else if (selectedMeeting !== 'ALL' && totalAfterWhy > 0) {
      message = `No market movers for ${selectedMeeting} yet (moves exist in other meetings).`;}
    else if (!totalAll) {
      message = 'No market movers detected yet (requires live odds changes across snapshots).';
    } else {
      message = 'No market movers currently passing filters.';
    }
    empty.innerHTML = `<div style='grid-column:1/-1'>${message}</div>`;
    table.appendChild(empty);
    return;
  }

  if (scoped.length) {
    const frag = document.createDocumentFragment();
    scoped.forEach(r=>{
      const row = document.createElement('div');
      row.className='row';
      const move = Number(r.pctMove || 0);
      const cls = move < 0 ? 'comp-green' : 'comp-red';
      const graphHtml = buildMoverGraph(r) || "<div class='sub'>No horizon data</div>";
      const fromOddsTxt = (r.fromOdds !== null && r.fromOdds !== undefined && Number.isFinite(Number(r.fromOdds))) ? Number(r.fromOdds).toFixed(2) : '—';
      const toOddsTxt = (r.toOdds !== null && r.toOdds !== undefined && Number.isFinite(Number(r.toOdds))) ? Number(r.toOdds).toFixed(2) : '—';
      const moverImg = marketMoverImage(r);
      row.innerHTML = `
        <div><button class='bet-btn race-cell-btn movers-race-btn' data-meeting='${r.meeting}' data-race='${r.race}'><span class="badge">${r.meeting}</span> R${r.race}</button></div>
        <div><button class='bet-btn movers-runner-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-runner='${r.runner}'><span class='bet-icon'>🐎</span>${r.runner}</button></div>
        <div><div class='comp-box ${cls} mover-comp-box'>${moverImg ? `<img class='mover-signal-img' src='${moverImg}' alt='${move < 0 ? 'Firming' : 'Drifting'} signal' />` : ''}<span>${move < 0 ? 'Firmed' : 'Drifted'} ${Math.abs(move).toFixed(1)}% ${r.fresh ? '· NEW' : ''}${r.startMove ? '· START' : ''}</span></div><div class='sub'>${fromOddsTxt} → ${toOddsTxt}</div></div>
        <div>${graphHtml}</div>
        <div class='right'>${buildJumpCell(r.meeting, r.race, r.eta || '—')}</div>
      `;
      frag.appendChild(row);
    });
    table.appendChild(frag);
  }

  if (restOfMeetingRows.length) {
    if (scoped.length) {
      const divider = document.createElement('div');
      divider.className = 'row rest-divider';
      divider.innerHTML = `<div style='grid-column:1/-1;color:#7aa3c7;font-size:11px;text-transform:uppercase;letter-spacing:0.12em'>Rest of ${selectedMeeting}</div>`;
      table.appendChild(divider);
    }
    const restFrag = document.createDocumentFragment();
    restOfMeetingRows.forEach(r => {
      const raceRef = (racesCache || []).find(x => meetingMatches(x.meeting) && String(x.race_number || x.race || '') === String(r.race || ''));
      const moverHints = (raceRef?.runners || [])
        .filter(x => !!x?.mover)
        .slice(0, 3)
        .map(x => `${cleanRunnerText(x.name || x.runner_name || '')}${Number(x.odds || x.fixed_win || x.tote_win || 0) ? ` @ ${Number(x.odds || x.fixed_win || x.tote_win).toFixed(2)}` : ''}`)
        .filter(Boolean);
      const row = document.createElement('div');
      row.className = 'row rest-row';
      row.innerHTML = `
        <div><button class='bet-btn race-cell-btn movers-race-btn' data-meeting='${r.meeting}' data-race='${r.race}'><span class="badge">${r.meeting}</span> R${r.race}</button></div>
        <div><div class='sub' style='color:#8ea6c8'>${moverHints.length ? moverHints.join(' · ') : 'No notable moves yet'}</div></div>
        <div><div class='comp-box ${moverHints.length ? 'comp-green' : 'comp-amber'}'>${moverHints.length ? 'Potential movers' : 'Monitoring'}</div><div class='sub'>${moverHints.length ? 'Runner mover flags detected' : 'Waiting for price action'}</div></div>
        <div><div class='sub'>${moverHints.length ? `${moverHints.length} flagged` : '—'}</div></div>
        <div class='right'>${buildJumpCell(r.meeting, r.race, 'upcoming')}</div>
      `;
      restFrag.appendChild(row);
    });
    table.appendChild(restFrag);
  }

  table.querySelectorAll('.movers-race-btn').forEach(btn=>{
    btn.onclick = async ()=>{
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      setActivePage('workspace');
      await selectRace(race.key);
      $('analysisBody').innerHTML += `<div style='margin-top:6px;color:#7aa3c7'>Loaded from Market Movers</div>`;
    };
  });

  table.querySelectorAll('.movers-runner-btn').forEach(btn=>{
    btn.onclick = async ()=>{
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      setActivePage('workspace');
      await selectRace(race.key);
      const selNorm = normalizeRunnerName(String(btn.dataset.runner || '').trim());
      const runner = (race.runners || []).find(x => {
        const nm = normalizeRunnerName(String(x.name || x.runner_name || '').trim());
        return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
      });
      if (runner && $('analysisBody')) {
        $('analysisBody').innerHTML += `<div style='margin-top:6px;color:#7aa3c7'>Focused from Market Movers: ${escapeHtml(runner.name || runner.runner_name || String(btn.dataset.runner || ''))}</div>`;
      }
    };
  });
}

function buildMoverGraph(row){
  const horizons = [
    { label: 'Open', value: Number(row.changeOpening) },
    { label: '5h', value: Number(row.change5h) },
    { label: '1h', value: Number(row.change1h) },
    { label: '30m', value: Number(row.change30m) },
    { label: '5m', value: Number(row.change5m) },
    { label: '1m', value: Number(row.change1m) }
  ];
  const usable = horizons.filter(h => Number.isFinite(h.value));
  if (!usable.length) return '';
  const maxAbs = Math.max(...usable.map(h => Math.abs(h.value))) || 1;
  const rows = horizons.map(h => {
    if (!Number.isFinite(h.value)) {
      return `<div class="horizon-row empty"><span class='label'>${h.label}</span><div class='bar-track'><span class='bar-fill'></span></div><span class='val'>—</span></div>`;
    }
    const width = Math.min(100, Math.abs(h.value) / maxAbs * 100);
    const dir = h.value < 0 ? 'firm' : 'drift';
    const val = `${h.value > 0 ? '+' : ''}${h.value.toFixed(1)}%`;
    return `<div class="horizon-row ${dir}"><span class='label'>${h.label}</span><div class='bar-track'><span class='bar-fill' style='width:${width}%'></span></div><span class='val'>${val}</span></div>`;
  }).join('');
  return `<div class="mover-graph horiz">${rows}</div>`;
}
function buildMoveTags(row){
  const move = Number(row?.pctMove || row?.change5m || row?.change1m || 0);
  if (!Number.isFinite(move) || move === 0) return [];
  const magnitude = Math.abs(move).toFixed(1);
  if (move < 0) return [`<span class='tag firm'>Firming ${magnitude}%</span>`];
  return [`<span class='tag drift'>Drifting ${magnitude}%</span>`];
}

function buildInterestingTags(row){
  const tags = ["<span class='tag'>Interesting</span>"];
  const reason = String(row?.reason || row?.ai_commentary || '').toLowerCase();
  const odds = Number(row?.odds || row?.fixed_win || row?.tote_win || 0);
  tags.push(...buildMoveTags(row));
  if (rowIsDominantFav(row)) tags.push("<span class='tag dom'>Dominant Fav</span>");
  if (Number.isFinite(odds) && odds >= 8 && /form/.test(reason)) tags.push("<span class='tag value'>Form + Overs</span>");
  if (/trial|first-up|second-up/.test(reason)) tags.push("<span class='tag form'>Form</span>");
  return tags;
}


function findInterestingRow(meeting, race, runner){
  const meetingNorm = String(meeting || '').trim().toLowerCase();
  const raceNorm = String(race || '').replace(/^R/i,'').trim();
  const runnerNorm = normalizeRunnerName(cleanRunnerText(runner || ''));
  return (latestInterestingRows || []).find(row => {
    const rm = String(row.meeting || '').trim().toLowerCase();
    const rr = String(row.race || '').replace(/^R/i,'').trim();
    const rn = normalizeRunnerName(cleanRunnerText(row.runner || ''));
    return rm === meetingNorm && rr === raceNorm && (rn === runnerNorm || rn.includes(runnerNorm) || runnerNorm.includes(rn));
  }) || null;
}

function inheritInterestingTags(meeting, race, runner){
  const row = findInterestingRow(meeting, race, runner);
  return row ? buildInterestingTags(row) : [];
}

function findMoverRow(meeting, race, runner){
  const meetingNorm = String(meeting || '').trim().toLowerCase();
  const raceNorm = String(race || '').replace(/^R/i,'').trim();
  const runnerNorm = normalizeRunnerName(cleanRunnerText(runner || ''));
  return (latestMarketMovers || []).find(row => {
    const rm = String(row.meeting || '').trim().toLowerCase();
    const rr = String(row.race || '').replace(/^R/i,'').trim();
    const rn = normalizeRunnerName(cleanRunnerText(row.runner || ''));
    return rm === meetingNorm && rr === raceNorm && (rn === runnerNorm || rn.includes(runnerNorm) || runnerNorm.includes(rn));
  }) || null;
}

function inheritMoveTags(meeting, race, runner){
  const row = findMoverRow(meeting, race, runner);
  return row ? buildMoveTags(row) : [];
}

function renderWorkspaceSignalPanels(){
  const moversTable = $('workspaceMoversTable');
  const interestingTable = $('workspaceInterestingTable');
  if (!moversTable && !interestingTable) return;
  if (moversTable) {
    const scopedMovers = (latestMarketMovers || []).filter(r => meetingMatches(r)).filter(selectionIsUpcoming).slice(0, 6);
    moversTable.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'row header';
    header.innerHTML = `<div>Race</div><div>Runner</div><div>Signal</div><div class='right'>Jump</div>`;
    moversTable.appendChild(header);
    if (!scopedMovers.length) {
      const empty = document.createElement('div');
      empty.className = 'row';
      empty.innerHTML = `<div style='grid-column:1/-1'>No market movers in the current meeting yet.</div>`;
      moversTable.appendChild(empty);
    } else {
      scopedMovers.forEach(r => {
        const row = document.createElement('div');
        const move = Number(r.pctMove || 0);
        const severity = Math.abs(move) >= 12 ? 'critical' : (Math.abs(move) >= 6 ? 'hot' : 'watch');
        const directionLabel = move < 0 ? 'Firmed' : 'Drifted';
        row.className = `row workspace-signal-rich ${move < 0 ? 'workspace-firm' : 'workspace-drift'}`;
        row.innerHTML = `
          <div><button class='bet-btn race-cell-btn movers-race-btn workspace-mini-btn' data-meeting='${r.meeting}' data-race='${r.race}'><span class="badge">${r.meeting}</span> R${r.race}</button></div>
          <div><button class='bet-btn movers-runner-btn workspace-mini-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-runner='${escapeAttr(String(r.runner || ''))}'><span class='bet-icon'>🐎</span>${escapeHtml(String(r.runner || ''))}</button></div>
          <div class='workspace-signal-cell'>
            <div class='workspace-signal-line'>
              <span class='workspace-severity-chip ${severity}'>${severity.toUpperCase()}</span>
              <span class='tag ${move < 0 ? 'firm' : 'drift'}'>${directionLabel} ${Math.abs(move).toFixed(1)}%</span>
            </div>
            <div class='sub'>${escapeHtml(String(r.fromOdds ?? '—'))} → ${escapeHtml(String(r.toOdds ?? '—'))}</div>
            <div class='workspace-signal-actions'>
              <button class='btn btn-ghost compact-btn workspace-action-btn workspace-track-runner-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-runner='${escapeAttr(String(r.runner || ''))}'>Track runner</button>
              <button class='btn btn-ghost compact-btn workspace-action-btn workspace-track-race-btn' data-meeting='${r.meeting}' data-race='${r.race}'>Track race</button>
            </div>
          </div>
          <div class='right'>${buildJumpCell(r.meeting, r.race, r.eta || '—')}</div>
        `;
        moversTable.appendChild(row);
      });
    }
  }
  if (interestingTable) {
    const scopedInteresting = filterInterestingByWhy(latestInterestingRows || []).filter(r => meetingMatches(r)).filter(selectionIsUpcoming).slice(0, 6);
    interestingTable.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'row header';
    header.innerHTML = `<div>Race</div><div>Runner</div><div>Signal</div><div class='right'>Jump</div>`;
    interestingTable.appendChild(header);
    if (!scopedInteresting.length) {
      const empty = document.createElement('div');
      empty.className = 'row';
      empty.innerHTML = `<div style='grid-column:1/-1'>No interesting runners in the current meeting right now.</div>`;
      interestingTable.appendChild(empty);
    } else {
      scopedInteresting.forEach(r => {
        const row = document.createElement('div');
        row.className = 'row workspace-signal-rich workspace-interesting';
        row.innerHTML = `
          <div><button class='bet-btn race-cell-btn interesting-race-btn workspace-mini-btn' data-meeting='${r.meeting}' data-race='${r.race}'><span class="badge">${r.meeting}</span> R${r.race}</button></div>
          <div><button class='bet-btn interesting-btn workspace-mini-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-runner='${escapeAttr(cleanRunnerText(r.runner))}'><span class='bet-icon'>🧠</span>${escapeHtml(cleanRunnerText(r.runner))}</button></div>
          <div class='workspace-signal-cell'>
            <div class='workspace-signal-line'><span class='workspace-severity-chip hot'>SIGNAL</span>${buildInterestingTags(r).join(' ')}</div>
            <div class='sub'>${escapeHtml(r.reason || 'Interesting profile')}</div>
            <div class='workspace-signal-actions'>
              <button class='btn btn-ghost compact-btn workspace-action-btn workspace-track-runner-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-runner='${escapeAttr(cleanRunnerText(r.runner))}'>Track runner</button>
              <button class='btn btn-ghost compact-btn workspace-action-btn workspace-track-race-btn' data-meeting='${r.meeting}' data-race='${r.race}'>Track race</button>
            </div>
          </div>
          <div class='right'>${buildJumpCell(r.meeting, r.race, r.eta || '—')}</div>
        `;
        interestingTable.appendChild(row);
      });
    }
    attachInterestingHandlers();
  }
  document.querySelectorAll('.workspace-open-tab-btn').forEach(btn => {
    btn.onclick = () => setActivePage(btn.dataset.openPage || 'workspace');
  });
  const bindWorkspaceRaceAction = (selector, handler) => {
    document.querySelectorAll(selector).forEach(btn => btn.onclick = handler);
  };
  bindWorkspaceRaceAction('#workspaceMoversTable .movers-race-btn', async (e) => {
    const btn = e.currentTarget;
    const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
    if (!race) return alert('Race not found in cache yet. Try Refresh.');
    await selectRace(race.key);
    $('analysisBody').innerHTML += `<div style='margin-top:6px;color:#7aa3c7'>Loaded from Workspace Market Movers</div>`;
  });
  bindWorkspaceRaceAction('#workspaceMoversTable .movers-runner-btn', async (e) => {
    const btn = e.currentTarget;
    const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
    if (!race) return alert('Race not found in cache yet. Try Refresh.');
    await selectRace(race.key);
    $('analysisBody').innerHTML += `<div style='margin-top:6px;color:#7aa3c7'>Focused from Workspace Market Movers: ${escapeHtml(String(btn.dataset.runner || ''))}</div>`;
  });
  bindWorkspaceRaceAction('.workspace-track-race-btn', async (e) => {
    const btn = e.currentTarget;
    const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
    if (!race) return alert('Race not found in cache yet. Try Refresh.');
    await openTrackRaceChooser(race, {
      title: `${race.meeting} R${race.race_number} — Track Race`,
      sourcePrefix: 'web-workspace-race-track',
      notes: {
        win: 'Track all runners in race from workspace',
        watch: 'Watch race from workspace'
      }
    });
  });
  bindWorkspaceRaceAction('.workspace-track-runner-btn', async (e) => {
    const btn = e.currentTarget;
    const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
    if (!race) return alert('Race not found in cache yet. Try Refresh.');
    const selNorm = normalizeRunnerName(String(btn.dataset.runner || '').trim());
    const runner = (race.runners || []).find(x => {
      const nm = normalizeRunnerName(String(x.name || x.runner_name || x.selection || '').trim());
      return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
    });
    if (!runner) return;
    const outcome = await toggleTrackedRunner(race, runner).catch(() => null);
    if (outcome?.action === 'tracked') alert(`Tracked ${cleanRunnerText(runner.name || runner.runner_name || btn.dataset.runner || 'runner')}.`);
    else if (outcome?.action === 'untracked') alert(`Untracked ${cleanRunnerText(runner.name || runner.runner_name || btn.dataset.runner || 'runner')}.`);
  });
}

function renderInteresting(rows){
  const table = $('interestingTable');
  table.innerHTML = '';
  const header = document.createElement('div');
  header.className='row header';
  header.innerHTML = `<div>Race</div><div>Runner</div><div>AI Commentary</div><div>Odds</div><div class='right'>Jumps In</div>`;
  table.appendChild(header);

  const filtered = filterInterestingByWhy(rows || []);
  let scoped = filtered
    .filter(r => meetingMatches(r))
    .filter(selectionIsUpcoming);

  if (!scoped.length && selectedMeeting && selectedMeeting !== 'ALL') {
    const fallback = buildFallbackInterestingRows(selectedMeeting);
    if (fallback.length) scoped = fallback;
  }

  if (!scoped.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    const totalAfterWhy = filtered.length;
    let message = '';
    if (selectedWhy !== 'ALL' && totalAfterWhy === 0) {
      message = `No interesting runners match WHY: ${displayWhy(selectedWhy)}.`;
    } else if (selectedMeeting !== 'ALL' && totalAfterWhy > 0) {
      message = `No interesting runners for ${selectedMeeting} right now.`;
    } else {
      message = 'No interesting runners available right now. Try Refresh or switch meeting/country.';
    }
    empty.innerHTML = `<div style='grid-column:1/-1'>${message}</div>`;
    table.appendChild(empty);
    attachInterestingHandlers();
    makeSelectionsDraggable();
    return;
  }

  const ordered = orderRowsAroundSelectedRace(scoped.map(r => ({ ...r, jumpsIn: r.jumpsIn || r.eta })));

  ordered.forEach(r=>{
    const row = document.createElement('div');
    row.className='row';
    const aiNote = r.ai_commentary || (r.reason ? `AI flags ${r.runner} due to ${r.reason.toLowerCase()}.` : 'AI monitoring runner profile.');
    const reasonWithOdds = `${r.reason || ''} @ ${r.odds || ''}`;
    const tags = [...buildInterestingTags(r)];
    const race = lookupRace(r.meeting, r.race);
    const runner = race?.runners?.find(x => normalizeRunnerName(x.name || x.runner_name || '') === normalizeRunnerName(r.runner || ''));
    const formSignal = runner ? runnerFormSignal(runner) : null;
    const formTag = renderFormStatusTag(formSignal, formSignal?.summary);
    if (formTag) tags.push(formTag);
    const fallbackSignal = formSignal?.status === 'HOT' ? 80 : formSignal?.status === 'SOLID' ? 70 : formSignal?.status === 'MIXED' ? 55 : formSignal?.status === 'COLD' ? 35 : null;
    const formBits = [];
    if (runner?.last_twenty_starts) formBits.push(`Form ${runner.last_twenty_starts}`);
    if (formSignal?.summary) formBits.push(formSignal.summary);
    if (runner?.speedmap) formBits.push(`Speed ${runner.speedmap}`);
    const profileLine = formBits.length ? `<div class='interesting-profile'>${formBits.join(' · ')}</div>` : '';
    row.innerHTML = `
      <div><button class='bet-btn race-cell-btn interesting-race-btn' data-meeting='${r.meeting}' data-race='${r.race}'><span class="badge">${r.meeting}</span> R${r.race}</button></div>
      <div><button class='bet-btn interesting-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-runner='${escapeAttr(cleanRunnerText(r.runner))}'><span class='bet-icon'>🧠</span>${escapeHtml(cleanRunnerText(r.runner))}</button></div>
      <div><div class='interesting-meta'>${signalHint(reasonWithOdds, 'win', r.runner || r.selection || '', fallbackSignal)} ${tags.join(' ')}</div><div class='interesting-note'>${aiNote}</div>${profileLine}</div>
      <div>${r.odds || '—'}</div>
      <div class='right'>${buildJumpCell(r.meeting, r.race, r.eta || '—')}</div>
    `;
    table.appendChild(row);
  });

  attachInterestingHandlers();
  makeSelectionsDraggable();
}
function formatRaceEtaLabel(race){
  const ts = parseTimeValue(race?.advertised_start || race?.start_time_nz);
  if (!Number.isFinite(ts)) return 'upcoming';
  const minutes = Math.round((ts - Date.now()) / 60000);
  if (!Number.isFinite(minutes)) return 'upcoming';
  if (minutes <= 0) return 'jumped';
  return `in ${minutes}m`;
}

function buildFallbackInterestingRows(meeting){
  const oddsOf = (r) => {
    const v = Number(r?.odds || r?.fixed_win || r?.tote_win || 0);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  };
  if (!meeting || !racesCache.length) return [];
  const target = String(meeting).trim().toLowerCase();
  if (!target) return [];
  const races = racesCache.filter(r => String(r.meeting || '').trim().toLowerCase() === target);
  if (!races.length) return [];
  const rows = [];
  races.forEach(race => {
    const region = String(race.country || race.region || '').trim().toUpperCase();
    const eta = formatRaceEtaLabel(race);
    const startTs = parseTimeValue(race.advertised_start || race.start_time_nz);
    (race.runners || []).forEach(runner => {
      const odds = oddsOf(runner);
      if (!Number.isFinite(odds) || odds < 8) return;
      const signal = runnerFormSignal(runner);
      const hasForm = signal && (signal.status === 'HOT' || signal.status === 'SOLID' || signal.legacy === 'GOOD');
      if (!hasForm && region !== 'HK') return;
      rows.push({
        meeting: race.meeting,
        race: race.race_number,
        runner: runner.name || runner.runner_name || 'Runner',
        odds: Number(odds.toFixed(2)),
        eta,
        reason: hasForm ? `auto LONG (${signal.summary || runner.last_twenty_starts || 'form solid'})` : 'auto HK long-odds profile',
        ai_commentary: hasForm ? 'Auto LONG candidate (odds ≥ 8 w/ recent form).' : 'Auto HK LONG candidate (limited form data).',
        _startTs: Number.isFinite(startTs) ? startTs : Infinity
      });
    });
  });

  if (!rows.length) {
    races.forEach(race => {
      const eta = formatRaceEtaLabel(race);
      const startTs = parseTimeValue(race.advertised_start || race.start_time_nz);
      const candidates = (race.runners || []).map(runner => {
        const odds = oddsOf(runner);
        const signal = runnerFormSignal(runner);
        const score = signal?.status === 'HOT' ? 3 : signal?.status === 'SOLID' ? 2 : signal?.status === 'MIXED' ? 1 : 0;
        return { runner, odds, signal, score };
      }).filter(c => c.score > 0);
      candidates.sort((a,b) => (b.score - a.score) || ((b.odds || 0) - (a.odds || 0)));
      candidates.slice(0, 2).forEach(c => {
        rows.push({
          meeting: race.meeting,
          race: race.race_number,
          runner: c.runner.name || c.runner.runner_name || 'Runner',
          odds: Number.isFinite(c.odds) ? Number(c.odds.toFixed(2)) : null,
          eta,
          reason: `auto FORM (${c.signal?.summary || c.runner.last_twenty_starts || 'solid form'})`,
          ai_commentary: 'Auto form-based runner (fallback when no long-odds picks).',
          _startTs: Number.isFinite(startTs) ? startTs : Infinity
        });
      });
    });
  }
  return rows
    .sort((a,b) => {
      if (a._startTs !== b._startTs) return a._startTs - b._startTs;
      return String(a.runner || '').localeCompare(String(b.runner || ''));
    })
    .slice(0, 8)
    .map(row => { const { _startTs, ...rest } = row; return rest; });
}
function buildFallbackLongSuggestedRows(){
  const oddsOf = (r) => {
    const v = Number(r?.odds || r?.fixed_win || r?.tote_win || 0);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  };
  if (!racesCache || !racesCache.length) return [];
  const rows = [];
  const limitPerMeeting = 3;
  const meetingCounts = new Map();
  racesCache.forEach(race => {
    if (!meetingMatches(race.meeting)) return;
    const meetingKey = String(race.meeting || '').trim();
    const used = meetingCounts.get(meetingKey) || 0;
    if (used >= limitPerMeeting && selectedMeeting === 'ALL') return;
    const region = String(race.country || race.region || '').trim().toUpperCase();
    const eta = formatRaceEtaLabel(race);
    const startTs = parseTimeValue(race.advertised_start || race.start_time_nz);
    (race.runners || []).forEach(runner => {
      const odds = oddsOf(runner);
      if (!Number.isFinite(odds) || odds < 8) return;
      const signal = runnerFormSignal(runner);
      const hasForm = signal && (signal.status === 'HOT' || signal.status === 'SOLID' || signal.legacy === 'GOOD');
      if (!hasForm && region !== 'HK') return;
      const estProb = hasForm
        ? Math.min(35, Math.max(12, 10 + (signal.wins || 0) * 5 + (signal.podiums || 0) * 2))
        : 12;
      rows.push({
        meeting: race.meeting,
        race: race.race_number,
        selection: runner.name || runner.runner_name || 'Runner',
        type: 'Win',
        reason: `p=${estProb.toFixed(1)}% @ ${odds.toFixed(1)} · LONG auto pick`,
        jumpsIn: eta,
        stake: 0,
        interesting: true,
        autoLong: true,
        _startTs: Number.isFinite(startTs) ? startTs : Infinity
      });
      if (selectedMeeting === 'ALL') {
        meetingCounts.set(meetingKey, (meetingCounts.get(meetingKey) || 0) + 1);
      }
    });
  });
  return rows
    .sort((a,b) => {
      if (a._startTs !== b._startTs) return a._startTs - b._startTs;
      return String(a.selection || '').localeCompare(String(b.selection || ''));
    })
    .slice(0, 12)
    .map(row => { const { _startTs, ...rest } = row; return rest; });
}
function buildRunnerOddsKey(race, runner){
  if (!race || !runner) return null;
  const raceKey = race.key || buildAiRaceKey(race);
  const runnerKey = normalizeRunnerName(runner.name || runner.runner_name || runner.selection || '');
  if (!raceKey || !runnerKey) return null;
  return `${raceKey}|${runnerKey}`;
}

function seedOddsSnapshotFromRaces(races){
  (races || []).forEach(race => {
    (race.runners || []).forEach(runner => {
      const winOdds = Number(runner?.odds || runner?.fixed_win || runner?.tote_win || 0);
      const placeOdds = Number(runner?.fixed_place || runner?.tote_place || runner?.place_odds || runner?.place_price || 0);
      trackRunnerOdds(race, runner, Number.isFinite(winOdds) && winOdds > 0 ? winOdds : null, Number.isFinite(placeOdds) && placeOdds > 0 ? placeOdds : null);
    });
  });
}

function trackRunnerOdds(race, runner, winOdds, placeOdds){
  const key = buildRunnerOddsKey(race, runner);
  if (!key) return { win: '', place: '' };
  const prev = lastOddsSnapshot.get(key);
  const classes = { win: '', place: '' };
  const now = Date.now();
  let winDir = prev?.winDir || '';
  let placeDir = prev?.placeDir || '';
  let winChangedAt = prev?.winChangedAt || 0;
  let placeChangedAt = prev?.placeChangedAt || 0;

  if (Number.isFinite(winOdds) && prev && Number.isFinite(prev.win)) {
    if (winOdds < prev.win) {
      winDir = 'odds-firming';
      winChangedAt = now;
    } else if (winOdds > prev.win) {
      winDir = 'odds-drifting';
      winChangedAt = now;
    }
  }
  if (Number.isFinite(placeOdds) && prev && Number.isFinite(prev.place)) {
    if (placeOdds < prev.place) {
      placeDir = 'odds-firming';
      placeChangedAt = now;
    } else if (placeOdds > prev.place) {
      placeDir = 'odds-drifting';
      placeChangedAt = now;
    }
  }

  if (winDir && (now - winChangedAt) <= ODDS_SIGNAL_TTL_MS) classes.win = winDir;
  if (placeDir && (now - placeChangedAt) <= ODDS_SIGNAL_TTL_MS) classes.place = placeDir;

  lastOddsSnapshot.set(key, {
    win: Number.isFinite(winOdds) ? winOdds : prev?.win ?? null,
    place: Number.isFinite(placeOdds) ? placeOdds : prev?.place ?? null,
    winDir,
    placeDir,
    winChangedAt,
    placeChangedAt,
    updatedAt: now
  });
  return classes;
}







function parseReasonWinProb(reason){
  const m = String(reason || '').match(/p\s*=\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : NaN;
}

function parseReasonOdds(reason){
  const m = String(reason || '').match(/@\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i);
  return m ? Number(m[1]) : NaN;
}

function parseWinProbValue(val){
  if (val == null || val === '') return NaN;
  if (typeof val === 'number') return Number.isFinite(val) ? val : NaN;
  const match = String(val).match(/([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : NaN;
}

function whyCategoryMatch(row, why, opts = {}){
  const allowExotic = opts.allowExotic !== false;
  if (why === 'ALL') return true;
  const reason = String(row?.reason || '').toLowerCase();
  const type = String(row?.type || '').toLowerCase();
  const odds = extractRowOdds(row || {});
  const directSignal = Number(row?.signal_score);
  const signal = Number.isFinite(directSignal) ? directSignal : signalScore(reason, type, row?.selection || row?.runner || '');
  const exotic = ['top2','top3','top4','trifecta','multi'].includes(type);
  if (why === 'EXOTIC') return allowExotic ? exotic : false;
  if (exotic) return false;
  if (why === 'STRONG') {
    if (Number.isFinite(signal) && signal >= 60) return true;
    const winProbDirect = parseWinProbValue(row?.aiWinProb ?? row?.win_p);
    const winProb = Number.isFinite(winProbDirect) ? winProbDirect : parseReasonWinProb(row?.reason);
    const shortFav = Number.isFinite(odds) && odds > 0 && odds <= 3.2;
    const favContext = /favourite|favorite|market\s+leader|short\s+price/.test(reason);
    const formStatus = String(runnerFormSignal(row)?.status || '').toUpperCase();
    return shortFav && ((Number.isFinite(winProb) && winProb >= 22) || favContext || formStatus === 'HOT' || formStatus === 'SOLID');
  }
  if (why === 'VALUE') return (type === 'ew') || rowHasValueEdge(row) || /value|odds|long-odds/.test(reason);
  if (why === 'LONG') return rowMatchesLongProfile(row);
  return true;
}

function filterSuggestedByWhy(rows){
  const all = rows || [];
  const cacheKey = `${selectedWhy}|${all.length}`;
  if (filterCache.suggested.key === cacheKey && filterCache.suggested.version === latestDataVersion) {
    return filterCache.suggested.result;
  }
  if (selectedWhy === 'ALL') {
    filterCache.suggested = { key: cacheKey, version: latestDataVersion, result: all };
    return all;
  }

  const filtered = all.filter(r => whyCategoryMatch(r, selectedWhy, { allowExotic: true }));

  if (!filtered.length && selectedWhy === 'LONG') {
    const fallback = buildFallbackLongSuggestedRows();
    filterCache.suggested = { key: cacheKey, version: latestDataVersion, result: fallback };
    return fallback;
  }

  filterCache.suggested = { key: cacheKey, version: latestDataVersion, result: filtered };
  return filtered;
}


function filterInterestingByWhy(rows){
  const all = rows || [];
  const cacheKey = `${selectedWhy}|${all.length}`;
  if (filterCache.interesting.key === cacheKey && filterCache.interesting.version === latestDataVersion) {
    return filterCache.interesting.result;
  }
  if (selectedWhy === 'ALL') {
    filterCache.interesting = { key: cacheKey, version: latestDataVersion, result: all };
    return all;
  }
  const filtered = all.filter(r => whyCategoryMatch(r, selectedWhy, { allowExotic: false }));
  filterCache.interesting = { key: cacheKey, version: latestDataVersion, result: filtered };
  return filtered;
}

function filterMoversByWhy(rows){
  const all = rows || [];
  const cacheKey = `${selectedWhy}|${all.length}`;
  if (filterCache.movers.key === cacheKey && filterCache.movers.version === latestDataVersion) {
    return filterCache.movers.result;
  }
  if (selectedWhy === 'ALL') {
    filterCache.movers = { key: cacheKey, version: latestDataVersion, result: all };
    return all;
  }
  const filtered = all.filter(r => {
    const normalized = { ...r, odds: Number(r.toOdds || r.fromOdds || extractRowOdds(r) || 0), type: r.type || 'win' };
    return whyCategoryMatch(normalized, selectedWhy, { allowExotic: false });
  });
  filterCache.movers = { key: cacheKey, version: latestDataVersion, result: filtered };
  return filtered;
}
function isMultiType(t){
  const x = String(t || '').toLowerCase();
  return ['multi','top2','top3','top4','trifecta'].includes(x);
}

function signalScore(reason, type, selection=''){
  const p = parseReasonWinProb(reason);
  const odds = parseReasonOdds(reason);
  const t = String(type || '').toLowerCase();

  if (['top2','top3','top4','trifecta','multi'].includes(t)) {
    // For exotics, derive score only when leg probabilities are explicitly present.
    const probs = [...String(selection || '').matchAll(/\(([0-9]+(?:\.[0-9]+)?)%\)/g)].map(m => Number(m[1])).filter(Number.isFinite);
    if (probs.length) {
      const top = probs[0] || 0;
      const second = probs[1] || 0;
      const avgTopTwo = (top + second) / (second ? 2 : 1);
      return Math.max(10, Math.min(90, Math.round(avgTopTwo * 2.2)));
    }
    return NaN;
  }

  if (Number.isFinite(p) && Number.isFinite(odds) && odds > 0) {
    const implied = 100 / odds;
    return Math.max(5, Math.min(95, Math.round(50 + ((p - implied) * 2.2))));
  }
  if (Number.isFinite(p)) return Math.max(5, Math.min(95, Math.round(p * 2.4)));
  return NaN;
}

function signalClass(score){
  if (score >= 70) return 'comp-green';
  if (score >= 45) return 'comp-amber';
  return 'comp-red';
}

function reasonToEnglish(reason){
  const raw = String(reason || '');
  const p = parseReasonWinProb(raw);
  const o = parseReasonOdds(raw);
  if (Number.isFinite(p) && Number.isFinite(o)) {
    return `Model estimates about ${p.toFixed(1)}% win probability at market odds ${o.toFixed(2)}.`;
  }
  if (Number.isFinite(p)) return `Model estimates about ${p.toFixed(1)}% win probability.`;
  if (Number.isFinite(o)) return `Current market odds are ${o.toFixed(2)}.`;
  return raw || 'Insufficient quantified inputs (win%, odds, or sectionals) to justify a reliable signal.';
}

function marketEdgeText(rowOrReason){
  const reason = typeof rowOrReason === 'string' ? rowOrReason : String(rowOrReason?.reason || '');
  const pDirect = (typeof rowOrReason === 'object' && rowOrReason)
    ? parseWinProbValue(rowOrReason.aiWinProb ?? rowOrReason.win_p)
    : NaN;
  const p = Number.isFinite(pDirect) ? pDirect : parseReasonWinProb(reason);
  const oddsDirect = (typeof rowOrReason === 'object' && rowOrReason)
    ? Number(rowOrReason.odds)
    : NaN;
  const o = Number.isFinite(oddsDirect) ? oddsDirect : parseReasonOdds(reason);
  if (!Number.isFinite(p) || !Number.isFinite(o) || o <= 0) return 'Edge: n/a';
  const implied = 100 / o;
  const edgePts = p - implied;
  const sign = edgePts > 0 ? '+' : '';
  return `Edge: ${sign}${edgePts.toFixed(1)} pts`;
}

function signalColor(score){
  if (score >= 70) return '#c5ff00';
  if (score >= 45) return '#f5c066';
  return '#ff8a8a';
}

function signalMeterFromScore(score){
  const safeScore = Number.isFinite(Number(score)) ? Math.round(Number(score)) : 0;
  const cls = signalClass(safeScore);
  return `<div class='comp-box ${cls}'>Signal: ${safeScore}</div>`;
}

function signalMeter(reason, type, selection=''){
  const score = signalScore(reason, type, selection);
  return signalMeterFromScore(score);
}

function signalHint(reason, type, selection='', overrideScore=null){
  const rawScore = Number.isFinite(overrideScore) ? overrideScore : signalScore(reason, type, selection);
  const score = Number.isFinite(rawScore) ? Math.round(rawScore) : 0;
  const color = signalColor(score);
  return `<span style='display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid ${color};color:${color};font-size:11px;font-weight:700'>Signal: ${score}</span>`;
}

function inferRowCountry(row){
  const direct = normalizeCountryKey(row?.country);
  if (direct) return direct;
  const meetingNorm = normalizeMeetingKey(row?.meeting);
  if (!meetingNorm) return '';
  const raceNorm = normalizeRaceNumberValue(row?.race || row?.race_number);
  const sources = [racesCache, lastRacesSnapshot];
  if (raceNorm) {
    for (const source of sources) {
      const hit = (source || []).find(r => normalizeMeetingKey(r?.meeting) === meetingNorm && normalizeRaceNumberValue(r?.race_number || r?.race) === raceNorm);
      const country = normalizeCountryKey(hit?.country);
      if (country) return country;
    }
  }
  for (const source of sources) {
    const countries = Array.from(new Set((source || [])
      .filter(r => normalizeMeetingKey(r?.meeting) === meetingNorm)
      .map(r => normalizeCountryKey(r?.country))
      .filter(Boolean)));
    if (countries.length === 1) return countries[0];
  }
  return '';
}

function meetingMatches(input, raceNumber = '', country = ''){
  const row = (input && typeof input === 'object')
    ? input
    : { meeting: input, race: raceNumber, country };
  if (selectedMeeting !== 'ALL' && normalizeMeetingKey(row?.meeting) !== normalizeMeetingKey(selectedMeeting)) return false;
  if (selectedCountry === 'ALL') return true;
  const rowCountry = normalizeCountryKey(row?.country) || inferRowCountry(row);
  return !rowCountry || rowCountry === normalizeCountryKey(selectedCountry);
}

function baseSuggestedRows(rows){
  const all = (rows || [])
    .filter(r => meetingMatches(r))
    .filter(selectionIsUpcoming)
    .slice();
  const allowedTypes = new Set(['win','ew','top2','top3','top4','trifecta','multi']);
  const filtered = all.filter(r => allowedTypes.has(String(r.type || 'win').toLowerCase()));
  const typePriority = { win:0, ew:1, top2:2, top3:3, top4:4, trifecta:5, multi:6 };

  return filtered
    .sort((a,b) => {
      const aj = jumpsInToMinutes(a.jumpsIn);
      const bj = jumpsInToMinutes(b.jumpsIn);
      if (aj !== bj) return aj - bj;
      const ta = typePriority[String(a.type || 'win').toLowerCase()] ?? 10;
      const tb = typePriority[String(b.type || 'win').toLowerCase()] ?? 10;
      if (ta !== tb) return ta - tb;
      const ai = a.interesting ? 0 : 1;
      const bi = b.interesting ? 0 : 1;
      return ai - bi;
    });
}

function orderRowsAroundSelectedRace(rows){
  const list = Array.isArray(rows) ? rows.slice() : [];
  const selectedRaceNo = (selectedRace && meetingMatches(selectedRace.meeting))
    ? Number(String(selectedRace.race_number || selectedRace.race || '').replace(/^R/i,''))
    : NaN;
  return list.sort((a,b) => {
    const aj = jumpsInToMinutes(a.jumpsIn || a.eta);
    const bj = jumpsInToMinutes(b.jumpsIn || b.eta);
    if (Number.isFinite(selectedRaceNo)) {
      const aRace = Number(String(a.race || a.race_number || '').replace(/^R/i,''));
      const bRace = Number(String(b.race || b.race_number || '').replace(/^R/i,''));
      const aBucket = Number.isFinite(aRace)
        ? (aRace === selectedRaceNo ? 0 : (aRace > selectedRaceNo ? 1 : 2))
        : 3;
      const bBucket = Number.isFinite(bRace)
        ? (bRace === selectedRaceNo ? 0 : (bRace > selectedRaceNo ? 1 : 2))
        : 3;
      if (aBucket !== bBucket) return aBucket - bBucket;
      if (aBucket === 2 && Number.isFinite(aRace) && Number.isFinite(bRace) && aRace !== bRace) return aRace - bRace;
      if ((aBucket === 0 || aBucket === 1) && Number.isFinite(aRace) && Number.isFinite(bRace) && aRace !== bRace) return aRace - bRace;
    }
    return aj - bj;
  });
}

function renderSuggested(rows){
  const table = $('suggestedTable');
  table.innerHTML = '';
  const suggestedSource = (rows && rows.length) ? rows : (latestSuggestedBets || []);
  let mainRows = orderRowsAroundSelectedRace(baseSuggestedRows(suggestedSource));
  if (!mainRows.length && selectedMeeting && selectedMeeting !== 'ALL') {
    const allowedTypes = new Set(['win','ew','top2','top3','top4','trifecta','multi']);
    mainRows = orderRowsAroundSelectedRace((latestSuggestedBets || suggestedSource)
      .filter(r => meetingMatches(r))
      .filter(r => allowedTypes.has(String(r.type || 'win').toLowerCase())));
  }
  if (!mainRows.length && (!selectedMeeting || selectedMeeting === 'ALL')) {
    const allowedTypes = new Set(['win','ew','top2','top3','top4','trifecta','multi']);
    mainRows = orderRowsAroundSelectedRace((latestSuggestedBets || suggestedSource)
      .filter(r => allowedTypes.has(String(r.type || 'win').toLowerCase())));
  }

  if (!mainRows.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    const msg = selectedWhy === 'EXOTIC'
      ? 'Exotic signals are shown in the Multis tab.'
      : (selectedWhy === 'ALL' ? 'No current suggested bets' : `No suggested bets match WHY: ${displayWhy(selectedWhy)}`);
    empty.innerHTML = `<div style='grid-column:1/-1'>${msg}</div>`;
    table.appendChild(empty);
    return;
  }

  const header = document.createElement('div');
  header.className='row header';
  header.innerHTML = `<div>Race</div><div>Selection</div><div>Type</div><div>Intent</div><div class='right'>Why</div>`;
  table.appendChild(header);

  const norm = (s)=>String(s||'').replace(/^\d+\.\s*/, '').trim().toLowerCase();
  const tierOrder = { bet_now: 0, queue: 1, watchlist: 2, blocked: 3 };
  const groupedRows = mainRows.slice().sort((a,b) => {
    const at = tierOrder[String(a.capitalTier || 'blocked')] ?? 9;
    const bt = tierOrder[String(b.capitalTier || 'blocked')] ?? 9;
    if (at !== bt) return at - bt;
    return jumpsInToMinutes(a.jumpsIn || a.eta) - jumpsInToMinutes(b.jumpsIn || b.eta);
  });
  let lastTier = null;

  groupedRows.forEach(r=>{
    const tier = String(r.capitalTier || 'blocked');
    if (tier !== lastTier) {
      const tierRow = document.createElement('div');
      tierRow.className = 'row header';
      const title = tier === 'bet_now' ? 'Bet Now' : tier === 'queue' ? 'Queue' : tier === 'watchlist' ? 'Watchlist' : 'Blocked';
      tierRow.innerHTML = `<div style='grid-column:1/-1'>${title}</div>`;
      table.appendChild(tierRow);
      lastTier = tier;
    }

    const row = document.createElement('div');
    row.className='row';

    const cmp = (latestAiCompare || []).find(c =>
      String(c.meeting || '').trim().toLowerCase() === String(r.meeting || '').trim().toLowerCase() &&
      String(c.race || '') === String(r.race || '') &&
      norm(c.selection) === norm(r.selection)
    );
    const alreadyPlaced = cmp && Number(cmp.placedStake || 0) >= Number(r.stake || 0);
    const tagPool = [];
    if (alreadyPlaced) tagPool.push(`<span class='tag value'>already placed</span>`);
    const inheritedInteresting = inheritInterestingTags(r.meeting, r.race, r.selection);
    const moverTags = inheritMoveTags(r.meeting, r.race, r.selection);
    const t = String(r.type || '').toLowerCase();
    if (r.interesting && !inheritedInteresting.length) tagPool.push(`<span class='tag ew'>interesting</span>`);
    if (t === 'top4') tagPool.push(`<span class='tag top4'>TOP4</span>`);
    if (tier === 'bet_now') tagPool.push(`<span class='tag strong'>BET NOW</span>`);
    else if (tier === 'queue') tagPool.push(`<span class='tag value'>QUEUE</span>`);
    else if (tier === 'watchlist') tagPool.push(`<span class='tag ew'>WATCH</span>`);
    else tagPool.push(`<span class='tag'>BLOCKED</span>`);
    tagPool.push(...inheritedInteresting, ...moverTags);
    const seenTags = new Set();
    const tags = tagPool.filter(tag => {
      if (!tag || seenTags.has(tag)) return false;
      seenTags.add(tag);
      return true;
    });
    const tag = tags.length ? ` ${tags.join(' ')}` : '';

    const odds = Number.isFinite(Number(r.odds)) ? Number(r.odds) : parseReasonOdds(r.reason);
    const suggestedSignalRaw = Number(r.signal_score);
    const suggestedSignal = Number.isFinite(suggestedSignalRaw)
      ? suggestedSignalRaw
      : (isMultiType(r.type) ? exoticSignalScore(r) : signalScore(r.reason, r.type, r.selection));
    const intentText = escapeHtml(r.capitalIntent || 'Blocked');
    const actionNote = r.executionBlockReason ? `Blocked: ${escapeHtml(String(r.executionBlockReason).replace(/_/g,' '))}` : escapeHtml(r.recommendedAction || '');
    row.innerHTML = `
      <div><button class='bet-btn race-cell-btn suggested-race-btn' data-meeting='${r.meeting}' data-race='${r.race}'><span class="badge">${r.meeting}</span> R${r.race}</button></div>
      <div><button class='bet-btn suggested-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-selection='${escapeAttr(cleanRunnerText(r.selection))}' data-reason='${escapeAttr(r.reason||'')}'><span class='bet-icon'>💡</span>${escapeHtml(cleanRunnerText(r.selection))}${tag}</button></div>
      <div>${r.type}</div>
      <div><div><b>${intentText}</b></div><div class='sub'>${actionNote}</div><div class='sub'>Odds: ${Number.isFinite(odds) ? odds.toFixed(2) : '—'} · ${marketEdgeText(r)}</div>${buildJumpCell(r.meeting, r.race, r.jumpsIn || 'upcoming')}</div>
      <div class='right'>${signalMeterFromScore(suggestedSignal)}<div class='sub suggested-note' style='margin-top:6px'>${reasonToEnglish(r.reason)}</div></div>
    `;
    table.appendChild(row);
  });

  attachSuggestedHandlers();
  makeSelectionsDraggable();
}

function exoticSignalScore(row){
  const raw = String(row.selection || '');
  const parts = raw.replace(/>/g,'/').replace(/ x /gi,'/').split('/').map(s=>s.trim()).filter(Boolean).slice(0,4);
  if (!parts.length) return signalScore(row.reason, row.type, row.selection);

  const race = (racesCache || []).find(x => String(x.meeting||'').trim().toLowerCase() === String(row.meeting||'').trim().toLowerCase() && String(x.race_number||'') === String(row.race||''));

  // 1) Try direct race runner odds from races cache.
  let probs = [];
  if (race && Array.isArray(race.runners)) {
    probs = parts.map(name => {
      const n = normalizeRunnerName(name);
      const rr = race.runners.find(r => {
        const rn = normalizeRunnerName(String(r.name || r.runner_name || '').trim());
        return rn === n || rn.includes(n) || n.includes(rn);
      });
      const od = Number(rr?.odds || rr?.fixed_win || 0);
      if (!Number.isFinite(od) || od <= 0) return null;
      return 100 / od;
    }).filter(v => Number.isFinite(v));
  }

  // 2) Fallback: infer from same-race Win rows in suggested bets.
  if (!probs.length) {
    const sameRaceWinRows = (latestSuggestedBets || []).filter(x =>
      String(x.meeting || '').trim().toLowerCase() === String(row.meeting || '').trim().toLowerCase() &&
      String(x.race || '') === String(row.race || '') &&
      String(x.type || '').toLowerCase() === 'win'
    );
    probs = parts.map(name => {
      const n = normalizeRunnerName(name);
      const hit = sameRaceWinRows.find(w => {
        const wn = normalizeRunnerName(String(w.selection || '').trim());
        return wn === n || wn.includes(n) || n.includes(wn);
      });
      if (!hit) return null;
      const wp = Number(hit.aiWinProb);
      if (Number.isFinite(wp) && wp > 0) return wp;
      const od = parseReasonOdds(hit.reason);
      if (Number.isFinite(od) && od > 0) return 100 / od;
      return null;
    }).filter(v => Number.isFinite(v));
  }

  if (!probs.length) return signalScore(row.reason, row.type, row.selection);
  const avg = probs.slice(0,2).reduce((a,b)=>a+b,0) / Math.min(2, probs.length);
  return Math.max(10, Math.min(90, Math.round(avg * 2.2)));
}

function renderMultis(rows){
  const table = $('multisTable');
  if (!table) return;
  table.innerHTML = '';
  const multiSource = (rows && rows.length) ? rows : (latestSuggestedBets || []);
  let multiRows = (multiSource || [])
    .filter(r => isMultiType(r.type))
    .filter(r => meetingMatches(r))
    .slice()
    .sort((a,b) => jumpsInToMinutes(a.jumpsIn) - jumpsInToMinutes(b.jumpsIn));

  if (!multiRows.length) {
    const winRows = (latestSuggestedBets || [])
      .filter(r => String(r.type || '').toLowerCase() === 'win' && meetingMatches(r))
      .slice()
      .sort((a,b) => scoreStrategyCandidate(b) - scoreStrategyCandidate(a))
      .slice(0, 3);
    if (winRows.length >= 2) {
      const race = winRows[0].race || winRows[0].race_number || '—';
      const meeting = winRows[0].meeting || selectedMeeting;
      const sel = winRows.map(x => cleanRunnerText(x.selection || x.runner || x.name || '')).filter(Boolean).slice(0,3).join(' / ');
      multiRows = [{
        meeting,
        race,
        selection: sel,
        type: 'top3',
        reason: 'Fallback exotics from strongest win selections',
        jumpsIn: winRows[0].jumpsIn || 'upcoming'
      }];
    }
  }

  if (!multiRows.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    empty.innerHTML = `<div style='grid-column:1/-1'>No multis available</div>`;
    table.appendChild(empty);
    return;
  }

  const header = document.createElement('div');
  header.className = 'row header';
  header.innerHTML = `<div>Race</div><div>Selection</div><div>Type</div><div>Odds</div><div class='right'>Why</div>`;
  table.appendChild(header);

  const raceMap = new Map((racesCache || []).map(x => [`${String(x.meeting||'').trim().toLowerCase()}|${String(x.race_number||'')}`, x]));
  const winProbMap = new Map();
  (latestSuggestedBets || []).forEach(x => {
    if (String(x.type || '').toLowerCase() !== 'win') return;
    const k = `${String(x.meeting || '').trim().toLowerCase()}|${String(x.race || '')}|${normalizeRunnerName(String(x.selection || '').trim())}`;
    const wp = Number(x.aiWinProb);
    const prob = Number.isFinite(wp) && wp > 0 ? wp : (Number.isFinite(parseReasonOdds(x.reason)) ? (100 / parseReasonOdds(x.reason)) : NaN);
    if (Number.isFinite(prob)) winProbMap.set(k, prob);
  });

  function exoticSignalScoreFast(row){
    const raw = String(row.selection || '');
    const parts = raw.replace(/>/g,'/').replace(/ x /gi,'/').split('/').map(s=>s.trim()).filter(Boolean).slice(0,4);
    if (!parts.length) return signalScore(row.reason, row.type, row.selection);

    const rk = `${String(row.meeting||'').trim().toLowerCase()}|${String(row.race||'')}`;
    const race = raceMap.get(rk);
    let probs = [];

    if (race && Array.isArray(race.runners)) {
      probs = parts.map(name => {
        const n = normalizeRunnerName(name);
        const rr = race.runners.find(z => {
          const rn = normalizeRunnerName(String(z.name || z.runner_name || '').trim());
          return rn === n || rn.includes(n) || n.includes(rn);
        });
        const od = Number(rr?.odds || rr?.fixed_win || 0);
        return (Number.isFinite(od) && od > 0) ? (100 / od) : null;
      }).filter(v => Number.isFinite(v));
    }

    if (!probs.length) {
      probs = parts.map(name => winProbMap.get(`${rk}|${normalizeRunnerName(name)}`)).filter(v => Number.isFinite(v));
    }

    if (!probs.length) return signalScore(row.reason, row.type, row.selection);
    const avg = probs.slice(0,2).reduce((a,b)=>a+b,0) / Math.min(2, probs.length);
    return Math.max(10, Math.min(90, Math.round(avg * 2.2)));
  }

  const frag = document.createDocumentFragment();
  multiRows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'row';
    const odds = parseReasonOdds(r.reason);
    const exScore = exoticSignalScoreFast(r);
    row.innerHTML = `
      <div><button class='bet-btn race-cell-btn multi-race-btn' data-meeting='${r.meeting}' data-race='${r.race}'><span class="badge">${r.meeting}</span> R${r.race}</button></div>
      <div><button class='bet-btn multi-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-selection='${escapeAttr(cleanRunnerText(r.selection))}' data-reason='${(r.reason||'').replace(/"/g,'&quot;')}'><span class='bet-icon'>🧩</span>${cleanRunnerText(r.selection)}</button></div>
      <div>${r.type}</div>
      <div><div class='sub'>Odds: ${Number.isFinite(odds) ? odds.toFixed(2) : '—'}</div><div class='sub'>${marketEdgeText(r)}</div>${buildJumpCell(r.meeting, r.race, r.jumpsIn || 'upcoming')}</div>
      <div class='right'>${signalMeterFromScore(exScore)}<div class='sub suggested-note' style='margin-top:6px'>${r.reason || ''}</div></div>
    `;
    frag.appendChild(row);
  });
  table.appendChild(frag);
  makeSelectionsDraggable();
  attachMultisHandlers();
}

function deriveEwRunnerForRace(race){
  if (!race || !Array.isArray(race.runners) || !race.runners.length) return null;
  const oddsOf = (r) => {
    const v = Number(r?.fixed_win || r?.tote_win || r?.odds || r?.price || r?.win_price || 0);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  };
  const placeOddsOf = (r) => {
    const v = Number(r?.fixed_place || r?.tote_place || r?.place_odds || r?.place_price || 0);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  };
  const runners = race.runners.slice();

  const model = runners.map(r => {
    const ro = oddsOf(r);
    let s = Number.isFinite(ro) ? 1 / Number(ro) : 0;
    if (r.barrier && r.barrier <= 4) s *= 1.03;
    if (r.barrier && r.barrier >= 10) s *= 0.97;
    if (['Leader','Pace'].includes(r.speedmap)) s *= 1.02;
    const formSignal = runnerFormSignal(r);
    if (formSignal?.status) {
      const formBoostMap = { HOT: 1.18, SOLID: 1.10, MIXED: 0.97, COLD: 0.9 };
      const boost = formBoostMap[formSignal.status];
      if (boost) {
        s = (s === 0 && (formSignal.status === 'HOT' || formSignal.status === 'SOLID')) ? 0.02 * boost : s * boost;
      }
    }
    return { name: r.name || r.runner_name || '', score: s };
  }).filter(x => x.name && x.score > 0);
  const sumM = model.reduce((a,b)=>a+b.score,0) || 1;
  model.forEach(x=>x.p = x.score / sumM);
  const modelProbMap = new Map(model.map(entry => [normalizeRunnerName(entry.name), entry.p]));

  const ewCandidateMetrics = runners.map(r => {
    const runnerName = cleanRunnerText(r.name || r.runner_name || '');
    if (!runnerName) return null;
    const odds = oddsOf(r);
    const placeOdds = placeOddsOf(r);
    if (!Number.isFinite(odds)) return null;
    const norm = normalizeRunnerName(runnerName);
    const winProb = modelProbMap.get(norm) || 0;
    const placePct = modeledPlacePct(r, { placeOddsGetter: placeOddsOf });
    const placeProb = Number.isFinite(placePct) ? placePct / 100 : 0;
    const implied = Number.isFinite(placeOdds) ? (100 / placeOdds) : NaN;
    const edge = (Number.isFinite(placePct) && Number.isFinite(implied)) ? (placePct - implied) : NaN;
    const formSignal = runnerFormSignal(r);
    const formStatus = formSignal?.status || 'UNKNOWN';
    const formBoost = formStatus === 'HOT' ? 6 : formStatus === 'SOLID' ? 3 : formStatus === 'COLD' ? -5 : 0;
    const volatilityPenalty = Number.isFinite(odds) && odds > 12 ? (odds - 12) * 1.5 : 0;
    const score = (winProb * 180) + (placeProb * 140) + (Number.isFinite(edge) ? edge * 1.2 : 0) + formBoost - volatilityPenalty;
    return { runnerName, edge, odds, winProb, placeProb, score, runner: r };
  }).filter(Boolean);

  const ewCandidates = ewCandidateMetrics
    .filter(item => item.odds >= 4 && item.odds <= 15 && (item.edge == null || item.edge >= 1) && item.winProb >= 0.05 && item.placeProb >= 0.25)
    .sort((a,b)=>b.score - a.score);
  let ewRunner = ewCandidates.length ? ewCandidates[0] : null;
  if (!ewRunner) {
    const valueFallback = ewCandidateMetrics
      .filter(item => item.odds >= 3 && item.odds <= 15 && item.winProb >= 0.02)
      .sort((a,b) => (Number(b.edge || 0) - Number(a.edge || 0)) || (b.winProb - a.winProb))[0];
    if (valueFallback) ewRunner = valueFallback;
  }
  if (!ewRunner) {
    const top = ewCandidateMetrics.sort((a,b)=>b.winProb - a.winProb)[0];
    if (top) ewRunner = top;
  }
  if (!ewRunner) return null;
  return ewRunner;
}

function buildEwCandidatesFromRaces(meeting){
  const meetingNorm = String(meeting || '').trim().toLowerCase();
  const races = (racesCache || lastRacesSnapshot || []).filter(r => !meetingNorm || String(r.meeting || '').trim().toLowerCase() === meetingNorm);
  const now = Date.now();
  return races.map(race => {
    const startRaw = race?.advertised_start ?? race?.start_time_nz ?? race?.start_time;
    const startTs = parseTimeValue(startRaw);
    if (Number.isFinite(startTs) && startTs < now - 2 * 60 * 1000) return null;
    const ew = deriveEwRunnerForRace(race);
    if (!ew || !ew.runnerName) return null;
    const odds = Number.isFinite(ew.odds) ? ew.odds : null;
    return {
      meeting: race.meeting,
      race: race.race_number,
      selection: ew.runnerName,
      type: 'ew',
      odds,
      jockey: ew.runner?.jockey || null,
      reason: `EW tag (model/place edge)`
    };
  }).filter(Boolean);
}

function buildWinCandidatesFromRaces(meeting){
  const meetingNorm = String(meeting || '').trim().toLowerCase();
  const races = (racesCache || lastRacesSnapshot || []).filter(r => !meetingNorm || String(r.meeting || '').trim().toLowerCase() === meetingNorm);
  const now = Date.now();
  const rows = [];

  races.forEach(race => {
    const startRaw = race?.advertised_start ?? race?.start_time_nz ?? race?.start_time;
    const startTs = parseTimeValue(startRaw);
    if (Number.isFinite(startTs) && startTs < now - 2 * 60 * 1000) return;

    const ranked = (race.runners || [])
      .map(r => {
        const odds = Number(r?.odds || r?.fixed_win || r?.tote_win || 0);
        const winP = Number(r?.win_p);
        const implied = Number.isFinite(odds) && odds > 0 ? (100 / odds) : null;
        const formSignal = runnerFormSignal(r);
        const formBoost = formSignal?.status === 'HOT' ? 4 : formSignal?.status === 'SOLID' ? 2 : formSignal?.status === 'COLD' ? -3 : 0;
        const score = (Number.isFinite(winP) ? winP : (Number.isFinite(implied) ? implied : 0)) + formBoost;
        const signal = (Number.isFinite(winP) && Number.isFinite(implied)) ? Math.max(0, Math.min(100, 50 + ((winP - implied) * 2))) : NaN;
        return {
          runner: r,
          name: cleanRunnerText(r?.name || r?.runner_name || ''),
          odds,
          winP,
          implied,
          signal,
          score
        };
      })
      .filter(x => x.name && (Number.isFinite(x.odds) || Number.isFinite(x.winP) || Number.isFinite(x.implied)))
      .filter(x => !Number.isFinite(x.odds) || x.odds <= 12)
      .filter(x => Number.isFinite(x.signal) ? x.signal >= 55 : true)
      .sort((a,b) => b.score - a.score)
      .slice(0, 2);

    ranked.forEach(x => {
      const prob = Number.isFinite(x.winP) ? x.winP : x.implied;
      rows.push({
        meeting: race.meeting,
        race: race.race_number,
        selection: x.name,
        type: 'win',
        odds: Number.isFinite(x.odds) ? x.odds : null,
        signal_score: Number.isFinite(x.signal) ? Number(x.signal.toFixed(1)) : null,
        jockey: x.runner?.jockey || null,
        reason: `model p=${Number.isFinite(prob) ? prob.toFixed(1) : 'n/a'}% @ ${Number.isFinite(x.odds) ? x.odds.toFixed(2) : 'n/a'} (race cache)`
      });
    });
  });

  return rows;
}

function buildStrategyPlanCandidates(type){
  const meeting = selectedMeeting || 'ALL';
  const suggested = (latestSuggestedBets || [])
    .filter(selectionIsUpcoming)
    .filter(r => meeting === 'ALL' || meetingMatches(r));
  const interesting = (latestInterestingRows || [])
    .filter(selectionIsUpcoming)
    .filter(r => meeting === 'ALL' || meetingMatches(r));

  if (type === 'ew') {
    const ewRows = suggested.filter(r => String(r.type || '').toLowerCase() === 'ew');
    if (ewRows.length) return ewRows;
    const fallback = suggested.filter(r => {
      const odds = parseReasonOdds(r.reason);
      return String(r.type || '').toLowerCase() === 'win' && Number.isFinite(odds) && odds >= 8;
    }).map(r => ({ ...r, type: 'ew' }));
    if (fallback.length) return fallback;
    const ewFromRaces = buildEwCandidatesFromRaces(meeting);
    return ewFromRaces.length ? ewFromRaces : fallback;
  }
  if (type === 'win') {
    const winRows = suggested.filter(r => String(r.type || '').toLowerCase() === 'win');
    if (winRows.length) {
      const analysisLedRows = winRows.filter(r => {
        const edge = strategyEdgePts(r);
        const signal = Number.isFinite(r.signal_score) ? r.signal_score : signalScore(r.reason, r.type, r.selection);
        const odds = extractRowOdds(r);
        return Number.isFinite(edge) && edge > 0 && Number(signal) >= 50 && (!Number.isFinite(odds) || odds <= 12);
      });
      if (analysisLedRows.length) return analysisLedRows;
      const safetyRows = winRows.filter(r => {
        const edge = strategyEdgePts(r);
        const signal = Number.isFinite(r.signal_score) ? r.signal_score : signalScore(r.reason, r.type, r.selection);
        const odds = extractRowOdds(r);
        return Number(signal) >= 55 && (Number.isFinite(edge) ? edge >= -1 : true) && (!Number.isFinite(odds) || odds <= 12);
      });
      return safetyRows.length ? safetyRows : buildWinCandidatesFromRaces(meeting);
    }
    return buildWinCandidatesFromRaces(meeting);
  }
  if (type === 'long') {
    const longRows = suggested.filter(r => String(r.type || '').toLowerCase() === 'win' && rowMatchesLongProfile(r));
    if (longRows.length) return longRows;
    const fallback = buildFallbackLongSuggestedRows();
    return fallback.length ? fallback : longRows;
  }
  if (type === 'blended') {
    const grouped = new Map();
    suggested.forEach(r => {
      const key = `${r.meeting}|${r.race}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    });
    const picks = [];
    grouped.forEach(rows => {
      const sorted = rows.slice().sort((a,b)=> scoreStrategyCandidate(b) - scoreStrategyCandidate(a));
      const primary = sorted.find(r => {
        const edge = strategyEdgePts(r);
        const signal = Number.isFinite(r.signal_score) ? r.signal_score : signalScore(r.reason, r.type, r.selection);
        return String(r.type || '').toLowerCase() === 'win' && Number.isFinite(edge) && edge > 0 && Number(signal) >= 50;
      }) || sorted[0];
      if (primary) picks.push(primary);
      const secondary = sorted.filter(r => r !== primary).slice(0, primary ? 1 : 2);
      picks.push(...secondary);
    });
    if (picks.length) return picks;
    return buildWinCandidatesFromRaces(meeting);
  }

  if (type === 'exotics') {
    const exoticTypes = new Set(['top2','top3','top4','trifecta','multi']);
    const exoticRows = suggested.filter(r => exoticTypes.has(String(r.type || '').toLowerCase()));
    if (exoticRows.length) return exoticRows;
    const interestingExotics = (latestInterestingRows || [])
      .filter(selectionIsUpcoming)
      .filter(r => meeting === 'ALL' || meetingMatches(r))
      .filter(r => {
        const text = String(r.reason || r.ai_commentary || '').toLowerCase();
        return /top\s*2|top\s*3|trifecta|exotic|multi/.test(text);
      })
      .map(r => ({
        meeting: r.meeting,
        race: r.race,
        selection: r.runner || r.selection || r.name,
        type: 'top3',
        reason: r.reason || r.ai_commentary || 'Exotic setup from runner profile context',
        odds: r.odds
      }));
    if (interestingExotics.length) return interestingExotics;

    const meetingNorm = String(meeting || '').trim().toLowerCase();
    const races = (racesCache || lastRacesSnapshot || []).filter(r => !meetingNorm || String(r.meeting || '').trim().toLowerCase() === meetingNorm);
    const fallback = [];
    races.forEach(race => {
      const ranked = (race.runners || [])
        .map(runner => {
          const odds = Number(runner?.odds || runner?.fixed_win || runner?.tote_win || 0);
          const winP = Number(runner?.win_p);
          const implied = Number.isFinite(odds) && odds > 0 ? (100 / odds) : null;
          const signal = runnerFormSignal(runner);
          const formBoost = signal?.status === 'HOT' ? 4 : signal?.status === 'SOLID' ? 2 : signal?.status === 'COLD' ? -3 : 0;
          const score = (Number.isFinite(winP) ? winP : (Number.isFinite(implied) ? implied : 0)) + formBoost;
          return { runner, name: cleanRunnerText(runner?.name || runner?.runner_name || ''), score, odds };
        })
        .filter(x => x.name)
        .sort((a,b) => b.score - a.score)
        .slice(0, 3);
      if (ranked.length < 2) return;
      const selection = ranked.map(x => x.name).join(' / ');
      fallback.push({
        meeting: race.meeting,
        race: race.race_number,
        selection,
        type: 'top3',
        reason: 'Auto Top3 (model + form rank) fallback',
        odds: ranked[0]?.odds || null
      });
    });
    return fallback;
  }

  // odds/value runner strategy
  const oddsRows = suggested.filter(r => {
    const odds = parseReasonOdds(r.reason);
    const reason = String(r.reason || '').toLowerCase();
    return String(r.type || '').toLowerCase() === 'win'
      && ((Number.isFinite(odds) && odds >= 4.5) || reason.includes('value') || reason.includes('long-odds'));
  });
  const interestingRows = interesting.map(r => ({
    meeting: r.meeting,
    race: r.race,
    selection: r.runner || r.selection || r.name,
    type: 'win',
    reason: r.reason || r.ai_commentary || '',
    odds: r.odds
  }));
  const combined = [...oddsRows, ...interestingRows];
  if (combined.length) return combined;
  return buildWinCandidatesFromRaces(meeting).filter(r => Number(r.odds || 0) >= 4.5);
}

function strategyEdgePts(row){
  const rowWinProb = parseWinProbValue(row?.aiWinProb ?? row?.win_p);
  const winProb = Number.isFinite(rowWinProb) ? rowWinProb : parseReasonWinProb(row?.reason);
  const odds = Number(row?.odds);
  const parsedOdds = parseReasonOdds(row?.reason);
  const useOdds = Number.isFinite(odds) ? odds : parsedOdds;
  const implied = Number.isFinite(useOdds) && useOdds > 0 ? (100 / useOdds) : NaN;
  return Number.isFinite(winProb) && Number.isFinite(implied) ? (winProb - implied) : NaN;
}

function scoreStrategyCandidate(row){
  const directSignal = Number(row?.signal_score);
  if (Number.isFinite(directSignal)) return directSignal;
  const derivedSignal = signalScore(row?.reason || '', row?.type || 'win', row?.selection || row?.runner || '');
  if (Number.isFinite(derivedSignal)) return derivedSignal;
  const rowWinProb = parseWinProbValue(row?.aiWinProb ?? row?.win_p);
  const winProb = Number.isFinite(rowWinProb) ? rowWinProb : parseReasonWinProb(row.reason);
  const odds = Number(row?.odds);
  const parsedOdds = parseReasonOdds(row.reason);
  const useOdds = Number.isFinite(odds) ? odds : parsedOdds;
  const implied = Number.isFinite(useOdds) && useOdds > 0 ? (100 / useOdds) : null;
  if (Number.isFinite(winProb)) return winProb;
  if (Number.isFinite(implied)) return implied;
  return 0;
}

function renderStrategySummary(stats){
  const el = $('strategySummary');
  if (!el) return;
  if (!stats) {
    el.innerHTML = '<div class="sub">No strategy data yet.</div>';
    return;
  }
  const blendedConfidence = (Number.isFinite(stats.winProb) || Number.isFinite(stats.avgSignal))
    ? ((Number.isFinite(stats.winProb) ? stats.winProb : 0) * 0.6 + (Number.isFinite(stats.avgSignal) ? stats.avgSignal : 0) * 0.4)
    : null;
  const coverage = Math.min(1, ((Number(stats.winProbCoverage) || 0) * 0.6) + ((Number(stats.signalCoverage) || 0) * 0.4));
  const volatilityPenalty = Number.isFinite(stats.oddsStd) ? Math.min(20, stats.oddsStd * 3) : 8;
  const coveragePenalty = Math.max(0, (1 - coverage) * 35);
  const baseRisk = blendedConfidence != null ? (100 - blendedConfidence) : 65;
  const risk = Math.max(5, Math.min(95, baseRisk + volatilityPenalty + coveragePenalty));
  const meter = (val) => `<div class='strategy-meter'><span style='width:${Math.min(100, Math.max(0, val || 0))}%'></span></div>`;
  el.innerHTML = `
    <div class='strategy-card'>
      <div class='label'>Selections</div>
      <div class='value'>${stats.count}</div>
    </div>
    <div class='strategy-card'>
      <div class='label'>Avg Win %</div>
      <div class='value'>${stats.winProb != null ? stats.winProb.toFixed(1)+'%' : '—'}</div>
      ${meter(stats.winProb)}
    </div>
    <div class='strategy-card'>
      <div class='label'>Avg Odds</div>
      <div class='value'>${stats.avgOdds != null ? stats.avgOdds.toFixed(2) : '—'}</div>
    </div>
    <div class='strategy-card'>
      <div class='label'>Risk Index</div>
      <div class='value'>${risk != null ? risk.toFixed(1)+'%' : '—'}</div>
      ${meter(risk)}
    </div>
  `;
}

function renderStrategyOutput(rows){
  const el = $('strategyOutput');
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="sub">No selections available for this strategy.</div>';
    return;
  }

  const rankByRunnerKey = new Map();
  const grouped = new Map();
  rows.forEach(r => {
    const key = `${r.meeting || selectedMeeting}|${r.race || r.race_number || '—'}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  });
  grouped.forEach((list, raceKey) => {
    list.slice().sort((a,b) => scoreStrategyCandidate(b) - scoreStrategyCandidate(a)).forEach((row, idx) => {
      const runnerKey = normalizeRunnerName(cleanRunnerText(row.selection || row.runner || row.name || ''));
      rankByRunnerKey.set(`${raceKey}|${runnerKey}`, idx + 1);
    });
  });

  el.innerHTML = rows.map(r => {
    const odds = parseReasonOdds(r.reason) || Number(r.odds || 0);
    const parsedWinProb = parseReasonWinProb(r.reason);
    const rawWinProb = Number.isFinite(parsedWinProb) ? parsedWinProb : scoreStrategyCandidate(r);
    const winProb = Number.isFinite(rawWinProb) ? Math.max(0, Math.min(100, rawWinProb)) : null;
    const signal = Number.isFinite(r.signal_score) ? r.signal_score : signalScore(r.reason, r.type, r.selection);
    const meeting = r.meeting || selectedMeeting;
    const raceNo = r.race || r.race_number || '—';
    const selLabel = cleanRunnerText(r.selection || r.runner || r.name || 'Selection');
    const race = lookupRace(meeting, raceNo);
    const selNorm = normalizeRunnerName(selLabel.replace(/^\d+\.\s*/, '').trim());
    const rankKey = `${meeting}|${raceNo}|${selNorm}`;
    const rank = rankByRunnerKey.get(rankKey);
    const rankBadge = rank === 1 ? `<span class='badge'>1st Pick</span>` : (rank === 2 ? `<span class='badge'>2nd Pick</span>` : '');
    const runner = race && selNorm ? (race.runners || []).find(x => {
      const nm = normalizeRunnerName(String(x.name || x.runner_name || '').trim());
      return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
    }) : null;
    const jockey = r.jockey || runner?.jockey || '—';
    const raceKey = race?.key || '';
    const jockeyCell = jockey && jockey !== '—'
      ? `<button class='jockey-profile-btn' data-jockey='${escapeAttr(String(jockey))}' data-race-key='${escapeAttr(String(raceKey))}'>${escapeHtml(String(jockey))}</button>`
      : `<span>${escapeHtml(String(jockey))}</span>`;
    return `
      <div class='strategy-pick'>
        <h4>
          <button class='bet-btn suggested-btn strategy-btn' data-meeting='${meeting}' data-race='${raceNo}' data-selection='${escapeAttr(selLabel)}' data-reason='${escapeAttr(r.reason || '')}'>
            <span class='bet-icon'>🐎</span>${escapeHtml(selLabel)}
          </button>
        </h4>
        <div class='meta'><span class='badge'>${meeting}</span> R${raceNo} · ${r.type || 'Win'} ${rankBadge}</div>
        <div class='sub'><span class='strategy-inline-label'>Jockey</span>${jockeyCell}</div>
        <div class='tagline'>Win% ${winProb ? winProb.toFixed(1)+'%' : '—'} · Odds ${Number.isFinite(odds) && odds > 0 ? odds.toFixed(2) : '—'}</div>
        <div class='signal-spot'>Signal ${Number.isFinite(signal) ? signal.toFixed(1) : '—'}</div>
        <div class='sub'>${strategyNarrativeHtml(r)}</div>
      </div>`;
  }).join('');

  attachSuggestedHandlers();
  makeSelectionsDraggable();
}

function buildStrategyRaceModelMap(race){
  if (!race || !Array.isArray(race.runners)) return new Map();
  const cacheKey = `${normalizeMeetingNameText(race.meeting)}|${String(race.race_number || race.race || '').trim()}`;
  if (strategyRaceModelCache.has(cacheKey)) return strategyRaceModelCache.get(cacheKey);

  const meetingBias = userMeetingBias[normalizeMeetingNameText(race.meeting)] || null;
  const oddsOf = (r) => {
    const v = Number(r?.odds || r?.fixed_win || r?.tote_win || 0);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  };
  const scored = race.runners.map(r => {
    const odds = oddsOf(r);
    let s = Number.isFinite(odds) ? 1 / odds : 0;
    if (r.barrier && r.barrier <= 4) s *= 1.03;
    if (r.barrier && r.barrier >= 10) s *= 0.97;
    if (['Leader','Pace'].includes(r.speedmap)) s *= 1.02;
    const formSignal = runnerFormSignal(r);
    if (formSignal?.status) {
      const formBoostMap = { HOT: 1.18, SOLID: 1.10, MIXED: 0.97, COLD: 0.9 };
      const boost = formBoostMap[formSignal.status];
      if (boost) s = (s === 0 && (formSignal.status === 'HOT' || formSignal.status === 'SOLID')) ? 0.02 * boost : s * boost;
    }
    if (meetingBias) {
      const map = String(r.speedmap || '').toLowerCase();
      const barrier = Number(r.barrier || 0);
      if (meetingBias.insideRail) {
        if (Number.isFinite(barrier) && barrier > 0 && barrier <= 4) s *= 1.06;
        if (Number.isFinite(barrier) && barrier >= 10) s *= 0.94;
      }
      if (meetingBias.leaders) {
        if (['leader', 'pace', 'on pace', 'onpace'].includes(map)) s *= 1.07;
        if (['midfield', 'off midfield', 'backmarker'].includes(map)) s *= 0.96;
      }
      if (meetingBias.swoopers) {
        if (['midfield', 'off midfield', 'backmarker'].includes(map)) s *= 1.07;
        if (['leader', 'pace', 'on pace', 'onpace'].includes(map)) s *= 0.95;
      }
    }
    return { key: normalizeRunnerName(r.name || r.runner_name || ''), score: s };
  }).filter(x => x.key && x.score > 0);

  const total = scored.reduce((a,b)=>a+b.score,0) || 1;
  const map = new Map(scored.map(x => [x.key, (x.score / total) * 100]));
  strategyRaceModelCache.set(cacheKey, map);
  return map;
}

function strategyProfileData(row){

  const meeting = row?.meeting || selectedMeeting;
  const raceNo = row?.race || row?.race_number;
  const sel = cleanRunnerText(row?.selection || row?.runner || row?.name || '');
  const race = lookupRace(meeting, raceNo);
  const selNorm = normalizeRunnerName(sel);
  const runner = race?.runners?.find(r => {
    const nm = normalizeRunnerName(String(r.name || r.runner_name || '').trim());
    return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
  }) || null;

  const odds = parseReasonOdds(row?.reason) || Number(row?.odds || runner?.odds || runner?.fixed_win || runner?.tote_win || 0);
  const modelMap = buildStrategyRaceModelMap(race);
  const mappedModelPct = Number(modelMap.get(selNorm));
  const runnerModelPctRaw = Number(runner?.win_p ?? runner?.model_win_pct ?? NaN);
  const runnerModelPct = Number.isFinite(runnerModelPctRaw)
    ? (runnerModelPctRaw <= 1 ? runnerModelPctRaw * 100 : runnerModelPctRaw)
    : (Number.isFinite(Number(runner?.modelProb)) ? Number(runner.modelProb) * 100 : NaN);
  const model = Number.isFinite(mappedModelPct) && mappedModelPct > 0
    ? mappedModelPct
    : (Number.isFinite(runnerModelPct) && runnerModelPct > 0 ? runnerModelPct : parseReasonWinProb(row?.reason));
  const implied = Number.isFinite(odds) && odds > 0 ? (100 / odds) : NaN;
  const edge = Number.isFinite(model) && Number.isFinite(implied) ? (model - implied) : NaN;
  const formSignal = runner ? runnerFormSignal(runner) : null;
  const map = String(runner?.speedmap || 'Neutral');

  const mapCall = /leader|pace/i.test(map)
    ? '✔ Maps: On-speed shape suits; can control or trail the speed.'
    : /mid|back/i.test(map)
      ? '✔ Maps: Off-speed run style can finish late if tempo is genuine.'
      : '✔ Maps: Tactical map is neutral; ride timing matters.';
  const trackCall = /soft|heavy/i.test(String(race?.track_condition || ''))
    ? '✔ Track: Wet profile in play; monitor footing confidence.'
    : '✔ Track: Surface profile acceptable for this setup.';
  const fitnessCall = formSignal?.status === 'HOT' || formSignal?.status === 'SOLID'
    ? '✔ Fitness: Race hard and ready.'
    : '✔ Fitness: Adequate, but watch pre-race market and parade.';

  const baseSuit = Number.isFinite(Number(runner?.suitability_score)) ? Number(runner?.suitability_score) : 6;
  const edgeBoost = Number.isFinite(edge) ? Math.max(-1.2, Math.min(1.2, edge / 5)) : 0;
  const formBoost = formSignal?.status === 'HOT' ? 1 : formSignal?.status === 'SOLID' ? 0.6 : formSignal?.status === 'COLD' ? -0.8 : 0;
  const suitability = Math.max(1, Math.min(10, baseSuit + edgeBoost + formBoost));

  return {
    meeting,
    raceNo,
    sel,
    runner,
    odds,
    model,
    implied,
    edge,
    formSignal,
    map,
    mapCall,
    trackCall,
    fitnessCall,
    suitability
  };
}

function strategyNarrative(row){
  const d = strategyProfileData(row);
  return `Field profile: ${d.sel}. Barrier ${d.runner?.barrier || 'n/a'}, map ${d.map}, jockey ${d.runner?.jockey || 'n/a'}, trainer ${d.runner?.trainer || 'n/a'}. Form ${d.formSignal?.summary || 'pending'}. Model ${Number.isFinite(d.model) ? d.model.toFixed(1)+'%' : 'n/a'} vs market ${Number.isFinite(d.implied) ? d.implied.toFixed(1)+'%' : 'n/a'}${Number.isFinite(d.edge) ? ` (edge ${d.edge >= 0 ? '+' : ''}${d.edge.toFixed(1)} pts)` : ''}.`;
}

function strategyNarrativeHtml(row){
  const d = strategyProfileData(row);
  return `<div class='strategy-field-profile'>
    <div class='strategy-field-title'>🧾 FIELD PROFILE</div>
    <div class='strategy-field-runner'>🐎 ${escapeHtml(String(d.raceNo || '—'))}. ${escapeHtml(d.sel)}${Number.isFinite(d.odds) ? ` — $${d.odds.toFixed(2)}` : ''}</div>
    <div class='strategy-line'><span class='strategy-line-label'>Barrier</span><span class='strategy-line-body'>${escapeHtml(String(d.runner?.barrier || 'n/a'))}</span></div>
    <div class='strategy-line'><span class='strategy-line-label'>Jockey</span><span class='strategy-line-body'>${escapeHtml(String(d.runner?.jockey || 'n/a'))}</span></div>
    <div class='strategy-line'><span class='strategy-line-label'>Trainer</span><span class='strategy-line-body'>${escapeHtml(String(d.runner?.trainer || 'n/a'))}</span></div>
    <div class='strategy-line'><span class='strategy-line-label'>Form</span><span class='strategy-line-body'>${escapeHtml(String(d.formSignal?.summary || 'Profile pending'))}</span></div>
    <div class='strategy-line'><span class='strategy-line-label'>Pattern</span><span class='strategy-line-body'>${escapeHtml(String(d.map))}</span></div>
    <div class='strategy-check'>${escapeHtml(d.mapCall)}</div>
    <div class='strategy-check'>${escapeHtml(d.trackCall)}</div>
    <div class='strategy-check'>${escapeHtml(d.fitnessCall)}</div>
    <div class='strategy-line'><span class='strategy-line-label'>Price</span><span class='strategy-line-body'>${Number.isFinite(d.model) && Number.isFinite(d.implied) ? `Model ${d.model.toFixed(1)}% vs Market ${d.implied.toFixed(1)}%` : 'Market/model alignment pending'}${Number.isFinite(d.edge) ? ` · Edge ${d.edge >= 0 ? '+' : ''}${d.edge.toFixed(1)} pts` : ''}</span></div>
    <div class='strategy-line'><span class='strategy-line-label'>Suitability</span><span class='strategy-line-body'>${d.suitability.toFixed(1)}/10</span></div>
  </div>`;
}

function buildBetmanEdgeOverlay(picks, meeting, type){
  const rows = (picks || []).map(r => {
    const odds = parseReasonOdds(r.reason) || Number(r.odds || 0);
    const model = parseReasonWinProb(r.reason);
    const implied = Number.isFinite(odds) && odds > 0 ? (100 / odds) : NaN;
    const edge = Number.isFinite(model) && Number.isFinite(implied) ? (model - implied) : NaN;
    const signal = Number.isFinite(r.signal_score) ? r.signal_score : signalScore(r.reason, r.type, r.selection);
    return { ...r, odds, model, implied, edge, signal };
  });
  const bestEdge = rows.filter(x => Number.isFinite(x.edge)).sort((a,b)=>b.edge-a.edge)[0] || null;
  const highestSignal = rows.filter(x => Number.isFinite(x.signal)).sort((a,b)=>b.signal-a.signal)[0] || null;
  const danger = rows.filter(x => Number.isFinite(x.edge)).sort((a,b)=>a.edge-b.edge)[0] || null;

  return `<div class='analysis-block'>
    <div><b>BETMAN Edge Brief</b> · ${escapeHtml(String(meeting || 'Meeting'))} · ${escapeHtml(String(type || 'strategy').toUpperCase())}</div>
    <div class='sub' style='margin-top:6px'>This layer is proprietary synthesis: edge concentration, execution order, and invalidation triggers — not a repeat of card fields.</div>
    <div style='margin-top:8px;display:grid;gap:8px'>
      <div class='strategy-fallback-row'><b>1) Price Dislocation</b><div class='sub'>${bestEdge ? `${escapeHtml(cleanRunnerText(bestEdge.selection || bestEdge.runner || bestEdge.name || 'Selection'))}: ${bestEdge.edge >= 0 ? '+' : ''}${bestEdge.edge.toFixed(1)} pts edge @ ${Number.isFinite(bestEdge.odds) ? bestEdge.odds.toFixed(2) : '—'}` : 'No reliable edge spread yet.'}</div></div>
      <div class='strategy-fallback-row'><b>2) Execution Priority</b><div class='sub'>${highestSignal ? `Top signal is ${escapeHtml(cleanRunnerText(highestSignal.selection || highestSignal.runner || highestSignal.name || 'Selection'))} (${Number(highestSignal.signal).toFixed(0)}). Stage this first in staking order.` : 'Signal hierarchy still forming.'}</div></div>
      <div class='strategy-fallback-row'><b>3) Risk Trigger</b><div class='sub'>${danger ? `Watch ${escapeHtml(cleanRunnerText(danger.selection || danger.runner || danger.name || 'Selection'))} (${danger.edge.toFixed(1)} pts). If market compresses further, reduce exposure.` : 'Use standard map + late-market checks.'}</div></div>
    </div>
  </div>`;
}

function buildStrategyFallbackSummary(picks, meeting, type){


  const rows = (picks || []).map((r, idx) => {
    const odds = parseReasonOdds(r.reason) || Number(r.odds || 0);
    const signal = Number.isFinite(r.signal_score) ? r.signal_score : signalScore(r.reason, r.type, r.selection);
    const race = r.race || r.race_number || '—';
    const sel = cleanRunnerText(r.selection || r.runner || r.name || 'Selection');
    const typeLabel = String(r.type || type || 'win').toUpperCase();
    return `<div class='strategy-fallback-row'><b>R${escapeHtml(String(race))} ${escapeHtml(sel)}</b> · ${escapeHtml(typeLabel)} · Signal ${Number.isFinite(signal) ? signal.toFixed(0) : '—'} · Odds ${Number.isFinite(odds) && odds > 0 ? odds.toFixed(2) : '—'}<div class='sub'>${strategyNarrativeHtml(r)}</div></div>`;
  }).join('');
  return `<div class='analysis-block'><div><b>Strategy Heuristic View</b> — per-race independent runner profiles for ${escapeHtml(String(meeting || 'selected meeting'))}.</div><div class='sub' style='margin-top:6px'>No multi-race coupling. Each pick is evaluated as a standalone race selection.</div><div style='margin-top:8px;display:grid;gap:8px'>${rows || '<div class="sub">No picks available.</div>'}</div></div>`;
}

function buildStrategyAiKey(meeting, type, picks){
  const names = (picks || []).map(r => cleanRunnerText(r.selection || r.runner || r.name || '')).filter(Boolean).join('|').toLowerCase();
  return `${String(selectedDay || '').toLowerCase()}|${String(meeting || '').toLowerCase()}|${String(type || '').toLowerCase()}|${names}|v2`;
}
function getStrategyAiCache(key){
  try {
    const raw = localStorage.getItem(`strategyAiCache:${key}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts || (Date.now() - parsed.ts) > STRATEGY_AI_CACHE_TTL_MS) return null;
    return parsed;
  } catch { return null; }
}
function setStrategyAiCache(key, html){
  try { localStorage.setItem(`strategyAiCache:${key}`, JSON.stringify({ html, ts: Date.now() })); } catch {}
}
function getStrategyAiCooldown(key){
  const until = Number(localStorage.getItem(`strategyAiCooldown:${key}`) || 0);
  return Number.isFinite(until) ? until : 0;
}
function setStrategyAiCooldown(key){
  try { localStorage.setItem(`strategyAiCooldown:${key}`, String(Date.now() + STRATEGY_AI_COOLDOWN_MS)); } catch {}
}

async function buildStrategyPlan(){
  const type = String($('strategyTypeSelect')?.value || 'win').toLowerCase();
  const meeting = selectedMeeting || 'ALL';
  const label = $('strategyMeetingLabel');
  if (label) label.textContent = `Meeting: ${meeting}`;
  if (!meeting || meeting === 'ALL') {
    const out = $('strategyOutput');
    const summary = $('strategySummary');
    if (summary) summary.innerHTML = '<div class="sub">Select a meeting in Meeting Workspace to build a strategy.</div>';
    if (out) out.innerHTML = '<div class="sub">Select a meeting in Meeting Workspace to build a strategy.</div>';
    $('strategyAiSummary') && ($('strategyAiSummary').innerHTML = '<div class="sub">Select a meeting in Meeting Workspace first.</div>');
    return;
  }
  const candidates = buildStrategyPlanCandidates(type);
  const sorted = candidates.slice().sort((a,b) => scoreStrategyCandidate(b) - scoreStrategyCandidate(a));
  let picks = type === 'blended' ? candidates : sorted.slice(0, 8);
  if (type === 'win') picks = picks.filter(r => String(r.type || '').toLowerCase() === 'win');
  if (type === 'ew') picks = picks.filter(r => String(r.type || '').toLowerCase() === 'ew');
  if (type === 'long') picks = picks.filter(r => rowMatchesLongProfile(r));
  if (type === 'exotics') picks = picks.filter(r => ['top2','top3','top4','trifecta','multi'].includes(String(r.type || '').toLowerCase()));

  const deduped = new Map();
  picks.forEach(r => {
    const key = `${String(r.meeting || '').trim().toLowerCase()}|${String(r.race || r.race_number || '').trim()}|${normalizeRunnerName(cleanRunnerText(r.selection || r.runner || r.name || ''))}`;
    const score = Number.isFinite(r.signal_score) ? Number(r.signal_score) : scoreStrategyCandidate(r);
    const prev = deduped.get(key);
    if (!prev || score > prev._score) deduped.set(key, { ...r, _score: score });
  });
  picks = Array.from(deduped.values()).map(({ _score, ...row }) => row);
  const winProbVals = picks
    .map(r => {
      const fromReason = parseReasonWinProb(r.reason);
      const fromRow = parseWinProbValue(r.aiWinProb ?? r.win_p);
      return Number.isFinite(fromReason) ? fromReason : (Number.isFinite(fromRow) ? fromRow : NaN);
    })
    .filter(v => Number.isFinite(v) && v > 0);
  const oddsVals = picks.map(r => parseReasonOdds(r.reason) || Number(r.odds || 0)).filter(v => Number.isFinite(v) && v > 0);
  const signalVals = picks
    .map(r => Number.isFinite(r.signal_score) ? Number(r.signal_score) : signalScore(r.reason, r.type, r.selection))
    .filter(v => Number.isFinite(v));
  const avgOdds = oddsVals.length ? (oddsVals.reduce((a,b)=>a+b,0) / oddsVals.length) : null;
  const oddsStd = (oddsVals.length > 1 && Number.isFinite(avgOdds))
    ? Math.sqrt(oddsVals.reduce((a,b)=>a+Math.pow(b-avgOdds,2),0) / oddsVals.length)
    : null;
  const stats = {
    count: picks.length,
    winProb: winProbVals.length ? (winProbVals.reduce((a,b)=>a+b,0) / winProbVals.length) : null,
    avgOdds,
    avgSignal: signalVals.length ? (signalVals.reduce((a,b)=>a+b,0) / signalVals.length) : null,
    winProbCoverage: picks.length ? (winProbVals.length / picks.length) : 0,
    signalCoverage: picks.length ? (signalVals.length / picks.length) : 0,
    oddsStd
  };
  latestStrategyContext = {
    picks: picks.slice(),
    stats,
    type,
    meeting,
    aiSummaryHtml: $('strategyAiSummary')?.innerHTML || ''
  };
  renderStrategySummary(stats);
  renderStrategyOutput(picks);

  const aiToggle = $('strategyAiToggle');
  const aiSummary = $('strategyAiSummary');
  if (!aiToggle || !aiSummary || !aiToggle.checked) {
    if (aiSummary) aiSummary.innerHTML = '';
    return;
  }
  const betmanOverlay = buildBetmanEdgeOverlay(picks, meeting, type);
  const aiKey = buildStrategyAiKey(meeting, type, picks);
  const cachedAi = getStrategyAiCache(aiKey);
  const cooldownUntil = getStrategyAiCooldown(aiKey);
  if (cachedAi?.html) {
    aiSummary.innerHTML = `${betmanOverlay}<div class="sub" style="margin-top:8px">Loaded AI cache.</div>${cachedAi.html}`;
    latestStrategyContext.aiSummaryHtml = aiSummary.innerHTML;
    return;
  }
  if (cooldownUntil > Date.now()) {
    const sec = Math.max(1, Math.ceil((cooldownUntil - Date.now()) / 1000));
    aiSummary.innerHTML = `${betmanOverlay}<div class="sub" style="margin-top:8px">AI cooldown active (${sec}s remaining). Using heuristic view.</div>${buildStrategyFallbackSummary(picks, meeting, type)}`;
    latestStrategyContext.aiSummaryHtml = aiSummary.innerHTML;
    return;
  }
  aiSummary.innerHTML = `${betmanOverlay}<div class="sub" style="margin-top:8px">AI filtering strategy… (3 min cooldown after run)</div>`;
  setStrategyAiCooldown(aiKey);
  const strategyLabel = type === 'blended'
    ? 'BLENDED strategy (1-3 bets per race)'
    : `${type.toUpperCase()} strategy`;
  const selectionNames = picks.map(r => cleanRunnerText(r.selection || r.runner || r.name || '')).filter(Boolean).join(', ');
  const question = `For ${meeting} using ${strategyLabel}, provide horse-by-horse commentary on the candidate list.

Rules:
- Treat each horse independently (no cross-runner comparisons).
- Do NOT repeat obvious card fields unless they materially change the bet decision.
- Add BETMAN-specific value: execution order, price-dislocation call, risk trigger, and why this is actionable.
- Use race context, trainer/jockey, weight, map pattern, sectionals/trials/form, market price, and risk.
- Keep each runner concise but rich.
- IMPORTANT: these are already selected/tagged candidates. Do not output "pass" for them; instead mark stake caution or reduced confidence when needed.
- Keep messaging consistent with tags (e.g., Odds Runner/Long/EW should remain actionable with risk notes, not contradictions).
- Use this exact structure per runner:
  [Runner Number if known]. [Horse Name] — [Trainer] / [Jockey] — [Weight] — [$Odds]
  Profile: ...
  Positives: ...
  Negatives: ...
  Pattern: ...
  Suitability score: X.X/10
  Take: ...
- Use plain-English punter language.
- No tables.
- Do not collapse runners into one paragraph.

You MUST explicitly mention each of these runners by name: ${selectionNames}.`;
  try {
    const res = await fetchLocal('./api/ask-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        selectionCount: picks.length,
        selections: picks,
        source: 'strategy',
        uiContext: { day: selectedDay, country: selectedCountry, meeting: selectedMeeting },
        provider: selectedAiModel.provider,
        model: selectedAiModel.model,
        userNotes: queryAiUserNotes('', selectedMeeting).slice(0, 5).map(n => ({ text: n.text, meeting: n.meeting, createdAt: n.createdAt }))
      })
    });
    const out = await res.json();
    if (out?.mode === 'fallback') {
      const finalHtml = `${betmanOverlay}${buildStrategyFallbackSummary(picks, meeting, type)}`;
      aiSummary.innerHTML = finalHtml;
      setStrategyAiCache(aiKey, finalHtml.replace(betmanOverlay, ''));
    } else {
      const rawAnswer = String(out?.answer || '');
      const requiredNames = picks.map(r => cleanRunnerText(r.selection || r.runner || r.name || '')).filter(Boolean);
      const lowerAnswer = rawAnswer.toLowerCase();
      const missing = requiredNames.filter(name => !lowerAnswer.includes(name.toLowerCase()));
      if (missing.length) {
        const missingNote = `<div class='analysis-block'><div class='sub'>AI response missing ${missing.length} runner${missing.length === 1 ? '' : 's'} (${missing.slice(0,4).map(escapeHtml).join(', ')}${missing.length > 4 ? '…' : ''}). Showing heuristic view instead.</div></div>`;
        const aiHtml = `${missingNote}${buildStrategyFallbackSummary(picks, meeting, type)}`;
        aiSummary.innerHTML = `${betmanOverlay}${aiHtml}`;
        setStrategyAiCache(aiKey, aiHtml);
      } else {
        const aiBlock = rawAnswer ? formatAiAnswer(rawAnswer) : '<div class="sub">AI response unavailable.</div>';
        aiSummary.innerHTML = `${betmanOverlay}${aiBlock}`;
        setStrategyAiCache(aiKey, aiBlock);
      }
    }
  } catch {
    const fallbackHtml = buildStrategyFallbackSummary(picks, meeting, type);
    aiSummary.innerHTML = `${betmanOverlay}${fallbackHtml}`;
    setStrategyAiCache(aiKey, fallbackHtml);
  }
  latestStrategyContext.aiSummaryHtml = aiSummary.innerHTML;
}

function buildStrategyPrintHtml(ctx = {}){
  const picks = Array.isArray(ctx.picks) ? ctx.picks : [];
  const stats = ctx.stats || {};
  const now = new Date();
  const dateLabel = now.toLocaleString();
  const typeLabel = String(ctx.type || 'win').toUpperCase();
  const meeting = ctx.meeting || '—';
  const crestName = ctx.userDisplayName || currentUserDisplayName || 'User';

  const rankByRunnerKey = new Map();
  const grouped = new Map();
  picks.forEach(r => {
    const key = `${r.meeting || meeting}|${r.race || r.race_number || '—'}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  });
  grouped.forEach((list, raceKey) => {
    list.slice().sort((a,b) => scoreStrategyCandidate(b) - scoreStrategyCandidate(a)).forEach((row, idx) => {
      const runnerKey = normalizeRunnerName(cleanRunnerText(row.selection || row.runner || row.name || ''));
      rankByRunnerKey.set(`${raceKey}|${runnerKey}`, idx + 1);
    });
  });

  const topThree = picks
    .slice()
    .sort((a,b) => scoreStrategyCandidate(b) - scoreStrategyCandidate(a))
    .slice(0,3);
  const topThreeHtml = topThree.map((r, i) => {
    const odds = parseReasonOdds(r.reason) || Number(r.odds || 0);
    const name = cleanRunnerText(r.selection || r.runner || r.name || 'Selection');
    const race = String(r.race || r.race_number || '—');
    return `<div class='best-row'><span class='n'>${i+1}</span><span class='t'>R${escapeHtml(race)} · ${escapeHtml(name)}</span><span class='o'>${Number.isFinite(odds) && odds > 0 ? `$${odds.toFixed(2)}` : '—'}</span></div>`;
  }).join('');

  const pickRows = picks.map((r, idx) => {
    const odds = parseReasonOdds(r.reason) || Number(r.odds || 0);
    const signal = Number.isFinite(r.signal_score) ? r.signal_score : signalScore(r.reason, r.type, r.selection);
    const raceKey = `${r.meeting || meeting}|${r.race || r.race_number || '—'}`;
    const runnerKey = normalizeRunnerName(cleanRunnerText(r.selection || r.runner || r.name || 'Selection'));
    const rank = rankByRunnerKey.get(`${raceKey}|${runnerKey}`);
    const rankLabel = rank === 1 ? '1st Pick' : (rank === 2 ? '2nd Pick' : '—');
    const rankChip = rank === 1
      ? `<span class='rank-chip rank-first'>1st Pick</span>`
      : rank === 2
        ? `<span class='rank-chip rank-second'>2nd Pick</span>`
        : `<span class='rank-chip rank-other'>—</span>`;
    return `<tr>
      <td>${idx + 1}</td>
      <td>${escapeHtml(String(r.race || r.race_number || '—'))}</td>
      <td>${escapeHtml(cleanRunnerText(r.selection || r.runner || r.name || 'Selection'))}</td>
      <td>${escapeHtml(String(r.type || 'Win').toUpperCase())}</td>
      <td>${rankChip}</td>
      <td>${Number.isFinite(odds) && odds > 0 ? odds.toFixed(2) : '—'}</td>
      <td>${Number.isFinite(signal) ? signal.toFixed(0) : '—'}</td>
      <td>${strategyNarrativeHtml(r)}</td>
    </tr>`;
  }).join('');

  return `<!doctype html><html><head><meta charset='utf-8'/><title>Strategy Book</title>
  <style>
    @page{size:A4;margin:12mm}
    body{font-family:'Georgia','Times New Roman',serif;background:#f6efe2;color:#2f2418;margin:0}
    .book{position:relative;border:2px solid #7b5a3c;padding:18px 20px;background:#fff9ef;box-shadow:0 2px 10px rgba(63,44,27,.12)}
    .mast{border-bottom:2px double #7b5a3c;padding-bottom:10px;margin-bottom:12px;position:relative}
    .crest{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#6a4b2f;margin-bottom:4px}
    .title{font-size:30px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 6px;color:#2f2418}
    .sub{font-size:12px;color:#6d4f35}
    .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;font-size:12px;margin:12px 0}
    .meta > div{border:1px solid #c9ae90;padding:6px 8px;background:#fff6e9}
    .meta b{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6a4b2f}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
    th,td{border:1px solid #c9ae90;padding:7px;vertical-align:top}
    th{background:#ecd7bb;text-transform:uppercase;font-size:10px;letter-spacing:.11em;color:#4d3824}
    tr:nth-child(even) td{background:#fff4e4}
    .rank-chip{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #a98663;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
    .rank-first{background:#4d3824;color:#f8e9d2;border-color:#4d3824}
    .rank-second{background:#7b5a3c;color:#f8e9d2;border-color:#7b5a3c}
    .rank-other{background:#f4e6d2;color:#7b5a3c;border-color:#c9ae90}
    .footer{margin-top:14px;font-size:11px;color:#6d4f35;border-top:1px dashed #b6926e;padding-top:8px}
    .ai{margin-top:12px;padding:10px;border:1px dashed #b6926e;background:#fff5e7;font-size:12px;line-height:1.5}
    .strategy-field-profile{padding:6px;border:1px solid #d0b191;background:#fffdf8}
    .strategy-field-title{font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:#6a4b2f;margin-bottom:4px}
    .strategy-field-runner{font-weight:700;margin-bottom:4px;color:#2f2418}
    .strategy-line{display:flex;gap:8px;line-height:1.35;margin:2px 0;align-items:flex-start}
    .strategy-line-label{flex:0 0 90px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:#7a5a3b;text-align:right}
    .strategy-line-body{flex:1 1 auto;min-width:0;color:#2f2418;padding-left:4px}
    .strategy-check{font-size:11px;color:#4d3824;margin-top:2px}
    .best-bets-hero{margin:10px 0 8px;padding:10px 12px;border:1px solid #b99262;border-radius:8px;background:linear-gradient(135deg,#2d7f5e 0%, #1f6b50 45%, #14513b 100%);color:#f5ffef}
    .best-bets-hero .h{font-size:10px;letter-spacing:.14em;text-transform:uppercase;opacity:.95;margin-bottom:6px}
    .best-row{display:grid;grid-template-columns:22px 1fr auto;gap:8px;align-items:center;padding:2px 0;font-size:12px}
    .best-row .n{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;background:#c5ff00;color:#173023;font-weight:800;font-size:10px}
    .best-row .t{font-weight:700}
    .best-row .o{font-weight:700;opacity:.95}
  </style></head><body>
  <div class='book'>
    <div class='mast'>
      <div class='crest'>${escapeHtml(crestName)} · STRATEGY LEDGER</div>
      <h1 class='title'>Racing Strategy Book</h1>
      <div class='sub'>Racebook · Generated ${escapeHtml(dateLabel)}</div>
    </div>
    <div class='meta'>
      <div><b>Meeting</b><div>${escapeHtml(meeting)}</div></div>
      <div><b>Strategy</b><div>${escapeHtml(typeLabel)}</div></div>
      <div><b>Selections</b><div>${Number(stats.count || picks.length || 0)}</div></div>
      <div><b>Avg Odds</b><div>${stats.avgOdds != null ? Number(stats.avgOdds).toFixed(2) : '—'}</div></div>
    </div>
    <div class='best-bets-hero'>
      <div class='h'>BETMAN · Best Bets of the Day</div>
      ${topThreeHtml || '<div class="best-row"><span class="n">—</span><span class="t">No ranked bets</span><span class="o">—</span></div>'}
    </div>
    <table>
      <thead><tr><th>#</th><th>Race</th><th>Selection</th><th>Type</th><th>Pick Rank</th><th>Odds</th><th>Signal</th><th>Commentary</th></tr></thead>
      <tbody>${pickRows || '<tr><td colspan="8">No strategy selections.</td></tr>'}</tbody>
    </table>
    ${ctx.aiSummaryHtml ? `<div class='ai'><b>AI Notes</b><div>${ctx.aiSummaryHtml}</div></div>` : ''}
    <div class='footer'>
      Private Book · For strategy review only. Validate price + map changes before staking.
    </div>
  </div>
  </body></html>`;
}

function toggleStrategyPrintModal(show){
  const modal = $('strategyPrintModal');
  if (!modal) return;
  modal.classList.toggle('hidden', !show);
  modal.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function printStrategyBook(){
  const ctx = latestStrategyContext || {};
  if (!ctx.picks || !ctx.picks.length) {
    alert('Build a strategy first, then print.');
    return;
  }
  const html = buildStrategyPrintHtml(ctx);
  const frame = $('strategyPrintFrame');
  if (!frame) {
    alert('Preview frame unavailable.');
    return;
  }
  frame.srcdoc = html;
  frame.dataset.doc = html;
  toggleStrategyPrintModal(true);
}

function parseTimeValue(raw){
  if (raw == null || raw === '') return NaN;
  if (typeof raw === 'number') return raw < 1e12 ? raw * 1000 : raw;
  if (/^\d+$/.test(String(raw))) {
    const n = Number(raw);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = new Date(raw).getTime();
  return Number.isNaN(t) ? NaN : t;
}

function formatCountdown(targetIso){
  const t = parseTimeValue(targetIso);
  if (!t || Number.isNaN(t)) return 'queued';
  const d = Math.max(0, Math.floor((t - Date.now()) / 1000));
  return d <= 0 ? 'placing…' : `placing in ${d}s`;
}

function formatRaceCountdown(target){
  const t = parseTimeValue(target);
  if (!t || Number.isNaN(t)) return null;
  const s = Math.floor((t - Date.now()) / 1000);
  if (s <= 0) return { text: 'jumping now', color: '#ff6b6b' };
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const text = `${m}m ${String(sec).padStart(2,'0')}s`;
  const color = s <= 300 ? '#ff6b6b' : (s <= 900 ? '#f5c066' : '#c5ff00');
  return { text, color };
}


function lookupRace(meeting, raceNumber, country = ''){
  const target = { meeting, raceNumber, country };
  const finder = collection => (collection || []).find(r => raceIdentityMatches(r, target)) || null;
  return finder(racesCache) || finder(lastRacesSnapshot) || null;
}

function buildJumpCell(meeting, raceNumber, fallback){
  const race = (racesCache || []).find(x => String(x.meeting || '').trim().toLowerCase() === String(meeting || '').trim().toLowerCase() && String(x.race_number || '') === String(raceNumber || '').replace(/^R/i,'').trim());
  const raw = race?.advertised_start ?? race?.start_time_nz;
  if (!raw) {
    const missing = fallback ? `Jumps in ${fallback}` : 'Jumps in —';
    return `<div class='jump-time'>${fallback || '—'}</div><div class='sub race-countdown'>${missing}</div>`;
  }
  const dt = parseTimeValue(raw);
  const timeText = Number.isFinite(dt) ? new Date(dt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : (fallback || '—');
  const cd = formatRaceCountdown(raw);
  const cdText = cd ? `Jumps in ${cd.text}` : `Jumps in ${fallback || 'upcoming'}`;
  const style = cd?.color ? `style="color:${cd.color};font-weight:700"` : '';
  return `<div class='jump-time'>${timeText}</div><div class='sub race-countdown' data-racetime='${raw}' ${style}>${cdText}</div>`;
}
function tickQueuedCountdowns(){
  document.querySelectorAll('.queued-countdown').forEach(el => {
    const iso = el.dataset.placeafter;
    el.textContent = formatCountdown(iso);
  });
  document.querySelectorAll('.race-countdown').forEach(el => {
    const out = formatRaceCountdown(el.dataset.racetime);
    if (!out) return;
    el.textContent = out.text;
    el.style.color = out.color;
    el.style.fontWeight = '700';
  });
}

function getRaceStartTimestamp(race){
  if (!race) return NaN;
  const candidates = [race.advertised_start, race.start_time_iso, race.start_time, race.start_time_nz, race.start_time_local];
  for (const raw of candidates) {
    const ts = parseTimeValue(raw);
    if (Number.isFinite(ts)) return ts;
  }
  return NaN;
}

function getTradingDayStartMs(){
  const base = new Date();
  if (selectedDay === 'tomorrow') base.setDate(base.getDate() + 1);
  base.setHours(0, 0, 0, 0);
  return base.getTime();
}

function computeRaceEta(race){
  const ts = getRaceStartTimestamp(race);
  if (!Number.isFinite(ts)) return { eta: '—', mins: null };
  const diffMin = Math.round((ts - Date.now()) / 60000);
  if (diffMin <= 0) return { eta: 'Jumped', mins: diffMin };
  if (diffMin >= 120) {
    const hrs = Math.floor(diffMin / 60);
    const mins = diffMin % 60;
    return { eta: `in ${hrs}h ${mins}m`, mins: diffMin };
  }
  return { eta: `in ${diffMin}m`, mins: diffMin };
}

function normalizeMeetingKey(val){
  return String(val || '').trim().toLowerCase();
}

function normalizeRaceNumberValue(val){
  return String(val || '').replace(/^R/i, '').trim();
}

function parseMarketOddsKey(key){
  if (!key || typeof key !== 'string') return null;
  const [left, runnerPart] = key.split('|');
  if (!runnerPart) return null;
  const segments = left.split(':');
  if (segments.length < 3) return null;
  const country = segments.shift();
  const raceSegment = segments.pop();
  const meeting = segments.join(':');
  const race = normalizeRaceNumberValue(raceSegment);
  const runnerRaw = cleanRunnerText(runnerPart);
  const runnerNorm = normalizeRunnerName(runnerRaw);
  if (!meeting || !race || !runnerNorm) return null;
  return { country, meeting, race, runner: runnerRaw, runnerNorm };
}

function marketMoverRowKey(row){
  if (!row) return '';
  const meeting = normalizeMeetingKey(row.meeting);
  const race = normalizeRaceNumberValue(row.race || row.race_number);
  const runner = normalizeRunnerName(row.runner || row.selection || row.name || '');
  if (!meeting || !race || !runner) return '';
  return `${meeting}|${race}|${runner}`;
}

function mergeMoverRows(primary = [], derived = []){
  const merged = primary ? primary.slice() : [];
  const seen = new Set(merged.map(marketMoverRowKey).filter(Boolean));
  derived.forEach(row => {
    const key = marketMoverRowKey(row);
    if (!key || seen.has(key)) return;
    merged.push(row);
    seen.add(key);
  });
  return merged;
}

function deriveMarketMoversFromHistory(){
  const history = latestMarketOddsHistory || {};
  if (!history || typeof history !== 'object') return [];
  const dayStart = getTradingDayStartMs();
  const rows = [];
  const START_MOVE_THRESHOLD = 5;
  Object.entries(history).forEach(([key, points]) => {
    if (!Array.isArray(points) || points.length < 2) return;
    const parsed = parseMarketOddsKey(key);
    if (!parsed) return;
    const filtered = points.filter(pt => {
      const ts = Number(pt?.ts);
      if (!Number.isFinite(ts)) return true;
      return ts >= dayStart;
    });
    const seq = filtered.length ? filtered : points;
    const first = seq[0];
    const last = seq[seq.length - 1];
    const openOdds = Number(first?.odds);
    const currentOdds = Number(last?.odds);
    if (!Number.isFinite(openOdds) || !Number.isFinite(currentOdds) || openOdds <= 0 || currentOdds <= 0) return;
    if (openOdds === currentOdds) return;
    const pctMove = ((currentOdds - openOdds) / openOdds) * 100;
    if (Math.abs(pctMove) < START_MOVE_THRESHOLD) return;
    const race = lookupRace(parsed.meeting, parsed.race);
    if (!race) return;
    if (raceHasJumped(race, 300)) return;
    const { eta, mins } = computeRaceEta(race);
    rows.push({
      meeting: race.meeting || parsed.meeting,
      race: race.race_number || parsed.race,
      runner: parsed.runner,
      fromOdds: Number(openOdds.toFixed(2)),
      toOdds: Number(currentOdds.toFixed(2)),
      pctMove: Number(pctMove.toFixed(1)),
      direction: currentOdds > openOdds ? 'drift' : 'firm',
      eta: eta || '—',
      minsToJump: mins,
      fresh: false,
      snapshot: true,
      startMove: true
    });
  });
  return rows;
}

function applyDerivedMovers(){
  const derived = deriveMarketMoversFromHistory();
  if (!derived.length) return 0;
  latestMarketMovers = mergeMoverRows(latestMarketMovers, derived);
  return derived.length;
}

function raceHasJumped(race, bufferSeconds = 0){
  const ts = getRaceStartTimestamp(race);
  if (!Number.isFinite(ts)) return false;
  const bufferMs = Math.max(0, bufferSeconds * 1000);
  return ts < (Date.now() - bufferMs);
}

function selectionStartTimestamp(row){
  if (!row) return NaN;
  const hinted = [row.advertisedStart, row.advertised_start, row.startTime, row.start_time, row.startTimeIso, row.start_time_iso, row.startTimeNz, row.start_time_nz, row.raceTime, row.race_time];
  for (const raw of hinted) {
    const ts = parseTimeValue(raw);
    if (Number.isFinite(ts)) return ts;
  }
  const race = getRaceFromCache(row.meeting, row.race);
  if (race) {
    const ts = getRaceStartTimestamp(race);
    if (Number.isFinite(ts)) return ts;
  }
  return NaN;
}

function selectionHasJumped(row){
  if (!row) return false;
  const rawHint = row.jumpsIn ?? row.eta ?? row.jumps_in ?? '';
  const hint = String(rawHint || '').toLowerCase().trim();
  if (hint) {
    if (hint.includes('jumped') || hint.includes('ago')) return true;
    if (hint === 'jumped') return true;
    const minutes = jumpsInToMinutes(rawHint);
    if (Number.isFinite(minutes) && minutes <= 0) return true;
  }
  const minsField = Number(row.minsToJump ?? row.mins_to_jump);
  if (Number.isFinite(minsField) && minsField <= 0) return true;
  const ts = selectionStartTimestamp(row);
  if (Number.isFinite(ts)) return ts <= Date.now();
  return false;
}

function selectionIsUpcoming(row){
  if (!row) return false;
  return !selectionHasJumped(row);
}

function jumpsInToMinutes(jumpsIn){
  const s = String(jumpsIn || '').toLowerCase().trim();
  if (s === 'jumped') return 0;
  const m = s.match(/in\s*(\d+)m/);
  if (m) return Number(m[1]);
  const n = s.match(/^(\d+)m$/);
  if (n) return Number(n[1]);
  return Number.POSITIVE_INFINITY;
}

function updateNextRaceCountdown(rows){
  const el = $('nextRaceCountdown');
  if (!el) return;
  const next = (rows || [])
    .filter(r => jumpsInToMinutes(r.jumpsIn) > 0)
    .slice()
    .sort((a,b) => jumpsInToMinutes(a.jumpsIn) - jumpsInToMinutes(b.jumpsIn))[0];
  if (!next) {
    el.textContent = 'Next race: no upcoming races in current window';
    return;
  }
  el.textContent = `Next race: ${next.meeting} R${next.race} — ${next.selection} jumps ${next.jumpsIn}`;
}

function renderNextPlanned(rows){
  const table = $('nextPlannedTable');
  if (!table) return;
  table.innerHTML = '';
  const plannedSource = (rows && rows.length) ? rows : (latestSuggestedBets || []);
  const plannedWindow = Number(earlyWindowMin || 180);
  const actionableTiers = new Set(['bet_now','queue']);
  const actionableTypes = new Set(['win','ew','top2','top3','top4','trifecta','multi']);

  let scoped = (latestUpcomingBets || [])
    .filter(selectionIsUpcoming)
    .filter(r => !selectedMeeting || selectedMeeting === 'ALL' || meetingMatches(r))
    .slice()
    .sort((a,b) => jumpsInToMinutes(a.eta || a.jumpsIn || a.sortTime) - jumpsInToMinutes(b.eta || b.jumpsIn || b.sortTime));

  if (!scoped.length) {
    scoped = baseSuggestedRows(plannedSource)
      .filter(selectionIsUpcoming)
      .filter(r => actionableTypes.has(String(r.type || 'win').toLowerCase()))
      .filter(r => actionableTiers.has(String(r.capitalTier || '').toLowerCase()))
      .filter(r => jumpsInToMinutes(r.jumpsIn) <= plannedWindow)
      .filter(r => !selectedMeeting || selectedMeeting === 'ALL' || meetingMatches(r))
      .slice()
      .sort((a,b) => {
        const at = String(a.capitalTier || '').toLowerCase() === 'bet_now' ? 0 : 1;
        const bt = String(b.capitalTier || '').toLowerCase() === 'bet_now' ? 0 : 1;
        if (at !== bt) return at - bt;
        return jumpsInToMinutes(a.jumpsIn) - jumpsInToMinutes(b.jumpsIn);
      });
  }

  if (!scoped.length) {
    scoped = baseSuggestedRows(plannedSource)
      .filter(selectionIsUpcoming)
      .filter(r => actionableTypes.has(String(r.type || 'win').toLowerCase()))
      .filter(r => jumpsInToMinutes(r.jumpsIn) <= plannedWindow)
      .filter(r => !selectedMeeting || selectedMeeting === 'ALL' || meetingMatches(r))
      .slice()
      .sort((a,b) => jumpsInToMinutes(a.jumpsIn) - jumpsInToMinutes(b.jumpsIn));
  }

  updateNextRaceCountdown(scoped.map(r => ({
    meeting: r.meeting,
    race: r.race,
    selection: r.selection,
    jumpsIn: r.jumpsIn || r.eta || r.sortTime || '—'
  })));
  const top = scoped.slice(0,5);
  if (!top.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    const msg = selectedWhy === 'ALL' ? 'No planned bets yet' : `No planned bets match WHY: ${displayWhy(selectedWhy)}`;
    empty.innerHTML = `<div style='grid-column:1/-1'>${msg}</div>`;
    table.appendChild(empty);
    return;
  }
  const norm = (s)=>String(s||'').replace(/^\d+\.\s*/, '').trim().toLowerCase();

  top.forEach(r => {
    const row = document.createElement('div');
    row.className = 'row';

    const cmp = (latestAiCompare || []).find(c =>
      String(c.meeting || '').trim().toLowerCase() === String(r.meeting || '').trim().toLowerCase() &&
      String(c.race || '') === String(r.race || '') &&
      norm(c.selection) === norm(r.selection)
    );
    const alreadyPlaced = cmp && Number(cmp.placedStake || 0) >= Number(r.stake || 0);
    const reasonLc = String(r.reason || '').toLowerCase();
    const t = String(r.type || '').toLowerCase();
    const p = parseReasonWinProb(r.reason);
    const odds = parseReasonOdds(r.reason);
    const exotic = ['top2','top3','top4','trifecta','multi'].includes(t);

    const tagPool = [];
    if (alreadyPlaced) tagPool.push(`<span class='tag value'>already placed</span>`);
    const inheritedInteresting = inheritInterestingTags(r.meeting, r.race, r.selection);
    const moverTags = inheritMoveTags(r.meeting, r.race, r.selection);
    if (r.interesting && !inheritedInteresting.length) tagPool.push(`<span class='tag ew'>interesting</span>`);
    tagPool.push(...inheritedInteresting, ...moverTags);
    if (exotic) tagPool.push(`<span class='tag'>exotic</span>`);
    if (t === 'top4') tagPool.push(`<span class='tag top4'>TOP4</span>`);
    const sigRaw = Number(r.signal_score);
    const sig = Number.isFinite(sigRaw) ? sigRaw : signalScore(r.reason, t, r.selection || r.runner || '');
    const formStatus = runnerFormSignal(r)?.status;
    const shortFavStrong = Number.isFinite(odds) && odds > 0 && odds <= 3.2 && ['HOT','SOLID'].includes(String(formStatus || '').toUpperCase());
    if (!exotic && ((Number.isFinite(sig) && sig >= 60) || shortFavStrong)) tagPool.push(`<span class='tag win'>strong</span>`);
    if (!exotic && (t === 'ew' || (Number.isFinite(odds) && odds >= 5) || (Number.isFinite(p) && p < 20) || reasonLc.includes('value') || reasonLc.includes('long-odds'))) tagPool.push(`<span class='tag value'>value</span>`);
    const seenPlanTags = new Set();
    const tags = tagPool.filter(tag => {
      if (!tag || seenPlanTags.has(tag)) return false;
      seenPlanTags.add(tag);
      return true;
    });
    const tag = tags.length ? ` ${tags.join(' ')}` : '';
    const fallbackRow = /^fallback/.test(String(r.reason || '').trim().toLowerCase());
    const aiProbText = Number.isFinite(Number(r.aiWinProb))
      ? `AI win probability is ${Number(r.aiWinProb).toFixed(1)}%.`
      : (() => {
          if (exotic) {
            const aiProb = Number(r.aiWinProb);
            if (Number.isFinite(aiProb) && aiProb > 0) {
              const modelPrice = (100 / aiProb);
              return `AI probability (synthetic) ${aiProb.toFixed(1)}% · model $${modelPrice.toFixed(2)}.`;
            }
            if (Number.isFinite(odds) && odds > 0) {
              const impliedPct = `${(100 / odds).toFixed(1)}%`;
              return `AI probability pending. Model price $${odds.toFixed(2)} (implied ${impliedPct}).`;
            }
            return 'AI probability pending — awaiting model inputs.';
          }
          if (fallbackRow) {
            return 'AI win probability pending — placeholder runner until a qualified AI signal enters the window.';
          }
          const f = String(formStatus || '').toUpperCase();
          if (Number.isFinite(odds) && odds > 0 && odds <= 3.2) {
            return `AI win probability is unavailable for this market. WHY: short-priced favourite${f ? ` with ${f} form` : ''}.`;
          }
          return 'AI win probability is unavailable for this market. WHY: market lacks enough quantified model inputs.';
        })();
    row.innerHTML = `<div><button class='bet-btn race-cell-btn planned-race-btn' data-meeting='${r.meeting}' data-race='${r.race}'><span class="badge">${r.meeting}</span> R${r.race}</button></div><div><button class='bet-btn next-planned-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-selection='${escapeAttr(cleanRunnerText(r.selection))}'><span class='bet-icon'>📌</span>${escapeHtml(cleanRunnerText(r.selection))}${tag}</button></div><div>${r.type}</div><div><div class='sub'>Odds: ${Number.isFinite(odds) ? odds.toFixed(2) : '—'}</div>${buildJumpCell(r.meeting, r.race, r.jumpsIn || 'upcoming')}</div><div class='right'>${aiProbText}</div>`;
    table.appendChild(row);
  });

  attachNextPlannedHandlers();
  makeSelectionsDraggable();
}

let autobetFilterType = 'ALL';
let autobetWindow = 'day';
let autobetPerfDaily = null;

function autobetStrategyKey(type){
  const t = String(type || '').toLowerCase();
  if (t.includes('ew')) return 'EW';
  if (t.includes('odds') || t.includes('value')) return 'ODDS';
  if (t.includes('long')) return 'LONG';
  if (t.includes('top') || t.includes('trifecta') || t.includes('multi') || t.includes('exotic')) return 'EXOTICS';
  return 'WIN';
}

function autobetTagClass(type){
  const t = String(type || '').toLowerCase();
  if (t.includes('top4')) return 'tag top4';
  if (t.includes('top')) return 'tag';
  if (t.includes('trifecta') || t.includes('multi')) return 'tag';
  if (t.includes('ew')) return 'tag ew';
  if (t.includes('win')) return 'tag win';
  if (t.includes('odds') || t.includes('value')) return 'tag value';
  if (t.includes('long')) return 'tag value';
  return 'tag';
}

function autobetStakeProfile(row){
  const type = String(row?.type || '').toLowerCase();
  const fallbackStake = Number(row?.stake);
  const basePref = Number(confidenceBaseStakeUnit);
  const boostPref = Number(confidenceBoostStakeUnit);
  const stakeCap = Number(stakePerRace);
  const signal = confidenceSignalPct(row);
  const isExotic = ['top2','top3','top4','trifecta','multi'].includes(type);
  const qualifies = !isExotic && Number.isFinite(signal) && signal >= confidenceSignalThreshold;
  let target = Number.isFinite(basePref) && basePref > 0 ? basePref : (Number.isFinite(fallbackStake) ? fallbackStake : null);
  const boostValue = Number.isFinite(boostPref) && boostPref > 0 ? boostPref : target;
  if (qualifies && Number.isFinite(boostValue)) target = boostValue;
  if (!Number.isFinite(target) || target <= 0) target = Number.isFinite(fallbackStake) ? fallbackStake : null;
  if (Number.isFinite(stakeCap) && stakeCap > 0 && Number.isFinite(target)) target = Math.min(target, stakeCap);
  if (!Number.isFinite(target) || target <= 0) {
    return { stake: null, tier: qualifies ? 'boosted' : 'base', qualifies, signal };
  }
  return { stake: Math.round(target * 100) / 100, tier: qualifies ? 'boosted' : 'base', qualifies, signal };
}

function renderAutobetFeed(rows){
  const table = $('autobetFeed');
  if (!table) return;
  table.innerHTML = '';
  const queued = (rows || []).filter(r => String(r.type || '').toLowerCase().includes('queued'));
  const filtered = autobetFilterType === 'ALL'
    ? queued
    : queued.filter(r => autobetStrategyKey(r.type) === autobetFilterType);
  let sourceRows = filtered;
  let feedNote = '';
  if (!filtered.length) {
    const plannedWindow = Number(earlyWindowMin || 1800);
    const allowedTypes = new Set(['win','ew','top2','top3','top4','trifecta','multi']);
    const planned = (latestSuggestedBets || [])
      .filter(selectionIsUpcoming)
      .filter(r => allowedTypes.has(String(r.type || 'win').toLowerCase()))
      .filter(r => jumpsInToMinutes(r.jumpsIn) <= plannedWindow)
      .map(r => ({
        meeting: r.meeting,
        race: r.race,
        selection: r.selection,
        type: r.type,
        stake: r.stake,
        odds: r.odds || parseReasonOdds(r.reason),
        eta: r.jumpsIn,
        aiWinProb: r.aiWinProb,
        reason: r.reason
      }));
    const plannedFiltered = autobetFilterType === 'ALL'
      ? planned
      : planned.filter(r => autobetStrategyKey(r.type) === autobetFilterType);
    sourceRows = plannedFiltered;
    feedNote = sourceRows.length
      ? `No queued bets yet — showing bets inside the ${plannedWindow}m bet window.`
      : (autobetFilterType === 'ALL' ? 'No queued bets right now.' : `No queued bets for ${autobetFilterType}.`);
  }
  const sortKey = (row) => {
    const mins = jumpsInToMinutes(row.eta || row.jumpsIn);
    if (Number.isFinite(mins) && mins !== Number.POSITIVE_INFINITY) return mins;
    const ts = selectionStartTimestamp(row);
    if (Number.isFinite(ts)) return (ts - Date.now()) / 60000;
    return Number.POSITIVE_INFINITY;
  };
  sourceRows = sourceRows.slice().sort((a,b) => sortKey(a) - sortKey(b));

  if (!sourceRows.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    empty.innerHTML = `<div style='grid-column:1/-1'>${feedNote}</div>`;
    table.appendChild(empty);
    return;
  }
  if (feedNote) {
    const note = document.createElement('div');
    note.className = 'row';
    note.innerHTML = `<div style='grid-column:1/-1' class='sub'>${feedNote}</div>`;
    table.appendChild(note);
  }
  const header = document.createElement('div');
  header.className = 'row header';
  header.innerHTML = `<div>Race</div><div>Selection</div><div>Type</div><div>AI %</div><div>Stake</div><div>Odds</div><div class='right'>ETA</div>`;
  table.appendChild(header);
  const probMap = new Map();
  (latestSuggestedBets || []).forEach(x => {
    const key = `${String(x.meeting || '').trim().toLowerCase()}|${String(x.race || '').trim()}|${normalizeRunnerName(String(x.selection || '').trim())}`;
    const wp = Number(x.aiWinProb);
    const prob = Number.isFinite(wp) ? wp : parseReasonWinProb(x.reason);
    if (Number.isFinite(prob)) probMap.set(key, prob);
  });
  sourceRows.forEach(r => {
    const row = document.createElement('div');
    row.className = 'row';
    const typeLabel = String(r.type || '').replace(/\(queued\)/i, '').trim();
    const tagClass = autobetTagClass(typeLabel);
    const key = `${String(r.meeting || '').trim().toLowerCase()}|${String(r.race || '').trim()}|${normalizeRunnerName(String(r.selection || '').trim())}`;
    const directProb = Number(r.aiWinProb);
    const aiProb = Number.isFinite(directProb) ? directProb : probMap.get(key);
    const stakeProfile = autobetStakeProfile(r);
    const stakeValue = Number.isFinite(stakeProfile.stake) ? `$${stakeProfile.stake.toFixed(2)}` : (Number.isFinite(Number(r.stake)) ? `$${Number(r.stake).toFixed(2)}` : '—');
    const stakeTier = Number.isFinite(stakeProfile.stake) ? `<div class='sub autobet-stake-note ${stakeProfile.tier}'>${stakeProfile.tier === 'boosted' ? 'Boosted' : 'Base'}</div>` : '';
    row.innerHTML = `
      <div><span class="badge">${escapeHtml(String(r.meeting || ''))}</span> R${escapeHtml(String(r.race || '—'))}</div>
      <div>${escapeHtml(String(r.selection || '—'))}</div>
      <div><span class='${tagClass}'>${escapeHtml(typeLabel || '—')}</span></div>
      <div>${Number.isFinite(aiProb) ? `${aiProb.toFixed(1)}%` : '—'}</div>
      <div>${stakeValue}${stakeTier}</div>
      <div>${r.odds || '—'}</div>
      <div class='right'>${escapeHtml(String(r.eta || r.sortTime || 'upcoming'))}</div>
    `;
    table.appendChild(row);
  });
}

function renderAutobetTiles(daily){
  const wrap = $('autobetRoiTiles');
  if (!wrap) return;
  const windowDays = autobetWindow === 'day' ? 1 : (autobetWindow === 'week' ? 7 : (autobetWindow === 'month' ? 30 : 365));
  const agg = aggregateLastNDays(daily, windowDays);
  const empty = !agg;
  const pct = (wins, bets) => (Number.isFinite(wins) && Number.isFinite(bets) && bets > 0) ? (wins / bets) : null;
  const winPct = pct(agg?.pick?.win?.wins, agg?.pick?.win?.bets);
  const ewPct = pct(agg?.pick?.ew?.wins, agg?.pick?.ew?.bets);
  const oddsPct = pct(agg?.pick?.odds_runner?.wins, agg?.pick?.odds_runner?.bets);
  const longPct = pct(agg?.long?.wins, agg?.long?.bets);
  const exoticPct = pct(agg?.exotic?.hits, agg?.exotic?.bets);
  const roi = (profit, stake) => (Number.isFinite(profit) && Number.isFinite(stake) && stake > 0) ? (profit / stake) : null;
  const winRoi = roi(agg?.pick?.win?.profit_rec, agg?.pick?.win?.roi_stake_units);
  const ewRoi = roi(agg?.pick?.ew?.profit_rec, agg?.pick?.ew?.roi_stake_units);
  const oddsRoi = roi(agg?.pick?.odds_runner?.profit_rec, agg?.pick?.odds_runner?.roi_stake_units);
  const longRoi = roi(agg?.long?.profit_rec, agg?.long?.roi_stake_units);
  const exoticRoi = roi(agg?.exotic_profit, agg?.exotic_stake);
  const allWins = (agg?.pick?.win?.wins || 0) + (agg?.pick?.ew?.wins || 0) + (agg?.pick?.odds_runner?.wins || 0) + (agg?.long?.wins || 0) + (agg?.exotic?.hits || 0);
  const allBets = (agg?.pick?.win?.bets || 0) + (agg?.pick?.ew?.bets || 0) + (agg?.pick?.odds_runner?.bets || 0) + (agg?.long?.bets || 0) + (agg?.exotic?.bets || 0);
  const allPct = pct(allWins, allBets);
  const allProfit = (agg?.pick?.win?.profit_rec || 0) + (agg?.pick?.ew?.profit_rec || 0) + (agg?.pick?.odds_runner?.profit_rec || 0) + (agg?.long?.profit_rec || 0) + (agg?.exotic_profit || 0);
  const allStake = (agg?.pick?.win?.roi_stake_units || 0) + (agg?.pick?.ew?.roi_stake_units || 0) + (agg?.pick?.odds_runner?.roi_stake_units || 0) + (agg?.long?.roi_stake_units || 0) + (agg?.exotic_stake || 0);
  const allRoi = roi(allProfit, allStake);

  const tiles = [
    { key: 'ALL', label: 'ALL', pct: allPct, roi: allRoi },
    { key: 'WIN', label: 'WIN', pct: winPct, roi: winRoi },
    { key: 'EW', label: 'EW', pct: ewPct, roi: ewRoi },
    { key: 'ODDS', label: 'ODDS', pct: oddsPct, roi: oddsRoi },
    { key: 'LONG', label: 'LONG', pct: longPct, roi: longRoi },
    { key: 'EXOTICS', label: 'EXOTICS', pct: exoticPct, roi: exoticRoi }
  ];
  wrap.innerHTML = tiles.map(t => {
    const active = autobetFilterType === t.key ? 'active' : '';
    return `<div class='perf-card autobet-tile ${active}' data-filter='${t.key}'>
      <div class='label'>${t.label}</div>
      <div class='value'>${empty ? '—' : fmtPct(t.pct)}</div>
      <div class='sub'>ROI ${empty ? '—' : fmtRoi(t.roi)}</div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.autobet-tile').forEach(tile => {
    tile.onclick = () => {
      autobetFilterType = tile.dataset.filter || 'ALL';
      renderAutobetTiles(daily);
      renderAutobetFeed(latestUpcomingBets || []);
    };
  });
}

function renderAutobetWindowTabs(){
  const wrap = $('autobetWindowTabs');
  if (!wrap) return;
  wrap.querySelectorAll('button').forEach(btn => {
    const key = btn.dataset.window || 'day';
    btn.classList.toggle('active', key === autobetWindow);
    btn.onclick = () => {
      autobetWindow = key;
      renderAutobetWindowTabs();
      renderAutobetTiles(autobetPerfDaily);
    };
  });
}

function renderBets(rows){
  const table = $('betsTable');
  if (!table) return;
  table.innerHTML = '';

  const ordered = (rows || []).slice().sort((a,b)=> String(a.sortTime||a.eta||'').localeCompare(String(b.sortTime||b.eta||'')));
  if (!ordered.length) {
    const previewPool = baseSuggestedRows(latestSuggestedBets || [])
      .filter(r => jumpsInToMinutes(r.jumpsIn) <= Number(aiWindowMin || 10));
    const preview = previewPool.slice(0,5);
    const previewHtml = preview.length
      ? `<div style='margin-top:8px;color:#c9d5e3;font-size:12px'><b>Next suggested bets (<=${Number(aiWindowMin || 10)}m):</b><br>${preview.map(x=>`• ${x.meeting} R${x.race} — ${x.selection} (${x.type} $${x.stake})`).join('<br>')}</div>`
      : '';

    const empty = document.createElement('div');
    empty.className='row';
    empty.innerHTML = `
      <div style='grid-column:1/-1'>
        <div><b>Window open — waiting for trigger.</b></div>
        <div style='color:#8ea0b5;font-size:12px;margin-top:4px'>
          No entries yet means no bets are inside the immediate placement window (<=${aiWindowMin}m). Early plans remain on Suggested Bets.
        </div>
        ${previewHtml}
      </div>`;
    table.appendChild(empty);
    return;
  }

  const header = document.createElement('div');
  header.className='row header';
  header.innerHTML = `<div>Time</div><div>Selection</div><div>Stake</div><div>Odds</div><div class='right'>Race</div>`;
  table.appendChild(header);

  ordered.forEach(r=>{
    const row = document.createElement('div');
    row.className='row';
    const isQueued = String(r.type || '').includes('(Queued)');
    const raceCountdown = formatRaceCountdown(r.sortTime || r.eta);
    const timeCell = isQueued
      ? `<span class='queued-countdown' data-placeafter='${r.eta}'>${formatCountdown(r.eta)}</span>`
      : (raceCountdown
          ? `<span class='race-countdown' data-racetime='${r.sortTime || r.eta}' style='color:${raceCountdown.color};font-weight:700'>${raceCountdown.text}</span>`
          : `${r.eta || '—'}`);
    const src = String(r.source || '').toUpperCase();
    const srcFlag = src.includes('TAB') ? '<span class="badge">TAB</span>' : (src.includes('BETCHA') ? '<span class="badge">BETCHA</span>' : '');
    const cancelBtn = isQueued ? `<button class='btn btn-ghost cancel-queued-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-selection='${String(r.selection||'').replace(/"/g,'&quot;')}' style='margin-left:6px;padding:4px 8px'>Cancel</button>` : '';
    row.innerHTML = `
      <div>${timeCell}</div>
      <div><button class='bet-btn' data-meeting='${r.meeting}' data-race='${r.race}' data-selection='${r.selection}'><span class='bet-icon'>🎯</span>${r.selection}</button></div>
      <div>$${r.stake} ${r.type}${cancelBtn}</div>
      <div>${r.odds || '—'}</div>
      <div class='right'>${srcFlag} <span class="badge">${r.meeting}</span> R${r.race}</div>
    `;
    table.appendChild(row);
  });

  scrollerAttach();
  document.querySelectorAll('.cancel-queued-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      try {
        const res = await fetchLocal('./api/cancel-ai-bet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meeting: btn.dataset.meeting, race: btn.dataset.race, selection: btn.dataset.selection })
        });
        const out = await res.json();
        await loadStatus();
        alert(`Cancelled queued bet(s): ${out.removed || 0}`);
      } catch {
        alert('Failed to cancel queued bet.');
      }
    };
  });
  tickQueuedCountdowns();
}

function renderAiCompare(rows){
  const table = $('aiCompareTable');
  if (!table) return;
  table.innerHTML = '';
  if (!rows || !rows.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    empty.innerHTML = `<div style='grid-column:1/-1'>No placed bets to compare yet</div>`;
    table.appendChild(empty);
    return;
  }

  rows.forEach(r => {
    let cls = 'comp-red';
    let txt = 'No AI match';
    if (r.matchesAiSelection && r.pctBetVsAi != null) {
      if (r.pctBetVsAi >= 90 && r.pctBetVsAi <= 110) { cls = 'comp-green'; txt = `${r.pctBetVsAi}% of AI stake`; }
      else if (r.pctBetVsAi >= 70 && r.pctBetVsAi <= 130) { cls = 'comp-amber'; txt = `${r.pctBetVsAi}% of AI stake`; }
      else { cls = 'comp-red'; txt = `${r.pctBetVsAi}% of AI stake`; }
    }

    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div><span class="badge">${r.meeting}</span> R${r.race}</div>
      <div>${r.selection}</div>
      <div>Bet $${r.placedStake}</div>
      <div>AI $${r.aiStake || 0}</div>
      <div class='right'><div class='comp-box ${cls}'>${r.matchesAiSelection ? '✅ Match' : '⚠️ No match'} · ${txt}</div></div>
    `;
    table.appendChild(row);
  });
}

function buildPostRaceCommentary(b){
  const odds = Number(b.odds || 0);
  const stake = Number(b.stake || 0);
  const implied = odds > 0 ? (100 / odds) : null;
  const conf = implied ? (implied >= 30 ? 'high-conviction profile' : (implied >= 18 ? 'medium-conviction profile' : 'value/longshot profile')) : 'profile unavailable';
  return `${b.selection} was a ${b.type} bet (${conf})${implied ? ` at ~${implied.toFixed(1)}% implied win` : ''}. Stake discipline: $${stake.toFixed(2)} from ${b.source || 'system'} flow.`;
}

async function markCompletedResult(meeting, race, selection, result){
  try {
    await fetchLocal('./api/completed-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meeting, race, selection, result })
    });
    await loadStatus();
  } catch (e) {
    console.error('markCompletedResult failed', e);
  }
}

function renderCompleted(rows){
  const table = $('completedTable');
  if (!table) return;
  table.innerHTML = '';
  if (!rows || !rows.length) {
    const empty = document.createElement('div');
    empty.className = 'row';
    empty.innerHTML = `<div style='grid-column:1/-1'>No completed bets yet</div>`;
    table.appendChild(empty);
    return;
  }

  const wins = rows.filter(x => x.result === 'win').length;
  const losses = rows.filter(x => x.result === 'loss').length;
  const ewWins = rows.filter(x => x.result === 'ew_win').length;
  const ewPlaces = rows.filter(x => x.result === 'ew_place').length;
  const ewLosses = rows.filter(x => x.result === 'ew_loss').length;
  const pending = rows.filter(x => !x.result || x.result === 'pending').length;
  const wl = document.createElement('div');
  wl.className = 'row';
  wl.innerHTML = `<div style='grid-column:1/-1'><b>Win/Loss Report:</b> W ${wins} · L ${losses} · EW Win ${ewWins} · EW Place ${ewPlaces} · EW Loss ${ewLosses} · Pending ${pending}</div>`;
  table.appendChild(wl);

  rows.slice(0,20).forEach(b => {
    const row = document.createElement('div');
    row.className = 'row';
    const commentary = buildPostRaceCommentary(b);
    const result = String(b.result || 'pending');
    const resultTag = result === 'win' ? `<span class='tag win'>WIN</span>`
      : result === 'loss' ? `<span class='tag'>LOSS</span>`
      : result === 'ew_win' ? `<span class='tag win'>EW WIN</span>`
      : result === 'ew_place' ? `<span class='tag value'>EW PLACE</span>`
      : result === 'ew_loss' ? `<span class='tag'>EW LOSS</span>`
      : `<span class='tag value'>PENDING</span>`;
    row.innerHTML = `
      <div><span class="badge">${b.meeting}</span> R${b.race}</div>
      <div><button class='bet-btn completed-btn' data-title='${(b.meeting+' R'+b.race+' — '+b.selection).replace(/"/g,'&quot;')}' data-commentary='${commentary.replace(/"/g,'&quot;')}'><span class='bet-icon'>📘</span>${b.selection}</button></div>
      <div>${b.type} ${resultTag}</div>
      <div>$${b.stake}</div>
      <div class='right'>${b.eta || 'Completed'}<div class='btn-row' style='justify-content:flex-end'><button class='btn btn-ghost completed-win' data-meeting='${b.meeting}' data-race='${b.race}' data-selection='${(b.selection||'').replace(/"/g,'&quot;')}'>Win</button><button class='btn btn-ghost completed-loss' data-meeting='${b.meeting}' data-race='${b.race}' data-selection='${(b.selection||'').replace(/"/g,'&quot;')}'>Loss</button><button class='btn btn-ghost completed-ew-win' data-meeting='${b.meeting}' data-race='${b.race}' data-selection='${(b.selection||'').replace(/"/g,'&quot;')}'>EW Win</button><button class='btn btn-ghost completed-ew-place' data-meeting='${b.meeting}' data-race='${b.race}' data-selection='${(b.selection||'').replace(/"/g,'&quot;')}'>EW Place</button><button class='btn btn-ghost completed-ew-loss' data-meeting='${b.meeting}' data-race='${b.race}' data-selection='${(b.selection||'').replace(/"/g,'&quot;')}'>EW Loss</button></div></div>
    `;
    table.appendChild(row);
  });

  document.querySelectorAll('.completed-btn').forEach(btn => {
    btn.onclick = () => {
      openSummaryPopup(btn.dataset.title || 'Completed Bet', `<div><b>AI Post-Race Analysis</b></div><div style='margin-top:8px'>${btn.dataset.commentary || ''}</div>`);
    };
  });
  document.querySelectorAll('.completed-win').forEach(btn => {
    btn.onclick = () => markCompletedResult(btn.dataset.meeting, btn.dataset.race, btn.dataset.selection, 'win');
  });
  document.querySelectorAll('.completed-loss').forEach(btn => {
    btn.onclick = () => markCompletedResult(btn.dataset.meeting, btn.dataset.race, btn.dataset.selection, 'loss');
  });
  document.querySelectorAll('.completed-ew-win').forEach(btn => {
    btn.onclick = () => markCompletedResult(btn.dataset.meeting, btn.dataset.race, btn.dataset.selection, 'ew_win');
  });
  document.querySelectorAll('.completed-ew-place').forEach(btn => {
    btn.onclick = () => markCompletedResult(btn.dataset.meeting, btn.dataset.race, btn.dataset.selection, 'ew_place');
  });
  document.querySelectorAll('.completed-ew-loss').forEach(btn => {
    btn.onclick = () => markCompletedResult(btn.dataset.meeting, btn.dataset.race, btn.dataset.selection, 'ew_loss');
  });
}

function isCompositeSelection(selRaw){
  const s = String(selRaw || '').toLowerCase();
  return s.includes(' x ') || s.includes(' / ') || s.includes(' > ');
}

function scrollerAttach(){
  document.querySelectorAll('#betsTable .bet-btn').forEach(btn=>{
    btn.onclick = async () => {
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      const selRaw = String(btn.dataset.selection || '');
      const selNorm = normalizeRunnerName(selRaw.replace(/^\d+\.\s*/, '').trim());
      const composite = isCompositeSelection(selRaw);
      const runner = composite ? null : (race.runners || []).find(x => {
        const nm = normalizeRunnerName(String(x.name || x.runner_name || '').trim());
        return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
      });
      if (runner) {
        openSummaryPopup(`${race.meeting} R${race.race_number} — ${runner.name}`, renderHorseAnalysis(race, runner));
      } else {
        // fallback for multis/combined selections
        openSummaryPopup(`${race.meeting} R${race.race_number} — ${race.description}`, `<div style='margin-bottom:8px'><b>Selection:</b> ${selRaw}</div>` + renderAnalysis(race));
      }
    };
  });
}

function attachNextPlannedHandlers(){
  document.querySelectorAll('#nextPlannedTable .planned-race-btn').forEach(btn=>{
    btn.onclick = async () => {
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      setActivePage('workspace');
      await selectRace(race.key);
      $('analysisBody').innerHTML += `<div style='margin-top:6px;color:#7aa3c7'>Loaded from Bet Plans</div>`;
    };
  });

  document.querySelectorAll('#nextPlannedTable .next-planned-btn').forEach(btn=>{
    btn.onclick = async () => {
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      const selRaw = String(btn.dataset.selection || '');
      const selNorm = normalizeRunnerName(selRaw.replace(/^\d+\.\s*/, '').trim());
      const composite = isCompositeSelection(selRaw);
      const runner = composite ? null : (race.runners || []).find(x => {
        const nm = normalizeRunnerName(String(x.name || x.runner_name || '').trim());
        return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
      });
      if (runner) {
        openSummaryPopup(`${race.meeting} R${race.race_number} — ${runner.name}`, renderHorseAnalysis(race, runner));
      } else {
        openSummaryPopup(`${race.meeting} R${race.race_number} — ${race.description}`, `<div style='margin-bottom:8px'><b>Selection:</b> ${selRaw}</div>` + renderAnalysis(race));
      }
    };
  });
}

function attachMultisHandlers(){
  const table = $('multisTable');
  if (!table) return;
  table.querySelectorAll('.multi-race-btn').forEach(btn=>{
    btn.onclick = async () => {
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      setActivePage('workspace');
      await selectRace(race.key);
      $('analysisBody').innerHTML += `<div style='margin-top:6px;color:#7aa3c7'>Loaded from Multis</div>`;
    };
  });
}

function attachInterestingHandlers(){
  document.querySelectorAll('.interesting-race-btn').forEach(btn=>{
    btn.onclick = async () => {
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      setActivePage('workspace');
      await selectRace(race.key);
      $('analysisBody').innerHTML += `<div style='margin-top:6px;color:#7aa3c7'>Loaded from Interesting Runners</div>`;
    };
  });

  document.querySelectorAll('.interesting-btn').forEach(btn=>{
    btn.onclick = async () => {
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      setActivePage('workspace');
      await selectRace(race.key);
      const selRaw = String(btn.dataset.runner || '');
      const selNorm = normalizeRunnerName(selRaw.replace(/^\d+\.\s*/, '').trim());
      const runner = (race.runners || []).find(x => {
        const nm = normalizeRunnerName(String(x.name || x.runner_name || '').trim());
        return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
      });
      if (runner && $('analysisBody')) {
        $('analysisBody').innerHTML += `<div style='margin-top:6px;color:#7aa3c7'>Focused from Interesting Runners: ${escapeHtml(runner.name || runner.runner_name || selRaw)}</div>`;
      }
    };
  });
}

function attachSuggestedHandlers(){
  document.querySelectorAll('.suggested-race-btn').forEach(btn=>{
    btn.onclick = async () => {
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      setActivePage('workspace');
      await selectRace(race.key);
      $('analysisBody').innerHTML += `<div style='margin-top:6px;color:#7aa3c7'>Loaded from Suggested Bets</div>`;
    };
  });

  document.querySelectorAll('.suggested-btn').forEach(btn=>{
    btn.onclick = async () => {
      const race = await findRaceForButton(btn.dataset.meeting, btn.dataset.race);
      if (!race) return alert('Race not found in cache yet. Try Refresh.');
      const selRaw = String(btn.dataset.selection || '');
      const selNorm = normalizeRunnerName(selRaw.replace(/^\d+\.\s*/, '').trim());
      const composite = isCompositeSelection(selRaw);
      const runner = composite ? null : (race.runners || []).find(x => {
        const nm = normalizeRunnerName(String(x.name || x.runner_name || '').trim());
        return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
      });
      if (runner) {
        openSummaryPopup(
          `${race.meeting} R${race.race_number} — ${runner.name}`,
          renderHorseAnalysis(race, runner) + `<div style='margin-top:8px'><b>Suggested Bet Rationale:</b> ${btn.dataset.reason || ''}</div>`
        );
      } else {
        // exotics/multi selections may not map to a single runner label
        openSummaryPopup(
          `${race.meeting} R${race.race_number} — ${race.description}`,
          `<div style='margin-bottom:8px'><b>Suggested Bet:</b> ${selRaw}</div><div style='margin-bottom:8px'><b>Rationale:</b> ${btn.dataset.reason || ''}</div>` + renderAnalysis(race)
        );
      }
    };
  });
}

function renderFeel(f){
  const s = Math.max(0, Math.min(100, Number(f.score || 50)));
  $('feelScore').textContent = s;
  $('feelWins').textContent = f.wins || 0;
  $('feelLosses').textContent = f.losses || 0;
  const bar = $('feelBar');
  bar.style.width = `${s}%`;
  bar.style.background = s >= 65 ? '#c5ff00' : (s >= 40 ? '#f5c066' : '#ff6b6b');
}

async function markFeel(result){
  try {
    const r = await fetchLocal('./api/bet-result', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ result })
    });
    const out = await r.json();
    renderFeel(out);
    await loadStatus();
  } catch (e) {
    console.error('feel update failed', e);
  }
}

function renderActivity(rows){
  const wrap = $('activity');
  wrap.innerHTML='';
  rows.forEach(r=>{
    const item = document.createElement('div');
    item.className='activity-item';
    item.textContent = r;
    wrap.appendChild(item);
  });
}

function fmtPct(val){
  if (!Number.isFinite(val)) return '—';
  return `${(val * 100).toFixed(1)}%`;
}

function fmtRoi(val){
  if (!Number.isFinite(val)) return '—';
  const sign = val > 0 ? '+' : '';
  return `${sign}${(val * 100).toFixed(1)}%`;
}

function fmtRoiZero(val){
  const n = Number.isFinite(val) ? val : 0;
  return fmtRoi(n);
}

function fmtUnits(val){
  if (!Number.isFinite(val)) return '—';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(1)}u`;
}

function latestKey(obj){
  if (!obj || typeof obj !== 'object') return null;
  const keys = Object.keys(obj).sort();
  return keys.length ? keys[keys.length - 1] : null;
}

function renderPerformanceTable(targetId, data, opts = {}){
  const el = $(targetId);
  if (!el) return;
  if (!data || typeof data !== 'object') {
    el.innerHTML = '<div class="sub">No data yet.</div>';
    return;
  }
  const keys = Object.keys(data).sort().reverse();
  if (!keys.length) {
    el.innerHTML = '<div class="sub">No data yet.</div>';
    return;
  }
  const showRoi = !!isAdminUser;
  if (opts.strategyDetail) {
    const buildCell = (label, stats) => {
      const bets = stats?.bets ?? 0;
      const winRate = stats?.win_rate ?? null;
      const roi = stats?.roi_rec ?? null;
      const roiLine = showRoi ? `<div data-roi-only>ROI ${fmtRoi(roi)}</div>` : '';
      return `<div class='strategy-cell'>
        <div class='strategy-label'>${label}</div>
        <div>Bets ${bets || '—'}</div>
        <div>Win ${fmtPct(winRate)}</div>
        ${roiLine}
      </div>`;
    };
    const rows = keys.slice(0, 30).map(key => {
      const r = data[key] || {};
      const picks = r.pick_breakdown || {};
      const longPick = r.long_breakdown || {};
      return `<tr>
        <td data-label="Period">${key}</td>
        <td data-label="Win Strategy">${buildCell('Win Strategy', picks.win)}</td>
        <td data-label="Odds Runner">${buildCell('Odds Runner', picks.odds_runner)}</td>
        <td data-label="Each Way">${buildCell('Each Way', picks.ew)}</td>
        <td data-label="Long Odds">${buildCell('Long Odds', longPick)}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `
      <table class="perf-table">
        <thead>
          <tr>
            <th>Period</th>
            <th>Win Strategy</th>
            <th>Odds Runner</th>
            <th>Each Way</th>
            <th>Long Odds</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
    applyPerformanceVisibility();
    return;
  }
  const withMix = !!opts.withMix;
  const withExotics = !!opts.withExotics;
  const rows = keys.slice(0, 30).map(key => {
    const r = data[key] || {};
    let mixCells = '';
    if (withMix) {
      const picks = r.pick_breakdown || {};
      const winBets = picks.win?.bets ?? 0;
      const oddsBets = picks.odds_runner?.bets ?? 0;
      const ewBets = picks.ew?.bets ?? 0;
      const pickTotal = winBets + oddsBets + ewBets;
      mixCells = `
        <td data-label="Win Bet %">${fmtPct(pickTotal ? winBets / pickTotal : null)}</td>
        <td data-label="Odds Runner %">${fmtPct(pickTotal ? oddsBets / pickTotal : null)}</td>
        <td data-label="Each Way %">${fmtPct(pickTotal ? ewBets / pickTotal : null)}</td>`;
    }
    let exoticCells = '';
    if (withExotics) {
      const exoticBreakdown = r.exotic_breakdown || {};
      const exoticBets = Object.values(exoticBreakdown).reduce((a,b)=>a+(b?.bets||0),0);
      const roiCell = showRoi ? `<td data-label="Exotic ROI">${fmtRoi(r.exotic_roi_tote)}</td>` : '';
      exoticCells = `
        <td data-label="Exotic Bets">${exoticBets}</td>
        <td data-label="Exotic Hit Rate">${fmtPct(r.exotic_hit_rate)}</td>
        ${roiCell}`;
    }
    const roiCells = showRoi
      ? `<td data-label="ROI Tote">${fmtRoiZero(r.roi_tote)}</td>
      <td data-label="ROI Rec">${fmtRoi(r.roi_rec)}</td>
      <td data-label="ROI SP">${fmtRoi(r.roi_sp)}</td>
      <td data-label="ROI EW">${fmtRoi(r.roi_ew)}</td>`
      : '';
    return `<tr>
      <td data-label="Period">${key}</td>
      <td data-label="Win Bets">${r.win_bets ?? 0}</td>
      <td data-label="Win Rate">${fmtPct(r.win_rate)}</td>
      ${mixCells}
      ${exoticCells}
      ${roiCells}
    </tr>`;
  }).join('');
  const mixHeaders = withMix ? '<th>Win Strategy %</th><th>Odds Runner %</th><th>Each Way %</th>' : '';
  const exoticHeaders = withExotics
    ? `<th>Exotic Bets</th><th>Exotic Hit Rate</th>${showRoi ? '<th>Exotic ROI</th>' : ''}`
    : '';
  const roiHeaders = showRoi ? '<th>ROI Tote</th><th>ROI Rec</th><th>ROI SP</th><th>ROI EW</th>' : '';
  el.innerHTML = `
    <table class="perf-table">
      <thead>
        <tr>
          <th>Period</th>
          <th>Win Bets</th>
          <th>Win Rate</th>
          ${mixHeaders}
          ${exoticHeaders}
          ${roiHeaders}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderPerformanceCharts(daily){
  if (!daily || typeof daily !== 'object') return;
  if (typeof Chart === 'undefined') return;
  const keys = Object.keys(daily).sort();
  if (!keys.length) return;

  const lastKeys = keys.slice(-30);
  const labels = lastKeys.map(k => k.slice(5));
  const roiSeries = lastKeys.map(k => Number.isFinite(daily[k]?.roi_rec) ? (daily[k].roi_rec * 100) : null);
  const roiMovingAvg30 = roiSeries.map((_, idx, arr) => {
    const start = Math.max(0, idx - 29);
    const window = arr.slice(start, idx + 1).filter(v => Number.isFinite(v));
    if (!window.length) return null;
    return window.reduce((sum, v) => sum + v, 0) / window.length;
  });
  const winSeriesWin = lastKeys.map(k => Number.isFinite(daily[k]?.pick_breakdown?.win?.win_rate) ? (daily[k].pick_breakdown.win.win_rate * 100) : null);
  const winSeriesOdds = lastKeys.map(k => Number.isFinite(daily[k]?.pick_breakdown?.odds_runner?.win_rate) ? (daily[k].pick_breakdown.odds_runner.win_rate * 100) : null);
  const winSeriesEw = lastKeys.map(k => Number.isFinite(daily[k]?.pick_breakdown?.ew?.win_rate) ? (daily[k].pick_breakdown.ew.win_rate * 100) : null);
  const winSeriesLong = lastKeys.map(k => Number.isFinite(daily[k]?.long_breakdown?.win_rate) ? (daily[k].long_breakdown.win_rate * 100) : null);

  const agg = aggregateLastNDays(daily, 30);
  let score = 50;
  let winRate = 0;
  let roiRec = 0;
  let betCount = 0;
  if (agg) {
    winRate = agg.win_bets ? agg.wins / agg.win_bets : 0;
    roiRec = agg.roi_stake ? agg.roi_rec_profit / agg.roi_stake : 0;
    betCount = agg.win_bets || agg.total_bets || 0;
    const sampleFactor = Math.min(1, (betCount || 0) / 200);
    const roiScore = Math.max(0, Math.min(100, 50 + (roiRec * 100) * 1.2));
    const winScore = Math.max(0, Math.min(100, 50 + ((winRate * 100) - 25) * 1.0));
    const rawScore = (roiScore * 0.65) + (winScore * 0.35);
    score = Math.max(0, Math.min(100, 50 * (1 - sampleFactor) + rawScore * sampleFactor));
  }
  const scoreEl = $('feelGoodScore');
  if (scoreEl) scoreEl.textContent = `${Math.round(score)}%`;
  const noteEl = $('feelGoodNote');
  if (noteEl) {
    const mood = score >= 70 ? 'Hot' : score >= 55 ? 'Positive' : score >= 45 ? 'Neutral' : score >= 30 ? 'Soft' : 'Cold';
    const roiText = agg ? `ROI ${fmtRoi(roiRec)}` : 'ROI —';
    const winText = agg ? `Win ${fmtPct(winRate)}` : 'Win —';
    const betText = agg ? `Bets ${betCount}` : 'Bets —';
    noteEl.textContent = `${mood} · ${roiText} · ${winText} · ${betText}`;
  }

  const feelCanvas = $('feelGoodChart');
  if (feelCanvas) {
    const scoreColor = score >= 65 ? '#c5ff00' : (score >= 40 ? '#f5c066' : '#ff6b6b');
    if (feelGoodChart) feelGoodChart.destroy();
    feelGoodChart = new Chart(feelCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Score', 'Remaining'],
        datasets: [{
          data: [score, 100 - score],
          backgroundColor: [scoreColor, 'rgba(255,255,255,.08)'],
          borderWidth: 0
        }]
      },
      options: {
        cutout: '78%',
        circumference: 180,
        rotation: 270,
        plugins: { legend: { display: false }, tooltip: { enabled: false } }
      }
    });
  }

  const roiCanvas = $('roiTrendChart');
  if (roiCanvas) {
    if (roiTrendChart) roiTrendChart.destroy();
    roiTrendChart = new Chart(roiCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'ROI (Rec)',
            data: roiSeries,
            borderColor: '#c5ff00',
            backgroundColor: 'rgba(197,255,0,.12)',
            borderWidth: 2,
            tension: 0.35,
            fill: true,
            pointRadius: 0
          },
          {
            label: '30D MA',
            data: roiMovingAvg30,
            borderColor: '#7aa3c7',
            backgroundColor: 'rgba(122,163,199,0)',
            borderWidth: 2,
            tension: 0.2,
            fill: false,
            pointRadius: 0,
            borderDash: [6, 4]
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels: { color: '#8ea0b5', boxWidth: 10, boxHeight: 10 } }
        },
        scales: {
          x: { ticks: { color: '#8ea0b5' }, grid: { display: false } },
          y: { ticks: { color: '#8ea0b5', callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,.06)' } }
        }
      }
    });
  }

  const winCanvas = $('winRateTrendChart');
  if (winCanvas) {
    if (winRateTrendChart) winRateTrendChart.destroy();
    winRateTrendChart = new Chart(winCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Win',
            data: winSeriesWin,
            borderColor: '#c5ff00',
            backgroundColor: 'rgba(197,255,0,.10)',
            borderWidth: 2,
            tension: 0.35,
            fill: false,
            pointRadius: 0
          },
          {
            label: 'Odds',
            data: winSeriesOdds,
            borderColor: '#7aa3c7',
            backgroundColor: 'rgba(122,163,199,.08)',
            borderWidth: 2,
            tension: 0.35,
            fill: false,
            pointRadius: 0
          },
          {
            label: 'EW',
            data: winSeriesEw,
            borderColor: '#f5c066',
            backgroundColor: 'rgba(245,192,102,.08)',
            borderWidth: 2,
            tension: 0.35,
            fill: false,
            pointRadius: 0
          },
          {
            label: 'Long',
            data: winSeriesLong,
            borderColor: '#ff6b6b',
            backgroundColor: 'rgba(255,107,107,.08)',
            borderWidth: 2,
            tension: 0.35,
            fill: false,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, labels: { color: '#8ea0b5' } } },
        scales: {
          x: { ticks: { color: '#8ea0b5' }, grid: { display: false } },
          y: { min: 0, max: 100, ticks: { color: '#8ea0b5', callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,.06)' } }
        }
      }
    });
  }

  const netUnitsSeries = lastKeys.map(k => {
    const r = daily[k] || {};
    const roiStake = Number.isFinite(r.roi_stake)
      ? r.roi_stake
      : (Number.isFinite(r.total_stake) ? r.total_stake : (Number.isFinite(r.win_bets) ? r.win_bets : 0));
    const baseProfit = Number.isFinite(r.roi_rec) ? r.roi_rec * roiStake : 0;
    const exoticStake = Number.isFinite(r.exotic_roi_stake) ? r.exotic_roi_stake : 0;
    const exoticProfit = (Number.isFinite(r.exotic_roi_tote) && exoticStake)
      ? r.exotic_roi_tote * exoticStake
      : 0;
    const netProfit = baseProfit + exoticProfit;
    return Number.isFinite(netProfit) ? netProfit : null;
  });
  const cumulativeUnits = [];
  netUnitsSeries.forEach((v, idx) => {
    const prev = idx ? (cumulativeUnits[idx - 1] || 0) : 0;
    cumulativeUnits.push(prev + (Number.isFinite(v) ? v : 0));
  });
  const netRoiSeries = lastKeys.map(k => {
    const r = daily[k] || {};
    const roiStake = Number.isFinite(r.roi_stake)
      ? r.roi_stake
      : (Number.isFinite(r.total_stake) ? r.total_stake : (Number.isFinite(r.win_bets) ? r.win_bets : 0));
    const exoticStake = Number.isFinite(r.exotic_roi_stake) ? r.exotic_roi_stake : 0;
    const stake = (roiStake || 0) + (exoticStake || 0);
    const baseProfit = Number.isFinite(r.roi_rec) ? r.roi_rec * roiStake : 0;
    const exoticProfit = (Number.isFinite(r.exotic_roi_tote) && exoticStake)
      ? r.exotic_roi_tote * exoticStake
      : 0;
    const netProfit = baseProfit + exoticProfit;
    return stake ? (netProfit / stake) * 100 : null;
  });

  const returnUnitsCanvas = $('returnUnitsChart');
  if (returnUnitsCanvas) {
    if (returnUnitsChart) returnUnitsChart.destroy();
    returnUnitsChart = new Chart(returnUnitsCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Units',
            data: cumulativeUnits,
            borderColor: '#c5ff00',
            backgroundColor: 'rgba(197,255,0,.12)',
            borderWidth: 2,
            tension: 0.35,
            fill: true,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `Units: ${fmtUnits(ctx.raw)}` } }
        },
        scales: {
          x: { ticks: { display: false }, grid: { display: false } },
          y: { ticks: { color: '#8ea0b5', callback: v => fmtUnits(v) }, grid: { color: 'rgba(255,255,255,.06)' } }
        }
      }
    });
  }

  const returnRoiCanvas = $('returnRoiChart');
  if (returnRoiCanvas) {
    if (returnRoiChart) returnRoiChart.destroy();
    returnRoiChart = new Chart(returnRoiCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'ROI',
            data: netRoiSeries,
            borderColor: '#7aa3c7',
            backgroundColor: 'rgba(122,163,199,.12)',
            borderWidth: 2,
            tension: 0.35,
            fill: true,
            pointRadius: 0
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `ROI: ${Number.isFinite(ctx.raw) ? ctx.raw.toFixed(1) : '—'}%` } }
        },
        scales: {
          x: { ticks: { display: false }, grid: { display: false } },
          y: { ticks: { color: '#8ea0b5', callback: v => `${v}%` }, grid: { color: 'rgba(255,255,255,.06)' } }
        }
      }
    });
  }
}

function renderExoticsTable(targetId, data){
  const el = $(targetId);
  if (!el) return;
  if (!data || typeof data !== 'object') {
    el.innerHTML = '<div class="sub">No data yet.</div>';
    return;
  }
  const keys = Object.keys(data).sort().reverse();
  if (!keys.length) {
    el.innerHTML = '<div class="sub">No data yet.</div>';
    return;
  }
  const showRoi = !!isAdminUser;
  const rows = keys.slice(0, 30).map(key => {
    const r = data[key] || {};
    const exoticBets = r.exotic_breakdown ? Object.values(r.exotic_breakdown).reduce((a,b)=>a+(b?.bets||0),0) : 0;
    const roiCell = showRoi ? `<td data-label="Exotic ROI">${fmtRoi(r.exotic_roi_tote)}</td>` : '';
    return `<tr>
      <td data-label="Period">${key}</td>
      <td data-label="Exotic Bets">${exoticBets}</td>
      <td data-label="Hit Rate">${fmtPct(r.exotic_hit_rate)}</td>
      ${roiCell}
    </tr>`;
  }).join('');
  const roiHeader = showRoi ? '<th>Exotic ROI</th>' : '';
  el.innerHTML = `
    <table class="perf-table">
      <thead>
        <tr>
          <th>Period</th>
          <th>Exotic Bets</th>
          <th>Hit Rate</th>
          ${roiHeader}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderPickBreakdown(latest){
  const el = $('perfPickTable');
  if (!el) return;
  const data = latest?.pick_breakdown || {};
  const showRoi = !!isAdminUser;
  const rows = ['win','odds_runner','ew'].map(key => {
    const r = data[key] || {};
    const label = key === 'odds_runner' ? 'Odds Runner' : key.toUpperCase();
    const roiCells = showRoi
      ? `<td data-label="ROI Tote">${fmtRoiZero(r.roi_tote)}</td>
      <td data-label="ROI Rec">${fmtRoi(r.roi_rec)}</td>
      <td data-label="ROI SP">${fmtRoi(r.roi_sp)}</td>
      <td data-label="ROI EW">${fmtRoi(r.roi_ew)}</td>`
      : '';
    return `<tr>
      <td data-label="Pick">${label}</td>
      <td data-label="Bets">${r.bets ?? 0}</td>
      <td data-label="Win Rate">${fmtPct(r.win_rate)}</td>
      ${roiCells}
    </tr>`;
  });

  const exoticBreakdown = latest?.exotic_breakdown || {};
  const exoticBets = Object.values(exoticBreakdown).reduce((a,b)=>a+(b?.bets||0),0);
  const exoticHit = fmtPct(latest?.exotic_hit_rate);
  const exoticRoi = fmtRoi(latest?.exotic_roi_tote);
  const exoticRoiCells = showRoi
    ? `<td data-label="ROI Tote">${exoticRoi}</td>
      <td data-label="ROI Rec">—</td>
      <td data-label="ROI SP">—</td>
      <td data-label="ROI EW">—</td>`
    : '';
  rows.push(`<tr>
      <td data-label="Pick">EXOTIC</td>
      <td data-label="Bets">${exoticBets}</td>
      <td data-label="Win Rate">${exoticHit}</td>
      ${exoticRoiCells}
    </tr>`);

  const rowsHtml = rows.join('');
  const roiHeaders = showRoi ? '<th>ROI Tote</th><th>ROI Rec</th><th>ROI SP</th><th>ROI EW</th>' : '';
  el.innerHTML = `
    <table class="perf-table">
      <thead>
        <tr>
          <th>Pick</th>
          <th>Bets</th>
          <th>Win Rate</th>
          ${roiHeaders}
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
}

function renderLatestSnapshot(latest){
  const el = $('perfLatestSnapshotTable');
  if (!el) return;
  if (!latest) {
    el.innerHTML = '';
    return;
  }
  const picks = latest.pick_breakdown || {};
  const long = latest.long_breakdown || {};
  const cols = [
    { label: 'WIN', data: picks.win || {} },
    { label: 'ODDS', data: picks.odds_runner || {} },
    { label: 'EW', data: picks.ew || {} },
    { label: 'LONG', data: long || {} }
  ];
  const showRoi = !!isAdminUser;
  const row = (label, key) => `
    <tr>
      <td data-label="Metric">${label}</td>
      ${cols.map(col => {
        const v = col.data?.[key];
        const display = key === 'bets' ? (v ?? 0) : key === 'win_rate' ? fmtPct(v) : fmtRoi(v);
        return `<td data-label="${col.label}">${display}</td>`;
      }).join('')}
    </tr>`;

  el.innerHTML = `
    <table class="perf-table perf-snapshot">
      <thead>
        <tr>
          <th>Metric</th>
          ${cols.map(col => `<th>${col.label}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${row('Bets','bets')}
        ${row('Win Rate','win_rate')}
        ${showRoi ? row('ROI Rec','roi_rec') : ''}
      </tbody>
    </table>`;
}

function renderExoticBreakdown(latest){
  const el = $('perfExoticTable');
  if (!el) return;
  const data = latest?.exotic_breakdown || {};
  const showRoi = !!isAdminUser;
  const rows = ['top2','top3','top4','trifecta'].map(key => {
    const r = data[key] || {};
    const roiCell = showRoi ? `<td data-label="ROI Tote">${fmtRoiZero(r.roi_tote)}</td>` : '';
    return `<tr>
      <td data-label="Exotic">${key.toUpperCase()}</td>
      <td data-label="Bets">${r.bets ?? 0}</td>
      <td data-label="Hit Rate">${fmtPct(r.hit_rate)}</td>
      ${roiCell}
    </tr>`;
  }).join('');
  const roiHeader = showRoi ? '<th>ROI Tote</th>' : '';
  el.innerHTML = `
    <table class="perf-table">
      <thead>
        <tr>
          <th>Exotic</th>
          <th>Bets</th>
          <th>Hit Rate</th>
          ${roiHeader}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function betPlanWindowDays(window){
  if (window === 'week') return 7;
  if (window === 'month') return 30;
  return 1;
}

function betPlanLabel(window){
  if (window === 'week') return 'Last 7 Days';
  if (window === 'month') return 'Last 30 Days';
  return 'Latest Day';
}

function aggregatePedigreePerformance(daily, window){
  if (!daily || typeof daily !== 'object') return null;
  const keys = Object.keys(daily).sort().reverse();
  const days = Math.max(1, betPlanWindowDays(window));
  const selected = keys.slice(0, days);
  if (!selected.length) return null;
  const agg = { bets: 0, wins: 0, stake: 0, profit: 0, scoreSum: 0, scoreCount: 0, confSum: 0, confCount: 0, edgeSum: 0, edgeCount: 0, archetypes: {} };
  selected.forEach(key => {
    const ped = daily[key]?.pedigree_breakdown || {};
    agg.bets += Number(ped.bets || 0);
    agg.wins += Number((ped.win_rate != null && ped.bets != null) ? Math.round(ped.win_rate * ped.bets) : 0);
    agg.stake += Number(ped.roi_stake_units || ped.stake_units || 0);
    agg.profit += Number.isFinite(ped.roi_rec) && Number.isFinite(ped.roi_stake_units || ped.stake_units) ? Number(ped.roi_rec) * Number(ped.roi_stake_units || ped.stake_units || 0) : 0;
    if (Number.isFinite(ped.avg_score)) { agg.scoreSum += Number(ped.avg_score) * Number(ped.bets || 0); agg.scoreCount += Number(ped.bets || 0); }
    if (Number.isFinite(ped.avg_confidence)) { agg.confSum += Number(ped.avg_confidence) * Number(ped.bets || 0); agg.confCount += Number(ped.bets || 0); }
    if (Number.isFinite(ped.avg_edge)) { agg.edgeSum += Number(ped.avg_edge) * Number(ped.bets || 0); agg.edgeCount += Number(ped.bets || 0); }
    const archetypes = ped.archetypes || {};
    Object.entries(archetypes).forEach(([arch, vals]) => {
      if (!agg.archetypes[arch]) agg.archetypes[arch] = { bets: 0, wins: 0, profit: 0 };
      agg.archetypes[arch].bets += Number(vals?.bets || 0);
      agg.archetypes[arch].wins += Number(vals?.wins || 0);
      agg.archetypes[arch].profit += Number(vals?.profit || 0);
    });
  });
  return {
    bets: agg.bets,
    winRate: agg.bets ? agg.wins / agg.bets : null,
    roiRec: agg.stake ? agg.profit / agg.stake : null,
    avgScore: agg.scoreCount ? agg.scoreSum / agg.scoreCount : null,
    avgConfidence: agg.confCount ? agg.confSum / agg.confCount : null,
    avgEdge: agg.edgeCount ? agg.edgeSum / agg.edgeCount : null,
    archetypes: agg.archetypes
  };
}

function computeBetPlanStats(daily, window){
  if (!daily || typeof daily !== 'object') return null;
  const agg = aggregateLastNDays(daily, betPlanWindowDays(window));
  if (!agg) return null;
  const winRate = agg.win_bets ? agg.wins / agg.win_bets : null;
  const roiRec = agg.roi_stake ? agg.roi_rec_profit / agg.roi_stake : null;
  const roiSp = agg.roi_sp_stake ? agg.roi_sp_profit / agg.roi_sp_stake : 0;
  const roiTote = agg.roi_tote_stake ? agg.roi_tote_profit / agg.roi_tote_stake : 0;
  const bets = agg.total_bets ?? 0;
  const netUnits = agg.roi_rec_profit ?? null;
  const exoticHit = agg.exotic?.bets ? (agg.exotic.hits / agg.exotic.bets) : null;
  const exoticRoi = agg.exotic_stake ? (agg.exotic_profit / agg.exotic_stake) : 0;
  const summarizePick = (entry = {}) => {
    const b = entry.bets ?? 0;
    const wins = entry.wins ?? 0;
    const stake = entry.roi_stake_units ?? entry.stake_units ?? b;
    return {
      bets: b,
      winRate: b ? wins / b : null,
      roiRec: stake ? (entry.profit_rec ?? 0) / stake : null
    };
  };
  return {
    window,
    days: agg.days,
    bets,
    winRate,
    roiRec,
    roiSp,
    roiTote,
    netUnits,
    exoticHit,
    exoticRoi,
    racesRun: agg.races_run ?? null,
    racesWon: agg.races_won ?? null,
    baseProfit: agg.roi_rec_profit,
    baseStake: agg.roi_stake,
    exoticProfit: agg.exotic_profit,
    exoticStake: agg.exotic_stake,
    strategyBreakdown: {
      win: summarizePick(agg.pick?.win),
      odds: summarizePick(agg.pick?.odds_runner),
      ew: summarizePick(agg.pick?.ew),
      long: summarizePick(agg.long),
      pedigree: {
        ...summarizePick(agg.pedigree),
        avgScore: agg.pedigree?.score_count ? (agg.pedigree.score_sum / agg.pedigree.score_count) : null,
        avgConfidence: agg.pedigree?.confidence_count ? (agg.pedigree.confidence_sum / agg.pedigree.confidence_count) : null,
        avgEdge: agg.pedigree?.edge_count ? (agg.pedigree.edge_sum / agg.pedigree.edge_count) : null,
        archetypes: agg.pedigree?.archetypes || {}
      }
    }
  };
}

let signalThresholdAuditCache = null;

function renderSignalThresholdAuditPanel(audit){
  const wrap = $('betPlanPerformanceBreakdown');
  if (!wrap || !audit) return '';
  const renderBucketList = (obj, mode) => Object.entries(obj || {}).slice(0, 6).map(([k,v]) => `<div>${escapeHtml(k)} — Bets ${v?.bets || 0} · Win ${fmtPct(v?.winRate)}${mode ? ` · ROI ${fmtRoi(v?.roi)}` : ''}</div>`).join('') || '<div>No data</div>';
  const goodBuckets = Object.fromEntries(Object.entries(audit.byEdgeBand || {}).filter(([,v]) => Number(v?.roi) > 0).sort((a,b)=>Number(b[1].roi)-Number(a[1].roi)).slice(0,5));
  const badBuckets = Object.fromEntries(Object.entries(audit.byEdgeBand || {}).filter(([,v]) => Number(v?.roi) < 0).sort((a,b)=>Number(a[1].roi)-Number(b[1].roi)).slice(0,5));
  const blockedBuckets = {
    '0-2 edge': audit.byEdgeBand?.['0-2'] || null,
    '2-4 edge @ 5-8 odds': audit.topIntersections?.['20-25 | 2-4 | 5-8'] || audit.topIntersections?.['15-20 | 2-4 | 5-8'] || null,
    '20-25 model band': audit.byProbabilityBand?.['20-25'] || null
  };
  const policy = [
    'Main bet: edge ≥ 6 pts, confidence ≥ 65',
    'Secondary bet: edge ≥ 4 pts, confidence ≥ 58',
    'Block 0–2 pt edge',
    'Block 2–4 pt edge in 5–8 odds range',
    'Block toxic 20–25% model band unless exceptional support',
    'Block COLD form and track-dislike runners'
  ];
  return `<div class='bet-plan-breakdown-card' style='grid-column:1 / -1'>
    <div class='label'>Signal Threshold Audit v2</div>
    <div style='margin:6px 0 10px'>Current active threshold policy</div>
    <ul>${policy.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
    <div style='margin-top:10px'><b>Good buckets</b></div>
    ${renderBucketList(goodBuckets, true)}
    <div style='margin-top:10px'><b>Bad buckets</b></div>
    ${renderBucketList(badBuckets, true)}
    <div style='margin-top:10px'><b>Blocked buckets</b></div>
    ${renderBucketList(blockedBuckets, true)}
  </div>`;
}

function renderBetPlanPerformance(daily){
  if (daily) performanceDailyCache = daily;
  const cache = performanceDailyCache;
  const metricsWrap = $('betPlanPerformanceMetrics');
  const tableWrap = $('betPlanPerformanceTable');
  const breakdownWrap = $('betPlanPerformanceBreakdown');
  if (!metricsWrap || !tableWrap) return;
  if (!cache || !Object.keys(cache).length) {
    metricsWrap.innerHTML = '<div class="sub">No bet-plan data yet.</div>';
    tableWrap.innerHTML = '';
    if (breakdownWrap) breakdownWrap.innerHTML = '';
    return;
  }
  const coverageNote = latestKey(cache);
  const noteEl = $('betPlanPerformanceNote');
  const staleSuffix = (dateStr) => {
    const parsed = Date.parse(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(parsed)) return '';
    const diffDays = Math.floor((Date.now() - parsed) / 86400000);
    return diffDays > 1 ? ` ⚠️ ${diffDays} days old` : '';
  };
  if (noteEl) {
    noteEl.textContent = coverageNote ? `Settled through ${coverageNote}${staleSuffix(coverageNote)}. Fresh results land once TAB posts final dividends.` : '';
  }
  const stats = computeBetPlanStats(cache, betPlanPerfWindow);
  if (!stats) {
    metricsWrap.innerHTML = '<div class="sub">No bet-plan data for this window.</div>';
    tableWrap.innerHTML = '';
    if (breakdownWrap) breakdownWrap.innerHTML = '';
    return;
  }
  const showRoi = !!isAdminUser;
  const buildBreakdownCard = (label, data) => {
    if (!data || (!data.bets && !Number.isFinite(data.winRate))) {
      return `<div class='bet-plan-breakdown-card'><div class='label'>${label}</div><div>No data</div></div>`;
    }
    const lowSample = (data.bets ?? 0) < 5 ? `<div class='low-sample-warning'>Low sample</div>` : '';
    return `<div class='bet-plan-breakdown-card'>
      <div class='label'>${label}</div>
      <div>Bets ${data.bets ?? '—'}</div>
      <div>Win ${fmtPct(data.winRate)}</div>
      ${showRoi ? `<div data-roi-only>ROI ${fmtRoi(data.roiRec)}</div>` : ''}
      ${lowSample}
    </div>`;
  };
  const ewBets = stats.strategyBreakdown?.ew?.bets ?? 0;
  const pedigreeStats = aggregatePedigreePerformance(cache, betPlanPerfWindow);
  const cards = `
    <div class='perf-kpis'>
      <div class='perf-card'><div class='label'>Window</div><div class='value'>${betPlanLabel(betPlanPerfWindow)}</div></div>
      <div class='perf-card'><div class='label'>Bets</div><div class='value'>${stats.bets ?? '—'}</div></div>
      <div class='perf-card'><div class='label'>Win Rate</div><div class='value win-metric'>${fmtPct(stats.winRate)}</div></div>
      <div class='perf-card'><div class='label'>EW Bets</div><div class='value'>${ewBets}</div></div>
      <div class='perf-card' data-roi-only><div class='label'>ROI (Rec)</div><div class='value'>${fmtRoi(stats.roiRec)}</div></div>
      <div class='perf-card' data-roi-only><div class='label'>Net Units</div><div class='value'>${fmtUnits(stats.netUnits)}</div></div>
      <div class='perf-card'><div class='label'>Exotic Hit</div><div class='value win-metric'>${fmtPct(stats.exoticHit)}</div></div>
      <div class='perf-card' data-roi-only><div class='label'>Exotic ROI</div><div class='value'>${fmtRoi(stats.exoticRoi)}</div></div>
      <div class='perf-card'><div class='label'>Settled Races</div><div class='value'>${stats.racesRun ?? '—'}</div></div>
      <div class='perf-card'><div class='label'>Settled Won</div><div class='value'>${stats.racesWon ?? '—'}</div></div>
    </div>
    <div class='perf-kpis perf-kpis-secondary' style='margin-top:10px'>
      <div class='perf-card'><div class='label'>Pedigree Adv Bets</div><div class='value'>${pedigreeStats?.bets ?? 0}</div></div>
      <div class='perf-card'><div class='label'>Pedigree Win Rate</div><div class='value win-metric'>${fmtPct(pedigreeStats?.winRate)}</div></div>
      <div class='perf-card' data-roi-only><div class='label'>Pedigree ROI</div><div class='value'>${fmtRoi(pedigreeStats?.roiRec)}</div></div>
      <div class='perf-card'><div class='label'>Avg Ped Score</div><div class='value'>${Number.isFinite(pedigreeStats?.avgScore) ? pedigreeStats.avgScore.toFixed(1) : '—'}</div></div>
      <div class='perf-card'><div class='label'>Avg Ped Conf</div><div class='value'>${Number.isFinite(pedigreeStats?.avgConfidence) ? pedigreeStats.avgConfidence.toFixed(1)+'%' : '—'}</div></div>
      <div class='perf-card'><div class='label'>Avg Ped Edge</div><div class='value'>${Number.isFinite(pedigreeStats?.avgEdge) ? (pedigreeStats.avgEdge >= 0 ? '+' : '') + pedigreeStats.avgEdge.toFixed(1) : '—'}</div></div>
    </div>`;
  metricsWrap.innerHTML = cards;

  if (breakdownWrap) {
    const detail = stats.strategyBreakdown || {};
    const pedigreeArchetypeLines = pedigreeStats?.archetypes ? Object.entries(pedigreeStats.archetypes)
      .sort((a,b) => (b[1]?.bets || 0) - (a[1]?.bets || 0))
      .slice(0, 6)
      .map(([arch, vals]) => `<div>${escapeHtml(arch)} — Bets ${vals?.bets || 0} · Win ${fmtPct((vals?.bets || 0) ? ((vals?.wins || 0) / (vals?.bets || 0)) : null)} · ${showRoi ? `ROI ${fmtRoi((vals?.bets || 0) ? ((vals?.profit || 0) / (vals?.bets || 0)) : null)}` : ''}</div>`)
      .join('') : '';
    const cardsHtml = [
      ['Win', detail.win],
      ['Odds Runner', detail.odds],
      ['EW', detail.ew],
      ['Long', detail.long],
      ['Pedigree Advantage', detail.pedigree]
    ].map(([label, data]) => buildBreakdownCard(label, data)).join('');
    const pedigreeExtra = pedigreeArchetypeLines ? `<div class='bet-plan-breakdown-card' style='grid-column:1 / -1'><div class='label'>Pedigree by Archetype</div>${pedigreeArchetypeLines}</div>` : '';
    const thresholdAuditPanel = renderSignalThresholdAuditPanel(signalThresholdAuditCache);
    breakdownWrap.innerHTML = `${cardsHtml}${pedigreeExtra}${thresholdAuditPanel}`;
  }

  const windows = ['day','week','month'];
  const rows = windows.map(win => {
    const rowStats = computeBetPlanStats(cache, win);
    if (!rowStats) return '';
    const active = win === betPlanPerfWindow ? ' class="active-row"' : '';
    return `<tr${active}>
      <td data-label='Window'>${betPlanLabel(win)}</td>
      <td data-label='Bets'>${rowStats.bets ?? '—'}</td>
      <td data-label='Win Rate'>${fmtPct(rowStats.winRate)}</td>
      <td data-label='ROI (Rec)' data-roi-only>${fmtRoi(rowStats.roiRec)}</td>
      <td data-label='ROI (SP)' data-roi-only>${fmtRoi(rowStats.roiSp)}</td>
      <td data-label='ROI (Tote)' data-roi-only>${fmtRoi(rowStats.roiTote)}</td>
      <td data-label='Net Units' data-roi-only>${fmtUnits(rowStats.netUnits)}</td>
    </tr>`;
  }).join('');
  tableWrap.innerHTML = rows
    ? `<table class='perf-table'>
        <thead>
          <tr>
            <th>Window</th>
            <th>Bets</th>
            <th>Win Rate</th>
            <th data-roi-only>ROI (Rec)</th>
            <th data-roi-only>ROI (SP)</th>
            <th data-roi-only>ROI (Tote)</th>
            <th data-roi-only>Net Units</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
    : '<div class="sub">No bet-plan history available.</div>';
  updateBetmanReturn(stats);
  applyPerformanceVisibility();
}

function updateBetmanReturn(stats){
  const baseReturn = stats?.baseProfit ?? null;
  const baseInvested = stats?.baseStake ?? null;
  const exoticReturn = stats?.exoticProfit ?? null;
  const exoticInvested = stats?.exoticStake ?? null;
  const netReturn = (baseReturn ?? 0) + (exoticReturn ?? 0);
  const invested = (baseInvested ?? 0) + (exoticInvested ?? 0);
  const returnValueEl = $('betmanReturnValue');
  const returnSubEl = $('betmanReturnSub');
  const returnBarEl = $('betmanReturnBar');
  if (returnValueEl) {
    const isNeg = Number.isFinite(netReturn) && netReturn < 0;
    returnValueEl.textContent = Number.isFinite(netReturn) ? fmtUnits(netReturn) : '—';
    returnValueEl.classList.toggle('neg', !!isNeg);
  }
  if (returnSubEl) {
    const roi = (Number.isFinite(netReturn) && Number.isFinite(invested) && invested) ? (netReturn / invested) : null;
    const baseRoi = (Number.isFinite(baseReturn) && Number.isFinite(baseInvested) && baseInvested) ? (baseReturn / baseInvested) : null;
    const exoticRoi = (Number.isFinite(exoticReturn) && Number.isFinite(exoticInvested) && exoticInvested) ? (exoticReturn / exoticInvested) : null;
    const winBets = stats?.winRate != null ? `Win Bets: ${fmtPct(stats.winRate)}` : 'Win Bets: —';
    const winBreakdown = Number.isFinite(baseReturn) ? `Win P/L ${fmtUnits(baseReturn)}${baseRoi != null ? ` (${fmtPct(baseRoi)})` : ''}` : 'Win P/L: —';
    const exoticBreakdown = Number.isFinite(exoticReturn) ? `Exotics P/L ${fmtUnits(exoticReturn)}${exoticRoi != null ? ` (${fmtPct(exoticRoi)})` : ''}` : 'Exotics P/L: —';
    const exoticHit = stats?.exoticHit != null ? `Exotic Hit: ${fmtPct(stats.exoticHit)}` : 'Exotic Hit: —';
    const roiText = roi != null ? `Total ROI: ${fmtPct(roi)}` : 'Total ROI: —';
    returnSubEl.textContent = `${winBets} · ${winBreakdown} · ${exoticHit} · ${exoticBreakdown} · ${roiText}`;
  }
  if (returnBarEl) {
    const roi = (Number.isFinite(netReturn) && Number.isFinite(invested) && invested) ? (netReturn / invested) : null;
    const pct = roi != null ? Math.min(Math.abs(roi) * 100, 100) : 0;
    returnBarEl.style.width = `${pct}%`;
    returnBarEl.classList.toggle('neg', roi != null && roi < 0);
  }
}

function renderBetPlansRoi(daily, weekly, monthly){
  const el = $('perfBetPlansRoi');
  if (!el) return;
  if (!isAdminUser) {
    el.innerHTML = '<div class="sub">ROI figures are visible to admin only.</div>';
    return;
  }
  const periods = [
    { label: 'Daily', agg: aggregateLastNDays(daily, 1), key: latestKey(daily) },
    { label: 'Weekly', agg: aggregateLastNDays(daily, 7), key: latestKey(weekly) },
    { label: 'Monthly', agg: aggregateLastNDays(daily, 30), key: latestKey(monthly) }
  ];
  const tags = [
    { key: 'win', label: 'Win' },
    { key: 'odds', label: 'Odds' },
    { key: 'ew', label: 'EW' },
    { key: 'long', label: 'Long' }
  ];
  const rows = tags.map(t => {
    const cells = periods.map(p => {
      const a = p.agg;
      if (!a) return `<td data-label="${p.label}">—</td>`;
      const src = t.key === 'long'
        ? { bets: a.long.bets, wins: a.long.wins, stake: a.long.stake_units, profit: a.long.profit_rec }
        : a.pick[t.key === 'odds' ? 'odds_runner' : t.key];
      const winRate = src.bets ? src.wins / src.bets : null;
      const roiRec = src.stake_units ? src.profit_rec / src.stake_units : (src.stake ? src.profit / src.stake : null);
      const bets = src.bets || 0;
      return `<td data-label="${p.label}">
        <div class="betplan-cell">
          <div class="betplan-win">Win: ${fmtPct(winRate)}</div>
          <div class="betplan-roi">ROI: ${fmtRoi(roiRec)}</div>
          <div class="betplan-bets">Tag Bets: ${bets}</div>
        </div>
      </td>`;
    }).join('');
    return `<tr>
      <td data-label="Tag">${t.label}</td>
      ${cells}
    </tr>`;
  }).join('');

  const totalRow = `<tr>
      <td data-label="Tag"><b>Total Bets</b></td>
      ${periods.map(p => `<td data-label="${p.label}"><b>${p.agg?.total_bets ?? 0}</b></td>`).join('')}
    </tr>`;
  const headers = periods.map(p => `<th>${p.label}${p.key ? ` (${p.key})` : ''}</th>`).join('');
  el.innerHTML = `
    <table class="perf-table">
      <thead>
        <tr>
          <th>Tag</th>
          ${headers}
        </tr>
      </thead>
      <tbody>${totalRow}${rows}</tbody>
    </table>`;
}

function averageDailyWinRate(daily, days=30){
  if (!daily || typeof daily !== 'object') return null;
  const keys = Object.keys(daily).sort();
  const slice = keys.slice(-days);
  if (!slice.length) return null;
  const vals = slice.map(k => daily[k]?.win_rate).filter(v => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a,b)=>a+b,0) / vals.length;
}

function applyHeroTiles(prefix, agg){
  if (!agg) return;
  const winRateWin = agg.pick.win.bets ? agg.pick.win.wins / agg.pick.win.bets : null;
  const winRateOdds = agg.pick.odds_runner.bets ? agg.pick.odds_runner.wins / agg.pick.odds_runner.bets : null;
  const winRateEw = agg.pick.ew.bets ? agg.pick.ew.wins / agg.pick.ew.bets : null;
  const winRateLong = agg.long.bets ? agg.long.wins / agg.long.bets : null;
  const exoticHit = agg.exotic?.bets ? (agg.exotic.hits / agg.exotic.bets) : null;
  const racesRun = Number.isFinite(agg.races_run) ? agg.races_run : null;
  const racesWon = Number.isFinite(agg.races_won) ? agg.races_won : null;
  $(`${prefix}Win`) && ($(`${prefix}Win`).textContent = fmtPct(winRateWin));
  $(`${prefix}Odds`) && ($(`${prefix}Odds`).textContent = fmtPct(winRateOdds));
  $(`${prefix}Ew`) && ($(`${prefix}Ew`).textContent = fmtPct(winRateEw));
  $(`${prefix}Long`) && ($(`${prefix}Long`).textContent = fmtPct(winRateLong));
  $(`${prefix}Exotic`) && ($(`${prefix}Exotic`).textContent = fmtPct(exoticHit));
  $(`${prefix}RacesRun`) && ($(`${prefix}RacesRun`).textContent = racesRun ?? '—');
  $(`${prefix}RacesWon`) && ($(`${prefix}RacesWon`).textContent = racesWon ?? '—');
}

function bestStrategyLabel(daily, days=30){
  const agg = aggregateLastNDays(daily, days);
  if (!agg) return null;
  const options = [
    { key: 'win', label: 'Win Strategy', bets: agg.pick.win.bets, stake: agg.pick.win.stake_units, roiStake: agg.pick.win.roi_stake_units, profit: agg.pick.win.profit_rec },
    { key: 'odds_runner', label: 'Odds Runner', bets: agg.pick.odds_runner.bets, stake: agg.pick.odds_runner.stake_units, roiStake: agg.pick.odds_runner.roi_stake_units, profit: agg.pick.odds_runner.profit_rec },
    { key: 'ew', label: 'Each Way', bets: agg.pick.ew.bets, stake: agg.pick.ew.stake_units, roiStake: agg.pick.ew.roi_stake_units, profit: agg.pick.ew.profit_rec },
    { key: 'long', label: 'Long Odds', bets: agg.long.bets, stake: agg.long.stake_units, roiStake: agg.long.roi_stake_units, profit: agg.long.profit_rec }
  ].filter(o => (o.stake || 0) > 0 && (o.bets || 0) >= STRATEGY_MIN_BETS && (o.roiStake || 0) / (o.stake || 1) >= STRATEGY_MIN_ROI_COVERAGE);
  if (!options.length) return null;
  options.forEach(o => { o.roi = o.roiStake ? o.profit / o.roiStake : null; });
  options.sort((a,b) => (b.roi ?? -999) - (a.roi ?? -999));
  return options[0].label;
}


function renderPerformanceSummary(daily){
  const el = $('perfSummary');
  if (!el) return;
  const agg = aggregateLastNDays(daily, 30);
  if (!agg) {
    el.innerHTML = '<div class="sub">No data yet.</div>';
    return;
  }
  const winRate = agg.win_bets ? agg.wins / agg.win_bets : null;
  const roiRec = agg.roi_stake ? agg.roi_rec_profit / agg.roi_stake : null;
  const roiSp = agg.roi_sp_stake ? agg.roi_sp_profit / agg.roi_sp_stake : null;
  const roiTote = agg.roi_tote_stake ? agg.roi_tote_profit / agg.roi_tote_stake : null;
  const avgBets = agg.days ? (agg.total_bets / agg.days) : null;
  const pickTotal = (agg.pick.win.bets + agg.pick.odds_runner.bets + agg.pick.ew.bets) || 0;
  const winBetPct = pickTotal ? agg.pick.win.bets / pickTotal : null;
  const oddsBetPct = pickTotal ? agg.pick.odds_runner.bets / pickTotal : null;
  const ewBetPct = pickTotal ? agg.pick.ew.bets / pickTotal : null;
  const showRoi = !!isAdminUser;
  if (!showRoi) {
    el.innerHTML = `
      <table class="perf-table">
        <thead>
          <tr>
            <th>Window</th>
            <th>Total Bets</th>
            <th>Win Bets</th>
            <th>Win Rate</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Window">Last ${agg.days} days</td>
            <td data-label="Total Bets">${agg.total_bets}</td>
            <td data-label="Win Bets">${agg.win_bets}</td>
            <td data-label="Win Rate">${fmtPct(winRate)}</td>
          </tr>
        </tbody>
      </table>
      <div class="perf-summary-meta">
        <div>Bet Mix — Win: <b>${fmtPct(winBetPct)}</b> · Odds: <b>${fmtPct(oddsBetPct)}</b> · EW: <b>${fmtPct(ewBetPct)}</b></div>
        <div>Avg Bets/Day: <b>${Number.isFinite(avgBets) ? avgBets.toFixed(1) : '—'}</b> · Win Hits: <b>${agg.wins}</b></div>
      </div>`;
    return;
  }
  el.innerHTML = `
    <table class="perf-table">
      <thead>
        <tr>
          <th>Window</th>
          <th>Total Bets</th>
          <th>Win Bets</th>
          <th>Win Rate</th>
          <th>ROI Rec</th>
          <th>ROI SP</th>
          <th>ROI Tote</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td data-label="Window">Last ${agg.days} days</td>
          <td data-label="Total Bets">${agg.total_bets}</td>
          <td data-label="Win Bets">${agg.win_bets}</td>
          <td data-label="Win Rate">${fmtPct(winRate)}</td>
          <td data-label="ROI Rec">${fmtRoi(roiRec)}</td>
          <td data-label="ROI SP">${fmtRoi(roiSp)}</td>
          <td data-label="ROI Tote">${fmtRoiZero(roiTote)}</td>
        </tr>
      </tbody>
    </table>
    <div class="perf-summary-meta">
      <div>Bet Mix — Win: <b>${fmtPct(winBetPct)}</b> · Odds: <b>${fmtPct(oddsBetPct)}</b> · EW: <b>${fmtPct(ewBetPct)}</b></div>
      <div>ROI Line — Rec: <b>${fmtRoi(roiRec)}</b> · SP: <b>${fmtRoi(roiSp)}</b> · Tote: <b>${fmtRoiZero(roiTote)}</b></div>
    </div>
    <div class="perf-summary-meta">
      <div>Net Rec P/L: <b>${fmtUnits(agg.roi_rec_profit)}</b></div>
      <div>Avg Bets/Day: <b>${Number.isFinite(avgBets) ? avgBets.toFixed(1) : '—'}</b></div>
      <div>Win Hits: <b>${agg.wins}</b></div>
    </div>`;
}

function renderBestStrategy(daily){
  const el = $('perfBestStrategy');
  if (!el) return;
  const agg = aggregateLastNDays(daily, 30);
  if (!agg) {
    el.innerHTML = '<div class="sub">No data yet.</div>';
    return;
  }
  let rows = ['win','odds_runner','ew','long'].map(key => {
    const r = key === 'long' ? (agg.long || {}) : (agg.pick[key] || {});
    const stakeUnits = r.stake_units ?? r.bets;
    const roiStakeUnits = r.roi_stake_units ?? stakeUnits;
    const roiRec = roiStakeUnits ? r.profit_rec / roiStakeUnits : null;
    const roiSpStakeUnits = r.roi_sp_stake_units ?? 0;
    const roiToteStakeUnits = r.roi_tote_stake_units ?? 0;
    const roiSp = roiSpStakeUnits ? r.profit_sp / roiSpStakeUnits : null;
    const roiTote = roiToteStakeUnits ? r.profit_tote / roiToteStakeUnits : null;
    const winRate = r.bets ? r.wins / r.bets : null;
    return {
      key,
      bets: r.bets,
      stakeUnits,
      roiStakeUnits,
      roiSpStakeUnits,
      roiToteStakeUnits,
      winRate,
      roiRec,
      roiSp,
      roiTote,
      profit_rec: r.profit_rec,
      profit_sp: r.profit_sp,
      profit_tote: r.profit_tote,
      wins: r.wins
    };
  });

  const exotic = {
    key: 'exotic',
    bets: Number(agg.exotic_bets || 0),
    stakeUnits: Number(agg.exotic_stake || 0),
    roiStakeUnits: Number(agg.exotic_stake || 0),
    roiSpStakeUnits: 0,
    roiToteStakeUnits: Number(agg.exotic_stake || 0),
    winRate: Number(agg.exotic_hit_rate),
    roiRec: null,
    roiSp: null,
    roiTote: Number.isFinite(Number(agg.exotic_roi_tote)) ? Number(agg.exotic_roi_tote) : null,
    profit_rec: 0,
    profit_sp: 0,
    profit_tote: Number(agg.exotic_profit || 0),
    wins: null
  };
  if (exotic.bets > 0) rows.push(exotic);

  const rowsWithBets = rows.filter(r => r.bets > 0 && r.key !== 'exotic');
  if (rowsWithBets.length) {
    const combo = rowsWithBets.reduce((acc, r) => {
      acc.bets += r.bets;
      acc.stakeUnits += r.stakeUnits || r.bets;
      acc.roiStakeUnits += r.roiStakeUnits || r.stakeUnits || r.bets;
      acc.roiSpStakeUnits += r.roiSpStakeUnits || 0;
      acc.roiToteStakeUnits += r.roiToteStakeUnits || 0;
      acc.wins += r.wins || 0;
      acc.profit_rec += r.profit_rec || 0;
      acc.profit_sp += r.profit_sp || 0;
      acc.profit_tote += r.profit_tote || 0;
      return acc;
    }, { key: 'combo', bets: 0, stakeUnits: 0, roiStakeUnits: 0, roiSpStakeUnits: 0, roiToteStakeUnits: 0, wins: 0, profit_rec: 0, profit_sp: 0, profit_tote: 0 });
    combo.winRate = combo.bets ? combo.wins / combo.bets : null;
    combo.roiRec = combo.roiStakeUnits ? combo.profit_rec / combo.roiStakeUnits : null;
    combo.roiSp = combo.roiSpStakeUnits ? combo.profit_sp / combo.roiSpStakeUnits : null;
    combo.roiTote = combo.roiToteStakeUnits ? combo.profit_tote / combo.roiToteStakeUnits : null;
    rows.push(combo);
  }

  const showRoi = !!isAdminUser;
  const rankingPool = rows.filter(r => r.bets > 0);
  const comparator = (a, b) => {
    if (showRoi) return (b.roiRec ?? -999) - (a.roiRec ?? -999);
    return (b.winRate ?? -999) - (a.winRate ?? -999);
  };
  const best = rankingPool.sort(comparator)[0] || null;
  const bestKey = best?.key || null;
  const roiHeaders = showRoi ? '<th>ROI Rec</th><th>ROI SP</th><th>ROI Tote</th>' : '';
  const labelFor = (key) => {
    if (key === 'win') return 'Win Strategy';
    if (key === 'odds_runner') return 'Odds Runner';
    if (key === 'ew') return 'Each Way';
    if (key === 'long') return 'Long Odds';
    if (key === 'exotic') return 'Exotics';
    if (key === 'combo') return 'Win + Odds Runner + Each Way';
    return key.toUpperCase();
  };
  const roiCells = (row) => showRoi
    ? `<td data-label="ROI Rec">${fmtRoi(row.roiRec)}</td>
          <td data-label="ROI SP">${fmtRoi(row.roiSp)}</td>
          <td data-label="ROI Tote">${fmtRoiZero(row.roiTote)}</td>`
    : '';
  const tableRows = rows.map(row => {
    const star = row.key === bestKey ? ' ⭐' : '';
    const cls = row.key === bestKey ? 'best-strategy-row' : '';
    return `<tr class='${cls}'>
      <td data-label="Strategy"><b>${labelFor(row.key)}</b>${star}</td>
      <td data-label="Bets">${row.bets ?? '—'}</td>
      <td data-label="Win Rate">${fmtPct(row.winRate)}</td>
      ${roiCells(row)}
    </tr>`;
  }).join('');

  if (!tableRows) {
    el.innerHTML = '<div class="sub">No strategy data yet.</div>';
    return;
  }

  const netRec = best && Number.isFinite(best.roiRec) ? (best.roiRec * best.bets) : null;
  const subtitle = showRoi ? '⭐ marks best by Rec return' : '⭐ marks best by win rate';
  el.innerHTML = `
    <table class="perf-table">
      <thead>
        <tr>
          <th>Strategy</th>
          <th>Bets</th>
          <th>Win Rate</th>
          ${roiHeaders}
        </tr>
      </thead>
      <tbody>${tableRows}</tbody>
    </table>
    <div class="perf-summary-meta">${subtitle}</div>
    ${showRoi && best ? `<div class="perf-summary-meta">
      <div>Net Rec P/L: <b>${fmtUnits(netRec)}</b></div>
      <div>Avg ROI/Bet: <b>${fmtRoi(best.roiRec)}</b></div>
    </div>` : ''}`;
}

function updatePerformanceRefreshState(){
  const btn = $('refreshPerformanceBtn');
  if (!btn) return;
  const remaining = performanceCooldownUntil - Date.now();
  if (remaining > 0) {
    btn.disabled = true;
    const seconds = Math.ceil(remaining / 1000);
    btn.textContent = `Refresh (${seconds}s)`;
    if (performanceCooldownTimer) clearTimeout(performanceCooldownTimer);
    performanceCooldownTimer = setTimeout(updatePerformanceRefreshState, Math.min(1000, remaining));
    return;
  }
  btn.disabled = false;
  btn.textContent = 'Refresh';
}

async function loadRuntimeHealth(){
  const el = $('runtimeHealthPanel');
  if (!el || !isAdminUser) return;
  try {
    const out = await fetchLocal('./api/runtime-health', { cache: 'no-store' }).then(r=>r.json());
    if (!out?.ok) throw new Error(out?.error || 'runtime_health_failed');
    el.innerHTML = `
      <div class='perf-card'><div class='label'>PID</div><div class='value'>${out.pid ?? '—'}</div></div>
      <div class='perf-card'><div class='label'>Uptime</div><div class='value'>${out.uptimeSec ?? '—'}s</div></div>
      <div class='perf-card'><div class='label'>RSS</div><div class='value'>${out.rssMb ?? '—'} MB</div></div>
      <div class='perf-card'><div class='label'>Heap Used</div><div class='value'>${out.heapUsedMb ?? '—'} MB</div></div>
      <div class='perf-card'><div class='label'>OpenAI</div><div class='value'>${out.openAiConfigured ? 'Configured' : 'Missing'}</div></div>
      <div class='perf-card'><div class='label'>Bakeoff</div><div class='value'>${out.bakeoffRunning ? 'Running' : (out.bakeoffExitCode === 0 ? 'Last OK' : (out.bakeoffExitCode == null ? 'Idle' : 'Last Failed'))}</div></div>
      <div class='perf-card'><div class='label'>AI Model Cache</div><div class='value'>${out.aiModelsCacheAgeSec == null ? 'cold' : `${out.aiModelsCacheAgeSec}s`}</div></div>
    `;
  } catch (err) {
    el.innerHTML = `<div class='sub'>Runtime health unavailable: ${escapeHtml(err?.message || 'unknown')}</div>`;
  }
}

async function triggerPerformancePoll(manual = false){
  if (!isAdminUser) return;
  try {
    const res = await fetchLocal('./api/performance-poll', { method: 'POST' });
    const out = await res.json();
    if (out?.cooldownMs && out.cooldownMs > 0) {
      performanceCooldownUntil = Date.now() + out.cooldownMs;
    } else if (out?.ran) {
      performanceCooldownUntil = Date.now() + (5 * 60 * 1000);
    }
    updatePerformanceRefreshState();
  } catch {}
  await loadRuntimeHealth();
  if (manual) await loadPerformance();
}

async function triggerModelTraining(){
  if (!isAdminUser) return;
  const btn = $('trainModelsBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Training…';
  }
  try {
    const res = await fetchLocal('./api/train-models', { method: 'POST' });
    const out = await res.json();
    const ok = out?.ok;
    if (btn) btn.textContent = ok ? 'Trained' : 'Train Models';
  } catch {
    if (btn) btn.textContent = 'Train Models';
  } finally {
    if (btn) {
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = 'Train Models';
      }, 1500);
    }
  }
}

function renderConfidenceBasedBets(){
  const wrap = $('perfConfidenceBets');
  if (!wrap) return;

  if (!Number.isFinite(Number(confidenceBaseStakeUnit)) || Number(confidenceBaseStakeUnit) < 0) confidenceBaseStakeUnit = 1;
  if (!Number.isFinite(Number(confidenceBoostStakeUnit)) || Number(confidenceBoostStakeUnit) < 0) confidenceBoostStakeUnit = 2;

  const rows = (latestSuggestedBets || [])
    .filter(selectionIsUpcoming)
    .filter(r => isConfidenceBoostCandidate(r))
    .sort((a, b) => {
      const pb = Number(confidenceSignalPct(b) || 0);
      const pa = Number(confidenceSignalPct(a) || 0);
      if (pb !== pa) return pb - pa;
      return Number(b.stake || 0) - Number(a.stake || 0);
    });

  const baseStake = rows.length * Number(confidenceBaseStakeUnit || 0);
  const boostedStake = rows.length * Number(confidenceBoostStakeUnit || 0);
  const upliftStake = boostedStake - baseStake;

  const controls = `
    <div class='ai-chat-input-row' style='margin:8px 0 10px;gap:10px;flex-wrap:wrap'>
      <label class='sub' style='display:flex;align-items:center;gap:6px'>Signal Threshold <input id='confidenceSignalThresholdInput' type='number' min='0' max='100' step='1' value='${Number(confidenceSignalThreshold || 40).toFixed(0)}' style='width:72px' />%</label>
      <label class='sub' style='display:flex;align-items:center;gap:6px'>Base Stake <input id='confidenceBaseStakeInput' type='number' min='0' step='0.5' value='${Number(confidenceBaseStakeUnit || 1).toFixed(2)}' style='width:92px' /></label>
      <label class='sub' style='display:flex;align-items:center;gap:6px'>Boosted Stake <input id='confidenceBoostStakeInput' type='number' min='0' step='0.5' value='${Number(confidenceBoostStakeUnit || 2).toFixed(2)}' style='width:92px' /></label>
    </div>`;

  const kpis = `
    <div class='perf-kpis perf-kpis-secondary'>
      <div class='perf-card'><div class='label'>Signal Threshold</div><div class='value'>≥ ${confidenceSignalThreshold}%</div></div>
      <div class='perf-card'><div class='label'>Qualifying Bets</div><div class='value'>${rows.length}</div></div>
      <div class='perf-card'><div class='label'>Base Stake Setting</div><div class='value'>$${Number(confidenceBaseStakeUnit || 0).toFixed(2)}</div></div>
      <div class='perf-card'><div class='label'>Boosted Stake Setting</div><div class='value'>$${Number(confidenceBoostStakeUnit || 0).toFixed(2)}</div></div>
      <div class='perf-card'><div class='label'>Base Deployed</div><div class='value'>$${baseStake.toFixed(2)}</div></div>
      <div class='perf-card'><div class='label'>Boosted Deployed</div><div class='value'>$${boostedStake.toFixed(2)}</div></div>
      <div class='perf-card'><div class='label'>Extra Deployed</div><div class='value ${upliftStake >= 0 ? 'pos' : 'neg'}'>$${upliftStake.toFixed(2)}</div></div>
    </div>`;

  const tableRows = rows.slice(0, 20).map(r => {
    const p = confidenceSignalPct(r);
    return `<tr>
      <td>${escapeHtml(String(r.meeting || '—'))}</td>
      <td>R${escapeHtml(String(r.race || '—'))}</td>
      <td>${escapeHtml(String(r.selection || r.runner || '—'))}</td>
      <td>${Number.isFinite(p) ? `${Number(p).toFixed(1)}%` : '—'}</td>
      <td>${escapeHtml(String(r.type || 'Win'))}</td>
      <td>$${Number(confidenceBaseStakeUnit || 0).toFixed(2)}</td>
      <td>$${Number(confidenceBoostStakeUnit || 0).toFixed(2)}</td>
      <td>${escapeHtml(String(r.jumpsIn || '—'))}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class='perf-hint'>Confidence stakes are user-defined. Base bets with signal ≥ ${confidenceSignalThreshold}% use your boosted stake setting. Exotics are excluded from this threshold and are not adjusted here.</div>
    ${controls}
    ${kpis}
    <div class='table'>
      <table class='perf-table'>
        <thead><tr><th>Meeting</th><th>Race</th><th>Selection</th><th>Signal</th><th>Type</th><th>Base Stake</th><th>Boosted Stake</th><th>ETA</th></tr></thead>
        <tbody>${tableRows || `<tr><td colspan='8'>No qualifying confidence bets right now.</td></tr>`}</tbody>
      </table>
    </div>`;

  const thresholdInput = $('confidenceSignalThresholdInput');
  const baseInput = $('confidenceBaseStakeInput');
  const boostInput = $('confidenceBoostStakeInput');
  const applyStakeSettings = () => {
    const threshold = Number(thresholdInput?.value);
    const base = Number(baseInput?.value);
    const boost = Number(boostInput?.value);
    confidenceSignalThreshold = Number.isFinite(threshold) && threshold >= 0 && threshold <= 100 ? threshold : 40;
    confidenceBaseStakeUnit = Number.isFinite(base) && base >= 0 ? base : 1;
    confidenceBoostStakeUnit = Number.isFinite(boost) && boost >= 0 ? boost : 2;
    try {
      localStorage.setItem('confidenceSignalThreshold', String(confidenceSignalThreshold));
      localStorage.setItem('confidenceBaseStakeUnit', String(confidenceBaseStakeUnit));
      localStorage.setItem('confidenceBoostStakeUnit', String(confidenceBoostStakeUnit));
    } catch {}
    renderConfidenceBasedBets();
  };
  thresholdInput?.addEventListener('change', applyStakeSettings);
  baseInput?.addEventListener('change', applyStakeSettings);
  boostInput?.addEventListener('change', applyStakeSettings);
}

function downloadCsv(filename, rows){
  const csv = rows.map(cols => cols.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function hydrateSettledMeetingFilter(rows){
  const sel = $('perfSettledMeetingFilter');
  if (!sel) return;
  const prev = sel.value || 'all';
  const meetings = Array.from(new Set((rows || []).map(r => String(r?.meeting || '').trim()).filter(Boolean))).sort((a,b) => a.localeCompare(b));
  sel.innerHTML = [`<option value="all">All meetings</option>`].concat(meetings.map(m => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`)).join('');
  sel.value = meetings.includes(prev) || prev === 'all' ? prev : 'all';
}

function renderBetProfile(race, runner, bet){
  const safeRace = race || { meeting: bet?.meeting, race_number: bet?.race, distance: '—', track_condition: '—' };
  const silk = runner?.silk_url_128x128 || runner?.alt_silk_url_128x128 || runner?.silk_url_64x64 || runner?.alt_silk_url_64x64 || '';
  const silkAlt = escapeHtml(runner?.name || runner?.runner_name || bet?.selection || 'runner');
  const silkFallback = `<div class='silk-img' style='display:flex;align-items:center;justify-content:center;background:#0d1520;border:1px solid rgba(255,255,255,.08);color:#8ea0b5'>—</div>`;
  const silkImg = silk ? `<img class='silk-img' src='${silk}' alt='Silks for ${silkAlt}' referrerpolicy='no-referrer' onerror="this.outerHTML=${JSON.stringify(silkFallback)}" />` : silkFallback;
  const result = String(bet?.result || 'pending');
  const resultTag = result === 'win' ? `<span class='tag win'>WIN</span>`
    : result === 'loss' ? `<span class='tag'>LOSS</span>`
    : result === 'ew_win' ? `<span class='tag win'>EW WIN</span>`
    : result === 'ew_place' ? `<span class='tag value'>EW PLACE</span>`
    : result === 'ew_loss' ? `<span class='tag'>EW LOSS</span>`
    : `<span class='tag value'>${escapeHtml(result.toUpperCase())}</span>`;
  const movement = (() => {
    try {
      const history = marketOddsHistoryCache || {};
      const raceKey = Object.keys(history).find(k => {
        const parts = String(k).split('|');
        return parts.length >= 3 && String(parts[0] || '').toLowerCase().includes(String(bet?.meeting || '').toLowerCase()) && String(parts[1] || '') === String(bet?.race || '') && String(parts.slice(2).join('|') || '').toLowerCase().includes(String(bet?.selection || '').toLowerCase());
      });
      const hist = raceKey ? history[raceKey] : null;
      if (!Array.isArray(hist) || !hist.length) return 'No odds movement captured';
      const first = Number(hist[0]?.odds || 0);
      const last = Number(hist[hist.length - 1]?.odds || 0);
      if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last <= 0) return 'No odds movement captured';
      const pct = (((last - first) / first) * 100).toFixed(1);
      const dir = last < first ? 'Firmed' : (last > first ? 'Drifting' : 'Flat');
      return `${dir}: ${first.toFixed(2)} → ${last.toFixed(2)} (${pct}%)`;
    } catch {
      return 'No odds movement captured';
    }
  })();
  const horseBlock = runner ? renderHorseAnalysis(safeRace, runner) : `
    <div class='horse-meta'>
      <div><b>Horse:</b> ${escapeHtml(String(bet?.selection || '—'))}</div>
      <div><b>Race:</b> ${escapeHtml(String(bet?.meeting || '—'))} R${escapeHtml(String(bet?.race || '—'))}</div>
      <div><b>Cache enrichment:</b> Historic race card not currently loaded in cache. Showing settled bet profile from ledger.</div>
    </div>`;
  return `
    <div class='horse-summary'>
      <div class='horse-silk'>${silkImg}</div>
      <div>
        <div><b>Bet:</b> ${escapeHtml(String(bet?.selection || '—'))}</div>
        <div><b>Race:</b> ${escapeHtml(String(bet?.meeting || safeRace?.meeting || '—'))} R${escapeHtml(String(bet?.race || safeRace?.race_number || '—'))}</div>
        <div><b>Type:</b> ${escapeHtml(String(bet?.type || '—')).toUpperCase()} · <b>Stake:</b> ${fmtUnits(bet?.stake_units)} · <b>Outcome:</b> ${resultTag}</div>
        <div><b>Odds:</b> ${escapeHtml(String(bet?.odds ?? '—'))} · <b>Return:</b> ${fmtUnits(bet?.return_units)} · <b>P/L:</b> ${fmtUnits(bet?.profit_units)} · <b>ROI:</b> ${fmtPct(bet?.roi)}</div>
        <div><b>Position:</b> ${escapeHtml(String(bet?.position ?? '—'))} · <b>Winner:</b> ${escapeHtml(String(bet?.winner || '—'))}</div>
        <div><b>Odds movement:</b> ${escapeHtml(movement)}</div>
      </div>
    </div>
    <div style='margin-top:12px'>${horseBlock}</div>
  `;
}

async function findHistoricalRaceForBet(meeting, raceNum, betDate){
  const normMeeting = String(meeting || '').trim().toLowerCase();
  const normRace = String(raceNum || '').replace(/^R/i,'').trim();
  if (betDate) {
    try {
      const res = await fetchLocal(`./api/races?date=${encodeURIComponent(String(betDate))}&meeting=${encodeURIComponent(String(meeting || ''))}&limit=5000`, { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const rows = Array.isArray(data?.races) ? data.races.map(sanitizeRaceObject) : [];
        const hit = rows.find(r => String(r.meeting || '').trim().toLowerCase() === normMeeting && String(r.race_number || '').trim() === normRace);
        if (hit) return hit;
      }
    } catch {}
  }
  try {
    return await findRaceForButton(meeting, raceNum);
  } catch {}
  return null;
}

async function openSettledBetAnalysis(row){
  let race = null;
  try {
    race = await findHistoricalRaceForBet(row?.meeting, row?.race, row?.date);
  } catch {}
  const selRaw = String(row?.selection || '');
  const selNorm = normalizeRunnerName(selRaw.replace(/^\d+\.\s*/, '').trim());
  const runner = race ? (race.runners || []).find(x => {
    const nm = normalizeRunnerName(String(x.name || x.runner_name || '').trim());
    return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
  }) : null;
  const title = race
    ? `${race.meeting} R${race.race_number} — ${row?.selection || runner?.name || 'Bet Profile'}`
    : `${row?.meeting || 'Unknown Meeting'} R${row?.race || '—'} — ${row?.selection || 'Bet Profile'}`;
  openSummaryPopup(title, renderBetProfile(race, runner, row));
}

let latestSettledBetsCache = [];

function initializeSettledBetFilters(rows){
  const allRows = Array.isArray(rows) ? rows : [];
  const latestDate = allRows.reduce((max, b) => {
    const d = String(b?.date || '');
    return d > max ? d : max;
  }, '');
  const latestTs = latestDate ? Date.parse(`${latestDate}T00:00:00Z`) : NaN;
  const defaultFrom = Number.isFinite(latestTs) ? new Date(latestTs - (6 * 86400000)).toISOString().slice(0,10) : '';
  const fromInput = $('perfSettledDateFrom');
  const toInput = $('perfSettledDateTo');
  if (fromInput) fromInput.value = defaultFrom || '';
  if (toInput) toInput.value = latestDate || '';
  const meeting = $('perfSettledMeetingFilter');
  const result = $('perfSettledResultFilter');
  const type = $('perfSettledTypeFilter');
  const sort = $('perfSettledSort');
  const search = $('perfSettledSearch');
  if (meeting) meeting.value = 'all';
  if (result) result.value = 'all';
  if (type) type.value = 'all';
  if (sort) sort.value = 'date_desc';
  if (search) search.value = '';
}

function renderSettledBets(rows){
  const el = $('perfSettledBetsTable');
  const summaryEl = $('perfSettledSummary');
  if (!el) return;
  const allRows = Array.isArray(rows) ? rows : [];
  if (!allRows.length) {
    if (summaryEl) summaryEl.textContent = '';
    el.innerHTML = `<div class='row'><div style='grid-column:1/-1'>No settled bets captured yet</div></div>`;
    return;
  }

  hydrateSettledMeetingFilter(allRows);

  const q = String($('perfSettledSearch')?.value || '').trim().toLowerCase();
  const resultFilter = String($('perfSettledResultFilter')?.value || 'all').toLowerCase();
  const typeFilter = String($('perfSettledTypeFilter')?.value || 'all').toLowerCase();
  const meetingFilter = String($('perfSettledMeetingFilter')?.value || 'all');
  const sortBy = String($('perfSettledSort')?.value || 'date_desc');

  const latestDate = allRows.reduce((max, b) => {
    const d = String(b?.date || '');
    return d > max ? d : max;
  }, '');
  const fromInput = $('perfSettledDateFrom');
  const toInput = $('perfSettledDateTo');
  const fromDate = String(fromInput?.value || '');
  const toDate = String(toInput?.value || latestDate || '');

  let filtered = allRows.filter(b => {
    const result = normalizeSettledResultValue(b?.result);
    const type = String(b?.type || '').toLowerCase();
    const meeting = String(b?.meeting || '');
    const betDate = String(b?.date || '');
    if (fromDate && betDate && betDate < fromDate) return false;
    if (toDate && betDate && betDate > toDate) return false;
    if (meetingFilter !== 'all' && meeting !== meetingFilter) return false;
    if (resultFilter !== 'all' && result !== resultFilter) return false;
    if (typeFilter !== 'all' && type !== typeFilter) return false;
    if (!q) return true;
    const hay = [
      b?.date,
      b?.meeting,
      `r${b?.race || ''}`,
      b?.selection,
      b?.type,
      b?.result,
      canonicalTrackedResultLabel(b?.result),
      normalizeSettledResultValue(b?.result),
      b?.winner,
      b?.pick_bucket
    ].map(v => String(v || '').toLowerCase()).join(' | ');
    return hay.includes(q);
  });

  const sorters = {
    date_desc: (a,b) => `${b?.date || ''}|${String(b?.meeting || '')}|${String(b?.race || '').padStart(3,'0')}`.localeCompare(`${a?.date || ''}|${String(a?.meeting || '')}|${String(a?.race || '').padStart(3,'0')}`),
    date_asc: (a,b) => `${a?.date || ''}|${String(a?.meeting || '')}|${String(a?.race || '').padStart(3,'0')}`.localeCompare(`${b?.date || ''}|${String(b?.meeting || '')}|${String(b?.race || '').padStart(3,'0')}`),
    profit_desc: (a,b) => (Number(b?.profit_units ?? -999999) - Number(a?.profit_units ?? -999999)),
    profit_asc: (a,b) => (Number(a?.profit_units ?? 999999) - Number(b?.profit_units ?? 999999)),
    roi_desc: (a,b) => (Number(b?.roi ?? -999999) - Number(a?.roi ?? -999999)),
    roi_asc: (a,b) => (Number(a?.roi ?? 999999) - Number(b?.roi ?? 999999)),
    return_desc: (a,b) => (Number(b?.return_units ?? -999999) - Number(a?.return_units ?? -999999)),
    return_asc: (a,b) => (Number(a?.return_units ?? 999999) - Number(b?.return_units ?? 999999))
  };
  filtered = [...filtered].sort(sorters[sortBy] || sorters.date_desc);

  const totalProfit = filtered.reduce((sum, b) => sum + (Number.isFinite(Number(b?.profit_units)) ? Number(b.profit_units) : 0), 0);
  const totalReturn = filtered.reduce((sum, b) => sum + (Number.isFinite(Number(b?.return_units)) ? Number(b.return_units) : 0), 0);
  if (summaryEl) {
    const windowLabel = fromDate || toDate ? `${fromDate || '…'} → ${toDate || '…'}` : 'Date range';
    summaryEl.textContent = `${windowLabel} · ${filtered.length} bet${filtered.length === 1 ? '' : 's'} · Return ${fmtUnits(totalReturn)} · P/L ${fmtUnits(totalProfit)}`;
  }

  const head = `<div class='row header'>
    <div>Date</div>
    <div>Race</div>
    <div>Selection</div>
    <div>Type</div>
    <div>Result</div>
    <div>Return</div>
    <div>P/L</div>
    <div class='right'>ROI</div>
  </div>`;
  const body = filtered.map(b => {
    const result = normalizeSettledResultValue(b?.result);
    const resultTag = result === 'win' ? `<span class='tag win'>WIN</span>`
      : result === 'loss' ? `<span class='tag'>LOSS</span>`
      : result === 'ew_win' ? `<span class='tag win'>EW WIN</span>`
      : result === 'ew_place' ? `<span class='tag value'>EW PLACE</span>`
      : result === 'ew_loss' ? `<span class='tag'>EW LOSS</span>`
      : `<span class='tag value'>${escapeHtml(result.toUpperCase())}</span>`;
    const raceLabel = `${escapeHtml(String(b?.meeting || ''))} R${escapeHtml(String(b?.race || ''))}`;
    const selection = escapeHtml(String(b?.selection || '—'));
    const extra = b?.winner ? `<div class='sub'>Winner: ${escapeHtml(String(b.winner))}</div>` : '';
    return `<div class='row settled-bet-row' data-date='${escapeAttr(String(b?.date || ''))}' data-meeting='${escapeAttr(String(b?.meeting || ''))}' data-race='${escapeAttr(String(b?.race || ''))}' data-selection='${escapeAttr(String(b?.selection || ''))}' style='cursor:pointer'>
      <div>${escapeHtml(String(b?.date || '—'))}</div>
      <div>${raceLabel}</div>
      <div>${selection}${extra}</div>
      <div>${escapeHtml(String(b?.type || '—')).toUpperCase()}</div>
      <div>${resultTag}</div>
      <div>${fmtUnits(b?.return_units)}</div>
      <div>${fmtUnits(b?.profit_units)}</div>
      <div class='right'>${fmtPct(b?.roi)}</div>
    </div>`;
  });
  el.innerHTML = head + (body.length ? body.join('') : `<div class='row'><div style='grid-column:1/-1'>No bets matched your filters</div></div>`);

  el.querySelectorAll('.settled-bet-row').forEach(node => {
    node.addEventListener('click', async () => {
      const picked = (latestSettledBetsCache || []).find(b =>
        String(b?.date || '') === String(node.dataset.date || '') &&
        String(b?.meeting || '') === String(node.dataset.meeting || '') &&
        String(b?.race || '') === String(node.dataset.race || '') &&
        String(b?.selection || '') === String(node.dataset.selection || '')
      ) || {
        date: node.dataset.date,
        meeting: node.dataset.meeting,
        race: node.dataset.race,
        selection: node.dataset.selection
      };
      await openSettledBetAnalysis(picked);
    });
  });
}

function renderPerformanceLedger(rows){
  const summaryEl = $('perfLedgerSummary');
  const tableEl = $('perfLedgerTable');
  const noteEl = $('perfLedgerNote');
  if (!summaryEl || !tableEl) return;
  const allRows = Array.isArray(rows) ? rows : [];
  if (noteEl) {
    noteEl.textContent = allRows.length
      ? 'Daily P&L ledger built from settled bet rows. Grouped by day with day-level totals.'
      : 'Ledger will populate once settled bets are available.';
  }
  if (!allRows.length) {
    summaryEl.innerHTML = '';
    tableEl.innerHTML = `<div class='row'><div style='grid-column:1/-1'>No settled bets captured yet</div></div>`;
    return;
  }

  const summary = (typeof summarizeSettledBets === 'function')
    ? summarizeSettledBets(allRows)
    : { bets: allRows.length, stake: 0, returnUnits: 0, profitUnits: 0, hits: 0 };
  const grouped = (typeof groupSettledBetsByDate === 'function')
    ? groupSettledBetsByDate(allRows)
    : [];
  const days = grouped.length;
  const roi = summary.stake > 0 ? (summary.profitUnits / summary.stake) : null;
  summaryEl.innerHTML = [
    { label: 'days', value: days },
    { label: 'bets', value: summary.bets },
    { label: 'strike rate', value: fmtPct(summary.bets ? (summary.hits / summary.bets) : null) },
    { label: 'stake', value: fmtUnits(summary.stake) },
    { label: 'returns', value: fmtUnits(summary.returnUnits) },
    { label: 'net p/l', value: fmtUnits(summary.profitUnits), neg: Number(summary.profitUnits) < 0 },
    { label: 'roi', value: fmtPct(roi), neg: Number(roi) < 0 }
  ].map(card => `<div class='perf-card'>
      <div class='label'>${escapeHtml(card.label)}</div>
      <div class='value${card.neg ? ' neg' : ''}'>${escapeHtml(String(card.value))}</div>
    </div>`).join('');

  const sections = grouped.map(group => {
    const dayRoi = group.summary.stake > 0 ? (group.summary.profitUnits / group.summary.stake) : null;
    const rowsHtml = group.rows.map((b) => {
      const result = normalizeSettledResultValue(b?.result);
      const resultTag = result === 'win' ? `<span class='tag win'>WIN</span>`
        : result === 'loss' ? `<span class='tag'>LOSS</span>`
        : result === 'ew_win' ? `<span class='tag win'>EW WIN</span>`
        : result === 'ew_place' ? `<span class='tag value'>EW PLACE</span>`
        : result === 'ew_loss' ? `<span class='tag'>EW LOSS</span>`
        : `<span class='tag value'>${escapeHtml(result.toUpperCase())}</span>`;
      return `<div class='ledger-row settled-bet-row' data-date='${escapeAttr(String(b?.date || ''))}' data-meeting='${escapeAttr(String(b?.meeting || ''))}' data-race='${escapeAttr(String(b?.race || ''))}' data-selection='${escapeAttr(String(b?.selection || ''))}' style='cursor:pointer'>
        <div data-label='Race'>${escapeHtml(String(b?.meeting || '—'))} R${escapeHtml(String(b?.race || ''))}</div>
        <div data-label='Selection'>
          <div>${escapeHtml(String(b?.selection || '—'))}</div>
          <div class='sub'>${escapeHtml(String(b?.type || '—')).toUpperCase()}</div>
        </div>
        <div data-label='Result'>${resultTag}</div>
        <div data-label='Odds'>${Number.isFinite(Number(b?.odds)) ? Number(b.odds).toFixed(2) : '—'}</div>
        <div data-label='Stake'>${fmtUnits(b?.stake_units)}</div>
        <div data-label='Return'>${fmtUnits(b?.return_units)}</div>
        <div data-label='P/L' class='${Number(b?.profit_units) < 0 ? 'neg' : ''}'>${fmtUnits(b?.profit_units)}</div>
        <div data-label='ROI' class='right ${Number(b?.roi) < 0 ? 'neg' : ''}'>${fmtPct(b?.roi)}</div>
      </div>`;
    }).join('');
    return `<section class='ledger-day'>
      <div class='ledger-day-head'>
        <div>
          <div class='ledger-day-title'>${escapeHtml(group.date)}</div>
          <div class='sub'>${group.summary.bets} bet${group.summary.bets === 1 ? '' : 's'} · Hits ${group.summary.hits}</div>
        </div>
        <div class='ledger-day-stats'>
          <span>Stake ${fmtUnits(group.summary.stake)}</span>
          <span>Return ${fmtUnits(group.summary.returnUnits)}</span>
          <span class='${group.summary.profitUnits < 0 ? 'neg' : ''}'>P/L ${fmtUnits(group.summary.profitUnits)}</span>
          <span class='${dayRoi != null && dayRoi < 0 ? 'neg' : ''}'>ROI ${fmtPct(dayRoi)}</span>
        </div>
      </div>
      <div class='ledger-table'>
        <div class='ledger-row ledger-head'>
          <div>Race</div>
          <div>Selection</div>
          <div>Result</div>
          <div>Odds</div>
          <div>Stake</div>
          <div>Return</div>
          <div>P/L</div>
          <div class='right'>ROI</div>
        </div>
        ${rowsHtml}
      </div>
    </section>`;
  }).join('');

  tableEl.innerHTML = sections;
  tableEl.querySelectorAll('.settled-bet-row').forEach(node => {
    node.addEventListener('click', async () => {
      const picked = (latestSettledBetsCache || []).find(b =>
        String(b?.date || '') === String(node.dataset.date || '') &&
        String(b?.meeting || '') === String(node.dataset.meeting || '') &&
        String(b?.race || '') === String(node.dataset.race || '') &&
        String(b?.selection || '') === String(node.dataset.selection || '')
      ) || {
        date: node.dataset.date,
        meeting: node.dataset.meeting,
        race: node.dataset.race,
        selection: node.dataset.selection
      };
      await openSettledBetAnalysis(picked);
    });
  });
}

function renderLearningsSimpleList(targetId, items, emptyText = 'No data'){ 
  const el = $(targetId);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = `<div class='row'><div style='grid-column:1/-1'>${escapeHtml(emptyText)}</div></div>`;
    return;
  }
  el.innerHTML = items.map(item => `<div class='row'><div style='grid-column:1/-1'>${escapeHtml(item)}</div></div>`).join('');
}

function renderLearningsMetricTable(targetId, rows, options = {}){
  const el = $(targetId);
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = `<div class='row'><div style='grid-column:1/-1'>No data</div></div>`;
    return;
  }
  const limit = options.limit || 5;
  const body = rows.slice(0, limit).map(r => `<div class='row'>
    <div>${escapeHtml(String(r?.name || '—'))}</div>
    <div>${r?.bets ?? 0} bets</div>
    <div>${fmtPct(r?.win_rate)}</div>
    <div>${fmtPct(r?.roi)}</div>
    <div class='right'>${fmtUnits(r?.profit_units)}</div>
  </div>`).join('');
  el.innerHTML = `<div class='row header'><div>Name</div><div>Bets</div><div>Win</div><div>ROI</div><div class='right'>P/L</div></div>${body}`;
}

function renderLearningsBetTable(targetId, rows){
  const el = $(targetId);
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = `<div class='row'><div style='grid-column:1/-1'>No bets</div></div>`;
    return;
  }
  const body = rows.slice(0, 10).map(r => `<div class='row'>
    <div>${escapeHtml(String(r?.date || '—'))}</div>
    <div>${escapeHtml(String(r?.meeting || '—'))} R${escapeHtml(String(r?.race || ''))}</div>
    <div>${escapeHtml(String(r?.selection || '—'))}</div>
    <div>${escapeHtml(String(r?.type || '—')).toUpperCase()}</div>
    <div>${fmtUnits(r?.profit_units)}</div>
    <div class='right'>${fmtPct(r?.roi)}</div>
  </div>`).join('');
  el.innerHTML = `<div class='row header'><div>Date</div><div>Race</div><div>Selection</div><div>Type</div><div>P/L</div><div class='right'>ROI</div></div>${body}`;
}

function renderAutotuneControl(){
  const el = $('perfAutotuneControl');
  if (!el) return;
  const key = 'betman_autotune_enabled';
  const enabled = localStorage.getItem(key) === '1';
  el.innerHTML = `<div class='row'>
    <div><b>Status</b></div>
    <div>${enabled ? '<span class="tag win">ON</span>' : '<span class="tag">OFF</span>'}</div>
    <div style='grid-column:3 / -1; text-align:right'><button id='perfAutotuneToggle' class='btn'>Turn ${enabled ? 'OFF' : 'ON'}</button></div>
  </div>
  <div class='row'><div style='grid-column:1/-1'>AUTOTUNE is a control switch for future automatic threshold/rule adaptation. Phase 4 wiring starts here.</div></div>`;
  const btn = $('perfAutotuneToggle');
  if (btn) {
    btn.onclick = () => {
      localStorage.setItem(key, enabled ? '0' : '1');
      renderAutotuneControl();
    };
  }
}

function renderLearningsReport(report){
  const sumEl = $('perfLearningsSummary');
  const recEl = $('perfLearningsRecommendations');
  if (!sumEl || !recEl) return;
  renderAutotuneControl();
  if (!report || !report.summary) {
    sumEl.innerHTML = `<div class='row'><div style='grid-column:1/-1'>No learnings report yet</div></div>`;
    recEl.innerHTML = '';
    renderLearningsSimpleList('perfLearningsEdgeTable', [], 'No edge sources yet');
    renderLearningsSimpleList('perfLearningsLeakTable', [], 'No leak sources yet');
    renderLearningsMetricTable('perfLearningsBestMeetings', []);
    renderLearningsMetricTable('perfLearningsWorstMeetings', []);
    renderLearningsMetricTable('perfLearningsBestBands', []);
    renderLearningsMetricTable('perfLearningsWorstBands', []);
    renderLearningsBetTable('perfLearningsTopBets', []);
    renderLearningsBetTable('perfLearningsWorstBets', []);
    return;
  }
  const windowText = `${report.window?.from || '—'} → ${report.window?.to || '—'}`;
  const summaryRows = [
    `<div class='row header'><div>Window</div><div>Bets</div><div>Win Rate</div><div>ROI</div><div class='right'>P/L</div></div>`,
    `<div class='row'><div>${escapeHtml(windowText)}</div><div>${report.summary?.bets ?? 0}</div><div>${fmtPct(report.summary?.win_rate)}</div><div>${fmtPct(report.summary?.roi)}</div><div class='right'>${fmtUnits(report.summary?.profit_units)}</div></div>`,
    `<div class='row'><div style='grid-column:1/-1'><b>Edge sources:</b> ${(report.edge_sources || []).map(escapeHtml).join(' · ') || '—'}</div></div>`,
    `<div class='row'><div style='grid-column:1/-1'><b>Leak sources:</b> ${(report.leak_sources || []).map(escapeHtml).join(' · ') || '—'}</div></div>`
  ];
  sumEl.innerHTML = summaryRows.join('');

  const recs = report.recommendations || [];
  recEl.innerHTML = recs.length
    ? recs.map(r => `<div class='row'><div style='grid-column:1/-1'>${escapeHtml(r)}</div></div>`).join('')
    : `<div class='row'><div style='grid-column:1/-1'>No recommendations yet</div></div>`;

  renderLearningsSimpleList('perfLearningsEdgeTable', report.edge_sources || [], 'No edge sources yet');
  renderLearningsSimpleList('perfLearningsLeakTable', report.leak_sources || [], 'No leak sources yet');
  const meetings = Array.isArray(report.by_meeting) ? report.by_meeting : [];
  const bands = Array.isArray(report.by_odds_band) ? report.by_odds_band : [];
  renderLearningsMetricTable('perfLearningsBestMeetings', [...meetings].sort((a,b) => (b?.profit_units ?? -999) - (a?.profit_units ?? -999)), { limit: 5 });
  renderLearningsMetricTable('perfLearningsWorstMeetings', [...meetings].sort((a,b) => (a?.profit_units ?? 999) - (b?.profit_units ?? 999)), { limit: 5 });
  renderLearningsMetricTable('perfLearningsBestBands', [...bands].sort((a,b) => (b?.roi ?? -999) - (a?.roi ?? -999)), { limit: 5 });
  renderLearningsMetricTable('perfLearningsWorstBands', [...bands].sort((a,b) => (a?.roi ?? 999) - (b?.roi ?? 999)), { limit: 5 });
  renderLearningsBetTable('perfLearningsTopBets', report.top_bets || []);
  renderLearningsBetTable('perfLearningsWorstBets', report.worst_bets || []);
}

async function loadPerformance(){
  const daily = await fetchLocal('./data/success_daily.json', { cache: 'no-store' }).then(r=>r.json()).catch(()=>null);
  const weekly = await fetchLocal('./data/success_weekly.json', { cache: 'no-store' }).then(r=>r.json()).catch(()=>null);
  const monthly = await fetchLocal('./data/success_monthly.json', { cache: 'no-store' }).then(r=>r.json()).catch(()=>null);
  const settledBets = await fetchLocal('./api/v1/settled-bets', { cache: 'no-store' }).then(r=>r.json()).catch(()=>[]);
  const learningsReport = await fetchLocal('./data/learnings_report.json', { cache: 'no-store' }).then(r=>r.json()).catch(()=>null);
  signalThresholdAuditCache = await fetchLocal('./data/signal_threshold_audit_v2.json', { cache: 'no-store' }).then(r=>r.json()).catch(()=>null);

  const summaryEl = $('perfSummary');
  if (!daily || !weekly || !monthly) {
    if (summaryEl) summaryEl.innerHTML = '<div class="sub">Performance data is incomplete or still generating. Refresh again shortly.</div>';
  }

  renderBetPlanPerformance(daily);
  renderLearningsReport(learningsReport);

  const latestDailyKey = latestKey(daily);
  const latestDaily = latestDailyKey ? daily[latestDailyKey] : null;
  const dailyNote = $('perfDailyNote');
  if (dailyNote) {
    const parsed = latestDailyKey ? Date.parse(`${latestDailyKey}T00:00:00Z`) : NaN;
    const diffDays = Number.isNaN(parsed) ? 0 : Math.floor((Date.now() - parsed) / 86400000);
    const stale = diffDays > 1 ? ` ⚠️ ${diffDays} days old` : '';
    dailyNote.textContent = latestDailyKey ? `Settled through ${latestDailyKey}${stale}` : '';
  }
  renderPerformanceSummary(daily);
  renderBestStrategy(daily);
  if (latestDaily) {
    $('perfLatestPeriod').textContent = latestDailyKey;
    $('perfTotalBets').textContent = latestDaily.total_bets ?? '—';
    $('perfWinRate').textContent = fmtPct(latestDaily.win_rate);
    $('perfWinPickPct').textContent = fmtPct(latestDaily.pick_breakdown?.win?.win_rate);
    $('perfRoiTote').textContent = fmtRoiZero(latestDaily.roi_tote);
    $('perfRoiRec').textContent = fmtRoi(latestDaily.roi_rec);
    $('perfRoiFixed').textContent = fmtRoi(latestDaily.roi_rec);
    $('perfRoiSp').textContent = fmtRoi(latestDaily.roi_sp);
    $('perfRoiEw').textContent = fmtRoi(latestDaily.roi_ew);
    $('perfExoticHit').textContent = fmtPct(latestDaily.exotic_hit_rate);
    $('perfExoticRoi').textContent = fmtRoi(latestDaily.exotic_roi_tote);
    renderLatestSnapshot(latestDaily);
    renderPickBreakdown(latestDaily);
    renderExoticBreakdown(latestDaily);
  }

  const avgDailyWinRate = averageDailyWinRate(daily, 30);
  $('perfAvgDailyWinRate') && ($('perfAvgDailyWinRate').textContent = fmtPct(avgDailyWinRate));
  const agg30 = aggregateLastNDays(daily, 30);
  const bestLabel = bestStrategyLabel(daily, 30);
  $('perfBestStrategyTile') && ($('perfBestStrategyTile').textContent = bestLabel || '—');
  if (agg30) {
    const winRateWin = agg30.pick.win.bets ? agg30.pick.win.wins / agg30.pick.win.bets : null;
    const winRateOdds = agg30.pick.odds_runner.bets ? agg30.pick.odds_runner.wins / agg30.pick.odds_runner.bets : null;
    const winRateEw = agg30.pick.ew.bets ? agg30.pick.ew.wins / agg30.pick.ew.bets : null;
    const winRateLong = agg30.long.bets ? agg30.long.wins / agg30.long.bets : null;
    $('perfWinTypePct') && ($('perfWinTypePct').textContent = fmtPct(winRateWin));
    $('perfOddsTypePct') && ($('perfOddsTypePct').textContent = fmtPct(winRateOdds));
    $('perfEwTypePct') && ($('perfEwTypePct').textContent = fmtPct(winRateEw));
    $('perfLongTypePct') && ($('perfLongTypePct').textContent = fmtPct(winRateLong));
  }
  autobetPerfDaily = daily;
  renderAutobetWindowTabs();
  renderAutobetTiles(daily);
  applyHeroTiles('heroDay', aggregateLastNDays(daily, 1));
  applyHeroTiles('heroWeek', aggregateLastNDays(daily, 7));
  applyHeroTiles('heroMonth', aggregateLastNDays(daily, 30));
  applyHeroTiles('heroYear', aggregateLastNDays(daily, 365));

  const allDays = daily ? Object.keys(daily).length : 0;
  const returnAgg = aggregateLastNDays(daily, allDays || 1);
  const baseReturn = returnAgg ? (returnAgg.roi_rec_base_profit ?? returnAgg.roi_rec_profit ?? null) : null;
  const baseInvested = returnAgg ? (returnAgg.roi_stake_base ?? returnAgg.roi_stake ?? null) : null;
  const exoticReturn = returnAgg ? (returnAgg.exotic_profit || 0) : null;
  const exoticInvested = returnAgg ? (returnAgg.exotic_stake || 0) : null;
  const netReturn = returnAgg ? ((baseReturn || 0) + (exoticReturn || 0)) : null;
  const invested = returnAgg ? ((baseInvested || 0) + (exoticInvested || 0)) : null;
  const returnValueEl = $('betmanReturnValue');
  const returnSubEl = $('betmanReturnSub');
  const returnBaseValueEl = $('betmanBaseReturnValue');
  const returnBaseEl = $('betmanBaseReturnSub');
  const returnExoticValueEl = $('betmanExoticReturnValue');
  const returnExoticEl = $('betmanExoticReturnSub');
  const returnBarEl = $('betmanReturnBar');
  const returnRoiEl = $('betmanReturnRoi');
  const returnUnitsEl = $('betmanReturnUnits');
  const returnStakeEl = $('betmanReturnStake');
  const roi = (Number.isFinite(netReturn) && Number.isFinite(invested) && invested) ? (netReturn / invested) : null;
  const baseRoi = (Number.isFinite(baseReturn) && Number.isFinite(baseInvested) && baseInvested) ? (baseReturn / baseInvested) : null;
  const exoticRoi = (Number.isFinite(exoticReturn) && Number.isFinite(exoticInvested) && exoticInvested) ? (exoticReturn / exoticInvested) : null;
  if (returnValueEl) {
    const isNeg = Number.isFinite(netReturn) && netReturn < 0;
    returnValueEl.textContent = Number.isFinite(netReturn) ? fmtUnits(netReturn) : '—';
    returnValueEl.classList.toggle('neg', !!isNeg);
  }
  if (returnBaseValueEl) {
    const isNeg = Number.isFinite(baseReturn) && baseReturn < 0;
    returnBaseValueEl.textContent = Number.isFinite(baseReturn) ? fmtUnits(baseReturn) : '—';
    returnBaseValueEl.classList.toggle('neg', !!isNeg);
  }
  if (returnExoticValueEl) {
    const isNeg = Number.isFinite(exoticReturn) && exoticReturn < 0;
    returnExoticValueEl.textContent = Number.isFinite(exoticReturn) ? fmtUnits(exoticReturn) : '—';
    returnExoticValueEl.classList.toggle('neg', !!isNeg);
  }
  if (returnSubEl) {
    returnSubEl.textContent = `ROI ${roi != null ? fmtPct(roi) : '—'} · Stake ${fmtUnits(invested)}`;
  }
  if (returnBaseEl) {
    returnBaseEl.textContent = `ROI ${baseRoi != null ? fmtPct(baseRoi) : '—'} · Stake ${fmtUnits(baseInvested)}`;
  }
  if (returnExoticEl) {
    returnExoticEl.textContent = `ROI ${exoticRoi != null ? fmtPct(exoticRoi) : '—'} · Stake ${fmtUnits(exoticInvested)}`;
  }
  if (returnRoiEl) {
    returnRoiEl.textContent = roi != null ? fmtPct(roi) : '—';
    returnRoiEl.classList.toggle('neg', roi != null && roi < 0);
  }
  if (returnUnitsEl) {
    const isNeg = Number.isFinite(netReturn) && netReturn < 0;
    returnUnitsEl.textContent = Number.isFinite(netReturn) ? fmtUnits(netReturn) : '—';
    returnUnitsEl.classList.toggle('neg', !!isNeg);
  }
  if (returnStakeEl) {
    returnStakeEl.textContent = Number.isFinite(invested) ? fmtUnits(invested) : '—';
  }
  if (returnBarEl) {
    const roi = (Number.isFinite(netReturn) && Number.isFinite(invested) && invested) ? (netReturn / invested) : null;
    const pct = roi != null ? Math.min(Math.abs(roi) * 100, 100) : 0;
    returnBarEl.style.width = `${pct}%`;
    returnBarEl.classList.toggle('neg', roi != null && roi < 0);
  }
  const returnTableEl = $('betmanReturnTable');
  if (returnTableEl) {
    const rows = [
      { label: 'Combined P/L', pl: netReturn, roi, stake: invested },
      { label: 'Base Strategies P/L', pl: baseReturn, roi: baseRoi, stake: baseInvested },
      { label: 'Exotics P/L', pl: exoticReturn, roi: exoticRoi, stake: exoticInvested }
    ];
    const table = [`<div class='row header'><div>Bucket</div><div>P/L (u)</div><div>ROI</div><div class='right'>Stake (u)</div></div>`];
    rows.forEach(row => {
      table.push(`<div class='row'>
        <div>${row.label}</div>
        <div>${fmtUnits(row.pl)}</div>
        <div>${fmtPct(row.roi)}</div>
        <div class='right'>${fmtUnits(row.stake)}</div>
      </div>`);
    });
    returnTableEl.innerHTML = table.join('');
  }

  renderBetPlansRoi(daily, weekly, monthly);
  renderPerformanceTable('perfDailyTable', daily, { strategyDetail: true });
  renderPerformanceTable('perfWeeklyTable', weekly);
  renderPerformanceTable('perfMonthlyTable', monthly);
  renderExoticsTable('perfExoticsTable', daily);

  latestSettledBetsCache = Array.isArray(settledBets) ? settledBets : [];
  renderPerformanceLedger(latestSettledBetsCache);
  const fromInputInit = $('perfSettledDateFrom');
  const toInputInit = $('perfSettledDateTo');
  if ((fromInputInit && !fromInputInit.value) || (toInputInit && !toInputInit.value)) {
    initializeSettledBetFilters(latestSettledBetsCache);
  }
  renderSettledBets(settledBets);

  const searchInput = $('perfSettledSearch');
  if (searchInput && searchInput.dataset.bound !== '1') {
    searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') renderSettledBets(latestSettledBetsCache);
    });
    searchInput.dataset.bound = '1';
  }

  const searchBtn = $('perfSettledSearchBtn');
  if (searchBtn && searchBtn.dataset.bound !== '1') {
    searchBtn.addEventListener('click', () => renderSettledBets(latestSettledBetsCache));
    searchBtn.dataset.bound = '1';
  }

  const clearBtn = $('perfSettledClearBtn');
  if (clearBtn && clearBtn.dataset.bound !== '1') {
    clearBtn.addEventListener('click', () => {
      initializeSettledBetFilters(latestSettledBetsCache);
      renderSettledBets(latestSettledBetsCache);
    });
    clearBtn.dataset.bound = '1';
  }

  const exportBtn = $('perfSettledExportCsv');
  if (exportBtn && exportBtn.dataset.bound !== '1') {
    exportBtn.addEventListener('click', () => {
      const rows = [['date','meeting','race','selection','type','result','winner','position','odds','place_odds','stake_units','return_units','profit_units','roi','pick_bucket','is_long']];
      const q = String($('perfSettledSearch')?.value || '').trim().toLowerCase();
      const resultFilter = String($('perfSettledResultFilter')?.value || 'all').toLowerCase();
      const typeFilter = String($('perfSettledTypeFilter')?.value || 'all').toLowerCase();
      const meetingFilter = String($('perfSettledMeetingFilter')?.value || 'all');
      const fromDate = String($('perfSettledDateFrom')?.value || '');
      const toDate = String($('perfSettledDateTo')?.value || '');
      (Array.isArray(settledBets) ? settledBets : []).filter(b => {
        const result = normalizeSettledResultValue(b?.result);
        const type = String(b?.type || '').toLowerCase();
        const meeting = String(b?.meeting || '');
        const betDate = String(b?.date || '');
        if (fromDate && betDate && betDate < fromDate) return false;
        if (toDate && betDate && betDate > toDate) return false;
        if (meetingFilter !== 'all' && meeting !== meetingFilter) return false;
        if (resultFilter !== 'all' && result !== resultFilter) return false;
        if (typeFilter !== 'all' && type !== typeFilter) return false;
        if (!q) return true;
        const hay = [b?.date,b?.meeting,`r${b?.race || ''}`,b?.selection,b?.type,b?.result,canonicalTrackedResultLabel(b?.result),normalizeSettledResultValue(b?.result),b?.winner,b?.pick_bucket].map(v => String(v || '').toLowerCase()).join(' | ');
        return hay.includes(q);
      }).forEach(b => {
        rows.push([
          b?.date, b?.meeting, b?.race, b?.selection, b?.type, b?.result, b?.winner, b?.position,
          b?.odds, b?.place_odds, b?.stake_units, b?.return_units, b?.profit_units, b?.roi, b?.pick_bucket, b?.is_long
        ]);
      });
      downloadCsv(`settled-bets-${fromDate || 'from'}-to-${toDate || 'to'}.csv`, rows);
    });
    exportBtn.dataset.bound = '1';
  }

  renderPerformanceCharts(daily);
  renderConfidenceBasedBets();
  updatePerformanceRefreshState();
}

async function enqueueRequest(type, target='main'){
  const payload = {
    type,
    target,
    mode: 'command',
    ts: new Date().toISOString()
  };
  try {
    const sres = await fetchLocal('./api/stake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: type, target })
    });
    const sdata = await sres.json();
    stakePerRace = sdata.stakePerRace || stakePerRace;
    exoticStakePerRace = (typeof sdata.exoticStakePerRace === 'number') ? sdata.exoticStakePerRace : exoticStakePerRace;
    earlyWindowMin = (typeof sdata.earlyWindowMin === 'number') ? sdata.earlyWindowMin : earlyWindowMin;
    aiWindowMin = (typeof sdata.aiWindowMin === 'number') ? sdata.aiWindowMin : aiWindowMin;
    localStorage.setItem('stakePerRace', String(stakePerRace));
    localStorage.setItem('exoticStakePerRace', String(exoticStakePerRace));
    localStorage.setItem('earlyWindowMin', String(earlyWindowMin));
    localStorage.setItem('aiWindowMin', String(aiWindowMin));
    refreshBetWindowUi();
    $('aiWindowMin') && ($('aiWindowMin').textContent = `AI Bets to Place window: ${aiWindowMin}m`);

    await fetchLocal('./data/requests.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // rebuild plans/status with new stake immediately
    await fetchLocal('./api/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: selectedDay, country: selectedCountry })
    }).catch(()=>{});
    await loadStatus();

    const label = target === 'exotic' ? 'Exotic' : (target === 'window' ? 'Suggested window' : (target === 'aiwindow' ? 'AI window' : 'Main'));
    alert(`${label} ${type} executed.`);
  } catch (e) {
    const local = JSON.parse(localStorage.getItem('stakeRequests')||'[]');
    local.push(payload);
    localStorage.setItem('stakeRequests', JSON.stringify(local));
    // optimistic local update
    if (target === 'exotic') {
      if (type === 'increase') exoticStakePerRace = Math.round((exoticStakePerRace + 0.5) * 100) / 100;
      if (type === 'decrease') exoticStakePerRace = Math.max(0, Math.round((exoticStakePerRace - 0.5) * 100) / 100);
      localStorage.setItem('exoticStakePerRace', String(exoticStakePerRace));
    } else if (target === 'window') {
      if (type === 'increase') earlyWindowMin = Math.min(3600, earlyWindowMin + 30);
      if (type === 'decrease') earlyWindowMin = Math.max(1, earlyWindowMin - 30);
      localStorage.setItem('earlyWindowMin', String(earlyWindowMin));
      refreshBetWindowUi();
    } else if (target === 'aiwindow') {
      if (type === 'increase') aiWindowMin = Math.min(30, aiWindowMin + 1);
      if (type === 'decrease') aiWindowMin = Math.max(1, aiWindowMin - 1);
      localStorage.setItem('aiWindowMin', String(aiWindowMin));
      $('aiWindowMin') && ($('aiWindowMin').textContent = `AI Bets to Place window: ${aiWindowMin}m`);
    } else {
      if (type === 'increase') stakePerRace += 1;
      if (type === 'decrease') stakePerRace = Math.max(1, stakePerRace - 1);
      localStorage.setItem('stakePerRace', String(stakePerRace));
    }
    const label = target === 'exotic' ? 'Exotic' : (target === 'window' ? 'Suggested window' : (target === 'aiwindow' ? 'AI window' : 'Main'));
    alert(`${label} ${type} executed (local).`);
  }
}

$('saveBetWindowBtn')?.addEventListener('click', async ()=>{
  const val = Number(($('betWindowInput')?.value || '').trim());
  if (!Number.isFinite(val)) return alert('Enter a valid number.');
  const clamped = Math.max(1, Math.min(3600, Math.round(val)));
  earlyWindowMin = clamped;
  localStorage.setItem('earlyWindowMin', String(earlyWindowMin));
  refreshBetWindowUi();
  try {
    const res = await fetchLocal('./api/stake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'window', value: clamped })
    });
    const sdata = await res.json();
    earlyWindowMin = (typeof sdata.earlyWindowMin === 'number') ? sdata.earlyWindowMin : clamped;
    localStorage.setItem('earlyWindowMin', String(earlyWindowMin));
    refreshBetWindowUi();

    // Rebuild queue immediately so Suggested/Plans reflect new window without waiting for cron.
    await fetchLocal('./api/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: selectedDay, country: selectedCountry, meeting: selectedMeeting })
    });
    await loadRaces();
    renderRaces(racesCache);
    await loadStatus();

    alert(`Bet window set to ${earlyWindowMin} minutes and queue refreshed.`);
  } catch {
    alert('Failed to update bet window.');
  }
});
// removed AI-bets-to-place controls

$('summaryModalClose')?.addEventListener('click', closeSummaryPopup);
$('summaryModalBackdrop')?.addEventListener('click', closeSummaryPopup);
$('strategyPrintModalClose')?.addEventListener('click', ()=> toggleStrategyPrintModal(false));
$('strategyPrintModalBackdrop')?.addEventListener('click', ()=> toggleStrategyPrintModal(false));
$('strategyPrintRenderBtn')?.addEventListener('click', ()=> {
  const frame = $('strategyPrintFrame');
  try { frame?.contentWindow?.focus(); frame?.contentWindow?.print(); } catch {}
});
$('strategyPrintDownloadBtn')?.addEventListener('click', async ()=> {
  const frame = $('strategyPrintFrame');
  const html = frame?.dataset?.doc || frame?.srcdoc || '';
  if (!html) return;

  // Preferred: render high-quality PDF via html2pdf.js
  if (window.html2pdf) {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '-99999px';
    container.style.top = '0';
    container.style.width = '1024px';
    container.innerHTML = html;
    document.body.appendChild(container);
    const book = container.querySelector('.book') || container;
    try {
      await window.html2pdf()
        .set({
          margin: [8, 8, 8, 8],
          filename: `strategy-racebook-${Date.now()}.pdf`,
          image: { type: 'jpeg', quality: 0.98 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: '#f0dfbe' },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          pagebreak: { mode: ['css', 'legacy'] }
        })
        .from(book)
        .save();
      return;
    } catch (err) {
      console.warn('strategy_pdf_render_failed', err);
    } finally {
      container.remove();
    }
  }

  // Fallback: download HTML snapshot
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `strategy-racebook-${Date.now()}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') { closeSummaryPopup(); toggleStrategyPrintModal(false); } });

document.addEventListener('click', (e) => {
  const bloodlineBtn = e.target?.closest?.('.bloodline-profile-btn');
  if (bloodlineBtn) {
    const bloodline = bloodlineBtn.getAttribute('data-bloodline') || '';
    const relation = bloodlineBtn.getAttribute('data-relation') || 'Bloodline';
    openBloodlineProfile(bloodline, relation);
    return;
  }
  const btn = e.target?.closest?.('.jockey-profile-btn');
  if (!btn) return;
  const jockey = btn.getAttribute('data-jockey') || '';
  const raceKey = btn.getAttribute('data-race-key') || '';
  const race = (racesCache || []).find(r => String(r.key || '') === String(raceKey)) || selectedRace || null;
  openJockeyProfile(jockey, race);
});

$('placeAiBetsBtn')?.addEventListener('click', async ()=>{
  if (!selectedRace) {
    await loadRaces();
    const selectedCard = document.querySelector('.race-card.selected');
    if (selectedCard) {
      await selectRace(selectedCard.dataset.key, selectedCard.dataset.meeting, selectedCard.dataset.race);
    } else {
      selectedRace = racesCache[0];
      selectedRaceKey = selectedRace ? selectedRace.key : null;
    }
  }

  if (!selectedRace) return alert('Select a race first.');

  const plan = buildAIPlan(selectedRace);
  if (!plan || !plan.bets || !plan.bets.length) return alert('No AI plan available for this race.');

  const bets = plan.bets.map(b => {
    const runner = (selectedRace.runners || []).find(r => String(r.name || r.runner_name) === String(b.selection));
    return {
      meeting: selectedRace.meeting,
      race: selectedRace.race_number,
      selection: b.selection,
      stake: b.stake,
      type: b.type,
      odds: runner?.odds || runner?.fixed_win || '',
      eta: selectedRace.start_time_nz || 'upcoming',
      sortTime: selectedRace.advertised_start || ''
    };
  });

  try {
    const res = await fetchLocal('./api/place-ai-bets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bets })
    });
    const out = await res.json();
    await loadStatus();
    alert(`AI bets queued: ${out.queued ?? out.placed ?? 0}${out.skipped ? ` (skipped ${out.skipped} already matched)` : ''}`);
  } catch (e) {
    alert('Failed to queue AI bets.');
  }
});

async function openAIMultiPreview(legCount = 2){
  if (!selectedRace) {
    await loadRaces();
    const selectedCard = document.querySelector('.race-card.selected');
    if (selectedCard) await selectRace(selectedCard.dataset.key, selectedCard.dataset.meeting, selectedCard.dataset.race);
    else {
      selectedRace = racesCache[0];
      selectedRaceKey = selectedRace ? selectedRace.key : null;
    }
  }
  if (!selectedRace) return alert('Select a race first.');
  if (raceHasJumped(selectedRace, 30)) return alert('Selected race has already jumped — pick an upcoming race before building a multi.');

  const n = Math.max(2, Math.min(4, Number(legCount || 2)));
  const multi = buildAIMultiPlan(selectedRace, n);
  if (!multi) return alert(`Unable to build a valid ${n}-leg multi from current win selections (missing enough races or odds).`);

  const legs = (multi.legs || []).map((r, i) => {
    const nm = String(r.selection || runnerLabel(r));
    const od = Number(r.odds || 0);
    return `<tr><td>Leg ${i+1}</td><td>${r.meeting} R${r.race} — ${nm}</td><td>${od ? od.toFixed(2) : '—'}</td></tr>`;
  }).join('');

  openSummaryPopup(
    `AI ${n}‑Race Multi — ${selectedRace.meeting} R${selectedRace.race_number}`,
    `<div><b>Selection:</b> ${multi.selectionLabel}</div>
     <div style='margin-top:6px'><b>Type:</b> Standard Multi (different races)</div>
     <div><b>Stake:</b> $${Number(multi.stake || 0).toFixed(2)}</div>
     <div><b>Estimated Multi Odds:</b> ${Number(multi.estMultiOdds || 0).toFixed(2)}</div>
     <div><b>Calculation:</b> ${multi.calc || 'n/a'}</div>
     <div style='margin-top:8px'><b>Legs</b></div>
     <table><tr><th>Leg</th><th>Runner</th><th>Odds</th></tr>${legs}</table>
     <div style='margin-top:8px;color:#f5c066'><b>Note:</b> Same‑Race Multi is a different market with bookmaker-specific pricing. This tool estimates standard cross-race multis only.</div>
     <div style='margin-top:8px;color:#7aa3c7'>Display-only preview. No bet has been queued.</div>`
  );
}

$('pickAiMultiBtn').addEventListener('click', async ()=> openAIMultiPreview(2));
$('pickAiMulti3Btn')?.addEventListener('click', async ()=> openAIMultiPreview(3));
$('pickAiMulti4Btn')?.addEventListener('click', async ()=> openAIMultiPreview(4));

async function selectRace(key, fallbackMeeting = null, fallbackRace = null){
  if (!racesCache.length) await loadRaces();
  await loadTrackedBetsCache();
  let race = key ? racesCache.find(r=>r.key === key) : null;
  if (!race && fallbackMeeting) {
    race = getRaceFromCache(fallbackMeeting, fallbackRace);
  }
  if (!race && (key || fallbackMeeting)) {
    const all = await loadAllRacesUnfiltered();
    race = (all || []).find(r => raceIdentityMatches(r, { key, meeting: fallbackMeeting, raceNumber: fallbackRace }));
  }
  if (!race) return;
  const cutoff = Date.now() - 5 * 60 * 1000;
  if (!raceIsUpcoming(race, cutoff)) {
    selectedRace = null;
    selectedRaceKey = null;
    renderRaces(racesCache);
    return;
  }

  await alignSelectionUniverse({
    key: race.key || key,
    meeting: race.meeting || fallbackMeeting,
    raceNumber: race.race_number || race.race || fallbackRace,
    country: race.country || ''
  });

  const resolvedRace = (racesCache || []).find(r => raceIdentityMatches(r, race))
    || (fallbackMeeting ? getRaceFromCache(fallbackMeeting, fallbackRace, race.country || '') : null)
    || race;

  hideAnalysisProcessingHint();
  selectedRace = resolvedRace;
  selectedRaceKey = resolvedRace.key || key || buildRaceCacheKey(fallbackMeeting, fallbackRace);
  await hydrateRaceWithLoveracing(selectedRace);

  // Selecting a race should lock meeting context and unlock dependent tabs.
  selectedMeeting = String(selectedRace.meeting || 'ALL');
  if (selectedRace.country && normalizeUiCountry(selectedRace.country, '') && normalizeUiCountry(selectedRace.country, '') !== 'ALL') {
    selectedCountry = normalizeUiCountry(selectedRace.country, selectedCountry);
    const cs = $('countrySelect');
    if (cs) cs.value = selectedCountry;
  }
  persistMeetingLock();
  persistLastRaceSelection(selectedRace);
  const meetingSel = $('meetingSelect');
  if (meetingSel) meetingSel.value = selectedMeeting;
  refreshTabAccess();
  renderMeetingList(racesCache);

  $('analysisTitle').textContent = `${selectedRace.meeting} R${selectedRace.race_number} — ${selectedRace.description}`;
  analysisViewMode = 'engine';
  updateAnalysisToggleLabel();
  $('analysisBody').innerHTML = renderAnalysis(selectedRace, 'engine');
  updateAnalysisAiModelNote();
  attachAnalysisSelectionHandlers(selectedRace);
  makeSelectionsDraggable();
  ensureAiAnswerHost();
  clearAiAnswerPanel();
  renderCachedAiAnalysisIfPresent(selectedRace);
  refreshAiAnalyseButtonState();
  renderRaces(racesCache);
  renderInteresting(latestInterestingRows || []);
  renderMarketMovers(latestMarketMovers || []);
}
function refreshSelectedRaceAnalysis(){
  if (!selectedRace) return;
  const cutoff = Date.now() - 5 * 60 * 1000;
  if (!raceIsUpcoming(selectedRace, cutoff)) {
    selectedRace = null;
    selectedRaceKey = null;
    $('analysisBody').innerHTML = '<div class="sub">Race closed (more than 5 minutes past jump).</div>';
    clearAiAnswerPanel();
    renderRaces(racesCache);
    return;
  }
  const viewMode = analysisViewMode || 'engine';
  $('analysisBody').innerHTML = renderAnalysis(selectedRace, viewMode);
  updateAnalysisToggleLabel();
  updateAnalysisAiModelNote();
  attachAnalysisSelectionHandlers(selectedRace);
  makeSelectionsDraggable();
  $('analysisTitle').textContent = `${selectedRace.meeting} R${selectedRace.race_number} — ${selectedRace.description || ''}`;
  if (!renderCachedAiAnalysisIfPresent(selectedRace)) {
    clearAiAnswerPanel();
  }
}



function cleanRunnerText(v){
  return String(v || '')
    // Remove bracketed probability blobs like "(~23.1%).'>" or "(23.1%)"
    .replace(/\([^)]*\d+(?:\.\d+)?%[^)]*\)\s*["'`>\.]*/g, '')
    // strip loose probability fragments: 42%, ~23.1%, 23.1%..., etc.
    .replace(/[~≈]?\s*\d+(?:\.\d+)?%\s*["'`>\.]*/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+[\-–—,:;]+\s*$/g, '')
    .trim();
}

function formatResponseTime(ms){
  if (!Number.isFinite(ms)) return null;
  const seconds = ms / 1000;
  return seconds >= 1 ? `${seconds.toFixed(1)}s` : `${seconds.toFixed(2)}s`;
}

function formatAiModeBadge(mode){
  const normalized = String(mode || '').toLowerCase();
  if (normalized === 'ai') return '[AI]';
  if (normalized === 'cache') return '[CACHE]';
  if (normalized === 'fallback') return '[DATA]';
  if (normalized === 'clarify') return '[CLARIFY]';
  return '[AI]';
}

function parsePctValue(val){
  if (val === null || val === undefined || val === '') return NaN;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const match = val.match(/-?\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return NaN;
}

function runnerSimKey(runner){
  if (!runner) return '';
  if (runner.name) return runner.name;
  if (runner.runner_name) return runner.runner_name;
  if (runner.runner_number != null) return `#${runner.runner_number}`;
  return String(runner.key || '').trim();
}

function modeledPlacePct(runner, opts = {}){
  const normalizePct = (v) => {
    if (!Number.isFinite(v)) return NaN;
    let out = v;
    if (out > 0 && out <= 1) out *= 100;
    if (out < 0) out = 0;
    // Avoid degenerate 0/100 place outputs that pollute EW logic.
    if (out >= 100) out = 95;
    return Math.round(out * 10) / 10;
  };

  const directFields = [
    runner?.model_place_pct,
    runner?.modelPlacePct,
    runner?.place_model_pct,
    runner?.placeModelPct,
    runner?.place_p,
    runner?.placeP,
    runner?.modeled_place_pct,
    runner?.modeledPlacePct
  ];
  for (const field of directFields) {
    const parsed = parsePctValue(field);
    const normalized = normalizePct(parsed);
    if (Number.isFinite(normalized)) return normalized;
  }

  const sim = opts?.sim;
  if (sim && runner) {
    const key = runnerSimKey(runner);
    const simVal = sim[key] ?? sim[runner?.name] ?? sim[runner?.runner_name];
    const winPct = Number(simVal) * 100;
    if (Number.isFinite(winPct)) {
      return normalizePct(Math.min(95, Math.max(winPct, Math.round((winPct * 1.85 + 8) * 10) / 10)));
    }
  }

  const placeOddsGetter = typeof opts?.placeOddsGetter === 'function' ? opts.placeOddsGetter : null;
  const rawPlaceOdds = placeOddsGetter ? placeOddsGetter(runner) : Number(runner?.fixed_place || runner?.tote_place || runner?.place_odds || runner?.place_price || 0);
  if (Number.isFinite(rawPlaceOdds) && rawPlaceOdds > 0) {
    return normalizePct(100 / rawPlaceOdds);
  }
  return NaN;
}


function validateDecisionSignals(signals = {}){
  const issues = [];
  const winEdge = Number(signals.recommendedWinEdge);
  if (signals.recommended && (!Number.isFinite(winEdge) || winEdge < 0)) {
    issues.push('recommended_negative_edge');
  }
  const odds = Number(signals.oddsRunnerOdds);
  const oddsEdge = Number(signals.oddsRunnerEdge);
  if (signals.oddsRunner && (!Number.isFinite(odds) || odds < 6 || !Number.isFinite(oddsEdge) || oddsEdge <= 0)) {
    issues.push('odds_runner_invalid_profile');
  }
  const ewPlace = Number(signals.ewPlaceProb);
  if (signals.ew && Number.isFinite(ewPlace) && (ewPlace <= 0 || ewPlace >= 0.9)) {
    issues.push('ew_degenerate_place_prob');
  }
  return issues;
}

function formatGearText(v, fallback = '—'){
  if (!v) return fallback;
  const cleaned = String(v).replace(/[\[\]]+/g, '').trim();
  return cleaned || fallback;
}

function escapeHtml(s){
  return String(s ?? '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function escapeAttr(s){
  return escapeHtml(s);
}

function formatInlineAiText(text){
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g,'<b>$1</b>')
    .replace(/__(.+?)__/g,'<u>$1</u>')
    .replace(/`([^`]+)`/g,'<code>$1</code>');
}

function formatAiAnswer(raw){
  const source = String(raw || '').trim();
  if (!source) return `<div class='analysis-block'><div>No analysis returned.</div></div>`;
  const blocks = source
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(b => b.trim())
    .filter(Boolean);
  const htmlBlocks = blocks.map(block => {
    const lines = block.split(/\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    const isPureList = lines.every(line => /^(?:[-•]\s+|\d+\.\s+)/.test(line));
    if (isPureList) {
      const items = lines.map(line => {
        const cleaned = line.replace(/^(?:[-•]\s+|\d+\.\s+)/, '');
        return `<li>${formatInlineAiText(cleaned)}</li>`;
      }).join('');
      return `<div class='analysis-block'><ul>${items}</ul></div>`;
    }
    const rendered = lines.map(line => {
      const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const level = Math.min(6, headingMatch[1].length);
        return `<div class='ai-subheading level-${level}'>${formatInlineAiText(headingMatch[2])}</div>`;
      }
      if (/^[-•]\s+/.test(line)) {
        return `<div>• ${formatInlineAiText(line.replace(/^[-•]\s+/, ''))}</div>`;
      }
      if (/^\d+\.\s+/.test(line)) {
        return `<div>${formatInlineAiText(line.replace(/^\d+\.\s+/, ''))}</div>`;
      }
      if (/^[A-Za-z][A-Za-z\s]{1,30}:/.test(line)) {
        const idx = line.indexOf(':');
        const label = escapeHtml(line.slice(0, idx + 1));
        const rest = formatInlineAiText(line.slice(idx + 1).trim());
        return `<div><b>${label}</b> ${rest}</div>`;
      }
      return `<div>${formatInlineAiText(line)}</div>`;
    }).join('');
    return `<div class='analysis-block'>${rendered}</div>`;
  }).filter(Boolean);
  return htmlBlocks.join('') || `<div class='analysis-block'><div>${formatInlineAiText(source)}</div></div>`;
}

function buildOddsSummaryTable(race){
  if (!race || !Array.isArray(race.runners)) return '';
  const edgeRows = Array.isArray(latestAnalysisSignals?.edgeRows) ? latestAnalysisSignals.edgeRows : [];
  const edgeMap = new Map(edgeRows.map(r => [normalizeRunnerName(r?.name || ''), r]));
  const rows = race.runners.map(r => {
    const name = cleanRunnerText(r.name || r.runner_name || '');
    if (!name) return null;
    const odds = Number(r?.odds || r?.fixed_win || r?.tote_win || 0);
    if (!Number.isFinite(odds) || odds <= 0) return null;
    const implied = 100 / odds;
    const rawModel = Number(r?.win_p ?? r?.modelProb ?? r?.model_win_pct ?? r?.modelProb);
    let model = Number.isFinite(rawModel) ? (rawModel <= 1 ? rawModel * 100 : rawModel) : NaN;
    let edge = (Number.isFinite(model) && Number.isFinite(implied)) ? (model - implied) : NaN;
    const edgeRow = edgeMap.get(normalizeRunnerName(name));
    if (edgeRow) {
      if (!Number.isFinite(model) && Number.isFinite(edgeRow.modeledPct)) model = edgeRow.modeledPct;
      if (Number.isFinite(edgeRow.edgePct)) edge = edgeRow.edgePct;
    }
    const numberRaw = r.number ?? r.runner_number ?? r.saddle_number ?? r.horse_number ?? r.program_number ?? r.tab_no ?? null;
    const label = (numberRaw === 0 || numberRaw) ? `${name} (#${String(numberRaw).trim()})` : name;
    return { label, odds, implied, model, edge };
  }).filter(Boolean).sort((a,b)=>a.odds-b.odds);
  if (!rows.length) return '';
  const body = rows.map(r => {
    const impliedTxt = Number.isFinite(r.implied) ? `${r.implied.toFixed(2)}%` : '—';
    const modelTxt = Number.isFinite(r.model) ? `${r.model.toFixed(2)}%` : '—';
    const edgeTxt = Number.isFinite(r.edge) ? `${r.edge >= 0 ? '+' : ''}${r.edge.toFixed(2)}%` : '—';
    return `<tr><td>${escapeHtml(r.label)}</td><td>$${r.odds.toFixed(2)}</td><td>${impliedTxt}</td><td>${modelTxt}</td><td>${edgeTxt}</td></tr>`;
  }).join('');
  return `
    <div class='analysis-block odds-summary-block'>
      <div class='analysis-table-scroll'>
        <table class='analysis-table'>
          <tr><th>Runner</th><th>Odds</th><th>Implied Probability</th><th>Model Probability</th><th>Edge (%)</th></tr>
          ${body}
        </table>
      </div>
    </div>`;
}

function normalizeRunnerName(v){
  return cleanRunnerText(v).toLowerCase();
}

function buildRaceCacheKey(meeting, raceNumber){
  const mtg = String(meeting || '').trim().toLowerCase();
  const race = String(raceNumber || '').replace(/^R/i,'').trim();
  if (!mtg || !race) return '';
  return `${mtg}|${race}`;
}

function normalizeCountryKey(value){
  return String(value || '').trim().toUpperCase();
}

function raceIdentityMatches(row, target = {}){
  if (!row || !target) return false;
  const targetKey = String(target.key || '').trim();
  if (targetKey && row.key && String(row.key).trim() === targetKey) return true;
  const meetingOk = normalizeMeetingKey(row.meeting) === normalizeMeetingKey(target.meeting);
  const raceOk = normalizeRaceNumberValue(row.race_number || row.race) === normalizeRaceNumberValue(target.race_number || target.race || target.raceNumber);
  if (!meetingOk || !raceOk) return false;
  const targetCountry = normalizeCountryKey(target.country);
  const rowCountry = normalizeCountryKey(row.country);
  return !targetCountry || !rowCountry || targetCountry === rowCountry;
}

function normalizeMeetingNameText(v){
  return String(v || '').trim().toLowerCase();
}

function findMeetingInCollection(collection, targetNorm){
  if (!targetNorm) return null;
  const exact = (collection || []).find(r => normalizeMeetingNameText(r?.meeting) === targetNorm);
  if (exact) return exact;
  return (collection || []).find(r => {
    const label = normalizeMeetingNameText(r?.meeting);
    return label && label.includes(targetNorm);
  }) || null;
}

function parseMeetingSearchValue(raw){
  const value = String(raw || '').trim();
  if (!value) return { meeting: '', race: null };
  let meeting = value;
  let race = null;
  const rMatch = value.match(/(.+?)\s+r(?:ace)?\s*(\d+)/i);
  if (rMatch) {
    meeting = rMatch[1];
    race = rMatch[2];
  } else {
    const trailing = value.match(/(.+?)\s+(\d{1,2})$/);
    if (trailing) {
      meeting = trailing[1];
      race = trailing[2];
    }
  }
  meeting = meeting.trim();
  const raceClean = race ? String(Number(race)) : null;
  return { meeting, race: raceClean };
}

function setMeetingSearchHint(text, isError = false){
  const hint = $('meetingSearchHint');
  if (!hint) return;
  hint.textContent = text || '';
  hint.style.color = isError ? '#ff8a8a' : '#7d8b9d';
}

function invalidateMeetingSearch(){
  meetingSearchRunId++;
  const btn = $('meetingSearchBtn');
  const hadPending = !!(btn && btn.dataset.searchRun);
  if (btn) {
    btn.disabled = false;
    delete btn.dataset.searchRun;
  }
  if (hadPending) setMeetingSearchHint('Selection changed — search cancelled');
}

async function resolveMeetingMeta(name){
  const norm = normalizeMeetingNameText(name);
  if (!norm) return null;
  const sources = [racesCache, lastRacesSnapshot].filter(src => Array.isArray(src) && src.length);
  for (const src of sources) {
    const hit = findMeetingInCollection(src, norm);
    if (hit) return hit;
  }
  const fallback = await loadAllRacesUnfiltered();
  return findMeetingInCollection(fallback, norm);
}

async function alignSelectionUniverse(target = {}){
  const targetMeeting = String(target.meeting || '').trim();
  const targetCountry = normalizeUiCountry(target.country, '');
  const countryChanged = !!(targetCountry && targetCountry !== 'ALL' && targetCountry !== selectedCountry);
  const meetingChanged = !!(targetMeeting && normalizeMeetingKey(targetMeeting) !== normalizeMeetingKey(selectedMeeting));

  if (countryChanged) {
    selectedCountry = targetCountry;
    const cs = $('countrySelect');
    if (cs) cs.value = targetCountry;
  }
  if (meetingChanged) {
    selectedMeeting = targetMeeting;
  }
  if (countryChanged || meetingChanged) persistMeetingLock();

  const hasRaceInCache = (racesCache || []).some(r => raceIdentityMatches(r, target));
  if (!racesCache.length || countryChanged || meetingChanged || !hasRaceInCache) {
    await loadRaces();
  }

  if (targetMeeting) {
    const canonicalMeeting = (racesCache || []).find(r => normalizeMeetingKey(r.meeting) === normalizeMeetingKey(targetMeeting))?.meeting;
    const resolvedMeeting = canonicalMeeting || selectedMeeting || targetMeeting;
    selectedMeeting = resolvedMeeting;
    const meetingSel = $('meetingSelect');
    if (meetingSel) meetingSel.value = resolvedMeeting;
    persistMeetingLock();
  }
}

async function focusMeetingSelection(meetingMeta, raceNumber, options = {}){
  if (!meetingMeta || !meetingMeta.meeting) return false;
  const token = options?.token ?? null;
  const tokenActive = () => token == null || token === meetingSearchRunId;
  if (!tokenActive()) return false;

  await alignSelectionUniverse({
    meeting: meetingMeta.meeting,
    country: meetingMeta.country,
    raceNumber
  });
  if (!tokenActive()) return false;

  renderRaces(racesCache);
  if (!tokenActive()) return false;
  renderInteresting(latestInterestingRows || []);
  if (!tokenActive()) return false;
  renderMarketMovers(latestMarketMovers || []);
  refreshTabAccess();

  if (raceNumber) {
    if (!tokenActive()) return false;
    await selectRace(null, meetingMeta.meeting, raceNumber);
    if (!tokenActive()) return false;
  }
  return true;
}

async function handleMeetingSearchSubmit(){
  const input = $('meetingSearchInput');
  if (!input) return;
  const { meeting, race } = parseMeetingSearchValue(input.value);
  if (!meeting) {
    setMeetingSearchHint('Enter a meeting name', true);
    return;
  }
  setMeetingSearchHint('Searching…');
  const btn = $('meetingSearchBtn');
  const runId = ++meetingSearchRunId;
  if (btn) {
    btn.disabled = true;
    btn.dataset.searchRun = String(runId);
  }
  try {
    const meta = await resolveMeetingMeta(meeting);
    if (runId !== meetingSearchRunId) return;
    if (!meta) {
      setMeetingSearchHint(`No meeting found for "${meeting}"`, true);
      return;
    }
    const ok = await focusMeetingSelection(meta, race, { token: runId });
    if (!ok || runId !== meetingSearchRunId) return;
    if (race) {
      setMeetingSearchHint(`Jumped to ${meta.meeting} R${race}`);
    } else {
      setMeetingSearchHint(`Focused ${meta.meeting}`);
    }
  } catch (err) {
    console.error('meeting_search_failed', err);
    setMeetingSearchHint('Search failed', true);
  } finally {
    if (btn && btn.dataset.searchRun === String(runId)) {
      btn.disabled = false;
      delete btn.dataset.searchRun;
    }
  }
}

function slugifyMeetingName(name){
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'') || 'unknown-meeting';
}

function buildAiRaceKey(race){
  if (!race) return '';
  const base = race.key || `${race.meeting}|${race.race_number}`;
  const dateStamp = race.race_date || race.date || race.meeting_date || (lastRacesMeta?.dateStr) || '';
  const startStamp = race.advertised_start || race.start_time_epoch || race.start_time_nz || '';
  return [base, dateStamp, startStamp].filter(Boolean).join('|') || base;
}

function getRaceFromCache(meeting, raceNumber, country = ''){
  const key = buildRaceCacheKey(meeting, raceNumber);
  if (!key) return null;
  return (racesCache || []).find(r => buildRaceCacheKey(r.meeting, r.race_number) === key && (!country || !r.country || normalizeCountryKey(r.country) === normalizeCountryKey(country))) || null;
}

function findRunnerFromCache(meeting, raceNumber, runnerName){
  const race = getRaceFromCache(meeting, raceNumber);
  if (!race || !runnerName) return null;
  const target = normalizeRunnerName(runnerName);
  if (!target) return null;
  return (race.runners || []).find(r => {
    const nm = normalizeRunnerName(r.name || r.runner_name || '');
    return nm === target || nm.includes(target) || target.includes(nm);
  }) || null;
}

function extractFormDigits(raw){
  return String(raw || '')
    .toUpperCase()
    .split('')
    .map(ch => {
      if (/[1-9]/.test(ch)) return Number(ch);
      if (ch === '0') return 10;
      return NaN;
    })
    .filter(Number.isFinite);
}

function entryIsTrial(start){
  if (!start || typeof start !== 'object') return false;
  const typeFields = [start.class, start.race_class, start.race_type, start.type];
  const boolFields = [start.trial, start.is_trial];
  if (typeFields.some(val => String(val || '').toLowerCase().includes('trial'))) return true;
  if (boolFields.some(val => {
    const raw = String(val || '').toLowerCase();
    return raw === 'true' || raw === '1';
  })) return true;
  return false;
}

function runnerHasStrongTrials(runner){
  if (!runner || !Array.isArray(runner.last_starts) || !runner.last_starts.length) return false;
  const trials = runner.last_starts.filter(entryIsTrial);
  if (!trials.length) return false;
  const hasOfficial = runner.last_starts.some(ls => !entryIsTrial(ls));
  if (hasOfficial) return false;
  const finishes = trials
    .map(ls => Number(ls?.finish))
    .filter(n => Number.isFinite(n) && n > 0);
  if (!finishes.length) return false;
  const wins = finishes.filter(v => v === 1).length;
  const podiums = finishes.filter(v => v <= 3).length;
  const avg = finishes.reduce((sum, val) => sum + val, 0) / finishes.length;
  if (wins >= 1) return true;
  if (podiums >= 2) return true;
  if (avg <= 3) return true;
  return false;
}

function runnerFormPlacings(runner){
  if (!runner) return [];
  if (Array.isArray(runner.last_starts) && runner.last_starts.length) {
    const finishes = runner.last_starts
      .filter(ls => !entryIsTrial(ls))
      .map(ls => Number(ls?.finish))
      .filter(n => Number.isFinite(n) && n > 0);
    if (finishes.length) return finishes;
  }
  const sources = [
    runner.last_five_starts,
    runner.last_four_starts,
    runner.last_twenty_starts,
    runner.form,
    runner.recent_form
  ];
  for (const source of sources) {
    if (!source) continue;
    if (Array.isArray(source)) {
      const nums = source
        .map(x => Number(x))
        .filter(n => Number.isFinite(n) && n > 0);
      if (nums.length) return nums;
      continue;
    }
    const digits = extractFormDigits(source);
    if (digits.length) return digits.reverse();
  }
  return [];
}

function runnerThreeStartAvg(runner){
  const placings = runnerFormPlacings(runner).slice(0, 3);
  if (!placings.length) return 10;
  const avg = placings.reduce((sum, v) => sum + v, 0) / placings.length;
  return avg === 0 ? avg + 10 : avg;
}

const formSignalCache = new WeakMap();

function runnerFormSignal(runner){
  if (!runner) return { status: 'UNKNOWN', legacy: 'UNKNOWN', summary: 'Form data unavailable', sample: '', recentLength: 0, formScore: 0, lastStart: null };
  if (formSignalCache.has(runner)) return formSignalCache.get(runner);
  const placements = runnerFormPlacings(runner);
  if (!placements.length) {
    const empty = { status: 'UNKNOWN', legacy: 'UNKNOWN', summary: 'Form data unavailable', sample: '', recentLength: 0, formScore: 0, lastStart: null };
    formSignalCache.set(runner, empty);
    return empty;
  }
  const recent = placements.slice(0, 6);
  const recent4 = placements.slice(0, 4);
  const recent3 = placements.slice(0, 3);
  const wins = recent.filter(v => v === 1).length;
  const podiums = recent.filter(v => v >= 1 && v <= 3).length;
  const top4 = recent.filter(v => v >= 1 && v <= 4).length;
  const top5 = recent.filter(v => v >= 1 && v <= 5).length;
  const avgFinish = recent.reduce((sum, val) => sum + val, 0) / recent.length;
  const winsLast4 = recent4.filter(v => v === 1).length;
  const recent3Podiums = recent3.filter(v => v <= 3).length;
  const recent5Top4 = placements.slice(0, 5).filter(v => v <= 4).length;
  const lastStart = Number.isFinite(recent[0]) ? recent[0] : null;
  let streakTop3 = 0;
  for (let i = 0; i < recent.length; i++) {
    if (recent[i] <= 3) streakTop3++;
    else break;
  }
  const finishPoints = (finish, idx) => {
    if (!Number.isFinite(finish) || finish <= 0) return 0;
    const base = finish === 1 ? 12
      : finish === 2 ? 9
      : finish === 3 ? 7
      : finish === 4 ? 4
      : finish === 5 ? 2
      : finish <= 7 ? 0
      : finish <= 10 ? -4
      : -7;
    const weights = [0.45, 0.25, 0.18, 0.12];
    return base * (weights[idx] || 0.08);
  };
  let formScore = placements.slice(0, 4).reduce((sum, finish, idx) => sum + finishPoints(finish, idx), 0);
  if (lastStart !== null && lastStart <= 3) formScore += 4;
  if (lastStart === 1) formScore += 3;
  if (lastStart !== null && lastStart >= 8) formScore -= 6;
  if (placements[0] >= 6 && placements[1] >= 6) formScore -= 4;
  if (placements[2] && placements[1] && placements[0] < placements[1] && placements[1] < placements[2]) formScore += 2;

  let status = 'COLD';
  const lastStartHotEligible = lastStart !== null && lastStart <= 3;
  const twoWinsIntoToday = recent.length >= 2 && recent[0] === 1 && recent[1] === 1;
  const twoStartSample = recent.length === 2;

  if (twoWinsIntoToday || (twoStartSample && wins >= 1)) {
    status = 'HOT';
  } else if (lastStartHotEligible && (winsLast4 >= 2 || recent3Podiums >= 2 || recent5Top4 >= 3) && formScore >= 12) {
    status = 'HOT';
  } else if ((lastStart !== null && lastStart <= 5 && (recent3Podiums >= 1 || top4 >= 2)) || formScore >= 5) {
    status = 'SOLID';
  } else if (podiums >= 1 || top5 >= 2 || avgFinish <= 6 || streakTop3 >= 2 || formScore >= -2) {
    status = 'MIXED';
  }
  if (lastStart !== null && lastStart > 3 && status === 'HOT' && !twoWinsIntoToday && !twoStartSample) status = 'SOLID';
  const recent4Podiums = recent4.filter(v => v <= 3).length;
  if (recent4Podiums === 0 && status === 'SOLID') status = 'MIXED';
  if (recent.length < 3) {
    if (recent.length === 1 && wins === 1) status = 'SOLID';
    if (recent.length === 2 && wins === 0 && podiums >= 1 && status === 'HOT') status = 'SOLID';
  }
  if (lastStart !== null && lastStart >= 8 && formScore < 5 && status !== 'COLD') status = 'MIXED';
  if (lastStart !== null && lastStart >= 9 && formScore < 0) status = 'COLD';
  const legacy = (status === 'HOT' || status === 'SOLID') ? 'GOOD'
    : (status === 'MIXED' ? 'MIXED' : (status === 'COLD' ? 'POOR' : 'UNKNOWN'));
  const sampleNote = recent.length < 3 ? ' · limited sample' : '';
  const hotGateNote = lastStart !== null && lastStart > 3 && !twoWinsIntoToday && !twoStartSample ? ' · last start missed HOT gate' : '';
  const summary = `${wins} win${wins === 1 ? '' : 's'}, ${podiums} podium${podiums === 1 ? '' : 's'} last ${recent.length} · avg finish ${avgFinish.toFixed(1)} · form ${formScore.toFixed(1)}${sampleNote}${hotGateNote}`;
  const sample = recent.map(v => (v >= 10 ? '0' : v)).join('');
  const details = { status, legacy, summary, wins, podiums, top5, avgFinish, streakTop3, sample, recentLength: recent.length, raw: placements, formScore, lastStart };
  formSignalCache.set(runner, details);
  return details;
}

function normalizeTrackBucket(track){
  const raw = String(track || '').toLowerCase().trim();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('heavy')) return 'HEAVY';
  if (raw.includes('soft') || raw.includes('slow')) return 'SOFT';
  if (raw.includes('firm')) return 'FIRM';
  if (raw.includes('good')) return 'GOOD';
  return 'UNKNOWN';
}

function normalizeBloodlineName(value){
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(aus|nz|ire|gb|usa|fr|jpn|ger|ity)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function recordWinPlaceScore(stats){
  if (!stats) return { score: 0, starts: 0, wins: 0, places: 0 };
  const starts = Number(stats.number_of_starts ?? stats.starts ?? 0);
  const wins = Number(stats.wins ?? 0);
  const places = Number(stats.places ?? stats.placings ?? 0);
  if (!Number.isFinite(starts) || starts <= 0) return { score: 0, starts: 0, wins: 0, places: 0 };
  const winRate = wins / starts;
  const placeRate = (wins + places) / starts;
  const avgFinish = Number(stats.average_finish ?? stats.avg_finish ?? NaN);
  let score = (winRate * 16) + (placeRate * 8);
  if (Number.isFinite(avgFinish)) score += Math.max(-4, Math.min(4, 6 - avgFinish));
  const shrink = starts / (starts + 3);
  return { score: score * shrink, starts, wins, places };
}

function runnerTrackPreferenceSignal(runner, race){
  const trackBucket = normalizeTrackBucket(race?.track_condition || race?.loveracing?.track_condition || '');
  const stats = runner?.stats || {};
  let statKey = 'overall';
  if (trackBucket === 'HEAVY') statKey = 'heavy';
  else if (trackBucket === 'SOFT') statKey = 'soft';
  else if (trackBucket === 'GOOD' || trackBucket === 'FIRM') statKey = 'good';
  const direct = recordWinPlaceScore(stats[statKey]);
  const fallback = direct.starts ? { score: 0, starts: 0 } : recordWinPlaceScore(stats.overall);
  const baseScore = direct.starts ? direct.score : (fallback.score * 0.35);
  const reliability = Math.max(0.2, Math.min(1, ((direct.starts || 0) + ((fallback.starts || 0) * 0.35)) / 6));
  const formSignal = runnerFormSignal(runner);
  let score = baseScore;
  if (trackBucket === 'HEAVY' && formSignal.lastStart !== null && formSignal.lastStart >= 8) score -= 1.5;
  if (trackBucket !== 'UNKNOWN' && formSignal.status === 'HOT') score += 1.5;
  if (trackBucket !== 'UNKNOWN' && formSignal.status === 'COLD') score -= 1.5;
  let label = 'NEUTRAL';
  if (score >= 8) label = 'LOVES THIS GROUND';
  else if (score >= 3) label = 'SUITED';
  else if (score <= -8) label = 'DISLIKES THIS GROUND';
  else if (score <= -3) label = 'QUERY';
  return { bucket: trackBucket, statKey, score, reliability, label, starts: direct.starts || fallback.starts || 0 };
}

function clampProbability(p){
  if (!Number.isFinite(p)) return NaN;
  return Math.max(0.02, Math.min(0.42, p));
}

const PEDIGREE_BLOODLINE_LIBRARY = {
  snitzel: { juvenile: 16, sprint: 14, wet: 5, slipper: 22, elite: 8 },
  'i am invincible': { juvenile: 14, sprint: 16, wet: 2, slipper: 8, elite: 8 },
  'written tycoon': { juvenile: 12, sprint: 12, wet: 2, slipper: 9, elite: 6 },
  'exceed and excel': { juvenile: 13, sprint: 11, wet: 2, slipper: 8, elite: 6 },
  zoustar: { juvenile: 12, sprint: 12, wet: 3, slipper: 8, elite: 7 },
  'fastnet rock': { juvenile: 9, sprint: 11, wet: 4, slipper: 7, elite: 8 },
  savvybeel: { juvenile: 5, sprint: 3, wet: 8, staying: 10, elite: 9 },
  savabeel: { juvenile: 5, sprint: 3, wet: 8, staying: 10, elite: 9 },
  'per incanto': { juvenile: 6, sprint: 9, wet: 6, elite: 5 },
  proisir: { juvenile: 5, sprint: 5, wet: 9, staying: 8, elite: 6 },
  tivaci: { juvenile: 5, sprint: 6, wet: 5, elite: 5 },
  ardrossan: { juvenile: 6, sprint: 8, wet: 4, elite: 5 },
  preferment: { juvenile: 2, sprint: 1, wet: 5, staying: 12, elite: 5 },
  belardo: { juvenile: 8, sprint: 8, wet: 4, elite: 5 },
  toronado: { juvenile: 6, sprint: 5, wet: 5, staying: 7, elite: 5 },
  'so you think': { juvenile: 3, sprint: 2, wet: 5, staying: 11, elite: 8 },
  'ocean park': { juvenile: 2, sprint: 1, wet: 8, staying: 12, elite: 6 }
};

const BLOODLINE_COMMENTARY_LIBRARY = {
  snitzel: {
    summary: 'Premium Australian speed/juvenile sire line. Strong precocity and high-pressure 2YO sprint profile.',
    strengths: ['2YO sprint precocity', 'Golden Slipper-style pressure races', 'sharp early speed'],
    cautions: ['not an automatic wet-track edge', 'must still fit map and setup'],
    style: 'Fast, professional, early-season quality.'
  },
  'i am invincible': {
    summary: 'Elite sprint sire line with strong commercial speed and broad open-sprint relevance.',
    strengths: ['open sprint quality', 'speed influence', 'commercial class'],
    cautions: ['not always the top Slipper-specific profile', 'wet profile can vary by cross'],
    style: 'Explosive speed, broad sprinting class.'
  },
  'written tycoon': {
    summary: 'Strong Australian speed/juvenile influence with genuine precocity and commercial sharpness.',
    strengths: ['juvenile sprinting', 'early speed', 'AUS speed races'],
    cautions: ['needs setup support at elite end'],
    style: 'Sharp, quick, precocious.'
  },
  'fastnet rock': {
    summary: 'Powerful Danehill-line source of class and versatility. Strong broodmare-sire relevance too.',
    strengths: ['class', 'versatility', 'important dam-sire cross influence'],
    cautions: ['less pure-precocity than specialist 2YO sprint sires'],
    style: 'Class, depth, and cross value.'
  },
  savabeel: {
    summary: 'Core NZ staying/wet-ground/class influence. Much stronger in NZ middle-distance and rain-affected setups than in raw juvenile speed tests.',
    strengths: ['wet tracks', 'middle distance', 'staying quality', 'NZ class profile'],
    cautions: ['not a natural pure-precocity sprint line'],
    style: 'Toughness, depth, and wet-ground resilience.'
  },
  proisir: {
    summary: 'NZ-oriented line with strong wet-track and middle-distance upside.',
    strengths: ['wet ground', 'middle-distance progression'],
    cautions: ['not a top-end Australian juvenile sprint default'],
    style: 'Progressive, rain-affected, durable.'
  },
  'per incanto': {
    summary: 'Useful NZ/AUS sprinting line with respectable wet-ground support.',
    strengths: ['open sprint races', 'NZ speed setups'],
    cautions: ['less dominant in elite juvenile races'],
    style: 'Sprinting utility with enough versatility.'
  }
};

function pedigreeBloodlineProfile(name){
  const key = normalizeBloodlineName(name || '');
  if (!key) return null;
  return PEDIGREE_BLOODLINE_LIBRARY[key] || null;
}

function bloodlineCommentaryProfile(name){
  const key = normalizeBloodlineName(name || '');
  if (!key) return null;
  return BLOODLINE_COMMENTARY_LIBRARY[key] || null;
}

function renderBloodlineButton(name, relation='Bloodline'){
  const label = String(name || '').trim();
  if (!label) return 'n/a';
  return `<button class='bloodline-profile-btn' data-bloodline='${escapeAttr(label)}' data-relation='${escapeAttr(relation)}'>${escapeHtml(label)}</button>`;
}

function openBloodlineProfile(bloodlineName, relation='Bloodline'){
  const label = String(bloodlineName || '').trim();
  if (!label) {
    openSummaryPopup('Bloodline Library', '<div>No bloodline selected.</div>');
    return;
  }
  const traits = pedigreeBloodlineProfile(label) || {};
  const notes = bloodlineCommentaryProfile(label) || {};
  const traitRows = Object.entries(traits || {}).map(([k,v]) => `<div><b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}</div>`).join('');
  const strengths = Array.isArray(notes.strengths) && notes.strengths.length ? `<li>${notes.strengths.map(x => escapeHtml(String(x))).join('</li><li>')}</li>` : '<li>No strength notes yet.</li>';
  const cautions = Array.isArray(notes.cautions) && notes.cautions.length ? `<li>${notes.cautions.map(x => escapeHtml(String(x))).join('</li><li>')}</li>` : '<li>No caution notes yet.</li>';
  const html = `<div class='bloodline-profile-modal'>
    <div class='sub' style='margin-bottom:10px'>${escapeHtml(relation)} lookup from the BETMAN bloodline library.</div>
    <div class='runner-grid'>
      <div><b>Bloodline:</b> ${escapeHtml(label)}</div>
      <div><b>Style:</b> ${escapeHtml(notes.style || 'No style note yet')}</div>
      <div><b>Summary:</b> ${escapeHtml(notes.summary || 'No commentary yet')}</div>
    </div>
    <div style='margin-top:12px'><b>Trait profile</b></div>
    <div class='runner-grid' style='margin-top:8px'>${traitRows || '<div>No trait profile in library yet.</div>'}</div>
    <div style='margin-top:12px'><b>Strengths</b></div>
    <ul>${strengths}</ul>
    <div style='margin-top:12px'><b>Cautions</b></div>
    <ul>${cautions}</ul>
  </div>`;
  openSummaryPopup(`${relation} — ${label}`, html);
}

function inferRacePedigreeDemand(race){
  const distance = Number(race?.distance || 0);
  const desc = String(race?.description || '').toLowerCase();
  const track = normalizeTrackBucket(race?.track_condition || race?.loveracing?.track_condition || '');
  const juvenile = /slipper|2yo|two-year|juvenile/.test(desc) ? 1.25 : (distance > 0 && distance <= 1200 ? 1.0 : 0.45);
  const sprint = distance > 0 && distance <= 1400 ? 1.0 : 0.35;
  const staying = distance >= 1800 ? 1.0 : 0.1;
  const slipper = /golden slipper/.test(desc) ? 1.35 : (/slipper/.test(desc) ? 1.15 : 0);
  const wet = track === 'HEAVY' ? 1.0 : (track === 'SOFT' ? 0.65 : 0.15);
  const elite = /group 1|g1|group 2|g2|listed|classic|slipper/.test(desc) ? 0.8 : 0.35;
  return { juvenile, sprint, staying, slipper, wet, elite };
}

function pedigreeComponentScore(name, demand){
  const profile = pedigreeBloodlineProfile(name);
  if (!profile) return { score: 0, confidence: 0, known: false };
  const score =
    (profile.juvenile || 0) * (demand.juvenile || 0) +
    (profile.sprint || 0) * (demand.sprint || 0) +
    (profile.staying || 0) * (demand.staying || 0) +
    (profile.slipper || 0) * (demand.slipper || 0) +
    (profile.wet || 0) * (demand.wet || 0) +
    (profile.elite || 0) * (demand.elite || 0);
  const confidence = 0.55 + (Object.keys(profile).length * 0.05);
  return { score, confidence: Math.min(0.95, confidence), known: true };
}

function runnerPedigreeSignal(runner, race){
  const demand = inferRacePedigreeDemand(race);
  const sire = pedigreeComponentScore(runner?.sire, demand);
  const damSire = pedigreeComponentScore(runner?.dam_sire || runner?.damSire, demand);
  const dam = pedigreeComponentScore(runner?.dam, demand);
  const crossBoost = sire.known && damSire.known ? Math.min(6, Math.max(0, (sire.score + damSire.score) * 0.08)) : 0;
  const total = (sire.score * 0.45) + (dam.score * 0.18) + (damSire.score * 0.27) + crossBoost;
  const weightedConfidence = (sire.confidence * 0.45) + (dam.confidence * 0.18) + (damSire.confidence * 0.27) + ((crossBoost ? 0.1 : 0));
  const primaryConfidence = Math.max(
    sire.known ? sire.confidence * 0.82 : 0,
    damSire.known ? damSire.confidence * 0.72 : 0,
    crossBoost ? 0.68 : 0
  );
  const confidence = Math.max(0.2, Math.min(0.95, Math.max(weightedConfidence, primaryConfidence)));
  return {
    score: total,
    confidence,
    sireKnown: sire.known,
    damKnown: dam.known,
    damSireKnown: damSire.known,
    summary: `Pedigree ${total.toFixed(1)} · sire ${runner?.sire || 'n/a'} · dam ${runner?.dam || 'n/a'} · dam sire ${runner?.dam_sire || runner?.damSire || 'n/a'}`
  };
}

function computeRacePedigreeAdvantageMap(race, runners){
  const entries = (runners || []).map(r => ({
    runner: r,
    key: normalizeRunnerName(r?.name || r?.runner_name || ''),
    signal: runnerPedigreeSignal(r, race)
  })).filter(x => x.key);
  if (!entries.length) return new Map();
  const scores = entries.map(x => x.signal.score).filter(Number.isFinite);
  const avg = scores.length ? scores.reduce((a,b)=>a+b,0) / scores.length : 0;
  const top = scores.length ? Math.max(...scores) : 0;
  const qualified = entries.filter(x => {
    const eliteCompactField = top >= 40 && (top - x.signal.score) <= 1.5;
    const clearFieldEdge = (x.signal.score - avg) >= 6 && (top - x.signal.score) <= 3.0;
    return x.signal.score >= 24 && (x.signal.confidence * 100) >= 55 && (clearFieldEdge || eliteCompactField);
  });
  return new Map(entries.map(x => [x.key, {
    ...x.signal,
    relativeEdge: x.signal.score - avg,
    qualifies: qualified.some(q => q.key === x.key),
    topScore: top,
    averageScore: avg
  }]));
}

function runnerConfidenceBlend(runner, race, rawProb){
  const marketOdds = runnerOddsValue(runner);
  const marketProb = Number.isFinite(marketOdds) && marketOdds > 0 ? (1 / marketOdds) : rawProb;
  const formSignal = runnerFormSignal(runner);
  const trackSignal = runnerTrackPreferenceSignal(runner, race);
  const hasSectionals = Array.isArray(runner?.last_starts) && runner.last_starts.some(start => start?.last_600 || start?.last600 || start?.lastSixHundred);
  const hasMap = !!runner?.speedmap;
  const hasStats = !!(runner?.stats?.overall || runner?.stats?.soft || runner?.stats?.heavy || runner?.stats?.good);
  let confidence = 0.35;
  if (hasStats) confidence += 0.15;
  if (hasSectionals) confidence += 0.10;
  if (hasMap) confidence += 0.10;
  if (formSignal.recentLength >= 4) confidence += 0.10;
  confidence += Math.min(0.15, trackSignal.reliability * 0.15);
  confidence = Math.max(0.25, Math.min(0.8, confidence));
  const blended = (rawProb * confidence) + (marketProb * (1 - confidence));
  const trackAdj = Math.max(-0.025, Math.min(0.025, (trackSignal.score / 100) * (0.5 + trackSignal.reliability * 0.5)));
  return {
    confidence,
    marketProb,
    finalProb: clampProbability(blended + trackAdj),
    trackSignal
  };
}

function runnerFormStatus(runner){
  return runnerFormSignal(runner).legacy;
}

function describeFormSignal(signal){
  if (!signal) return '';
  const labelMap = {
    HOT: 'HOT FORM',
    SOLID: 'SOLID FORM',
    MIXED: 'MIXED FORM',
    COLD: 'COLD FORM'
  };
  const label = signal.status && signal.status !== 'UNKNOWN'
    ? (labelMap[signal.status] || `${signal.status} FORM`)
    : (signal.legacy && signal.legacy !== 'UNKNOWN' ? `${signal.legacy} FORM` : '');
  const parts = [];
  if (label) parts.push(label);
  if (signal.summary) parts.push(signal.summary);
  return parts.join(' · ');
}

function renderFormStatusTag(statusOrSignal, summary=''){
  if (!statusOrSignal) return '';
  const signalObj = (typeof statusOrSignal === 'object' && statusOrSignal !== null) ? statusOrSignal : null;
  const status = signalObj?.status && signalObj.status !== 'UNKNOWN' ? signalObj.status : null;
  const legacy = signalObj?.legacy && signalObj.legacy !== 'UNKNOWN' ? signalObj.legacy : null;
  const note = summary || signalObj?.summary || '';
  const key = status || statusOrSignal;
  const map = {
    HOT: { cls: 'tag form-hot', label: 'HOT FORM' },
    SOLID: { cls: 'tag form-solid', label: 'SOLID FORM' },
    MIXED: { cls: 'tag form-mixed', label: 'MIXED FORM' },
    COLD: { cls: 'tag form-cold', label: 'COLD FORM' },
    GOOD: { cls: 'tag form-good', label: 'GOOD FORM' },
    POOR: { cls: 'tag form-poor', label: 'POOR FORM' }
  };
  const entry = map[key] || map[legacy];
  if (!entry) return '';
  const titleAttr = note ? ` title='${escapeAttr(note)}'` : '';
  return `<span class='${entry.cls}'${titleAttr}>${entry.label}</span>`;
}

function rowFormSignal(row){
  if (!row) return null;
  const runner = findRunnerFromCache(row.meeting, row.race || row.race_number, row.runner || row.selection || row.name);
  if (!runner) return null;
  return runnerFormSignal(runner);
}

function rowFormStatus(row){
  const signal = rowFormSignal(row);
  return signal ? signal.legacy : 'UNKNOWN';
}

function extractRowOdds(row){
  if (!row) return NaN;
  const candidates = [
    row.odds,
    row.price,
    row.fixed_win,
    row.tote_win,
    row.toOdds,
    row.fromOdds
  ];
  for (const candidate of candidates) {
    const val = Number(candidate);
    if (Number.isFinite(val) && val > 0) return val;
  }
  const reasonOdds = parseReasonOdds(row.reason);
  if (Number.isFinite(reasonOdds) && reasonOdds > 0) return reasonOdds;
  return NaN;
}

function runnerOddsValue(runner){
  if (!runner) return NaN;
  const candidates = [
    runner.odds,
    runner.fixed_win,
    runner.tote_win,
    runner.price,
    runner.win_fixed,
    runner.win_tote
  ];
  for (const candidate of candidates) {
    const val = Number(candidate);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return NaN;
}

function rowRunnerKey(row){
  if (!row) return '';
  return normalizeRunnerName(cleanRunnerText(row.runner || row.selection || row.name || ''));
}

function getRaceDominantFavKey(race){
  if (!race) return null;
  const entries = (race.runners || [])
    .map(r => ({ key: normalizeRunnerName(r.name || r.runner_name || ''), odds: runnerOddsValue(r) }))
    .filter(entry => entry.key && Number.isFinite(entry.odds) && entry.odds > 0)
    .sort((a,b) => {
      if (a.odds !== b.odds) return a.odds - b.odds;
      return a.key.localeCompare(b.key);
    });
  if (!entries.length || entries[0].odds > 3.6) return null;
  return entries[0].key;
}

function rowIsDominantFav(row){
  const runnerKey = rowRunnerKey(row);
  if (!runnerKey) return false;
  const race = getRaceFromCache(row.meeting, row.race || row.race_number);
  if (!race) return false;
  const favKey = getRaceDominantFavKey(race);
  return favKey === runnerKey;
}

function rowMatchesLongProfile(row){
  const odds = extractRowOdds(row);
  if (!Number.isFinite(odds) || odds < 8) return false;
  const signal = rowFormSignal(row);
  if (signal && (signal.status === 'HOT' || signal.status === 'SOLID' || signal.legacy === 'GOOD')) return true;
  const race = lookupRace(row.meeting, row.race || row.race_number);
  const region = String(race?.country || race?.region || row?.country || '').trim().toUpperCase();
  if (region === 'HK') return true;
  return false;
}

function rowHasValueEdge(row){
  if (!row) return false;
  const winProb = parseReasonWinProb(row.reason);
  const odds = extractRowOdds(row);
  if (!Number.isFinite(winProb) || !Number.isFinite(odds) || odds <= 0) return false;
  const implied = 100 / odds;
  const edge = winProb - implied;
  return edge >= 1.5;
}

function sanitizeRunnerObject(r){
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  if ('name' in out) out.name = cleanRunnerText(out.name);
  if ('runner_name' in out) out.runner_name = cleanRunnerText(out.runner_name);
  return out;
}

function sanitizeRaceObject(r){
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  if (Array.isArray(out.runners)) out.runners = out.runners.map(sanitizeRunnerObject);
  return out;
}

function confidenceSignalPct(row){
  const fromAi = Number(row?.aiWinProb);
  if (Number.isFinite(fromAi) && fromAi > 0) return fromAi;
  const fromReason = parseReasonWinProb(row?.reason);
  return Number.isFinite(fromReason) ? fromReason : null;
}

function isConfidenceBoostCandidate(row){
  const t = String(row?.type || '').toLowerCase();
  if (['top2','top3','top4','trifecta','multi'].includes(t)) return false;
  const p = confidenceSignalPct(row);
  return Number.isFinite(p) && p >= confidenceSignalThreshold;
}

function sanitizeSuggestedRow(x){
  if (!x || typeof x !== 'object') return x;
  const out = { ...x };
  if ('selection' in out) out.selection = cleanRunnerText(out.selection);
  if ('runner' in out) out.runner = cleanRunnerText(out.runner);
  if ('type' in out) {
    const rawType = String(out.type || '').trim().toLowerCase();
    if (['ew','e/w','eachway','each-way','each way'].includes(rawType)) out.type = 'ew';
    else if (['w','win'].includes(rawType)) out.type = 'win';
    else if (['top 2','top2'].includes(rawType)) out.type = 'top2';
    else if (['top 3','top3'].includes(rawType)) out.type = 'top3';
    else if (['top 4','top4'].includes(rawType)) out.type = 'top4';
    else out.type = rawType;
  }

  const baseStake = Number(out.stake || 0);
  out.baseStake = Number.isFinite(baseStake) ? baseStake : 0;
  out.confidenceSignalPct = confidenceSignalPct(out);
  out.confidenceBoost = isConfidenceBoostCandidate(out);
  out.stakeBoostMultiplier = 1;
  if (!out.capitalTier) {
    if (String(out.recommendedAction || '').toUpperCase() === 'BET_NOW') out.capitalTier = 'bet_now';
    else if (String(out.recommendedAction || '').toUpperCase() === 'QUEUE') out.capitalTier = 'queue';
    else if (out.interesting || String(out.recommendedAction || '').toUpperCase() === 'WATCH') out.capitalTier = 'watchlist';
    else out.capitalTier = 'blocked';
  }
  if (!out.capitalIntent) {
    out.capitalIntent = out.capitalTier === 'bet_now' ? 'Bet Now'
      : out.capitalTier === 'queue' ? 'Queue'
      : out.capitalTier === 'watchlist' ? 'Watchlist'
      : 'Blocked';
  }
  return out;
}

function runnerLabel(r){
  return cleanRunnerText(r?.name || r?.runner_name || '');
}

function buildAIPlan(race){
  const runners = (race.runners||[]).filter(r=>r.odds).sort((a,b)=>a.odds-b.odds);
  if (!runners.length) return null;
  const top1 = runners[0];
  const top2 = runners[1];
  const n1 = runnerLabel(top1);
  const n2 = runnerLabel(top2);
  const standout = top2 && (1/top1.odds) >= 0.35 && (1/top1.odds) >= 1.8*(1/top2.odds);
  if (standout || !top2) {
    return { summary: `Win $${stakePerRace} on ${n1}`, bets: [{ selection: n1, stake: stakePerRace, type: 'Win' }] };
  }
  const s1 = Math.round(stakePerRace*0.6*100)/100;
  const s2 = Math.round((stakePerRace - s1)*100)/100;
  return { summary: `Split $${s1} ${n1}, $${s2} ${n2}`, bets: [{ selection: n1, stake: s1, type: 'Win' }, { selection: n2, stake: s2, type: 'Win' }] };
}

function parseOddsFromReason(reason){
  const m = String(reason || '').match(/@\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : NaN;
}

function buildAIMultiPlan(race, legCount = 2){
  const targetLegs = Math.max(2, Math.min(4, Number(legCount || 2)));
  const isWin = (x) => String(x.type || '').toLowerCase() === 'win';
  const nonMulti = (latestSuggestedBets || []).filter(x => isWin(x));
  const upcomingWinRows = nonMulti.filter(selectionIsUpcoming);
  const raceKey = `${String(race.meeting)}|${String(race.race_number)}`;

  const parseWinOdds = (row) => {
    const fromReason = parseOddsFromReason(row?.reason);
    if (Number.isFinite(fromReason) && fromReason > 0) return fromReason;
    const fromProb = Number(row?.aiWinProb);
    if (Number.isFinite(fromProb) && fromProb > 0) return 100 / fromProb;
    return NaN;
  };

  // Leg 1: selected race top Win suggestion if available, else market favourite of selected race.
  const leg1Suggested = upcomingWinRows.find(x => `${x.meeting}|${x.race}` === raceKey);
  let leg1 = null;
  if (leg1Suggested) {
    const o = parseWinOdds(leg1Suggested);
    leg1 = { meeting: leg1Suggested.meeting, race: leg1Suggested.race, selection: leg1Suggested.selection, odds: Number.isFinite(o) ? o : null };
  } else {
    const fav = (race.runners || []).filter(r => Number(r.odds) > 0).sort((a,b)=>Number(a.odds)-Number(b.odds))[0];
    if (fav) leg1 = { meeting: race.meeting, race: race.race_number, selection: runnerLabel(fav), odds: Number(fav.odds) };
  }
  if (!leg1 || !(Number(leg1.odds) > 0)) return null;

  const usedRaces = new Set([`${leg1.meeting}|${leg1.race}`]);
  const legs = [leg1];

  const candidates = upcomingWinRows
    .filter(x => !usedRaces.has(`${x.meeting}|${x.race}`))
    .map(x => {
      const o = parseWinOdds(x);
      return { meeting: x.meeting, race: x.race, selection: x.selection, odds: Number.isFinite(o) ? o : null, jumpsIn: x.jumpsIn || '' };
    })
    .filter(x => Number(x.odds) > 0)
    .sort((a,b) => jumpsInToMinutes(a.jumpsIn) - jumpsInToMinutes(b.jumpsIn));

  for (const c of candidates) {
    if (legs.length >= targetLegs) break;
    const rk = `${c.meeting}|${c.race}`;
    if (usedRaces.has(rk)) continue;
    legs.push({ meeting: c.meeting, race: c.race, selection: c.selection, odds: c.odds });
    usedRaces.add(rk);
  }

  if (legs.length < targetLegs) return null;

  const estMultiOdds = Math.round(legs.reduce((acc, l) => acc * Number(l.odds), 1) * 100) / 100;
  const calc = `${legs.map(l => Number(l.odds).toFixed(2)).join(' × ')} = ${estMultiOdds.toFixed(2)}`;
  return {
    stake: 1,
    type: `${targetLegs}-Race Multi`,
    legs,
    estMultiOdds,
    calc,
    selectionLabel: legs.map(l => l.selection).join(' x ')
  };
}

function buildRunnerSignalTags(race, runner, featured){
  const labels = new Set();
  if (!race || !runner) return [];
  const runnerName = runner.name || runner.runner_name || '';
  const interestingRow = findInterestingRow(race.meeting, race.race_number, runnerName);
  if (featured?.interesting || interestingRow) labels.add('interesting');
  const moverRow = findMoverRow(race.meeting, race.race_number, runnerName);
  if (moverRow) {
    const move = Number(moverRow.pctMove ?? moverRow.change5m ?? moverRow.change1m ?? moverRow.change30m ?? moverRow.change1h ?? moverRow.change5h ?? 0);
    if (Number.isFinite(move) && move !== 0) {
      const magnitude = Math.abs(move).toFixed(1);
      labels.add(move < 0 ? `firming ${magnitude}%` : `drifting ${magnitude}%`);
    }
  }
  if (featured) {
    const t = String(featured.type || '').toLowerCase();
    const p = parseReasonWinProb(featured.reason);
    const o = parseReasonOdds(featured.reason);
    const reasonLc = String(featured.reason || '').toLowerCase();
    const exotic = ['top2','top3','top4','trifecta','multi'].includes(t);
    if (exotic) labels.add('exotic');
    const sigRaw = Number(featured.signal_score);
    const sig = Number.isFinite(sigRaw) ? sigRaw : signalScore(featured.reason, t, featured.selection || featured.runner || '');
    if (!exotic && Number.isFinite(sig) && sig >= 60) labels.add('strong');
    if (!exotic && (t === 'ew' || (Number.isFinite(o) && o >= 5) || (Number.isFinite(p) && p < 20) || reasonLc.includes('value') || reasonLc.includes('long-odds'))) labels.add('value');
  }
  return Array.from(labels);
}

function renderHorseAnalysis(race, runner){
  const trackedBet = findTrackedBet(race?.meeting, race?.race_number || race?.race, runner?.name || runner?.runner_name || runner?.selection || '');
  const ro = Number(runner?.odds || runner?.fixed_win || runner?.tote_win || 0);
  const p = ro > 0 ? (100/ro) : null;
  const raceRows = (latestSuggestedBets || []).filter(x =>
    String(x.meeting || '').trim().toLowerCase() === String(race.meeting || '').trim().toLowerCase() &&
    String(x.race || '') === String(race.race_number || '')
  );
  const runnerNorm = normalizeRunnerName(runner.name || runner.runner_name || '');
  const normalizeMeetingKey = (val) => String(val || '').trim().toLowerCase();
  const analysisContext = (latestAnalysisSignals && normalizeMeetingKey(latestAnalysisSignals.meeting) === normalizeMeetingKey(race.meeting) && String(latestAnalysisSignals.race || '').trim() === String(race.race_number || race.race || '').trim()) ? latestAnalysisSignals : null;
  const aiWinKey = analysisContext?.winRunner ? normalizeRunnerName(analysisContext.winRunner) : '';
  const aiEwKey = analysisContext?.ewRunner ? normalizeRunnerName(analysisContext.ewRunner) : '';
  const aiSimKey = analysisContext?.aiRunner ? normalizeRunnerName(analysisContext.aiRunner) : '';
  const featured = raceRows.find(x => normalizeRunnerName(x.selection || x.runner || '') === runnerNorm);
  let call = 'Pass (not a featured model candidate in this race).';
  if (featured) {
    const t = String(featured.type || '').toLowerCase();
    if (t === 'win') call = 'Featured: Win candidate.';
    else if (t === 'ew') call = 'Featured: EW/Value candidate.';
    else call = `Featured: ${featured.type || 'candidate'}.`;
  } else if (analysisContext) {
    if (aiWinKey && aiWinKey === runnerNorm) {
      call = 'AI Engine pick: Win candidate from latest analysis.';
    } else if (aiEwKey && aiEwKey === runnerNorm) {
      call = 'AI Engine pick: EW/value candidate from latest analysis.';
    } else if (aiSimKey && aiSimKey === runnerNorm) {
      call = 'AI Engine pick: Simulation leader from latest analysis.';
    }
  }

  const callTagSet = new Set(buildRunnerSignalTags(race, runner, featured));
  if (aiWinKey && aiWinKey === runnerNorm) callTagSet.add('ai-win');
  if (aiEwKey && aiEwKey === runnerNorm) callTagSet.add('ai-ew');
  if (aiSimKey && aiSimKey === runnerNorm) callTagSet.add('ai-sim');
  const callTags = Array.from(callTagSet);
  if (callTags.length) call += ` Tags: ${callTags.join(', ')}.`;

  const silk = runner.silk_url_128x128 || runner.silk_url_64x64 || '';
  const silkImg = silk ? `<img class='silk-img' src='${silk}' alt='Silks for ${escapeHtml(runner.name || '')}' />` : '';
  const stats = runner.stats || {};
  const formatLastStart = (ls = {}) => {
    const date = escapeHtml(ls.date || '—');
    const track = escapeHtml(ls.track || ls.track_four_char || '—');
    const distance = ls.distance ? escapeHtml(String(ls.distance)) : '—';
    const isTrial = entryIsTrial(ls);
    const classRaw = String(ls.class || ls.race_class || (isTrial ? 'Trial' : 'Race'));
    const classLabel = escapeHtml(classRaw);
    const finishRaw = String(ls.finish || '').trim();
    const finishLabel = finishRaw ? `${finishRaw}${ls.number_of_runners ? ' / ' + ls.number_of_runners : ''}` : (ls.number_of_runners ? `— / ${ls.number_of_runners}` : '—');
    const margin = escapeHtml(ls.margin || ls.margin_1st_2nd || ls.margin_2nd_3rd || '—');
    const finishPos = Number.parseInt(finishRaw, 10);
    const rival = finishPos === 1 ? ls.second : ls.winner;
    const rivalNote = rival ? ` ${finishPos === 1 ? 'over' : 'behind'} ${escapeHtml(rival)}` : '';
    const jockey = escapeHtml(ls.jockey || '—');
    const sp = ls.starting_price ? `$${ls.starting_price}` : 'n/a';
    const trackCond = escapeHtml(ls.track_condition || 'n/a');
    const headerBits = [`<b>${date} · ${track} (${distance}m)</b>`];
    const hasTrialInClass = /trial/i.test(classRaw);
    if (classLabel) headerBits.push(`<span class='start-badge'>${classLabel}${isTrial && !hasTrialInClass ? ' · Trial' : ''}</span>`);
    return `<div class='last-start-row'><div>${headerBits.join(' ')}</div><div>Finish: ${escapeHtml(finishLabel)} · Margin: ${margin}${rivalNote}</div><div>Jockey: ${jockey} · SP ${sp} · Track ${trackCond}</div></div>`;
  };
  const lastStartsList = Array.isArray(runner.last_starts) ? runner.last_starts.slice(0,5) : [];
  const lastStartsSection = lastStartsList.length
    ? `<div class='analysis-block last-starts'><b>Recent Runs</b>${lastStartsList.map(formatLastStart).join('')}</div>`
    : '';
  const formSignal = runnerFormSignal(runner);
  const formStatusTag = renderFormStatusTag(formSignal, formSignal?.summary);
  const formLine = `${runner.last_twenty_starts || 'n/a'}${formSignal?.summary ? ` (${formSignal.summary})` : ''}`;
  const fmt = (obj) => obj ? `${obj.number_of_starts || 0}-${obj.number_of_wins || 0}-${(obj.number_of_seconds || 0) + (obj.number_of_thirds || 0)}` : '—';
  const horseName = escapeHtml(runner.name || runner.runner_name || '—');
  const runnerNo = escapeHtml(runner.runner_number || '—');
  const raceMeeting = escapeHtml(race.meeting || '—');
  const raceNo = escapeHtml(race.race_number || race.race || '—');
  const raceDistance = escapeHtml(race.distance || '—');
  const trackCond = escapeHtml(race.track_condition || 'n/a');
  const barrierText = escapeHtml(runner.barrier || '—');
  const jockeyText = escapeHtml(runner.jockey || '—');
  const trainerText = escapeHtml(runner.trainer || '—');
  const weightText = escapeHtml(runner.weight || runner.weight_total || runner.weight_allocated || '—');
  const speedText = escapeHtml(runner.speedmap || 'n/a');
  const breedingText = `${escapeHtml(runner.sire || '—')} · ${escapeHtml(runner.dam || '—')} · ${escapeHtml(runner.dam_sire || '—')}`;
  const ageSexText = `${escapeHtml(runner.age || '—')}${runner.sex ? `/${escapeHtml(runner.sex)}` : ''}`;
  const colourText = escapeHtml(runner.colour || '—');
  const trainerLocText = escapeHtml(runner.trainer_location || '—');
  const ownersText = escapeHtml(runner.owners || '—');
  return `
    <div class='horse-summary'>
      <div class='horse-silk'>${silkImg}</div>
      <div>
        <div><b>Horse:</b> ${horseName} (#${runnerNo})</div>
        <div><b>Race:</b> ${raceMeeting} R${raceNo} · ${raceDistance}m · ${trackCond}</div>
        <div><b>Barrier:</b> ${barrierText} · <b>Jockey:</b> ${jockeyText} · <b>Trainer:</b> ${trainerText}</div>
        <div><b>Weight:</b> ${weightText} · <b>Form:</b> ${formLine} ${formStatusTag || ''} · <b>Speed:</b> ${speedText}</div>
      </div>
    </div>
    <div class='horse-meta'>
      <div><b>Breeding:</b> ${breedingText}</div>
      <div><b>Gear:</b> ${formatGearText(runner.gear)} · <b>Age/Sex:</b> ${ageSexText} · <b>Colour:</b> ${colourText}</div>
      <div><b>Trainer loc:</b> ${trainerLocText} · <b>Owners:</b> ${ownersText}</div>
      <div><b>Silks:</b> ${runner.silk_colours || '—'}</div>
    </div>
    <div class='btn-row' style='margin-top:12px'>
      ${buildTrackRunnerButtonsHtml(race, runner, trackedBet)}
    </div>
    <table>
      <tr><th>Odds</th><th>Implied Win%</th><th>Track</th><th>Distance</th><th>Track Cond</th><th>1st Up</th><th>2nd Up</th></tr>
      <tr>
        <td>${runner.odds || 'n/a'}</td>
        <td>${p ? p.toFixed(1)+'%' : 'n/a'}</td>
        <td>${fmt(stats.track || stats.track_distance)}</td>
        <td>${fmt(stats.distance)}</td>
        <td>${fmt(stats.good || stats.soft || stats.heavy)}</td>
        <td>${fmt(stats.first_up)}</td>
        <td>${fmt(stats.second_up)}</td>
      </tr>
    </table>
    ${lastStartsSection}
    <div style='margin-top:8px'><b>Call:</b> ${call}</div>
  `;
}

function normalizeRaceNumber(value){
  return String(value || '').replace(/^R/i,'').trim();
}

function getSuggestedWinForRace(race){
  if (!race) return null;
  const meetingKey = String(race.meeting || '').trim().toLowerCase();
  const raceNumber = normalizeRaceNumber(race.race_number || race.race);
  const pool = (latestSuggestedBets || []).filter(x =>
    String(x.meeting || '').trim().toLowerCase() === meetingKey &&
    normalizeRaceNumber(x.race) === raceNumber &&
    String(x.type || '').toLowerCase() === 'win'
  );
  let rows = pool;
  if (!rows.length && Array.isArray(latestFilteredSuggested) && latestFilteredSuggested.length) {
    rows = latestFilteredSuggested.filter(x =>
      String(x.meeting || '').trim().toLowerCase() === meetingKey &&
      normalizeRaceNumber(x.race) === raceNumber &&
      String(x.type || '').toLowerCase() === 'win'
    );
  }
  if (!rows.length) return null;
  rows.sort((a,b)=> Number(b.stake || 0) - Number(a.stake || 0));
  return rows[0];
}

function attachAnalysisSelectionHandlers(race){
  document.querySelectorAll('.analysis-drag-btn').forEach(btn=>{
    btn.onclick = () => {
      const selRaw = String(btn.dataset.selection || '');
      const selNorm = normalizeRunnerName(selRaw.replace(/^\d+\.\s*/, '').trim());
      const runner = (race?.runners || []).find(x => {
        const nm = normalizeRunnerName(String(x.name || x.runner_name || '').trim());
        return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
      });
      if (!runner) return;
      openSummaryPopup(`${race.meeting} R${race.race_number} — ${runner.name || runner.runner_name}`, renderHorseAnalysis(race, runner));
      bindTrackRunnerButtons(race);
    };
  });

  document.querySelectorAll('.analysis-odds-runner-btn').forEach(btn => {
    btn.onclick = () => {
      const selRaw = String(btn.dataset.runner || '').trim();
      if (!selRaw) return;
      const selNorm = normalizeRunnerName(selRaw.replace(/^\d+\.\s*/, ''));
      const runner = (race?.runners || []).find(x => {
        const nm = normalizeRunnerName(String(x.name || x.runner_name || '').trim());
        return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
      });
      if (!runner) return;
      openSummaryPopup(`${race.meeting} R${race.race_number} — ${runner.name || runner.runner_name}`, renderHorseAnalysis(race, runner));
      bindTrackRunnerButtons(race);
    };
  });

  bindTrackRunnerButtons(race);

  document.querySelectorAll('[data-launch-ai]').forEach(btn => {
    btn.onclick = async () => {
      if (!selectedRace) {
        await loadRaces();
        const selectedCard = document.querySelector('.race-card.selected');
        if (selectedCard) await selectRace(selectedCard.dataset.key, selectedCard.dataset.meeting, selectedCard.dataset.race);
      }
      if (!selectedRace) {
        alert('Select a race first.');
        return;
      }
      analysisViewMode = analysisViewMode === 'engine' ? 'race' : 'engine';
      $('analysisBody').innerHTML = renderAnalysis(selectedRace, analysisViewMode);
      updateAnalysisAiModelNote();
      attachAnalysisSelectionHandlers(selectedRace);
      makeSelectionsDraggable();
      ensureAiAnswerHost();
      if (analysisViewMode === 'engine') {
        if (!renderCachedAiAnalysisIfPresent(selectedRace)) {
          clearAiAnswerPanel();
        }
      } else {
        clearAiAnswerPanel();
      }
      updateAnalysisToggleLabel();
    };
  });

  const watchRaceBtn = $('analysisWatchRaceBtn');
  if (watchRaceBtn) {
    watchRaceBtn.textContent = 'Track Race';
    watchRaceBtn.onclick = async () => {
      if (!selectedRace) return alert('Select a race first.');
      await openTrackRaceChooser(selectedRace, {
        title: `${selectedRace.meeting} R${selectedRace.race_number} — Track Race`,
        sourcePrefix: 'web-analysis-race-track',
        notes: {
          win: 'Track all runners in race from analysis',
          watch: 'Watch race from analysis'
        }
      });
    };
  }

  const trackAllBtn = $('analysisTrackAllRunnersBtn');
  if (trackAllBtn) {
    trackAllBtn.style.display = 'none';
  }

  const speedToggle = $('analysisSpeedToggle');
  if (speedToggle) {
    speedToggle.onclick = async () => {
      if (!selectedRace) {
        await loadRaces();
        const selectedCard = document.querySelector('.race-card.selected');
        if (selectedCard) await selectRace(selectedCard.dataset.key, selectedCard.dataset.meeting, selectedCard.dataset.race);
      }
      if (!selectedRace) {
        alert('Select a race first.');
        return;
      }
      analysisViewMode = analysisViewMode === 'speed' ? 'engine' : 'speed';
      $('analysisBody').innerHTML = renderAnalysis(selectedRace, analysisViewMode);
      updateAnalysisAiModelNote();
      attachAnalysisSelectionHandlers(selectedRace);
      makeSelectionsDraggable();
      clearAiAnswerPanel();
      updateAnalysisToggleLabel();
    };
  }

  renderAiModelSelect();
  bindAiAnalyseButton();
  bindPollOddsButton();
  updateAnalysisToggleLabel();
}

function bindTrackRunnerButtons(race){
  document.querySelectorAll('.track-runner-btn').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const selRaw = String(btn.dataset.runner || '').trim();
      if (!selRaw) return;
      const selNorm = normalizeRunnerName(selRaw.replace(/^\d+\.\s*/, ''));
      const runner = (race?.runners || []).find(x => {
        const nm = normalizeRunnerName(String(x.name || x.runner_name || x.selection || '').trim());
        return nm === selNorm || nm.includes(selNorm) || selNorm.includes(nm);
      });
      if (!runner) return;
      const reopenRunnerModal = () => {
        openSummaryPopup(`${race.meeting} R${race.race_number} — ${runner.name || runner.runner_name}`, renderHorseAnalysis(race, runner));
        bindTrackRunnerButtons(race);
      };
      if (!btn.classList.contains('is-tracked')) {
        openSummaryPopup(`${race.meeting} R${race.race_number} — ${runner.name || runner.runner_name}`, buildTrackTypeChooserHtml({
          heading: 'Track this runner',
          subheading: `${cleanRunnerText(runner.name || runner.runner_name || selRaw)} · choose the tracked mode.`,
          choices: [
            { value: 'Win', label: 'Win' },
            { value: 'Place', label: 'Place' },
            { value: 'Each Way', label: 'Each Way' },
            { value: 'Watch', label: 'Watch' }
          ]
        }));
        bindTrackTypeChooser(async (choice, choiceBtn) => {
          choiceBtn.disabled = true;
          const outcome = await toggleTrackedRunner(race, runner, {
            betType: choice,
            source: String(choice || '').toLowerCase() === 'watch' ? 'web-watch-runner' : 'web-runner',
            note: String(choice || '').toLowerCase() === 'watch' ? 'Watch runner from analysis' : null
          }).catch(() => null);
          if (!outcome) return;
          reopenRunnerModal();
        });
        return;
      }
      const betType = String(btn.dataset.trackBetType || 'Win').trim() || 'Win';
      const outcome = await toggleTrackedRunner(race, runner, { betType, source: betType.toLowerCase() === 'watch' ? 'web-watch-runner' : 'web-runner', note: betType.toLowerCase() === 'watch' ? 'Watch runner from analysis' : null }).catch(() => null);
      if (!outcome) return;
      if ((outcome.action === 'tracked' || outcome.action === 'untracked') && !document.querySelector('[data-tracked-edit-root="1"]')) {
        reopenRunnerModal();
      }
    };
  });
}

function buildAiAnalysisCacheKey(overrideProvider, overrideModel){
  if (!selectedRace) return '';
  const raceKey = buildAiRaceKey(selectedRace);
  if (!raceKey) return '';
  const provider = overrideProvider || selectedAiModel.provider || 'ollama';
  const model = overrideModel || selectedAiModel.model || '';
  return `${raceKey}|${provider}|${model}`;
}

function buildAiCooldownKey(race = selectedRace){
  return buildAiRaceKey(race) || '';
}

function getAiAnalyseCooldownRemaining(key){
  if (!key) return 0;
  const until = aiAnalysisCooldown.get(key);
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    aiAnalysisCooldown.delete(key);
    persistAiCooldown();
    return 0;
  }
  return remaining;
}

function refreshAiAnalyseButtonState(){
  const btn = $('aiAnalyseBtn');
  if (!btn) return;
  const key = buildAiCooldownKey();
  const locked = getAiAnalyseCooldownRemaining(key) > 0;
  btn.disabled = locked;
  if (locked) {
    const cooldownMinutes = AI_ANALYSE_COOLDOWN_MS / 60000;
    const label = Number.isInteger(cooldownMinutes) ? String(cooldownMinutes) : cooldownMinutes.toFixed(1);
    btn.title = `AI analysis cooling down (${label} min)`;
    ensureAiCooldownTimer();
  } else {
    btn.title = '';
    if (aiCooldownInterval) {
      clearInterval(aiCooldownInterval);
      aiCooldownInterval = null;
    }
  }
  updateAiCooldownTimer();
}

function updateAnalysisAiModelNote(){
  const text = `Using ${selectedAiModel.model || '—'} (${selectedAiModel.provider || '—'})`;
  document.querySelectorAll('.analysis-ai-model-note').forEach(note => {
    note.textContent = text;
  });
}

function startAiAnalyseCooldown(key){
  if (!key) return;
  aiAnalysisCooldown.set(key, Date.now() + AI_ANALYSE_COOLDOWN_MS);
  persistAiCooldown();
  refreshAiAnalyseButtonState();
  ensureAiCooldownTimer();
}

function updateAiCooldownTimer(){
  const el = $('aiCooldownTimer');
  if (!el) return;
  const remaining = getAiAnalyseCooldownRemaining(buildAiCooldownKey());
  if (remaining <= 0) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  const seconds = Math.max(1, Math.ceil(remaining / 1000));
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const text = minutes > 0 ? `${minutes}m ${String(secs).padStart(2,'0')}s` : `${secs}s`;
  el.textContent = `AI cooldown: ${text}`;
  el.style.display = '';
}

function ensureAiCooldownTimer(){
  updateAiCooldownTimer();
  if (aiCooldownInterval) return;
  aiCooldownInterval = setInterval(() => {
    const remaining = getAiAnalyseCooldownRemaining(buildAiCooldownKey());
    if (remaining <= 0) {
      clearInterval(aiCooldownInterval);
      aiCooldownInterval = null;
      updateAiCooldownTimer();
    } else {
      updateAiCooldownTimer();
    }
  }, 1000);
}

function renderCachedAiAnalysisIfPresent(race){
  if (!race) return false;
  const resolved = resolveAutoTuneModelSelection();
  const key = buildAiAnalysisCacheKey(resolved.provider, resolved.model);
  if (!key) return false;
  const cached = aiAnalysisCache.get(key);
  if (!cached || !cached.answerHtml) return false;
  if ((Date.now() - cached.timestamp) > AI_ANALYSE_CACHE_TTL_MS) {
    aiAnalysisCache.delete(key);
    persistAiAnalysisCache();
    return false;
  }
  const responseLabel = formatResponseTime(cached.durationMs) || 'n/a';
  const modelName = cached.modelName || resolved.model || selectedAiModel.model || '—';
  const meta = `<div class='analysis-meta'>Answer ${new Date(cached.timestamp || Date.now()).toLocaleTimeString()} · Response ${responseLabel} · ${modelName} · Cached</div>`;
  setAiAnswerPanel(`<div class='ai-answer-block'>${cached.answerHtml}</div>${meta}`);
  return true;
}

function bindAiAnalyseButton(){
  const btn = $('aiAnalyseBtn');
  if (!btn) return;
  const defaultAiAnalyseLabel = btn.textContent || 'AI Analyse';
  refreshAiAnalyseButtonState();
  btn.onclick = async ()=>{
    const setButtonLoading = (label) => {
      if (label) {
        btn.dataset.loading = '1';
        btn.disabled = true;
        btn.textContent = label;
      } else {
        btn.dataset.loading = '0';
        btn.disabled = false;
        btn.textContent = defaultAiAnalyseLabel;
      }
    };
    const flashButtonMessage = (text) => {
      btn.textContent = text;
      setTimeout(()=>{
        if (btn.dataset.loading !== '1') btn.textContent = defaultAiAnalyseLabel;
      }, 1200);
    };
    const serveCache = () => {
      if (!selectedRace) return false;
      const resolved = resolveAutoTuneModelSelection();
      const key = buildAiAnalysisCacheKey(resolved.provider, resolved.model);
      if (!key) return false;
      const cached = aiAnalysisCache.get(key);
      if (!cached || !cached.answerHtml) return false;
      if ((Date.now() - cached.timestamp) > AI_ANALYSE_CACHE_TTL_MS) {
        aiAnalysisCache.delete(key);
        persistAiAnalysisCache();
        return false;
      }
      const responseLabel = formatResponseTime(cached.durationMs) || 'n/a';
      const modelName = cached.modelName || resolved.model || selectedAiModel.model || '—';
      const meta = `<div class='analysis-meta'>Answer ${new Date(cached.timestamp).toLocaleTimeString()} · Response ${responseLabel} · ${modelName} · Cached</div>`;
      analysisViewMode = 'engine';
      updateAnalysisToggleLabel();
      $('analysisBody').innerHTML = renderAnalysis(selectedRace, 'engine');
      updateAnalysisAiModelNote();
      attachAnalysisSelectionHandlers(selectedRace);
      makeSelectionsDraggable();
      ensureAiAnswerHost();
      setAiAnswerPanel(`<div class='ai-answer-block'>${cached.answerHtml}</div>${meta}`);
      flashButtonMessage('Cached answer');
      return true;
    };
    if (getAiAnalyseCooldownRemaining(buildAiCooldownKey()) > 0) return;
    if (!selectedRace) {
      await loadRaces();
      const selectedCard = document.querySelector('.race-card.selected');
      if (selectedCard) {
        await selectRace(selectedCard.dataset.key, selectedCard.dataset.meeting, selectedCard.dataset.race);
      } else if (racesCache.length) {
        selectedRace = racesCache[0];
        selectedRaceKey = selectedRace ? selectedRace.key : null;
      }
    }
    if (!selectedRace) {
      alert('Select a race first.');
      return;
    }
    if (serveCache()) return;
    setButtonLoading('Analysing…');
    showAnalysisProcessingHint();
    analysisViewMode = 'engine';
    updateAnalysisToggleLabel();
    $('analysisBody').innerHTML = renderAnalysis(selectedRace, 'engine');
    updateAnalysisAiModelNote();
    attachAnalysisSelectionHandlers(selectedRace);
    makeSelectionsDraggable();
    $('analysisTitle').textContent = `${selectedRace.meeting} R${selectedRace.race_number} — ${selectedRace.description}`;
    ensureAiAnswerHost();
    setAiAnswerPanel(`<div class='ai-answer-block pending'>Running AI analysis…</div>`);
    const cooldownKey = buildAiCooldownKey(selectedRace);
    await ensureInstructionsLoaded().catch(()=>{});
    await loadRunnerMetrics().catch(()=>{});
    const autoTuneSelection = resolveAutoTuneModelSelection();
    const cacheKey = (() => {
      if (!selectedRace) return '';
      const raceKey = buildAiRaceKey(selectedRace);
      if (!raceKey) return '';
      const provider = autoTuneSelection.provider || 'ollama';
      const model = autoTuneSelection.model || '';
      return `${raceKey}|${provider}|${model}`;
    })();
    const payload = {
      source: 'race-analysis',
      question: buildAiAnalysisPrompt(selectedRace),
      provider: autoTuneSelection.provider,
      model: autoTuneSelection.model,
      selectionCount: 0,
      selections: [],
      uiContext: { day: selectedDay, country: selectedCountry, meeting: selectedMeeting },
      raceContext: { meeting: selectedRace.meeting, raceNumber: selectedRace.race_number, raceName: selectedRace.description },
      userNotes: queryAiUserNotes('', selectedMeeting).slice(0, 5).map(n => ({ text: n.text, meeting: n.meeting, createdAt: n.createdAt }))
    };
    const requestStarted = performance.now();
    let responseMs = null;
    try {
      const res = await fetchLocal('./api/ask-selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const out = await res.json();
      responseMs = performance.now() - requestStarted;
      if (!res.ok || !out || !out.answer) throw new Error(out?.error || 'ai_analysis_failed');
      const raceKey = buildAiRaceKey(selectedRace);
      if (raceKey) aiRaceRuns.add(raceKey);
      const answerHtml = formatAiAnswer(out.answer);
      const oddsTableHtml = buildOddsSummaryTable(selectedRace);
      const requestedModel = out.modelRequested || autoTuneSelection.model || selectedAiModel.model || '—';
      const usedModel = out.modelUsed || requestedModel || '—';
      const modelLabel = (requestedModel && usedModel && requestedModel !== usedModel)
        ? `${usedModel} (req ${requestedModel})`
        : usedModel;
      const generatedAt = Date.now();
      const responseLabel = formatResponseTime(responseMs) || 'n/a';
      const modeBadge = formatAiModeBadge(out.mode);
      const meta = `<div class='analysis-meta'>${modeBadge} · Answer ${new Date(generatedAt).toLocaleTimeString()} · Response ${responseLabel} · ${modelLabel}</div>`;
      setAiAnswerPanel(`<div class='ai-answer-block'>${oddsTableHtml}${answerHtml}</div>${meta}`);
      hideAnalysisProcessingHint();
      if (cooldownKey) startAiAnalyseCooldown(cooldownKey);
      if (cacheKey) {
        aiAnalysisCache.set(cacheKey, { answerHtml, modelName: modelLabel, timestamp: generatedAt, durationMs: responseMs });
        persistAiAnalysisCache();
      }
    } catch (err) {
      console.error('ai_analyse_failed', err);
      if (cooldownKey) {
        aiAnalysisCooldown.delete(cooldownKey);
        persistAiCooldown();
      }
      if (responseMs === null) responseMs = performance.now() - requestStarted;
      const responseLabel = formatResponseTime(responseMs) || 'n/a';
      const requestedModel = autoTuneSelection.model || selectedAiModel.model || '—';
      const providerLabel = autoTuneSelection.provider || selectedAiModel.provider || 'unknown';
      setAiAnswerPanel(`<div class='ai-answer-block error'>AI analysis failed for the selected model.</div><div class='analysis-meta'>Error ${new Date().toLocaleTimeString()} · Response ${responseLabel} · ${requestedModel} (${providerLabel})</div>`);
      hideAnalysisProcessingHint();
    } finally {
      attachAnalysisSelectionHandlers(selectedRace);
      makeSelectionsDraggable();
      hideAnalysisProcessingHint();
      setButtonLoading(null);
      refreshAiAnalyseButtonState();
    }
  };
}

function ensureAiAnswerHost(){
  const body = $('analysisBody');
  if (!body) return null;
  let host = $('aiAnswerPanel');
  if (host) return host;
  host = document.createElement('div');
  host.id = 'aiAnswerPanel';
  host.className = 'ai-answer-panel';
  host.style.display = 'none';
  const header = body.querySelector('.analysis-header');
  if (header) header.insertAdjacentElement('afterend', host);
  else body.insertBefore(host, body.firstChild || null);
  return host;
}

function setAiAnswerPanel(content){
  const host = ensureAiAnswerHost();
  if (!host) return;
  if (content) {
    host.innerHTML = content;
    host.style.display = 'block';
  } else {
    host.innerHTML = '';
    host.style.display = 'none';
  }
}

function clearAiAnswerPanel(){
  setAiAnswerPanel('');
}

let helpHintTooltipEl = null;
function hideHelpHintTooltip(){
  if (helpHintTooltipEl) {
    helpHintTooltipEl.remove();
    helpHintTooltipEl = null;
  }
}
function showHelpHintTooltip(target){
  const text = String(target?.getAttribute?.('title') || '').trim();
  if (!text) return;
  hideHelpHintTooltip();
  const tip = document.createElement('div');
  tip.className = 'help-floating-tooltip';
  tip.textContent = text;
  document.body.appendChild(tip);
  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
  left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
  let top = rect.top - tipRect.height - 8;
  if (top < 8) top = rect.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  helpHintTooltipEl = tip;
}
function setupHelpHintTooltips(){
  document.addEventListener('mouseenter', (e) => {
    const target = e.target?.closest?.('.help-hint');
    if (!target) return;
    showHelpHintTooltip(target);
  }, true);
  document.addEventListener('mouseleave', (e) => {
    const target = e.target?.closest?.('.help-hint');
    if (!target) return;
    hideHelpHintTooltip();
  }, true);
  document.addEventListener('click', (e) => {
    const target = e.target?.closest?.('.help-hint');
    if (!target) return;
    e.preventDefault();
    if (helpHintTooltipEl) hideHelpHintTooltip();
    else showHelpHintTooltip(target);
  });
  window.addEventListener('scroll', hideHelpHintTooltip, true);
}

function updateAnalysisToggleLabel(){
  const btn = $('analysisSimulationLaunch');
  if (btn) {
    btn.textContent = analysisViewMode === 'engine' ? 'Back to Race Card' : 'ODDS & AI ENGINE';
  }
  const speedBtn = $('analysisSpeedToggle');
  if (speedBtn) {
    speedBtn.textContent = analysisViewMode === 'speed' ? 'Back to Odds & AI' : 'Speed Analysis';
  }
}

function buildAiAnalysisPrompt(race){
  if (!race || !Array.isArray(race.runners)) {
    return 'Provide the full BETMAN race-analysis pack even though the race payload was missing.';
  }
  const meeting = race.meeting || 'Unknown meeting';
  const raceNo = race.race_number || race.race || '—';
  const desc = race.description || 'Race analysis requested';
  const track = race.track_condition || 'Track n/a';
  const rail = race.rail_position || 'Rail n/a';
  const weather = race.weather || 'Weather n/a';
  const distance = race.distance ? `${race.distance}m` : 'Distance n/a';
  const header = `Full race analysis for ${meeting} R${raceNo}: ${desc}`;
  const meta = `Track ${track} · Rail ${rail} · Weather ${weather} · Distance ${distance}`;
  const raceLine = `Meeting: ${meeting} | Race: ${raceNo} | Name: ${desc} | Distance: ${distance} | Track: ${track} | Rail: ${rail} | Weather: ${weather}`;
  const loveracing = race.loveracing || {};
  const lrMetaParts = [];
  if (loveracing.track_condition && loveracing.track_condition !== track) lrMetaParts.push(`LR Track ${loveracing.track_condition}`);
  if (loveracing.rail_position && loveracing.rail_position !== rail) lrMetaParts.push(`LR Rail ${loveracing.rail_position}`);
  if (loveracing.weather && loveracing.weather !== weather) lrMetaParts.push(`LR Weather ${loveracing.weather}`);
  const loveracingMeta = lrMetaParts.length ? lrMetaParts.join(' · ') : '';
  const loveracingCommentaryRaw = (loveracing.race_commentary || loveracing.comment || '').trim();
  const loveracingCommentary = loveracingCommentaryRaw.length > 250 ? `${loveracingCommentaryRaw.slice(0, 250)}…` : loveracingCommentaryRaw;
  // Note: instructions are sent by the backend as a system message — do not duplicate here.
  const loveracingLines = [];
  if (loveracingMeta) loveracingLines.push(loveracingMeta);
  if (loveracingCommentary) loveracingLines.push(`Loveracing track intel: ${loveracingCommentary}`);
  if (!loveracingCommentary) {
    const trialCount = (race.runners || []).filter(r => runnerHasStrongTrials(r)).length;
    if (trialCount > 0) loveracingLines.push(`Fallback intel: ${trialCount} runner${trialCount === 1 ? '' : 's'} show strong trial indicators (RacingAUS).`);
  }
  const raceRunnerNames = (race.runners || []).map(r => cleanRunnerText(r.name || r.runner_name || '')).filter(Boolean);
  const cleanFormComment = (runner) => {
    const raw = String(runner?.form_comment || '').trim();
    if (!raw || raw.toLowerCase() === 'n/a') return '';
    if (raw.length > 320) return '';
    const lower = raw.toLowerCase();
    const runnerName = cleanRunnerText(runner?.name || runner?.runner_name || '');
    if (runnerName && !lower.includes(runnerName.toLowerCase())) return '';
    const hits = raceRunnerNames.filter(name => lower.includes(name.toLowerCase()));
    if (hits.length > 1) return '';
    return raw;
  };
  const commentSample = (race.runners || []).map(r => cleanFormComment(r)).filter(Boolean).slice(0, 2);
  if (!loveracingCommentary && commentSample.length) loveracingLines.push(`Fallback form notes: ${commentSample.join(' · ')}`);
  if ((!weather || String(weather).toLowerCase() === 'weather n/a') && !loveracing.weather) {
    loveracingLines.push(`Weather fallback: official weather feed unavailable; use track condition (${track}) as surface proxy.`);
  }
  const loveracingBlock = loveracingLines.length ? `${loveracingLines.join('\n')}\n` : '';
  const runners = (race.runners || []).filter(r => !r.is_scratched).slice().sort((a,b)=>{
    const oa = Number(a?.odds || a?.fixed_win || a?.tote_win || a?.price || 0);
    const ob = Number(b?.odds || b?.fixed_win || b?.tote_win || b?.price || 0);
    if (Number.isFinite(oa) && Number.isFinite(ob)) return oa - ob;
    if (Number.isFinite(oa)) return -1;
    if (Number.isFinite(ob)) return 1;
    return String(a?.runner_number || a?.name || '').localeCompare(String(b?.runner_number || b?.name || ''));
  });
  const formatStatsText = (label, record) => {
    if (!record || typeof record !== 'object') return null;
    const starts = record.number_of_starts ?? record.starts;
    const wins = record.number_of_wins ?? record.wins;
    const seconds = record.number_of_seconds ?? record.seconds;
    const thirds = record.number_of_thirds ?? record.thirds;
    if ([starts, wins, seconds, thirds].every(v => v == null)) return null;
    const shortLabels = {
      'Career': 'C',
      'Track': 'Tr',
      'Dist': 'Dist',
      'Soft': 'Soft',
      '1st Up': '1U',
      '2nd Up': '2U'
    };
    const short = shortLabels[label] || label.replace(/\s+/g, '');
    return `${short} ${starts ?? 0}:${wins ?? 0}-${seconds ?? 0}-${thirds ?? 0}`;
  };
  const runnerLines = runners.map(r => {
    const headerBits = [];
    if (r.runner_number) headerBits.push(`#${r.runner_number}`);
    const name = cleanRunnerText(r.name || r.runner_name || '');
    if (name) headerBits.push(name);
    const info = [];
    if (r.is_scratched) info.push('SCR');
    if (r.barrier) info.push(`G${r.barrier}`);
    if (r.jockey) info.push(`J:${r.jockey}`);
    if (r.trainer) info.push(`T:${r.trainer}`);
    const weightParts = [];
    if (r.weight) weightParts.push(`${r.weight}kg`);
    if (r.allowance_weight) weightParts.push(`-${r.allowance_weight}`);
    if (weightParts.length) info.push(`Wt:${weightParts.join('/')}`);
    const oddsVal = Number(r.odds || r.fixed_win || r.tote_win || r.price || 0);
    if (Number.isFinite(oddsVal) && oddsVal > 0) info.push(`Win $${oddsVal.toFixed(2)}`);
    const placeVal = Number(r.fixed_place || r.tote_place || r.place_odds || r.place_price || 0);
    if (Number.isFinite(placeVal) && placeVal > 0) info.push(`Pl $${placeVal.toFixed(2)}`);
    const winProb = Number(r.win_p);
    if (Number.isFinite(winProb)) info.push(`WinP ${winProb.toFixed(1)}%`);
    const sectional = (() => {
      if (Array.isArray(r?.last_starts)) {
        const withL600 = r.last_starts.find(start => start?.last_600 || start?.last600 || start?.lastSixHundred);
        if (withL600) return withL600.last_600 || withL600.last600 || withL600.lastSixHundred;
      }
      return r?.last_600 || r?.last600 || null;
    })();
    if (sectional) info.push(`L600 ${sectional}`);
    const lrSec = r?.loveracing?.sectionals?.avg3 || null;
    if (Number.isFinite(lrSec?.last600)) info.push(`LR L600 avg3 ${lrSec.last600}s`);
    const modeledPlace = modeledPlacePct(r);
    if (Number.isFinite(modeledPlace)) info.push(`PlP ${modeledPlace.toFixed(1)}%`);
    const formSignal = runnerFormSignal(r);
    const formDescriptor = formSignal?.status && formSignal.status !== 'UNKNOWN'
      ? `${formSignal.status} – ${formSignal.summary}`
      : (r.last_twenty_starts || r.last_starts || r.form || 'n/a');
    if (formDescriptor) info.push(`Form ${formDescriptor}`);
    const lr = r?.loveracing || null;
    const lrSectionals = lr?.sectionals || null;
    if (lr?.domestic_rating) info.push(`LR Rating ${lr.domestic_rating}`);
    const lrAvg = lrSectionals?.avg3 || {};
    const lrTrend = lrSectionals?.trend_per_race_seconds || {};
    const lrForecast = lrSectionals?.forecast_next?.seconds || {};
    if (Number.isFinite(lrAvg?.last600)) info.push(`LR L600 avg3 ${lrAvg.last600}s`);
    if (Number.isFinite(lrTrend?.last600)) info.push(`LR L600 trend ${lrTrend.last600}s/r`);
    if (Number.isFinite(lrForecast?.last600)) info.push(`LR L600 fc ${lrForecast.last600}s`);
    const metricsKey = `${String(meeting || '').trim().toLowerCase()}|${String(raceNo || '').replace(/^R/i,'').trim()}|${normalizeRunnerName(name)}`;
    const metrics = runnerMetricsIndex.get(metricsKey) || null;
    const sectionalsPresent = !!(metrics?.loveracing_sectionals || lrSectionals || r?.racingaus?.sectionals_available || sectional);
    const trialIndicator = !!(metrics?.racingaus_trial_flag || r?.racingaus?.trial_indicator || runnerHasStrongTrials(r));
    const sourceTags = [
      (metrics?.loveracing_available || lr) ? 'loveracing' : null,
      (metrics?.racingaus_source || r?.racingaus?.available || r.form_comment) ? 'racingaus' : null
    ].filter(Boolean);
    const basicProfilePresent = !!(r?.barrier && r?.jockey && r?.trainer);
    const formPresent = !!(r?.last_twenty_starts || r?.form_comment || r?.form);
    const oddsPresent = Number.isFinite(Number(r?.odds || r?.fixed_win || r?.tote_win || 0));
    const speedmapPresent = !!r?.speedmap;
    const coverageFlags = [
      basicProfilePresent,
      formPresent,
      oddsPresent,
      speedmapPresent,
      sectionalsPresent,
      sourceTags.includes('loveracing'),
      sourceTags.includes('racingaus')
    ];
    let coverageScore = Math.min(100,
      (basicProfilePresent ? 20 : 0)
      + (formPresent ? 15 : 0)
      + (oddsPresent ? 10 : 0)
      + (speedmapPresent ? 10 : 0)
      + (sectionalsPresent ? 15 : 0)
      + (sourceTags.includes('loveracing') ? 10 : 0)
      + (sourceTags.includes('racingaus') ? 10 : 0)
      + (trialIndicator ? 20 : 0)
    );
    if (!sectionalsPresent) coverageScore = Math.min(coverageScore, 55);
    if (!sourceTags.includes('loveracing')) coverageScore = Math.min(coverageScore, 65);
    if (trialIndicator) coverageScore = Math.max(coverageScore, 90);
    info.push(`Sectionals ${sectionalsPresent ? 'yes' : 'no'}`);
    info.push(`Trials ${trialIndicator ? 'yes' : 'no'}`);
    info.push(`Sources ${sourceTags.length ? sourceTags.join(',') : 'n/a'}`);
    info.push(`Coverage ${coverageScore}%`);
    if (r.speedmap) info.push(`Map:${r.speedmap}`);
    if (r.gear) info.push(`Gear:${formatGearText(r.gear, '').trim()}`);
    const stats = r.stats || {};
    const statsParts = [];
    const pushRec = (label, record) => {
      const text = formatStatsText(label, record);
      if (text) statsParts.push(text);
    };
    pushRec('Career', stats.overall);
    pushRec('Track', stats.track);
    pushRec('Dist', stats.distance);
    pushRec('Soft', stats.soft || stats.good);
    pushRec('1stUp', stats.first_up);
    pushRec('2ndUp', stats.second_up);
    if (statsParts.length) info.push(`Stats ${statsParts.join(' / ')}`);
    const breedingBits = [];
    if (r.sire) breedingBits.push(r.sire);
    if (r.dam) breedingBits.push(r.dam);
    if (r.dam_sire) breedingBits.push(r.dam_sire);
    if (breedingBits.length) info.push(`Ped ${breedingBits.join(' × ')}`);
    const suitability = r.suitability_score != null ? `Suit:${r.suitability_score}/10` : (r.handicap_rating ? `Suit:Hcp ${r.handicap_rating}` : (r.rating ? `Suit:Rating ${r.rating}` : (r.spr ? `Suit:SPR ${r.spr}` : null)));
    if (suitability) info.push(suitability);
    const moverRow = findMoverRow(meeting, raceNo, r.name || r.runner_name || r.runner || '');
    if (moverRow) {
      const move = Number(moverRow.pctMove || moverRow.change5m || moverRow.change1m || 0);
      if (Number.isFinite(move) && move !== 0) {
        const dir = move < 0 ? 'Firm' : 'Drift';
        const fromOdds = Number(moverRow.fromOdds);
        const toOdds = Number(moverRow.toOdds);
        const swing = `${Math.abs(move).toFixed(1)}%` + (Number.isFinite(fromOdds) && Number.isFinite(toOdds) ? ` (${fromOdds.toFixed(2)}→${toOdds.toFixed(2)})` : '');
        info.push(`Move ${dir} ${swing}`);
      }
    }
    return `- ${headerBits.join(' ')} | ${info.join(' | ')}`;
  }).join('\n');
  // Cap runner lines at 8000 chars to prevent oversized prompts on large fields.
  // Runners are already sorted by market so the most relevant ones are first.
  const runnerLinesCapped = runnerLines.length > 8000 ? runnerLines.slice(0, 8000) + '\n… (field truncated to fit context)' : runnerLines;
  const sections = 'Deliver: verdict, ranked runners, overlays/underlays, pace map, runner callouts, value board, 999,999-run sim math, punter panel, staking plan, confidence %, invalidations.';
  return `${header}
${meta}
${loveracingBlock}${raceLine}

Runner intel (full field, sorted by market):
${runnerLinesCapped}

${sections}`;
}

function renderAnalysis(race, modeOverride){
  const viewMode = modeOverride || analysisViewMode;
  const oddsOf = (r) => {
    const v = Number(r?.odds || r?.fixed_win || r?.tote_win || 0);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  };
  const placeOddsOf = (r) => {
    const v = Number(r?.fixed_place || r?.tote_place || r?.place_odds || r?.place_price || 0);
    return Number.isFinite(v) && v > 0 ? v : NaN;
  };
  const formatSeconds = (val) => {
    if (!Number.isFinite(val)) return '—';
    const m = Math.floor(val / 60);
    const s = val - (m * 60);
    const sTxt = s.toFixed(2).padStart(5, '0');
    return m > 0 ? `${m}:${sTxt}` : s.toFixed(2);
  };

  const runners = (race.runners||[]).filter(r => !r.is_scratched).slice().sort((a,b)=> {
    const oa = oddsOf(a); const ob = oddsOf(b);
    return (Number.isFinite(oa) ? oa : 999) - (Number.isFinite(ob) ? ob : 999);
  });
  const fullRunners = Array.isArray(race.runners) ? race.runners.filter(r => !r.is_scratched) : [];

  // simple market-implied probabilities
  const probs = runners.map(r=>({
    name: r.name,
    odds: oddsOf(r),
    p: Number.isFinite(oddsOf(r)) ? 1/Number(oddsOf(r)) : 0
  })).filter(x=>x.p>0);
  const sumP = probs.reduce((a,b)=>a+b.p,0) || 1;
  probs.forEach(x=>x.p = x.p/sumP);
  probs.sort((a,b)=>b.p-a.p);
  const fav = probs[0];
  const second = probs[1];

  const meetingBias = userMeetingBias[normalizeMeetingNameText(race.meeting)] || null;

  // Modelled adjustments (not odds‑only): barrier + speedmap influence + user bias notes
  function modelScore(r){
    const ro = oddsOf(r);
    let s = Number.isFinite(ro) ? 1/Number(ro) : 0;
    if (r.barrier && r.barrier <= 4) s *= 1.03;
    if (r.barrier && r.barrier >= 10) s *= 0.97;
    if (['Leader','Pace'].includes(r.speedmap)) s *= 1.02;
    const formSignal = runnerFormSignal(r);
    if (formSignal?.status) {
      const formBoostMap = {
        HOT: 1.18,
        SOLID: 1.10,
        MIXED: 0.97,
        COLD: 0.9
      };
      const boost = formBoostMap[formSignal.status];
      if (boost) {
        s = (s === 0 && (formSignal.status === 'HOT' || formSignal.status === 'SOLID')) ? 0.02 * boost : s * boost;
      }
    }

    if (meetingBias) {
      const map = String(r.speedmap || '').toLowerCase();
      const barrier = Number(r.barrier || 0);
      if (meetingBias.insideRail) {
        if (Number.isFinite(barrier) && barrier > 0 && barrier <= 4) s *= 1.06;
        if (Number.isFinite(barrier) && barrier >= 10) s *= 0.94;
      }
      if (meetingBias.leaders) {
        if (['leader', 'pace', 'on pace', 'onpace'].includes(map)) s *= 1.07;
        if (['midfield', 'off midfield', 'backmarker'].includes(map)) s *= 0.96;
      }
      if (meetingBias.swoopers) {
        if (['midfield', 'off midfield', 'backmarker'].includes(map)) s *= 1.07;
        if (['leader', 'pace', 'on pace', 'onpace'].includes(map)) s *= 0.95;
      }
    }
    return s;
  }
  const model = runners.map(r=>({name:r.name, score:modelScore(r)})).filter(x=>x.score>0);
  const sumM = model.reduce((a,b)=>a+b.score,0) || 1;
  model.forEach(x=>x.p = x.score/sumM);
  model.sort((a,b)=>b.p-a.p);
  const modelProbMap = new Map(model.map(entry => [normalizeRunnerName(entry.name), entry.p]));
  const enrichedRunners = (race.runners || []).filter(r => !r.is_scratched).map(r => {
    const norm = normalizeRunnerName(r.name || r.runner_name || '');
    const prob = modelProbMap.get(norm);
    return { ...r, modelProb: Number.isFinite(prob) ? prob : null };
  });

  const hasCareerStats = fullRunners.some(r => {
    const stats = r?.stats?.overall;
    const starts = stats?.number_of_starts ?? stats?.starts;
    return starts != null;
  });
  const hasTrackDistance = fullRunners.some(r => {
    const stats = r?.stats;
    const track = stats?.track;
    const distance = stats?.distance;
    return ((track?.number_of_starts ?? track?.starts) != null) || ((distance?.number_of_starts ?? distance?.starts) != null);
  });
  const hasSectionals = fullRunners.some(r => {
    if (Array.isArray(r?.last_starts)) {
      return r.last_starts.some(start => start?.last_600 || start?.last600 || start?.lastSixHundred);
    }
    return !!(r?.last_600 || r?.last600);
  });
  const hasSpeedmap = fullRunners.some(r => !!r?.speedmap);
  const hasSuitability = fullRunners.some(r => r?.suitability_score != null || r?.handicap_rating || r?.rating || r?.spr);
  const dataGaps = [];
  if (!hasCareerStats) dataGaps.push('Career starts / wins / placings');
  if (!hasTrackDistance) dataGaps.push('Track / distance splits');
  if (!hasSectionals) dataGaps.push('Sectionals (early/mid/L600)');
  if (!hasSpeedmap) dataGaps.push('Speed map feed');
  if (!hasSuitability) dataGaps.push('Suitability score / ratings');

  // Monte‑Carlo sim on modelled probs
  function simulate(probs, n=999999){
    const cum=[]; let s=0;
    probs.forEach(p=>{s+=p.p; cum.push([p.name,s]);});
    const wins = Object.fromEntries(probs.map(p=>[p.name,0]));
    for(let i=0;i<n;i++){
      const x=Math.random();
      for(const [name,c] of cum){ if(x<=c){wins[name]++; break;} }
    }
    return Object.fromEntries(probs.map(p=>[p.name, wins[p.name]/n]));
  }
  const sim = simulate(model, 999999);

  const jockeyBuckets = new Map();
  runners.forEach(r => {
    const jockey = String(r.jockey || '').trim();
    if (!jockey) return;
    const modeledPct = Number(sim[r.name] || 0) * 100;
    if (!jockeyBuckets.has(jockey)) jockeyBuckets.set(jockey, []);
    jockeyBuckets.get(jockey).push(modeledPct);
  });
  const fieldModelAvg = runners.length
    ? (runners.reduce((acc, r) => acc + (Number(sim[r.name] || 0) * 100), 0) / runners.length)
    : 0;
  const jockeyEdgeMap = new Map();
  jockeyBuckets.forEach((vals, jockey) => {
    const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
    const rawEdge = avg - fieldModelAvg;
    // Shrink small-sample edges and clamp to avoid extreme swings from one ride.
    const sampleShrink = vals.length / (vals.length + 2);
    const shrunk = rawEdge * sampleShrink;
    const capped = Math.max(-6, Math.min(6, shrunk));
    jockeyEdgeMap.set(jockey, capped);
  });
  const jockeyEdgePct = (runner) => {
    const jockey = String(runner?.jockey || '').trim();
    if (!jockey) return NaN;
    return Number(jockeyEdgeMap.get(jockey));
  };

  let summary = '';
  if (fav) {
    const edge = second ? (fav.p/(second.p||1)) : null;
    summary = `Market‑anchored leader: <b>${escapeHtml(fav.name)}</b> (~${(fav.p*100).toFixed(1)}%).`;
    if (edge && edge >= 1.5) summary += ` Clear separation vs next (${edge.toFixed(2)}×).`;
  }

  const paceLeaders = runners.filter(r=>['Leader','Pace'].includes(r.speedmap)).map(r=>r.name).slice(0,3);
  const paceNote = paceLeaders.length ? `Likely on‑pace: ${paceLeaders.join(', ')}.` : 'Pace map unclear in feed.';
  const topJockeyEdge = runners
    .map(r => ({ name: cleanRunnerText(r.name || r.runner_name || ''), edge: jockeyEdgePct(r) }))
    .filter(x => Number.isFinite(x.edge))
    .sort((a,b) => b.edge - a.edge)[0] || null;

  const topSim = Object.entries(sim).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const punters = [
    {name:'Gabe “Tape” Morris', note:'sticks with price/market leadership'},
    {name:'Leah “Rail” Chan', note:'bias + map focused'},
    {name:'Mick “Value” Fraser', note:'loves overs / longshots'}
  ];

  const modelFav = topSim[0]?.[0];
  const modelFavP = topSim[0]?.[1] || 0;
  const modelSecond = topSim[1]?.[0];
  const modelSecondP = topSim[1]?.[1] || 0;
  const speedGroups = { leaders: [], onpace: [], midfield: [], backmarkers: [] };
  runners.forEach(r => {
    const label = `${cleanRunnerText(r.name)}${r.barrier ? ` (B${r.barrier})` : ''}`;
    const map = String(r.speedmap || '').toLowerCase();
    if (['leader','pace'].includes(map)) speedGroups.leaders.push(label);
    else if (['on pace','onpace'].includes(map)) speedGroups.onpace.push(label);
    else if (['midfield','off midfield'].includes(map)) speedGroups.midfield.push(label);
    else speedGroups.backmarkers.push(label);
  });
  const speedMapHtml = [
    speedGroups.leaders.length ? `<div><b>Leaders:</b> ${speedGroups.leaders.join(', ')}</div>` : '',
    speedGroups.onpace.length ? `<div><b>On pace:</b> ${speedGroups.onpace.join(', ')}</div>` : '',
    speedGroups.midfield.length ? `<div><b>Midfield:</b> ${speedGroups.midfield.join(', ')}</div>` : '',
    speedGroups.backmarkers.length ? `<div><b>Backmarkers:</b> ${speedGroups.backmarkers.join(', ')}</div>` : ''
  ].filter(Boolean).join('') || '<div>Speed map inputs missing.</div>';

  const speedRows = runners.map(r => {
    const lr = r?.loveracing || {};
    const ra = r?.racingaus || {};
    const sec = lr?.sectionals || {};
    const avg = sec?.avg3 || {};
    const trend = sec?.trend_per_race_seconds || {};
    const fc = sec?.forecast_next?.seconds || {};
    const improving = sec?.forecast_next?.improving || {};
    const last600Raw = (() => {
      if (Array.isArray(r?.last_starts)) {
        const withL600 = r.last_starts.find(start => start?.last_600 || start?.last600 || start?.lastSixHundred);
        if (withL600) return withL600.last_600 || withL600.last600 || withL600.lastSixHundred;
      }
      return r?.last_600 || r?.last600 || null;
    })();
    const last600RawNum = (last600Raw !== null && last600Raw !== undefined && String(last600Raw).trim() !== '') ? Number(last600Raw) : NaN;
    const raLast600Candidates = [
      ra?.last600_avg,
      ra?.last600_best,
      ra?.last_600,
      ra?.last600,
      ra?.sectionals?.last600,
      ra?.sectionals?.avg_last600
    ].map(v => Number(v));
    const raLast600 = raLast600Candidates.find(v => Number.isFinite(v));
    const raFirst400 = [ra?.first400_avg, ra?.first_400, ra?.first400, ra?.sectionals?.first400].map(v => Number(v)).find(v => Number.isFinite(v));
    const raLast800 = [ra?.last800_avg, ra?.last_800, ra?.last800, ra?.sectionals?.last800].map(v => Number(v)).find(v => Number.isFinite(v));
    const last600 = Number.isFinite(avg?.last600)
      ? avg.last600
      : (Number.isFinite(last600RawNum)
        ? last600RawNum
        : (Number.isFinite(raLast600) ? raLast600 : null));
    const l600 = Number.isFinite(fc?.last600) ? fc.last600 : (Number.isFinite(last600) ? last600 : NaN);
    return {
      runner: r,
      rating: lr?.domestic_rating,
      first400: Number.isFinite(avg?.first400) ? avg.first400 : (Number.isFinite(raFirst400) ? raFirst400 : null),
      last800: Number.isFinite(avg?.last800) ? avg.last800 : (Number.isFinite(raLast800) ? raLast800 : null),
      last600,
      trend600: trend?.last600,
      forecast600: fc?.last600,
      improving600: improving?.last600,
      hasSource: !!(lr?.sectionals || lr?.domestic_rating || ra?.available || ra?.trial_indicator || Number.isFinite(raLast600) || r?.form_comment),
      sortVal: l600
    };
  });

  speedRows.sort((a,b)=> (Number.isFinite(a.sortVal) ? a.sortVal : 999) - (Number.isFinite(b.sortVal) ? b.sortVal : 999));
  let usesForecastFallback = false;
  const fastestFirst400 = speedRows.reduce((min, row) => Number.isFinite(row.first400) ? Math.min(min, row.first400) : min, Infinity);
  const fastestLast800 = speedRows.reduce((min, row) => Number.isFinite(row.last800) ? Math.min(min, row.last800) : min, Infinity);
  const fastestLast600 = speedRows.reduce((min, row) => {
    const val = Number.isFinite(row.last600) ? row.last600 : (Number.isFinite(row.forecast600) ? row.forecast600 : NaN);
    return Number.isFinite(val) ? Math.min(min, val) : min;
  }, Infinity);
  const fastestForecast = speedRows.reduce((min, row) => Number.isFinite(row.forecast600) ? Math.min(min, row.forecast600) : min, Infinity);
  const hasFastestFirst400 = Number.isFinite(fastestFirst400) && fastestFirst400 !== Infinity;
  const hasFastestLast800 = Number.isFinite(fastestLast800) && fastestLast800 !== Infinity;
  const hasFastestLast600 = Number.isFinite(fastestLast600) && fastestLast600 !== Infinity;
  const hasFastestForecast = Number.isFinite(fastestForecast) && fastestForecast !== Infinity;
  const speedTableRows = speedRows.map(row => {
    const name = cleanRunnerText(row.runner?.name || row.runner?.runner_name || '');
    const trendTag = Number.isFinite(row.trend600) ? `${row.trend600 >= 0 ? '+' : ''}${row.trend600.toFixed(2)}` : '—';
    const trajectory = row.improving600 === true ? 'up' : (row.improving600 === false ? 'down' : 'flat');
    const trajectorySymbol = trajectory === 'up' ? '↑' : trajectory === 'down' ? '↓' : '→';
    const last600Val = Number.isFinite(row.last600) ? row.last600 : (Number.isFinite(row.forecast600) ? row.forecast600 : NaN);
    const isFastestLast600 = hasFastestLast600 && Number.isFinite(last600Val) && Math.abs(last600Val - fastestLast600) < 0.0001;
    const isFastestFirst400 = hasFastestFirst400 && Number.isFinite(row.first400) && Math.abs(row.first400 - fastestFirst400) < 0.0001;
    const isFastestLast800 = hasFastestLast800 && Number.isFinite(row.last800) && Math.abs(row.last800 - fastestLast800) < 0.0001;
    const isFastestForecast = hasFastestForecast && Number.isFinite(row.forecast600) && Math.abs(row.forecast600 - fastestForecast) < 0.0001;
    const last600Cell = Number.isFinite(row.last600)
      ? formatSeconds(row.last600)
      : (Number.isFinite(row.forecast600)
        ? (usesForecastFallback = true, `<span class='forecast-value'>${formatSeconds(row.forecast600)}*</span>`)
        : '—');
    const last600Display = isFastestLast600 ? `<span class='fastest-sectional'>${last600Cell}</span>` : last600Cell;
    const first400Display = isFastestFirst400 ? `<span class='fastest-sectional'>${formatSeconds(row.first400)}</span>` : formatSeconds(row.first400);
    const last800Display = isFastestLast800 ? `<span class='fastest-sectional'>${formatSeconds(row.last800)}</span>` : formatSeconds(row.last800);
    const forecastDisplay = isFastestForecast ? `<span class='fastest-sectional'>${formatSeconds(row.forecast600)}</span>` : formatSeconds(row.forecast600);
    const runnerCell = name
      ? `<button class='analysis-odds-runner-btn' data-meeting='${escapeAttr(race.meeting)}' data-race='${escapeAttr(race.race_number || race.race || '')}' data-runner='${escapeAttr(name)}'>${escapeHtml(name)}</button>`
      : '—';
    return `<tr>
      <td>${runnerCell}</td>
      <td>${row.rating ?? '—'}</td>
      <td>${first400Display}</td>
      <td>${last800Display}</td>
      <td>${last600Display}</td>
      <td>${trendTag}</td>
      <td>${forecastDisplay}</td>
      <td><span class='traj ${trajectory}'>${trajectorySymbol}</span></td>
    </tr>`;
  }).join('');
  const region = String(race.country || race.region || '').trim().toUpperCase();
  const speedTableHtml = speedRows.length
    ? `<div class='analysis-table-scroll'>
        <table class='analysis-table'>
          <tr><th>Runner</th><th>LR Rating</th><th>Avg F400</th><th>Avg L800</th><th>Avg L600</th><th>L600 Trend</th><th>L600 Forecast</th><th>Trajectory <span class='help-hint' title='Arrow shows forecast direction for L600: ↑ improving, → flat, ↓ slowing.'>?</span></th></tr>
          ${speedTableRows}
        </table>
        ${usesForecastFallback ? `<div class='sub forecast-note'>* Forecast used where sectionals are missing.</div>` : ''}
      </div>`
    : `<div>${region === 'NZ' ? 'Speed/sectional data pending from Loveracing.' : 'Sectionals unavailable from RacingAUS feed for this race yet.'}</div>`;

  const metricsRows = runners.map(r => {
    const runnerName = cleanRunnerText(r.name || r.runner_name || '');
    const meetingKey = String(race.meeting || '').trim().toLowerCase();
    const raceKey = String(race.race_number || race.race || '').replace(/^R/i,'').trim();
    const runnerKey = normalizeRunnerName(runnerName);
    const metrics = runnerMetricsIndex.get(`${meetingKey}|${raceKey}|${runnerKey}`) || {};
    const sectionalsPresent = !!(metrics?.loveracing_sectionals || r?.loveracing?.sectionals || r?.racingaus?.sectionals_available || Array.isArray(r?.last_starts) && r.last_starts.some(s => s?.last_600 || s?.last600));
    const trialPresent = !!(metrics?.racingaus_trial_flag || r?.racingaus?.trial_indicator || runnerHasStrongTrials(r));
    const hasLoveracingTag = !!(metrics?.loveracing_available || r?.loveracing);
    const hasRacingAusTag = !!(metrics?.racingaus_source || r?.racingaus?.available || r?.form_comment);
    const basicProfilePresent = !!(r?.barrier && r?.jockey && r?.trainer);
    const formPresent = !!(r?.last_twenty_starts || r?.form_comment || r?.form);
    const oddsPresent = Number.isFinite(Number(r?.odds || r?.fixed_win || r?.tote_win || 0));
    const speedmapPresent = !!r?.speedmap;
    const coverageParts = [
      basicProfilePresent,
      formPresent,
      oddsPresent,
      speedmapPresent,
      sectionalsPresent,
      trialPresent,
      hasLoveracingTag,
      hasRacingAusTag
    ];
    const coverage = Math.round((coverageParts.filter(Boolean).length / coverageParts.length) * 100);
    const sourceTags = [
      hasLoveracingTag ? 'loveracing' : null,
      hasRacingAusTag ? 'racingaus' : null
    ].filter(Boolean).join(', ') || '—';
    return {
      runnerName,
      sectionals: sectionalsPresent ? 'Yes' : 'No',
      trial: trialPresent ? 'Yes' : 'No',
      sources: sourceTags,
      coverage
    };
  });
  const metricsRowsHtml = metricsRows.map(row => `<tr>
      <td>${escapeHtml(row.runnerName || '—')}</td>
      <td>${row.sectionals}</td>
      <td>${row.trial}</td>
      <td>${escapeHtml(row.sources)}</td>
      <td>${row.coverage}%</td>
    </tr>`).join('');
  const metricsCoverageAvg = metricsRows.length ? Math.round(metricsRows.reduce((acc, row) => acc + (row.coverage || 0), 0) / metricsRows.length) : null;
  const runnerMetricsBlock = `
    <details class='analysis-block runner-coverage-block'>
      <summary>
        <b>Runner Data Coverage (Loveracing + RacingAUS)</b>
        <span class='analysis-meta-line'>Coverage average: ${metricsCoverageAvg != null ? `${metricsCoverageAvg}%` : '—'}</span>
      </summary>
      <div class='analysis-table-scroll'>
        <table class='analysis-table'>
          <tr><th>Runner</th><th>Sectionals</th><th>Trial indicators</th><th>Source tags</th><th>Coverage</th></tr>
          ${metricsRowsHtml}
        </table>
      </div>
    </details>`;

  const horseProfiles = runners.slice(0,3).map((r, idx) => {
    const odds = oddsOf(r);
    const placeOdds = placeOddsOf(r);
    const lr = r?.loveracing || null;
    const lrAvg = lr?.sectionals?.avg3 || null;
    const last600 = (() => {
      if (Array.isArray(r?.last_starts)) {
        const withL600 = r.last_starts.find(start => start?.last_600 || start?.last600 || start?.lastSixHundred);
        if (withL600) return withL600.last_600 || withL600.last600 || withL600.lastSixHundred;
      }
      return r?.last_600 || r?.last600 || null;
    })();
    const sectionalBits = [];
    if (last600) sectionalBits.push(`L600 ${last600}`);
    if (Number.isFinite(lrAvg?.last600)) sectionalBits.push(`LR L600 avg3 ${lrAvg.last600}s`);
    const sectionalsText = sectionalBits.length ? sectionalBits.join(' · ') : 'Sectionals n/a';
    return `<div class='horse-profile'>
      <b>${idx+1}. ${cleanRunnerText(r.name)}</b> · Barrier ${r.barrier || '—'} · ${r.jockey || 'jockey n/a'} · ${r.trainer || 'trainer n/a'}<br />
      Form ${r.last_twenty_starts || 'n/a'} · Speed ${r.speedmap || 'n/a'} · ${sectionalsText} · Win ${Number.isFinite(odds) ? `$${odds.toFixed(2)}` : '—'} / Place ${Number.isFinite(placeOdds) ? `$${placeOdds.toFixed(2)}` : '—'} · Model ${(sim[r.name]*100 || 0).toFixed(1)}%
    </div>`;
  }).join('') || '<div>No runner profiles available.</div>';

  const winEdgeData = runners.map(r => {
    const odds = oddsOf(r);
    const implied = Number.isFinite(odds) ? (100/odds) : NaN;
    const modeled = Number(sim[r.name] || 0) * 100;
    return { name: r.name, edge: (Number.isFinite(modeled) && Number.isFinite(implied)) ? modeled - implied : NaN };
  }).filter(x => Number.isFinite(x.edge));
  const placeEdgeData = runners.map(r => {
    const odds = placeOddsOf(r);
    const implied = Number.isFinite(odds) ? (100/odds) : NaN;
    const modeled = modeledPlacePct(r, { sim, placeOddsGetter: placeOddsOf });
    return { name: r.name, edge: (Number.isFinite(modeled) && Number.isFinite(implied)) ? modeled - implied : NaN };
  }).filter(x => Number.isFinite(x.edge));
  const winOverlays = winEdgeData.filter(x => x.edge > 0).sort((a,b)=>b.edge-a.edge).slice(0,3)
    .map(x => `<li>${cleanRunnerText(x.name)} (+${x.edge.toFixed(1)} pts)</li>`).join('') || '<li>No overlays.</li>';
  const winUnderlays = winEdgeData.filter(x => x.edge < 0).sort((a,b)=>a.edge-b.edge).slice(0,2)
    .map(x => `<li>${cleanRunnerText(x.name)} (${x.edge.toFixed(1)} pts)</li>`).join('') || '<li>No obvious underlays.</li>';
  const placeOverlays = placeEdgeData.length
    ? (placeEdgeData.filter(x => x.edge > 0).sort((a,b)=>b.edge-a.edge).slice(0,3)
      .map(x => `<li>${cleanRunnerText(x.name)} (+${x.edge.toFixed(1)} pts)</li>`).join('') || '<li>No place overlays.</li>')
    : '<li>Place prices pending.</li>';
  const placeUnderlays = placeEdgeData.length
    ? (placeEdgeData.filter(x => x.edge < 0).sort((a,b)=>a.edge-b.edge).slice(0,2)
      .map(x => `<li>${cleanRunnerText(x.name)} (${x.edge.toFixed(1)} pts)</li>`).join('') || '<li>No obvious place underlays.</li>')
    : '<li>Place prices pending.</li>';

  const ewCandidateMetrics = placeEdgeData
    .map(candidate => {
      const runnerName = candidate.name;
      const runnerObj = runners.find(r => cleanRunnerText(r.name || r.runner_name || '') === runnerName);
      const odds = runnerObj ? oddsOf(runnerObj) : NaN;
      const norm = normalizeRunnerName(runnerName);
      const winProb = modelProbMap.get(norm) || sim[runnerName] || 0;
      const placePct = runnerObj ? modeledPlacePct(runnerObj, { sim, placeOddsGetter: placeOddsOf }) : NaN;
      const placeProb = Number.isFinite(placePct) ? placePct / 100 : 0;
      const formSignal = runnerObj ? runnerFormSignal(runnerObj) : null;
      const formStatus = formSignal?.status || 'UNKNOWN';
      const formBoost = formStatus === 'HOT' ? 6 : formStatus === 'SOLID' ? 3 : formStatus === 'COLD' ? -5 : 0;
      const volatilityPenalty = Number.isFinite(odds) && odds > 12 ? (odds - 12) * 1.5 : 0;
      const score = (winProb * 180) + (placeProb * 140) + (candidate.edge * 1.2) + formBoost - volatilityPenalty;
      return { runnerName, edge: candidate.edge, odds, winProb, placeProb, formStatus, score };
    })
    .filter(item => Number.isFinite(item.odds));
  const ewCandidates = ewCandidateMetrics
    .filter(item => item.odds >= 4 && item.odds <= 15 && item.edge >= 1 && item.winProb >= 0.05 && item.placeProb >= 0.25 && item.placeProb <= 0.85)
    .sort((a,b) => b.score - a.score);
  let ewRunner = ewCandidates.length ? ewCandidates[0].runnerName : null;
  if (!ewRunner) {
    const valueFallback = ewCandidateMetrics
      .filter(item => item.edge > 0.5 && item.odds >= 3 && item.odds <= 15 && item.winProb >= 0.02)
      .sort((a,b) => (b.edge - a.edge) || (b.winProb - a.winProb))[0];
    if (valueFallback) ewRunner = valueFallback.runnerName;
  }
  if (!ewRunner) {
    for (const [runnerName] of topSim) {
      const candidateObj = runners.find(r => cleanRunnerText(r.name || r.runner_name || '') === runnerName);
      const odds = candidateObj ? oddsOf(candidateObj) : NaN;
      if (Number.isFinite(odds) && odds >= 3 && odds <= 30) {
        ewRunner = runnerName;
        break;
      }
    }
  }
  if (!ewRunner) ewRunner = modelSecond || modelFav;

  // Selection policy:
  // 1) If Suggested Bets has an explicit Win recommendation for this race, use it as source-of-truth.
  // 2) Otherwise fallback to model policy.
  const hasClearModelSeparation = (modelFavP >= 0.35 && modelFavP >= 1.25 * modelSecondP);
  const suggestedWin = getSuggestedWinForRace(race);

  let picked = modelFav;
  let pickPolicy = 'model_leader';

  if (suggestedWin && suggestedWin.selection) {
    picked = suggestedWin.selection;
    pickPolicy = 'suggested_win';
  } else if (!hasClearModelSeparation) {
    picked = ewRunner || modelSecond || modelFav;
    pickPolicy = ewRunner ? 'value_ew' : 'value_secondary';
  }

  const getRunnerWinEdge = (runnerName) => {
    const row = winEdgeData.find(x => normalizeRunnerName(x.name) === normalizeRunnerName(runnerName || ''));
    return row ? Number(row.edge) : NaN;
  };
  const getRunnerDriftPct = (runnerName) => {
    const mover = findMoverRow(race.meeting, race.race_number || race.race, runnerName || '');
    const move = Number(mover?.pctMove || mover?.change5m || mover?.change1m || 0);
    return Number.isFinite(move) ? move : NaN; // + = drift, - = firm
  };
  const pickedEdge = getRunnerWinEdge(picked);
  // Consistency gate: don't mark a negative-EV runner as the recommended win bet.
  if (!Number.isFinite(pickedEdge) || pickedEdge < 0) {
    const modelFavEdge = getRunnerWinEdge(modelFav);
    if (Number.isFinite(modelFavEdge) && modelFavEdge >= 0) {
      picked = modelFav;
      pickPolicy = 'model_non_negative_edge';
    } else {
      picked = null;
      pickPolicy = 'no_bet_negative_edge';
    }
  }

  if (picked) {
    const driftPct = getRunnerDriftPct(picked);
    const edge = getRunnerWinEdge(picked);
    const heavyDrift = Number.isFinite(driftPct) && driftPct >= 12;
    const cautionDrift = Number.isFinite(driftPct) && driftPct >= 8;
    if (heavyDrift || (cautionDrift && (!Number.isFinite(edge) || edge < 2))) {
      const alt = [modelFav, modelSecond, ewRunner].find(x => x && normalizeRunnerName(x) !== normalizeRunnerName(picked));
      if (alt) {
        picked = alt;
        pickPolicy = 'reconsider_on_market_drift';
      } else {
        picked = null;
        pickPolicy = 'no_bet_drift_risk';
      }
    }
  }

  const winnerKey = buildAiRaceKey(race);
  const hasAiRun = winnerKey ? aiRaceRuns.has(winnerKey) : false;
  const aiWinnerPctRaw = (picked && Number.isFinite(sim[picked])) ? sim[picked] * 100 : (hasClearModelSeparation ? modelFavP * 100 : NaN);
  const aiWinnerPctRounded = Number.isFinite(aiWinnerPctRaw) ? Number(aiWinnerPctRaw.toFixed(1)) : null;
  if (hasAiRun && picked) {
    aiWinnerState.set(winnerKey, {
      meeting: race.meeting,
      race: race.race_number,
      runner: picked,
      winPct: aiWinnerPctRounded,
      updatedAt: Date.now()
    });
  } else if (winnerKey) {
    aiWinnerState.delete(winnerKey);
  }

  const modelFavKey = modelFav ? normalizeRunnerName(modelFav) : '';
  let recommendedKey = picked ? normalizeRunnerName(picked) : '';
  let ewKey = ewRunner ? normalizeRunnerName(ewRunner) : '';
  const bestWinOverlay = winEdgeData.slice().sort((a,b)=>b.edge-a.edge)[0];
  const favKey = fav ? normalizeRunnerName(fav.name) : '';
  const favRunner = favKey ? runners.find(r => normalizeRunnerName(r.name || r.runner_name || '') === favKey) : null;
  const favOdds = favRunner ? oddsOf(favRunner) : NaN;
  const pricedCandidates = runners.map(r => {
    const odds = oddsOf(r);
    const modeledPct = Number(sim[r.name] || 0) * 100;
    const implied = Number.isFinite(odds) ? (100/odds) : NaN;
    const edge = (Number.isFinite(modeledPct) && Number.isFinite(implied)) ? modeledPct - implied : NaN;
    const formSignal = runnerFormSignal(r);
    const formScore = formSignal?.status === 'HOT' ? 3 : formSignal?.status === 'SOLID' ? 2 : formSignal?.status === 'MIXED' ? 1 : 0;
    return {
      runner: r,
      norm: normalizeRunnerName(r.name || r.runner_name || ''),
      odds,
      modeledPct,
      edge,
      formScore
    };
  }).filter(c => c.norm && Number.isFinite(c.odds) && c.odds > 0);
  pricedCandidates.sort((a,b)=> (b.formScore - a.formScore) || (b.odds - a.odds));
  const primaryOddsRunner = pricedCandidates[0] || null;
  let fallbackOddsRunner = null;
  if (bestWinOverlay) {
    const match = runners.find(r => normalizeRunnerName(r.name || r.runner_name || '') === normalizeRunnerName(bestWinOverlay.name));
    const odds = match ? oddsOf(match) : NaN;
    const modeledPct = Number(sim[bestWinOverlay.name] || 0) * 100;
    fallbackOddsRunner = {
      runner: match || { name: bestWinOverlay.name },
      norm: normalizeRunnerName(bestWinOverlay.name),
      odds,
      modeledPct,
      edge: bestWinOverlay.edge
    };
  }
  let finalOddsRunner = primaryOddsRunner || fallbackOddsRunner;
  if (finalOddsRunner) {
    const favRef = Number.isFinite(favOdds) ? favOdds : 0;
    const minOddsForOddsTag = Math.max(1.8, favRef > 0 ? favRef * 1.08 : 2.0);
    const maxOddsForOddsTag = 12;
    const formStatus = runnerFormSignal(finalOddsRunner.runner || {}).status;
    const oddsOk = Number.isFinite(finalOddsRunner.odds) && finalOddsRunner.odds >= minOddsForOddsTag && finalOddsRunner.odds <= maxOddsForOddsTag;
    const edgeOk = true;
    const formOk = formStatus !== 'COLD';
    if (!oddsOk || !edgeOk || !formOk) finalOddsRunner = null;
  }
  let oddsRunnerKey = finalOddsRunner?.norm || '';

  const ewRunnerMetrics = ewCandidateMetrics.find(x => normalizeRunnerName(x.runnerName) === normalizeRunnerName(ewRunner || '')) || null;
  const decisionSignals = {
    recommended: picked,
    recommendedWinEdge: getRunnerWinEdge(picked),
    oddsRunner: finalOddsRunner?.runner?.name || null,
    oddsRunnerOdds: finalOddsRunner?.odds,
    oddsRunnerEdge: finalOddsRunner?.edge,
    ew: ewRunner || null,
    ewPlaceProb: ewRunnerMetrics?.placeProb
  };
  const decisionIssues = validateDecisionSignals(decisionSignals);
  if (decisionIssues.includes('recommended_negative_edge')) picked = null;
  if (decisionIssues.includes('odds_runner_invalid_profile')) finalOddsRunner = null;

  // UI policy: always output a Recommended Bet + Odds Runner for operator workflow.
  let recommendedStatus = 'qualified';
  let oddsRunnerStatus = 'qualified';
  if (!picked) {
    picked = modelFav || modelSecond || ewRunner || null;
    recommendedStatus = 'forced';
  }
  if (!finalOddsRunner) {
    const fallback = pricedCandidates
      .slice()
      .filter(c => c && c.runner && normalizeRunnerName(c.runner.name || c.runner.runner_name || '') !== normalizeRunnerName(picked || ''))
      .sort((a,b) => (Number(b.odds || 0) - Number(a.odds || 0)) || (Number(b.edge || 0) - Number(a.edge || 0)))[0];
    if (fallback) {
      finalOddsRunner = fallback;
      oddsRunnerStatus = 'forced';
    }
  }
  if (!finalOddsRunner) {
    const looseFallbackRunner = runners
      .map(r => {
        const odds = oddsOf(r);
        const name = r.name || r.runner_name || '';
        const modeledPct = Number(sim[name] || 0) * 100;
        const implied = Number.isFinite(odds) && odds > 0 ? (100 / odds) : NaN;
        const edge = Number.isFinite(modeledPct) && Number.isFinite(implied) ? modeledPct - implied : NaN;
        const formSignal = runnerFormSignal(r);
        const formPenalty = formSignal?.status === 'COLD' ? -4 : formSignal?.status === 'MIXED' ? -1 : 0;
        const score = (Number.isFinite(edge) ? edge * 2 : 0) + (Number.isFinite(modeledPct) ? modeledPct : 0) + formPenalty;
        return { runner: r, norm: normalizeRunnerName(name), odds, modeledPct, edge, score, form: formSignal?.status || '' };
      })
      .filter(c => c.norm && c.norm !== normalizeRunnerName(picked || '') && Number.isFinite(c.odds))
      .filter(c => c.odds >= 2 && c.odds <= 12)
      .sort((a,b) => (b.score - a.score) || (Number(b.edge || -999) - Number(a.edge || -999)))[0];
    if (looseFallbackRunner) {
      finalOddsRunner = looseFallbackRunner;
      oddsRunnerStatus = 'forced';
    }
  }

  if (finalOddsRunner) {
    const odds = Number(finalOddsRunner.odds || 0);
    const edge = Number(finalOddsRunner.edge);
    const form = runnerFormSignal(finalOddsRunner.runner || {}).status;
    const invalidOddsRunner = !Number.isFinite(odds) || odds > 30 || form === 'COLD';
    if (invalidOddsRunner) {
      finalOddsRunner = null;
      oddsRunnerStatus = 'forced';
    }
  }

  // Operator rule: always output an Odds Runner.
  if (!finalOddsRunner) {
    const forcedOddsRunner = runners
      .map(r => {
        const odds = oddsOf(r);
        const name = r.name || r.runner_name || '';
        const modeledPct = Number(sim[name] || 0) * 100;
        const implied = Number.isFinite(odds) && odds > 0 ? (100 / odds) : NaN;
        const edge = Number.isFinite(modeledPct) && Number.isFinite(implied) ? modeledPct - implied : NaN;
        const signal = runnerFormSignal(r);
        const formPenalty = signal?.status === 'COLD' ? -3 : 0;
        const score = (Number.isFinite(modeledPct) ? modeledPct : 0) + (Number.isFinite(edge) ? edge : 0) + formPenalty;
        return { runner: r, norm: normalizeRunnerName(name), odds, modeledPct, edge, score };
      })
      .filter(c => c.norm && c.norm !== normalizeRunnerName(picked || '') && Number.isFinite(c.odds) && c.odds >= 2 && c.odds <= 15)
      .sort((a,b) => b.score - a.score)[0];

    if (forcedOddsRunner) {
      finalOddsRunner = forcedOddsRunner;
      oddsRunnerStatus = 'forced';
    }
  }

  recommendedKey = picked ? normalizeRunnerName(picked) : '';
  ewKey = ewRunner ? normalizeRunnerName(ewRunner) : '';
  oddsRunnerKey = finalOddsRunner?.norm || '';

  const calcSignalStrength = (runnerName) => {
    if (!runnerName) return null;
    const runnerObj = runners.find(r => normalizeRunnerName(r.name || r.runner_name || '') === normalizeRunnerName(runnerName));
    const odds = runnerObj ? oddsOf(runnerObj) : NaN;
    const runnerKey = cleanRunnerText(runnerName);
    const modelPct = Number.isFinite(sim[runnerKey]) ? (sim[runnerKey] * 100) : NaN;
    const syntheticReason = `${Number.isFinite(modelPct) ? `p=${modelPct.toFixed(1)}` : ''} ${Number.isFinite(odds) ? `@ $${odds.toFixed(2)}` : ''}`.trim();
    const score = signalScore(syntheticReason, 'win', runnerName);
    return Number.isFinite(score) ? score : null;
  };

  const sanitizedDecision = nextBestCandidates({
    recommendedName: picked || null,
    recommendedKey,
    oddsRunner: finalOddsRunner
  });
  recommendedKey = sanitizedDecision.recommendedKey;
  finalOddsRunner = sanitizedDecision.oddsRunner;
  oddsRunnerKey = sanitizedDecision.oddsRunnerKey;

  const decisionEngine = {
    recommended: {
      name: sanitizedDecision.recommendedName || null,
      key: recommendedKey,
      status: recommendedStatus,
      signalStrength: calcSignalStrength(sanitizedDecision.recommendedName)
    },
    oddsRunner: {
      name: finalOddsRunner?.runner?.name || null,
      key: oddsRunnerKey,
      status: oddsRunnerStatus,
      signalStrength: calcSignalStrength(finalOddsRunner?.runner?.name)
    },
    ew: { name: ewRunner || null, key: ewKey, status: ewRunner ? 'qualified' : 'forced' },
    issues: decisionIssues
  };

  const longModelCandidates = runners
    .map(r => {
      const odds = oddsOf(r);
      const signal = runnerFormSignal(r);
      const blend = runnerConfidenceBlend(r, race, Number(sim[r.name] || 0));
      const trackSignal = blend.trackSignal;
      const modeledPct = Number(blend.finalProb || 0) * 100;
      const implied = Number.isFinite(odds) && odds > 0 ? (100 / odds) : NaN;
      const edge = Number.isFinite(modeledPct) && Number.isFinite(implied) ? (modeledPct - implied) : NaN;
      const formAvg = runnerThreeStartAvg(r);
      const hardFail = (signal?.lastStart ?? 99) >= 9 && (signal?.formScore ?? -99) < 0;
      const map = String(r?.speedmap || '').toLowerCase();
      const mapPenalty = (!map || /back|off pace/.test(map)) ? 1 : 0;
      const goodForm = signal && (signal.status === 'HOT' || signal.status === 'SOLID');
      const trackOk = trackSignal.label !== 'DISLIKES THIS GROUND';
      return { r, odds, goodForm, modeledPct, edge, formAvg, hardFail, mapPenalty, trackOk, confidence: blend.confidence, trackSignal };
    })
    .filter(x => Number.isFinite(x.odds) && x.odds >= 8 && x.goodForm && x.trackOk && !x.hardFail && x.modeledPct >= 7.5)
    .sort((a,b) => (b.edge ?? -999) - (a.edge ?? -999) || (b.confidence - a.confidence) || (a.formAvg - b.formAvg) || (a.mapPenalty - b.mapPenalty) || b.modeledPct - a.modeledPct);
  const longTop = longModelCandidates[0]?.r || null;
  const longRunnerKeys = new Set(longTop ? [normalizeRunnerName(longTop.name || longTop.runner_name || '')].filter(Boolean) : []);

  // Tag sanity audit (avoid contradictory labels).
  const tagAuditIssues = [];
  if (recommendedKey && oddsRunnerKey && recommendedKey === oddsRunnerKey) {
    finalOddsRunner = null;
    oddsRunnerKey = '';
    tagAuditIssues.push('odds_runner_same_as_recommended');
  }
  if (recommendedKey) {
    const recRunner = runners.find(r => normalizeRunnerName(r.name || r.runner_name || '') === recommendedKey);
    const recForm = runnerFormSignal(recRunner || {}).status;
    if (recForm === 'COLD') {
      picked = modelFav ? cleanRunnerText(modelFav) : '';
      recommendedKey = modelFav ? normalizeRunnerName(modelFav) : '';
      tagAuditIssues.push('recommended_was_cold_form');
    }
  }
  decisionEngine.recommended.key = recommendedKey;
  decisionEngine.recommended.name = picked || null;
  decisionEngine.oddsRunner.key = oddsRunnerKey;
  decisionEngine.oddsRunner.name = finalOddsRunner?.runner?.name || null;
  if (tagAuditIssues.length) console.warn('tag_audit_adjustments', { meeting: race.meeting, race: race.race_number, issues: tagAuditIssues });

  const storedAiWinner = winnerKey ? aiWinnerState.get(winnerKey) : null;
  const aiWinnerRunner = storedAiWinner?.runner || (hasAiRun ? picked : null);
  const aiWinnerTagKey = aiWinnerRunner ? normalizeRunnerName(aiWinnerRunner) : '';
  const aiWinnerPctValue = Number.isFinite(storedAiWinner?.winPct) ? storedAiWinner.winPct : (hasAiRun ? aiWinnerPctRounded : null);
  const pedigreeAdvantageMap = computeRacePedigreeAdvantageMap(race, runners);
  const buildRunnerLink = (text, runnerName) => {
    const baseText = (text === null || text === undefined) ? '—' : String(text);
    if (!runnerName) return escapeHtml(baseText);
    const runnerLabel = cleanRunnerText(runnerName);
    if (!runnerLabel) return escapeHtml(baseText);
    return `<button class='analysis-runner-link analysis-odds-runner-btn' data-meeting='${escapeAttr(race.meeting)}' data-race='${escapeAttr(race.race_number || race.race || '')}' data-runner='${escapeAttr(runnerLabel)}'>${escapeHtml(baseText)}</button>`;
  };

  const driftReconsiderTag = pickPolicy === 'reconsider_on_market_drift' ? ' (reconsidered on drift)' : '';
  const recommendedLabel = picked ? `${cleanRunnerText(picked)}${driftReconsiderTag}` : 'PASS (no +EV win edge)';
  const recommendedDisplay = buildRunnerLink(recommendedLabel, picked);
  const oddsRunnerDisplayRaw = finalOddsRunner ? (()=>{
    const name = cleanRunnerText(finalOddsRunner.runner?.name || '');
    const stats = [];
    if (Number.isFinite(finalOddsRunner.modeledPct)) stats.push(`${finalOddsRunner.modeledPct.toFixed(1)}%`);
    if (Number.isFinite(finalOddsRunner.odds)) stats.push(`@ $${finalOddsRunner.odds.toFixed(2)}`);
    const edgePart = Number.isFinite(finalOddsRunner.edge) ? ` ${(finalOddsRunner.edge >= 0 ? '+' : '') + finalOddsRunner.edge.toFixed(1)} pts` : '';
    return `${name}${stats.length ? ` (${stats.join(' ')})` : ''}${edgePart}`;
  })() : 'No qualifying odds runner';
  const oddsRunnerDisplay = buildRunnerLink(oddsRunnerDisplayRaw, finalOddsRunner?.runner?.name || finalOddsRunner?.runner?.selection || finalOddsRunner?.runner?.runner);
  const ewDisplay = buildRunnerLink(ewRunner ? cleanRunnerText(ewRunner) : 'No EW qualifier', ewRunner);
  const aiWinnerLabelText = (hasAiRun && aiWinnerRunner) ? 'AI Winner' : 'Model Winner';
  let aiWinnerDisplay = '';
  let aiWinnerRunnerName = null;
  if (hasAiRun && aiWinnerRunner) {
    aiWinnerRunnerName = aiWinnerRunner;
    aiWinnerDisplay = `${cleanRunnerText(aiWinnerRunner)}${Number.isFinite(aiWinnerPctValue) ? ` (${aiWinnerPctValue.toFixed(1)}%)` : ''}`;
  } else if (modelFav) {
    aiWinnerRunnerName = modelFav;
    aiWinnerDisplay = `${cleanRunnerText(modelFav)}${Number.isFinite(modelFavP) ? ` (${(modelFavP*100).toFixed(1)}%)` : ''}`;
  } else {
    aiWinnerDisplay = `<span class='key-signal-muted'>Model leader pending</span>`;
  }
  if (aiWinnerRunnerName) {
    aiWinnerDisplay = buildRunnerLink(aiWinnerDisplay, aiWinnerRunnerName);
  }

  const renderRunnerTagRow = (runner) => {
    const norm = normalizeRunnerName(runner?.name || '');
    if (!norm) return '';
    const tags = [];
    const trackedBet = findTrackedBet(race?.meeting, race?.race_number || race?.race, runner?.name || runner?.runner_name || runner?.selection || '');
    if (trackedBet) tags.push(`<span class='tag tracked'>${trackedGroupMeta(trackedBet).isMulti ? 'MULTI' : 'TRACKED'}</span>`);
    if (decisionEngine.recommended.key && norm === decisionEngine.recommended.key) {
      tags.push(`<span class='tag win'>Recommended Bet</span>`);
    }
    if (modelFavKey && norm === modelFavKey) tags.push("<span class='tag model'>#1 Model</span>");
    if (aiWinnerTagKey && norm === aiWinnerTagKey) tags.push("<span class='tag ai-winner'>AI Winner</span>");
    if (decisionEngine.oddsRunner.key && norm === decisionEngine.oddsRunner.key) {
      tags.push(`<span class='tag odds'>Odds Runner</span>`);
    }
    if (ewKey && norm === ewKey) tags.push("<span class='tag ew'>EW</span>");
    if (longRunnerKeys.has(norm)) tags.push("<span class='tag long'>LONG</span>");
    const pedigreeSignal = pedigreeAdvantageMap.get(norm);
    if (pedigreeSignal?.qualifies) tags.push(`<span class='tag pedigree-adv' title='${escapeAttr(pedigreeSignal.summary || `Pedigree Advantage ${pedigreeSignal.score?.toFixed?.(1) || ''}`)}' style='background:linear-gradient(135deg,#ffd54a,#c89b1d);color:#1c1606;border-color:#f4cf63'>Pedigree Advantage</span>`);
    const moveTags = inheritMoveTags(race.meeting, race.race_number || race.race, runner.name || runner.runner_name || runner.selection || '');
    if (moveTags.length) tags.push(...moveTags);
    if (runnerHasStrongTrials(runner)) tags.push("<span class='tag form'>Trial Form</span>");
    if (!tags.length) return '';
    return `<span class='runner-tag-row'>${tags.join(' ')}</span>`;
  };

  const edgeVizRows = runners.map(r => {
    const odds = oddsOf(r);
    const impliedPct = Number.isFinite(odds) ? (100/odds) : NaN;
    const rawProb = Number(sim[r.name] || 0);
    const blend = runnerConfidenceBlend(r, race, rawProb);
    const modeledPct = Number(blend.finalProb || 0) * 100;
    const edgePct = Number.isFinite(modeledPct) && Number.isFinite(impliedPct) ? (modeledPct - impliedPct) : NaN;
    return {
      name: cleanRunnerText(r.name || r.runner_name || ''),
      odds: Number.isFinite(odds) ? odds : null,
      impliedPct: Number.isFinite(impliedPct) ? Number(impliedPct.toFixed(1)) : null,
      modeledPct: Number.isFinite(modeledPct) ? Number(modeledPct.toFixed(1)) : null,
      edgePct: Number.isFinite(edgePct) ? Number(edgePct.toFixed(1)) : null,
      confidence: Number.isFinite(blend.confidence) ? Number((blend.confidence * 100).toFixed(0)) : null,
      trackLabel: blend.trackSignal?.label || null
    };
  }).filter(row => row.name);

  const oddsRows = runners.map(r => {
    const odds = oddsOf(r);
    const implied = Number.isFinite(odds) ? (100/odds) : NaN;
    const rawProb = Number(sim[r.name] || 0);
    const blend = runnerConfidenceBlend(r, race, rawProb);
    const modeled = Number(blend.finalProb || 0) * 100;
    const edge = Number.isFinite(modeled) && Number.isFinite(implied) ? (modeled - implied) : NaN;
    const placeOdds = placeOddsOf(r);
    const placeImplied = Number.isFinite(placeOdds) ? (100/placeOdds) : NaN;
    const modeledPlace = modeledPlacePct(r, { sim, placeOddsGetter: placeOddsOf });
    const placeEdge = Number.isFinite(modeledPlace) && Number.isFinite(placeImplied) ? (modeledPlace - placeImplied) : NaN;
    const oddsClasses = trackRunnerOdds(race, r, Number.isFinite(odds) ? odds : null, Number.isFinite(placeOdds) ? placeOdds : null);
    const winClass = oddsClasses?.win || '';
    const placeClass = oddsClasses?.place || '';
    const tags = renderRunnerTagRow(r);
    const trackedBet = findTrackedBet(race?.meeting, race?.race_number || race?.race, r?.name || r?.runner_name || r?.selection || '');
    const runnerBtn = `<button class='bet-btn analysis-odds-runner-btn' data-meeting='${escapeAttr(race.meeting)}' data-race='${escapeAttr(race.race_number || race.race || '')}' data-runner='${escapeAttr(cleanRunnerText(r.name))}'><span class='bet-icon'>🐎</span>${cleanRunnerText(r.name)}</button>`;
    const trackBtn = buildTrackRunnerButtonsHtml(race, { name: cleanRunnerText(r.name) }, trackedBet);
    const runnerCell = `<div class='runner-name-cell'>${runnerBtn}${tags}</div>`;
    const numberRaw = r.number ?? r.runner_number ?? r.saddle_number ?? r.horse_number ?? r.program_number ?? r.tab_no ?? null;
    const runnerNumber = (numberRaw === 0 || numberRaw) ? String(numberRaw).trim() : '';
    const formSignal = runnerFormSignal(r);
    const pedigreeSignal = pedigreeAdvantageMap.get(normalizeRunnerName(r.name || r.runner_name || ''));
    const formPattern = r.last_twenty_starts || r.form || r.last_five_starts || r.recent_form || '—';
    const formTag = formSignal ? renderFormStatusTag(formSignal, formSignal.summary || '') : '';
    const trialTag = runnerHasStrongTrials(r) ? `<span class='tag form'>Trial Form</span>` : '';
    const pedigreeTag = pedigreeSignal?.qualifies ? `<span class='tag pedigree-adv' title='${escapeAttr(pedigreeSignal.summary || '')}' style='background:linear-gradient(135deg,#ffd54a,#c89b1d);color:#1c1606;border-color:#f4cf63'>Pedigree Advantage ${Number.isFinite(pedigreeSignal.score) ? pedigreeSignal.score.toFixed(1) : ''}</span>` : '';
    const pedigreeFitTxt = Number.isFinite(pedigreeSignal?.score) ? pedigreeSignal.score.toFixed(1) : '—';
    const pedigreeConfidenceTxt = Number.isFinite(pedigreeSignal?.confidence) ? `${(pedigreeSignal.confidence * 100).toFixed(0)}%` : '—';
    const pedigreeEdgeTxt = Number.isFinite(pedigreeSignal?.relativeEdge) ? `${pedigreeSignal.relativeEdge >= 0 ? '+' : ''}${pedigreeSignal.relativeEdge.toFixed(1)}` : '—';
    const formCell = `<div class='form-pattern'>${formPattern || '—'}</div>${formTag ? `<div class='form-status-tag'>${formTag}</div>` : ''}${trialTag ? `<div class='form-status-tag'>${trialTag}</div>` : ''}${pedigreeTag ? `<div class='form-status-tag'>${pedigreeTag}</div>` : ''}`;
    const jockeyCell = r.jockey
      ? `<button class='jockey-profile-btn' data-jockey='${escapeAttr(String(r.jockey))}' data-race-key='${escapeAttr(String(race.key || ''))}'>${escapeHtml(String(r.jockey))}</button>`
      : '—';
    const trainerCell = escapeHtml(r.trainer || '—');
    const jockeyEdge = jockeyEdgePct(r);
    const jockeyEdgeTxt = Number.isFinite(jockeyEdge) ? `${jockeyEdge >= 0 ? '+' : ''}${jockeyEdge.toFixed(1)} pts` : '—';
    return `<tr><td class='track-cell'>${trackBtn}</td><td class='runner-num-cell'>${escapeHtml(runnerNumber || '—')}</td><td>${runnerCell}</td><td>${escapeHtml(r.barrier || '—')}</td><td>${jockeyCell}</td><td>${trainerCell}</td><td>${formCell}</td><td>${jockeyEdgeTxt}</td><td>${pedigreeFitTxt}</td><td>${pedigreeConfidenceTxt}</td><td>${pedigreeEdgeTxt}</td><td class='odds-cell ${winClass}'>${Number.isFinite(odds) ? odds.toFixed(2) : '—'}</td><td>${Number.isFinite(modeled) ? modeled.toFixed(1)+'%' : '—'}</td><td>${Number.isFinite(implied) ? implied.toFixed(1)+'%' : '—'}</td><td>${Number.isFinite(edge) ? (edge>=0?'+':'')+edge.toFixed(1)+' pts' : '—'}</td><td class='odds-cell ${placeClass}'>${Number.isFinite(placeOdds) ? placeOdds.toFixed(2) : '—'}</td><td>${Number.isFinite(modeledPlace) ? modeledPlace.toFixed(1)+'%' : '—'}</td><td>${Number.isFinite(placeImplied) ? placeImplied.toFixed(1)+'%' : '—'}</td><td>${Number.isFinite(placeEdge) ? (placeEdge>=0?'+':'')+placeEdge.toFixed(1)+' pts' : '—'}</td></tr>`;
  }).join('');
  const topEdgeRunner = winEdgeData.slice().sort((a,b)=>b.edge-a.edge)[0]?.name || 'No clear overs';
  const punterPanel = `<ul>
    <li>${escapeHtml(punters[0].name)}: “${escapeHtml(picked || 'No standout')} controls the shape for mine.”</li>
    <li>${escapeHtml(punters[1].name)}: “${escapeHtml(paceLeaders[0] || 'Map unclear')} decides whether we can press.”</li>
    <li>${escapeHtml(punters[2].name)}: “${escapeHtml(topEdgeRunner)} is the bet if price holds.”</li>
  </ul>`;

  const saverLine = (ewRunner && ewRunner !== picked) ? `<div>Saver/Value: ${ewRunner} (each-way credentials).</div>` : '';
  const confidence = Number.isFinite(aiWinnerPctRaw) ? Math.min(90, Math.round(aiWinnerPctRaw + 15)) : (hasClearModelSeparation ? 68 : 54);
  const invalidation = hasClearModelSeparation ? 'Invalidate if pace collapses or track downgrades sharply.' : 'No bet if map swings or price collapses.';

  const headerMetaParts = [];
  if (race.distance) headerMetaParts.push(`${race.distance}m`);
  if (race.track_condition && race.track_condition !== 'n/a') headerMetaParts.push(`Track ${race.track_condition}`);
  if (race.rail_position && race.rail_position !== 'n/a') headerMetaParts.push(`Rail ${race.rail_position}`);
  if (race.weather && race.weather !== 'n/a') headerMetaParts.push(`Weather ${race.weather}`);
  const headerMetaLine = headerMetaParts.length ? `Official: ${headerMetaParts.join(' · ')}` : 'Awaiting official track + weather intel.';
  const loveracingHeaderParts = [];
  if (race.loveracing?.track_condition && race.loveracing.track_condition !== race.track_condition) loveracingHeaderParts.push(`Track ${race.loveracing.track_condition}`);
  if (race.loveracing?.rail_position && race.loveracing.rail_position !== race.rail_position) loveracingHeaderParts.push(`Rail ${race.loveracing.rail_position}`);
  if (race.loveracing?.weather && race.loveracing.weather !== race.weather) loveracingHeaderParts.push(`Weather ${race.loveracing.weather}`);
  const loveracingHeaderLine = loveracingHeaderParts.length ? `Loveracing: ${loveracingHeaderParts.join(' · ')}` : '';
  const conflictLine = loveracingHeaderParts.length ? '⚠️ Loveracing differs from official track/rail/weather.' : '';
  const raceRunnerNames = (race.runners || []).map(r => cleanRunnerText(r.name || r.runner_name || '')).filter(Boolean);
  const rawLoveracingNote = race.loveracing?.race_commentary || '';
  const loveracingNoteHits = rawLoveracingNote
    ? raceRunnerNames.filter(name => rawLoveracingNote.toLowerCase().includes(name.toLowerCase()))
    : [];
  const loveracingNoteText = (rawLoveracingNote && loveracingNoteHits.length) ? rawLoveracingNote : '';

  const altCommentBits = [];
  const trialCount = runners.filter(r => runnerHasStrongTrials(r)).length;
  if (trialCount > 0) altCommentBits.push(`${trialCount} runner${trialCount === 1 ? '' : 's'} flagged with strong trial indicators`);
  const speedTagged = runners.filter(r => (r?.racingaus?.last600_best || r?.racingaus?.last600_avg)).length;
  if (speedTagged > 0) altCommentBits.push(`${speedTagged} runner${speedTagged === 1 ? '' : 's'} with RacingAUS L600 data`);
  const formComments = runners
    .map(r => String(r.form_comment || '').trim())
    .filter(x => x && x.toLowerCase() !== 'n/a')
    .slice(0, 2);
  if (formComments.length) altCommentBits.push(formComments.join(' · '));
  const altCommentary = !loveracingNoteText && altCommentBits.length
    ? `Alt intel (RacingAUS/Form): ${altCommentBits.join(' · ')}`
    : '';
  const weatherFallbackLine = (!race.weather || String(race.weather).toLowerCase() === 'n/a') && !race.loveracing?.weather
    ? `Weather fallback: pending official feed; using track condition (${race.track_condition || 'n/a'}) as surface proxy.`
    : '';

  const headerBlock = `
    <div class='analysis-header'>
      <div>
        <div><b>🏇 ${race.meeting} R${race.race_number} — ${race.description || ''}</b></div>
        <div class='analysis-meta-line'>${headerMetaLine}</div>
        ${loveracingHeaderLine ? `<div class='analysis-meta-line'>${loveracingHeaderLine}</div>` : ''}
        ${conflictLine ? `<div class='analysis-meta-line conflict-note'>${conflictLine}</div>` : ''}
        ${loveracingNoteText ? `<div class='analysis-meta-line loveracing-note'>${loveracingNoteText}</div>` : ''}
        ${altCommentary ? `<div class='analysis-meta-line'>${altCommentary}</div>` : ''}
        ${weatherFallbackLine ? `<div class='analysis-meta-line'>${weatherFallbackLine}</div>` : ''}
      </div>
    </div>`;

  const raceCardMarkup = `
    <div class='analysis-section race-card-section'>
      <h3>Race Card</h3>
      ${buildRaceCardSection(race, enrichedRunners)}
    </div>`;

  const horseProfilesBlock = `
    <div class='analysis-block horse-profiles-block'>
      <b>Sectionals & Profiles</b>
      ${horseProfiles}
    </div>`;

  const speedAnalysisBlock = `
    <div class='analysis-block speed-analysis-block'>
      <b>Speed Analysis</b>
      ${speedTableHtml}
    </div>`;

  const keySignalsBlock = `
    <div class='analysis-block key-signals-block'>
      <b>Key Signals</b>
      <div class='key-signals-grid'>
        <div class='key-signal'><div class='label'>Recommended Bet <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.recommended)}'>?</span></div><div class='value'>${recommendedDisplay}</div></div>
        <div class='key-signal'><div class='label'>Odds Runner <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.oddsRunner)}'>?</span></div><div class='value'>${oddsRunnerDisplay}</div></div>
        <div class='key-signal'><div class='label'>EW <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.ew)}'>?</span></div><div class='value'>${ewDisplay}</div></div>
        <div class='key-signal'><div class='label'>${aiWinnerLabelText} <span class='help-hint' title='Highest model/AI win probability runner for this race view.'>?</span></div><div class='value'>${aiWinnerDisplay}</div></div>
      </div>
    </div>`;

  const simulationContent = `
      <div class='analysis-block ai-model-block'>
        <div class='ai-model-actions'>
          <button id='aiAnalyseBtn' class='btn' type='button'>AI Analyse</button>
          <div class='ai-model-note analysis-ai-model-note'>Using ${selectedAiModel.model || '—'} (${selectedAiModel.provider || '—'})</div>
        </div>
      </div>
      ${keySignalsBlock}
      <div class='analysis-block'>
        <b>Verdict / Edge / Risk</b>
        <div>${summary || 'Market picture still forming.'}</div>
        <div>Edge: ${hasClearModelSeparation ? 'Model separation >1.25×.' : 'Clustered market — price sensitive.'}</div>
        <div>Jockey Edge: ${topJockeyEdge ? `${escapeHtml(topJockeyEdge.name)} ${topJockeyEdge.edge >= 0 ? '+' : ''}${topJockeyEdge.edge.toFixed(1)} pts vs field` : 'No jockey edge signal yet.'}</div>
        ${meetingBias ? `<div>Track Bias Input: ${meetingBias.insideRail ? 'inside rail' : ''}${meetingBias.insideRail && (meetingBias.swoopers || meetingBias.leaders) ? ' + ' : ''}${meetingBias.swoopers ? 'swoopers/off-speed' : ''}${(meetingBias.insideRail || meetingBias.swoopers) && meetingBias.leaders ? ' + ' : ''}${meetingBias.leaders ? 'leaders/on-pace' : ''} (user supplied).</div>` : ''}
        <div>Risk: ${race.track_condition || 'Track n/a'} / ${paceLeaders.length ? 'pace known' : 'pace unclear'} · Invalidation: ${invalidation}</div>
      </div>
      <div class='analysis-block'>
        <b>Speed Map Projection</b>
        ${speedMapHtml}
      </div>
      <div class='analysis-block'>
        <div class='analysis-block-head'>
          <b>Odds vs Model Probabilities <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.edge)}'>?</span></b>
          <button id='pollOddsBtn' class='btn btn-ghost compact-btn' type='button'>Poll Odds</button>
        </div>
        <div class='analysis-table-scroll'>
          <table class='analysis-table'><tr><th title='Track runner'></th><th title='Saddle / runner number'>#</th><th>Runner</th><th title='Barrier draw'>Gate</th><th>Jockey</th><th>Trainer</th><th title='Recent form pattern + status'>Form</th><th title='Jockey edge vs field average model % (same race). Positive = jockey riding stronger modeled book.'>Jockey Edge <span class='help-hint' title='Jockey edge vs field average model % (same race). Positive = jockey riding stronger modeled book.'>?</span></th><th title='Pedigree fit score for this race archetype'>Ped Fit</th><th title='Confidence in pedigree assessment'>Ped Conf</th><th title='Field-relative pedigree edge'>Ped Edge</th><th title='Current market win odds'>Win Odds</th><th title='${escapeAttr(SIGNAL_GLOSSARY.model)}'>Win Model% <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.model)}'>?</span></th><th title='${escapeAttr(SIGNAL_GLOSSARY.implied)}'>Win Implied% <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.implied)}'>?</span></th><th title='${escapeAttr(SIGNAL_GLOSSARY.edge)}'>Win Edge <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.edge)}'>?</span></th><th title='Current market place odds'>Place Odds</th><th title='${escapeAttr(SIGNAL_GLOSSARY.model)}'>Place Model% <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.model)}'>?</span></th><th title='${escapeAttr(SIGNAL_GLOSSARY.implied)}'>Place Implied% <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.implied)}'>?</span></th><th title='${escapeAttr(SIGNAL_GLOSSARY.edge)}'>Place Edge <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.edge)}'>?</span></th></tr>${oddsRows}</table>
        </div>
      </div>
      <div class='analysis-split'>
        <div class='analysis-block'>
          <b>Edge Visualisation (Implied vs Model vs Edge) <span class='help-hint' title='${escapeAttr(SIGNAL_GLOSSARY.edge)}'>?</span></b>
          <div style='height:240px'><canvas id='analysisEdgeChart'></canvas></div>
        </div>
        <div class='analysis-block'>
          <b>Monte Carlo (999,999 runs)</b>
          <div style='width:100%;height:240px;margin:8px 0'><canvas id='analysisMonteChart'></canvas></div>
          <ul>${topSim.map(([name,p])=>`<li>${name}: ${(p*100).toFixed(1)}%</li>`).join('')}</ul>
        </div>
      </div>
      <div class='analysis-block'>
        <b>Value Board</b>
        <div><u>Win Overlays</u></div>
        <ul>${winOverlays}</ul>
        <div><u>Win Underlays / danger prices</u></div>
        <ul>${winUnderlays}</ul>
        <div><u>Place Overlays</u></div>
        <ul>${placeOverlays}</ul>
        <div><u>Place Underlays</u></div>
        <ul>${placeUnderlays}</ul>
      </div>
      <div class='analysis-block'>
        <b>Punter Panel Debate</b>
        ${punterPanel}
      </div>
      <div class='analysis-block'>
        <b>Final Tips</b>
        <div>Primary play: ${picked || 'No bet'} (${pickPolicy.replace('_',' ')}).</div>
        ${saverLine}
        <div>Confidence: ${confidence}% · Monitor market for ${picked || 'primary'}.</div>
      </div>
      ${dataGaps.length ? `<div class='analysis-block'>
        <b>Data gaps detected</b>
        <ul>${dataGaps.map(item => `<li>${item}</li>`).join('')}</ul>
      </div>` : ''}
      ${runnerMetricsBlock}`;
const simulationPanelHtml = `
    <div class='analysis-section simulation-section'>
      <h3>Odds & AI Engine</h3>
      ${simulationContent}
    </div>`;
  const speedPanelHtml = `
    <div class='analysis-section speed-section'>
      <h3>Speed Analysis</h3>
      ${speedAnalysisBlock}
    </div>`;
  currentSimulationHtml = simulationPanelHtml;
  currentSimulationTitle = `${race.meeting} R${race.race_number} — Odds & AI Engine`;

  const primaryPanel = viewMode === 'engine' ? simulationPanelHtml : (viewMode === 'speed' ? speedPanelHtml : raceCardMarkup);
  const columnClass = viewMode === 'engine' ? 'simulation-column' : (viewMode === 'speed' ? 'speed-column' : 'race-card-column');
  const html = `${headerBlock}
  <div class='analysis-grid'>
    <div class='analysis-column ${columnClass}'>
      ${primaryPanel}
    </div>
  </div>`;
  const monteTagMeta = (runnerName) => {
    const norm = normalizeRunnerName(runnerName || '');
    if (!norm) return { tag: 'other', color: 'rgba(122,163,199,0.55)', border: '#7aa3c7' };
    if (recommendedKey && norm === recommendedKey) return { tag: 'tag.win', color: 'rgba(197,255,0,0.72)', border: '#c5ff00' };
    if (aiWinnerTagKey && norm === aiWinnerTagKey) return { tag: 'tag.ai-winner', color: 'rgba(197,255,0,0.72)', border: '#c5ff00' };
    if (modelFavKey && norm === modelFavKey) return { tag: 'tag.model', color: 'rgba(197,255,0,0.72)', border: '#c5ff00' };
    if (oddsRunnerKey && norm === oddsRunnerKey) return { tag: 'tag.value', color: 'rgba(36,50,68,0.72)', border: '#243244' };
    if (ewKey && norm === ewKey) return { tag: 'tag.ew', color: 'rgba(245,192,102,0.75)', border: '#f5c066' };
    if (longRunnerKeys.has(norm)) return { tag: 'tag.long', color: 'rgba(179,139,255,0.72)', border: '#b38bff' };
    return { tag: 'other', color: 'rgba(122,163,199,0.55)', border: '#7aa3c7' };
  };

  latestAnalysisSignals = {
    meeting: race.meeting || '',
    race: race.race_number || race.race || '',
    raceKey: race.key || '',
    winRunner: picked ? cleanRunnerText(picked) : null,
    ewRunner: ewRunner ? cleanRunnerText(ewRunner) : null,
    aiRunner: aiWinnerRunnerName ? cleanRunnerText(aiWinnerRunnerName) : null,
    oddsRunner: finalOddsRunner?.runner?.name ? cleanRunnerText(finalOddsRunner.runner.name) : null,
    longRunners: Array.from(longRunnerKeys || []).map(name => cleanRunnerText(name)),
    edgeRows: edgeVizRows,
    monteRows: topSim.map(([name, p]) => {
      const meta = monteTagMeta(name);
      return {
        name: cleanRunnerText(name),
        winPct: Number((p * 100).toFixed(2)),
        tag: meta.tag,
        color: meta.color,
        border: meta.border
      };
    })
  };
  setTimeout(() => renderAnalysisVisuals(), 0);
  return html;

}


function normalizePersonName(name){
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function collectJockeyProfile(jockeyName, contextRace){
  const target = normalizePersonName(jockeyName);
  if (!target) return null;

  const rides = [];
  (racesCache || []).forEach(race => {
    (race?.runners || []).forEach(runner => {
      if (normalizePersonName(runner?.jockey) !== target) return;
      rides.push({ race, runner });
    });
  });

  if (!rides.length) return null;

  const oddsVals = rides
    .map(x => Number(x.runner?.odds || x.runner?.fixed_win || x.runner?.tote_win || 0))
    .filter(v => Number.isFinite(v) && v > 0);
  const avgOdds = oddsVals.length ? (oddsVals.reduce((a,b)=>a+b,0) / oddsVals.length) : null;
  const avgImplied = oddsVals.length ? (oddsVals.reduce((a,b)=>a + (100 / b), 0) / oddsVals.length) : null;

  const modelVals = rides
    .map(x => {
      const direct = Number(x.runner?.win_p);
      if (Number.isFinite(direct) && direct > 0) return direct;
      const alt = Number(x.runner?.modelProb);
      if (Number.isFinite(alt) && alt > 0) return alt * 100;
      const odds = Number(x.runner?.odds || x.runner?.fixed_win || x.runner?.tote_win || 0);
      if (Number.isFinite(odds) && odds > 0) return 100 / odds;
      return NaN;
    })
    .filter(v => Number.isFinite(v) && v > 0);
  const avgModel = modelVals.length ? (modelVals.reduce((a,b)=>a+b,0) / modelVals.length) : null;

  const favCount = rides.filter(x => !!x.runner?.favourite).length;

  const rankedRides = [...rides]
    .sort((a, b) => (Number(b.runner?.win_p || 0) - Number(a.runner?.win_p || 0)))
    .slice(0, 6)
    .map(x => {
      const odds = Number(x.runner?.odds || x.runner?.fixed_win || x.runner?.tote_win || 0);
      const oddsText = Number.isFinite(odds) && odds > 0 ? odds.toFixed(2) : '—';
      const modelPct = (() => {
        const direct = Number(x.runner?.win_p);
        if (Number.isFinite(direct) && direct > 0) return direct;
        const alt = Number(x.runner?.modelProb);
        if (Number.isFinite(alt) && alt > 0) return alt * 100;
        const odds = Number(x.runner?.odds || x.runner?.fixed_win || x.runner?.tote_win || 0);
        if (Number.isFinite(odds) && odds > 0) return 100 / odds;
        return NaN;
      })();
      const modelText = Number.isFinite(modelPct) ? `${Number(modelPct).toFixed(1)}%` : '—';
      return {
        meeting: x.race?.meeting || '—',
        raceNo: x.race?.race_number || x.race?.race || '—',
        horse: x.runner?.name || x.runner?.runner_name || '—',
        barrier: x.runner?.barrier || '—',
        odds: oddsText,
        model: modelText,
        trainer: x.runner?.trainer || '—'
      };
    });

  const contextMeetingKey = normalizePersonName(contextRace?.meeting || '');
  const ridesAtMeeting = contextMeetingKey
    ? rides.filter(x => normalizePersonName(x.race?.meeting || '') === contextMeetingKey).length
    : 0;
  const nowTs = Date.now();
  const upcomingRides = rides.filter(x => {
    const ts = parseTimeValue(x.race?.advertised_start || x.race?.start_time_nz);
    return Number.isFinite(ts) && ts >= nowTs;
  }).length;

  return {
    jockeyName,
    ridesCount: rides.length,
    favourites: favCount,
    avgOdds,
    avgImplied,
    avgModel,
    ridesAtMeeting,
    upcomingRides,
    rankedRides
  };
}

function openJockeyProfile(jockeyName, race){
  const profile = collectJockeyProfile(jockeyName, race);
  if (!profile) {
    openSummaryPopup(`Jockey: ${jockeyName || 'Unknown'}`, `<div>No jockey stats found in current cache.</div>`);
    return;
  }

  const statLine = [
    `<b>Rides in cache:</b> ${profile.ridesCount}`,
    `<b>Favourites:</b> ${profile.favourites}`,
    `<b>Avg Win Odds:</b> ${Number.isFinite(profile.avgOdds) ? profile.avgOdds.toFixed(2) : '—'}`,
    `<b>Avg Implied Win:</b> ${Number.isFinite(profile.avgImplied) ? profile.avgImplied.toFixed(1) + '%' : '—'}`,
    `<b>Avg Model Win%:</b> ${Number.isFinite(profile.avgModel) ? profile.avgModel.toFixed(1) + '%' : '—'}`,
    `<b>Rides at this meeting:</b> ${profile.ridesAtMeeting || 0}`,
    `<b>Upcoming rides:</b> ${profile.upcomingRides || 0}`
  ];

  const rows = profile.rankedRides.map((x, i) => `<tr>
    <td>${i + 1}</td>
    <td>${escapeHtml(String(x.meeting))}</td>
    <td>R${escapeHtml(String(x.raceNo))}</td>
    <td>${escapeHtml(String(x.horse))}</td>
    <td>${escapeHtml(String(x.barrier))}</td>
    <td>${escapeHtml(String(x.odds))}</td>
    <td>${escapeHtml(String(x.model))}</td>
    <td>${escapeHtml(String(x.trainer))}</td>
  </tr>`).join('');

  const html = `<div class='jockey-profile-modal'>
    <div class='sub' style='margin-bottom:10px'>Latest stats from current race cache.</div>
    <div class='runner-grid'>${statLine.map(x => `<div>${x}</div>`).join('')}</div>
    <div style='margin-top:12px'><b>Top current rides (by model win%)</b></div>
    <div class='table-scroll'>
      <table class='runners-table' style='margin-top:8px'>
        <thead><tr><th>#</th><th>Meeting</th><th>Race</th><th>Horse</th><th>Barrier</th><th>Odds</th><th>Model</th><th>Trainer</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="8">No rides found</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;

  openSummaryPopup(`Jockey Profile — ${jockeyName}`, html);
}

function buildRaceCardSection(race, runners){
  const formatRecordText = (obj) => {
    if (!obj || typeof obj !== 'object') return '—';
    const starts = obj.number_of_starts ?? obj.starts ?? null;
    const wins = obj.number_of_wins ?? obj.wins ?? null;
    const seconds = obj.number_of_seconds ?? obj.seconds ?? null;
    const thirds = obj.number_of_thirds ?? obj.thirds ?? null;
    return `${starts ?? 0}:${wins ?? 0}-${seconds ?? 0}-${thirds ?? 0}`;
  };
  const ensureValue = (value, fallback = '—') => {
    if (value === null || value === undefined || String(value).trim() === '') return fallback;
    return value;
  };
  const renderGridBlocks = (blocks) => blocks.map(([label, value]) => `<div><span>${label}</span> ${ensureValue(value)}</div>`).join('');
  const renderOverflow = (blocks, label) => {
    if (!blocks.length) return '';
    return `<details class='race-runner-more'><summary>${label}</summary><div class='race-runner-more-grid'>${renderGridBlocks(blocks)}</div></details>`;
  };
  const INFO_LIMIT = 6;
  const STATS_LIMIT = 8;
  const allRunnerNames = (runners || []).map(r => cleanRunnerText(r.name || r.runner_name || '')).filter(Boolean);
  const analysisContext = (latestAnalysisSignals && normalizeMeetingKey(latestAnalysisSignals.meeting) === normalizeMeetingKey(race.meeting) && String(latestAnalysisSignals.race || '').trim() === String(race.race_number || race.race || '').trim())
    ? latestAnalysisSignals
    : null;

  const rows = (runners || []).map(r => {
    const label = cleanRunnerText(r.name || r.runner_name || '');
    const odds = Number(r.odds || r.fixed_win || r.tote_win || 0);
    const implied = Number.isFinite(odds) && odds > 0 ? `${(100/odds).toFixed(1)}%` : '—';
    const modelProb = Number.isFinite(r.modelProb) ? `${(r.modelProb * 100).toFixed(1)}%` : '—';
    const placeOdds = Number(r.fixed_place || r.tote_place || r.place_odds || 0);
    const placeImplied = Number.isFinite(placeOdds) && placeOdds > 0 ? `${(100/placeOdds).toFixed(1)}%` : '—';
    const placeOddsText = Number.isFinite(placeOdds) && placeOdds > 0 ? placeOdds.toFixed(2) : '—';
    const silk = r.silk_url_64x64 || r.silk_url_128x128 || '';
    const stats = r.stats || {};
    const breedingParts = [];
    if (r.sire) breedingParts.push(`Sire: ${renderBloodlineButton(r.sire, 'Sire')}`);
    if (r.dam) breedingParts.push(`Dam: ${renderBloodlineButton(r.dam, 'Dam')}`);
    if (r.dam_sire) breedingParts.push(`Dam Sire: ${renderBloodlineButton(r.dam_sire, 'Dam Sire')}`);
    const breeding = breedingParts.length ? breedingParts.join(' · ') : 'n/a';
    const profileBits = [];
    if (r.age) profileBits.push(`${r.age}yo`);
    if (r.sex) profileBits.push(r.sex);
    if (r.colour) profileBits.push(r.colour);
    if (r.country) profileBits.push(r.country);
    const profile = profileBits.length ? profileBits.join(' · ') : 'n/a';
    const stableBase = r.trainer_location || 'n/a';
    const apprenticeBits = [];
    if (r.apprentice_indicator) apprenticeBits.push('Apprentice');
    if (r.allowance_weight) apprenticeBits.push(`Claim ${r.allowance_weight}`);
    const apprenticeInfo = apprenticeBits.length ? apprenticeBits.join(' · ') : 'n/a';
    const ratingBits = [];
    if (r.rating) ratingBits.push(`Rating ${r.rating}`);
    if (r.handicap_rating) ratingBits.push(`Hcp ${r.handicap_rating}`);
    if (r.spr) ratingBits.push(`SPR ${r.spr}`);
    const ratingText = ratingBits.length ? ratingBits.join(' · ') : 'n/a';
    const statusBits = [];
    if (r.favourite) statusBits.push('Favourite');
    if (r.mover) statusBits.push('Market Mover');
    if (r.ride_guide_exists) statusBits.push('Ride Guide');
    const statusLine = statusBits.length ? statusBits.join(' · ') : 'n/a';
    const silksText = r.silk_colours || 'n/a';
    const rawComment = String(r.form_comment || '').trim();
    const runnerName = cleanRunnerText(r.name || r.runner_name || '');
    const lowerComment = rawComment.toLowerCase();
    const hits = rawComment ? allRunnerNames.filter(name => lowerComment.includes(name.toLowerCase())) : [];
    const formComment = (rawComment && rawComment.toLowerCase() !== 'n/a' && rawComment.length <= 320 && (!runnerName || lowerComment.includes(runnerName.toLowerCase())) && hits.length <= 1)
      ? rawComment
      : 'n/a';
    const winProb = Number.isFinite(r.win_p) ? `${r.win_p.toFixed(1)}%` : '—';
    const placeProb = Number.isFinite(r.place_p) ? `${r.place_p.toFixed(1)}%` : '—';
    const formSignal = runnerFormSignal(r);
    const formLine = `${r.last_twenty_starts || 'n/a'}${formSignal?.summary ? ` (${formSignal.summary})` : ''}`;
    const inheritedInteresting = inheritInterestingTags(race.meeting, race.race_number, r.name || r.runner_name);
    const moverTags = inheritMoveTags(race.meeting, race.race_number, r.name || r.runner_name);
    const formStatusTag = renderFormStatusTag(formSignal, formSignal?.summary);
    const tagPool = [...inheritedInteresting, ...moverTags];
    if (analysisContext) {
      const norm = normalizeRunnerName(label);
      if (analysisContext.winRunner && normalizeRunnerName(analysisContext.winRunner) === norm) tagPool.push(`<span class='tag win'>Recommended Bet</span>`);
      if (analysisContext.aiRunner && normalizeRunnerName(analysisContext.aiRunner) === norm) tagPool.push(`<span class='tag ai-winner'>AI Winner</span>`);
      if (analysisContext.oddsRunner && normalizeRunnerName(analysisContext.oddsRunner) === norm) tagPool.push(`<span class='tag odds'>Odds Runner</span>`);
      if (analysisContext.ewRunner && normalizeRunnerName(analysisContext.ewRunner) === norm) tagPool.push(`<span class='tag ew'>EW</span>`);
      if (Array.isArray(analysisContext.longRunners) && analysisContext.longRunners.map(normalizeRunnerName).includes(norm)) tagPool.push(`<span class='tag long'>LONG</span>`);
    }
    if (formStatusTag) tagPool.push(formStatusTag);
    const seenRunnerTags = new Set();
    const enrichedTags = tagPool.filter(tag => {
      if (!tag || seenRunnerTags.has(tag)) return false;
      seenRunnerTags.add(tag);
      return true;
    });
    const suitability = r.suitability_score != null ? `Suit:${r.suitability_score}/10` : (r.handicap_rating ? `Suit:Hcp ${r.handicap_rating}` : (r.rating ? `Suit:Rating ${r.rating}` : (r.spr ? `Suit:SPR ${r.spr}` : null)));

    const jockeyLabel = r.jockey || 'n/a';
    const jockeyCell = r.jockey
      ? `<button class='jockey-profile-btn' data-jockey='${escapeAttr(String(r.jockey))}' data-race-key='${escapeAttr(String(race.key || ''))}'>${escapeHtml(String(jockeyLabel))}</button>`
      : 'n/a';

    const infoBlocks = [
      ['Jockey', jockeyCell],
      ['Trainer', r.trainer || 'n/a'],
      ['Form', formLine],
      ['Speed', r.speedmap || 'n/a'],
      ['Gear', formatGearText(r.gear, 'n/a')],
      ['Owners', r.owners || 'n/a'],
      ['Profile', profile],
      ['Stable Base', stableBase],
      ['Apprentice / Claim', apprenticeInfo],
      ['Ratings', ratingText],
      ['Status', statusLine],
      ['Notes', formComment],
      ['Silks', silksText]
    ];

    const statsBlocks = [
      ['Career', formatRecordText(stats.overall)],
      ['Track', formatRecordText(stats.track)],
      ['Distance', formatRecordText(stats.distance)],
      ['Win Prob', winProb],
      ['Place Prob', placeProb],
      ['Soft', formatRecordText(stats.soft || stats.good)],
      ['Heavy', formatRecordText(stats.heavy)],
      ['1st Up', formatRecordText(stats.first_up)],
      ['2nd Up', formatRecordText(stats.second_up)],
      ['Fresh', formatRecordText(stats.fresh_90 || stats.fresh)],
      ['Suitability', suitability || 'n/a'],
      ['Breeding', breeding]
    ];

    const infoPrimary = infoBlocks.slice(0, INFO_LIMIT);
    const infoExtra = infoBlocks.slice(INFO_LIMIT);
    const statsPrimary = statsBlocks.slice(0, STATS_LIMIT);
    const statsExtra = statsBlocks.slice(STATS_LIMIT);

    const metrics = [
      ['Barrier', r.barrier || '—'],
      ['Weight', r.weight || '—'],
      ['Win', Number.isFinite(odds) && odds > 0 ? `${odds.toFixed(2)} (${implied})` : '—'],
      ['Place', Number.isFinite(placeOdds) && placeOdds > 0 ? `${placeOdds.toFixed(2)} (${placeImplied})` : '—'],
      ['Model', modelProb]
    ].map(([title, value]) => `<span class='race-runner-metric'><span>${title}</span>${value}</span>`).join('');

    return `<div class="race-runner-card">
      <div class="race-runner-head">
        <div class="race-runner-main">
          <div class="race-runner-num">${r.runner_number || ''}</div>
          <div>
            <div class="race-runner-name-row">
              <button class="analysis-drag-btn" data-selection='${escapeAttr(label)}' data-meeting='${race.meeting}' data-race='${race.race_number}'>${escapeHtml(label)}</button>
            </div>
            ${enrichedTags.length ? `<div class='race-runner-tags'>${enrichedTags.join(' ')}</div>` : ''}
            <div class="race-runner-metrics">${metrics}</div>
          </div>
        </div>
        <div class="race-runner-silk">${silk ? `<img src='${silk}' alt='Silks for ${escapeHtml(label)}' />` : '<div class="silk-placeholder">🎽</div>'}</div>
      </div>
      <div class="race-runner-body">
        <div class="race-runner-info-grid">
          ${renderGridBlocks(infoPrimary)}
        </div>
        <div class="race-runner-stats-grid">
          ${renderGridBlocks(statsPrimary)}
        </div>
      </div>
      <div class="race-runner-extra">
        ${renderOverflow(infoExtra, 'More runner info')}
        ${renderOverflow(statsExtra, 'Extended stats')}
      </div>
    </div>`;
  }).join('');
  return rows ? `<div class='race-runner-card-grid'>${rows}</div>` : '<div>No runner data available.</div>';
}



async function triggerPoll(){
  const meta = $('refreshMeta');
  if (meta) meta.textContent = 'Refreshing…';

  const pollPromise = fetchLocal('./api/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day: selectedDay, country: selectedCountry, meeting: selectedMeeting })
  }).catch(() => null);

  await loadRaces();
  renderRaces(racesCache);

  await pollPromise;
  await loadStatus();

  if (meta) meta.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

document.querySelectorAll('.pill[data-day]').forEach(p=>{
  p.addEventListener('click', async ()=>{
    invalidateMeetingSearch();
    document.querySelectorAll('.pill[data-day]').forEach(x=>x.classList.remove('active'));
    p.classList.add('active');
    selectedDay = p.dataset.day;
    selectedMeeting = 'ALL';
    persistMeetingLock();
    const meetingSel = $('meetingSelect');
    if (meetingSel) meetingSel.value = 'ALL';
    updatePulseMeetingAwareUi();
    await triggerPoll();
  });
});
$('countrySelect')?.addEventListener('change', async (e)=>{
  invalidateMeetingSearch();
  selectedCountry = normalizeUiCountry(e.target.value, selectedCountry);
  selectedMeeting = 'ALL';
  persistMeetingLock();
  const meetingSel = $('meetingSelect');
  if (meetingSel) meetingSel.value = 'ALL';
  renderMeetingIntelPanel();
  updatePulseMeetingAwareUi();
  await triggerPoll();
});
$('meetingSelect')?.addEventListener('change', async (e)=>{
  invalidateMeetingSearch();
  selectedMeeting = e.target.value;
  persistMeetingLock();

  if (selectedMeeting !== 'ALL') {
    const inCache = (racesCache || []).some(r => String(r.meeting || '').trim().toLowerCase() === String(selectedMeeting).trim().toLowerCase());
    if (!inCache) {
      const all = await loadAllRacesUnfiltered();
      const hit = (all || []).find(r => String(r.meeting || '').trim().toLowerCase() === String(selectedMeeting).trim().toLowerCase());
      if (hit && hit.country && normalizeUiCountry(hit.country, selectedCountry) !== selectedCountry) {
        selectedCountry = normalizeUiCountry(hit.country, selectedCountry);
        const cs = $('countrySelect');
        if (cs) cs.value = selectedCountry;
        persistMeetingLock();
      }
    }
  }

  await loadRaces();
  renderRaces(racesCache);
  renderSuggested(latestFilteredSuggested || filterSuggestedByWhy(latestSuggestedBets || []));
  renderMultis(latestFilteredSuggested || filterSuggestedByWhy(latestSuggestedBets || []));
  renderNextPlanned(latestFilteredSuggested || filterSuggestedByWhy(latestSuggestedBets || []));
  renderInteresting(latestInterestingRows || []);
  renderMarketMovers(latestMarketMovers || []);
  refreshTabAccess();
  renderMeetingIntelPanel();
  updatePulseMeetingAwareUi();
});
$('meetingSearchBtn')?.addEventListener('click', async ()=>{
  await handleMeetingSearchSubmit();
});
$('meetingSearchInput')?.addEventListener('keydown', async (e)=>{
  if (e.key === 'Enter') {
    e.preventDefault();
    await handleMeetingSearchSubmit();
  }
});
$('meetingSearchInput')?.addEventListener('input', ()=> setMeetingSearchHint(''));
$('whyFilter')?.addEventListener('change', (e)=>{
  selectedWhy = e.target.value || 'ALL';
  const filteredSuggested = filterSuggestedByWhy(latestSuggestedBets);
  latestFilteredSuggested = filteredSuggested;
  renderSuggested(filteredSuggested);
  renderMultis(filteredSuggested);
  renderNextPlanned(filteredSuggested);
  renderInteresting(latestInterestingRows || []);
  renderMarketMovers(latestMarketMovers || []);
  if (selectedWhy === 'EXOTIC') setActivePage('multis');
});
document.querySelectorAll('.pill[data-day]').forEach(btn=>{
  btn.classList.toggle('active', btn.dataset.day === selectedDay);
});

document.querySelectorAll('.page-tab').forEach(btn=>{
  btn.addEventListener('click', ()=> {
    const page = btn.dataset.page || 'plans';
    if (page === 'bakeoff' && !isAdminUser) return;
    setActivePage(page);
    if (page === 'bakeoff') loadBakeoffLeaderboard();
    if (page === 'strategy') buildStrategyPlan();
  });
});
document.querySelectorAll('.bet-plan-tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const target = btn.dataset.window || 'day';
    if (betPlanPerfWindow === target) return;
    betPlanPerfWindow = target;
    document.querySelectorAll('.bet-plan-tab').forEach(b=>b.classList.toggle('active', b.dataset.window === target));
    renderBetPlanPerformance();
  });
});
$('refreshBakeoffBtn')?.addEventListener('click', ()=> loadBakeoffLeaderboard());
$('testAllModelsBtn')?.addEventListener('click', ()=> runBakeoffModelTest());
$('runFullSoakBtn')?.addEventListener('click', ()=> runBakeoffFullSoak());
$('openStrategyBtn')?.addEventListener('click', ()=> {
  setActivePage('strategy');
  buildStrategyPlan();
});
$('strategyBuildBtn')?.addEventListener('click', ()=> buildStrategyPlan());
$('strategyPrintBtn')?.addEventListener('click', ()=> printStrategyBook());
document.querySelectorAll('#refreshPerformanceBtn').forEach(btn => {
  btn.addEventListener('click', () => triggerPerformancePoll(true));
});
document.querySelectorAll('#openLedgerBtn').forEach(btn => {
  btn.addEventListener('click', () => setActivePage('performance-ledger'));
});
$('ledgerBackBtn')?.addEventListener('click', ()=> setActivePage('performance'));
document.querySelectorAll('.perf-subtab').forEach(btn => {
  btn.addEventListener('click', () => setActivePerformanceTab(btn.dataset.perfTab || 'overview'));
});
document.querySelectorAll('.pulse-subtab, .alerts-subtab').forEach(btn => {
  btn.addEventListener('click', () => setActivePulseTab(btn.dataset.pulseTab || btn.dataset.alertsTab || 'live'));
});
$('refreshPulseBtn')?.addEventListener('click', () => renderAlertsShell());
$('refreshAlertsBtn')?.addEventListener('click', () => renderAlertsShell());
($('pulseCountryFilter') || $('alertsCountryFilter'))?.addEventListener('change', () => renderAlertsShell());
($('pulseMeetingFilter') || $('alertsMeetingFilter'))?.addEventListener('change', () => renderAlertsShell());
document.addEventListener('click', (event) => {
  const btn = event.target.closest('.pulse-filter-chip');
  if (!btn) return;
  const selectId = String(btn.dataset.select || '');
  const value = String(btn.dataset.value || '');
  const sel = $(selectId);
  if (!sel) return;
  sel.value = value || 'all';
  sel.dispatchEvent(new Event('change'));
});
$('refreshGenericAlertsBtn')?.addEventListener('click', () => renderGenericAlertsShell());
$('clearGenericAlertsBtn')?.addEventListener('click', () => {
  if ($('genericAlertsCountryFilter')) $('genericAlertsCountryFilter').value = 'all';
  if ($('genericAlertsMeetingFilter')) $('genericAlertsMeetingFilter').value = 'all';
  if ($('genericAlertsSeverityFilter')) $('genericAlertsSeverityFilter').value = 'all';
  if ($('genericAlertsTypeFilter')) $('genericAlertsTypeFilter').value = 'all';
  if ($('genericAlertsSearch')) $('genericAlertsSearch').value = '';
  renderGenericAlertsShell();
});
$('genericAlertsCountryFilter')?.addEventListener('change', () => renderGenericAlertsShell());
$('genericAlertsMeetingFilter')?.addEventListener('change', () => renderGenericAlertsShell());
$('genericAlertsSeverityFilter')?.addEventListener('change', () => renderGenericAlertsShell());
$('genericAlertsTypeFilter')?.addEventListener('change', () => renderGenericAlertsShell());
$('genericAlertsSearch')?.addEventListener('input', () => renderGenericAlertsShell());
$('refreshTrackedBtn')?.addEventListener('click', () => renderTrackedShell());
document.querySelectorAll('.tracked-subtab').forEach(btn => {
  btn.addEventListener('click', () => {
    setActiveTrackedTab(btn.dataset.trackedTab || 'active');
    renderTrackedShell();
  });
});
$('trainModelsBtn')?.addEventListener('click', ()=> triggerModelTraining());
setActivePage(activePage);

function formatBakeoffPct(value){
  const num = Number(value);
  if (!Number.isFinite(num)) return NaN;
  const normalized = Math.abs(num) > 1 ? num : num * 100;
  return normalized;
}

function approximateTokenCount(text){
  const str = String(text || '');
  if (!str) return 0;
  return Math.max(1, Math.round(str.length / 4));
}

const BAKEOFF_AUTOTUNE_KEY = 'bakeoffAutoTuneState.v1';

function getBakeoffAutoTuneState(){
  try { return JSON.parse(localStorage.getItem(BAKEOFF_AUTOTUNE_KEY) || '{}'); } catch { return {}; }
}

function setBakeoffAutoTuneState(next){
  const prev = getBakeoffAutoTuneState();
  const out = { ...prev, ...next, updatedAt: new Date().toISOString() };
  try { localStorage.setItem(BAKEOFF_AUTOTUNE_KEY, JSON.stringify(out)); } catch {}
  return out;
}

function computeModelWeights(rows){
  if (!Array.isArray(rows) || !rows.length) return [];
  const vals = rows.map(r => Number(r.composite || 0)).filter(Number.isFinite);
  if (!vals.length) return [];
  const maxVal = Math.max(...vals);
  const weighted = rows.map(r => {
    const score = Number(r.composite || 0);
    const w = Number.isFinite(score) ? Math.exp((score - maxVal) / 10) : 0;
    return { model: r.model, score, w };
  });
  const sumW = weighted.reduce((a,b)=>a + b.w, 0) || 1;
  return weighted
    .map(x => ({ model: x.model, score: x.score, weight: x.w / sumW }))
    .sort((a,b)=>b.weight-a.weight);
}

function chooseChampion(rows){
  if (!Array.isArray(rows) || !rows.length) return null;
  const sorted = rows.slice().sort((a,b)=>Number(b.composite||0)-Number(a.composite||0));
  const best = sorted[0];
  const second = sorted[1] || null;
  const compositeGap = Number(best?.composite || 0) - Number(second?.composite || 0);
  const success = formatBakeoffPct(best?.successRate || 0);
  const quality = formatBakeoffPct(best?.qualityAvg || 0);
  const runs = Number(best?.runs || 0);
  const canPromote = success >= 55 && quality >= 55 && runs >= 20 && compositeGap >= 0.5;
  return {
    best,
    second,
    compositeGap,
    canPromote,
    reasons: [
      `success ${success.toFixed(1)}% (min 55%)`,
      `quality ${quality.toFixed(1)}% (min 55%)`,
      `runs ${runs} (min 20)`,
      `gap ${compositeGap.toFixed(2)} (min 0.50)`
    ]
  };
}

function pickWeightedModel(weights){
  if (!Array.isArray(weights) || !weights.length) return null;
  let r = Math.random();
  for (const w of weights) {
    r -= Number(w.weight || 0);
    if (r <= 0) return w.model;
  }
  return weights[0]?.model || null;
}

function resolveAutoTuneModelSelection(){
  const s = getBakeoffAutoTuneState();
  if (aiModelManualLock) {
    return { provider: selectedAiModel.provider || inferProviderFromModel(selectedAiModel.model), model: selectedAiModel.model, source: 'manual-lock' };
  }
  if (!s?.enabled) return { ...selectedAiModel, source: 'manual' };

  if (s.useWeighted && Array.isArray(s.weights) && s.weights.length) {
    const model = pickWeightedModel(s.weights);
    if (model) return { provider: inferProviderFromModel(model), model, source: 'weighted' };
  }

  if (s.champion) {
    return { provider: inferProviderFromModel(s.champion), model: s.champion, source: 'champion' };
  }

  return { ...selectedAiModel, source: 'manual' };
}

function renderBakeoffAutoTunePanel(rows, out){
  const wrap = $('bakeoffAutoTune');
  if (!wrap) return;
  if (!Array.isArray(rows) || !rows.length) {
    wrap.innerHTML = `<h4>Self-Tuning Engine</h4><div class='sub'>Run a bakeoff to activate Phase 1/2/3 controls.</div>`;
    return;
  }

  const state = getBakeoffAutoTuneState();
  const championDecision = chooseChampion(rows);
  const challenger = championDecision?.best?.model || null;
  const weights = computeModelWeights(rows).slice(0, 8);

  let champion = state.champion || null;
  if (state.autoPromote && championDecision?.canPromote && challenger && challenger !== champion) {
    const prev = champion || state.previousChampion || null;
    const updated = setBakeoffAutoTuneState({ champion: challenger, previousChampion: prev });
    champion = updated.champion;
  }

  const weightsChanged = JSON.stringify(state.weights || []) !== JSON.stringify(weights);
  if (weightsChanged) setBakeoffAutoTuneState({ weights });

  const weightsRows = weights.map((w, i) => `<tr><td>${i+1}</td><td>${escapeHtml(String(w.model || '—'))}</td><td>${Number(w.score || 0).toFixed(2)}</td><td>${(Number(w.weight || 0) * 100).toFixed(1)}%</td></tr>`).join('');

  wrap.innerHTML = `
    <h4>Self-Tuning Engine (Phase 1 / 2 / 3)</h4>
    <div class='perf-kpis perf-kpis-secondary'>
      <div class='perf-card'><div class='label'>Champion</div><div class='value'>${escapeHtml(champion || 'not set')}</div></div>
      <div class='perf-card'><div class='label'>Top Challenger</div><div class='value'>${escapeHtml(challenger || '—')}</div></div>
      <div class='perf-card'><div class='label'>Promotion Gate</div><div class='value ${championDecision?.canPromote ? 'pos' : ''}'>${championDecision?.canPromote ? 'PASS' : 'HOLD'}</div></div>
      <div class='perf-card'><div class='label'>Auto Promote</div><div class='value'>${state.autoPromote ? 'ON' : 'OFF'}</div></div>
      <div class='perf-card'><div class='label'>Weighted Routing</div><div class='value'>${state.useWeighted ? 'ON' : 'OFF'}</div></div>
      <div class='perf-card'><div class='label'>Nightly Retrain</div><div class='value'>${state.nightlyRetrain ? 'ON' : 'OFF'}</div></div>
    </div>

    <div class='sub'>Phase 1 (Champion/Challenger): ${championDecision?.reasons?.join(' · ') || 'n/a'}</div>
    <div class='btn-row' style='margin:8px 0 12px'>
      <button class='btn btn-ghost compact-btn' id='autotuneEnableBtn'>${state.enabled ? 'Disable' : 'Enable'} AutoTune</button>
      <button class='btn btn-ghost compact-btn' id='autotuneAutoPromoteBtn'>${state.autoPromote ? 'Disable' : 'Enable'} Auto Promote</button>
      <button class='btn btn-ghost compact-btn' id='autotuneWeightedBtn'>${state.useWeighted ? 'Disable' : 'Enable'} Weighted Routing</button>
      <button class='btn btn-ghost compact-btn' id='autotunePromoteBtn' ${championDecision?.canPromote ? '' : 'disabled'}>Promote Challenger</button>
      <button class='btn btn-ghost compact-btn' id='autotuneRollbackBtn' ${champion ? '' : 'disabled'}>Rollback Champion</button>
      <button class='btn btn-ghost compact-btn' id='autotuneNightlyBtn'>${state.nightlyRetrain ? 'Disable' : 'Enable'} Nightly Retrain Gate</button>
      <button class='btn btn-ghost compact-btn' id='autotuneTrainNowBtn'>Run Retrain Now</button>
    </div>

    <div><b>Phase 2 Dynamic Ensemble Weights</b></div>
    <div class='table'><table class='perf-table'><thead><tr><th>#</th><th>Model</th><th>Composite</th><th>Weight</th></tr></thead><tbody>${weightsRows}</tbody></table></div>

    <div class='sub' style='margin-top:8px'>Phase 3 Gate: nightly retrain is configuration state in UI; deployment remains gated by bakeoff pass + manual oversight.</div>
  `;

  $('autotuneEnableBtn')?.addEventListener('click', () => {
    const s = getBakeoffAutoTuneState();
    setBakeoffAutoTuneState({ enabled: !s.enabled });
    renderBakeoffAutoTunePanel(rows, out);
  });
  $('autotuneAutoPromoteBtn')?.addEventListener('click', () => {
    const s = getBakeoffAutoTuneState();
    setBakeoffAutoTuneState({ autoPromote: !s.autoPromote });
    renderBakeoffAutoTunePanel(rows, out);
  });
  $('autotuneWeightedBtn')?.addEventListener('click', () => {
    const s = getBakeoffAutoTuneState();
    setBakeoffAutoTuneState({ useWeighted: !s.useWeighted });
    renderBakeoffAutoTunePanel(rows, out);
  });
  $('autotunePromoteBtn')?.addEventListener('click', () => {
    if (!championDecision?.canPromote || !championDecision?.best?.model) return;
    const s = getBakeoffAutoTuneState();
    const prev = s.champion || null;
    setBakeoffAutoTuneState({ champion: championDecision.best.model, previousChampion: prev });
    renderBakeoffAutoTunePanel(rows, out);
  });
  $('autotuneRollbackBtn')?.addEventListener('click', () => {
    const s = getBakeoffAutoTuneState();
    if (!s.previousChampion) return;
    setBakeoffAutoTuneState({ champion: s.previousChampion, previousChampion: s.champion || null });
    renderBakeoffAutoTunePanel(rows, out);
  });
  $('autotuneNightlyBtn')?.addEventListener('click', () => {
    const s = getBakeoffAutoTuneState();
    setBakeoffAutoTuneState({ nightlyRetrain: !s.nightlyRetrain });
    renderBakeoffAutoTunePanel(rows, out);
  });
  $('autotuneTrainNowBtn')?.addEventListener('click', async () => {
    const btn = $('autotuneTrainNowBtn');
    const summary = $('bakeoffSummary');
    if (btn) btn.disabled = true;
    if (summary) summary.textContent = 'Retrain requested…';
    try {
      const res = await fetchLocal('./api/train-models', { method: 'POST' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out?.ok === false) {
        if (summary) summary.textContent = `Retrain failed: ${out?.error || 'unknown_error'}`;
      } else {
        if (summary) summary.textContent = 'Retrain completed. Refreshing bakeoff leaderboard…';
        setTimeout(() => loadBakeoffLeaderboard(), 1200);
      }
    } catch (err) {
      if (summary) summary.textContent = `Retrain failed: ${err?.message || 'network_error'}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

async function loadBakeoffLeaderboard(manualData = null){
  if (!isAdminUser) return;
  const summary = $('bakeoffSummary');
  const table = $('bakeoffTable');
  const coverage = $('bakeoffModelCoverage');
  const autoTune = $('bakeoffAutoTune');
  if (coverage) coverage.innerHTML = '';
  if (autoTune) autoTune.innerHTML = '';
  if (!summary || !table) return;
  summary.textContent = manualData ? 'Applying bakeoff results…' : 'Loading bakeoff leaderboard…';
  table.innerHTML = '';
  const renderCoverage = (models, rowsByModel)=>{
    if (!coverage) return;
    if (!models.length) {
      coverage.innerHTML = '<div class="sub">No models configured.</div>';
      return;
    }
    coverage.innerHTML = models.map(model => {
      const stats = rowsByModel.get(model);
      const cls = stats ? 'bakeoff-model-chip' : 'bakeoff-model-chip missing';
      const success = stats && Number.isFinite(stats.successRate) ? `${formatBakeoffPct(stats.successRate).toFixed(1)}% success` : null;
      const quality = stats && Number.isFinite(stats.qualityAvg) ? `${formatBakeoffPct(stats.qualityAvg).toFixed(1)}% quality` : null;
      const runs = stats && Number.isFinite(stats.runs) ? `${stats.runs} runs` : null;
      const status = stats ? [success, quality, runs].filter(Boolean).join(' · ') : 'No bakeoff run yet';
      return `<div class="${cls}"><div class="model">${escapeHtml(model)}</div><span class="meta">${status}</span></div>`;
    }).join('');
  };
  const renderView = (out, options = {}) => {
    if (!out || out.ok === false) {
      summary.textContent = options.emptyMessage || 'No bakeoff results found yet.';
      if (coverage) coverage.innerHTML = '<div class="sub">Run npm run bakeoff to generate stats.</div>';
      table.innerHTML = '';
      return;
    }
    const configuredModels = Array.from(new Set([
      ...((out.models || []).map(m => String(m).trim()).filter(Boolean)),
      ...((aiModelCatalog.ollamaModels || []).map(m => String(m).trim()).filter(Boolean)),
      ...((aiModelCatalog.openaiModels || []).map(m => String(m).trim()).filter(Boolean))
    ])).sort((a,b)=>a.localeCompare(b));
    const ts = out.generatedAt ? new Date(out.generatedAt).toLocaleString() : 'n/a';
    const openAiDateRaw = out.openAiDate || out.openaiDate || null;
    const openAiDate = openAiDateRaw ? new Date(openAiDateRaw).toLocaleString() : null;
    const rows = Array.isArray(out.leaderboard)
      ? out.leaderboard.slice().sort((a,b)=> (Number(b.qualityAvg||0) - Number(a.qualityAvg||0)) || (Number(b.successRate||0) - Number(a.successRate||0)) || (Number(b.composite||0)-Number(a.composite||0)))
      : [];
    const rowsByModel = new Map(rows.map(r => [r.model, r]));
    const missingModels = configuredModels.filter(model => !rowsByModel.has(model));
    const summaryBits = [];
    const label = options.sourceLabel || 'Last run';
    summaryBits.push(`${label}: ${ts}`);
    summaryBits.push(`Models: ${(out.models||[]).length}`);
    summaryBits.push(`Prompts: ${(out.prompts||[]).length}`);
    summaryBits.push(`Runs: ${out.runs || rows.length || 0}`);
    if (openAiDate) summaryBits.push(`OpenAI date: ${openAiDate}`);
    summaryBits.push('Ranking: Answer Quality');
    if (missingModels.length) summaryBits.push(`Pending models: ${missingModels.length}`);
    summary.textContent = summaryBits.join(' · ');
    renderCoverage(configuredModels, rowsByModel);
    const pct = (v)=> {
      if (!Number.isFinite(v)) return '—';
      return formatBakeoffPct(v).toFixed(1);
    };
    const rankMetric = (getter, asc = false) => {
      const scored = rows
        .map(r => ({ model: r.model, value: Number(getter(r)) }))
        .filter(x => Number.isFinite(x.value))
        .sort((a,b) => asc ? (a.value - b.value) : (b.value - a.value));
      const out = new Map();
      scored.forEach((x, idx) => out.set(x.model, idx + 1));
      return out;
    };
    const qualityRank = rankMetric(r => r.qualityAvg, false);
    const successRank = rankMetric(r => r.successRate, false);
    const latencyRank = rankMetric(r => r.latencyP50Ms, true);
    const fallbackRank = rankMetric(r => r.fallbackRate, true);
    const bestModelBy = (getter, asc = false) => {
      const scored = rows
        .map(r => ({ model: r.model, value: Number(getter(r)) }))
        .filter(x => Number.isFinite(x.value))
        .sort((a,b) => asc ? (a.value - b.value) : (b.value - a.value));
      return scored[0]?.model || null;
    };
    const bestSuccessModel = bestModelBy(r => r.successRate, false);
    const bestQualityModel = bestModelBy(r => r.qualityAvg, false);
    const bestLatencyModel = bestModelBy(r => r.latencyP50Ms, true);
    const bestFallbackModel = bestModelBy(r => r.fallbackRate, true);
    const peerScore = (row) => {
      const ranks = [qualityRank.get(row.model), successRank.get(row.model), latencyRank.get(row.model), fallbackRank.get(row.model)].filter(Number.isFinite);
      if (!ranks.length) return null;
      const avgRank = ranks.reduce((a,b)=>a+b,0) / ranks.length;
      const maxRank = rows.length || 1;
      return Math.max(0, Math.min(100, 100 * (1 - ((avgRank - 1) / Math.max(1, maxRank - 1)))));
    };
    const bestPeerModel = rows.length ? rows.slice().sort((a,b)=>(peerScore(b) || 0) - (peerScore(a) || 0))[0]?.model : null;
    const contextCellFor = (row) => {
      const contextParts = [];
      const pushContext = (val) => {
        if (val == null) return;
        const text = String(val);
        if (!text.trim()) return;
        if (!contextParts.includes(text)) contextParts.push(text);
      };
      pushContext(row.contextTokens);
      pushContext(row.contextSize);
      pushContext(row.context);
      return contextParts.length ? contextParts.join('/') : ((row.composite ?? null) != null ? row.composite : '—');
    };
    if (!rows.length && !missingModels.length) {
      table.innerHTML = '<div class="sub">No leaderboard entries.</div>';
      return;
    }
    const header = '<table><tr><th>Rank</th><th>Model</th><th>Context Size</th><th>Success %</th><th>Answer Quality</th><th>Peer Score</th><th>Answer Time (P50 ms)</th><th>TTL Response (P95 ms)</th><th>Fallback %</th></tr>';
    const leaderRows = rows.map((r,i)=>{
      const peer = peerScore(r);
      const successVal = pct(r.successRate);
      const qualityVal = pct(r.qualityAvg);
      const peerVal = peer != null ? peer.toFixed(1) : '—';
      const latencyVal = r.latencyP50Ms ?? '—';
      const fallbackVal = pct(r.fallbackRate);
      const mark = (isWinner, value) => isWinner ? `<span class='bakeoff-winner'>${value}</span>` : value;
      return `<tr><td>${i+1}</td><td>${escapeHtml(r.model||'n/a')}</td><td>${contextCellFor(r)}</td><td>${mark(r.model === bestSuccessModel, successVal)}</td><td>${mark(r.model === bestQualityModel, qualityVal)}</td><td>${mark(r.model === bestPeerModel, peerVal)}</td><td>${mark(r.model === bestLatencyModel, latencyVal)}</td><td>${r.latencyP95Ms ?? '—'}</td><td>${mark(r.model === bestFallbackModel, fallbackVal)}</td></tr>`;
    }).join('');
    const pendingRows = missingModels.map(model =>
      `<tr class="pending"><td>—</td><td>${escapeHtml(model)}<span class="pending-note">No bakeoff run yet</span></td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`
    ).join('');
    table.innerHTML = `${header}${leaderRows}${pendingRows}</table>`;
    renderBakeoffAutoTunePanel(rows, out);
  };
  if (manualData) {
    const label = manualData.sourceLabel || (manualData.source === 'ui-bakeoff' ? 'Live run' : 'Manual run');
    renderView(manualData, { sourceLabel: label });
    return;
  }
  try {
    const res = await fetchLocal('./api/model-bakeoff/latest', { cache:'no-store' });
    const { data, raw } = await readJsonSafe(res);
    if (!data) {
      summary.textContent = 'Bakeoff API returned non-JSON response.';
      if (coverage) coverage.innerHTML = `<div class="sub">${escapeHtml(String(raw || '').slice(0, 280))}</div>`;
      return;
    }
    if (!data.ok) {
      summary.textContent = 'No bakeoff results found yet.';
      if (coverage) coverage.innerHTML = '<div class="sub">Run npm run bakeoff to generate stats.</div>';
      return;
    }
    renderView(data);
  } catch {
    summary.textContent = 'Unable to load bakeoff leaderboard.';
    if (coverage) coverage.innerHTML = '<div class="sub">Unable to load model coverage.</div>';
  }
}
let bakeoffFullSoakPoll = null;

function renderBakeoffRunFeedback(out, startedAt){
  const results = $('bakeoffTestResults');
  if (!results) return;
  const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const tail = Array.isArray(out?.tail) ? out.tail.slice(-10) : [];
  const logLines = tail.length
    ? `<div class='sub' style='margin-top:8px'>Live log tail</div><pre style='margin-top:6px;max-height:220px;overflow:auto;white-space:pre-wrap;font-size:11px;line-height:1.35;background:#0b1220;border:1px solid rgba(255,255,255,0.08);padding:10px;border-radius:8px'>${escapeHtml(tail.join('\n'))}</pre>`
    : `<div class='sub' style='margin-top:8px'>Waiting for bakeoff log output…</div>`;
  results.innerHTML = `<div class='sub'>🔥 Full soak running for ${secs}s</div>${logLines}`;
}

async function pollBakeoffFullSoakStatus(startedAt = Date.now()){
  try {
    const res = await fetchLocal('./api/bakeoff-run-status');
    const { data, raw } = await readJsonSafe(res);
    if (!data) {
      setBakeoffRunIndicator('error', '⚠️ Full soak status returned non-JSON response.');
      renderBakeoffRunFeedback({ tail: [String(raw || '').slice(0, 240)] }, startedAt);
      return;
    }
    const out = data;
    if (!res.ok || out?.ok === false) return;
    if (out.running) {
      setBakeoffRunIndicator('running', `🔥 Full soak running… ${Math.max(0, Math.round((Date.now() - startedAt) / 1000))}s`);
      renderBakeoffRunFeedback(out, startedAt);
      return;
    }
    if (bakeoffFullSoakPoll) {
      clearInterval(bakeoffFullSoakPoll);
      bakeoffFullSoakPoll = null;
    }
    const ok = out.exitCode === 0;
    setBakeoffRunIndicator(ok ? 'success' : 'error', ok ? '✅ Full soak complete.' : `⚠️ Full soak failed (exit ${out.exitCode ?? 'n/a'})`);
    renderBakeoffRunFeedback(out, startedAt);
    const btn = $('runFullSoakBtn');
    if (btn) btn.disabled = false;
    if (ok) loadBakeoffLeaderboard();
  } catch (err) {
    setBakeoffRunIndicator('error', `⚠️ Full soak status error: ${err?.message || 'unknown'}`);
  }
}

async function restoreBakeoffRunFeedback(){
  try {
    const res = await fetchLocal('./api/bakeoff-run-status');
    const { data, raw } = await readJsonSafe(res);
    if (!data) {
      setBakeoffRunIndicator('error', '⚠️ Full soak status returned non-JSON response.');
      renderBakeoffRunFeedback({ tail: [String(raw || '').slice(0, 240)] }, Date.now());
      return;
    }
    const out = data;
    if (!res.ok || out?.ok === false) return;
    const startedAt = Number(out.startedAt || Date.now());
    if (out.running) {
      setBakeoffRunIndicator('running', `🔥 Full soak running… ${Math.max(0, Math.round((Date.now() - startedAt) / 1000))}s`);
      renderBakeoffRunFeedback(out, startedAt);
      const btn = $('runFullSoakBtn');
      if (btn) btn.disabled = true;
      if (bakeoffFullSoakPoll) clearInterval(bakeoffFullSoakPoll);
      bakeoffFullSoakPoll = setInterval(() => pollBakeoffFullSoakStatus(startedAt), 3000);
      return;
    }
    if (Number.isFinite(Number(out.exitCode)) || out.tail?.length) {
      const ok = out.exitCode === 0;
      setBakeoffRunIndicator(ok ? 'success' : 'error', ok ? '✅ Full soak complete.' : `⚠️ Full soak failed (exit ${out.exitCode ?? 'n/a'})`);
      renderBakeoffRunFeedback(out, startedAt);
    }
  } catch {}
}

async function runBakeoffFullSoak(){
  const btn = $('runFullSoakBtn');
  if (btn) btn.disabled = true;
  const startedAt = Date.now();
  try {
    const res = await fetchLocal('./api/bakeoff-run', { method: 'POST' });
    const { data, raw } = await readJsonSafe(res);
    if (!data) {
      setBakeoffRunIndicator('error', '⚠️ Full soak start returned non-JSON response.');
      renderBakeoffRunFeedback({ tail: [String(raw || '').slice(0, 240)] }, startedAt);
      return;
    }
    const out = data;
    if (!res.ok || out?.ok === false) {
      setBakeoffRunIndicator('error', `⚠️ Full soak failed to start: ${out?.error || 'unknown_error'}`);
      return;
    }
    setBakeoffRunIndicator('running', '🔥 Full soak running (npm run bakeoff)…');
    renderBakeoffRunFeedback(out, startedAt);
    if (bakeoffFullSoakPoll) clearInterval(bakeoffFullSoakPoll);
    bakeoffFullSoakPoll = setInterval(() => pollBakeoffFullSoakStatus(startedAt), 3000);
    setTimeout(() => pollBakeoffFullSoakStatus(startedAt), 1000);
  } catch (err) {
    setBakeoffRunIndicator('error', `⚠️ Full soak start error: ${err?.message || 'network_error'}`);
  } finally {
    if (btn && !bakeoffFullSoakPoll) btn.disabled = false;
  }
}

async function runBakeoffModelTest(){
  const btn = $('testAllModelsBtn');
  const results = $('bakeoffTestResults');
  if (!results) return;
  const liveEntries = [];
  const runStarted = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  setBakeoffRunIndicator('running', '⏱ Model bake-off running…');
  if (!((aiModelCatalog.ollamaModels || []).length || (aiModelCatalog.openaiModels || []).length)) {
    await loadAiModels().catch(()=>{});
  }
  const ollamaCatalog = (aiModelCatalog.ollamaModels || []).map(model => ({ provider: 'ollama', model }));
  const openAiTestable = (aiModelCatalog.capabilities?.openaiPermitted ? (aiModelCatalog.openaiModels || []) : []);
  const openAiCatalog = openAiTestable.map(model => ({ provider: 'openai', model }));
  const catalog = [...ollamaCatalog, ...openAiCatalog];
  const skippedOpenAi = (aiModelCatalog.openaiModels || []).length && !aiModelCatalog.capabilities?.openaiPermitted;
  let runFailed = false;
  if (!catalog.length) {
    results.innerHTML = "<div class='sub'>No testable models. Configure Ollama or add an OpenAI API key.</div>";
    setBakeoffRunIndicator('error', '⚠️ No testable AI models configured.');
    return;
  }
  results.innerHTML = "<div class='sub'>Preparing race context…</div>";
  let race = selectedRace;
  if (!race) {
    if (!racesCache.length) {
      try {
        await Promise.race([
          loadRaces(),
          new Promise((_, reject)=> setTimeout(()=>reject(new Error('race_load_timeout')), 8000))
        ]);
      } catch {}
    }
    race = selectedRace || racesCache[0] || null;
  }
  if (!race) {
    const fallbackRow = (latestSuggestedBets || [])[0];
    if (fallbackRow?.meeting && fallbackRow?.race) {
      race = {
        meeting: fallbackRow.meeting,
        race_number: String(fallbackRow.race).replace(/^R/i,''),
        description: 'Bakeoff prompt',
        runners: []
      };
      results.innerHTML = "<div class='sub'>Using Suggested Bets as bakeoff context (race list not loaded).</div>";
    } else {
      results.innerHTML = "<div class='sub'>Select a race so we can build the test prompt.</div>";
      setBakeoffRunIndicator('error', '⚠️ Select a race (or load Suggested Bets) before running the bake-off.');
      return;
    }
  }
  let question = '';
  let questionTokens = 0;
  try {
    await ensureInstructionsLoaded().catch(()=>{});
    question = buildAiAnalysisPrompt(race);
    questionTokens = approximateTokenCount(question);
    results.innerHTML = "";
    if (skippedOpenAi && aiModelCatalog.openaiBlockedReason) {
      results.innerHTML += `<div class='sub'>Skipped OpenAI models: ${escapeHtml(aiModelCatalog.openaiBlockedReason)}</div>`;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Testing…';
    }
    for (const entry of catalog) {
      const card = document.createElement('div');
      card.className = 'bakeoff-test-card';
      card.innerHTML = `<div class='head'><div>${escapeHtml(entry.model)} <span class='provider'>(${entry.provider})</span></div><div class='status'>Queued…</div></div><div class='body sub'>Queued…</div>`;
      results.appendChild(card);
      const statusEl = card.querySelector('.status');
      const bodyEl = card.querySelector('.body');
      try {
        const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const res = await fetchLocal('./api/ask-selection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'race-analysis',
            question,
            provider: entry.provider,
            model: entry.model,
            selectionCount: 0,
            selections: [],
            uiContext: { day: selectedDay, country: selectedCountry, meeting: selectedMeeting },
            raceContext: { meeting: race.meeting, raceNumber: race.race_number, raceName: race.description },
            userNotes: queryAiUserNotes('', selectedMeeting).slice(0, 5).map(n => ({ text: n.text, meeting: n.meeting, createdAt: n.createdAt }))
          })
        });
        const out = await res.json();
        if (!res.ok || !out?.answer) throw new Error(out?.error || `HTTP ${res.status}`);
        const duration = (((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - started) / 1000;
        const latencyMs = Math.round(duration * 1000);
        card.classList.add('success');
        if (statusEl) statusEl.textContent = `OK · ${duration.toFixed(2)}s`;
        if (bodyEl) {
          const metrics = `<div class='bakeoff-metrics'>Response ${duration.toFixed(2)}s · Provider ${entry.provider}${out.mode ? ` · Mode ${out.mode}` : ''}</div>`;
          bodyEl.innerHTML = `${metrics}${formatAiAnswer(out.answer)}`;
        }
        const qualityScore = scoreBakeoffAnswerQuality(out.answer);
        const requestedProvider = entry.provider;
        const usedProvider = String(out.provider || '').trim().toLowerCase();
        const requestedModel = String(entry.model || '').trim().toLowerCase();
        const usedModel = String(out.modelUsed || out.modelRequested || '').trim().toLowerCase();
        const trueFallback = !!(out.fallbackReason || (requestedProvider && usedProvider && requestedProvider !== usedProvider) || (requestedModel && usedModel && requestedModel !== usedModel));
        liveEntries.push({
          model: entry.model,
          runs: 1,
          successRate: 1,
          qualityAvg: qualityScore,
          latencyP50Ms: latencyMs,
          latencyP95Ms: latencyMs,
          fallbackRate: trueFallback ? 1 : 0,
          composite: trueFallback ? 40 : 70,
          contextTokens: questionTokens || null,
          contextSize: questionTokens || null,
          context: questionTokens ? `${questionTokens} tok` : null
        });
      } catch (err) {
        card.classList.add('error');
        if (statusEl) statusEl.textContent = 'Failed';
        if (bodyEl) bodyEl.innerHTML = `<div>${escapeHtml(err?.message || 'Model error')}</div>`;
        liveEntries.push({
          model: entry.model,
          runs: 1,
          successRate: 0,
          qualityAvg: 0,
          latencyP50Ms: null,
          latencyP95Ms: null,
          fallbackRate: 1,
          composite: 30,
          contextTokens: questionTokens || null,
          contextSize: questionTokens || null,
          context: questionTokens ? `${questionTokens} tok` : null
        });
      }
    }
  } catch (err) {
    runFailed = true;
    console.error('bakeoff_run_failed', err);
    setBakeoffRunIndicator('error', `⚠️ Bake-off failed: ${escapeHtml(err?.message || 'unknown error')}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Test All Models';
    }
    if (!runFailed) {
      const ended = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const duration = ((ended - runStarted) / 1000).toFixed(1);
      setBakeoffRunIndicator('success', `✅ Bake-off finished in ${duration}s (${catalog.length} models)`);
      if (liveEntries.length) {
        await persistBakeoffLiveResults(liveEntries, {
          question,
          questionTokens,
          models: catalog.map(row => row.model),
          prompts: ['race-analysis-ui']
        });
      } else {
        loadBakeoffLeaderboard();
      }
    }
  }
}


async function persistBakeoffLiveResults(entries, meta = {}){
  if (!Array.isArray(entries) || !entries.length) {
    loadBakeoffLeaderboard();
    return;
  }
  const payload = buildBakeoffLiveData(entries, meta);
  const manualData = { ok: true, source: 'ui-bakeoff', sourceLabel: 'Live run', ...payload };
  loadBakeoffLeaderboard(manualData);
  try {
    const res = await fetchLocal('./api/model-bakeoff/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const out = await res.json();
    if (!res.ok || out?.ok === false) throw new Error(out?.error || `HTTP ${res.status}`);
    try { localStorage.setItem('betmanBakeoffLive', JSON.stringify(manualData)); } catch {}
    loadBakeoffLeaderboard();
  } catch (err) {
    console.warn('bakeoff_live_persist_failed', err);
  }
}

function scoreBakeoffAnswerQuality(answer){
  const text = String(answer || '').trim();
  if (!text) return 0;
  const lc = text.toLowerCase();
  const keywords = ['verdict','value','overlay','pace','runner','punter','confidence','staking','invalid','sim'];
  let hits = 0;
  keywords.forEach(k => { if (lc.includes(k)) hits++; });
  const coverageScore = keywords.length ? (hits / keywords.length) * 100 : 0;
  const lengthPenalty = text.length > 12000 ? Math.min(25, ((text.length - 12000) / 12000) * 100) : 0;
  return Math.max(0, Math.round(coverageScore - lengthPenalty));
}

function buildBakeoffLiveData(entries, meta = {}){
  const models = Array.isArray(meta.models) && meta.models.length ? meta.models : entries.map(e => e.model);
  const prompts = Array.isArray(meta.prompts) && meta.prompts.length ? meta.prompts : ['ui-bakeoff'];
  const questionTokens = Number(meta.questionTokens) || null;
  const generatedAt = new Date().toISOString();
  const leaderboard = entries.map((entry, idx) => ({
    model: entry.model || `model_${idx+1}` ,
    runs: Number(entry.runs) || 1,
    successRate: Number(entry.successRate) || 0,
    qualityAvg: entry.qualityAvg == null ? null : Number(entry.qualityAvg),
    latencyP50Ms: entry.latencyP50Ms == null ? null : Math.round(entry.latencyP50Ms),
    latencyP95Ms: entry.latencyP95Ms == null ? null : Math.round(entry.latencyP95Ms),
    fallbackRate: Number(entry.fallbackRate) || 0,
    composite: Number(entry.composite ?? entry.successRate ?? 0),
    contextTokens: entry.contextTokens ?? questionTokens ?? null,
    contextSize: entry.contextSize ?? questionTokens ?? null,
    context: entry.context || (questionTokens ? `${questionTokens} tok` : null)
  }));
  return {
    source: 'ui-bakeoff',
    generatedAt,
    models,
    runs: leaderboard.length,
    prompts,
    questionTokens,
    leaderboard
  };
}


function parsePctText(text){
  const m = String(text || '').match(/p\s*=\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)%/i);
  if (!m) return null;
  return Number(m[1] || m[2]);
}

function pushAiChat(role, text){
  const box = $('aiChatMessages');
  if (!box) return;
  const item = document.createElement('div');
  item.className = `ai-msg ${role}`;

  if (role === 'bot' && String(text || '').includes('\n')) {
    const lines = String(text).split(/\n+/).map(s=>s.trim()).filter(Boolean);
    item.innerHTML = lines.map(l => {
      if (/^[\-•]/.test(l)) return `<div>• ${escapeHtml(l.replace(/^[\-•]\s*/, ''))}</div>`;
      if (/^[A-Za-z][A-Za-z\s]{2,20}:/.test(l)) {
        const idx = l.indexOf(':');
        return `<div><b>${escapeHtml(l.slice(0, idx+1))}</b> ${escapeHtml(l.slice(idx+1).trim())}</div>`;
      }
      return `<div>${escapeHtml(l)}</div>`;
    }).join('');
  } else {
    item.textContent = text;
  }

  box.appendChild(item);
  box.scrollTop = box.scrollHeight;
}

function confidenceForDraggedSelection(x){
  const mtg = String(x?.meeting || '').trim().toLowerCase();
  const rc = String(x?.race || '').trim().replace(/^R/i,'');
  const sel = normalizeRunnerName(x?.selection || '');

  const hit = (latestSuggestedBets || []).find(s => {
    const sm = String(s.meeting || '').trim().toLowerCase();
    const sr = String(s.race || '').trim().replace(/^R/i,'');
    const ss = normalizeRunnerName(s.selection || s.runner || '');
    return sm === mtg && sr === rc && (ss === sel || ss.includes(sel) || sel.includes(ss));
  });
  if (hit) {
    const p = Number(hit.aiWinProb);
    if (Number.isFinite(p) && p > 0 && p <= 100) return p;
    const rp = parsePctText(hit.reason || '');
    if (Number.isFinite(rp)) return rp;
  }

  const race = (racesCache || []).find(r =>
    String(r.meeting || '').trim().toLowerCase() === mtg &&
    String(r.race_number || '').trim() === rc
  );
  if (race && Array.isArray(race.runners)) {
    const rr = race.runners.find(r => {
      const rn = normalizeRunnerName(r.name || r.runner_name || '');
      return rn === sel || rn.includes(sel) || sel.includes(rn);
    });
    const od = Number(rr?.odds || rr?.fixed_win || rr?.tote_win || 0);
    if (Number.isFinite(od) && od > 0) return 100 / od;
  }

  const rp = parsePctText(x?.reason || '');
  return Number.isFinite(rp) ? rp : null;
}

function enrichDraggedSelection(item){
  const mtg = String(item?.meeting || '').trim().toLowerCase();
  const rc = String(item?.race || '').trim().replace(/^R/i,'');
  const sel = normalizeRunnerName(item?.selection || item?.runner || '');

  const suggestedHit = (latestSuggestedBets || []).find(s => {
    const sm = String(s.meeting || '').trim().toLowerCase();
    const sr = String(s.race || '').trim().replace(/^R/i,'');
    const ss = normalizeRunnerName(s.selection || s.runner || '');
    return sm === mtg && sr === rc && (ss === sel || ss.includes(sel) || sel.includes(ss));
  });

  const interestingHit = (latestInterestingRows || []).find(r => {
    const rm = String(r.meeting || '').trim().toLowerCase();
    const rr = String(r.race || '').trim().replace(/^R/i,'');
    const rs = normalizeRunnerName(r.runner || r.selection || '');
    return rm === mtg && rr === rc && (rs === sel || rs.includes(sel) || sel.includes(rs));
  });

  const race = (racesCache || []).find(r => String(r.meeting || '').trim().toLowerCase() === mtg && String(r.race_number || r.race || '').trim() === rc);
  const runner = Array.isArray(race?.runners)
    ? race.runners.find(r => {
        const rn = normalizeRunnerName(r.name || r.runner_name || '');
        return rn === sel || rn.includes(sel) || sel.includes(rn);
      })
    : null;

  const tags = [];
  if (suggestedHit?.type) tags.push(String(suggestedHit.type));
  if (interestingHit) tags.push('Interesting');
  if (runnerHasStrongTrials(runner)) tags.push('Trial Form');
  const moveTags = buildMoveTags(interestingHit || suggestedHit || runner || {}).map(t => String(t).replace(/<[^>]+>/g,'').trim()).filter(Boolean);
  tags.push(...moveTags);

  const odds = Number(suggestedHit?.odds ?? runner?.odds ?? runner?.fixed_win ?? runner?.tote_win);
  const aiWinProb = Number(suggestedHit?.aiWinProb);
  const impliedPct = Number.isFinite(odds) && odds > 0 ? (100 / odds) : null;
  const edgePct = Number.isFinite(aiWinProb) && Number.isFinite(impliedPct) ? (aiWinProb - impliedPct) : null;

  return {
    ...item,
    selection: item?.selection || item?.runner || '',
    tags: [...new Set(tags.filter(Boolean))],
    odds: Number.isFinite(odds) ? odds : null,
    aiWinProb: Number.isFinite(aiWinProb) ? aiWinProb : null,
    impliedPct: Number.isFinite(impliedPct) ? impliedPct : null,
    edgePct: Number.isFinite(edgePct) ? edgePct : null,
    jockey: runner?.jockey || item?.jockey || null,
    trainer: runner?.trainer || item?.trainer || null,
    barrier: runner?.barrier || null,
    form: runner?.form || interestingHit?.form || null,
    confidence: confidenceForDraggedSelection(item)
  };
}

function buildDraggedContextLines(){
  return draggedSelections.map(raw => {
    const x = enrichDraggedSelection(raw);
    const bits = [
      `- ${x.meeting} R${x.race} ${x.selection}`,
      x.tags?.length ? `tags: ${x.tags.join(', ')}` : '',
      Number.isFinite(x.odds) ? `odds ${x.odds.toFixed(2)}` : '',
      Number.isFinite(x.aiWinProb) ? `model ${x.aiWinProb.toFixed(1)}%` : '',
      Number.isFinite(x.impliedPct) ? `implied ${x.impliedPct.toFixed(1)}%` : '',
      Number.isFinite(x.edgePct) ? `edge ${x.edgePct >= 0 ? '+' : ''}${x.edgePct.toFixed(1)} pts` : '',
      x.barrier ? `barrier ${x.barrier}` : '',
      x.jockey ? `jockey ${x.jockey}` : '',
      x.trainer ? `trainer ${x.trainer}` : '',
      x.form ? `form ${x.form}` : '',
      x.reason ? `note: ${x.reason}` : ''
    ].filter(Boolean);
    return bits.join(' | ');
  });
}

function likelyDraggedFormat(){
  const raceKeys = [...new Set(draggedSelections.map(x => `${x.meeting}|${x.race}`))];
  return raceKeys.length <= 1 ? 'Same-Race/H2H' : '2-Race Multi';
}

function renderAiSelectionBasket(){
  const wrap = $('aiSelectionBasket');
  if (!wrap) return;
  if (!draggedSelections.length) {
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }

  const rows = draggedSelections.map((raw, idx) => {
    const x = enrichDraggedSelection(raw);
    const label = `${x.meeting} R${x.race} ${x.selection}`.replace(/\s+/g,' ').trim();
    const pct = Number(x.confidence);
    const meter = Number.isFinite(pct) ? `<span class='ai-chip-meter'>${pct.toFixed(1)}%</span>` : `<span class='ai-chip-meter'>n/a</span>`;
    const meta = [
      x.tags?.length ? x.tags.join(', ') : '',
      Number.isFinite(x.odds) ? `Odds ${x.odds.toFixed(2)}` : '',
      Number.isFinite(x.edgePct) ? `Edge ${x.edgePct >= 0 ? '+' : ''}${x.edgePct.toFixed(1)} pts` : '',
      x.jockey ? `J ${x.jockey}` : '',
      x.trainer ? `T ${x.trainer}` : ''
    ].filter(Boolean).join(' · ');
    return `<span class='ai-chip'>${escapeHtml(label)} ${meter}${meta ? ` <span class='sub'>${escapeHtml(meta)}</span>` : ''} <button data-ai-remove='${idx}' title='Remove'>×</button></span>`;
  }).join('');

  wrap.classList.remove('hidden');
  wrap.innerHTML = `
    <div class='ai-basket-head'>
      <span>Dragged selections: ${draggedSelections.length} · Likely format: ${likelyDraggedFormat()}</span>
      <div class='btn-row'>
        <button id='aiBasketTrackMulti' class='btn btn-ghost compact-btn' ${draggedSelections.length >= 2 ? '' : 'disabled'}>Track Multi</button>
        <button id='aiBasketClear' class='btn btn-ghost compact-btn'>Clear</button>
      </div>
    </div>
    <div class='ai-basket-items'>${rows}</div>
  `;

  wrap.querySelector('#aiBasketTrackMulti')?.addEventListener('click', ()=>{
    trackDraggedSelectionsAsMulti().catch(() => alert('Failed to track multi.'));
  });
  wrap.querySelector('#aiBasketClear')?.addEventListener('click', ()=>{
    draggedSelections = [];
    renderAiSelectionBasket();
  });
  wrap.querySelectorAll('[data-ai-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const idx = Number(btn.getAttribute('data-ai-remove'));
      if (Number.isFinite(idx) && idx >= 0) draggedSelections.splice(idx, 1);
      renderAiSelectionBasket();
    });
  });
}

function makeSelectionsDraggable(){
  const selector = [
    '.suggested-btn',
    '.next-planned-btn',
    '.interesting-btn',
    '.multi-btn',
    '.analysis-drag-btn',
    '.analysis-runner-btn',
    '.analysis-odds-runner-btn',
    '[data-runner]',
    '[data-selection]',
    '[data-jockey]'
  ].join(', ');

  document.querySelectorAll(selector).forEach(el => {
    if (el.dataset.dndBound === '1') return;
    const selection = el.dataset.selection || el.dataset.runner || el.dataset.jockey || el.textContent?.trim() || '';
    if (!String(selection || '').trim()) return;
    el.dataset.dndBound = '1';
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      const payload = enrichDraggedSelection({
        meeting: el.dataset.meeting || selectedRace?.meeting || selectedMeeting || '',
        race: el.dataset.race || el.dataset.raceNumber || selectedRace?.race_number || '',
        selection,
        reason: el.dataset.reason || '',
        jockey: el.dataset.jockey || ''
      });
      e.dataTransfer.setData('application/json', JSON.stringify(payload));
      e.dataTransfer.setData('text/plain', `${payload.meeting} R${payload.race} ${payload.selection}`.trim());
    });
  });
}

function toggleAiChat(show){
  const panel = $('aiChatPanel');
  if (!panel) return;
  const shouldShow = (typeof show === 'boolean') ? show : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !shouldShow);
  panel.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  if (shouldShow && !$('aiChatMessages')?.children?.length) {
    pushAiChat('bot', 'Session ready. Drag runners to build context. Use Race Context / 2-Race Multi / Same-Race Multi / H2H prompts for faster analysis.');
  }
  if (shouldShow) renderAiSelectionBasket();
}

function getAiScenarios(){
  try { return JSON.parse(localStorage.getItem('aiScenarios') || '[]'); } catch { return []; }
}

function setAiScenarios(rows){
  localStorage.setItem('aiScenarios', JSON.stringify(rows || []));
}

function refreshAiScenarioSelect(){
  const sel = $('aiScenarioSelect');
  if (!sel) return;
  const rows = getAiScenarios();
  sel.innerHTML = `<option value=''>Scenarios</option>` + rows.map((r, i) => `<option value='${i}'>${escapeHtml(r.name)}</option>`).join('');
}

function saveAiScenario(){
  if (!draggedSelections.length) return pushAiChat('bot', 'Drag at least one runner before saving a scenario.');
  const name = String($('aiScenarioName')?.value || '').trim() || `Set ${new Date().toLocaleTimeString()}`;
  const rows = getAiScenarios();
  rows.unshift({ name, items: draggedSelections.slice(0, 20) });
  setAiScenarios(rows.slice(0, 20));
  refreshAiScenarioSelect();
  pushAiChat('bot', `Saved scenario: ${name}`);
}

function loadAiScenario(){
  const sel = $('aiScenarioSelect');
  const idx = Number(sel?.value || -1);
  const rows = getAiScenarios();
  if (!Number.isFinite(idx) || idx < 0 || idx >= rows.length) return;
  draggedSelections = Array.isArray(rows[idx].items) ? rows[idx].items.slice(0, 20) : [];
  renderAiSelectionBasket();
  toggleAiChat(true);
  pushAiChat('bot', `Loaded scenario: ${rows[idx].name}`);
}

function newAiChatSession(){
  draggedSelections = [];
  renderAiSelectionBasket();
  const box = $('aiChatMessages');
  if (box) box.innerHTML = '';
  const input = $('aiChatInput');
  if (input) input.value = '';
  pushAiChat('bot', 'New session started. Context cleared. Drag fresh runners or ask a new question.');
}

async function sendAiChat(){
  const input = $('aiChatInput');
  const sendBtn = $('aiChatSend');
  let q = String(input?.value || '').trim();

  if (!q && draggedSelections.length) {
    const lines = buildDraggedContextLines();
    q = `Using only these dragged runners, provide ranked win chances, best structure, edge vs market, and key risks:\n${lines.join('\n')}`;
  }
  if (!q) return;

  const rememberMatch = q.match(/^(?:remember|note|save\s+note)\s*:\s*(.+)$/i);
  if (rememberMatch) {
    const entry = addAiUserNote(rememberMatch[1], selectedMeeting);
    pushAiChat('user', q);
    pushAiChat('bot', entry ? `Saved note${entry.meeting ? ` for ${entry.meeting}` : ''}: ${entry.text}` : 'Unable to save note.');
    return;
  }

  const recallMatch = q.match(/^(?:recall|what\s+do\s+you\s+remember|show\s+notes)(?:\s*:\s*(.*))?$/i);
  if (recallMatch) {
    const keyword = String(recallMatch[1] || '').trim();
    const notes = queryAiUserNotes(keyword, selectedMeeting);
    pushAiChat('user', q);
    if (!notes.length) {
      pushAiChat('bot', 'No stored notes found for this context.');
    } else {
      const lines = notes.map((n, idx) => `${idx + 1}. ${n.meeting ? `${n.meeting} — ` : ''}${n.text}`).join('\n');
      pushAiChat('bot', `Stored notes:\n${lines}`);
    }
    return;
  }

  const selectionCount = draggedSelections.length;
  const biasUpdate = registerMeetingBiasFromUserText(q, selectedMeeting);
  pushAiChat('user', q);
  if (biasUpdate) {
    pushAiChat('bot', `Track-bias note saved for ${selectedMeeting}: ${biasUpdate.insideRail ? 'inside rail' : ''}${biasUpdate.insideRail && (biasUpdate.swoopers || biasUpdate.leaders) ? ' + ' : ''}${biasUpdate.swoopers ? 'swoopers/off-speed' : ''}${(biasUpdate.insideRail || biasUpdate.swoopers) && biasUpdate.leaders ? ' + ' : ''}${biasUpdate.leaders ? 'leaders/on-pace' : ''}. Will apply to upcoming race calculations.`);
  }
  if (input) input.value = '';

  const box = $('aiChatMessages');
  const thinking = document.createElement('div');
  thinking.className = 'ai-msg bot thinking';
  thinking.textContent = 'AI is thinking…';
  box?.appendChild(thinking);
  if (box) box.scrollTop = box.scrollHeight;

  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = 'Thinking…';
  }

  try {
    const raceKeys = [...new Set((draggedSelections || []).map(x => `${x.meeting}|${x.race}`))];
    const chatHistory = [...document.querySelectorAll('#aiChatMessages .ai-msg')].slice(-8).map(el => ({
      role: el.classList.contains('user') ? 'user' : 'assistant',
      text: String(el.textContent || '')
    }));
    const recentNotes = queryAiUserNotes('', selectedMeeting).slice(0, 5).map(n => ({
      text: n.text,
      meeting: n.meeting,
      createdAt: n.createdAt
    }));

    const res = await fetchLocal('./api/ask-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: q,
        source: draggedSelections.length ? 'strategy' : 'chat',
        selectionCount,
        selections: draggedSelections,
        multiRaceContext: {
          enabled: raceKeys.length > 1,
          raceCount: raceKeys.length,
          races: raceKeys
        },
        uiContext: {
          day: selectedDay,
          country: selectedCountry,
          meeting: selectedMeeting
        },
        provider: selectedAiModel.provider,
        model: selectedAiModel.model,
        chatHistory,
        userNotes: recentNotes
      })
    });
    const out = await res.json();
    thinking.remove();
    const modeBadge = formatAiModeBadge(out.mode);
    pushAiChat('bot', `${modeBadge} ${out.answer || 'No answer available.'}`);
  } catch {
    thinking.remove();
    pushAiChat('bot', 'Unable to answer right now. Try again.');
  } finally {
    renderAiSelectionBasket();
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Ask';
    }
  }
}

async function auditAiChatModels(){
  const PREVIEW_MAX_LENGTH = 400;
  const auditBtn = $('aiChatAuditBtn');
  const input = $('aiChatInput');
  const box = $('aiChatMessages');

  // Resolve question: use input value or fall back to last user message in chat
  let q = String(input?.value || '').trim();
  if (!q) {
    const lastUser = [...(box?.querySelectorAll('.ai-msg.user') || [])].slice(-1)[0];
    q = lastUser ? String(lastUser.textContent || '').trim() : '';
  }
  if (!q && draggedSelections.length) {
    const lines = buildDraggedContextLines();
    q = `Using only these dragged runners, provide ranked win chances, best structure, edge vs market, and key risks:\n${lines.join('\n')}`;
  }
  if (!q) return pushAiChat('bot', 'Enter a question first, then tap Compare.');

  if (!((aiModelCatalog.ollamaModels || []).length || (aiModelCatalog.openaiModels || []).length)) {
    await loadAiModels().catch(()=>{});
  }

  const catalog = [
    ...(aiModelCatalog.ollamaModels || []).map(m => ({ provider: 'ollama', model: m })),
    ...(aiModelCatalog.capabilities?.openaiPermitted ? (aiModelCatalog.openaiModels || []).map(m => ({ provider: 'openai', model: m })) : [])
  ];
  if (!catalog.length) return pushAiChat('bot', 'No models available to compare. Configure Ollama or add an OpenAI key.');

  if (auditBtn) { auditBtn.disabled = true; auditBtn.textContent = '⏱ Running…'; }

  // Show "thinking" placeholder
  const thinking = document.createElement('div');
  thinking.className = 'ai-msg bot thinking';
  thinking.textContent = `Comparing ${catalog.length} model${catalog.length > 1 ? 's' : ''} in parallel…`;
  box?.appendChild(thinking);
  if (box) box.scrollTop = box.scrollHeight;

  // Build shared payload (same shape as sendAiChat)
  const raceKeys = [...new Set((draggedSelections || []).map(x => `${x.meeting}|${x.race}`))];
  const recentNotes = queryAiUserNotes('', selectedMeeting).slice(0, 5).map(n => ({
    text: n.text, meeting: n.meeting, createdAt: n.createdAt
  }));
  const basePayload = {
    question: q,
    source: draggedSelections.length ? 'strategy' : 'chat',
    selectionCount: draggedSelections.length,
    selections: draggedSelections,
    multiRaceContext: { enabled: raceKeys.length > 1, raceCount: raceKeys.length, races: raceKeys },
    uiContext: { day: selectedDay, country: selectedCountry, meeting: selectedMeeting },
    userNotes: recentNotes
  };

  // Fire all models in parallel
  const results = await Promise.allSettled(catalog.map(async entry => {
    const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const res = await fetchLocal('./api/ask-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basePayload, provider: entry.provider, model: entry.model })
    });
    const out = await res.json();
    const latencyMs = Math.round(((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - started);
    if (!res.ok || !out?.ok) throw Object.assign(new Error(out?.error || `HTTP ${res.status}`), { entry, latencyMs });
    return { entry, out, latencyMs };
  }));

  thinking.remove();

  // Render comparison block
  const cards = results.map(r => {
    if (r.status === 'fulfilled') {
      const { entry, out, latencyMs } = r.value;
      const latSec = (latencyMs / 1000).toFixed(2);
      const preview = String(out.answer || '').trim().slice(0, PREVIEW_MAX_LENGTH) + (String(out.answer || '').length > PREVIEW_MAX_LENGTH ? '…' : '');
      return `<div class="bakeoff-test-card success">
        <div class="head"><div>${escapeHtml(entry.model)} <span class="provider">(${escapeHtml(entry.provider)})</span></div><div class="status">OK · ${latSec}s</div></div>
        <div class="body"><div class="bakeoff-metrics">${latSec}s · ${escapeHtml(out.mode || 'ai')}${out.modelUsed && out.modelUsed !== entry.model ? ` · used ${escapeHtml(out.modelUsed)}` : ''}</div>${formatAiAnswer(preview)}</div>
      </div>`;
    } else {
      const err = r.reason;
      const entry = err?.entry || {};
      const latSec = err?.latencyMs ? (err.latencyMs / 1000).toFixed(2) + 's' : '—';
      return `<div class="bakeoff-test-card error">
        <div class="head"><div>${escapeHtml(entry.model || 'unknown')} <span class="provider">(${escapeHtml(entry.provider || '?')})</span></div><div class="status">Error · ${latSec}</div></div>
        <div class="body">${escapeHtml(String(err?.message || 'Failed'))}</div>
      </div>`;
    }
  }).join('');

  const wrapper = document.createElement('div');
  wrapper.className = 'ai-msg bot';
  wrapper.innerHTML = `<div class="ai-audit-compare"><div class="ai-audit-head">⚖️ Model Comparison — ${escapeHtml(q.slice(0, 80))}${q.length > 80 ? '…' : ''}</div><div class="bakeoff-test-results" style="margin-top:8px">${cards}</div></div>`;
  box?.appendChild(wrapper);
  if (box) box.scrollTop = box.scrollHeight;

  if (auditBtn) { auditBtn.disabled = false; auditBtn.textContent = '⚖️ Compare'; }
}

function clearApiKeySecretDisplay(){
  latestGeneratedApiKey = null;
  const secretInput = $('apiKeySecretValue');
  if (secretInput) secretInput.value = '';
  const copyBtn = $('apiKeyCopyBtn');
  if (copyBtn) copyBtn.style.display = 'none';
  const secretWrap = $('apiKeySecretWrap');
  if (secretWrap) secretWrap.classList.add('hidden');
}

function updatePulseEntitlementUi(){
  const watchbar = $('alertsPulseWatchbar');
  if (watchbar) watchbar.style.display = pulseEligible ? '' : 'none';
}

function updateApiKeyPanel(){
  const panel = $('apiKeyPanel');
  if (!panel) return;
  panel.classList.toggle('hidden', !apiKeyEligible);
  if (!apiKeyEligible) {
    const status = $('apiKeyStatus');
    if (status) status.textContent = 'Sign in to generate an API key.';
    clearApiKeySecretDisplay();
    return;
  }
  const status = $('apiKeyStatus');
  if (status) {
    if (apiKeyCreatedAt) {
      const ts = new Date(apiKeyCreatedAt).toLocaleString();
      const tail = apiKeyPreview ? ` (ending ${apiKeyPreview})` : '';
      status.textContent = `API key generated ${ts}${tail}. Generate again to rotate.`;
    } else {
      status.textContent = 'Generate an API key to call BETMAN Pulse. Live Haptics and Heat Maps. via HTTP Basic auth.';
    }
  }
  const secretWrap = $('apiKeySecretWrap');
  if (secretWrap) secretWrap.classList.toggle('hidden', !latestGeneratedApiKey);
  const copyBtn = $('apiKeyCopyBtn');
  if (copyBtn) copyBtn.style.display = latestGeneratedApiKey ? '' : 'none';
  const secretInput = $('apiKeySecretValue');
  if (secretInput && latestGeneratedApiKey) {
    secretInput.value = latestGeneratedApiKey;
  }
}

function toggleAuthModal(show){
  const modal = $('authModal');
  if (!modal) return;
  const shouldShow = (typeof show === 'boolean') ? show : modal.classList.contains('hidden');
  modal.classList.toggle('hidden', !shouldShow);
  modal.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  if (!shouldShow) {
    clearApiKeySecretDisplay();
  } else {
    updateApiKeyPanel();
  }
}

function setAdminTab(tab='create'){
  document.querySelectorAll('.admin-tab-btn').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.adminTab === tab);
  });
  document.querySelectorAll('.admin-tab-panel').forEach(p=>{
    p.style.display = p.dataset.adminPanel === tab ? '' : 'none';
  });
}

function syncCreateUserPlanFields(){
  const plan = String($('createUserPlanType')?.value || 'single');
  const fn = $('createUserFirstName');
  const ln = $('createUserLastName');
  const cn = $('createUserCompanyName');
  if (!fn || !ln || !cn) return;
  const isCommercial = plan === 'commercial';
  fn.disabled = isCommercial;
  ln.disabled = isCommercial;
  cn.disabled = !isCommercial;
  if (isCommercial) {
    fn.value = '';
    ln.value = '';
  } else {
    cn.value = '';
  }
}

function applyPerformanceVisibility(){
  const show = !!isAdminUser;
  document.querySelectorAll('[data-roi-only]').forEach(el => {
    el.style.display = show ? '' : 'none';
  });
  const hint = $('roiAdminHint');
  if (hint) hint.style.display = show ? 'none' : '';
}

async function loadOfferStrip(){
  const el = $('offerStrip');
  if (!el) return;
  try {
    const out = await fetchLocal('./api/pricing', { cache: 'no-store' }).then(r=>r.json());
    const cards = [
      { key: 'single_day', title: 'BETMAN Single DAY', note: '24-hour racing access. Perfect for QR-code offers and trial conversion.', cls: 'pricing-card-tester' },
      { key: 'single', title: 'Weekly Subscription', note: 'Weekly access for individual punters.', cls: 'pricing-card-single' },
      { key: 'commercial', title: 'BETMAN Pulse. Live Haptics and Heat Maps.', note: 'Multi-user / business access.', cls: 'pricing-card-commercial' }
    ].filter(x => out?.[x.key]?.paymentLink);
    el.innerHTML = cards.map(card => {
      const item = out[card.key] || {};
      return `<a class='pricing-card ${card.cls}' href='${escapeAttr(item.paymentLink || '#')}' target='_blank' rel='noreferrer'>
        <div class='plan-label'>${escapeHtml(card.title)}</div>
        <div class='plan-price'>${escapeHtml(item.price || '—')}</div>
        <div class='plan-note'>${escapeHtml(card.note)}</div>
      </a>`;
    }).join('');
  } catch {
    el.innerHTML = `<div class='sub'>Pricing unavailable right now.</div>`;
  }
}

async function loadAuthenticatedUser(){
  const el = $('authUserPill');
  if (!el) return;
  try {
    const cfg = await fetchLocal('./api/auth-config', { cache: 'no-store' }).then(r=>r.json());
    const u = String(cfg?.currentUser || '').trim();
    const first = String(cfg?.currentUserFirstName || cfg?.firstName || cfg?.profile?.firstName || '').trim();
    const last = String(cfg?.currentUserLastName || cfg?.lastName || cfg?.profile?.lastName || '').trim();
    currentUserDisplayName = [first, last].filter(Boolean).join(' ').trim() || u || 'User';
    isAdminUser = !!cfg?.isAdmin;
    pulseEligible = !!cfg?.pulseEligible;
    apiKeyEligible = !!cfg?.apiKeyEligible;
    apiKeyCreatedAt = cfg?.apiKeyCreatedAt || null;
    apiKeyPreview = cfg?.apiKeyPreview || null;
    el.textContent = `Authenticated User ${u || '—'}`;
  } catch {
    isAdminUser = false;
    pulseEligible = false;
    currentUserDisplayName = 'User';
    el.textContent = 'Authenticated User —';
    apiKeyEligible = false;
    apiKeyCreatedAt = null;
    apiKeyPreview = null;
    clearApiKeySecretDisplay();
  }
  const trainBtn = $('trainModelsBtn');
  if (trainBtn) {
    trainBtn.style.display = isAdminUser ? '' : 'none';
    trainBtn.disabled = !isAdminUser;
    trainBtn.title = isAdminUser ? '' : 'Admin only';
  }
  applyPerformanceVisibility();
  refreshTabAccess();
  updatePulseEntitlementUi();
  updateApiKeyPanel();
  if (!pulseEligible && activePage === 'pulse') setActivePage('workspace');
  if (!isAdminUser && (activePage === 'bakeoff' || activePage === 'performance')) setActivePage('workspace');
}

async function renderAuthPulseSettingsPanel(){
  const root = $('authPulseSettingsBody');
  if (!root) return;
  if (!pulseEligible) {
    root.innerHTML = `<div class='row'><div style='grid-column:1/-1'><b>Pulse</b> is available after sign-in. Alerts remains available as the broad market monitor; sign in again if your session has expired.</div></div>`;
    return;
  }
  root.innerHTML = `<div class='row'><div style='grid-column:1/-1'>Loading Pulse settings…</div></div>`;
  try {
    const cfg = await loadPulseConfig();
    const thresholds = cfg?.thresholds || {};
    const alertTypes = cfg?.alertTypes || {};
    const targeting = normalizePulseTargeting(cfg?.targeting || {});
    const alertTypeMarkup = pulseTypeMeta().map(item => `<div style='display:flex;justify-content:space-between;gap:10px'><span>${escapeHtml(item.label)}</span><span class='tag ${alertTypes[item.key] ? 'win' : ''}'>${alertTypes[item.key] ? 'Enabled' : 'Disabled'}</span></div>`).join('');
    root.innerHTML = `
      <div class='row'><div><b>Pulse feed</b></div><div>${cfg?.enabled === false ? 'Disabled' : 'Enabled'}</div></div>
      <div class='row'><div><b>Scope</b></div><div>${escapeHtml(pulseTargetingSummary(targeting))}</div></div>
      <div class='row'><div><b>Time gate</b></div><div>${thresholds.maxMinsToJump == null ? 'Off' : `${thresholds.maxMinsToJump} minutes to jump`}</div></div>
      <div class='row'><div><b>Minimum severity</b></div><div>${escapeHtml(String(thresholds.minSeverity || 'WATCH'))}</div></div>
      <div class='row'><div><b>Minimum move %</b></div><div>${thresholds.minMovePct == null ? 'Off' : `${thresholds.minMovePct}%`}</div></div>
      <div class='row'><div><b>Tracked override</b></div><div>${thresholds.trackedRunnerOverride ? 'On' : 'Off'}</div></div>
      <div class='row'><div><b>Alert rules</b></div><div style='display:grid;gap:6px'>${alertTypeMarkup}</div></div>
      <div class='row'><div style='grid-column:1/-1'><button id='openPulseConfigFromAuth' class='btn btn-ghost compact-btn'>Open Full Pulse Config</button></div></div>
    `;
    $('openPulseConfigFromAuth')?.addEventListener('click', () => {
      toggleAuthModal(false);
      setActivePage('pulse');
      setActivePulseTab('config');
      renderPulseConfigPanel();
    });
  } catch {
    root.innerHTML = `<div class='row'><div style='grid-column:1/-1'>Unable to load Pulse settings right now.</div></div>`;
  }
}

async function openAuthModal(){
  toggleAuthModal(true);
  let isAdmin = false;
  try {
    const current = await fetchLocal('./api/auth-config', { cache: 'no-store' }).then(r=>r.json());
    if (current?.username) $('authUsername').value = current.username;
    isAdmin = !!current?.isAdmin;
    pulseEligible = !!current?.pulseEligible;
    apiKeyEligible = !!current?.apiKeyEligible;
    apiKeyCreatedAt = current?.apiKeyCreatedAt || null;
    apiKeyPreview = current?.apiKeyPreview || null;
  } catch {
    pulseEligible = false;
    apiKeyEligible = false;
    apiKeyCreatedAt = null;
    apiKeyPreview = null;
  }
  updatePulseEntitlementUi();
  updateApiKeyPanel();
  await renderAuthPulseSettingsPanel();

  const adminBlock = $('adminAuthBlock');
  if (adminBlock) adminBlock.style.display = isAdmin ? '' : 'none';
  const adminNotice = $('adminPermissionNotice');
  if (adminNotice) adminNotice.style.display = 'none';

  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.disabled = !isAdmin;
    btn.classList.toggle('disabled', !isAdmin);
  });

  if (isAdmin) setAdminTab('create');

  if (isAdmin) {
    syncCreateUserPlanFields();
  }
}

async function changeMyPassword(){
  const currentPassword = String($('selfCurrentPassword')?.value || '');
  const newPassword = String($('selfNewPassword')?.value || '');
  if (!currentPassword || !newPassword) return alert('Fill current and new password.');
  try {
    const res = await fetchLocal('./api/auth-self-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const out = await res.json();
    if (!res.ok || out.ok === false) return alert(`Change password failed: ${out.error || res.status}`);
    $('selfCurrentPassword').value = '';
    $('selfNewPassword').value = '';
    alert('Password updated. You may be prompted to log in again.');
  } catch {
    alert('Unable to change password right now.');
  }
}

async function generateApiKey(){
  if (!apiKeyEligible) {
    return alert('Sign in to generate an API key.');
  }
  if (!confirm('Generate a new API key? This will revoke any previous key.')) return;
  try {
    const res = await fetchLocal('./api/auth-self-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const out = await res.json();
    if (!res.ok || out.ok === false) {
      return alert(`API key generation failed: ${out.error || res.status}`);
    }
    latestGeneratedApiKey = out.apiKey || '';
    apiKeyCreatedAt = out.createdAt || new Date().toISOString();
    apiKeyPreview = latestGeneratedApiKey ? latestGeneratedApiKey.slice(-6) : null;
    updateApiKeyPanel();
    alert('API key created. Copy and store it securely — it will not be shown again.');
  } catch {
    alert('Unable to generate an API key right now.');
  }
}

async function copyApiKeyToClipboard(){
  const secret = $('apiKeySecretValue')?.value || '';
  if (!secret) return;
  try {
    await navigator.clipboard.writeText(secret);
    alert('API key copied to clipboard.');
  } catch {
    const input = $('apiKeySecretValue');
    if (input) {
      input.select();
      document.execCommand('copy');
      input.blur();
      alert('API key copied to clipboard.');
    }
  }
}

async function saveAuthFromModal(){
  const newUsername = String($('authUsername')?.value || '').trim();
  const currentPassword = String($('authCurrentPassword')?.value || '');
  const newPassword = String($('authNewPassword')?.value || '');
  if (!newUsername || !currentPassword || !newPassword) return alert('Fill all fields.');

  try {
    const res = await fetchLocal('./api/auth-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newUsername, newPassword })
    });
    const out = await res.json();
    if (!res.ok || out.ok === false) return alert(`Failed: ${out.error || res.status}`);
    $('authCurrentPassword').value = '';
    $('authNewPassword').value = '';
    alert('Credentials updated. Browser may prompt you to log in again.');
    toggleAuthModal(false);
  } catch {
    alert('Unable to update credentials right now.');
  }
}

async function createAuthUser(){
  const currentPassword = String(prompt('Admin password (required):') || '');
  if (!currentPassword) return;
  const planType = String($('createUserPlanType')?.value || 'single').trim();
  const firstName = String($('createUserFirstName')?.value || '').trim();
  const lastName = String($('createUserLastName')?.value || '').trim();
  const companyName = String($('createUserCompanyName')?.value || '').trim();
  const email = String($('createUserEmail')?.value || '').trim().toLowerCase();
  const password = String($('createUserPassword')?.value || '');
  const verificationText = String($('createUserVerification')?.value || '').trim().toUpperCase();
  const verified = !!$('createUserVerified')?.checked;
  const hasPersonName = !!(firstName && lastName);
  const hasCompany = !!companyName;
  if (((planType === 'single' || planType === 'single_day') && !hasPersonName) || (planType === 'commercial' && !hasCompany) || !email || !password) {
    return alert(planType === 'commercial'
      ? 'BETMAN Pulse. Live Haptics and Heat Maps. plan requires Company name, email, and password.'
      : 'Single User / Single DAY plan requires First + Last name, email, and password.');
  }

  try {
    const res = await fetchLocal('./api/auth-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword,
        planType,
        firstName,
        lastName,
        companyName,
        email,
        password,
        verificationText,
        verified
      })
    });
    const out = await res.json();
    if (!res.ok || out.ok === false) return alert(`Create user failed: ${out.error || res.status}`);
    $('createUserFirstName').value = '';
    $('createUserLastName').value = '';
    $('createUserCompanyName').value = '';
    $('createUserEmail').value = '';
    $('createUserPassword').value = '';
    $('createUserVerification').value = '';
    if ($('createUserVerified')) $('createUserVerified').checked = false;
    await openAuthModal();
    alert(`User created: ${out.user}`);
  } catch {
    alert('Unable to create user right now.');
  }
}

async function changeAuthUserPassword(){
  const currentPassword = String(prompt('Admin password (required):') || '');
  if (!currentPassword) return;
  const username = String($('changeUserUsername')?.value || '').trim();
  const newPassword = String($('changeUserPassword')?.value || '');
  if (!username || !newPassword) return alert('Enter username and new password.');

  try {
    const res = await fetchLocal('./api/auth-users/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, username, newPassword })
    });
    const out = await res.json();
    if (!res.ok || out.ok === false) return alert(`Change password failed: ${out.error || res.status}`);
    $('changeUserUsername').value = '';
    $('changeUserPassword').value = '';
    await openAuthModal();
    alert(`Password updated for: ${out.user}`);
  } catch {
    alert('Unable to change password right now.');
  }
}

async function deleteAuthUser(){
  const currentPassword = String(prompt('Admin password (required):') || '');
  if (!currentPassword) return;
  const username = String($('deleteUserUsername')?.value || '').trim();
  if (!username) return alert('Enter username to delete.');
  if (!confirm(`Delete user \"${username}\"?`)) return;

  try {
    const res = await fetchLocal('./api/auth-users/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, username })
    });
    const out = await res.json();
    if (!res.ok || out.ok === false) return alert(`Delete user failed: ${out.error || res.status}`);
    $('deleteUserUsername').value = '';
    await openAuthModal();
    alert(`User deleted: ${out.user}`);
  } catch {
    alert('Unable to delete user right now.');
  }
}

function setupAiChatDropzone(){
  const panel = $('aiChatPanel');
  const input = $('aiChatInput');
  if (!panel || !input) return;

  function rebuildMultiPrompt(mode='auto'){
    if (!draggedSelections.length) return;
    const lines = draggedSelections.map(x =>
      `- ${x.meeting} R${x.race} ${x.selection}${x.reason ? ` (${x.reason})` : ''}`.trim()
    );
    const raceKeys = [...new Set(draggedSelections.map(x => `${x.meeting}|${x.race}`))];
    const likely = raceKeys.length <= 1 ? 'Likely format: Same-Race Multi / H2H.' : 'Likely format: 2-Race Multi.';

    if (mode === 'race') {
      input.value = `Provide race context for these runners only: rank by win chance, map shape, risk factors, and a final top pick.\n${lines.join('\n')}`;
    } else if (mode === 'two') {
      input.value = `Build a 2-Race Multi from these runners only. Give best pair, probability chain, combined odds logic, and invalidation points.\n${lines.join('\n')}`;
    } else if (mode === 'same') {
      input.value = `Build a Same-Race Multi / H2H view from these runners only. Rank combinations, estimate likely outcomes, and key risks.\n${lines.join('\n')}`;
    } else {
      input.value = `${likely} Using only these dragged runners, rank by win chance, build best structures, show edge vs market, and list key risks:\n${lines.join('\n')}`;
    }
  }

  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter','dragover'].forEach(evt => panel.addEventListener(evt, (e)=>{ prevent(e); panel.classList.add('drag-over'); }));
  ['dragleave','drop'].forEach(evt => panel.addEventListener(evt, (e)=>{ prevent(e); panel.classList.remove('drag-over'); }));

  panel.addEventListener('drop', (e) => {
    // 1) Preferred JSON payload (single item from draggable selection button)
    let payload = null;
    try { payload = JSON.parse(e.dataTransfer.getData('application/json') || '{}'); } catch {}
    if (payload && payload.selection) {
      const key = `${payload.meeting}|${payload.race}|${payload.selection}`.toLowerCase();
      if (!draggedSelections.some(x => `${x.meeting}|${x.race}|${x.selection}`.toLowerCase() === key)) {
        draggedSelections.push({
          meeting: payload.meeting || '',
          race: payload.race || '',
          selection: payload.selection || '',
          reason: payload.reason || ''
        });
      }
    } else {
      // 2) Fallback text payload
      const plain = (e.dataTransfer.getData('text/plain') || '').trim();
      if (plain) {
        const key = `text||${plain}`.toLowerCase();
        if (!draggedSelections.some(x => `${x.meeting}|${x.race}|${x.selection}`.toLowerCase() === key)) {
          draggedSelections.push({ meeting: 'Selection', race: '-', selection: plain, reason: '' });
        }
      }
    }

    if (!draggedSelections.length) return;
    toggleAiChat(true);
    renderAiSelectionBasket();
    rebuildMultiPrompt('auto');
    input.focus();
  });
}

function setupAiChatDraggable(){
  const panel = $('aiChatPanel');
  if (!panel) return;
  const head = panel.querySelector('.ai-chat-head');
  if (!head) return;

  const key = 'aiChatPosition';
  const clamp = () => {
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
    let left = rect.left;
    let top = rect.top;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (left > maxLeft) left = maxLeft;
    if (top > maxTop) top = maxTop;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
  };

  try {
    const saved = JSON.parse(localStorage.getItem(key) || '{}');
    if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      panel.style.left = `${saved.left}px`;
      panel.style.top = `${saved.top}px`;
      panel.style.right = 'auto';
      clamp();
    }
  } catch {}

  let dragging = false;
  let dx = 0;
  let dy = 0;

  const onMove = (e) => {
    if (!dragging) return;
    const x = e.clientX - dx;
    const y = e.clientY - dy;
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.right = 'auto';
    clamp();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging-ai-chat');
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(key, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target && e.target.closest('button, input, select, textarea, a')) return;
    const rect = panel.getBoundingClientRect();
    dragging = true;
    dx = e.clientX - rect.left;
    dy = e.clientY - rect.top;
    document.body.classList.add('dragging-ai-chat');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  window.addEventListener('resize', clamp);
}

function printAiChat(){
  const msgs = [...document.querySelectorAll('#aiChatMessages .ai-msg')].map(el => {
    const who = el.classList.contains('user') ? 'You' : 'AI';
    return `<div style="margin:0 0 10px"><b>${who}:</b> ${String(el.textContent || '').replace(/</g,'&lt;')}</div>`;
  }).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>BETMAN AI Chat</title></head><body style="font-family:Inter,Arial,sans-serif;padding:24px;color:#111"><h2>BETMAN AI Chat Transcript</h2>${msgs || '<div>No messages.</div>'}</body></html>`;
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return alert('Unable to open print preview.');
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

$('aiChatToggle')?.addEventListener('click', ()=>toggleAiChat());
$('aiChatToggleFloating')?.addEventListener('click', ()=>toggleAiChat());
$('aiChatClose')?.addEventListener('click', ()=>toggleAiChat(false));
$('aiChatNewSession')?.addEventListener('click', newAiChatSession);
$('aiScenarioSave')?.addEventListener('click', saveAiScenario);
$('aiScenarioLoad')?.addEventListener('click', loadAiScenario);
$('aiChatPrint')?.addEventListener('click', printAiChat);
$('aiChatAnalyzeBasket')?.addEventListener('click', ()=>{
  if (!draggedSelections.length) return pushAiChat('bot', 'Drag runners first, then tap Analyze Basket.');
  const input = $('aiChatInput');
  if (input) input.value = '';
  sendAiChat();
});
$('aiChatSend')?.addEventListener('click', sendAiChat);
$('aiChatAuditBtn')?.addEventListener('click', auditAiChatModels);
$('aiFormatRace')?.addEventListener('click', ()=>{
  if (!draggedSelections.length) return pushAiChat('bot', 'Drag at least one runner first, then use Race Context.');
  const input = $('aiChatInput');
  if (input) {
    const lines = draggedSelections.map(x => `- ${x.meeting} R${x.race} ${x.selection}`).join('\n');
    input.value = `Provide race context for these runners only: rank by win chance, map shape, risk factors, and final top pick.\n${lines}`;
    input.focus();
  }
});
$('aiFormatTwoRace')?.addEventListener('click', ()=>{
  if (!draggedSelections.length) return pushAiChat('bot', 'Drag runners first, then select 2-Race Multi.');
  const input = $('aiChatInput');
  if (input) {
    const lines = draggedSelections.map(x => `- ${x.meeting} R${x.race} ${x.selection}`).join('\n');
    input.value = `Build a 2-Race Multi from these runners only. Give best pair, probability chain, odds logic, and invalidation points.\n${lines}`;
    input.focus();
  }
});
$('aiFormatThreeRace')?.addEventListener('click', ()=>{
  if (!draggedSelections.length) return pushAiChat('bot', 'Drag runners first, then select 3-Race Multi.');
  const input = $('aiChatInput');
  if (input) {
    const lines = draggedSelections.map(x => `- ${x.meeting} R${x.race} ${x.selection}`).join('\n');
    input.value = `Build a 3-Race Multi from these runners only. Rank the best 3-leg structure, chain probability, combined odds logic, and invalidation points.\n${lines}`;
    input.focus();
  }
});
$('aiFormatFourRace')?.addEventListener('click', ()=>{
  if (!draggedSelections.length) return pushAiChat('bot', 'Drag runners first, then select 4-Race Multi.');
  const input = $('aiChatInput');
  if (input) {
    const lines = draggedSelections.map(x => `- ${x.meeting} R${x.race} ${x.selection}`).join('\n');
    input.value = `Build a 4-Race Multi from these runners only. Rank the best 4-leg structure, chain probability, combined odds logic, and invalidation points.\n${lines}`;
    input.focus();
  }
});
$('aiFormatSameRace')?.addEventListener('click', ()=>{
  if (!draggedSelections.length) return pushAiChat('bot', 'Drag runners first, then select Same-Race Multi.');
  const input = $('aiChatInput');
  if (input) {
    const lines = draggedSelections.map(x => `- ${x.meeting} R${x.race} ${x.selection}`).join('\n');
    input.value = `Build a Same-Race Multi view from these runners only. Rank combinations, likely outcomes, and key risks.\n${lines}`;
    input.focus();
  }
});
$('aiFormatH2H')?.addEventListener('click', ()=>{
  if (!draggedSelections.length) return pushAiChat('bot', 'Drag runners first, then select H2H.');
  const input = $('aiChatInput');
  if (input) {
    const lines = draggedSelections.map(x => `- ${x.meeting} R${x.race} ${x.selection}`).join('\n');
    input.value = `Build a Head-to-Head (H2H) view from these runners only. Compare each matchup, win likelihood, and best H2H angle with risks.\n${lines}`;
    input.focus();
  }
});
$('aiChatInput')?.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') sendAiChat(); });
$('helpTopBtn')?.addEventListener('click', ()=>{
  setActivePage('help');
  const u = new URL(window.location.href);
  u.searchParams.set('page', 'help');
  history.replaceState(null, '', u.toString());
});
document.querySelectorAll('.admin-tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> setAdminTab(btn.dataset.adminTab || 'users'));
});
$('createUserPlanType')?.addEventListener('change', syncCreateUserPlanFields);
$('authManageToggle')?.addEventListener('click', openAuthModal);
const authPill = $('authUserPill');
authPill?.addEventListener('click', openAuthModal);
authPill?.addEventListener('keydown', (e)=>{
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openAuthModal();
  }
});
$('generateApiKeyBtn')?.addEventListener('click', generateApiKey);
$('apiKeyCopyBtn')?.addEventListener('click', copyApiKeyToClipboard);
$('authModalClose')?.addEventListener('click', ()=>toggleAuthModal(false));
$('authModalBackdrop')?.addEventListener('click', ()=>toggleAuthModal(false));
$('selfChangePasswordBtn')?.addEventListener('click', changeMyPassword);
$('authSaveBtn')?.addEventListener('click', saveAuthFromModal);
$('createUserBtn')?.addEventListener('click', createAuthUser);
$('changeUserPasswordBtn')?.addEventListener('click', changeAuthUserPassword);
$('deleteUserBtn')?.addEventListener('click', deleteAuthUser);
$('logoutBtn')?.addEventListener('click', async ()=>{
  try { await fetchLocal('./api/logout', { cache: 'no-store' }); } catch {}
  window.location.href = `/login?logout=1&ts=${Date.now()}`;
});
$('themeToggleBtn')?.addEventListener('click', ()=>{
  const current = document.body.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});
function openHelpDrawer(title, body){
  let drawer = $('mobileHelpDrawer');
  if (!drawer) {
    const wrap = document.createElement('div');
    wrap.id = 'mobileHelpDrawer';
    wrap.className = 'mobile-help-drawer hidden';
    wrap.innerHTML = `<div class='mobile-help-backdrop' data-help-close='1'></div><div class='mobile-help-sheet'><div class='mobile-help-head'><b id='mobileHelpTitle'>Help</b><button id='mobileHelpCloseBtn' class='btn btn-ghost compact-btn' type='button'>Close</button></div><div id='mobileHelpBody' class='mobile-help-body'></div></div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => {
      if (e.target?.getAttribute('data-help-close') === '1') wrap.classList.add('hidden');
    });
    wrap.querySelector('#mobileHelpCloseBtn')?.addEventListener('click', () => wrap.classList.add('hidden'));
    drawer = wrap;
  }
  const titleEl = $('mobileHelpTitle');
  const bodyEl = $('mobileHelpBody');
  if (titleEl) titleEl.textContent = title || 'Help';
  if (bodyEl) bodyEl.textContent = body || '';
  drawer.classList.remove('hidden');
}

function setupTouchHelpHints(){
  document.addEventListener('click', (event) => {
    const hint = event.target?.closest?.('.help-hint');
    if (!hint) return;
    const mobileLike = window.matchMedia('(max-width: 760px)').matches || ('ontouchstart' in window);
    if (!mobileLike) return;
    const label = hint.closest('.label')?.textContent?.replace('?', '').trim() || 'Help';
    const message = hint.getAttribute('title') || '';
    if (!message) return;
    event.preventDefault();
    openHelpDrawer(label, message);
  });
}

detectClientPlatform();
setupTouchHelpHints();
setupHelpHintTooltips();
setupAiChatDraggable();
setupAiChatDropzone();
refreshAiScenarioSelect();
initTheme();
loadConfidenceStakePrefs();
loadMeetingBiasPrefs();
loadAiUserNotes();
toggleAiChat(false);


loadStake().then(async ()=>{
  await loadStatus();
  await loadAuthenticatedUser();
  loadAiModels().catch(err => console.warn('ai_model_catalog_failed', err));
  const requestedPage = String(new URLSearchParams(window.location.search).get('page') || '').trim().toLowerCase();
  const knownPages = new Set(['workspace', 'plans', 'suggested', 'multis', 'movers', 'interesting', 'autobet', 'strategy', 'bakeoff', 'performance', 'tracked', 'heatmap', 'pulse', 'alerts', 'help']);
  if (knownPages.has(requestedPage)) {
    if (requestedPage === 'bakeoff' && isAdminUser) {
      setActivePage('bakeoff');
      loadBakeoffLeaderboard();
    } else {
      setActivePage(requestedPage);
    }
  }
}).catch(err => console.error('app_init_error', err));
loadRaces().then(()=>{
  renderRaces(racesCache);
  if (applyDerivedMovers()) {
    renderMarketMovers(latestMarketMovers);
  }
  restoreLastRaceSelection();
}).catch(err => console.error('app_races_init_error', err));
setInterval(async ()=>{
  try {
  if (document.hidden) return;
  await loadStake();
  await loadStatus();
  } catch (err) { console.error('status_poll_error', err); }
}, 60000);
setInterval(()=>{
  if (document.hidden) return;
  if (isAdminUser) {
    try { triggerPerformancePoll(false); loadPerformance(); } catch (err) { console.error('perf_poll_error', err); }
  }
}, 5 * 60 * 1000);
setInterval(()=>{
  if (document.hidden) return;
  tickQueuedCountdowns();
}, 1000);


function bindPollOddsButton(){
  const btn = $('pollOddsBtn');
  if (!btn) return;
  btn.onclick = async ()=>{
    if (btn.dataset.loading === '1') return;
    const originalText = btn.textContent || 'Poll Odds';
    btn.dataset.loading = '1';
    btn.disabled = true;
    btn.textContent = 'Polling…';
    const raceKey = selectedRace?.key;
    const fallbackMeeting = selectedRace?.meeting;
    const fallbackRace = selectedRace?.race_number;
    try {
      await triggerPoll();
      if (raceKey) {
        await selectRace(raceKey, fallbackMeeting, fallbackRace);
      }
    } catch (err) {
      console.error('poll_odds_failed', err);
    } finally {
      delete btn.dataset.loading;
      btn.disabled = false;
      btn.textContent = originalText;
    }
  };
}
