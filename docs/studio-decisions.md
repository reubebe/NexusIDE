# Studio and shared account decisions

Decision date: 2026-11-05. Input: the user-supplied `NexusIDE_Codex_Guide.md`, updated 2026-11-03. This is a critical assessment and staged plan, not an assertion that the guide's proposed workspaces exist. The guide's upstream version, license and benchmark claims are not automatically accepted as current evidence.

## Decision for this release

Finish the already-started motion, subscription and budget slice in 0.3.1. Preserve the existing runtime, state, vault, provider picker, approvals and native host. Do not delay these working improvements to install or audit every proposed editor. The guide explicitly permits a smaller tested slice; its recommendation to postpone all motion until an image/video suite exists would discard useful work already in progress, so that sequence is not adopted.

No new dependency, external application, model weight, proxy, credential store, task database or orchestrator is introduced. Original adapter code invokes separately installed tools. No source or assets from the newly proposed repositories are redistributed. ManimGL remains experimental and optional. No generic engine framework is justified for two narrow operations.

## Current capability gaps

| Area | State | Evidence / remaining gap |
| --- | --- | --- |
| Charts, graphs, images, spatial views | Existing | `src/artifacts.js`, `src/visual-spec.js`, `ui/visualizations.js`; no image editing engine. |
| Media preview and comparison | Partial, implemented | `src/media-workflow.js`, `src/motion.js`, `ui/motion.js`; real FFmpeg output, source preservation and receipts; no general timeline editor. |
| Animation rendering | Experimental external adapter | Fixed ManimGL invocation with approval, cancellation and output checks; fixture renderer tested, actual ManimGL absent. |
| Unified Studio assets/revisions and image editor | Proposed | Current artifacts and receipts provide a starting point; no full image/history/project model or six-workspace shell. |
| API accounts and route precedence | Existing | `src/config.js`, `src/provider-catalog.js`, `src/vault.js`, `ui/provider-picker.js`; numbered accounts, explicit model route, agent pins. |
| Official CLI accounts | Existing | `src/cli-accounts.js`; separate supported CLI state, no token copying. Meta Muse uses shared sign-in. |
| Claude subscription inference in Tasks | Experimental, implemented | `src/subscription-provider.js`; official CLI boundary, identity binding, tools disabled, explicit route. Synthetic tests only, no live quota/completion evidence. |
| Request/token/time controls | Partial, implemented | `src/run-budget.js`, shared workflow counters/deadline; usage can arrive after expenditure. No account-wide dollar ceiling or vendor quota feed. |
| Quotas, failover and local aggregation proxy | Absent / deferred | Unsupported quota remains unknown. No hidden account rotation or paid fallback. |
| Skills, source retrieval and evidence | Existing / partial | `src/skills.js`, deep scanner, local project retrieval and Research Harness adapters; no governed public crawler or source-to-skill publishing pipeline. |
| Workbench and ACP | Existing / partial | File editor, terminal, code map, worktrees and `src/acp.js`; no LSP/DAP replacement or external CodeG/OpenIDEA compatibility claim. Nexus executes its own granted tools. |
| Assurance and coordination | Existing / partial | Runtime approval events, independent review, workflow records/checkpoints/locks; no authenticated human-only task board or complete immutable policy trace. |
| Foreign session import/handoff | Proposed | Native history/team handoffs exist. No external transcript scanning or cross-vendor native resume. |

## Ranked follow-on decisions

