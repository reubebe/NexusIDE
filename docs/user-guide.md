# NexusIDE User Guide

NexusIDE runs project agents from a terminal, local dashboard, VS Code terminal, or a Zed ACP connection. Agents use the same project configuration, tool approvals, memory, and run history in each interface.

## 1. Install and initialize a project

Use Node.js 22.18 or newer and Git. From the NexusIDE source directory:

```sh
npm install
npm start -- init
npm start -- packs install
npm start -- doctor
```

`init` creates `.nexus/` with starter agents and a development workflow. `packs install` adds research and hobby workflows without replacing existing files. Add `.nexus/` to the project's `.gitignore` because it contains local history and configuration.

For another project, run `npm link` once from the NexusIDE source directory, change to the intended project, and use `nexus init`, `nexus packs install`, and `nexus serve`. The `npm start -- ...` examples in this guide assume you are in the NexusIDE source directory.

Start with the offline walkthrough:

```sh
npm start -- run architect "Inspect this project and summarize its structure" --demo
npm start -- team run movie-studio "Plan a two-minute science-fiction short" --demo
```

Demo responses are scripted examples. They do not call an AI model or make project changes.

## 2. Open the dashboard

```sh
npm start -- serve
```

Open the full local URL printed in the terminal, including its login fragment. The dashboard is bound to `127.0.0.1`. Use it to review agents, runs, approvals, files, skills, memory, and provider settings. Stop the server with Ctrl+C.

## 3. Connect a model

For Anthropic, export a provider and API key in your shell:

```sh
export NEXUS_PROVIDER=anthropic
export NEXUS_MODEL='YOUR_MODEL_ID'
export ANTHROPIC_API_KEY='YOUR_API_KEY'
npm start -- run architect "Inspect this project and propose the next task"
```

The compatible Chat Completions option uses `NEXUS_PROVIDER=compatible`, `NEXUS_MODEL`, `NEXUS_API_KEY`, and optionally `NEXUS_BASE_URL`. For a local OpenAI-compatible service, set its local base URL and model identifier. NexusIDE does not read `.env` files automatically. See [provider profiles](../integrations/providers.example.json) for routing different agent roles to different providers.

This workspace now has a verified `local-ollama` profile using the already-installed `gpt-oss:20b` model. It is the default route here. With Ollama running, try `npm start -- run architect "Inspect the project structure"` without `--demo`. This configuration is local workspace state, so a fresh installation still needs its own provider setup.

Inspect saved compatibility evidence with `nexus providers`. To test your exact profile, run `nexus providers check NAME`; this sends only synthetic prompts and tool results, up to six requests, and may incur provider charges. It does not change your default route. Profiles can set `maxOutputTokens`, `timeoutMs`, and the compatible endpoint's `tokenLimitField`. See [provider compatibility](providers.md) for configuration, historical live results, credential isolation and untested targets.

## 4. Run an agent

```sh
npm start -- agents
npm start -- inspect architect
npm start -- run architect "Review the authentication design"
npm start -- status
```

Starter agent definitions are in `.nexus/agents/`. Each agent has instructions, permissions, and optional memory, skills, MCP servers, and applications. Edit the JSON through the dashboard or directly. Imported agents start read-only; agent instructions alone cannot grant tools.

To let an agent run approved commands, its configuration must enable execution and the run must also include the explicit flag:

```sh
npm start -- run tester "Run the unit tests and report failures" --allow-commands
```

Review each requested action when prompted. Host commands still run under your account. `nexus terminal` opens an interactive shell for you; that terminal is not a sandbox.

## 5. Run teams and review isolated changes

```sh
npm start -- team run development "Fix the failing parser tests"
npm start -- team status
npm start -- worktree list
npm start -- worktree diff TASK_NAME
```

Teams use dependency-ordered workflows. Use `--isolated` to give workflow steps separate Git worktrees; agents exchange reports, and their code changes are not automatically combined. Review each diff before bringing work into your branch. Worktrees require a Git repository with a committed starting revision.

To incorporate committed work, run `npm start -- worktree merge TASK_NAME`. NexusIDE shows the exact revisions, file list and diff for approval, then checks them again before fast-forwarding the current branch. It refuses dirty workspaces, divergent history, protected paths, links, binary changes and configured Git content filters. Commit the reviewed source changes yourself first; the merge command does not create commits, push, or delete worktrees.

