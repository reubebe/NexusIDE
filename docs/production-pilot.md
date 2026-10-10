# Security review and production pilot

Phase 7 has two different gates: technical preparation and a consented real-user pilot. Passing automated checks is preparation, not production certification. A local review is not an independent penetration test. A signed app is not proof that integrations or model-generated actions are safe.

## Bounded synthetic rehearsal

Run from the NexusIDE project:

```sh
node scripts/verify-pilot.js
```

This creates a temporary, synthetic workspace and executes 16 sequential runtime runs using an in-process scripted provider. No cloud API, Ollama model, MCP server, shell command, integration runtime, or user project is used. The fixture is removed afterward. The CLI saves only the summary to `.nexus/verification/pilot-synthetic.json`; importing `runSyntheticPilot()` does not save a project receipt.

The rehearsal verifies real runtime tool dispatch, approved and denied file writes, SQLite round-trips, injected provider failures, prose-only continuation without tool replay, cancellation, and approval-gated recovery of an injected orphan record. The orphan test is **not** an actual process-crash experiment. Three failed runs and one cancelled run are intentional; failing any expected behavior makes the receipt fail. Check `verified`, every check status, and the expected-failure counters rather than treating a completed script as a pass.

Latency percentiles measure the local fixture's runtime and storage overhead, not model latency, project indexing scale, interactive responsiveness, concurrent workloads, or a service-level objective. No token usage, costs, reliability percentage, or production readiness is inferred from the synthetic provider. A successful receipt always remains `evidence: synthetic-preproduction` and `productionReady: false`.

## Release candidate entry gates

Every gate needs dated evidence tied to the exact candidate commit, app version, architecture and artifact SHA-256. Missing, stale or fixture-only evidence is **not passed**. Rebuilds invalidate artifact-level evidence; changed security-sensitive source requires relevant checks to be rerun.

| Gate | Required evidence before a distributable pilot |
| --- | --- |
| Distribution trust | Owner's Developer ID signature, hardened runtime, notarization acceptance and stapled artifact; verify identity and Gatekeeper acceptance on the final downloaded artifact. Ad-hoc signatures are local-development only. |
| Clean installation | Fresh supported macOS account/machine with no developer checkout or preinstalled Node: install, first launch, project selection, offline behavior, terminal, shutdown, upgrade without losing `.nexus`, backup/restore and uninstall. Record OS/architecture and each result. A relocation test on a developer machine is insufficient. |
| Runtime/provider coverage | Passing unit/integration suites and the bounded rehearsal; live text/tool/structured-output checks for each provider/model actually allowed in the pilot. Fixture-only providers are excluded until live evidence exists. |
| Integration scope | Only owner-approved, pinned integrations; install/upgrade/rollback/removal checks, source validation, dependency inventory and an explicit grant review. External application execution remains host-privileged. Disable unused integrations and MCP servers. |
| Security review | Review network authentication, origins, filesystem boundaries, symlinks, secrets/log redaction, permission escalation, untrusted tool text, dependency risks, recovery and artifact integrity. Record reviewer, scope, findings, evidence, owner and disposition. No unresolved critical/high findings; no ignored/expired accepted risk. |
| Recoverability | Private backup created and restoration tested into a separate synthetic/disposable workspace; demonstrate interruption handling without replaying tools or overwriting user data. Retain the previous installer and backups until the pilot is accepted. |
| Owner consent | Named pilot owner, consenting participants, approved workspace copies/data classes, provider data policies, spending cap, allowed permissions, duration, support contact, retention/deletion policy and stop conditions agreed before real tasks. |

## Consented pilot protocol

This is a proposed protocol, not a pilot that has already happened. Do not enroll users, transmit private code, enable telemetry, buy services, grant credentials, or change workspace permissions automatically.

1. **Day 0 — scope and baseline.** The owner selects one or two non-sensitive/disposable project copies and one to three consenting users. Agree the release candidate, supported macOS architecture, selected provider/model, maximum spend and maximum run steps. Start with read-only agents; grant individual writes or commands only after inspecting them. Record pre-change repository state and a tested private backup.
2. **Days 1–2 — supervised tasks.** Complete at least ten owner-reviewed tasks covering read/explain, one small code change with independent tests, a denied write, cancelled run, restart/continuation, and approved integration use if integrations are in scope. Research tasks require source-quality review; this is not trading or medical-decision approval.
3. **Days 3–7 — bounded daily use.** Target at least 30 eligible tasks across five active days. Keep per-action approval and a human reviewer for every proposed change. Log task category, start/end time, outcome, independent verification, approvals, observed cost when available, failure/recovery category and support actions. Store no prompts, private source or credentials in shared reports. Any opt-in telemetry or external report needs separate consent.
4. **Closeout — decide and retain evidence.** Review every failed task and security/support incident, test restoration again, compare the results to the thresholds below and record the owner's go/no-go decision. Delete or retain data according to the agreed policy. A material fix produces a new candidate and repeats affected gates; do not relabel an earlier pass as evidence for new bits.

## Proposed go/no-go criteria

Agree these before starting; they are acceptance targets, not current measured results.

- All entry gates passed for the exact shipped candidate, with zero unresolved critical/high security issues and explicit owner acceptance of any lower-severity residual risks.
- Zero unapproved writes/commands/network grants, credential disclosures, cross-project access, data-loss events or duplicate tool replay. Any occurrence stops the pilot immediately, preserves private evidence and triggers investigation/rollback.
- At least 30 eligible tasks over five active days; at least 90% meet the predeclared acceptance criteria with independent tests or human review. Report cancellations, provider outages, retries and exclusions separately; exclusions and success criteria cannot be invented after seeing results.
- Every run reaches a recorded terminal state or is explicitly recovered with history intact. Every tested restore preserves the agreed data. No unexplained lost history or unrecoverable application crash.
- Owner-set latency and spending budgets met for each selected task class and provider. Report median/p95 latency and the sample count; unreported token usage/cost is unknown, not zero. A small pilot does not establish a long-term availability SLA.
- A named owner can reproduce install/upgrade/rollback and handle incidents within the support window agreed on Day 0. The final issue log, evidence locations and release decision are retained privately.

On a stop condition: stop new runs, decline pending approvals, disable the affected integration/provider, preserve logs privately, restore only from a verified backup into an explicitly selected target, and assess whether credentials need rotation. Do not automatically upload incident data, reset repositories or delete `.nexus`.

Passing this limited pilot supports a scoped release decision only. Broader operating systems, architectures, providers, sensitive research or regulated uses require separate evidence and review.
