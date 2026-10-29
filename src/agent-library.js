import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAgent, validateAgent } from './agents.js';
import { validateWorkflow } from './workflows.js';
import { writeState } from './state.js';

// Public agent definitions shipped with Nexus. Private workspace state,
// credentials, project paths and transcripts are never part of this library.
const libraryRoot = fileURLToPath(new URL('../examples/agents/', import.meta.url));

export async function bundledAgents() {
  const files = (await readdir(libraryRoot)).filter(file => file.endsWith('.json')).sort();
  return Promise.all(files.map(async file => validateAgent(JSON.parse(await readFile(path.join(libraryRoot, file), 'utf8')))));
}

export async function installBundledAgents(root, { onAgent = () => {}, exclude = [] } = {}) {
  const created = [], kept = [];
  for (const agent of await bundledAgents()) {
    if (exclude.includes(agent.name)) continue;
    try {
      await installAgent(root, agent); created.push(agent.name); onAgent(agent.name, true);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      kept.push(agent.name); onAgent(agent.name, false);
    }
  }
  return { created, kept };
}

export async function installBundledTeams(root) {
  const directory = fileURLToPath(new URL('../examples/teams/', import.meta.url));
  const created = [], kept = [];
  for (const file of (await readdir(directory)).filter(file => file.endsWith('.json')).sort()) {
    const team = validateWorkflow(JSON.parse(await readFile(path.join(directory, file), 'utf8')));
    try { await writeState(root, 'teams', `${team.name}.json`, team, { exclusive: true }); created.push(team.name); }
    catch (error) { if (error.code !== 'EEXIST') throw error; kept.push(team.name); }
  }
  return { created, kept };
}
