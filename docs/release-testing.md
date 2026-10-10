# Release testing: rehearsal versus clean-device acceptance

A passing developer-machine rehearsal is useful evidence, **not clean-machine certification**. Phase 6 is complete only after the final, notarized release artifact passes the manual acceptance matrix below on independent clean devices. Do not mark an unperformed check as passed or promote an ad-hoc build to a production release.

## Automated local rehearsal

Run after packaging, and again after the final signed/notarized artifacts are produced:

```sh
npm run verify:release

# Explicit artifact selection; quotation marks matter for paths containing spaces.
node scripts/verify-release.js \
  --app '/absolute/path/NexusIDE.app' \
  --report '/absolute/path/NexusIDE-0.2.0-arm64.json' \
  --dmg '/absolute/path/NexusIDE-0.2.0-arm64.dmg'

# Add a retained earlier app to exercise cross-version data compatibility.
node scripts/verify-release.js --previous-app '/absolute/path/previous/NexusIDE.app'
```

The harness requires macOS matching the artifact architecture. The harness itself runs under the development Node, but every application launch and CLI data operation uses the **bundled executable/runtime** with a system-only PATH, an isolated HOME, and no inherited provider keys or Node options. It makes no model requests, downloads, analytics calls, or account changes. This is not an OS-level network-denial test.

It performs these checks:

1. Validate app/report metadata consistency, SHA-256 digests of the DMG, bundled Node and lockfile, and bundle-contained symlinks. Reports are consistency records; their fields alone do not authenticate a publisher.
2. Verify disk-image integrity and the application code signature (plus declared Hardened Runtime / Developer ID authority and team on new-format bundles). Mount the DMG read-only, compare its contained app with the report, and use that actual app as the installation source. The report's notarization field is recorded as `reportedNotarized`; it is not independently validated by this no-network rehearsal.
3. Copy the app into a temporary `Applications` directory. Bootstrap its real native launcher into a synthetic workspace, then run an offline demo with the bundled CLI and persist its run history.
4. Relaunch, replace the application, and check that the saved run, agent definition, project file and private note remain unchanged. With no differently versioned `--previous-app`, this is **same-version replacement**, not schema migration coverage.
5. Move only the temporary app to temporary Trash; verify project/application data remain. Restore the app and reopen that data.
6. Restore a closed-state backup into a separate workspace/data directory and read back the original run. Detach the disk image and remove temporary rehearsal files.

The harness never installs into the real `/Applications`, modifies your existing workspace or preferences, or removes a user app. If image detachment fails it reports failure and leaves that temporary mount in place rather than recursively deleting through it. Only the receipt is saved in the invoking workspace: `.nexus/verification/release-rehearsal.json` (ignored by Git). Review paths before sharing it.

Receipt fields include `schemaVersion`, `suite`, artifact digests, source revision/dirty status, OS/architecture, each check's status, and the replacement versions. `verified: true` means only that all **automated rehearsal** checks passed. `cleanMachineVerified` and `releaseCertified` always remain `false`; every manual check appears under `unperformed` as `not-run`. Retain the receipt with the exact final DMG/report, because rebuilding or stapling changes evidence applicability. A build from a dirty source tree is not a reproducible release candidate.

`npm run desktop:verify-bundle` provides complementary relocated-bundle, authenticated dashboard, PTY, SQLite and shutdown checks. Neither harness is a visual test or a replacement for clean-device testing.

## Clean-device acceptance matrix

Use a physical Mac or a fresh macOS VM snapshot that has never launched this app/version. A second account on the development Mac helps with user-state testing but does not clear OS-level caches or establish a clean machine. Record the device/VM identifier without personal identifiers, OS build, native CPU architecture, artifact SHA-256, app version, source revision, tester, UTC time and expected versus actual result.

Test each distributed architecture natively: `arm64` on Apple Silicon and `x64` on Intel. A Rosetta run is separate optional evidence, not an Intel-machine substitute. Cover the declared minimum macOS version and the current supported macOS version for each advertised build. Mark unavailable combinations `not-run` and narrow published support claims until they pass.

