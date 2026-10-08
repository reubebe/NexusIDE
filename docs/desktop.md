# Native macOS workspace

The native shell opens the existing NexusIDE dashboard in a macOS window. It shares the CLI's project state, agents, workflows, providers and approval system.

## Build and open

Requires macOS, Node 22 or later, project dependencies, and Xcode Command Line Tools with a matching macOS SDK.

```sh
npm run desktop:build
npm run desktop
```

Create a locally signed application bundle and installable disk image:

```sh
npm run desktop:package
```

This produces `dist/NexusIDE.app` and `dist/NexusIDE-0.2.0.dmg`. By default the app uses an ad-hoc local signature, which is suitable for local verification but not public distribution. Set `NEXUS_CODESIGN_IDENTITY` to an installed Apple Developer identity for a distributable signature; notarization remains a separate release step.

After linking the CLI, run `nexus desktop` from another initialized project to open that project's workspace. Build the host again after changing `desktop/macos/NexusDesktop.swift`. The compiled executable lives at `dist/NexusIDE-host`.

The window provides the dashboard's agents, task activity, approvals, file editor, memory, skills, history, connections and an explicitly started embedded PTY. The terminal is authenticated through the loopback session, bounds retained output, stops with the app, and does not send output to models. It runs under your account and is not a sandbox; `nexus terminal` remains available in Terminal.app.

Closing the window or choosing **Quit NexusIDE** closes its server and cancels active jobs and pending approvals. Save edits first. Run records remain in the project's `.nexus` directory. The launcher also handles Ctrl-C and SIGTERM.

## Boundaries

- Each launch starts an authenticated server on a free loopback port.
- The token travels to the native host over stdin, not command arguments or environment variables.
- The WebKit session uses nonpersistent storage. It has no JavaScript-to-native command bridge.
- Top-level navigation is restricted to the same loopback origin; new browser windows are refused. The dashboard's CSP remains in force.
- The local runtime still runs as your user. This shell is not an OS sandbox.

The host uses Apple's [WKNavigationDelegate](https://developer.apple.com/documentation/webkit/wknavigationdelegate) to restrict navigation.

## Verification and limits

`node scripts/verify-desktop.js` checks URL validation, native process launch, dashboard HTTP authentication and shutdown in a temporary workspace. Native visual checks also covered workspace rendering, navigation and an embedded terminal command in the packaged app.

The build produces a native host bundle and DMG, not a self-contained Finder-launchable product. The host requires its session URL on stdin from `nexus desktop`, plus the local source installation and Node runtime. A Finder entry point/project picker, Developer ID signing/notarization, automatic updates, bundled Node and Windows/Linux hosts remain outstanding. `nexus serve` remains the browser interface on supported Node platforms.

The audit added native discard confirmations and protection when closing or quitting with unsaved file edits. A newer source-built host is preferred over an older packaged copy. A forced process termination can still lose unsaved browser drafts.
