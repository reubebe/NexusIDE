#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { installAgent, listAgents, loadAgent, validateAgent } from './agents.js';
import { runAgent } from './runtime.js';
import { createWorktree, listWorktrees, resolveWorktree, inspectWorktree, mergeWorktree } from './worktrees.js';
import { loadConfig, saveConfig, routeProvider } from './config.js';
import { importSkill, listSkills, loadSkill, readSkillBundle, auditSkill } from './skills.js';
import { scanSkillFiles } from './skill-scan.js';
import { remember, forget, listMemories, updateMemory, memoryHistory } from './memory.js';
import { searchMemory } from './memory-search.js';
import { draftMemory, listMemoryDrafts, reviewMemoryDraft } from './memory-distillation.js';
import { writeState, readState, listState, safeName, recentState } from './state.js';
import { validateWorkflow, loadWorkflow, runWorkflow } from './workflows.js';
import { terminalApproval, print } from './approval.js';
import { importMarkdownAgent } from './imports.js';
import { setSecret, listSecrets } from './vault.js';
import { inspectWorkspaceLocks, removeStaleWorkspaceLock } from './locks.js';
import { inspectActivity, recoverActivity } from './recovery.js';
import { rebuildMemoryIndex, semanticRecall } from './semantic-memory.js';
import { rebuildProjectIndex, searchProject, semanticProjectSearch } from './project-index.js';
import { initializeWorkspace } from './workspace-init.js';

const help = `NexusIDE · One runtime. Any agent. Any model.

  nexus init                              Create project agents and team
  nexus agents                            List agents
  nexus inspect <name>                    Inspect agent
  nexus install <agent.json>              Import native agent
  nexus import <agent.md>                 Import foreign instructions safely
  nexus run <agent> "task" [options]      Run an agent
  nexus plan "task" [--demo]              Generate a reviewable team workflow
  nexus status [run-id]                   List runs or inspect transcript
  nexus team install <team.json>          Import workflow DAG
  nexus team run <name> "task"            Run workflow
  nexus team status [id]                  Inspect workflows
  nexus skills import <directory>         Import SKILL.md and resources
  nexus skills scan <directory>           Statically scan before importing a skill
  nexus skills audit [name]               Check stored integrity and rescan installed skills
  nexus skills list                       List imported skills
  nexus skills inspect <name>             Inspect provenance and resources
  nexus memory add "text" [--agent name]  Save scoped memory
  nexus memory list [--agent name]         List notes [--all-scopes, --layer L1|L2|L3]
  nexus memory history <id>               Inspect note revisions
  nexus memory update <id> <patch.json>    Edit using patch.expectedRevision
  nexus memory search "query"             Search memory [--mode lexical|hybrid|semantic]
  nexus memory index [--force]            Update embeddings for changed notes
  nexus memory semantic "query"           Semantic search [--agent name]
  nexus memory distill <run-id>            Draft candidates [--demo | --provider profile]
  nexus memory drafts                     List saved drafts and candidate status
  nexus memory review <draft> <candidate> approve|reject --revision N
  nexus memory forget <id>                Delete memory
  nexus project index [--force]           Update code/document index [--mode lexical]
  nexus project search "query"            Search code/documents [--mode lexical|hybrid|semantic]
  nexus project semantic "query"          Search indexed project content by meaning
  nexus storage status                    Inspect SQLite storage and integrity
  nexus storage migrate                   Import existing history and notes
  nexus storage backup <file.sqlite>      Save a consistent SQLite snapshot
  nexus config show                       Show provider/MCP configuration
  nexus config import <file.json>          Configure profiles and routes
  nexus providers                         Show provider compatibility evidence
  nexus providers check <profile>         Run bounded synthetic model checks
  nexus providers check-env               Check an explicit environment model
  nexus worktree create|diff <name>        Create or inspect worktree
  nexus worktree list                      List worktrees
  nexus worktree merge <name>              Review and approve a fast-forward merge
  nexus desktop                           Open the native macOS workspace
  nexus serve [--port 4317]                Local dashboard
  nexus terminal                          Interactive terminal wrapper
  nexus acp [--demo]                       Editor Agent Client Protocol bridge
  nexus packs install                     Install research and hobby teams
  nexus extras install cortex|review|anatomy  Set up optional knowledge, review or illustration tools
  nexus integrations                      Show integration catalog
  nexus integration status [name]         Check optional runtime installation
  nexus integration install <name>        Install TradingAgents or OpenMontage
  nexus integration configure <name>      Grant a runtime to its hobby agent
  nexus integration upgrade <name>        Stage and verify a reviewed runtime
  nexus integration rollback <name> [id]  Activate a retained verified version
  nexus integration uninstall <name>      Disable runtime; retain recoverable files
  nexus integration unconfigure <name>    Revoke managed project grants
  nexus integration recover <name>        Inspect and recover interrupted setup
  nexus doctor                            Check local setup and connections
  nexus recover [lock-key-prefix]          Inspect locks or remove a confirmed stale lock
  nexus recover activity                   Inspect unfinished runs and workflows
  nexus recover run|workflow <id>          Mark a confirmed orphan as interrupted
  nexus secret set <name>                 Encrypt NEXUS_SECRET_VALUE
  nexus secret list                       List secret names (never values)

Run options: --demo, --provider <profile>, --worktree <name>, --resume <id>,
  --allow-commands, --sandbox-image <image@sha256:digest>
Team options: --demo, --allow-commands, --isolated, --concurrency <1-4>
Memory add options: --layer L1|L2|L3, --category <category>
Memory list options: --status all|active|archived, --offset N, --limit N
Memory history/drafts options: --offset N, --limit N
Memory search/semantic: --agent <name> applies that agent's memory selection.
Search defaults to hybrid, with local keyword fallback. Semantic commands require embeddings.
Distillation requires a completed run; live provider transmission prompts for approval.

Commands require agent execute permission, --allow-commands, and approval.
Provider env: NEXUS_PROVIDER, NEXUS_MODEL, NEXUS_API_KEY, NEXUS_BASE_URL.`;