| Check | Procedure and required evidence |
| --- | --- |
| Artifact provenance | Obtain the final artifact/report from the actual private release channel. Independently compare DMG SHA-256 with the approved release record. Record build revision, clean-tree status, signature identity/team, notarization acceptance and ticket validation. |
| Fresh download / quarantine | Download through the intended browser on the clean device. Record quarantine metadata before launch; do not strip extended attributes or use a local build copy as the substitute. Start with default Gatekeeper and SIP settings. |
| Gatekeeper first launch | Open the downloaded DMG, drag the app to Applications, eject the image and open through Finder. Verify normal first-launch behavior without an override or developer tools. Capture the exact prompt/failure if blocked. Never disable Gatekeeper globally to make a test pass. |
| Fresh standard user | Use a non-admin account without Node, npm, Homebrew, Python, Git developer tools or Ollama. Confirm the app opens and its bundled demo/terminal/history work. Missing optional tools/models must be described as prerequisites, not cause a crash or silent install. |
| Offline first launch | From a clean snapshot, download the final stapled artifact, then disable external networking before its first launch. Test launch, workspace initialization, demo, terminal, SQLite history, quit and relaunch. Record network state and expected failure messages for cloud-only functions. Loopback access must remain available. |
| Native window and accessibility | Visually inspect a small display and enlarged text; keyboard-focus order, accessible control labels, task planning, cancellation, terminal resizing/input, copy/paste, links and errors. Test VoiceOver. Capture screenshots without secrets. |
| Workspace permissions | Try a normal local folder, a path with spaces/non-ASCII characters, a read-only folder and a protected location. Deny access when prompted; confirm no hang, no writes elsewhere and a useful recovery path. Then allow access using normal system controls and retry. Do not grant Full Disk Access merely to conceal a failure. |
| Workspace isolation | Create two synthetic projects and switch/relaunch. Verify agents, run history, semantic index and approvals are scoped correctly; no credentials or bearer tokens appear in preferences, logs or shared screenshots. |
| Real upgrade | Install the actual previous supported release, create runs/notes/agents/index and a non-secret provider profile, quit, and take a closed-state backup. Install the candidate and verify retained data and expected schema migration. Record both versions/digests; same-build replacement does not count. |
| Failed launch / recovery | Use disposable fixtures for unavailable model/server, denied folder, interrupted integration setup and process cancellation. Check saved failure status, recoverable locks and that child processes stop. Test storage exhaustion only in a disposable limited-size disk/VM, never on your normal disk. |
| Backup / restore | With all related app/CLI processes stopped, securely copy the project's entire `.nexus` directory plus project files and the app-data directory. Restore to a separate folder/account; verify runs, agents, notes, settings and index usability. Keychain or machine-bound secrets may require explicit reconfiguration; never copy raw secrets into the test report. |
| App uninstall / reinstall | Quit all app/CLI processes, move only the app to Trash, verify project `.nexus` and `~/Library/Application Support/NexusIDE` remain, reinstall and reopen. Do not remove user data as an implicit uninstall step. |
| Privacy / network | With no provider/integration configured, observe launch/demo traffic using the clean test environment's approved monitor. Record destinations and compare against the documented loopback-only app behavior. Platform security/network checks are distinct from application telemetry. Test an explicitly approved provider separately. |

Gatekeeper assessment, signatures and notarization are distinct from a first-launch test. Apple recommends testing the end-user launch experience with Gatekeeper enabled and quarantine present. See [Apple's distribution testing guidance](https://help.apple.com/xcode/mac/current/en.lproj/dev033e997ca.html) and [testing a Developer ID-signed app](https://help.apple.com/xcode/mac/current/en.lproj/dev1cc22a95c.html). Notarization does not replace application security review; see [Apple's Gatekeeper overview](https://support.apple.com/en-ie/guide/security/sec5599b66df/web).

## Recording manual evidence

Keep a separate private acceptance record per artifact/device combination. A minimal template is:

```json
{
  "schemaVersion": 1,
  "kind": "manual-clean-device-acceptance",
  "artifactSha256": null,
  "sourceRevision": null,
  "version": null,
  "platform": "darwin",
  "architecture": null,
  "osBuild": null,
  "deviceFixture": null,
  "tester": null,
  "at": null,
  "checks": [
    { "name": "gatekeeper-first-launch", "status": "not-run", "evidence": null },
    { "name": "offline-first-launch", "status": "not-run", "evidence": null },
    { "name": "real-upgrade-and-restore", "status": "not-run", "evidence": null }
  ],
  "releaseApproved": false
}
```

Add every matrix check before testing. Use `passed`, `failed`, `not-run`, or `not-applicable`; explain each exclusion. Store screenshot/log filenames and observed outcomes, not credentials or full workspace contents. Do not overwrite the automated receipt to manufacture clean-machine evidence. Release approval requires the signed/notarized artifact, applicable clean-device checks, security review and pilot gates—not just an aggregate test count.
