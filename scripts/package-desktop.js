import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildDesktop } from './build-desktop.js';
import { commandEnvironment, runProcess } from '../src/process.js';
import { assertContainedSymlinks, assertDeploymentTarget, assertRuntimeMetadata, assertSystemLibraries, copyPayload, MINIMUM_MACOS, publishArtifacts, safeVersion, sha256 } from './desktop-package-utils.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(root, 'dist');

export function applicationPlist(version, arch) {
  safeVersion(version);
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Unsupported application architecture.');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>NexusIDE</string>
<key>CFBundleIdentifier</key><string>dev.nexuside.desktop</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>NexusIDE</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>${MINIMUM_MACOS}</string>
<key>LSArchitecturePriority</key><array><string>${arch === 'x64' ? 'x86_64' : arch}</string></array>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`;
}

async function checked(command, args, options = {}) {
  const result = await runProcess(command, args, { timeoutMs: 120000, maxBytes: 100000, ...options });
  if (result.code !== 0) throw new Error(`${path.basename(command)} failed (${result.stopped || result.code}).\n${result.output}`);
  return result.output;
}

async function inspectBinary(binary) {
  const libraries = assertSystemLibraries(await checked('/usr/bin/otool', ['-L', binary]));
  assertDeploymentTarget(await checked('/usr/bin/otool', ['-l', binary], { maxBytes: 1000000 }));
  return libraries;
}

async function nodeLicense(version, localLicense) {
  let text;
  if (localLicense) text = await readFile(localLicense, 'utf8');
  else {
    // License text only: executable bytes always come from the explicitly selected local Node.
    const url = `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok) throw new Error('Could not retrieve the matching Node license. Set NEXUS_NODE_LICENSE to a local copy for an offline build.');
    text = await response.text();
  }
  if (text.length > 1000000 || !text.includes('Node.js is licensed')) throw new Error('Invalid Node license text.');
  return text;
}

