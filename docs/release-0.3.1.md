# NexusIDE 0.3.1 validation record

Date: 2026-11-05. Limited development preview. Runtime source revision is recorded in the generated build report. The existing user video deletion/replacement is excluded from this release.

## Changes and coverage

- Experimental Claude Code subscription inference selected explicitly in Connections for Tasks/teams. Identity-bound immutable route profiles preserve unrelated models and reject agents with pinned providers. No credentials copied, built-in CLI tools enabled, account rotation or API fallback.
- Shared request/token/deadline limits, including approval cancellation in dashboard, CLI and ACP. Failed requests mark shared usage unknown. Same-account subscription stages serialize.
- Motion comparison UI and real FFmpeg export; optional ManimGL scene adapter; matching permission-gated agent tools. Protected paths, source-change checks, cancellation, source/output hashes and ffprobe output inspection. Missing render engines do not prevent Nexus startup.
- App version 0.3.1 displayed. User guide and subscription instructions expanded. Studio/repository decisions distinguish implementation from proposed work and avoid redundant runtimes, proxies and stores.

## Observed validation

| Check | Result |
| --- | --- |
| `npm test` after repairs | 452 tests: 451 passed, 0 failed, 1 skipped (optional graph backend discovery). |
| Targeted routing/budget evidence | Pinned-route refusal, independent model selection and identity rebinding, shared deadline, unknown failed usage and pending approval cleanup covered with synthetic CLI/local provider fixtures. |
| Motion | Seven tests passed in full suite. Actual FFmpeg color-clip comparison verified dimensions, duration and unchanged source hashes; ManimGL invocation used a synthetic executable. Invalid renderer output rejected despite exit 0. |
| GUI | macOS Chrome, disposable workspace: visible v0.3.1, both synthetic videos displayed, source playback, confirmed export with completed output path, budget form/save confirmation. Browser-control host was unavailable; native accessibility control worked. No paid provider call. |
| Initial failures | Canonical macOS `/var` path bug fixed. Test expectations updated for canonical paths; budget fixtures corrected to retain required existing limit fields and keep cancellation test alive. Final regression run passed. |
| Source review | Focused delegated review identified route/model mutation and deadline/unknown-usage defects; fixed locally after workers reached usage limits. Diff whitespace checks passed. No new dependencies or copied upstream implementation/assets. |

## Limits and deferred work

- Live Claude subscription authentication/completion, billing and quota availability were not validated. Other official subscription CLIs remain Terminal-only; direct APIs/local models retain their prior behavior.
- Actual ManimGL rendering was not run because it is absent. Its Python scene/import execution is approved host execution, not a security sandbox. FFmpeg parsers also run on the host; the bounded adapter is not hostile-media isolation or professional fidelity certification.
- Token ceilings may be exceeded by in-flight responses before usage is returned. These are run limits, not account-wide spending guarantees or vendor quota limits.
- No full image/RAW/PDF/design editor, external transcript importer, generic crawler, task board, policy certification or upstream feature parity. See [Studio decisions](studio-decisions.md).
- Clean-Mac/VM, Intel, minimum-OS, download-quarantine Gatekeeper and live-provider acceptance remain unperformed. Existing ad-hoc distribution does not establish Developer ID signing/notarization.

Distribution verification and final artifact digest are appended after packaging. Binaries remain local under `dist/`, following the repository's established convention.
