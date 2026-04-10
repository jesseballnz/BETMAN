#!/usr/bin/env node
const assert = require('assert');
const path = require('path');

const { resolveSafePath } = require('../scripts/safe_path');
const { safePath } = require('../scripts/frontend_server');

const root = path.resolve('/tmp/betman/frontend');

assert.strictEqual(
  resolveSafePath(root, '/assets/logo.png'),
  path.join(root, 'assets', 'logo.png'),
  'should resolve normal in-root asset paths'
);

assert.strictEqual(
  resolveSafePath(root, '/../frontend-evil/secrets.txt'),
  null,
  'should block sibling-prefix traversal that previously bypassed startsWith(root)'
);

assert.strictEqual(
  resolveSafePath(root, '/../../etc/passwd'),
  null,
  'should block parent directory traversal'
);

assert.strictEqual(
  safePath('/assets/logo.png'),
  path.join(process.cwd(), 'frontend', 'assets', 'logo.png'),
  'frontend_server safePath should delegate to safe resolver'
);

console.log('safe_path tests passed');
