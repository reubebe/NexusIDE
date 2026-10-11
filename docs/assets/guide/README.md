# Guide artwork

These screenshots are real renders of NexusIDE, using a disposable synthetic project. They contain no private workspace state, credentials, or real model responses. They are browser captures, not native macOS-window captures.

Regenerate from the repository root:

```sh
npm run docs:captures
```

The script requires Google Chrome (or `NEXUS_CHROME_PATH`) and Node 22.18+. It creates its own temporary browser profile and workspace, verifies desktop/tablet/mobile layouts and an offline planning/approval workflow, then removes only its own temporary resources. It does not restart existing services. Screenshots are intentionally taken before executing the demonstration workflow.

The architecture diagram lives in `ui/illustrations/architecture.svg` so the About page and both guide formats use one source. Task and Research Harness diagrams live here. SVG text uses presentation attributes, avoiding inline CSS under the dashboard's strict content security policy.

The canonical Nexus star is `ui/brand/nexus-symbol.svg`. On macOS, `npm run brand:icon` derives the committed PNG and ICNS from that vector using an isolated Chrome profile, `sips`, and `iconutil`. Packaging copies the committed icon; it does not need Chrome.

After visual changes, inspect the generated images as well as the automated checks. Do not replace these with captures of a real project or put session-token URLs in documentation.
