#!/usr/bin/env node
const assert = require('assert');
const http   = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { stripThinkingTags, isHallucinatedAnswer } = require(path.join(ROOT, 'scripts', 'frontend_server.js'));

// ═══════════════════════════════════════════════════════════════════════
// Unit tests: stripThinkingTags
// ═══════════════════════════════════════════════════════════════════════

// Basic: strips a single think block
assert.strictEqual(
  stripThinkingTags('<think>internal reasoning here</think>Actual answer about Te Rapa Race 5.'),
  'Actual answer about Te Rapa Race 5.',
  'should strip single think block and return real content'
);

// Multiline think block
assert.strictEqual(
  stripThinkingTags('<think>\nThe user is asking about a multi.\nLet me think about this.\n</think>\nHere is your 2-leg multi for Te Rapa.'),
  'Here is your 2-leg multi for Te Rapa.',
  'should strip multiline think block'
);

// Empty think block
assert.strictEqual(
  stripThinkingTags('<think></think>Race analysis follows.'),
  'Race analysis follows.',
  'should handle empty think tags'
);

// No think tags — passthrough
assert.strictEqual(
  stripThinkingTags('Normal answer about Wingatui R3.'),
  'Normal answer about Wingatui R3.',
  'should pass through answers without think tags unchanged'
);

// Content is ONLY think tags (deepseek-r1 empty-content scenario)
assert.strictEqual(
  stripThinkingTags('<think>All reasoning, no actual answer produced.</think>'),
  '',
  'should return empty string when content is only think tags'
);

// Null/undefined input
assert.strictEqual(stripThinkingTags(null), '', 'null input should return empty string');
assert.strictEqual(stripThinkingTags(undefined), '', 'undefined input should return empty string');
assert.strictEqual(stripThinkingTags(''), '', 'empty string should return empty string');

// Case insensitive
assert.strictEqual(
  stripThinkingTags('<THINK>Reasoning</THINK>Real answer.'),
  'Real answer.',
  'should handle uppercase THINK tags'
);

// Multiple think blocks
assert.strictEqual(
  stripThinkingTags('<think>first thought</think>Part one. <think>second thought</think>Part two.'),
  'Part one. Part two.',
  'should strip multiple think blocks'
);

console.log('✓ stripThinkingTags unit tests passed');

// ═══════════════════════════════════════════════════════════════════════
// Unit tests: isHallucinatedAnswer
// ═══════════════════════════════════════════════════════════════════════

// Real hallucination from the issue: ETF/stock trading response to a racing question
const etfHallucination = `Te Rapa Tomorrow is a New Zealand index ETF tracking the ASX Small Ord Min Cap index. 
The user might be an investor looking to dollar-cost average into NZSE-listed ETFs but wants to focus on 
smaller, undervalued companies. They might not want to pick individual stocks, hence using an ETF. 
A multi-legged order that allocates shares proportionally to their market value would be the best approach.
The portfolio allocation should consider the equity risk premium and asset class diversification.`;
assert.strictEqual(isHallucinatedAnswer(etfHallucination), true,
  'ETF/stock trading response should be detected as hallucination');

// Crypto hallucination
const cryptoHallucination = `For your multi-leg strategy, consider a portfolio of Bitcoin and Ethereum.
The cryptocurrency market shows strong momentum with blockchain adoption accelerating.
Dollar-cost averaging into these digital assets through a multi-leg entry would reduce risk.
The token sale market has been volatile but the underlying technology is sound.`;
assert.strictEqual(isHallucinatedAnswer(cryptoHallucination), true,
  'Cryptocurrency response should be detected as hallucination');

// Stock market hallucination
const stockHallucination = `Looking at the S&P 500 and NASDAQ indices, the market shows signs of recovery.
A 2-leg entry into equities through index funds would be prudent given current valuations.
The bond yield curve suggests a possible rate cut which would benefit stocks.
Consider spreading your portfolio allocation across multiple asset classes for diversification.`;
assert.strictEqual(isHallucinatedAnswer(stockHallucination), true,
  'Stock market response should be detected as hallucination');

// Cooking hallucination
const cookingHallucination = `For a delicious multi-layer cake, you'll need the following ingredients:
2 cups flour, 1 cup sugar, 3 eggs, and a tablespoon of vanilla extract.
Preheat your oven to 180°C. Mix the dry ingredients first, then add the wet.
Bake for 25-30 minutes until golden. The recipe serves 8 people.`;
assert.strictEqual(isHallucinatedAnswer(cookingHallucination), true,
  'Cooking recipe response should be detected as hallucination');

// Valid racing answer — multi bet
const validMulti = `Here's your 2-leg multi for Te Rapa tomorrow:

Leg 1: Te Rapa R5 — Not So Usual (Win) @ $3.40, ai win prob 29.4%
Leg 2: Te Rapa R7 — Poukawa (Win) @ $4.20, ai win prob 19.4%

Combined multi odds: $14.28
Joint likelihood: 5.7% (cross-race ≈ pA × pB / 100)

The barrier draw suits Not So Usual from gate 3 — should get a nice position on pace.
Poukawa is the value angle in the later race with strong form at the track and distance.
Pass if either runner drifts past $5.00 or the track deteriorates beyond a Slow 7.`;
assert.strictEqual(isHallucinatedAnswer(validMulti), false,
  'Valid racing multi answer should NOT be flagged as hallucination');

