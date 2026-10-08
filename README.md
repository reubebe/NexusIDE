# NexusIDE

**One runtime. Any agent. Any model.**

A local agent development workspace for software, scientific research, trading research, and movie-making. A shared Node.js runtime powers the terminal CLI and authenticated web dashboard. The current version is a working local prototype; see [implementation status](docs/architecture.md) for the exact boundaries.

New users: start with the step-by-step [NexusIDE User Guide](docs/user-guide.md).

## Start

Requires Node.js 22+ and npm. Git is needed for worktrees. The PTY dependency may need platform build tools when a prebuilt binary is unavailable.

```sh
npm install
npm start -- init
npm start -- packs install
npm start -- serve
```

Open the **complete URL printed by the server**, including its login fragment. The dashboard binds to `127.0.0.1`; each launch creates a new access token. It supports tasks, teams, approvals, project file editing, agent configuration, memory, skills, run history, and provider settings.

Try without credentials:

```sh
npm start -- run architect "Inspect this project" --demo
npm start -- team run movie-studio "Plan a two-minute science-fiction short" --demo
npm start -- doctor
```

The offline demo is scripted and exercises orchestration and file tools. It does not generate AI answers. Disable “Offline demo” in the dashboard after configuring a provider.

Run `npm link` if you want a `nexus` command available from other project directories. Each directory has its own `.nexus` configuration, agents, notes and history. Add `.nexus/` to that project's `.gitignore`.

## Models and connections

Configure using shell environment variables:

```sh
export NEXUS_PROVIDER=anthropic
export NEXUS_MODEL='YOUR_MODEL_ID'
export ANTHROPIC_API_KEY='YOUR_API_KEY'
npm start -- run architect "Inspect the project and propose a plan"
```

For a compatible Chat Completions service, set `NEXUS_PROVIDER=compatible`, `NEXUS_MODEL`, `NEXUS_API_KEY`, and `NEXUS_BASE_URL` (defaults to `https://api.openai.com/v1`). Local Ollama typically uses `http://localhost:11434/v1`; select an installed tool-capable model and unset unrelated key variables. NexusIDE does not automatically read `.env` files.

For different models by role, edit [the example configuration](integrations/providers.example.json), then import your file:

```sh
nexus config import my-connections.json
nexus run architect "Plan this change" --provider claude
```

Provider profiles reference `keyEnv` or `keySecret`, never plaintext API keys. Routes map agent names to profiles, with an optional default route. If configured, input/output prices per million tokens produce **estimates**, not provider billing totals. Actual model identifiers, credentials, pricing and service compatibility belong to your provider.

MCP connections support stdio and streamable HTTP. A server is contacted only if assigned in the agent's `mcp` list and approved by you. Its configured `tools` array is an explicit allowlist; an empty list exposes no tools. Every tool call requires approval, regardless of server annotations. See [integration review](docs/integrations.md).

## Agents and skills

`init` adds architect, coder, reviewer, researcher, tester and security-reviewer roles without overwriting existing definitions. `packs install` adds research, trading-research and movie-studio teams. Edit agents through the dashboard or `.nexus/agents/*.json`.

```sh
nexus install examples/scientific-reviewer.json
nexus import /path/to/foreign-agent.md
nexus skills scan /path/to/skill-directory
nexus skills import /path/to/skill-directory
nexus skills list
nexus skills audit
nexus inspect scientific-reviewer
```

Native JSON agents have explicit permissions. Foreign Markdown agent imports preserve instructions and record compatibility/provenance, with read-only permissions initially. Skill imports preserve SKILL.md and supporting resources, reject links, hash the package, and never run scripts or installers. `nexus skills scan` reports static indicators and coverage before import; `nexus skills audit [name]` checks stored integrity and rescans installed packages. The dashboard also offers an Audit skill button. Neither a clean scan nor a matching digest certifies safety or publisher identity. Assign imported names in an agent's `skills` array. A skill's `allowed-tools` field grants no permissions.

Selected Agency Agents and scientific/security/diagram/writing skills are already imported in this workspace; [the integration review](docs/integrations.md) records their source commits and limitations. Use `writing-editor` to opt into the imported writing skill. Imports stored in `.nexus` are local state, not bundled into the source distribution.

## Tools and terminal

```sh
nexus install examples/terminal-coder.json
nexus run terminal-coder "Inspect the code and run relevant checks" --allow-commands
nexus terminal
```

Agent commands require `permissions.execute: true`, the run option, and action approval. The command executor uses executable/argument arrays, a 60-second timeout, 100 KB combined output cap, and cancellation. It does not interpolate shell strings. An explicitly approved shell or interpreter can still execute arbitrary code.

`nexus terminal` is a user-operated PTY shell. Its commands run directly under your account; it is not an agent sandbox and its output is not silently fed to a model.

For Docker execution, add `--sandbox-image repository@sha256:DIGEST` to an agent run. The image must already exist locally. Network is disabled, root filesystem is read-only, capabilities are dropped, and CPU, memory and process counts are bounded. The workspace is writable. Keep credentials and `.nexus` outside a sandbox workspace by using a separate worktree. Docker is required; there is no fallback to host execution when Docker fails.

## Worktrees and teams

From a Git repository root with a committed HEAD:

```sh
nexus worktree create my-task
nexus run coder "Implement the requested change" --worktree my-task
nexus worktree diff my-task
nexus worktree list
nexus team run development "Implement the requested feature"
```

Worktrees start from committed HEAD; local uncommitted files are not copied. Agent definitions and logs stay in the original project. `nexus worktree diff` shows tracked edits and bounded previews of new text files; protected and binary files are omitted. Write-capable runs acquire a workspace lock. Read-only workflow stages may run concurrently; writes in a shared workspace serialize.