export function parseOptions(args) {
  const options = {}, positional = [];
  const values = new Set(['provider', 'worktree', 'resume', 'sandbox-image', 'concurrency', 'agent', 'port', 'mode', 'layer', 'category', 'status', 'offset', 'limit', 'revision', 'engine', 'brain', 'python']);
  const flags = new Set(['demo', 'allow-commands', 'isolated', 'force', 'all-scopes']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!args[i].startsWith('--')) { positional.push(args[i]); continue; }
    const name = args[i].slice(2);
    if (flags.has(name)) options[name] = true;
    else if (values.has(name)) { const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value.`); options[name] = value; }
    else throw new Error(`Unknown option: --${name}`);
  }
  return { options, positional };
}
async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) return print(help);
  const root = process.cwd();
  const { options, positional: args } = parseOptions(argv);
  const json = async file => { if (!file) throw new Error('Provide a JSON file.'); return JSON.parse(await readFile(file, 'utf8')); };
  if (command === 'desktop') { const { launchDesktop } = await import('./desktop.js'); return launchDesktop(root); }
  if (command === 'terminal') { const { launchTerminal } = await import('./terminal.js'); return launchTerminal(root); }
  if (command === 'acp') { const { startAcp } = await import('./acp.js'); return startAcp({ demo: options.demo, allowCommands: options['allow-commands'] }); }
  if (command === 'packs' && args[0] === 'install') { const { installPacks } = await import('./packs.js'); return print(await installPacks(root)); }
  if (command === 'integrations') return print(await readFile(new URL('../integrations/catalog.json', import.meta.url), 'utf8'));
  if (command === 'extras') {
    if (args[0] !== 'install' || args.length !== 2) throw new Error('Use nexus extras install cortex --engine /path/cortex.py --brain /path/brain [--python python3], or nexus extras install review|anatomy.');
    const { installOptionalIntegration } = await import('./optional-integrations.js');
    return print(JSON.stringify(await installOptionalIntegration(root, args[1], options), null, 2));
  }
  if (command === 'integration') {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Integration operation cancelled.'));
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
    const { configureIntegration, installIntegration, integrationStatus, listIntegrationStatus, upgradeIntegration, rollbackIntegration, uninstallIntegration, unconfigureIntegration, recoverIntegration } = await import('./integrations.js');
    if (args[0] === 'status') return print(JSON.stringify(args[1] ? await integrationStatus(args[1]) : await listIntegrationStatus(), null, 2));
    if (args[0] === 'install' && args.length === 2) return print(JSON.stringify(await installIntegration(args[1], { signal: controller.signal }), null, 2));
    const actions = { upgrade: upgradeIntegration, rollback: rollbackIntegration, uninstall: uninstallIntegration, recover: recoverIntegration };
    const action = args[0], name = args[1];
    if ((Object.hasOwn(actions, action) || ['configure', 'unconfigure'].includes(action)) && (args.length === 2 || (action === 'rollback' && args.length === 3))) {
      const status = await integrationStatus(name);
      const allowed = await terminalApproval(controller.signal)({ type: `integration-${action}`, integration: name, status, ...(args[2] ? { version: args[2] } : {}), notice: action === 'configure' ? 'Grants host execution and the listed environment-key access to this project agent.' : action === 'upgrade' ? 'Runs reviewed third-party setup code with your account permissions.' : 'Changes managed lifecycle state. Runtime files are retained, not deleted.' });
      if (!allowed) return print('Integration change declined.');
      const settings = { confirm: true, signal: controller.signal, ...(args[2] ? { version: args[2] } : {}) };
      const result = action === 'configure' ? await configureIntegration(root, name, settings) : action === 'unconfigure' ? await unconfigureIntegration(root, name, settings) : await actions[action](name, settings);
      return print(JSON.stringify(result, null, 2));
    }
    throw new Error('Use nexus integration status [name], install|configure|upgrade|uninstall|unconfigure|recover <name>, or rollback <name> [version].');
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
  if (command === 'doctor') { const { doctor } = await import('./doctor.js'); return print(JSON.stringify(await doctor(root), null, 2)); }
  if (command === 'providers') {
    const { providerMatrix, verifyProvider, verifyEnvironmentProvider } = await import('./provider-verification.js');
    if (!args.length) return print(JSON.stringify(await providerMatrix(root), null, 2));
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Provider check cancelled.'));
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try {
      let result;
      if (args[0] === 'check' && args.length === 2) result = await verifyProvider(root, args[1], { signal: controller.signal });
      else if (args[0] === 'check-env' && args.length === 1) result = await verifyEnvironmentProvider(root, { signal: controller.signal });
      else throw new Error('Use nexus providers, providers check <profile>, or providers check-env.');
      if (!result.verified) process.exitCode = 1;
      return print(JSON.stringify(result, null, 2));
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
  if (command === 'storage') {
    const { storageStatus, migrateStorage, backupStorage } = await import('./storage-maintenance.js');
    if (args[0] === 'status' && args.length === 1) return print(JSON.stringify(await storageStatus(root), null, 2));
    if (args[0] === 'migrate' && args.length === 1) return print(JSON.stringify(await migrateStorage(root), null, 2));
    if (args[0] === 'backup' && args.length === 2) return print(JSON.stringify(await backupStorage(root, args[1]), null, 2));
    throw new Error('Use nexus storage status, migrate, or backup <file.sqlite>.');
  }
  if (command === 'recover') {
    if (args[0] === 'activity' && args.length === 1) return print(JSON.stringify(await inspectActivity(root), null, 2));
    if (['run', 'workflow'].includes(args[0])) {
      if (args.length !== 2) throw new Error('Use nexus recover run|workflow <id>.');
      return print(JSON.stringify(await recoverActivity(root, args[0], args[1], terminalApproval()), null, 2));
    }
    const key = args[0];
    if (args.length > 1) throw new Error('Use nexus recover [lock-key-prefix].');
    if (!key) {
      const locks = await inspectWorkspaceLocks(root);
      return print(locks.length ? JSON.stringify(locks, null, 2) : 'No workspace locks.');
    }
    const lock = await removeStaleWorkspaceLock(root, key, terminalApproval());
    return print(`Removed stale lock ${lock.key} for ${lock.workspace}. Run records are retained for review.`);
  }
  if (command === 'secret') {
    if (args[0] === 'set') { await setSecret(root, args[1], process.env.NEXUS_SECRET_VALUE); return print('Encrypted secret saved.'); }
    if (args[0] === 'list') return print((await listSecrets(root)).join('\n'));
  }
  if (command === 'init') {
    await initializeWorkspace(root, { onAgent: (name, created) => print(`${created ? 'Created' : 'Kept'} ${name}`) });
    return print('Ready. Run an agent, or start the dashboard with: npm start -- serve');
  }
  if (command === 'agents') return print(JSON.stringify(await listAgents(root), null, 2));
  if (command === 'inspect') return print(JSON.stringify(await loadAgent(root, args[0]), null, 2));
  if (command === 'install') { const agent = validateAgent(await json(args[0])); await installAgent(root, agent); return print(`Installed ${agent.name}`); }
  if (command === 'import') return print(JSON.stringify(await importMarkdownAgent(root, args[0]), null, 2));
  if (command === 'config') {
    if (args[0] === 'show') return print(JSON.stringify(await loadConfig(root), null, 2));
    if (args[0] === 'import') { await saveConfig(root, await json(args[1])); return print('Configuration saved.'); }
  }
  if (command === 'skills') {
    if (args[0] === 'audit') {
      if (args.length > 2) throw new Error('Use nexus skills audit [name].');
      const names = args[1] ? [args[1]] : (await listState(root, 'skills')).map(f => f.slice(0, -5));
      const reports = [];
      for (const name of names) reports.push(await auditSkill(root, name));
      if (reports.some(r => r.integrity !== 'matches-record')) process.exitCode = 1;
      return print(JSON.stringify(reports, null, 2));
    }
    if (args[0] === 'scan') { const bundle = await readSkillBundle(args[1]); return print(JSON.stringify({ skill: bundle.meta.name, ...scanSkillFiles(bundle.files) }, null, 2)); }
    if (args[0] === 'import') return print(JSON.stringify(await importSkill(root, args[1]), null, 2));
    if (args[0] === 'list') return print(JSON.stringify(await listSkills(root), null, 2));
    if (args[0] === 'inspect') { const s = await loadSkill(root, args[1]); return print(JSON.stringify({ ...s, files: Object.keys(s.files) }, null, 2)); }
  }
  if (command === 'memory') {
    if (args[0] === 'index') return runIndex(rebuildMemoryIndex);
    if (['search', 'semantic'].includes(args[0])) {
      if (args[0] === 'semantic' && options.mode) throw new Error('memory semantic requires semantic retrieval; use memory search --mode for other modes.');
      const agent = options.agent ? await loadAgent(root, options.agent) : undefined;
      if (agent && !agent.memory) throw new Error('Memory is disabled for this agent.');
      const settings = { ...(options.mode ? { mode: options.mode } : {}), ...(agent ? { loadout: agent.memoryLoadout || {} } : {}), ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}) };
      const search = args[0] === 'semantic' ? semanticRecall : searchMemory;
      return print(JSON.stringify(await search(root, args.slice(1).join(' '), options.agent, settings), null, 2));
    }
    if (args[0] === 'add') return print(JSON.stringify(await remember(root, { text: args.slice(1).join(' '), scope: options.agent ? 'agent' : 'project', agent: options.agent, ...(options.layer ? { layer: options.layer } : {}), ...(options.category ? { category: options.category } : {}) }), null, 2));
    if (args[0] === 'list' && args.length === 1) return print(JSON.stringify(await listMemories(root, { ...pageOptions(), agent: options.agent, allScopes: Boolean(options['all-scopes']), ...(options.layer ? { layer: options.layer } : {}), ...(options.status ? { status: options.status } : {}) }), null, 2));
    if (args[0] === 'history' && args.length === 2) return print(JSON.stringify(await memoryHistory(root, args[1], pageOptions()), null, 2));
    if (args[0] === 'update' && args.length === 3) return print(JSON.stringify(await updateMemory(root, args[1], await json(args[2])), null, 2));
    if (args[0] === 'drafts' && args.length === 1) return print(JSON.stringify(await listMemoryDrafts(root, pageOptions()), null, 2));
    if (args[0] === 'review' && args.length === 4) return print(JSON.stringify(await reviewMemoryDraft({ root, draftId: args[1], candidateId: args[2], decision: args[3], expectedRevision: Number(options.revision) }), null, 2));
    if (args[0] === 'distill' && args.length === 2) {
      if (Boolean(options.demo) === Boolean(options.provider)) throw new Error('Choose memory distill <run-id> --demo or --provider <profile>.');
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error('Memory distillation cancelled.'));
      process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      try {
        const runId = safeName(args[1]);
        const run = options.demo ? undefined : await readState(root, 'runs', `${runId}.json`);
        const provider = options.demo ? undefined : await routeProvider(root, { name: run.agent }, { providerName: options.provider });
        return print(JSON.stringify(await draftMemory({ root, runId, provider, demo: Boolean(options.demo), approve: terminalApproval(controller.signal), signal: controller.signal }), null, 2));
      } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
    }
    if (args[0] === 'forget' && args.length === 2) { await forget(root, args[1]); return print('Memory and its revision history deleted.'); }
    throw new Error('Use nexus memory add, list, search, semantic, index, history <id>, update <id> <patch.json>, distill <run-id>, drafts, review <draft> <candidate> approve|reject --revision N, or forget <id>.');
  }
  if (command === 'project') {
    if (args[0] === 'index') return runIndex(rebuildProjectIndex);
    if (args[0] === 'search') return print(JSON.stringify(await searchProject(root, args.slice(1).join(' '), { ...(options.mode ? { mode: options.mode } : {}), ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}) }), null, 2));
    if (args[0] === 'semantic') {
      if (options.mode) throw new Error('project semantic requires embeddings; use project search --mode for other modes.');
      return print(JSON.stringify(await semanticProjectSearch(root, args.slice(1).join(' ')), null, 2));
    }
  }
  if (command === 'worktree') {
    if (args[0] === 'merge') return print(JSON.stringify(await mergeWorktree(root, args[1], terminalApproval()), null, 2));
    if (args[0] === 'create') return print(`Created ${await createWorktree(root, args[1])}\nBased on committed HEAD.`);
    if (args[0] === 'list') return print(await listWorktrees(root));
    if (args[0] === 'diff') return print(await inspectWorktree(root, args[1]));
  }
  if (command === 'status' || (command === 'team' && args[0] === 'status')) {
    const folder = command === 'status' ? 'runs' : 'workflows';
    const id = command === 'status' ? args[0] : args[1];
    if (id) return print(JSON.stringify(await readState(root, folder, `${safeName(id)}.json`), null, 2));
    const records = await recentState(root, folder, 30, { summary: true });
    return print(records.map(r => `${r.started}  ${r.agent || r.name}  ${r.status}  ${r.id}`).join('\n') || 'No runs yet.');
  }
  if (command === 'team' && args[0] === 'install') {
    const team = validateWorkflow(await json(args[1]));
    await writeState(root, 'teams', `${team.name}.json`, team, { exclusive: true });
    return print(`Installed team ${team.name}`);
  }
  if (command === 'serve') {
    const { startServer } = await import('./server.js');
    const server = await startServer({ root, port: Number(options.port || 4317) });
    const stop = async () => {
      try { await server.close(); }
      catch (error) { console.error(`NexusIDE shutdown: ${error.message}`); process.exitCode = 1; }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    print(`NexusIDE dashboard: ${server.url}`);
    return;
  }
  async function runIndex(build) {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Index build cancelled.'));
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try { return print(JSON.stringify(await build(root, { signal: controller.signal, force: Boolean(options.force), ...(options.mode ? { mode: options.mode } : {}) }), null, 2)); }
    finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
  function pageOptions() {
    return { ...(options.offset !== undefined ? { offset: Number(options.offset) } : {}), ...(options.limit !== undefined ? { limit: Number(options.limit) } : {}) };
  }
  const isTeam = command === 'team' && args[0] === 'run';
  if (command !== 'run' && command !== 'plan' && !isTeam) throw new Error('Unknown command. Use --help.');
  const task = args.slice(command === 'plan' ? 0 : isTeam ? 2 : 1).join(' ').trim();
  if (!task) throw new Error('Provide a task.');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Run cancelled.'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const common = { root, task, approve: terminalApproval(controller.signal), signal: controller.signal, commandMode: options['sandbox-image'] ? 'docker' : 'host', sandboxImage: options['sandbox-image'], onEvent: e => { if (e.type === 'text') print(e.text); else if (['tool', 'step-start', 'finish'].includes(e.type)) print(`${e.step || ''} ${e.type}: ${e.name || e.status || ''}`); } };
  try {
    if (command === 'plan') {
      const { planTask } = await import('./planner.js');
      const result = await planTask({ ...common, demo: options.demo });
      print(JSON.stringify(result.workflow, null, 2));
      print(`Plan saved as ${result.name}. Review it, then use nexus team run with that name and your task.`);
    } else if (isTeam) {
      const result = await runWorkflow({ ...common, workflow: await loadWorkflow(root, args[1]), demo: options.demo, allowCommands: options['allow-commands'], isolated: options.isolated, concurrency: Number(options.concurrency || 2) });
      print(`Workflow ${result.id}: ${result.status}`);
    } else {
      const agent = await loadAgent(root, args[0]);
      agent.permissions.execute = agent.permissions.execute === true && options['allow-commands'] === true;
      const config = await loadConfig(root);
      const provider = await routeProvider(root, agent, { demo: options.demo, providerName: options.provider });
      const run = await runAgent({ ...common, root: options.worktree ? await resolveWorktree(root, options.worktree) : root, stateRoot: root, agent, provider, resume: options.resume, maxSteps: config.limits?.maxSteps || 20, maxContextChars: config.limits?.maxContextChars || 160000 });
      print(`Run ${run.id}: ${run.status}`);
    }
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
main().catch(e => { console.error(`NexusIDE: ${e.message}`); process.exitCode = 1; });
