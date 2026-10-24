import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PACKAGE_DIRECTORIES = ['src', 'ui', 'integrations', 'scripts', 'docs', 'examples', 'extensions/vscode'];
export const PACKAGE_FILES = ['package.json', 'package-lock.json', 'README.md', 'SECURITY.md'];
export const MINIMUM_MACOS = '13.0';

export function assertRuntimeMetadata(metadata, arch) {
  const version = /^v(\d+)\.(\d+)\.(\d+)$/.exec(metadata.version || '');
  if (!version || Number(version[1]) !== 22 || Number(version[2]) < 18) throw new Error('Packaging requires the tested Node 22 line, version 22.18.0 or newer.');
  if (metadata.platform !== 'darwin' || metadata.arch !== arch || !['arm64', 'x64'].includes(arch)) throw new Error('Node runtime must match the macOS build architecture.');
}

export function assertSystemLibraries(output) {
  const dependencies = output.split('\n').filter(line => /^\s+\S/.test(line)).map(line => line.trim().split(' (compatibility version')[0]);
  if (!dependencies.length) throw new Error('Could not inspect Mach-O runtime dependencies.');
  const external = dependencies.filter(name => !name.startsWith('/usr/lib/') && !name.startsWith('/System/Library/'));
  if (external.length) throw new Error(`Non-system dynamic dependencies cannot be bundled implicitly: ${external.join(', ')}`);
  return [...new Set(dependencies)];
}

export function assertDeploymentTarget(output) {
  const commands = [...output.matchAll(/cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\b[\s\S]*?(?=\nLoad command|\n[^\n]*\(architecture|$)/g)].map(match => match[0]);
  const versions = commands.flatMap(command => {
    const field = command.startsWith('cmd LC_BUILD_VERSION') ? /^\s*minos\s+(\d+)\.(\d+)(?:\.\d+)?/gm : /^\s*version\s+(\d+)\.(\d+)(?:\.\d+)?/gm;
    return [...command.matchAll(field)].map(match => [Number(match[1]), Number(match[2])]);
  });
  if (!versions.length || versions.some(([major, minor]) => major > 13 || (major === 13 && minor > 0))) throw new Error('A bundled binary requires a newer macOS version than the declared minimum 13.0.');
}

export function safeVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version || '')) throw new Error('Invalid package version.');
  return version;
}

export async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }

// A positive source allowlist avoids workspace state, credentials, Git and arbitrary downloads.
export async function copyPayload(source, destination, { directories = PACKAGE_DIRECTORIES, files = PACKAGE_FILES } = {}) {
  async function copyEntry(relative) {
    const name = path.basename(relative);
    if (name === '__pycache__' || name.endsWith('.pyc') || name === '.DS_Store') return;
    if (['.nexus', '.git', 'node_modules'].includes(name) || (/^\.env(?:\.|$)/.test(name) && name !== '.env.example') || /\.(?:pem|p12|pfx|key)$/i.test(name)) throw new Error(`Private or generated file is not allowed in the source payload: ${relative}`);
    const from = path.join(source, relative), to = path.join(destination, relative);
    const stat = await lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`Source payload must not contain symlinks: ${relative}`);
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true });
      for (const child of await readdir(from)) await copyEntry(path.join(relative, child));
    } else if (stat.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    } else throw new Error(`Unsupported payload entry: ${relative}`);
  }
  for (const relative of [...directories, ...files]) {
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw new Error('Payload paths must be contained relative paths.');
    await copyEntry(relative);
  }
}

export async function assertContainedSymlinks(root) {
  const resolvedRoot = await realpath(root);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = await realpath(target);
        if (!resolved.startsWith(resolvedRoot + path.sep)) throw new Error('Dependency symlink escapes the application bundle.');
      } else if (entry.isDirectory()) await visit(target);
    }
  }
  await visit(root);
}

export async function publishArtifacts(entries, outputDirectory) {
  const backup = await mkdtemp(path.join(outputDirectory, '.previous-release-'));
  const saved = [], published = [];
  try {
    for (const { source, name } of entries) {
      if (path.basename(name) !== name || !name || name === '.' || name === '..') throw new Error('Invalid artifact name.');
      const target = path.join(outputDirectory, name), previous = path.join(backup, name);
      try { await rename(target, previous); saved.push({ target, previous }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(source, target); published.push(target);
    }
    if (!saved.length) await rm(backup, { recursive: true });
    return saved.length ? backup : null;
  } catch (error) {
    for (const target of published.reverse()) await rm(target, { recursive: true, force: true });
    for (const { target, previous } of saved.reverse()) await rename(previous, target);
    await rm(backup, { recursive: true, force: true });
    throw error;
  }
}
