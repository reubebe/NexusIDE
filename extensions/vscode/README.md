# NexusIDE VS Code launcher

Open this folder in VS Code and press F5 to launch an Extension Development Host. Set `nexuside.cliPath` in **user settings** to the absolute path of NexusIDE's `src/cli.js`, and `nexuside.nodePath` to a Node.js 22.18+ executable if `node` is not on PATH.

Commands: **NexusIDE: Initialize Project**, **NexusIDE: Run Agent**, and **NexusIDE: Start Dashboard**. The workspace must be trusted. Commands launch Node with an argument array in the integrated terminal; user tasks are not interpolated into a shell command.

This extension is a thin launcher for the same runtime. Activation, command registration and real CLI terminal initialization passed in VS Code 1.127.0 with a synthetic trusted workspace. Interactive agent selection and dashboard launch still need user-flow verification. Repeat the host check from the source root with `node scripts/verify-vscode.js`; it uses temporary settings and does not change your normal profile. For multiple workspace folders, use the intended folder as the primary folder when selecting an agent.
