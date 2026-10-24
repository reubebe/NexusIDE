# Offline harness improvement review

[Google Research RRSI](https://github.com/google-research/rrsi/tree/be50316e1db05914068a973f322770ef08ed7ba1)
studies improving an agent's harness while controlling overfitting, evaluation
noise, edit complexity and inference cost. Nexus adopts a small offline evidence
gate. It does not install RRSI, run its benchmarks, evolve its own source, or copy
upstream implementation. This is not a reproduction of the paper's algorithm or
results. The reviewed repository uses Apache 2.0 with separate third-party terms.

```sh
nexus harness evaluate /absolute/path/evidence.json
```

Use [the synthetic example](../examples/harness-evaluation.json) to learn the
format in a disposable initialized workspace. Its scores and revisions are made
up for demonstration; they are not measurements of Nexus. For real changes,
record actual Git revisions and collect paired baseline/candidate measurements
under the same model and task conditions. Pick cases and thresholds before
looking at candidate results. Keep development and held-out cases distinct, use
a final independent held-out assessment, and avoid repeatedly tuning against the
same held-out cases. This command cannot verify those experimental practices.

The version 1 file contains:

- `experiment`, `baselineRevision`, `candidateRevision`, and a concrete `hypothesis`.
- `edits`, each with a `component` and `description`; at most three may pass.
- `review`, containing `reviewer`, `leakageChecked` and review `notes`. This is a
  supplied human/reviewer attestation, not an automatic source-code critic.
- `trialsPerCase` from 3–20, and 6–100 `cases`, at least three per split.
- Each case has a unique `id`, `split` (`development` or `heldout`) and matching
  `baseline`/`candidate` trial arrays. Each trial records `score` (0–1), total
  `tokens` (input plus output), and `criticalFailure` (boolean). Use `null` for a
  missing trial; the denominator stays fixed and incomplete evidence cannot pass.

Nexus uses equal case weights and paired trials. Both splits must improve by
more than the larger of 0.02 and a conservative 1.96× standard-error heuristic
combining variation between case gains and within paired repeated trials. This
is a screening rule, not a calibrated statistical confidence claim. Candidate
critical failures reject the proposal. Each split's tokens may grow by at most
10%, and any proportional cost increase must be smaller than its proportional
score improvement. The fixed policy is printed in every report.

The first submission pins the baseline measurements and case/split manifest for
that experiment and baseline revision. A later changed baseline or dropped case
is rejected. Normalized hypotheses are remembered; a repeated one returns the
old report without re-evaluation. A deliberate new experiment can reset this
local ledger, so it does not enforce scientific independence or resist tampering.

Reports live under `.nexus/harness-evaluations` with evidence hashes, measured
summaries, reasons and attribution. No raw task transcripts are saved. Input is
bounded to 1 MB and linked files are refused. Known environment secrets are
redacted from persisted report prose. `eligible-for-human-review` means supplied
numbers passed this policy; it neither verifies the measurements nor approves
deployment. Rejections and duplicate submissions return CLI exit code 1.
