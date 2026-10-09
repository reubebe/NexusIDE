# Managed integration lifecycle

Phase 3 applies to the managed TradingAgents and OpenMontage runtimes. It does not turn arbitrary MCP servers, imported skills or external programs into managed installations. No user runtime is reinstalled automatically.

## Commands

```sh
nexus integration status
nexus integration install openmontage
nexus integration configure openmontage
nexus integration upgrade openmontage
nexus integration rollback openmontage
nexus integration unconfigure openmontage
nexus integration uninstall openmontage
```

`install` is an explicit request to run third-party setup code with your account permissions. It is idempotent for a ready current pin. `upgrade` builds the **reviewed catalog revision**, not an arbitrary upstream latest commit. Upgrade, configuration, rollback, removal and recovery require interactive confirmation; non-interactive CLI calls decline. `configure` shows the target agent, execution grant and requested environment-key names. It never copies credential values. Application calls still need their existing per-action approval and execution permission.

Upgrades stage a new checkout and virtual environment in a unique directory. The active pointer changes only after source and executable checks pass. Python virtual environments have absolute paths, so neither existing installations nor staged versions are moved when activated. Older and failed versions are retained. Installer output is not saved in lifecycle metadata, and a failed upgrade preserves the prior active version.

## Verification and locking

Every status/launch verifies the allowed Git origin and reviewed revision, repository location and the content/type/mode of each tracked source file against its Git object hash. This also catches modifications hidden by `assume-unchanged`; a matching HEAD alone is insufficient. Symlinks at managed root, metadata, version, Git and environment boundaries are refused. Tracked source symlinks must match the reviewed tree. Unsupported submodules fail verification.

A per-integration lease prevents an install, upgrade, rollback or removal from overlapping another lifecycle operation or approved run. Owner and subprocess IDs are recorded. Unknown/live owners block recovery. After a crash:

```sh
nexus integration status openmontage
nexus integration recover openmontage
```

Recovery removes only an unchanged lock whose recorded processes are absent and marks interrupted staging failed. It does not replay installers, execute a runtime or delete its files. Inspect preserved staging/output before deciding what to do next. A forced process kill can still leave external subprocesses or partial state; this mechanism is not an OS sandbox.

## Rollback, grants and removal

`rollback NAME [VERSION-ID]` selects a retained ready version and verifies it again against the current reviewed catalog. A historical revision must remain explicitly allowed by the catalog. Status lists version IDs. Rollback is not a bypass for a revoked or modified source revision.

`uninstall` is recoverable disablement: it clears the active selection but retains source, virtual environments and generated outputs. The managed runner refuses launches while disabled. `rollback` restores a retained version. Disk-space cleanup is deliberately manual; the CLI does not recursively delete user runtime/output folders.

`unconfigure` revokes the named project application and agent membership. A grant journal supports recovery from partial setup. It restores an execution permission only if configuration originally granted it and the agent has no other application memberships. Modified application profiles are not silently overwritten or removed. Credentials, other project settings and runtime files are preserved. To revoke a legacy profile with no journal, general execute permission is conservatively left unchanged.

On macOS, legacy runtimes stay under `~/Library/Application Support/NexusIDE/runtimes/NAME`. New lifecycle state and immutable-location versions live beside them in `NAME.nexus-lifecycle/`. Project grants remain in the project's private `.nexus` directory. Configuring from a relocated bundled CLI can update journaled managed profiles; custom or old unjournaled profiles that reference a source checkout may need explicit unconfiguration/reconfiguration.

## Evidence and limits

Temporary-repository tests cover staged installation, idempotence, reviewed-pin upgrades, failure preservation, rollback, recoverable disablement, interrupted setup, live locks, source tampering, unsafe paths, grant confirmation/revocation and partial grant recovery. The existing real TradingAgents/OpenMontage checkouts passed the stronger read-only source checks; no real reinstall, deletion, trading or paid media generation was needed.

Source pinning does **not** certify third-party code or every installed dependency. Python dependencies are resolved by the reviewed upstream installers; environments are not a reproducible dependency lock or a sandbox, and untracked/generated files and installed packages are not fully attested. Broader dependency/adversarial review and provider-backed integration workflows remain later validation work.