export async function packageDesktop({ identity = process.env.NEXUS_CODESIGN_IDENTITY || '-', nodeBinary = process.env.NEXUS_NODE_BINARY || process.execPath, nodeLicenseFile = process.env.NEXUS_NODE_LICENSE } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS packaging must run on macOS.');
  if (identity !== '-') throw new Error('Phase 4 produces ad-hoc development artifacts only. Developer ID signing and notarization require the Phase 5 release process.');
  const arch = process.arch;
  const metadata = JSON.parse(await checked(nodeBinary, ['-p', 'JSON.stringify({version:process.version,arch:process.arch,platform:process.platform,modules:process.versions.modules})']));
  assertRuntimeMetadata(metadata, arch);
  const runtimeLibraries = await inspectBinary(nodeBinary);
  const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = safeVersion(packageMetadata.version);
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  for (const [name, dependency] of Object.entries(lock.packages || {})) {
    if (name && !dependency.dev && (!dependency.integrity || !dependency.resolved?.startsWith('https://registry.npmjs.org/'))) throw new Error(`Unpinned or non-registry production dependency: ${name}`);
  }
  const license = await nodeLicense(metadata.version, nodeLicenseFile);
  await mkdir(outputDirectory, { recursive: true });
  const staging = await mkdtemp(path.join(outputDirectory, '.package-'));
  try {
    const volume = path.join(staging, 'volume');
    const app = path.join(volume, 'NexusIDE.app');
    const contents = path.join(app, 'Contents');
    const payload = path.join(contents, 'Resources', 'app');
    const runtime = path.join(contents, 'Resources', 'runtime');
    const bundledNode = path.join(runtime, 'bin', 'node');
    const executable = path.join(contents, 'MacOS', 'NexusIDE');
    await mkdir(path.dirname(executable), { recursive: true });
    await mkdir(path.dirname(bundledNode), { recursive: true });
    await copyFile(nodeBinary, bundledNode); await chmod(bundledNode, 0o755);
    await writeFile(path.join(runtime, 'LICENSE'), license);
    await copyPayload(root, payload);
    await buildDesktop({ output: executable });
    await inspectBinary(executable);
    await writeFile(path.join(contents, 'Info.plist'), applicationPlist(version, arch));

    // Never copy the developer's node_modules or run third-party installation scripts.
    const buildEnvironment = { ...commandEnvironment(), PATH: `${path.dirname(bundledNode)}:${process.env.PATH || '/usr/bin:/bin'}` };
    const npmUserConfig = path.join(staging, 'npm-user.rc'), npmGlobalConfig = path.join(staging, 'npm-global.rc');
    await writeFile(npmUserConfig, ''); await writeFile(npmGlobalConfig, '');
    await checked('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--userconfig=${npmUserConfig}`, `--globalconfig=${npmGlobalConfig}`, `--cache=${path.join(staging, 'npm-cache')}`], { cwd: payload, env: buildEnvironment, timeoutMs: 180000 });
    const prebuilds = path.join(payload, 'node_modules', 'node-pty', 'prebuilds');
    for (const entry of await readdir(prebuilds)) {
      if (entry !== `darwin-${arch}`) await rm(path.join(prebuilds, entry), { recursive: true, force: true });
    }
    await checked(bundledNode, [path.join(payload, 'scripts', 'setup-pty.js')], { cwd: payload, env: { PATH: '/usr/bin:/bin' } });
    await assertContainedSymlinks(payload);
    const nativeDirectory = path.join(prebuilds, `darwin-${arch}`);
    const nativeBinaries = [path.join(nativeDirectory, 'pty.node'), path.join(nativeDirectory, 'spawn-helper')];
    for (const binary of nativeBinaries) await inspectBinary(binary);
    const git = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: root });
    const dirty = await runProcess('git', ['status', '--porcelain'], { cwd: root });
    const manifest = {
      version, arch, minimumMacOS: MINIMUM_MACOS, builtAt: new Date().toISOString(), signing: 'ad-hoc', notarized: false,
      sourceRevision: git.code === 0 ? git.output.trim() : null, sourceDirty: dirty.code === 0 ? Boolean(dirty.output.trim()) : null,
      lockfileSha256: await sha256(path.join(payload, 'package-lock.json')),
      runtime: { ...metadata, inputSha256: await sha256(nodeBinary), systemLibraries: runtimeLibraries },
      dependencies: Object.fromEntries(Object.entries(lock.packages).filter(([name, info]) => name && !info.dev).map(([name, info]) => [name, { version: info.version, integrity: info.integrity }])),
      limitations: ['Architecture-specific development build', 'No Developer ID signature or notarization', 'No clean-machine certification', 'External tools/models/integrations require separate installation'],
    };
    await writeFile(path.join(contents, 'Resources', 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const binary of [bundledNode, ...nativeBinaries]) await checked('/usr/bin/codesign', ['--force', '--sign', '-', binary]);
    await checked('/usr/bin/codesign', ['--force', '--sign', '-', app]);
    await checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);

    // Starts a real PTY with the bundled ABI, and checks SQLite plus application dependencies.
    const smokeCode = `const assert=require('node:assert/strict'); const {createRequire}=require('node:module'); const req=createRequire(process.argv[1]); const db=new (require('node:sqlite').DatabaseSync)(':memory:'); assert.equal(db.prepare('select 1 as value').get().value,1); db.close(); for (const name of ['yaml','@modelcontextprotocol/sdk/server/index.js','@agentclientprotocol/sdk']) req.resolve(name); const pty=req('node-pty'); let output=''; const child=pty.spawn('/bin/sh',['-c','printf NEXUS_PTY_OK'],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin'}}); const timer=setTimeout(()=>{child.kill();process.exit(1)},5000); child.onData(value=>output+=value); child.onExit(value=>{clearTimeout(timer);assert.equal(value.exitCode,0);assert.match(output,/NEXUS_PTY_OK/);console.log('bundled-runtime-ok')});`;
    await checked(bundledNode, ['-e', smokeCode, path.join(payload, 'package.json')], { cwd: staging, env: { PATH: '/usr/bin:/bin' }, timeoutMs: 15000 });
    await symlink('/Applications', path.join(volume, 'Applications'));
    await writeFile(path.join(volume, 'READ ME.txt'), `NexusIDE ${version} (${arch})\n\nDrag NexusIDE.app to Applications. Open it and choose a project folder. Node and the dashboard runtime are included; Node/npm are not needed to launch.\n\nThis is an ad-hoc signed development build, NOT a notarized public release. Gatekeeper may block it. Do not disable Gatekeeper globally. Phase 5 will provide Developer ID signing/notarization.\n\nExternal models, Git, Python and integration tools are separate prerequisites. Project state stays in the chosen project's .nexus directory; app preferences are under ~/Library/Application Support/NexusIDE.\n`);
    const dmgName = `NexusIDE-${version}-${arch}.dmg`, reportName = `NexusIDE-${version}-${arch}.json`;
    const dmg = path.join(staging, dmgName);
    await checked('/usr/bin/hdiutil', ['create', '-volname', 'NexusIDE', '-srcfolder', volume, '-format', 'UDZO', dmg], { timeoutMs: 180000 });
    await checked('/usr/bin/hdiutil', ['verify', dmg], { timeoutMs: 120000 });
    const report = { ...manifest, dmgSha256: await sha256(dmg), bundledNodeSha256: await sha256(bundledNode), checks: ['system-only-dynamic-linkage', 'minimum-os-targets', 'lockfile-production-install', 'contained-dependency-symlinks', 'bundled-node-abi', 'real-pty', 'sqlite', 'code-signature', 'disk-image-integrity'] };
    await writeFile(path.join(staging, reportName), JSON.stringify(report, null, 2) + '\n');
    const previousArtifacts = await publishArtifacts([{ source: app, name: 'NexusIDE.app' }, { source: dmg, name: dmgName }, { source: path.join(staging, reportName), name: reportName }], outputDirectory);
    return { app: path.join(outputDirectory, 'NexusIDE.app'), dmg: path.join(outputDirectory, dmgName), report: path.join(outputDirectory, reportName), previousArtifacts, identity: 'ad-hoc', arch, runtime: metadata.version };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await packageDesktop(), null, 2));
