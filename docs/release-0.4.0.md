# NexusIDE 0.4.0 validation record

Native guide implementation, built as a local development distribution. The user-authorized scope includes explicit engineering exclusions in [guide completion](guide-completion.md), rather than forced installation of optional editors, runtimes or frameworks.

## Changes

- Studio source library, actual raster edits, ordered video exports, linear keyframe animation, SVG layout and macOS PDF page/comment operations. Derivative previews, source/output hashes, exact plan approvals, cancellation, scratch cleanup and confirmed-owner recovery.
- Renderer CPU/per-file limits on macOS/Linux, bounded inputs and library, preserved original media, and explicit format/fidelity limitations.
- Manual and model-assisted Skill Foundry with source-line verification, scans, human publication/revocation, local discovery and selection plans. Model generation uses the existing router and run budget with no tools or automatic publication.
- Consented public HTTPS acquisition with DNS pinning, IPv4/IPv6 exclusions, conservative robots handling, no redirects, bounded text, cancellation, concurrency limits and removable provenance receipts.
- Account aliases/disable state, effective routes and profile-attributed usage; human/agent task board with atomic revisions and native run evidence; read-only transcript import and reviewed context handoff; recorded tool-grant/approval assurance.
- Keyboard workspace search, adjustable file split, responsive controls, version 0.4.0 and expanded user guide. Astryx assessed as a design/testing reference; no React migration or new UI dependency.

## Observed validation

| Check | Result |
| --- | --- |
| Final full suite | 493 tests: 492 passed, zero failed, one optional graph-backend discovery test skipped. |
| Actual media | PNG/JPEG/WebP inputs, MP4/MOV/WebM video paths, motion and PDFKit output tested with source preservation, dimensions/duration and failure checks. SVG escaping tested. |
| Resource/recovery | Kernel file-size bound exercised with an actual subprocess; scratch cleanup protects registered media/exports/receipts; active owners cannot be recovered. |
| AI/security | Synthetic model/local transport fixtures test malformed generation, invented citations, denied tools, stale source, unapproved publication, task privacy/concurrency, DNS rebinding, response limits and cancellation. No paid/live provider call. |
| GUI | 56 checks passed across 14 workspaces at 360/390/768/1280 pixels, no browser errors. Direct Chrome interaction verified command search, synthetic image import, adjustment approval, completed export and visible derivative preview. Not a complete assistive-technology audit. |
| Native compile | macOS host compilation passed on Apple Silicon/macOS 27.2. |

## Distribution

Runtime source: `48171020f6b5c94dc54165d01b8780512a08dccf` in a clean detached checkout. The user's uncommitted video replacement/deletion is excluded. Binaries follow the existing local `dist/` convention and are not committed to GitHub.

- Bundled app verifier: **17/17 passed**, including relocated launch, signature, Node/PTY, native credential forwarding, authenticated dashboard and shutdown.
- Mounted DMG / installation-upgrade rehearsal: **14/14 passed**, including integrity, read-only mount, synthetic install, launch/relaunch, replacement of 0.3.1, data preservation, backup/restore and detach.
- Artifact: `dist/NexusIDE-0.4.0-arm64.dmg`; app and JSON build report are alongside it.
- SHA-256: `472218e6a62d7aa3353598a31af8a46d8c62d281b4a78ae1c5a4da8679463a19`.
- Apple Silicon; bundled Node v22.18.0; macOS 13 minimum metadata. Ad-hoc signature verified; **not Developer ID signed or notarized**.
- Prior app retained at `dist/.previous-release-UW17D6/NexusIDE.app`; earlier DMGs retained.
- Receipts: `.nexus/verification/bundle-0.4.0.json`, `release-0.4.0.json` and `publication-0.4.0.json` (local, ignored).
- Packaging initially failed at `hdiutil verify` with a temporary-resource error. The new documented `diskutil image create from` path succeeded; subsequent integrity and mounted-image checks passed. Older build hosts keep a probed hdiutil fallback. Failed staging is now preserved for diagnosis instead of forcing another complete rebuild.
- No GitHub binary upload or production deployment was performed.

## Explicit limits

No Developer ID signing, notarization, clean-machine/Intel/minimum-macOS certification, live subscription/quota validation or external editor compatibility is implied. Media parsers still run on the host after approval; resource limits are not sandbox isolation. RAW/layered/native-document fidelity and executable skill QA are outside the selected native scope. API cost estimates remain separate from billing and vendor quota. See the guide for per-feature boundaries and the [Astryx assessment](astryx-assessment.md) for the frontend decision.