// Valid racing answer — race analysis
const validRaceAnalysis = `🏇 Te Rapa – Race 5: Waikato Cup

The field of 12 runners shapes up with a genuine tempo expected. Leaders Astarte and Flash Point 
will contest the front, with midfield runners likely to benefit from the strong pace. The jockey 
change to James McDonald on Poukawa is significant — his record at Te Rapa is 22% win rate.

The trainer Lisa Latta has 3 runners in this race, suggesting she's confident about the meeting.
Track condition is Good 3 with the rail out 4m, favouring on-pace runners from barriers 1-6.

Top pick: Not So Usual @ $3.40 (model 29.4%, implied 29.4%, edge +0.0pts)
Danger: Poukawa @ $4.20 (model 19.4%, implied 23.8%, edge -4.4pts)`;
assert.strictEqual(isHallucinatedAnswer(validRaceAnalysis), false,
  'Valid race analysis should NOT be flagged as hallucination');

// Valid short racing chat answer
const validShortChat = `Te Rapa R5 looks competitive. The speed map suggests a solid tempo with 
Astarte and Flash Point likely to lead. Back Not So Usual from barrier 3 at odds of $3.40.`;
assert.strictEqual(isHallucinatedAnswer(validShortChat), false,
  'Valid short racing chat should NOT be flagged as hallucination');

// Too short to judge — should not flag
assert.strictEqual(isHallucinatedAnswer('No data available.'), false,
  'Very short answers should not be flagged');
assert.strictEqual(isHallucinatedAnswer(''), false,
  'Empty string should not be flagged');

// Edge case: answer that mentions "stock" in racing context (e.g. "breeding stock")
const racingWithStockWord = `The breeding stock at Dobell Farm has produced several winners this season.
This horse's sire has excellent race form on wet tracks. The trainer has a strong record at this meeting
with 3 wins from 8 runners. The jockey is experienced and the barrier draw favours an on-pace run.`;
assert.strictEqual(isHallucinatedAnswer(racingWithStockWord), false,
  'Racing answer with incidental "stock" word should NOT be flagged');

// Generic off-topic but long answer with zero racing terms
const genericOfftopic = `The weather forecast for tomorrow shows partly cloudy skies with a high of 22 degrees.
There will be light winds from the northwest at around 15 km/h. The UV index will be moderate at 5.
Humidity levels will be around 65% throughout the day. No significant weather events are expected.
The extended forecast shows similar conditions continuing through the week with temperatures gradually
warming. Overnight lows will be around 12 degrees with clear skies expected after midnight.`;
assert.strictEqual(isHallucinatedAnswer(genericOfftopic), true,
  'Long off-topic answer with zero racing terms should be flagged');

console.log('✓ isHallucinatedAnswer unit tests passed');

// ═══════════════════════════════════════════════════════════════════════
// Integration test: mock Ollama server to test truncation & think-tag handling
// ═══════════════════════════════════════════════════════════════════════

const OLLAMA_PORT = 18091;
const BETMAN_PORT = 18092;

let requestCount = 0;
let lastOllamaRequest = null;

// Responses to cycle through for each test scenario
const MOCK_RESPONSES = [];

const mockOllama = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ models: [{ name: 'deepseek-r1:8b' }] }));
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try { lastOllamaRequest = { url: req.url, body: JSON.parse(body) }; } catch { lastOllamaRequest = { url: req.url, body: {} }; }

    const mockResponse = MOCK_RESPONSES.length > 0
      ? MOCK_RESPONSES.shift()
      : { message: { role: 'assistant', content: 'Te Rapa Race 5 looks good. Top pick: Horse A at odds of $3.40 with strong form.' }, done: true, done_reason: 'stop' };

    requestCount++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockResponse));
  });
});

let defaultAuth = 'betman:change-me-now';
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'betman-auth.json'), 'utf8'));
  if (cfg?.username && cfg?.password) defaultAuth = `${cfg.username}:${cfg.password}`;
} catch {}
const AUTH = Buffer.from(defaultAuth).toString('base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function askSelection(question, extra = {}) {
  const res = await fetch(`http://127.0.0.1:${BETMAN_PORT}/api/ask-selection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${AUTH}` },
    body: JSON.stringify({
      source: 'chat',
      question,
      provider: 'ollama',
      model: 'deepseek-r1:8b',
      selectionCount: 0,
      selections: [],
      uiContext: {},
      ...extra
    }),
    signal: AbortSignal.timeout(15000)
  });
  return res.json();
}

