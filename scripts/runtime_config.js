const REQUIRED_ENV_KEYS = ['BETMAN_PASSWORD'];

function validateRuntimeConfig(env = process.env) {
  const errors = [];

  for (const key of REQUIRED_ENV_KEYS) {
    if (!String(env[key] || '').trim()) {
      errors.push(`${key} is required`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function assertRuntimeConfig(env = process.env) {
  const result = validateRuntimeConfig(env);
  if (!result.ok) {
    throw new Error(result.errors.join('; '));
  }
  return result;
}

module.exports = {
  REQUIRED_ENV_KEYS,
  validateRuntimeConfig,
  assertRuntimeConfig,
};
