const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const execFile = require('node:util').promisify(require('node:child_process').execFile);

exports.run = async () => {
  const report = { verified: false, vscode: vscode.version };
  try {
    const extension = vscode.extensions.getExtension('nexuside-local.nexuside-bridge');
    assert.ok(extension, 'Extension must be present in the development host.');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['nexuside.init', 'nexuside.runAgent', 'nexuside.dashboard']) assert.ok(commands.includes(command), command);
    assert.equal(vscode.workspace.isTrusted, true, 'Synthetic test workspace must be trusted.');
    await vscode.commands.executeCommand('nexuside.init');
    const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const file = path.join(workspace, '.nexus', 'agents', 'architect.json');
    let agent;
    for (let i = 0; i < 100; i++) {
      try { agent = JSON.parse(await fs.readFile(file, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(agent?.name, 'architect', 'Initialize command must run the real CLI in the terminal.');
    await vscode.commands.executeCommand('nexuside.runAgent', { agent: 'architect', task: 'Reply with the synthetic VS Code host verification.', demo: true });
    const settings = vscode.workspace.getConfiguration('nexuside');
    const stateModule = pathToFileURL(path.join(path.dirname(settings.get('cliPath')), 'state.js')).href;
    const readRuns = `const {recentState}=await import(process.argv[1]); console.log(JSON.stringify(await recentState(process.argv[2], 'runs', 10)));`;
    let completed;
    for (let i = 0; i < 200; i++) {
      try {
        const { stdout } = await execFile(settings.get('nodePath') || 'node', ['--input-type=module', '-e', readRuns, stateModule, workspace], { timeout: 10000, maxBuffer: 2000000 });
        for (const run of JSON.parse(stdout)) {
          if (run.status === 'completed' && run.messages?.some(message => message.content?.includes('synthetic VS Code host verification'))) completed = run;
        }
        if (completed) break;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(completed, 'Run Agent command must complete a real CLI demo run.');
    report.verified = true;
    report.checks = ['extension-activation', 'commands-registered', 'trusted-workspace-initialization', 'real-cli-terminal-launch', 'interactive-run-agent-command', 'persisted-run-history'];
  } catch (error) { report.error = error.message; throw error; }
  finally {
    for (const terminal of vscode.window.terminals) terminal.dispose();
    await fs.writeFile(process.env.NEXUS_VERIFY_RESULT, JSON.stringify(report));
  }
};
