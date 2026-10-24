# End-to-end repair and release audit — 2026-10-24

This follow-up covers runtime/provider contracts, MCP/ACP, workflows and recovery,
authenticated APIs, file operations, SQLite/memory, integrations, GUI state,
native macOS navigation, dependencies, and distribution. It supplements the
[integration audit](audit-2026-10-24.md), without certifying production readiness.

## Resolved findings

| Impact | Defect and correction |
| --- | --- |
| Medium — lost edits | Selecting another agent silently replaced unsaved instructions and memory selections. Draft snapshots, explicit reload/discard, busy protection, unload/native-close protection, and save status now preserve edits, including edits typed during saving. |
| Medium — file navigation | Out-of-order directory responses could display entries under the wrong path. Stale responses are ignored, failed loads preserve the displayed directory, and file actions use their displayed path. |
| Medium — native navigation | Project switching could prompt twice for already discarded edits after stopping the old runtime. New trusted sessions now consume one initial navigation allowance; later navigation still protects drafts. |
| Medium — AI failure handling | Oversized MCP results lost their error flag, evading the repeated-failure guard. Truncation preserves `isError` and bounds fully escaped JSON to 100,000 characters. |
| Medium — output correctness | Split UTF-8 characters were corrupted in command output. Independent streaming stdout/stderr decoders preserve characters and omit incomplete suffixes at the byte cap. |
| Medium — file correctness | NUL and malformed Unicode writes could create files unreadable by the text tools. Invalid content is now refused before approval or modification. |
| Medium — routing/scheduling | Names such as `constructor` and `toString` collided with inherited properties. Provider/application lookup, workflow execution/resumption, and connection status now check explicitly stored keys. Missing provider profiles display an actionable status. |
| Low — forms/accessibility | Invalid agent JSON could leave memory-selection loading permanently busy. Parsing now precedes the busy transition. Inline memory editing now has an accessible text label. |

At the user's request, **NexusIDE v0.2.0** appears in the footer and **Version
0.2.0** in About. Both use the installed application's `package.json`; the chosen
project's version cannot override it. No version bump was introduced.

## Validation

| Check | Observed result |
| --- | --- |
| Baseline Node suite | 362 passed, zero failed, one optional backend test skipped |
| Final `npm test` | 378 passed, zero failed, one optional graph-backend test skipped |
| Optional graph backend | Separately enabled the reviewed v0.11.0 binary: all seven Code map tests passed, including actual synthetic-source indexing/tracing; zero skips |
| Python reader | 12 tests passed in the existing Research Harness environment. System Python initially lacked optional `mcp`; no global dependencies were installed. |
| Research Harness protocol | Synthetic compatibility check passed against Harness 0.24.3, including provenance, stale-source rejection, bounded paging, and unchanged project state; no cloud calls |
| Synthetic runtime pilot | All 18 checks passed across 16 runs, including expected failures, cancellation, approvals, persistence, continuation, and recovery; not a real-user pilot |
| Storage scale | Seven checks passed: 2,048 files, 1,536-dimensional fixture vectors, 27,209,728-byte database, reuse, incremental reindexing, deletion, and bounded retrieval |
| Actual local model | `gpt-oss:20b` called `list_files` and `read_file` and returned exact fixture contents. This verifies that tool round trip, not broad answer accuracy. |
| Browser interaction | Protected agent draft/save, offline task, history, Unicode file edit, saved memory, and terminal start/input/stop passed in a disposable project |
| Responsive/visual | All nine tabs fit 390 pixels without document overflow; desktop/mobile screenshots inspected; no captured browser warnings/errors |
| Native build/navigation | Desktop compilation passed. A compiled AppKit/WKWebView regression verifies project switching and retained same-session draft protection. |
| Dependencies | `npm audit --omit=dev`: zero reported vulnerabilities |
| Relocated bundle | All 17 checks passed: signature, credential forwarding restrictions, bootstrap/shutdown, CLI, SQLite, authentication, and PTY |
| Distribution rehearsal | All 13 checks passed: integrity, DMG mount, temporary installation, relaunch, same-version replacement, retained data, uninstall/restore, backup restoration, and detach |
| Packaged visual check | Published native app with bundled server and isolated synthetic data showed version 0.2.0 in About and the footer. Visual launch used CLI session mode; owned bootstrap passed the automated harnesses. |

Regressions cover real subprocess output, loopback MCP exchange, persisted
workflow continuation, and native navigation, alongside existing provider-error,
cancellation, memory-governance, file, worktree, and recovery tests.

## Distribution and source

Runtime fixes: `de505af`. GUI, native navigation, and version display:
`7c5b40b3d8d2d9e0005732159ac5ee009599094f`.

The updated `dist/NexusIDE-0.2.0-arm64.dmg`, `dist/NexusIDE.app`, and JSON report
were built from a clean detached checkout of `7c5b40b`. DMG SHA-256:

```text
8c6b156c953582ce4cd71eff71fe2c3d7a7487935ecdb0cd87663b3ab039f67f
```

The app is ad-hoc signed, **not Developer ID signed or notarized**. The manifest
records `sourceDirty: false`; Node 22.18.0 and locked production dependencies are
bundled. This evidence document was written after packaging and is not included
in those immutable artifact bytes.

Previous artifacts were retained through `publishArtifacts`. Binaries remain in
ignored `dist/`, following the existing convention. Unrelated local video changes
were neither committed nor included in the clean-checkout build. Private receipts
remain in `.nexus/verification/`.

## Remaining release gates and limits

- **Release blocking:** Developer ID identity/team configuration, notarization,
  genuine clean-device/Gatekeeper acceptance, and the consented production pilot
  remain incomplete. Local replacement testing was same-version, not a
  cross-version migration certification.
- **Unverified platforms/accessibility:** native Intel, minimum-macOS execution,
  VoiceOver, Windows/Linux GUI, disk exhaustion, hostile filesystem races, and
  network filesystems were not exercised in this pass.
- **AI/integrations:** cloud generation, broader answer quality, successful live
  four-stage independent review, and actual hobby-application execution were not
  newly validated. Earlier Gemini/review limitations remain. No private research
  corpus or real project was sent to a model.

No failing automated checks remain for the corrected code. These limits remain
material when evaluating public-distribution readiness.
