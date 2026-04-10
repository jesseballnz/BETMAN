const { execFileSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');
const tests = [
  'tests/pulse_targeting_semantics.test.js',
  'tests/pulse_jump_pulse_without_mover.test.js',
  'tests/pulse_live_expiry_after_jump.test.js',
  'tests/ai_chat_scenarios.test.js',
  'tests/ai_analyse.test.js',
  'tests/betman_api.test.js',
];
for (const rel of tests) {
  console.log(`RUN ${rel}`);
  execFileSync('node', [path.join(root, rel)], { cwd: root, stdio: 'inherit' });
}
console.log('targeted runner: ok');
