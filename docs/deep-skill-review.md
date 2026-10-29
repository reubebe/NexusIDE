# Deeper skill review

Nexus keeps its fast native scanner and can run a separately installed, reviewed SkillSpector CLI against the same skill snapshot. Import never executes helper scripts. Neither scanner certifies safety, changes runtime permissions, nor establishes publisher authenticity.

The adapter uses the [SkillSpector 2.12.0 CLI and JSON report contract](https://github.com/NVIDIA/skillspector/blob/a5425e594d59a14c3d3eaa39e26847613ba08696/src/skillspector/cli.py). It accepts an absolute executable path, writes a private temporary copy of the bounded skill bundle, and removes that copy after the scan. The original source is unchanged. The optional environment is not bundled into the DMG and is never installed automatically. Review and install that dependency in its own environment following the upstream instructions before configuring it.

## Scope and data transmission

- The default is static, offline review. On macOS, `sandbox-exec` denies the scanner's network access. Platforms without the supported offline isolation return **unavailable** rather than silently enabling network. This is network isolation, not a complete filesystem sandbox; select a trusted scanner executable.
- Upstream `--no-llm` still attempts OSV dependency queries. Network must be explicitly enabled to allow those queries. Offline OSV fallback is limited and is not a current vulnerability-database check.
- Model analysis needs a separate explicit selection: `llm: true`, `network: true`, provider, model, and endpoint. Nexus supports `ollama` and `openai_compatible` for this adapter. The endpoint must use HTTPS, except HTTP on loopback. A remote compatible endpoint also requires an explicitly named credential environment variable. Skill contents can be sent to that endpoint.
- Only the selected model credential is forwarded, under SkillSpector's expected variable. Other provider secrets, inherited model settings, and tracing settings are not forwarded. The scanner gets a temporary home and working directory. No transitive fetch or author-provided suppression baseline is enabled.
- Timeouts default to 120 seconds and are capped at 600 seconds. Process output is capped at 100 KB and reports at 2 MB. A failed process, malformed or oversized report, missing coverage, skipped files, failed model analysis, or findings beyond the 500-item display limit cannot produce a clean completed result. Findings remain visible even when coverage is incomplete.

## Shared comparison probes

Run the native scanner and record optional-backend availability without installing anything:

```sh
node scripts/compare-skill-scanners.js --save
```

Compare both scanners after configuring a reviewed executable:

```sh
node scripts/compare-skill-scanners.js --command /absolute/path/to/skillspector --save
```

That command is offline by default on macOS. Add `--network` only when dependency names and versions may be sent to OSV. To explicitly evaluate a local model as well:

```sh
node scripts/compare-skill-scanners.js --command /absolute/path/to/skillspector \
  --network --llm --provider ollama --model YOUR_LOCAL_MODEL \
  --endpoint http://127.0.0.1:11434/v1 --save
```

`--api-key-env NAME` selects a credential for an `openai_compatible` endpoint without placing the secret in command arguments. `--timeout-ms` adjusts the bounded per-probe timeout. `--save` stores the report at `.nexus/verification/skill-scanner-comparison.json`; without it, output goes to stdout. A configured deeper backend that cannot complete causes exit status 1.

The six synthetic probes contain ordinary writing instructions, a benign warning about `eval`, remote shell text, instruction override text, a Python credential-transfer example, and encoded execution text. They are inspected as data and are never executed. The native baseline detects two of the four labelled risky examples, flags the benign `eval` warning, and misses two risky examples. Those results demonstrate known boundaries of its seven pattern groups. They are not a representative accuracy estimate. Missing or incomplete deeper scans are reported separately and excluded from classification; a fake test executable is never used as benchmark evidence.

On 27 October 2026, the real SkillSpector 2.12.0 executable from the pinned revision above was installed in a separate temporary Python 3.12 environment and run through this adapter with network denied and LLM analysis disabled. All six reports completed. On these probes it flagged all four risky cases and neither benign case, including the two cases missed by the native scanner. Each scan took approximately 3–6 seconds on the development Mac. This small result supports the deeper adapter's usefulness; it does not establish general accuracy, broad performance, scanner equivalence, semantic-model quality, or current dependency-CVE coverage. The saved local receipt is `.nexus/verification/skill-scanner-comparison.json`; that generated verification state is not bundled or committed.

## Programmatic interface

`deepScanSkill(directory, options)` reads a local bundle with Nexus's existing link, size, and frontmatter checks. `deepScanSkillFiles(files, options)` accepts the canonical base64 resource map from a verified installed skill. Both return the snapshot digest, timestamp, sanitized options, native findings, and the deeper result with its normalized findings, coverage, version, model execution metadata, and original parsed report when valid. The functions do not import the skill or persist the report automatically. `compareSkillScanners(options)` runs the same labelled corpus through both paths.

For installed skills, the caller must use `loadSkill` first to enforce the saved integrity check. Errors in caller options or invalid input are rejected before process launch. Scanner/environment failures return **unavailable** or **incomplete** alongside the native result. Render report strings as text; findings are untrusted source-derived content.
