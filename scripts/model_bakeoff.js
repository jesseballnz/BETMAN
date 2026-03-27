#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return dflt;
}

function inferProvider(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return '';
  if (m.includes('gpt-')) return 'openai';
  return 'ollama';
}

function scoreAnswer(answer, prompt) {
  const txt = String(answer || '');
  const lc = txt.toLowerCase();
  let hits = 0;
  const req = Array.isArray(prompt.mustInclude) ? prompt.mustInclude : [];
  for (const k of req) if (lc.includes(String(k).toLowerCase())) hits++;
  const keywordScore = req.length ? (hits / req.length) * 100 : 100;
  const lengthPenalty = prompt.maxChars && txt.length > prompt.maxChars ? Math.min(30, ((txt.length - prompt.maxChars) / prompt.maxChars) * 100) : 0;

  // Format-compliance gate: structured prompts that require pipe-delimited output
  let formatPenalty = 0;
  if (prompt.requirePipeFormat) {
    const pipePattern = /\w[^|]+\|[^|]+\|[^|]+\|[^|]+/;
    if (!pipePattern.test(txt)) formatPenalty = 25;
  }
  // Runner-profile gate: must mention individual runner names from context
  if (prompt.requireRunnerMentions && Array.isArray(prompt.requireRunnerMentions)) {
    const mentionedCount = prompt.requireRunnerMentions.filter(name =>
      lc.includes(String(name).toLowerCase())
    ).length;
    const mentionRate = prompt.requireRunnerMentions.length
      ? mentionedCount / prompt.requireRunnerMentions.length
      : 1;
    if (mentionRate < 0.5) formatPenalty = Math.max(formatPenalty, 20);
  }

  return Math.max(0, Math.round(keywordScore - lengthPenalty - formatPenalty));
}

function isTrueFallback(row) {
  const providerRequested = String(row?.providerRequested || '').trim().toLowerCase();
  const providerUsed = String(row?.providerUsed || '').trim().toLowerCase();
  const modelRequested = String(row?.modelRequested || '').trim().toLowerCase();
  const modelUsed = String(row?.modelUsed || '').trim().toLowerCase();
  const fallbackReason = String(row?.fallbackReason || '').trim();
  if (fallbackReason) return true;
  if (providerRequested && providerUsed && providerRequested !== providerUsed) return true;
  if (modelRequested && modelUsed && modelRequested !== modelUsed) return true;
  return false;
}

