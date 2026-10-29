# Advanced agent workflows

Nexus 0.3.0 adds seven native agent definitions and three staged workflows. In **Agents**, select **Add bundled agents and teams** to upgrade an existing project without replacing customized definitions. New project initialization includes them automatically. Select an agent or **Team · …** in Tasks, choose a model in Connections, and turn off Offline demo for real inference.

These are Nexus adaptations of the design ideas below, not embedded copies of the upstream applications. No claim of superior performance or full feature parity has been measured. Role instructions guide a model; permissions and tool validation enforce its actual access.

| Reference | Nexus agent | Practical workflow and extra checks | Dependencies and limits |
|---|---|---|---|
| [Filee](https://github.com/KnifeLemon/Filee#command-line) | `file-converter` | Inspect selected inputs, propose a local conversion, preserve originals, record output and fidelity checks. | Install Filee separately or use a verified installed converter. Commands require explicit task command access and approval. Filee's format engines are not bundled. |
| [Open Notebook](https://github.com/lfnovo/open-notebook) | `evidence-notebook` | Source inventory, claim-to-source ledger, disagreements, synthesis and approved Markdown/graph output. | Text can be read directly. PDF/audio/video parsing needs an explicitly configured tool or existing text export. No SurrealDB, podcast service or embedding engine is implied. |
| [DeepTutor](https://github.com/HKUDS/DeepTutor) | `learning-tutor` | Evidence retrieval, worked explanation, separate checking pass, diagnostic question and rubric, optional conceptual visualization. | No automatic mastery scoring, persistent student model or upstream learning platform. Synthetic examples must be labeled. |
| [Helix Foundry](https://github.com/HelixDB/helix-foundry) | `ontology-designer` | Entity/schema mapping, row or quote lineage, ambiguity and duplicate checks, reviewable graph preview. | The graph is a Nexus visualization. HelixDB ingestion and remote databases require separate configuration and authorization. |
| [OpenQodex](https://github.com/openqodex/openqodex) | `change-verifier` | Check changed code and callers, verify finding quotations, explain triggers, record coverage and refute unsupported findings. | Read-only. No scanner installation, push gate or automatic Git action. Separate stages are not proof of model independence. |
| [METATRON](https://github.com/sooryathejas/METATRON) | `security-analyst` | Passive source/report review, exploit prerequisites, severity, remediation and regression evidence. | Read-only; no active target scans, Parrot toolchain, model download or MariaDB. A version banner alone does not confirm a CVE. |
| [claude-video](https://github.com/bradautomates/claude-video) | `video-evidence-reviewer` | Approved local edit previews, timestamped cut frames, existing caption review and evidence timelines. | `ffmpeg`/`ffprobe` for previews; explicitly configured speech/vision tools for transcription or image interpretation. No silent cloud upload or whole-video coverage claim from sampled frames. |

The upstream README pages and repository license metadata were reviewed on 2026-10-29. Filee, Open Notebook, METATRON and claude-video declare MIT; DeepTutor and Helix Foundry declare Apache-2.0. Nexus ships original role instructions, not upstream code or model weights; consult each upstream license before a separate installation or redistribution.

## Teams and verification

- `evidence-learning`: inventory and evidence ledger → checked lesson → citation and coverage review.
- `ontology-review`: ontology and optional graph → source-lineage review.
- `evidence-review`: correctness and security review → evidence reconciliation.

Each stage is a separate persisted Nexus run with upstream reports passed as untrusted context. Models can be assigned by agent in Connections. Shared models/providers are disclosed as a limitation; these teams do not claim the stronger independence or exact-push gate of the optional `independent-review` integration.

The new `preview_media_edit` tool reuses Nexus's validated media workflow: supported local containers, bounded clips/duration, hashes of originals, a new output directory, a command receipt and cut-boundary frames. It requires **both write and execute permissions**, task command access, host command mode and explicit render approval. It refuses container mode instead of escaping that boundary. A completed render remains pending human editorial review. It neither transcribes speech nor sees images.

Example tasks:

- `evidence-notebook`: “Use notes.txt and findings.md to create a source ledger and synthesis in notebook.md. Identify disagreements.”
- `learning-tutor`: “Teach the method in methods.md, check the worked example, then give three practice questions.”
- `ontology-designer`: “Map the entities in schema.sql and notes.md. Preview extracted and inferred relationships separately.”
- `video-evidence-reviewer`: “Prepare a preview of clip.mp4 from 0–3 seconds followed by 5–8 seconds. Preserve the original and list the cut frames for review.”

Installation, non-overwrite behavior, tool permissions, denied approvals and synthetic team execution have automated coverage. These checks establish orchestration behavior, not the factual quality of live model responses. Upstream services and real subscription accounts were not exercised in this release validation.
