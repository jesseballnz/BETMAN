#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '..', 'scripts', 'frontend_server.js');
const source = fs.readFileSync(serverPath, 'utf8');

assert(source.includes("const BAKEOFF_AUTOTUNE_STATE_FILE = 'bakeoff_autotune_state.json';"), 'autotune state file constant missing');
assert(source.includes("normalizedTenantId === 'default'"), 'default tenant handling missing');
assert(source.includes("path.join(process.cwd(), 'frontend', 'data', BAKEOFF_AUTOTUNE_STATE_FILE)"), 'default tenant should use frontend/data path');
assert(source.includes("tenantDataPath(normalizedTenantId, BAKEOFF_AUTOTUNE_STATE_FILE)"), 'tenant path usage missing for non-default tenants');

console.log('bakeoff_autotune_persistence tests passed');
