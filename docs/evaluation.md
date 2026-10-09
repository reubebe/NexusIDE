# Build evaluation

This evaluation checks the supplied architecture against the local implementation. The full product is not complete. Passing automated tests is evidence for the exercised paths, not proof of complete functionality or security.

## Lifecycle and bundled desktop phases: 2026-10-09

The suite now passes 189 tests. Managed-integration fixtures exercise staged install/upgrade, cancellation/failure preservation, rollback, recoverable disablement, stale/live-owner recovery, tracked-source tamper detection and reversible grant journals. Existing TradingAgents/OpenMontage checkouts passed the stronger read-only source verification without reinstalling or running paid workflows.

The Apple Silicon app/DMG now includes Node and locked production JavaScript dependencies. A copied/moved bundle with minimal PATH passed native-owned bootstrap/shutdown, a bundled offline agent, SQLite history, authenticated dashboard and real PTY checks. Native UI checks covered the first-run project picker, default initialization, completed offline task, visible terminal command output, cancelling project selection without losing the session, and unsaved-edit protection on project switch/quit. Local evidence is in `bundled-desktop.json`, `integration-lifecycle.json` and `bundled-native-visual.json` under `.nexus/verification`.

This is an ad-hoc development distribution, not a Developer ID signed/notarized or clean-machine-certified release. External tools/models are separate, and integration source pins do not attest the entire dependency environment. See [integration lifecycle](integration-lifecycle.md) and [desktop distribution](desktop-distribution.md). Older notes below describe earlier builds and remain historical evidence.

## Provider phase: 2026-10-09

The suite now passes 164 tests, including adapter contracts, loopback runtime conversations, cancellation/timeouts, credential isolation, sanitized errors, usage accounting, and synthetic probe receipts. Selected live checks passed for Ollama `gpt-oss:20b` (five requests) and OpenAI `gpt-4.1-mini-2025-04-14` (four requests). Both returned text, observed lookup-tool values and the requested JSON object; OpenAI also emitted multiple calls in one reply. No project content was sent. Exact scope, options and untested targets are in [provider compatibility](providers.md). Anthropic and Gemini have no live validation yet. Earlier evidence below is preserved as historical, not expanded by these probes.

## Resumption: 2026-10-08

The earlier resumption suite passed 60 tests. The subsequent [comprehensive workflow audit](audit-2026-10-08.md) adds regression coverage and records current validation; the notes below also preserve historical evidence.

The starting suite passed all 51 tests. Dashboard source review found that saving followed by a fresh file read could overwrite a draft typed during the save, and selecting another file discarded unsaved edits. The editor now keeps the acknowledged saved snapshot separate from the draft, uses the write response's content hash for subsequent saves, blocks overlapping file requests and switching away from a dirty file, and offers explicit reload/discard. Closing the page with unsaved file edits uses the browser's unload warning. Regression tests cover in-flight edits, duplicate requests, conflicts, failed reloads and hash acknowledgements. Chrome visual interaction checks now cover the corrected editor states.

The Research Harness receipt is present and uses an older timestamp-valued `verified` field. Doctor now recognizes that specific successful historical receipt format; the previous audit's claim that the receipt was empty was incorrect. Historical receipts are still not live checks.

This directory now has Git history and a private `reubebe/NexusIDE` remote. Its name still ends with a space, and configured MCP paths depend on that exact location. No path migration was attempted during the audit. Local `.nexus` state, including imported agents and skills, is excluded by `.gitignore` and requires a separate private backup; pushing source does not back up that state.

The Chrome dashboard checks covered navigation, edits, approval decline, cancellation, offline tasks and history. Responsive checks cover 390×844 and 768×1024. The audit additionally exercised planning, stable team selection, approval and completion. After Ollama was reinstalled, `gpt-oss:20b` and `nomic-embed-text` passed live checks, repeated during this audit. Saved VS Code and Zed host receipts cover interactive demo prompts; broader editor workflows remain unverified.

## Verified in this build

