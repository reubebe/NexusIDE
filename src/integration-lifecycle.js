import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { runProcess } from './process.js';
import { runGit } from './git.js';
import { boundedRead } from './bounded-read.js';
import { processIsAlive } from './locks.js';

const identifier = value => value === 'legacy' || (typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
// A replacement ref can substitute a different tree while rev-parse still
// returns the pinned object ID. Source attestation must inspect real objects.
const sourceGit = (root, args, options) => runGit(root, ['--no-replace-objects', ...args], options);
const present = async (file, mode = constants.F_OK) => { try { await access(file, mode); return true; } catch { return false; } };
async function directory(file, optional = true) {
  try { const stat = await lstat(file); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Managed runtime directory is not a real directory: ${file}`); }
  catch (error) { if (!optional || error.code !== 'ENOENT') throw error; }
}
async function readJson(file, fallback) {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { return JSON.parse((await boundedRead(handle, 1_000_000)).toString('utf8')); } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function writeJson(file, value, exclusive = false) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 1_000_000) throw new Error('Lifecycle metadata exceeds its storage limit; existing state was preserved.');
  // Never follow a replaced manifest or lock, even though rename would be safe.
  try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Lifecycle state must be a regular file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    if (!exclusive) await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
function validateManifest(manifest, name) {
  if (!manifest || manifest.version !== 1 || manifest.name !== name || !(manifest.active === null || identifier(manifest.active)) ||
      !Array.isArray(manifest.history) || manifest.history.some(id => !identifier(id)) ||
      !manifest.versions || Array.isArray(manifest.versions) || typeof manifest.versions !== 'object' ||
      Object.entries(manifest.versions).some(([id, value]) => !identifier(id) || !value || !['ready', 'staging', 'failed'].includes(value.state) || !/^[a-f0-9]{40,64}$/.test(value.revision) || typeof value.source !== 'string') ||
      manifest.history.some(id => !Object.hasOwn(manifest.versions, id)) ||
      (manifest.active !== null && manifest.versions[manifest.active]?.state !== 'ready')) throw new Error('Invalid integration lifecycle manifest; no runtime was selected.');
  return manifest;
}
async function trackedSource(root) {
  const tree = await sourceGit(root, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], { timeoutMs: 30_000, maxBytes: 4_000_000 });
  if (tree.code !== 0 || tree.stopped) return { clean: false, reason: 'Could not enumerate pinned source files.' };
  const entries = tree.output.split('\0').filter(Boolean);
  if (!entries.length || entries.length > 25_000) return { clean: false, reason: 'Source file count is outside verification limits.' };
  const checkedDirectories = new Set([root]);
  for (const entry of entries) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40,64})\t(.+)$/.exec(entry);
    if (!match) return { clean: false, reason: 'Unsupported source entry (including submodules).' };
    const [, mode, object, relative] = match;
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '..' || part === '.') || path.isAbsolute(relative)) return { clean: false, reason: 'Unsafe source path.' };
    let parent = root;
    for (const part of parts.slice(0, -1)) { parent = path.join(parent, part); if (!checkedDirectories.has(parent)) { await directory(parent, false); checkedDirectories.add(parent); } }
    const filename = path.join(root, ...parts);
    try {
      const stat = await lstat(filename);
      let digest;
      if (mode === '120000') {
        if (!stat.isSymbolicLink()) return { clean: false, reason: `Changed source type: ${relative}` };
        const link = Buffer.from(await readlink(filename));
        digest = createHash(object.length === 64 ? 'sha256' : 'sha1').update(`blob ${link.length}\0`).update(link).digest('hex');
      } else {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000_000 || Boolean(stat.mode & 0o111) !== (mode === '100755')) return { clean: false, reason: `Changed source type/mode or oversized file: ${relative}` };
        const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const bytes = await boundedRead(handle, 64_000_000);
          digest = createHash(object.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        } finally { await handle.close(); }
      }
      if (digest !== object) return { clean: false, reason: `Modified tracked source: ${relative}` };
    } catch (error) { if (error.code === 'ENOENT') return { clean: false, reason: `Missing tracked source: ${relative}` }; throw error; }
  }
  return { clean: true, reason: null, files: entries.length };
}

/** Internal factory for isolated lifecycle tests. Public entry points use only the reviewed catalog. */
export function createIntegrationLifecycle({ definitions, rootFor, execute = runProcess, platform = process.platform }) {
  function definition(name) { if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown integration: ${name}`); return definitions[name]; }
  async function paths(name, { runtimeRoot } = {}, create = false) {
    definition(name);
    const raw = runtimeRoot ?? rootFor(name);
    if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.includes('\0') || path.resolve(raw) === path.parse(raw).root || path.resolve(raw) === os.homedir()) throw new Error('Invalid managed runtime root.');
    const base = path.resolve(raw);
    // Canonicalize existing ancestors (macOS /tmp is a system symlink), then refuse
    // symlinks at every managed boundary below that parent.
    if (create) await mkdir(path.dirname(base), { recursive: true, mode: 0o700 });
    let parent;
    try { parent = await realpath(path.dirname(base)); } catch (error) { if (error.code !== 'ENOENT') throw error; parent = path.dirname(base); }
    const root = path.join(parent, path.basename(base));
    const state = `${root}.nexus-lifecycle`;
    await directory(root); await directory(state); await directory(path.join(state, 'versions'));
    if (create) await mkdir(path.join(state, 'versions'), { recursive: true, mode: 0o700 });
    return { root, state, manifest: path.join(state, 'manifest.json'), lock: path.join(state, 'lock.json'), versions: path.join(state, 'versions') };
  }
  const versionRoot = (p, id) => { if (!identifier(id)) throw new Error('Invalid integration version.'); return id === 'legacy' ? p.root : path.join(p.versions, id); };
  async function manifest(p, name) { const value = await readJson(p.manifest, null); return value === null ? null : validateManifest(value, name); }
  async function source(name, root) {
    const d = definition(name);
    await directory(root); await directory(path.join(root, '.git')); await directory(path.join(root, '.venv'));
    let revision = null, origin = null, sourceClean = false, sourceReason = 'Runtime has not been cloned.';
    if (await present(path.join(root, '.git'))) {
      const command = args => sourceGit(root, args, { timeoutMs: 10_000, maxBytes: 20_000 });
      const head = await command(['rev-parse', '--verify', 'HEAD']);
      const remote = await command(['remote', 'get-url', 'origin']);
      const location = await command(['rev-parse', '--show-toplevel']);
      if (!head.stopped && head.code === 0) revision = head.output.trim();
      if (!remote.stopped && remote.code === 0) origin = remote.output.trim();
      const allowed = [d.revision, ...(d.previousRevisions || [])];
      if (location.code !== 0 || location.stopped || path.resolve(location.output.trim()) !== await realpath(root)) sourceReason = 'Git worktree location does not match the managed runtime.';
      else if (origin !== d.source || !allowed.includes(revision)) sourceReason = 'Source origin/revision differs from the reviewed catalog.';
      else { const checked = await trackedSource(root); sourceClean = checked.clean; sourceReason = checked.reason; }
    }
    const sourceVerified = sourceClean && origin === d.source && [d.revision, ...(d.previousRevisions || [])].includes(revision);
    const executableAvailable = await present(d.executable(root), constants.X_OK);
    return { name, root, source: d.source, cloned: Boolean(revision), revision, expectedRevision: d.revision, origin, sourceClean, sourceReason, sourceVerified, executableAvailable, ready: platform !== 'win32' && sourceVerified && executableAvailable, executable: d.executable(root), liveVerified: false };
  }
  async function status(name, options = {}) {
    const p = await paths(name, options), m = await manifest(p, name);
    const selected = m ? m.active : 'legacy';
    const result = await source(name, selected ? versionRoot(p, selected) : p.root);
    const lock = await readJson(p.lock, null);
    const locked = lock && !(options.ignoreOwnLock && lock.pid === process.pid) ? { operation: lock.operation, pid: lock.pid, childPid: lock.childPid ?? null, started: lock.started, state: await processIsAlive(lock.pid) === false && (!lock.childPid || await processIsAlive(lock.childPid) === false) ? 'stale' : 'active-or-unknown' } : null;
    const disabled = m?.active === null;
    const ready = result.ready && !disabled;
    return { ...result, ready, managedRoot: p.root, lifecycleRoot: p.state, activeVersion: selected, disabled, lock: locked,
      versions: Object.entries(m?.versions || {}).map(([id, value]) => ({ id, ...value, root: versionRoot(p, id) })),
      diagnostic: locked ? `Integration is locked (${locked.state}); wait for its owner or use nexus integration recover ${name} after a crash.` : disabled ? `Integration is disabled. Retained versions can be restored with nexus integration rollback ${name}.` : ready ? result.revision === result.expectedRevision ? 'Ready; reviewed tracked source verified.' : `A retained reviewed revision is active. Run nexus integration upgrade ${name} for the current pin.` : result.sourceReason || `Environment is incomplete. Run nexus integration install ${name} to stage a fresh version.` };
  }
  async function locked(name, options, operation, callback) {
    const p = await paths(name, options, true), id = randomUUID();
    const lock = { version: 1, id, name, pid: process.pid, operation, started: new Date().toISOString() };
    try { await writeJson(p.lock, lock, true); }
    catch (error) { if (error.code === 'EEXIST') throw new Error(`Integration is locked; wait, or inspect nexus integration status ${name} and recover a stale lock.`); throw error; }
    try { return await callback(p, async childPid => { if (!Number.isSafeInteger(childPid) || childPid < 1) throw new Error('Invalid runtime child process.'); lock.childPid = childPid; await writeJson(p.lock, lock); }); }
    finally { if ((await readJson(p.lock, null))?.id === id) await unlink(p.lock); }
  }
  async function initialManifest(name, p) {
    const m = await manifest(p, name);
    if (m) return m;
    const existing = await source(name, p.root);
    return { version: 1, name, active: existing.ready ? 'legacy' : null, history: [], versions: existing.ready ? { legacy: { state: 'ready', source: existing.origin, revision: existing.revision, created: new Date().toISOString() } } : {} };
  }
  async function install(name, options = {}, upgrade = false) {
    if (platform === 'win32') throw new Error('Managed runtime installation currently supports macOS/Linux only.');
    if (upgrade && options.confirm !== true) throw new Error('Upgrade requires explicit confirmation of third-party installer execution.');
    return locked(name, options, upgrade ? 'upgrade' : 'install', async (p, trackChild) => {
      const d = definition(name), m = await initialManifest(name, p);
      if (!upgrade && m.active) { const current = await source(name, versionRoot(p, m.active)); if (current.ready && current.revision === d.revision) return status(name, { ...options, ignoreOwnLock: true }); }
      const id = randomUUID(), root = versionRoot(p, id);
      m.versions[id] = { state: 'staging', source: d.source, revision: d.revision, created: new Date().toISOString() };
      await writeJson(p.manifest, m);
      try {
        const step = async (command, args, cwd, timeoutMs) => {
          const result = await execute(command, args, { cwd, timeoutMs, maxBytes: 2_000_000, signal: options.signal, onSpawn: trackChild });
          // Installer output may contain credentials or terminal escape sequences.
          // Keep lifecycle diagnostics bounded and never persist raw output.
          if (result.code !== 0 || result.stopped) throw new Error(`${command} failed (${result.stopped || `exit ${result.code}`}). Staged files were retained for inspection.`);
        };
        await step('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'clone', '--no-checkout', '--filter=blob:none', '--', d.source, root], p.versions, 300_000);
        const checkout = await sourceGit(root, ['checkout', '--detach', d.revision], { timeoutMs: 300_000, maxBytes: 1_000_000, signal: options.signal, onSpawn: trackChild });
        if (checkout.code !== 0 || checkout.stopped) throw new Error('Could not check out the reviewed runtime revision. No installer was run.');
        if (!(await source(name, root)).sourceVerified) throw new Error('Runtime source verification failed. No installer was run.');
        for (const [command, args] of d.steps) await step(command, args, root, 3_600_000);
        const verified = await source(name, root);
        if (!verified.ready) throw new Error(`Staged runtime failed verification: ${verified.sourceReason || 'executable unavailable'}`);
        m.versions[id].state = 'ready';
        if (m.active) m.history = [m.active, ...m.history.filter(value => value !== m.active)];
        m.active = id;
        await writeJson(p.manifest, m);
      } catch (error) {
        m.versions[id].state = 'failed';
        // The prior active pointer was never changed during setup.
        if (m.active === id) m.active = m.history.shift() ?? null;
        m.versions[id].failure = error.name === 'AbortError' ? 'Installation cancelled.' : 'Installation or source verification failed; prior active version preserved.';
        await writeJson(p.manifest, m);
        throw error;
      }
      return status(name, { ...options, ignoreOwnLock: true });
    });
  }
  async function rollback(name, options = {}) {
    if (options.confirm !== true) throw new Error('Rollback requires explicit confirmation.');
    return locked(name, options, 'rollback', async p => {
      const m = await manifest(p, name);
      const target = options.version ?? m?.history.find(id => id !== m.active && m.versions[id]?.state === 'ready');
      if (!m || !identifier(target) || target === m.active || !Object.hasOwn(m.versions, target) || m.versions[target].state !== 'ready') throw new Error('No retained ready version matches. Inspect integration status and select a version ID.');
      if (!(await source(name, versionRoot(p, target))).ready) throw new Error('Rollback target failed current catalog/source verification; active version unchanged.');
      m.history = [...(m.active ? [m.active] : []), ...m.history.filter(id => id !== target && id !== m.active)];
      m.active = target;
      await writeJson(p.manifest, m);
      return status(name, { ...options, ignoreOwnLock: true });
    });
  }
  async function uninstall(name, options = {}) {
    if (options.confirm !== true) throw new Error('Uninstall requires explicit confirmation.');
    return locked(name, options, 'uninstall', async p => {
      const m = await initialManifest(name, p);
      if (m.active) m.history = [m.active, ...m.history.filter(id => id !== m.active)];
      m.active = null;
      await writeJson(p.manifest, m);
      return { ...await status(name, { ...options, ignoreOwnLock: true }), retained: true, note: 'Runtime disabled; source, environments and outputs retained. Project grants remain inert until rollback; use unconfigure to revoke them.' };
    });
  }
  async function recover(name, options = {}) {
    if (options.confirm !== true) throw new Error('Recovery requires explicit confirmation.');
    const p = await paths(name, options, true), lock = await readJson(p.lock, null);
    if (lock) {
      if (await processIsAlive(lock.pid) !== false || (lock.childPid && await processIsAlive(lock.childPid) !== false)) throw new Error('Cannot recover an active or unknown integration lock.');
      const current = await readJson(p.lock, null);
      if (!lock.id || current?.id !== lock.id || current.pid !== lock.pid || current.childPid !== lock.childPid) throw new Error('Integration lock changed; inspect it again.');
      await unlink(p.lock);
    }
    return locked(name, options, 'recover', async current => {
      const m = await manifest(current, name);
      if (m) {
        for (const value of Object.values(m.versions)) if (value.state === 'staging') { value.state = 'failed'; value.failure = 'Interrupted setup recovered; staged files retained.'; }
        await writeJson(current.manifest, m);
      }
      return status(name, { ...options, ignoreOwnLock: true });
    });
  }
  async function run(name, options, callback) {
    return locked(name, options, 'run', async (_p, trackChild) => {
      const current = await status(name, options);
      if (!current.ready) throw new Error(`Integration is not ready: ${current.diagnostic}`);
      return callback(current, trackChild);
    });
  }
  return { status, install: (name, options) => install(name, options), upgrade: (name, options) => install(name, options, true), rollback, uninstall, recover, run };
}