`nexus plan "task description"` creates a reviewable workflow proposal. Inspect it and install/run only after you understand the agents and permissions it will use.

## 6. Import a third-party agent or skill

For Markdown agent instructions:

```sh
npm start -- import /path/to/agent.md
npm start -- agents
```

For a skill directory containing `SKILL.md`, scan it before importing:

```sh
npm start -- skills scan /path/to/skill-directory
npm start -- skills import /path/to/skill-directory
npm start -- skills list
npm start -- skills inspect SKILL_NAME
npm start -- skills audit SKILL_NAME
```

The scanner reports a small set of suspicious static patterns with file and line numbers. A clean scan is not a safety certification. Read the skill, supporting resources, source license, and provenance yourself. NexusIDE stores scripts but does not execute them during import. Assign a skill in an agent's `skills` list to make its instructions available to that agent. Tool names or `allowed-tools` text inside the skill do not grant runtime permissions.

Run `skills audit` without a name to check every installed package, or select **Audit skill** in the dashboard. Audits report skipped binary/non-UTF-8 resources and whether the findings cap left files unchecked. They do not modify imported packages. The runtime refuses packages whose resources no longer match the saved digest or whose cached instructions disagree with `SKILL.md`. This detects inconsistencies; a person who can modify local state can also replace its digest.

This workspace includes the optional `writing-editor` agent with the MIT-licensed `no-ai-slop` skill. Use it only when you want that editing approach:

```sh
npm start -- inspect writing-editor
npm start -- run writing-editor "Edit draft.md for clarity while preserving my voice"
```

It can read and propose edits to project files. Each file change still goes through NexusIDE's approval prompt. The skill and its evaluation file are preserved with commit and license provenance in `.nexus`.

## 7. Use research and hobby workflows

```sh
npm start -- team run research "Review the supplied paper and identify evidence gaps"
npm start -- team run trading-research "Compare these supplied strategy hypotheses"
npm start -- team run movie-studio "Create a production plan for a short film"
```

Research Harness and the included research skills support evidence-oriented work. Install a managed hobby runtime with `nexus integration install tradingagents` or `nexus integration install openmontage`, then connect it with `nexus integration configure NAME`. Check both with `nexus integration status`. External launches require `--allow-commands` and interactive approval. NexusIDE does not place trades; OpenMontage rendering remains subject to its own provider, media, cost, and licensing requirements.

Managed runtimes support `upgrade`, `rollback`, `recover`, `unconfigure`, and `uninstall`. Upgrades stage the reviewed pin without moving existing environments; uninstall disables while retaining files. Configuration and lifecycle changes require confirmation. See [integration lifecycle](integration-lifecycle.md) before changing grants or recovering a failed installation.

## 8. Configure MCP tools

Review [the example provider and MCP configuration](../integrations/providers.example.json), then import a project-specific JSON file:

```sh
npm start -- config import my-connections.json
npm start -- config show
```

MCP servers run only when assigned to an agent and approved. Keep the tool allowlist narrow. Each tool call still requires approval. Never assume that a remote tool server's description enforces filesystem or network boundaries.

## 9. Save and inspect memory

```sh
npm start -- memory add "Use Python for this project's numerical analysis"
npm start -- memory add "Prefer concise reviews" --agent reviewer
npm start -- memory search "Python"
npm start -- memory list --agent reviewer
npm start -- memory history MEMORY_ID
npm start -- memory update MEMORY_ID patch.json
npm start -- memory forget MEMORY_ID
```

Project and agent notes are local. They have L1 facts/decisions, L2 summaries, or L3 preferences, with revisions, expiry, and active/archived status. `memory search` defaults to hybrid retrieval with local keyword fallback; `--mode lexical` makes no embedding call. Agents with memory enabled can propose notes for approval. Their `memoryLoadout` chooses project notes, layers, and bounded context. See [memory management and selections](memory.md) for update-file examples, ownership, and limits.

For semantic search, run `ollama pull nomic-embed-text` and add an `embeddings` field to your existing project configuration (preserve the other settings):

```json
"embeddings": { "model": "nomic-embed-text", "url": "http://127.0.0.1:11434/api/embed" }
```

