# Build evaluation

This evaluation checks the supplied architecture against the local implementation. The full product is not complete. Passing automated tests is evidence for the exercised paths, not proof of complete functionality or security.

## Resumption: 2026-10-08

Validation after these changes: `npm test` passes all 54 tests with no skips or failures; changed JavaScript files pass syntax checks.

The starting suite passed all 51 tests. Dashboard source review found that saving followed by a fresh file read could overwrite a draft typed during the save, and selecting another file discarded unsaved edits. The editor now keeps the acknowledged saved snapshot separate from the draft, uses the write response's content hash for subsequent saves, blocks overlapping file requests and switching away from a dirty file, and offers explicit reload/discard. Closing the page with unsaved file edits uses the browser's unload warning. Regression tests cover in-flight edits, duplicate requests, conflicts, failed reloads and hash acknowledgements. Chrome visual interaction checks now cover the corrected editor states.

The Research Harness receipt is present and uses an older timestamp-valued `verified` field. Doctor now recognizes that specific successful historical receipt format; the previous audit's claim that the receipt was empty was incorrect. Historical receipts are still not live checks.

This directory has no `.git` history. Its name ends with a space and configured MCP paths depend on that exact absolute location. Establish version control and migrate those paths deliberately before relocating the workspace. Local `.nexus` state, including imported agents and skills, is excluded by `.gitignore` and needs a separate private backup.

The Chrome dashboard check covered desktop navigation, file edits, approval decline, cancellation, an offline task and run history. Task planning and responsive viewport checks remain. The configured local provider currently returns HTTP 404 because the reachable Ollama service reports no installed models; restore that model service before a real development task. Zed host checks and interactive VS Code flows remain open.

## Verified in this build

| Requirement | Evidence | Scope |
| --- | --- | --- |
| Shared agent runtime | Node suite, including provider conversion, permissions, cancellation, workflow scheduling, ACP and dashboard file editing | Automated fixtures; not every provider or editor |
| Real model tool use | `.nexus/verification/local-model.json` | Installed Ollama `gpt-oss:20b` called `list_files` and `read_file` and returned the synthetic fixture content; no cloud calls |
| Semantic note retrieval | `.nexus/verification/semantic-memory.json` | Local `nomic-embed-text` generated 768-dimensional vectors, ranked the synthetic accessibility note first and excluded another agent’s note; dashboard authentication and scope covered by tests |
| Docker isolation | `.nexus/verification/docker.json` | Existing digest-pinned PostgreSQL Alpine image; writable mounted workspace, read-only root, zero effective capabilities, no-new-privileges, no active external network/routes, outside file absent |
| VS Code bridge | `.nexus/verification/vscode.json` | Actual VS Code 1.127.0 extension activation, command registration and CLI initialization in a terminal; isolated user settings and workspace |
| Code graph MCP | `.nexus/verification/codegraph.json` | Pinned codebase-memory-mcp v0.11.0: synthetic indexing, function search, caller tracing and index-root containment; read-only navigator profile configured; `.nexus/verification/codegraph-project.json` also verifies a query against the real `src/` index |
| macOS desktop shell | `.nexus/verification/desktop.json` | Native compilation, URL checks, process launch, HTTP authentication and shutdown; visual interaction unverified |
| Browser dashboard | `.nexus/verification/dashboard-visual.json` | Chrome desktop layout, navigation, file draft protection, offline task, history, approval decline and cancellation |
| Imported skills | `nexus skills audit` and integrity regression tests | Six installed packages match saved resources/instructions; scanner limitations and findings documented in integrations.md |
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

- Responsive dashboard layouts and task planning remain to be exercised; desktop Chrome interaction passed.
- Zed host validation and interactive VS Code run-agent/dashboard flows.
- Complete real research and movie/trading workflows with selected external runtimes and data. Installed instruction packs alone do not prove these integrations.
- Broader code/document retrieval coverage. Native semantic note indexing and one code graph backend are implemented and live-verified within the documented scope.
- Desktop visual validation, embedded terminal, standalone distribution packaging, signing and additional platforms. The macOS source-built shell is implemented.
- Broader live model checks, platform coverage and adversarial review of external dependencies.

Repeatable live-check scripts are `scripts/verify-local-model.js`, `scripts/verify-sandbox.js`, `scripts/verify-vscode.js`, `scripts/verify-semantic-memory.js`, and `scripts/verify-codegraph.js`. They use synthetic workspaces and store local receipts; inspect each receipt's scope and timestamp before making compatibility claims. The default `doctor` command does not itself perform live model or MCP calls.

During the earlier live check, Ollama 0.11.4 rejected EmbeddingGemma. Its [model requirements](https://ollama.com/library/embeddinggemma) specify Ollama 0.11.10 or later, so the saved project configuration uses `nomic-embed-text`. The Ollama service reachable during the 2026-10-08 visual check reported no installed models; the historical receipt does not prove the current service is ready. The project index contains zero notes until the user or an approved agent saves memories.
