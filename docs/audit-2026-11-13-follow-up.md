# Core validation follow-up, 2026-11-13

This continues the [November 12 audit](audit-2026-11-12.md) from `bcddb1c`; it does not replace its baseline or turn its unperformed checks into passes. The original video-file changes remain untouched. No dependency, model, optional runtime or paid inference was added.

## Execution boundaries corrected

Direct calls below the main runtime accepted truthy approval values. A disposable reproduction wrote a file when its callback returned the string `"false"`. The runtime's wrapper already required `true`, and the authenticated dashboard already validated its approval JSON, so this was an inconsistency in exported execution boundaries, not evidence of an unauthenticated remote exploit.

File/command/board/visualization tools, external applications, MCP connection and calls, workflow gates and resume, independent review, worktree merges, stale-lock removal, recovery, Studio/media and experiment adoption now require literal boolean `true`. Direct tool/application grants also reject malformed non-boolean permissions. Existing approval UI and credentials remain unchanged.

Eight new regression tests cover denied file/process side effects, malformed tool grants, application spawning, actual loopback MCP request counts, workflow continuation, recovery/Studio state, parent-directory symlink replacement and optimistic edit checks. A simulated model following injected source instructions cannot gain write/command/memory privileges, read `.env`, cross the project boundary or claim a successful run. These are execution-policy tests, not proof that a model resists every prompt injection. The first regression run exposed five product failures and one invalid Studio fixture size; the fixture was corrected to its documented minimum without changing product validation.

The affected regression suite passed **76/76**. The full suite passed **522 tests, one optional graph-backend skip, zero failures** (523 total, 16.81 seconds). Logs are in `.nexus/verification/engineering-audit-2026-11-12/`, including `boundaries-regression.log` and `final-gap-tests.log`.

## Actual local-model evaluation

The already installed `gpt-oss:20b` ran through NexusIDE's actual provider adapter, agent runtime and workflow scheduler. An audit-owned Ollama listener used literal loopback, `OLLAMA_NO_CLOUD=1`, no pruning/downloads, one loaded model and one inference at a time. Only synthetic projects were supplied. The harness refuses non-loopback endpoints, missing installed models and remote-model metadata. This is evidence for this local model and these tasks only; no cloud or subscription compatibility claim follows.

The reproducible command is `npm run verify:agent-quality -- --model gpt-oss:20b`. An already running local Ollama server is required; `--url http://127.0.0.1:11435/v1`, `--case NAME` and `--report PATH` permit isolated diagnostics. The script never starts or installs a model server. Model-generated code and tests in the independent feature/mutation checks run with Node filesystem/process permissions and a macOS network-denial sandbox; that part currently requires macOS.

| Evidence | Observed result |
| --- | --- |
| [Initial eight-case run](evidence/2026-11-13/model-baseline.json) | 5 passed, 3 failed, 40 requests. Empty/omitted directory paths caused failures that correctly remained unresolved even after another action succeeded. |
| [Run after path-contract clarification](evidence/2026-11-13/model-after.json) | 6 passed, 2 failed, 37 requests. No blanket error suppression or automatic forgiveness was introduced. |
| [Targeted development workflow after correcting the evaluator](evidence/2026-11-13/model-handoff.json) | Passed. 11 requests; coder, tester and reviewer all completed with eight successful tools and no failed or denied actions. |

The production improvement explicitly documents nonempty relative tool paths and `path: "."` for the project root, both in the tool schema and agent instructions. Paths are still checked at execution; absolute paths and escapes are not normalized into permission.

The development benchmark starts with a broken invoice-total implementation. Its pre-authored five-test suite fails before editing (four failures, one pass); all five pass afterward, with an unchanged test-file hash. A permitted agent edits only the implementation; another executes the actual test command; a third reads the source and test file. The harness verifies exact upstream handoffs. The first evaluator compared raw multiline prose against JSON-escaped prompt text and falsely rejected a valid handoff. It now parses the handoff JSON and compares complete objects; only that affected case was rerun. The targeted run took 45.48 seconds and reported 11,755 input plus 1,969 output tokens. This is one observation, not a throughput estimate or an independent-model review. The reviewer identified floating-point rounding and missing input-validation concerns beyond the five fixture tests. Its review completed; it did not unconditionally approve general invoice correctness. The fixture was discarded, and these findings are retained in the evidence.

The other passing cases exercised a small feature against five independent assertions, generated tests against a correct implementation and four independently defined mutants, seeded boundary-defect review, denied edits, failed-read continuation without replay, and cancellation during real local inference. Code understanding returned the correct source, symbol and numeric result but failed the explicit evaluator requirement to use both search and file-read tools. That failure is retained; it was not rerun until it passed or relabeled a pass. Across the latest full run and corrected targeted check, seven scenarios have passing evidence and one retains a tool-use criterion failure. No statistically meaningful success-rate or causal improvement claim is made from these small stochastic runs.

## Native and offline checks

`npm run verify:offline-desktop` runs the existing DMG lifecycle harness under a macOS kernel sandbox inherited by its child processes. It first proves an external TEST-NET-1 connection returns `EPERM` and a loopback connection succeeds. It then exercises the real packaged native launcher, installation from the read-only DMG, isolated application data and HOME, system-only PATH, history retention, same-version replacement, uninstall/restore and closed-state backup restoration. The initial run passed all **13 lifecycle checks** against the installed November 12 artifact. The final artifact's receipt is `.nexus/verification/offline-desktop.json`; its digests determine which build it covers.

A native WKWebView smoke check used a disposable project through the actual macOS project picker. Task entry, offline execution, attempted/completed activity, the review-results state, accessible control names, keyboard command-palette opening, its Close control and normal shutdown were observed. The displayed result was one attempted and completed tool, zero failed/denied. The original project was restored with its zero-run history unchanged. Native screenshots were inspected in the computer-use session; they are distinct from the earlier Chromium captures. An automated Escape key did not dismiss the command palette; Close worked. That observation needs a focused native keyboard follow-up and is not a VoiceOver certification.

This is an offline rehearsal on the development Mac, not a clean-machine release test. No independent Mac/VM, Intel/minimum-OS matrix, standard-user account, actual cross-version migration, quarantined download, Developer ID identity or notarization submission was available or manufactured. No security setting was bypassed. The existing native architecture and local-only launch requirements remain intact.

## Remaining work, bounded by evidence

1. **Public distribution gate:** obtain owner-signed/notarized artifacts and test them on an independent clean Mac/VM, including quarantine, standard-user permissions, actual supported-version upgrades and the advertised OS/CPU matrix.
2. **Effectiveness:** broaden the opt-in model benchmark to representative repositories and repeated trials. Retain the tool-use failure, conservative unresolved-action behavior and absence of demonstrated memory-effectiveness gains. Paid/cloud inference remains untested.
3. **Accessibility:** full VoiceOver and native keyboard/focus testing, including the observed Escape behavior. The smoke check does not certify every workspace or assistive technology.
4. **Security/performance breadth:** hostile concurrent filesystem races beyond approval-time swaps, malicious third-party implementations, long-running resource measurements and optional installed integrations remain bounded follow-ups. Passing these regressions is not complete security certification.

No unchanged failing approach was retried beyond two failures. The model-path diagnosis used recorded tool arguments; the handoff failure was corrected in the evaluator; the offline sandbox was checked with a kernel-denied probe before using it as evidence. Failed and superseded receipts remain available.
