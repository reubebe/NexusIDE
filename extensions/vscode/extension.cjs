const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
function activate(context) {
  async function chooseFolder() {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
  }
  async function launch(command, args = [], selectedFolder) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before running NexusIDE.');
    const folder = selectedFolder || await chooseFolder();
    if (!folder) return;
    const settings = vscode.workspace.getConfiguration('nexuside');
    const cli = settings.get('cliPath');
    if (!cli || !path.isAbsolute(cli)) throw new Error('Set the NexusIDE CLI Path in user settings.');
    const terminal = vscode.window.createTerminal({ name: 'NexusIDE', cwd: folder.uri.fsPath, shellPath: settings.get('nodePath') || 'node', shellArgs: [cli, command, ...args] });
    terminal.show();
  }
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, async () => { try { await fn(); } catch (e) { vscode.window.showErrorMessage(e.message); } }));
  register('nexuside.init', () => launch('init'));
  register('nexuside.dashboard', () => launch('serve'));
  register('nexuside.runAgent', async () => {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace first.');
    const folder = await chooseFolder();
    if (!folder) return;
    const files = await fs.readdir(path.join(folder.uri.fsPath, '.nexus', 'agents'));
    const agent = await vscode.window.showQuickPick(files.filter(f => /^[a-z][a-z0-9-]*\.json$/.test(f)).map(f => f.slice(0, -5)), { placeHolder: 'Choose a NexusIDE agent' });
    if (!agent) return;
    const task = await vscode.window.showInputBox({ prompt: 'What should this agent do?', ignoreFocusOut: true });
    if (task?.trim()) await launch('run', [agent, task], folder);
  });
}
module.exports = { activate };