(async function integrationTests() {
  await new Promise(r => mockOllama.listen(OLLAMA_PORT, r));

  const env = {
    ...process.env,
    PORT: String(BETMAN_PORT),
    BETMAN_FAKE_AI: 'false',
    BETMAN_AI_CACHE_ENABLED: 'false',
    AI_CACHE_ENABLED: 'false',
    BETMAN_OLLAMA_BASE_URL: `http://127.0.0.1:${OLLAMA_PORT}`,
    BETMAN_WEB_SEARCH_TIMEOUT_MS: '200',
    BETMAN_WEB_PAGE_TIMEOUT_MS: '200',
    OPENAI_API_KEY: 'sk-test-fake'
  };

  const server = spawn('node', ['scripts/frontend_server.js'], { env, cwd: ROOT, stdio: 'ignore' });

  try {
    // Wait for the BETMAN frontend server to start accepting connections
    await sleep(2000);

    // ── Test 1: Truncated response (done_reason: "length") falls back ──
    MOCK_RESPONSES.push({
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'length'
    });
    const r1 = await askSelection('Give me a 2-leg value multi for Te Rapa Tomorrow');
    // With truncated response, should fall back (not crash)
    assert.ok(r1.ok !== undefined, 'truncated: response should have ok field');
    // The answer should either be a fallback or an error, not the truncated content
    if (r1.answer) {
      assert.ok(!r1.answer.includes('ETF'), 'truncated: answer should not contain hallucinated ETF content');
    }
    console.log('✓ Truncated response (done_reason=length) handled correctly');

    // ── Test 2: Response with <think> tags gets cleaned ──
    MOCK_RESPONSES.push({
      message: { role: 'assistant', content: '<think>Let me analyze the race card.</think>Te Rapa R5: Top pick is Not So Usual at odds $3.40. Strong form on the track, good barrier draw, and the jockey has a solid win rate at this meeting. Back to win.' },
      done: true,
      done_reason: 'stop'
    });
    const r2 = await askSelection('What is the top pick for Te Rapa R5?');
    assert.ok(r2.ok, 'think-tags: response should be ok');
    assert.ok(r2.answer, 'think-tags: should have answer');
    assert.ok(!r2.answer.includes('<think>'), 'think-tags: answer should NOT contain <think> tags');
    assert.ok(r2.answer.includes('Not So Usual'), 'think-tags: answer should contain the actual content');
    console.log('✓ Response with <think> tags properly stripped');

    // ── Test 3: Hallucinated answer triggers fallback ──
    MOCK_RESPONSES.push({
      message: { role: 'assistant', content: 'Te Rapa Tomorrow is a New Zealand index ETF tracking the ASX Small Ord Min Cap index. The user might be an investor looking to dollar-cost average into NZSE-listed ETFs but wants to focus on smaller, undervalued companies. They might not want to pick individual stocks, hence using an ETF. A multi-legged order that allocates shares proportionally to their market value would be the best approach with careful portfolio allocation across asset classes.' },
      done: true,
      done_reason: 'stop'
    });
    const r3 = await askSelection('Give me a 2-leg value multi for Te Rapa Tomorrow');
    // Hallucinated answer should be rejected
    if (r3.answer) {
      assert.ok(!r3.answer.includes('ETF'), 'hallucination: answer should not contain ETF nonsense');
      assert.ok(!r3.answer.includes('index fund'), 'hallucination: answer should not contain index fund reference');
    }
    console.log('✓ Hallucinated ETF answer correctly rejected');

    // ── Test 4: Valid racing answer passes through ──
    MOCK_RESPONSES.push({
      message: { role: 'assistant', content: 'Here is your 2-leg multi for Te Rapa:\n\nLeg 1: R5 Not So Usual @ $3.40 — ai win 29.4%\nLeg 2: R7 Poukawa @ $4.20 — ai win 19.4%\n\nCombined odds $14.28, joint likelihood 5.7%.\nGood value from the barrier draw and strong form at the track.' },
      done: true,
      done_reason: 'stop'
    });
    const r4 = await askSelection('Give me a 2-leg value multi for Te Rapa Tomorrow');
    assert.ok(r4.ok, 'valid-racing: response should be ok');
    assert.ok(r4.answer, 'valid-racing: should have answer');
    assert.ok(r4.answer.includes('Not So Usual') || r4.answer.includes('multi') || r4.answer.includes('Te Rapa'),
      'valid-racing: answer should contain racing content');
    console.log('✓ Valid racing answer passes through correctly');

    // ── Test 5: Empty content with done_reason "length" (exact issue scenario) ──
    MOCK_RESPONSES.push({
      message: { role: 'assistant', content: '', thinking: 'Okay, the user is asking for a 2-leg value multi for Te Rapa Tomorrow. Let me break this down. First, multi likely refers to a multi-legged order, common in trading...' },
      done: true,
      done_reason: 'length'
    });
    const r5 = await askSelection('Give me a 2-leg value multi for Te Rapa Tomorrow');
    assert.ok(r5.ok !== undefined, 'empty+truncated: response should have ok field');
    if (r5.answer) {
      assert.ok(!r5.answer.includes('trading'), 'empty+truncated: should not leak thinking content about trading');
    }
    console.log('✓ Empty content with done_reason=length (exact issue scenario) handled');

    console.log('ai_hallucination integration tests passed');
  } finally {
    server.kill('SIGTERM');
    mockOllama.close();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
