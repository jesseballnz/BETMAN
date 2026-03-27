#!/usr/bin/env node
const assert = require('assert');
const path = require('path');

const { scoreAnswer, isTrueFallback } = require(path.join(__dirname, '..', 'scripts', 'model_bakeoff.js'));

// --- scoreAnswer: basic keyword matching ---
{
  const prompt = { mustInclude: ['edge', 'bet', '%'] };
  const good = 'There is 12% edge here. Bet on Riding Together.';
  assert.strictEqual(scoreAnswer(good, prompt), 100, 'all keywords matched = 100');

  const partial = 'There is 12% edge here.';
  const partialScore = scoreAnswer(partial, prompt);
  assert.ok(partialScore > 0 && partialScore < 100, 'partial keywords = partial score');

  const none = 'No relevant content.';
  assert.strictEqual(scoreAnswer(none, prompt), 0, 'no keywords = 0');
}

// --- scoreAnswer: length penalty ---
{
  const prompt = { mustInclude: [], maxChars: 100 };
  const short = 'x'.repeat(100);
  const long = 'x'.repeat(300);
  assert.strictEqual(scoreAnswer(short, prompt), 100, 'at max chars = 100');
  const longScore = scoreAnswer(long, prompt);
  assert.ok(longScore < 100, 'over max chars incurs length penalty');
}

// --- scoreAnswer: requirePipeFormat gate ---
{
  const prompt = { mustInclude: ['Decision', 'Stake', 'Confidence', 'Invalidation'], requirePipeFormat: true };
  const good = 'Decision: Win | Stake: $10 | Confidence: 68% | Invalidation: if leader scratched';
  const goodScore = scoreAnswer(good, prompt);

  const bad = 'Decision: Win. Stake: $10. Confidence: 68%. Invalidation: if leader scratched.';
  const badScore = scoreAnswer(bad, prompt);

  assert.ok(goodScore > badScore, 'pipe-format answer scores higher than non-pipe answer');
  assert.ok(badScore <= goodScore - 25, 'pipe-format penalty is exactly 25 points');
}

// --- scoreAnswer: requireRunnerMentions gate ---
{
  const prompt = {
    mustInclude: ['%'],
    requireRunnerMentions: ['Riding Together', 'Fit For Beauty', 'Super Unicorn', 'Joltin']
  };
  const allMentioned = 'Riding Together 35%, Fit For Beauty 22%, Super Unicorn 15%, Joltin 8%';
  const noneMentioned = '35%, 22%, 15%, 8%';

  const allScore = scoreAnswer(allMentioned, prompt);
  const noneScore = scoreAnswer(noneMentioned, prompt);
  assert.ok(allScore > noneScore, 'mentioning runner names scores higher than not mentioning them');
}

// --- isTrueFallback ---
{
  const notFallback = {
    providerRequested: 'ollama', providerUsed: 'ollama',
    modelRequested: 'deepseek-r1:8b', modelUsed: 'deepseek-r1:8b',
    fallbackReason: ''
  };
  assert.strictEqual(isTrueFallback(notFallback), false, 'same provider/model = not fallback');

  const providerFallback = {
    providerRequested: 'ollama', providerUsed: 'openai',
    modelRequested: 'deepseek-r1:8b', modelUsed: 'gpt-4o-mini',
    fallbackReason: ''
  };
  assert.strictEqual(isTrueFallback(providerFallback), true, 'different provider = fallback');

  const reasonFallback = {
    providerRequested: 'ollama', providerUsed: 'ollama',
    modelRequested: 'deepseek-r1:8b', modelUsed: 'deepseek-r1:8b',
    fallbackReason: 'timeout'
  };
  assert.strictEqual(isTrueFallback(reasonFallback), true, 'fallbackReason set = fallback');
}

console.log('bakeoff_scoring tests passed');
