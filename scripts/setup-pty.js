import { chmod, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
if (process.platform !== 'win32') {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const dir of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release']) {
    const helper = path.join(root, dir, 'spawn-helper');
    try { await access(helper); await chmod(helper, 0o755); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
