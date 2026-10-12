# Self-contained macOS development distribution

Phase 4 bundles the native host, a tested Node 22 runtime, dashboard/CLI code and exact-lockfile production JavaScript dependencies, including node-pty. Finder launch no longer needs this source checkout, a global Node/npm installation or a terminal-provided session URL. This is an architecture-specific **ad-hoc signed development build**, not a Developer ID signed/notarized public release.

## Build and verify

On a macOS build machine with Node 22.18+ (22.x), npm and matching Xcode Command Line Tools:

```sh
npm run desktop:package
npm run desktop:verify-bundle
```

Outputs are `dist/NexusIDE.app`, `dist/NexusIDE-0.2.0-arm64.dmg` (or `x64` on that architecture) and a JSON build report. The DMG contains the app, an Applications shortcut and installation notes. Drag the app to Applications and open it. Gatekeeper may reject this development signature; do not globally disable Gatekeeper. Phase 5 provides the trusted release path.

The builder copies the selected local Node executable (`NEXUS_NODE_BINARY`, default the build process's Node), verifies version/architecture, rejects non-system dynamic libraries, checks declared minimum deployment targets, and records SHA-256 digests. It does not download executable Node bytes. Matching Node license text is fetched from the official Node source tag; set `NEXUS_NODE_LICENSE` to a local matching LICENSE for an offline license step. npm still needs registry/cache access for locked dependencies. Dependencies are installed in isolated staging with lifecycle scripts disabled; the Nexus-owned PTY helper setup and a real PTY/SQLite check run explicitly.

The positive payload list excludes workspace state, Git metadata, developer node_modules and credentials. Source payload links/private file patterns and escaping dependency symlinks fail packaging. Nested Mach-O binaries are signed before signing the app; signatures and disk-image integrity are verified. Existing release artifacts are retained under `dist/.previous-release-*`; a publication failure restores previous artifacts. Signing defaults to ad-hoc. The explicit Developer ID mode requires an exact certificate fingerprint, Team ID and clean checkout. [Phase 5 preparation](macos-release.md) documents that flow; no Developer ID/notarization success is claimed until enrollment and live checks are complete.

## First launch and storage

Choose a project folder on first launch, or use **File → Open Project…** later. Missing default agents/team are created with exclusive writes; existing agents, provider configuration and project history are kept. Setup performs no model calls, model downloads, external integration installs or secret imports.

Project state stays in `PROJECT/.nexus`. App-level recent-workspace metadata is stored privately under `~/Library/Application Support/NexusIDE/.nexus/desktop/`; the native last-folder preference uses macOS UserDefaults. This separation avoids writing inside the installed app and does not silently migrate existing project state. Back up project state and external runtime/output directories separately.

The native host starts only its bundled Node with a minimal environment. A private pipe carries the authenticated loopback URL; it is not placed in arguments, environment, preferences or logs. The host closes the service on quit/project switch, with bounded fallback if shutdown stalls. Existing unsaved-edit confirmation and WebKit origin restrictions remain. `nexus desktop` retains the CLI-owned session mode for terminal workflows.

Finder does not inherit shell-exported API keys or PATH additions. For the eight cloud presets, export the real API keys in a terminal, fully quit Nexus, then launch the installed native binary from that terminal:

```sh
/Applications/NexusIDE.app/Contents/MacOS/NexusIDE
```

The native host forwards only `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, `ZHIPUAI_API_KEY`, and `DASHSCOPE_API_KEY` to its owned runtime. It does not read shell startup files, `.env` files, or the Keychain, and does not persist key values. **Connections → Choose your model** then detects those keys. `open -a NexusIDE` is not a substitute for directly launching the binary with inherited variables.

Existing local Ollama profiles work while Ollama is running; vault-password setup and optional tools remain explicit. The bundled CLI can be invoked from a configured terminal using:

```sh
"/Applications/NexusIDE.app/Contents/Resources/runtime/bin/node" \
  "/Applications/NexusIDE.app/Contents/Resources/app/src/cli.js" providers
```

Use that same prefix for `integration configure NAME` in the intended project when adopting journaled managed profiles. Existing custom MCP/application configuration may intentionally point to external paths and is not rewritten. Git, Python/uv, FFmpeg, Docker, models and optional integration runtimes are not part of the core app; Finder's minimal PATH may require absolute executable paths for custom tools.

## Validation scope

The repeatable bundle check copies the signed app to a different directory, launches with a minimal PATH, verifies native bootstrap/shutdown, runs a bundled offline agent and SQLite history, tests authenticated dashboard access and a real embedded PTY, and checks app metadata contains no session token. Its local receipt is `.nexus/verification/bundled-desktop.json`. These checks run on the development Mac; they are not a fresh-machine/Gatekeeper or Intel hardware test.

macOS 13 is the declared binary deployment floor, not a claim that every supported OS version has been exercised. Windows/Linux native bundles, automatic updates, Developer ID signing/notarization, Intel testing and clean-machine installation/upgrade/uninstall validation remain later release work. See [release phases](release-phases.md).