After reviewing and committing the intended worktree changes, use `nexus worktree merge NAME` for an explicitly approved fast-forward merge. Both workspaces must be clean; source/destination revisions are checked again after approval. Protected paths, links, binary changes, configured Git content filters and divergent histories require manual handling. The command retains the worktree and does not push.

Custom teams are JSON DAGs with `id`, `agent`, `task`, optional `dependsOn`, and optional `approval` on each step. Use `nexus team install team.json`. `--isolated` creates separate step worktrees; upstream **reports** are handed off, but changes are not automatically merged. Use shared sequential stages when later steps must work on earlier edits. Worktrees remain for review after success, failure or cancellation.

## Research and hobbies

- `research`: literature researcher → statistical reviewer → manuscript reviewer.
- `trading-research`: market researcher → strategy analyst → risk reviewer.
- `movie-studio`: story developer → production planner → film editor.

The teams work with supplied content and their assigned tools. [Hobby application profiles](integrations/hobbies.example.json) connect separately installed TradingAgents and OpenMontage runtimes. Merge the profiles you need into your project configuration, set actual paths, assign the application name in the agent's `applications` array, and enable execution. Each application run shows the command, directory, credential-variable names and timeout for approval. No broker/order-placement API is built into NexusIDE.

## Memory, history and credentials

```sh
nexus memory add "Use Python for numerical analysis"
nexus memory add "Prefer concise reviews" --agent reviewer
nexus memory search "analysis"
nexus memory forget MEMORY_ID
nexus project index
nexus project semantic "where is accessibility handled?"
nexus status
nexus recover
nexus recover activity
nexus status RUN_ID
nexus run architect "Continue with this refinement" --resume RUN_ID
```

Memory is project-scoped or agent-scoped and searched lexically. Agents with `memory: true` receive relevant notes and can propose new notes for approval. Optional semantic note retrieval uses a configured local Ollama embedding model. Run `nexus memory index` to rebuild and `nexus memory semantic "query"` to search; see the [user guide](docs/user-guide.md#9-save-and-inspect-memory). Continuations carry prior conversation prose into a new run; unfinished tool calls are not replayed. Default limits are 20 model steps and 160,000 serialized context characters.

Project retrieval is separate from agent memory. `nexus project index` embeds bounded chunks from supported source and documentation files while excluding protected directories, links, binary files, files over 100 KB, and more than 5 MB or 500 files per build. `nexus project semantic` returns ranked paths and bounded excerpts. Rebuild after source changes; the local JSON index is intentionally capped for prototype-scale projects.

If a crash leaves a workspace lock, `nexus recover` lists lock keys and whether the recorded process is present. `nexus recover <key-prefix>` asks for confirmation before removing a unique stale lock. Inspect the process and workspace before approving; run history and workspace changes remain available afterward.

New runs and workflows record their owning process and host. `nexus recover activity` lists unfinished records; `nexus recover run ID` or `nexus recover workflow ID` marks one as interrupted only after confirmation and a recheck that its process is absent on this host. Legacy records without ownership and records from another host are not changed. Recovery does not replay tools or remove writer locks.

For optional encrypted secrets, set `NEXUS_VAULT_PASSWORD` (at least 12 characters) and `NEXUS_SECRET_VALUE` in your shell, run `nexus secret set NAME`, then unset the value variable. Reference `keySecret: "NAME"` in a provider profile. The vault uses scrypt and AES-256-GCM; losing its password loses access. `nexus secret list` returns names only. Known credentials are redacted from new run logs, but redaction cannot identify every possible secret in source files or provider output.

## Editors

The [VS Code extension](extensions/vscode) launches the same CLI in an integrated terminal and requires workspace trust. Set its `nexuside.cliPath` user setting to this installation's absolute `src/cli.js` path. Its activation, command registration and real CLI initialization were verified inside VS Code 1.127.0 using an isolated test workspace. Interactive agent selection and dashboard launch still need user-flow checks.

[Zed tasks](integrations/zed/tasks.json) launch the CLI/dashboard/terminal after `npm link`. Add these task entries to your project's existing `.zed/tasks.json`; preserve existing entries. NexusIDE also provides a native Agent Client Protocol (ACP) bridge: configure the absolute Node and `src/cli.js` paths from [the Zed agent settings example](integrations/zed/agent-settings.json) in Zed's `settings.json`. The bridge exposes project agents as selectable modes and uses NexusIDE's shared runtime and approvals. It is protocol-tested, but has not yet been exercised inside Zed itself. Editor-provided MCP servers and extra-directory grants are deliberately not accepted; configure approved NexusIDE MCP access in the project.

## Verify and understand the boundaries

```sh
npm test
npm audit --omit=dev
npm start -- doctor
```

Tests exercise provider conversion, approvals, cancellation, file restrictions, import fidelity, memory scope, workspace locks, real local MCP protocol exchange, HTTP authentication/origin checks, vault encryption, and workflow scheduling. Provider tests use mocks; no paid model API calls are made. [Security boundaries](SECURITY.md) and [architecture status](docs/architecture.md) identify what remains unverified.

### Code graph navigator

The local build includes `codebase-navigator`, backed by the reviewed codebase-memory-mcp v0.11.0 release. It can search symbols and trace callers through approved read-only MCP calls, then verify claims against source. See [setup, scope and index refresh](docs/codegraph.md).

### Native macOS shell

Run `npm run desktop:build`, then `npm run desktop` to open the dashboard in a native window. It uses the same runtime and approvals. See [desktop setup and current limits](docs/desktop.md).

Run `npm run desktop:package` to create an ad-hoc signed `NexusIDE.app` and compressed DMG for local installation. Public distribution still requires an Apple Developer identity and notarization.
