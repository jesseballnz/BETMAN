#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'scripts', 'frontend_server.js');
const source = fs.readFileSync(serverPath, 'utf8');

function mustInclude(snippet, label) {
  assert(source.includes(snippet), `${label} missing`);
}

function mustNotInclude(snippet, label) {
  assert(!source.includes(snippet), `${label} should not exist`);
}

mustInclude("if (req.method === 'GET' && url.pathname === '/api/v1/settled-bets')", 'settled-bets GET route');
mustInclude("if (url.pathname === '/api/ask-selection' || url.pathname === '/api/ask-betman')", 'ask-selection / ask-betman route');

mustInclude("function wrongApiSurface(res, req, pathName, expected)", 'wrong-surface diagnostic helper');
mustInclude("if (url.pathname === '/api/chat')", 'wrong-surface /api/chat diagnostic route');
mustInclude("if (url.pathname === '/api/show' || url.pathname === '/api/delete')", 'wrong-surface Ollama diagnostic route');

console.log('route_contracts tests passed');
