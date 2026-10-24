import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { opendir, lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { boundedRead } from './bounded-read.js';
import { protectedName, resolveProjectPath } from './file-policy.js';
import { loadSkill } from './skills.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const unsafeStage = agent => !!(agent.permissions.write || agent.permissions.execute || agent.mcp?.length || agent.applications?.length || agent.memory);

// Opt-in checkpoints fail closed if a complete accessible-project snapshot cannot
// be obtained. Protected files are never read or copied into the checkpoint.
export async function projectFingerprint(root, signal) {
  const base = await realpath(root), hash = createHash('sha256');
  let entries = 0, bytes = 0;
  async function walk(relative = '', depth = 0) {
    signal?.throwIfAborted();
    if (depth > 20) throw new Error('Checkpoint exceeds directory depth limit.');
    const directory = relative ? await resolveProjectPath(base, relative) : base;
    const before = await lstat(directory), children = [];
    for await (const entry of await opendir(directory)) {
      if (++entries > 5000) throw new Error('Checkpoint exceeds 5000 directory entries.');
      if (!protectedName(entry.name)) children.push(entry.name);
    }
    for (const name of children.sort()) {
      signal?.throwIfAborted();
      const file = relative ? `${relative}/${name}` : name;
      const absolute = await resolveProjectPath(base, file), stat = await lstat(absolute);
      hash.update(JSON.stringify([file, stat.mode]));
      if (stat.isDirectory()) await walk(file, depth + 1);
      else {
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Checkpoint requires regular files without links.');
        if (stat.size > 8_000_000 || (bytes += stat.size) > 50_000_000) throw new Error('Checkpoint exceeds 8 MB per file or 50 MB total.');
        const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const data = await boundedRead(handle, 8_000_000);
          hash.update(createHash('sha256').update(data).digest());
        } finally { await handle.close(); }
      }
    }
    const after = await lstat(directory);
    if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Project changed during checkpoint capture.');
  }
  await walk();
  return { root: base, digest: hash.digest('hex'), entries, bytes };
}

export async function workflowFingerprint(root, workflow, config, prepared, settings) {
  const definitions = [];
  for (const step of workflow.steps) {
    const { agent, provider } = prepared.get(step.id);
    // Command/MCP/app effects cannot be represented by a project file snapshot.
    if (agent.permissions.execute || agent.mcp?.length || agent.applications?.length || agent.memory) throw new Error('Checkpoint mode currently requires agents without commands, external tools, applications or memory.');
    const skills = [];
    for (const name of agent.skills || []) skills.push((await loadSkill(root, name)).digest);
    definitions.push({ step: step.id, agent, skills, provider: { name: provider.name, model: provider.model, endpoint: provider.endpoint, profile: provider.profile } });
  }
  return digest({ workflow, config, definitions, settings });
}
