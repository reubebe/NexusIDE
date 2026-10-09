# Release phases

Work proceeds one phase at a time. Completion means the phase's implementation and checks are recorded; it does not imply production certification.

| Phase | Scope and completion evidence | Status |
| --- | --- | --- |
| 1. SQLite and incremental indexing | Transactional legacy migration, indexed history summaries, scoped notes, reusable code/document/note vectors, consistent backup, interrupted-build recovery, larger synthetic workspace and local embedding verification | Complete locally: 117 tests; 2,048-file scale probe; real Ollama reuse/ranking; VS Code run/history; private workspace backup and migration |
| 2. Provider compatibility matrix | Versioned matrix and bounded synthetic checks; validated tool batches, structured requests, limits, cancellation, sanitized errors, usage and credential isolation | Complete for selected Ollama and OpenAI targets; 164 tests. Anthropic and Gemini remain fixture-only, not live-certified. See [provider evidence](providers.md). |
| 3. Integration lifecycle | Staged pinned installations/upgrades, tracked-source verification at launch, operation leases, failed/cancelled setup recovery, retained rollback/disablement, journaled grants | Complete for managed TradingAgents/OpenMontage lifecycle; fixture transitions and real existing-source checks. Dependency attestation and broader external runtimes remain outside this scope. See [lifecycle](integration-lifecycle.md). |
| 4. Bundled macOS app | Bundled Node 22 and locked production dependencies/PTY, Finder project picker, non-overwriting setup, separate app metadata, relocatable app/DMG | Complete for local Apple Silicon development distribution: 189 tests, moved-app bootstrap/API/demo/SQLite/PTY/shutdown checks, native visual checks. Ad-hoc only, not notarized or clean-machine certified. See [distribution](desktop-distribution.md). |
| 5. Developer ID signing/notarization | Sign with the owner's Developer ID identity, hardened runtime/entitlements, notarize and staple release artifacts | Next; requires signing identity and Apple account access |
| 6. Clean-machine release testing | Test install, first launch, permissions, offline behavior, upgrades, uninstall, Intel/Apple Silicon support as selected, and restoration on fresh machines | Pending |
| 7. Security review and production pilot | Review trust boundaries and dependencies; adversarial/recovery testing; limited pilot with measurable reliability and support criteria | Pending |

Storage design, limits and recovery instructions: [Phase 1 storage](storage.md).