| Rank | References / track | Decision and smallest acceptance gate |
| --- | --- | --- |
| 1 | CC Switch / shared accounts | Learn from account inventory and status clarity. Keep Nexus's existing router. Next: selected-route preview and observed identity/check timestamp. Reject subscription-token replay, automatic CLI config ownership and unapproved failover. |
| 2 | PhotoCraft / Image Studio | Evaluate one pinned installed CLI operation on a synthetic raster: preview, reversible crop/adjustment, derivative and source/output hashes. Adopt only after actual output/format tests. No install or fidelity claim in this release. |
| 3 | iFixAi / Agent Assurance | First strengthen native event evidence and add a deterministic read-only missing-approval auditor with an injected-defect fixture. Defer third-party judges and automatic policy repair. |
| 4 | RESOURCE2SKILL / Skill Foundry | Draft one candidate skill from an authorized local source; reuse current scanning, provenance and assignment. Compare with a manual baseline. Executable QA requires genuine isolation. No automatic publishing or imported runtime. |
| 5 | OpenIDEA / workbench | One keyboard navigation improvement or a disposable ACP compatibility probe. Reuse current file editor and ACP agent. No Tauri/Rust/LSP rebuild without a demonstrated gap. |
| 6 | Kanzo + Paperclip / task coordination | Project existing workflow records into a read-only board first. Claims, human-only policy and writes need server authorization tests before introduction. Do not copy Kanzo code or assume its license/trust model fits Nexus. Existing team persistence and new shared budgets cover part of the need. |
| 7 | CodeG / sessions | One explicitly selected, read-only transcript import and reviewed context handoff after privacy/authority tests. No home-directory sweep, foreign native-session resume, infinite canvas or remote access. |
| 8 | Scrapling / Web Sources | Only if an approved workflow cannot use current connectors. One bounded static page, URL/DNS/redirect/robots policy and provenance. No stealth, bypass or automated corpus collection. |
| 9 | FilmCraft + VideoCraft / video | Compare a pinned engine against current FFmpeg/OpenMontage workflows before adding it. Require real trim/export timing, cancellation and codec tests. No Windows app dependency on macOS. |
| 10 | EffectCraft, Animate, Anidoodle / motion | Compare only after a concrete scene/keyframe need exceeds current ManimGL/comparison adapter. Avoid a second redundant renderer. |
| 11 | LightCraft / photography | Defer until RAW/camera/color fixtures and a tested engine are available. No fidelity claim from README features. |
| 12 | PdfCraft / documents | Start with read/rotate/comment on test files if prioritized. Redaction permanence and signature validity require independent structural checks. |
| 13 | DesignCraft / publishing | Defer until a real layout/export task and fonts permit fidelity tests. No empty Design tab. |
| Conditional | OpenShell / OpenSandbox | Evaluate one optional backend only when current Docker isolation fails a concrete requirement. Worktrees and host subprocesses are not sandboxes. |
| Deferred | Unity MCP, SUPRA-Tex, Edge-Drop | No baseline dependency. GPU/model-license, OS clipboard/privacy and actual user workflow requirements remain unproven. |
| Retain bounded adaptation | NullMotion, ManimGL, BLA, OpenDevin fork | Comparison review and optional scene export fit now. BLA-style adversarial cases inform bounded failure tests; obfuscation/decoys do not belong in this app. The referenced OpenDevin fork is not a subscription authorization mechanism. |

## Source checks and limits

This session checked the following primary pages. They are moving references, not adopted pinned dependencies. No new upstream binary was installed or executed. A full source/license/security audit of all guide repositories is deferred until a specific adapter is selected.

- [CC Switch README](https://github.com/farion1231/cc-switch): account/routing UX is relevant, but upstream itself cautions about subscriptions outside official clients. Its proxy/failover behavior is not adopted.
- [PhotoCraft README and CLI examples](https://github.com/storytold/photocraft): a CLI/MCP entry point is documented. This warrants an optional engine test, not an assertion of PSD/color fidelity or verified macOS compatibility here.
- [RESOURCE2SKILL repository](https://github.com/microsoft/RESOURCE2SKILL): multimodal skill distillation and domain executors are relevant; installing that runtime would duplicate existing Nexus responsibilities. No generated-skill quality benchmark was performed.
- [CodeG host-tool policy source](https://github.com/spacering-net/codeg/blob/main/src-tauri/src/acp/host_tools_policy.rs): host-serviced filesystem/terminal calls can execute outside the external agent's sandbox. Any future ACP-host feature must enforce permissions where I/O actually occurs, deny alternate terminal/delegation escapes, and reject unknown policy. Current Nexus is an ACP agent, not a newly added external-agent host.

The remaining repository assessments above are design decisions based on the supplied brief and current Nexus gaps, not independently verified upstream runtime audits. Broader Studio acceptance tests, external interoperability, supported quota probes, live model quality, hostile-media isolation and clean-machine distribution remain separate gates. See [release validation](release-0.3.1.md) and [user guide](user-guide.md) for what can actually be used now.