Then run `npm start -- memory index` and `npm start -- memory semantic "your question"`. Add `--agent reviewer` to include that agent's notes. The dashboard provides update and search buttons. Indexing sends note text only to the configured local embedding endpoint. Update after adding or changing notes or switching models; unchanged text reuses its vectors. Changed/deleted notes are excluded from retrieval immediately. SQLite removes the previous 1,000-note/18-MB JSON ceiling; each vector has at most 8,192 dimensions and each index has a 512-MiB vector budget. Use `memory index --force` for a full embedding refresh. Code/document indexing uses the separate `project index` command.

Agents with memory enabled and embeddings configured can request hybrid retrieval through an approval prompt. Automatic startup context uses local keywords plus up to two recent selected summaries/preferences. Stored vectors, notes, revisions, and drafts are sensitive data in `.nexus/storage.sqlite`; legacy JSON copies may remain in `.nexus/indexes` and `.nexus/memory`. See [migration and backups](storage.md).

To distill a completed run, use `npm start -- memory distill RUN_ID --demo` offline, or `--provider PROFILE_NAME` for an explicit provider transmission approval. Review the evidence with `memory drafts`, then run `memory review DRAFT_ID CANDIDATE_ID approve --revision N` (or `reject`). Every candidate needs its own decision; L3 preferences must quote the original user. See [distillation boundaries](memory.md#reviewable-distillation).

## 10. Troubleshooting and security

```sh
npm start -- doctor
npm start -- status RUN_ID
npm start -- recover
npm start -- recover activity
```

`doctor` checks local setup. `status` shows run details. `recover` lists workspace locks; removing a stale lock requires a unique key prefix and interactive confirmation. Review [security boundaries](../SECURITY.md) before granting command, MCP, or application access. NexusIDE is a local prototype, not a hardened multi-user service.

For an unfinished run whose recorded process has exited, use `npm start -- recover run RUN_ID` (or `recover workflow WORKFLOW_ID`). After approval, its status becomes `interrupted` and its history is retained. Nothing is rerun. Continue deliberately with a new task or `run AGENT "Continuation task" --resume RUN_ID`. Records predating process ownership tracking remain unchanged; recover their stale locks separately if necessary.

## Current limits

The VS Code extension passed activation, terminal initialization and Run Agent checks inside VS Code 1.127.0 with persisted demo history. Zed 1.23.2 launched the NexusIDE ACP process and completed a demo prompt with persisted history. Docker is optional; its configured restrictions have now passed a live synthetic check on this machine. Selected Ollama and OpenAI models have passed synthetic text, tool-round-trip and structured-output checks. Other models, MCP servers, browser automation, trading runtime, and video tooling require separate setup and validation. See [architecture status](architecture.md), [provider compatibility](providers.md), and [integration review](integrations.md) for what has actually been exercised.

## Codebase navigation

The local `codebase-navigator` agent uses the installed codebase-memory-mcp backend to find functions and trace callers, then checks original source. It has read-only query grants. See [code graph setup and index refresh](codegraph.md) for its source-only scope, commands and verification.

For retrieval across code and documentation, run `nexus project index --mode lexical`, followed by `nexus project search "your question"`. With local embeddings configured, `project index` also builds vectors; `project semantic` requires them. The index excludes protected paths, links, binaries and oversized files, uses bounded storage, and filters changed or deleted source from results until the next rebuild.

## Health and verification history

Run `npm start -- doctor` to inspect configured connections, missing skill references, Docker availability and local verification receipts. `verificationHistory` records past checks, their timestamps and scope; it does not imply that today’s configuration was retested. The command makes no model API calls and starts no external MCP services.

## Desktop window

On macOS, run `npm run desktop:build` followed by `npm run desktop`. For another initialized project, use `nexus desktop` after linking the CLI. Closing the window cancels active jobs. See [desktop setup](desktop.md) for requirements, verification and distribution limits.

For Finder launch, build with `npm run desktop:package`, open `dist/NexusIDE.app`, and choose your project. Node and the core runtime are included. Existing `.nexus` state is kept, and missing defaults are initialized without model calls. Use **File → Open Project…** to switch projects. This remains an ad-hoc development build, not a notarized public release; see [distribution details](desktop-distribution.md).
