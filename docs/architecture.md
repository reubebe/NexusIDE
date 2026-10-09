# NexusIDE implementation map

The supplied architecture diagram remains the product target. This document distinguishes implemented core features, adapters, and external prerequisites.

## Current build phase

NexusIDE is a working local prototype with a shared runtime, editor adapters and a self-contained macOS development app. Local model tool use, a small real-model coding workflow, selected editor-host demos, research evidence retrieval and a zero-key media render have verification evidence. Phases 1–4 now cover SQLite/incremental indexing, selected-provider compatibility, managed integration lifecycle and an ad-hoc bundled macOS build. These are bounded checks, not production certification. Developer ID distribution, broader cloud-provider validation and real-world workloads remain open. See [release phases](release-phases.md), the [workflow audit](audit-2026-10-08.md) and [evaluation](evaluation.md) for scope and evidence.

The user-facing setup steps are in the [User Guide](user-guide.md). The concrete adaptation decisions for the supplied repositories are in [Integration review](integrations.md) and [the machine-readable catalog](../integrations/catalog.json).

```mermaid
flowchart TD
  CLI[CLI and user PTY] --> Runtime[Shared agent runtime]
  Desktop[Native macOS shell] --> Dashboard[Local dashboard and file editor]
  Dashboard --> Runtime
  Editors[VS Code launcher and Zed tasks] --> CLI
  Planner[Model-assisted workflow planner] --> Workflows[Validated workflow DAG]
  Workflows --> Runtime
  Definitions[Agents and imported skills] --> Runtime
  Runtime --> Router[Named provider profiles and role routes]
  Router --> Models[Claude or compatible model endpoint]
  Runtime --> Grants[Permissions and action approvals]
  Grants --> Files[Files, search, Git and commands]
  Grants --> MCP[Stdio and HTTP MCP tools]
  Grants --> Apps[External applications]
  Files --> Worktrees[Git worktrees and workspace locks]
  Runtime --> State[History, memory, usage and encrypted vault]
```

## Status by diagram layer

| Layer | Working implementation | Boundaries |
|---|---|---|
| Interfaces | CLI; user PTY; self-contained macOS WebKit app with bundled Node, first-run project picker and shared dashboard; authenticated task activity, approvals, file editor and embedded PTY; ACP bridge | Chrome desktop/mobile/tablet and plan-to-run checks passed. Saved VS Code/Zed host checks cover demos. Relocated bundled startup, history and PTY passed, as did native first-run/task/terminal/discard checks. App/DMG is ad-hoc signed; Developer ID, notarization and clean-machine/platform release checks remain. |
| Agent runtime | Persistent definitions, explicit read/write/execute permissions, native JSON and foreign Markdown imports, skill resources and provenance, scoped memory | Imported vendor hooks and runtime-specific behavior are not emulated. |
| Orchestration | Model-assisted plan creation, role routing, sequential/parallel DAG stages, approval gates, structured report handoffs, bounded context, cancellation | Planner output must validate. Isolated stage worktrees exchange reports, not automatically merged files. No autonomous recursive delegation. |
| Tools and execution | File tools, bounded code search, protected Git diff/status, approved commands, user PTY, Docker command adapter, MCP transports, application profiles | Docker boundaries verified with a pinned local image in a synthetic workspace. Browser/database/codegraph capabilities depend on explicitly connected MCP services. |
| Model routing | Claude Messages, compatible Chat Completions, offline demo; named profiles by role; per-run override; bounded opt-in compatibility probes and saved evidence | Selected Ollama/OpenAI models passed live text, tool and structured-output checks; other targets remain fixture-only. Entire tool batches are validated before execution; limits, missing usage and errors are explicit. No universal compatibility claim. Routing uses user rules. See [provider matrix](providers.md). |
| Persistent state | SQLite WAL transactions for runs, workflows, notes and incremental semantic indexes; bounded history summaries and vector scans; JSON configuration/definitions/locks; encrypted vault; explicit interrupted-run recovery | One-time history migration retains legacy JSON; consistent database snapshots and integrity checks are available. Retrieval remains an exact vector scan with bounded top results, not an approximate-nearest-neighbor service. No replay of unfinished actions. See [storage](storage.md). |
| Workspace | Git worktree creation/list/diff, approved fast-forward merge, explicit branch names, per-workspace writer locks | Requires an existing committed repository. No automatic merge, branch deletion or dirty-worktree cleanup. |

