# NexusIDE 0.3.0 validation record

Date: 2026-10-29. Runtime source commit: `6095797ae610a40e1000af06265e05a49984ed28`. Built from a clean detached release checkout; unrelated user video changes were excluded. This record distinguishes tested behavior from optional integrations and remaining release requirements.

## Coverage and implemented changes

- Provider and account routing, credential boundaries, Responses API parsing, terminal lifecycle, native environment forwarding, file/state safety, workflow recovery, packaging and documentation.
- Visible version, visualization creation and source tables, charts/graphs/spatial views, zoom/fit/expanded view, export and native save UI. File browsing, filtering, image preview and xterm terminal behavior.
- Explicit API/local-model routing and official CLI account profiles for Claude, Codex, Gemini and Meta Muse; separate state where the CLI supports it. Meta Model API and Muse keys have distinct roles. No silent account rotation or subscription-to-API fallback.
- Optional deep skill review, bounded external media/visual tool adapters, reproducible harness experiments and graph backend comparison.
- Seven additional Nexus roles and three teams, authenticated GUI library upgrade without overwriting customized agents/teams, and the permission-gated local media preview tool. See [advanced agents](advanced-agents.md).
- Expanded [user guide](user-guide.md), [subscription account boundaries](subscription-accounts.md) and [Research Harness connection comparison](research-harness-connections.md).

## Observed validation

| Check | Result |
|---|---|
| Final `npm test` | 436 tests: 435 passed, 0 failed, 1 skipped (optional graph backend discovery test). |
| New library/workflow/media checks | 9/9 passed, including exclusive upgrades, authenticated endpoint, three synthetic workflows, permission denial, container-mode refusal and real FFmpeg preview preservation. |
| Bootstrap tests after library expansion | 5/5 passed. Three initial full-suite failures were stale 28-agent expectations; corrected for the 35-agent library before the final passing run. |
| Final app bundle verifier | 17/17 checks passed, including relocated signature, bundled Node/PTY, native provider forwarding, authenticated dashboard, state and shutdown. |
| Final release rehearsal | 14/14 passed: artifact hashes, DMG integrity, read-only mount, install copy/native bootstrap, relaunch, app replacement, retained data, backup/restore and detach. Synthetic development-machine lifecycle only. |
| GUI | Prior 40 tab/viewport checks passed. Final browser check added 7 agents/3 teams, repeated with 0 additions, selected the new team, found no console errors or horizontal overflow, and displayed v0.3.0. |
| Native GUI | Rebuilt native host opened the synthetic workspace, displayed v0.3.0, navigated visualizations and saved CSV through NSSavePanel. Export was 69 bytes and retained `-2`, an empty missing value and `3`. |
| Native CSV digest | `80ecc92d5e52b2ba20caac9a0dbe9b5c8ff903fba2f8e7fba8a3ffe49fcfa558` |
| Prior focused checks | Provider/CLI catalog 37/37, native environment/navigation/ACP/MCP 7/7, pilot workflow 18 checks, dependency audit 0 vulnerabilities at the time run. Dependencies did not change in the final agent addition. |
| Focused delegated review | No material findings in permission enforcement, host-mode boundary, exclusive installation, authenticated library endpoint or regression coverage at `6095797`. No separate test rerun claimed. |
| Change review | Diff whitespace checks passed; targeted credential-pattern scan found no matches. User video deletion/replacement remains outside commits. |

Earlier SkillSpector and graph comparisons used small synthetic fixtures and are not accuracy benchmarks. Live paid AI outputs, actual subscription login/billing, and optional Iris/Earshot/nnInteractive services were not validated. Agent instructions and synthetic orchestration tests do not establish model quality or upstream feature parity.

## Artifact and remaining limitations

- Artifact: `dist/NexusIDE-0.3.0-arm64.dmg`; accompanying `.app` and JSON build report are in `dist/`.
- SHA-256: `4a46e79ad8748e66d0c0347a4d880c941e32dd8bfa459846ccb2c645e5344f16`.
- Apple Silicon, macOS 13 minimum in metadata; bundled Node v22.18.0. Ad-hoc development signature verified. **Not Developer ID signed or notarized.**
- No clean-Mac/VM, download-quarantine Gatekeeper, fresh-user permission-denial, Intel or minimum-OS validation. These remain distribution acceptance gaps; the rehearsal is not clean-machine certification.
- Functional gap: subscription CLIs run in Terminal. Direct ChatGPT/Claude subscription inference in Nexus Tasks is not implemented; Tasks uses API or local-model profiles. Meta Muse has one shared subscription sign-in; DeepSeek, GLM and Qwen use API paths. See the account guide before choosing billing.
- The seven references are adapted workflows, not bundled upstream runtimes. Converters, speech models, image services, external databases and scanners need separate setup. No measured claim that these roles outperform the referenced projects.
- Detailed machine receipts remain in ignored `.nexus/verification/`; release binaries follow the existing local artifact convention and are not committed to Git.
