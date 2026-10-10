# Internal release security review — 2026-10-09

This is a focused internal code review and synthetic regression exercise for Phase 7. It is **not** an independent penetration test, a certification, or approval for an unrestricted production rollout.

## Scope and method

Reviewed `src/integration-lifecycle.js`, `src/integrations.js`, `src/integration-runner.js` and `src/server.js`, with supporting inspection of process execution, Git helper suppression, bounded reads and workspace locks. The scope covers managed runtime provenance, lifecycle/recovery state, integration grants and the local dashboard's authority boundary. Existing security documentation and integration/dashboard tests were also checked.

All new reproductions used temporary repositories, temporary project state and loopback HTTP. No existing `.nexus` data, user runtime, remote provider, trading service or paid media service was changed or called. The launcher review included its argument allowlists and lease handoff; it did not execute third-party application code.

## Findings and fixes

### 1. Git replacement objects could bypass source-pin verification — fixed

A managed checkout could keep its reviewed `HEAD` object ID while a Git replacement ref substituted a different commit/tree. The verifier previously compared files against `git ls-tree HEAD`, which honors those replacements, and could therefore attest the substituted files rather than the reviewed tree.

Lifecycle source queries and checkout now pass `--no-replace-objects`. The regression creates a real substitute commit and replacement ref, confirms that an ordinary tree query is redirected while `rev-parse HEAD` remains pinned, and verifies that both status and launch reject the altered tracked source.

Exploitation required write access to the managed checkout; this was a source-attestation bypass, not an unauthenticated remote execution path. The fix does not turn Git or filesystem validation into a boundary against a malicious process with the operator's account privileges.

### 2. Dashboard configuration writes bypassed grant-transaction leases — fixed

Integration grant setup/revocation held the workspace writer lease, but dashboard configuration and agent saves did not. An overlapping save could interleave with the multi-file grant journal and overwrite one side of the transaction.

Both dashboard write endpoints now acquire the same lease. Regression requests made while another writer owns the project are rejected without changing configuration or agent permissions, and writes succeed after the lease is released. This serializes overlapping transactions; it does not add optimistic version checking to a stale configuration snapshot submitted after another transaction has finished.

### 3. Reconfiguration accepted malformed grant metadata — fixed

Unconfiguration validated ownership and permission-restoration fields, while configuration only checked the receipt's state. A corrupt receipt marked `configured` could be carried forward and leave a newly enabled integration unable to revoke its recorded grants safely.

Both paths now share validation of receipt version, integration/agent ownership, lifecycle state, profile shape and permission-restoration types before any configuration mutation. Regression cases preserve malformed receipts for inspection and confirm that permissions and application settings are unchanged.

## Evidence

`node --test test/security-release.test.js test/integration-lifecycle.test.js test/dashboard.test.js` passed **18/18 tests** on the development Mac. The three new release regressions cover the findings above. Existing tests in that run cover authentication/origin rejection, per-action approvals, stale file saves, terminal bounds, runtime staging/failure preservation, rollback, interrupted recovery, active leases, symlink boundaries and grant revocation.

These are targeted test results, not exhaustive adversarial coverage. Repository-wide and release-artifact results are recorded separately by the release workflow; this report does not infer their success from the focused run.

## Remaining limits and pilot gates

- Managed source verification attests tracked files against reviewed Git objects, not all generated/untracked files, Python packages, installer dependencies or external executables. Third-party setup and approved applications still run with host privileges. Dependency locking and a stronger execution boundary remain important before distributing integrations broadly.
- Runtime leases, PID checks and path validation coordinate cooperative processes. They cannot eliminate same-account directory replacement races, PID reuse, escaped subprocesses or compromise of the local account. Interrupted installer files are retained and never replayed automatically.
- The dashboard token grants operator-level authority, including its interactive terminal and configuration editor. It is loopback-only and intended for one trusted operator. It is not a remote multi-user service; do not forward its port or publish its bearer URL.
- Full configuration/agent saves do not yet use per-document revision tokens. Avoid parallel settings editors; the new writer lease protects overlapping operations, not every stale editor snapshot.
- Prompt-injection resistance is permission/approval-based, not a guarantee about model behavior. Provider-backed adversarial integration tests, a review of full third-party dependency trees and an independent assessment remain outstanding.
- Signing/notarization and a genuinely clean-machine test are separate release gates. A successful local security test or isolated home directory is not evidence that either gate passed.
- Begin a pilot only with explicit participant consent, disposable or backed-up non-sensitive projects, constrained integration grants, recorded artifact hashes, rollback access and a named incident owner. No real-user production pilot was started by this review.

See [security boundaries](../SECURITY.md), [managed integration lifecycle](integration-lifecycle.md) and [release phases](release-phases.md) for the surrounding constraints.
