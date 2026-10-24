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

## Comprehensive Markdown reference

`docs/user-guide.md` has 20 chapters and 22 illustration placements. The main
reference uses normal Markdown, local images and SVGs rather than a remote image
service or an AI-generated screenshot. It includes a contents table, Mac/Windows
setup, multi-account routing, Ollama, agent permissions, teams, checkpoints,
research/tool integrations, memory, files, terminal, VS Code/Zed, search, backup,
troubleshooting and worked examples.

Rebuild the additional diagrams and numbered screenshot wrappers with:

```sh
python3 scripts/generate-guide-illustrations.py --render
```

That standard-library script writes SVG markup and embeds approved local PNGs in
the two annotated SVGs. It does not start a model, external service or browser,
install software, or read project notes/credentials. The Connections screenshot
is a synthetic-account capture with real local Ollama catalog metadata, not a
cloud inference result. If its private verification capture is absent, the script
reuses the committed `connections.png` instead. The Workspace fixture contains
three sample agents; the current fresh-install library contains 28 definitions.

The optional `--render` step uses `rsvg-convert` to export the annotated SVGs as
standalone PNGs, so their embedded screenshots render in more Markdown viewers.
Omit that flag to regenerate only SVG sources. The renderer is a maintainer tool,
not a prerequisite to read the guide. Keep images and their relative
paths together when sharing the Markdown. Ordinary images are PNG; diagrams stay
editable SVG. The app's compact HTML tour links to the full Markdown reference;
a previously built DMG retains the guide that was bundled at build time.
