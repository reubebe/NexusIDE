import { readFile, realpath, lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAgent } from './agents.js';
import { importSkill, auditSkill } from './skills.js';
import { loadConfig, saveConfig } from './config.js';
import { writeState } from './state.js';
import { validateWorkflow } from './workflows.js';
import { acquireWorkspace } from './locks.js';
import { boundedRead } from './bounded-read.js';

const asset = relative => fileURLToPath(new URL('../' + relative, import.meta.url));
const json = async relative => JSON.parse(await readFile(asset(relative), 'utf8'));

// Explicit user setup only. Agent execution still uses ordinary tool approval.
export async function installOptionalIntegration(root, name, options = {}) {
  if (!['cortex', 'review', 'anatomy'].includes(name)) throw new Error('Choose cortex, review, or anatomy.');
  if (Object.keys(options).some(key => !['engine', 'brain', 'python'].includes(key)) || (name !== 'cortex' && Object.keys(options).length)) throw new Error('Only Cortex accepts engine, brain and python options.');
  if (options.python !== undefined && (typeof options.python !== 'string' || !options.python.trim() || options.python.includes('\0'))) throw new Error('Cortex python must name a nonempty executable without NUL characters.');
  let profile;
  if (name === 'cortex') {
    if (process.platform === 'win32') throw new Error('The Cortex reader currently requires macOS or Linux.');
    for (const key of ['engine', 'brain']) if (typeof options[key] !== 'string' || !path.isAbsolute(options[key])) throw new Error(`Cortex needs an absolute --${key} path.`);
    if ((await lstat(options.engine)).isSymbolicLink() || !(await lstat(options.brain)).isDirectory() || (await lstat(options.brain)).isSymbolicLink()) throw new Error('Use a real engine file and brain directory, without symbolic links.');
    const engine = await realpath(options.engine), brain = await realpath(options.brain);
    const notes = await lstat(path.join(brain, 'notes'));
    if (!notes.isDirectory() || notes.isSymbolicLink()) throw new Error('The brain needs a real notes directory.');
    const handle = await open(engine, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Cortex engine must be a regular file without hard links.');
      bytes = await boundedRead(handle, 1_000_000);
    } finally { await handle.close(); }
    profile = { command: options.python || 'python3', args: ['-I', '-B', asset('integrations/cortex-reader.py'), '--engine', engine, '--engine-sha256', createHash('sha256').update(bytes).digest('hex'), '--brain', brain], tools: ['cortex_find', 'cortex_read', 'cortex_context'], envKeys: [] };
  }
  const release = await acquireWorkspace(root, root, randomUUID());
  const created = [], kept = [];
  const install = async relative => {
    const agent = await json(relative);
    try { await installAgent(root, agent); created.push(agent.name); }
    catch (error) { if (error.code !== 'EEXIST') throw error; kept.push(agent.name); }
  };
  try {
    if (name === 'cortex') {
      const config = await loadConfig(root);
      if (config.mcp.cortex && JSON.stringify(config.mcp.cortex) !== JSON.stringify(profile)) throw new Error('An existing Cortex connection differs. Review and update it in Connections; setup did not replace it.');
      await install('examples/cortex-reader.json');
      if (!config.mcp.cortex) {
        await writeState(root, 'backups', `before-cortex-${randomUUID()}.json`, config, { exclusive: true });
        config.mcp.cortex = profile;
        await saveConfig(root, config);
      }
    } else if (name === 'review') {
      for (const agent of ['plan-critic', 'implementation-inspector']) await install(`examples/${agent}.json`);
      const team = validateWorkflow(await json('examples/independent-review.team.json'));
      try { await writeState(root, 'teams', `${team.name}.json`, team, { exclusive: true }); created.push('team:' + team.name); }
      catch (error) { if (error.code !== 'EEXIST') throw error; kept.push('team:' + team.name); }
    } else {
      const manifest = await json('integrations/anatomy/provenance.json');
      try {
        await importSkill(root, asset('integrations/anatomy'), { source: manifest.source, revision: manifest.revision, license: 'MIT' });
        created.push('skill:anatomy');
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const audit = await auditSkill(root, 'anatomy');
        if (audit.integrity !== 'matches-record') throw new Error('Existing Anatomy skill failed integrity checks. Review it before reinstalling.');
        kept.push('skill:anatomy');
      }
      await install('examples/technical-illustrator.json');
    }
    return { integration: name, created, kept, next: name === 'review' ? 'Assign distinct author and reviewer models in Connections before running independent-review.' : name === 'cortex' ? 'Select cortex-reader. Each knowledge query requires approval and uses the selected model.' : 'Select technical-illustrator. Imported skill scripts are resources; execution is not enabled.' };
  } finally { await release(); }
}