## Integration progress

This workspace has development agents, research/trading/movie packs, selected imported Agency Agents and seven imported skills. Advanced connections include Research Harness, code graph, REA and Hyper-Extract; definitions and grants remain private local `.nexus` state, not bundled source. CLI-Anything is imported as an instruction skill for the non-executing planner. A bounded static scanner records skill findings; scan results and hashes are not a safety certificate.

Research Harness first passed a connection/read check, then a real-abstract evidence retrieval and local-model summary check. See `.nexus/verification/research-harness.json` and `research-evidence.json`. This does not validate an entire research study or its conclusions.

Other projects have compatibility assessments in [integrations.md](integrations.md). TradingAgents and OpenMontage have installed isolated runtimes, restricted launchers and explicit grants. Historical checks cover local-model market research with a structured-output failure requiring manual review, and a zero-key OpenMontage demo render. Cloud generation and reliable structured trading ratings are not validated. Managed installers now pin reviewed revisions, check origin/HEAD and preserve existing environments.

The [managed lifecycle](integration-lifecycle.md) additionally hashes tracked source at launch, stages upgrades in separate immutable-location folders, serializes operations/runs, journals grants and supports verified rollback, crash recovery and recoverable disablement. Source verification is not full dependency attestation or an OS sandbox. Existing real runtimes were checked read-only, not reinstalled.

## Validation

The Node tests use temporary directories and repositories, a real local MCP subprocess, an HTTP MCP fixture, loopback model servers, and the actual dashboard API. The automated suite makes no paid provider calls. Separate live checks on 2026-10-09 passed for Ollama `gpt-oss:20b` and OpenAI `gpt-4.1-mini-2025-04-14`; see [provider evidence](providers.md) for scope and request counts. A PTY process was launched successfully on macOS. The installed Ollama model also called `list_files` and `read_file` through the actual runtime and returned the synthetic fixture content; receipt: `.nexus/verification/local-model.json`. Chrome visual checks covered dashboard navigation, file draft protection and discard, an offline task, run history, approval decline, and cancellation; receipt: `.nexus/verification/dashboard-visual.json`.

After Ollama was reinstalled, `gpt-oss:20b` again completed the live synthetic tool-use check and `nomic-embed-text` passed semantic ranking and agent-scope checks on 2026-10-08. Docker live checks passed using an existing pinned PostgreSQL Alpine image: workspace reads/writes, read-only root, zero effective capabilities, no-new-privileges, no active external network or routes, and an outside file not mounted. Receipt: `.nexus/verification/docker.json`. These checks cover these boundaries, not every container attack. Security controls and residual risks are documented in [SECURITY.md](../SECURITY.md).

## Remaining work toward the full product

1. Extend live checks to selected Anthropic/Google models when configured, and manually check the VS Code dashboard-launch flow. VS Code's Run Agent command and Zed's ACP bridge have completed real host-level demo prompts with persisted history.
2. Extend live provider and container checks to real development tasks and additional supported models.
3. Validate browser services and connect real research projects. Semantic note retrieval and codebase-memory-mcp now have live synthetic checks; extend their scope beyond notes and source-only indexing.
4. Expand TradingAgents/OpenMontage beyond their existing smoke workflows after provider/data/media choices, cost limits and successful structured-output checks.
5. Benchmark larger real projects and consider approximate-nearest-neighbor retrieval if exact scans become too slow. SQLite storage and incremental note/code/document indexing complete the first storage phase; see [release phases](release-phases.md). Richer terminal emulation, Developer ID signing/notarization and clean-machine macOS testing remain. Stale writer locks can be inspected and cleared with `nexus recover` after the owning process is confirmed absent.

These remaining items are not represented as completed features.