| Requirement | Evidence | Scope |
| --- | --- | --- |
| Shared agent runtime | Node suite, including provider conversion, permissions, cancellation, workflow scheduling, ACP and dashboard file editing | Automated fixtures; not every provider or editor |
| Real model tool use | `.nexus/verification/local-model.json` | Installed Ollama `gpt-oss:20b` called `list_files` and `read_file` and returned the synthetic fixture content; no cloud calls |
| Semantic note retrieval | `.nexus/verification/semantic-memory.json` | Local `nomic-embed-text` generated 768-dimensional vectors, ranked the synthetic accessibility note first and excluded another agent’s note; dashboard authentication and scope covered by tests |
| Docker isolation | `.nexus/verification/docker.json` | Existing digest-pinned PostgreSQL Alpine image; writable mounted workspace, read-only root, zero effective capabilities, no-new-privileges, no active external network/routes, outside file absent |
| VS Code bridge | `.nexus/verification/vscode.json` | Actual VS Code 1.127.0 extension activation, command registration and CLI initialization in a terminal; isolated user settings and workspace |
| Code graph MCP | `.nexus/verification/codegraph.json` | Pinned codebase-memory-mcp v0.11.0: synthetic indexing, function search, caller tracing and index-root containment; read-only navigator profile configured; `.nexus/verification/codegraph-project.json` also verifies a query against the real `src/` index |
| macOS desktop shell | `.nexus/verification/desktop.json`, `native-visual.json`, and latest audit | Compilation, launch/authentication/shutdown, native visual navigation, discard/close protection and embedded terminal; not a standalone signed distribution |
| Browser dashboard | `.nexus/verification/dashboard-visual.json` | Chrome desktop layout, navigation, file draft protection, offline task, history, approval decline and cancellation |
| Imported skills | `nexus skills audit` and integrity regression tests | Seven installed packages match saved resources/instructions; scanner limitations and findings documented in integrations.md |
| Reviewed merges | `test/worktree-merge.test.js` | Fast-forward only, explicit approval, two workspace locks, revalidation, refusal of dirty/divergent/protected changes, no push |
| Crash record recovery | `test/recovery.test.js` | Explicit confirmation, absent local owner, unchanged record, preserved history; no tool replay |
| User instructions | `docs/user-guide.md` | Setup, local model, tasks, teams, skill audits, merges, recovery, MCP and hobby boundaries |

## Findings addressed

1. Skill imports accepted hard links and relied on size checks before unrestricted reads. Intake now rejects links, bounds descriptor reads and checks for mutation.
2. The scanner silently skipped binary/non-UTF-8 files and did not identify incomplete scans. Coverage now includes skipped resources, unvisited files and findings truncation.
3. Cached skill instructions could disagree with stored SKILL.md. Runtime loading now validates both the resource digest and cached instructions before a model call.
4. Worktree previews could include protected tracked file contents. They now use the protected Git diff implementation; tracked `.env` fixtures exercise this restriction.
5. Interrupted runs could remain marked running indefinitely. New records include host/process ownership and support explicit recovery without replay.
6. Reviewed worktree integration was missing. Clean committed text changes can now be merged with `nexus worktree merge NAME`; divergent histories and unsafe/unsupported content require manual review.

## Still required

- Responsive dashboard layouts and task planning passed Chrome checks; broader browser and assistive-technology coverage remains.
- Manual VS Code dashboard-launch flow. VS Code 1.127.0 completed the extension's Run Agent command through the real CLI with persisted demo history; Zed 1.23.2 launched the custom NexusIDE ACP process and completed a demo prompt with persisted history.
- Expand real domain workflows beyond the completed Research Harness evidence check, OpenMontage zero-key render, and TradingAgents local-model analysis. Provider-backed media generation and reliable structured ratings remain open.
- Broader code/document retrieval coverage. Native semantic note indexing and one code graph backend are implemented and live-verified within the documented scope.
- Developer ID signing/notarization and additional platforms. The packaged macOS app passed native visual workspace/navigation checks; its authenticated embedded PTY executed and displayed a local command, and the app bundle/DMG use a verified ad-hoc local signature.
- Broader live model checks, platform coverage and adversarial review of external dependencies.

Repeatable live-check scripts are `scripts/verify-local-model.js`, `scripts/verify-sandbox.js`, `scripts/verify-vscode.js`, `scripts/verify-semantic-memory.js`, and `scripts/verify-codegraph.js`. They use synthetic workspaces and store local receipts; inspect each receipt's scope and timestamp before making compatibility claims. The default `doctor` command does not itself perform live model or MCP calls.

During the earlier live check, Ollama 0.11.4 rejected EmbeddingGemma. Its [model requirements](https://ollama.com/library/embeddinggemma) specify Ollama 0.11.10 or later, so the saved project configuration uses `nomic-embed-text`. The reinstalled Ollama 0.40.1 service now has both configured models and passed fresh synthetic model/tool and semantic-memory checks on 2026-10-08. The project index contains zero notes until the user or an approved agent saves memories.