async function run() {
  const baseUrl = arg('url', process.env.BAKEOFF_URL || 'http://127.0.0.1:8080');
  let user = arg('user', process.env.BAKEOFF_USER || process.env.BETMAN_USERNAME || process.env.BETMAN_USER || '');
  let pass = arg('pass', process.env.BAKEOFF_PASS || process.env.BETMAN_PASSWORD || process.env.BETMAN_PASS || '');
  if (!user || !pass) {
    try {
      const authState = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'memory', 'betman-auth.json'), 'utf8'));
      if (!user && authState?.username) user = authState.username;
      if (!pass && authState?.password) pass = authState.password;
    } catch {}
  }
  const mode = arg('mode', process.env.BAKEOFF_MODE || 'full');
  const quickPromptDefaults = ['race-win-core', 'risk-controls', 'decision-format', 'fast-brief'];
  const runsArgRaw = arg('runs', null);
  const runsEnvRaw = process.env.BAKEOFF_RUNS || null;
  let runs = Number(runsArgRaw ?? runsEnvRaw ?? 2);
  if (!Number.isFinite(runs) || runs <= 0) runs = 1;
  if (mode === 'quick' && runsArgRaw == null && runsEnvRaw == null) runs = 1;
  const timeoutMs = Number(arg('timeoutMs', process.env.BAKEOFF_TIMEOUT_MS || 120000));
  const promptsPath = arg('prompts', path.join(process.cwd(), 'bakeoff', 'prompts.json'));
  const outDir = arg('out', path.join(process.cwd(), 'bakeoff', 'results'));
  const modelsRaw = arg('models', process.env.BAKEOFF_MODELS || 'deepseek-r1:8b,llama3.1:8b,gpt-4o-mini,gpt-5.2');
  const models = modelsRaw.split(',').map(s => s.trim()).filter(Boolean);
  const promptIdsRaw = arg('promptIds', process.env.BAKEOFF_PROMPTS || '');
  let promptFilter = promptIdsRaw
    ? promptIdsRaw.split(',').map(s => s.trim()).filter(Boolean)
    : null;
  if (mode === 'quick' && (!promptFilter || !promptFilter.length)) promptFilter = quickPromptDefaults.slice();

  if (!models.length) throw new Error('No models provided');
  const promptDir = path.dirname(promptsPath);
  const promptsRaw = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
  const prompts = promptsRaw
    .filter((p) => {
      if (!promptFilter || !promptFilter.length) return true;
      return promptFilter.includes(String(p.id || '').trim());
    })
    .map((p) => {
      const contextPath = p.contextFile ? path.join(promptDir, p.contextFile) : null;
      let context = '';
      if (contextPath) {
        try {
          context = fs.readFileSync(contextPath, 'utf8').trim();
        } catch (e) {
          console.error('context_read_failed', contextPath, e?.message || e);
        }
      }
      return { ...p, context } ;
    });
  if (!prompts.length) throw new Error('No prompts available after filtering');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Bakeoff mode=${mode} · runs=${runs} · prompts=${prompts.map(p => p.id).join(',')}`);

  const headers = { 'Content-Type': 'application/json' };
  if (user && pass) headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  const rawRows = [];
  for (const model of models) {
    for (const p of prompts) {
      for (let i = 0; i < runs; i++) {
        const started = Date.now();
        let ok = false, status = 0, body = null, err = null, jsonParseError = false;
        try {
          const questionParts = [p.context?.trim(), p.question].filter(Boolean);
          const fullQuestion = questionParts.join('\n\n');
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), timeoutMs);
          const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ask-selection`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              question: fullQuestion || p.question,
              model,
              provider: inferProvider(model)
            }),
            signal: ctrl.signal
          });
          clearTimeout(t);
          status = res.status;
          let jsonParseErr = false;
          body = await res.json().catch((e) => {
            jsonParseErr = true;
            process.stderr.write(`json_parse_error model=${model} prompt=${p.id} status=${res.status} :: ${e?.message || e}\n`);
            return {};
          });
          if (jsonParseErr) err = `json_parse_error_status_${res.status}`;
          ok = !!(res.ok && body && body.ok);
          if (!ok && !jsonParseErr && res.ok && body && !body.ok) {
            // HTTP 200 but API returned ok:false — capture the API-level error
            const apiErr = body?.error || body?.fallbackReason || 'api_ok_false';
            process.stderr.write(`api_ok_false model=${model} prompt=${p.id} :: ${apiErr}\n`);
          }
          jsonParseError = jsonParseErr;
        } catch (e) {
          err = String(e && e.message || e);
        }
        const latencyMs = Date.now() - started;
        const answer = body?.answer || '';
        rawRows.push({
          ts: new Date().toISOString(),
          model,
          providerRequested: inferProvider(model),
          promptId: p.id,
          run: i + 1,
          ok,
          httpStatus: status,
          latencyMs,
          mode: body?.mode || null,
          providerUsed: body?.provider || null,
          modelRequested: body?.modelRequested || model,
          modelUsed: body?.modelUsed || null,
          fallbackReason: body?.fallbackReason || null,
          scoreQuality: ok ? scoreAnswer(answer, p) : 0,
          answerChars: String(answer).length,
          answer: answer ? String(answer).slice(0, 4000) : '',
          jsonParseError,
          error: err
        });
        process.stdout.write(`run model=${model} prompt=${p.id} #${i + 1} ok=${ok} jsonParseError=${jsonParseError} latency=${latencyMs}ms\n`);
      }
    }
  }

  const byModel = new Map();
  for (const r of rawRows) {
    const a = byModel.get(r.model) || { n: 0, ok: 0, q: 0, lat: [], fallback: 0, parseErrors: 0 };
    a.n++;
    if (r.ok) a.ok++;
    a.q += Number(r.scoreQuality || 0);
    a.lat.push(Number(r.latencyMs || 0));
    if (isTrueFallback(r)) a.fallback++;
    if (r.jsonParseError) a.parseErrors++;
    byModel.set(r.model, a);
  }

  const leaderboard = [...byModel.entries()].map(([model, a]) => {
    const successRate = a.n ? (a.ok / a.n) : 0;
    const qualityAvg = a.n ? (a.q / a.n) : 0;
    const latSorted = a.lat.slice().sort((x, y) => x - y);
    const p50 = latSorted[Math.floor((latSorted.length - 1) * 0.5)] || 0;
    const p95 = latSorted[Math.floor((latSorted.length - 1) * 0.95)] || 0;
    const fallbackRate = a.n ? (a.fallback / a.n) : 0;
    const parseErrorRate = a.n ? (a.parseErrors / a.n) : 0;

    const score = (
      qualityAvg * 0.4 +
      successRate * 100 * 0.25 +
      Math.max(0, 100 - Math.min(100, p50 / 80)) * 0.2 +
      (100 - fallbackRate * 100) * 0.15
    );

    return {
      model,
      runs: a.n,
      successRate: Number((successRate * 100).toFixed(1)),
      qualityAvg: Number(qualityAvg.toFixed(1)),
      latencyP50Ms: p50,
      latencyP95Ms: p95,
      fallbackRate: Number((fallbackRate * 100).toFixed(1)),
      parseErrorRate: Number((parseErrorRate * 100).toFixed(1)),
      composite: Number(score.toFixed(1)),
      aiScore: Number(qualityAvg.toFixed(1))
    };
  }).sort((x, y) => y.composite - x.composite);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawPath = path.join(outDir, `bakeoff-${stamp}.jsonl`);
  const sumPath = path.join(outDir, `leaderboard-${stamp}.json`);
  const mdPath = path.join(outDir, `leaderboard-${stamp}.md`);

  fs.writeFileSync(rawPath, rawRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(sumPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseUrl,
    models,
    runs,
    prompts: prompts.map(p => p.id),
    leaderboard
  }, null, 2));

  const md = [
    `# Model Bake-off`,
    ``,
    `- Generated: ${new Date().toISOString()}`,
    `- URL: ${baseUrl}`,
    `- Runs per prompt: ${runs}`,
    ``,
    `| Rank | Model | Composite | Success % | Quality | P50 ms | AI Score | P95 ms | Fallback % | Parse Err % |`,
    `|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|`,
    ...leaderboard.map((r, i) => `| ${i + 1} | ${r.model} | ${r.composite} | ${r.successRate} | ${r.qualityAvg} | ${r.latencyP50Ms} | ${r.aiScore} | ${r.latencyP95Ms} | ${r.fallbackRate} | ${r.parseErrorRate} |`),
    ``,
    `Raw: ${path.basename(rawPath)}`,
    `JSON: ${path.basename(sumPath)}`
  ].join('\n');
  fs.writeFileSync(mdPath, md + '\n');

  console.log(`\nWrote:\n- ${rawPath}\n- ${sumPath}\n- ${mdPath}`);
  if (leaderboard[0]) console.log(`Winner: ${leaderboard[0].model} (score ${leaderboard[0].composite})`);
}

if (require.main === module) {
  run().catch((e) => {
    console.error('bakeoff_failed', e);
    process.exit(1);
  });
}

module.exports = { scoreAnswer, isTrueFallback };
