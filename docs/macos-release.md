# Developer ID release preparation

The owner is not yet enrolled in the Apple Developer Program. No Developer ID identity is installed, no Apple credentials have been stored by this work, and **no artifact has been submitted for notarization**. This is release tooling plus local/fixture verification, not a completed signed release.

## Current local distribution

```sh
npm run desktop:package
npm run desktop:verify-bundle
npm run verify:release
npm run verify:pilot
npm run release:preflight
```

The default package remains ad-hoc signed and usable for local development. Preflight is read-only and intentionally fails until an explicit valid Developer ID identity/team is available. It does not test notary credentials or enroll anyone.

`NEXUS_SIGNING_MODE=hardened-rehearsal npm run desktop:package` is a diagnostic mode, not a distributable release. On this Apple Silicon development Mac, Node JIT worked with only `com.apple.security.cs.allow-jit`, but the real PTY check failed macOS Library Validation: the ad-hoc runtime/native module do not share a Developer ID Team. The failed build did not replace existing artifacts. Do not add `disable-library-validation`, `allow-unsigned-executable-memory`, `get-task-allow`, or other broad exceptions to bypass that gate. Full hardened Node/PTY/native-window operation must pass after all binaries have the owner's matching signature.

## Owner setup after enrollment

1. Enroll through [Apple's Developer Program](https://developer.apple.com/programs/enroll/). The owner handles payment and agreements.
2. Obtain a **Developer ID Application** certificate and its private key in the build Mac's Keychain. An Apple Development or Developer ID Installer identity is not a substitute.
3. Inspect public identity fingerprints with `security find-identity -v -p codesigning`. Select the exact 40-hex fingerprint and its 10-character Team ID; do not export the private key into the repository.
4. Store notarization credentials interactively, outside chat and shell history:

```sh
xcrun notarytool store-credentials nexus-release
```

The command prompts for credentials. The project uses only a Keychain profile name, never password/API-key command arguments. Do not put signing keys, `.p12` files or passwords in Git, CI logs or `.env` files.

## Build a release candidate

Use a clean, committed, dedicated checkout; do not edit or switch branches while building. This is not an immutable-build or supply-chain attestation system. The builder checks source cleanliness/revision before building, after payload creation, and before publication, but cannot defend against a compromised build host or transient same-account edits.

```sh
export NEXUS_SIGNING_MODE=release
export NEXUS_CODESIGN_IDENTITY='YOUR_40_HEX_CERTIFICATE_FINGERPRINT'
export NEXUS_TEAM_ID='YOUR_TEAM_ID'
npm run release:preflight
npm run desktop:package
npm run desktop:verify-bundle
npm run verify:release
```

The builder resolves that exact valid Developer ID Application identity. It signs the bundled Node, native PTY module and helper before the app, enables Hardened Runtime with secure timestamps, explicitly replaces upstream entitlements, and verifies the result. Only Node receives the JIT entitlement; host/helper/module receive no exceptions. The DMG is signed and its signature/team/timestamp verified separately. Production dependencies still come from the integrity-pinned npm lockfile with installer scripts disabled. A real PTY/SQLite smoke test remains a hard gate.

This build is signed but **not yet notarized**. Never advertise it as notarized based on a successful `codesign` invocation. Review and retain the report; previous local artifacts remain under `dist/.previous-release-*`.

## Explicit, resumable notarization

Preparation copies the signed app to an isolated retained job beneath `dist`, verifies its signature and digests, and archives it. It performs no upload:

```sh
npm run release:notarize -- prepare
```

Copy the returned absolute `job` path into a task-specific variable. Then execute each reported next step:

```sh
export NEXUS_NOTARY_PROFILE=nexus-release
NEXUS_RELEASE_JOB='/absolute/path/printed/by/prepare'
npm run release:notarize -- submit-app "$NEXUS_RELEASE_JOB"
npm run release:notarize -- check-app "$NEXUS_RELEASE_JOB"
# Repeat check-app later only while status is In Progress.
npm run release:notarize -- package-dmg "$NEXUS_RELEASE_JOB"
npm run release:notarize -- submit-dmg "$NEXUS_RELEASE_JOB"
npm run release:notarize -- check-dmg "$NEXUS_RELEASE_JOB"
# Repeat check-dmg later only while status is In Progress.
npm run release:notarize -- finish "$NEXUS_RELEASE_JOB"
```

`submit-app` and `submit-dmg` explicitly upload executable artifacts to Apple. Checking status and stapling also contact Apple's services. No command loops indefinitely or implicitly resubmits. Commands reject out-of-order execution; Invalid/Rejected/unknown statuses never progress. Review `app-notary-log.json` and `dmg-notary-log.json`, including warnings, even after acceptance.

The job pins the app's CodeDirectory hash, archive/disk-image SHA-256, submission IDs and Apple's matching log SHA-256. It staples the accepted app before creating the DMG. Finish preserves the originally submitted DMG and staples a separate final copy, validates tickets/signatures, and assesses app and DMG with Gatekeeper. Only after every check passes is a final report written with `notarized: true`. The signed internal manifest remains unchanged with its original pre-notarization status.

**Use the final paths printed by `finish`**, especially the DMG under `JOB/release/`; the original `dist` DMG and job-root submitted DMG are not the final stapled download. Rerun the release rehearsal with all three explicit paths, then follow [clean-device testing](release-testing.md). Gatekeeper acceptance on the development Mac alone is not an end-user first-launch test.

### Interrupted or rejected submissions

Each upload atomically saves and flushes an intent before making a network request. If the command fails before it can record Apple's submission ID, the job deliberately blocks another upload. Inspect `xcrun notarytool history --keychain-profile nexus-release --output-format json` and matching `info`/`log` output to reconcile the intent and artifact digest manually; do not clear the intent or retry blindly. After power loss or filesystem failure, reconcile Apple's history even if local evidence appears incomplete. This ambiguous-upload recovery is intentionally operator-assisted, not automated. Retain the job for evidence; prepare a new candidate only after the prior submission's disposition is understood.

A crashed command may leave `JOB/.step-lock`. Confirm the exact job has no live command before removing that empty lock directory manually. Never delete a lock owned by a running process. Do not alter `.app` contents after signing; fix source and build a new candidate instead. Failed jobs and prior artifacts are retained, not recursively purged by this workflow.

## Remaining gates

Live Developer ID signing, hardened PTY loading, Apple submission/acceptance/stapling and Gatekeeper checks have not been exercised here. The notarization state machine uses synthetic tests with mocked command responses; those cannot prove Apple will accept the binaries. Clean machines, Intel hardware, the declared minimum macOS, actual cross-version upgrades, accessibility and a consented multi-day pilot remain separate evidence requirements. Do not add release credentials or upload jobs to pull-request CI.

This workflow follows Apple's [notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [custom command-line workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) and [JIT entitlement guidance](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.allow-jit).
