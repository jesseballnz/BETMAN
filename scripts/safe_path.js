'use strict';

const path = require('path');

function resolveSafePath(rootDir, requestedPath) {
  const normalizedRoot = path.resolve(String(rootDir || '.'));
  const targetPath = path.resolve(normalizedRoot, `.${String(requestedPath || '')}`);
  const relative = path.relative(normalizedRoot, targetPath);
  if (!relative || relative === '') return targetPath;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return targetPath;
}

module.exports = {
  resolveSafePath,
};
