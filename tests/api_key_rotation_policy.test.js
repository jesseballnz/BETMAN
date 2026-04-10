#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const apiPath = path.join(__dirname, '..', 'scripts', 'betman_api.js');
const serverPath = path.join(__dirname, '..', 'scripts', 'frontend_server.js');
const apiSource = fs.readFileSync(apiPath, 'utf8');
const serverSource = fs.readFileSync(serverPath, 'utf8');

assert(apiSource.includes("key.active !== false ? { ...key, active: false, revokedAt: key.revokedAt || revokedAt } : key"), 'betman_api.js should revoke prior active keys on issue');
assert(serverSource.includes("key?.active !== false ? { ...key, active: false, revokedAt: key.revokedAt || nowIso } : key"), 'frontend_server.js should revoke prior active admin/user keys on issue');
assert(serverSource.includes("key?.active !== false ? { ...key, active: false, revokedAt: key.revokedAt || createdAtIso } : key"), 'frontend_server.js session key issuance should revoke prior active keys');

console.log('api_key_rotation_policy tests passed');
