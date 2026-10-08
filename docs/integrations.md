# Integration review

Reviewed source READMEs and selected interface files on 2026-10-04. These are compatibility assessments, not audits of every upstream source file. Nothing in a repository’s popularity or license establishes that its code is safe. See the machine-readable [catalog](../integrations/catalog.json) for all requested projects and their actual status.

## Additional candidates reviewed on 2026-10-07

The highest-value immediate improvement is NexusIDE's own `nexus skills scan` pre-import review. It flags a short list of suspicious code and instruction patterns with file/line references; it does not execute package code and is not equivalent to a full security scanner. NVIDIA's [SkillSpector](https://github.com/NVIDIA/skillspector) is a stronger optional reference for future scanner coverage, but its own CLI/runtime should be separately installed and reviewed before use.

| Project | What NexusIDE can reuse | NexusIDE adaptation | Priority/status |
| --- | --- | --- | --- |
| [UI Skills](https://github.com/ibelick/ui-skills) | Individual UI design-engineering skills | Make selected skills opt-in per agent; scan full packages and preserve references/license/provenance. | High; next skill candidate |
| [Garden Skills](https://github.com/ConardLi/garden-skills) | MIT skill packages for web and video workflows | Select one UI skill and one film skill only after inspecting their scripts and references. | High; candidate pool |
| [no-ai-slop](https://github.com/petergyang/no-ai-slop) | Writing/editing patterns that preserve writer voice | Imported at commit `000650b156983f5159695b441477f4e63b25dc85`, including its evaluation file and MIT license. Assigned only to the `writing-editor` agent, which requires approval for file writes. | High; imported and assigned |
| [book-to-skill](https://github.com/virgiliojr94/book-to-skill) | Local extraction and conversion workflow | Add a reviewed converter that emits an ordinary scanned skill bundle; never execute book content as code or bypass source rights. | Medium; inspect helpers first |
| [SkillSpector](https://github.com/NVIDIA/skillspector) | Security checks and risk taxonomy for skill packages | Expand the native scanner's tested indicators or offer a separately installed scanner adapter. Current `nexus-static-v2` is narrower and does not execute package code. | High; native scanner shipped, coverage limited |
| [prompts.chat](https://github.com/f/prompts.chat) | Prompt discovery/content | Add a user-curated prompt library with source/license metadata and explicit import, rather than representing prompts as executable agents. | Medium; no code yet |
| [system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks) | No package to adopt | Exclude leaked prompt content; use only general threat-model lessons and independently authored defenses. | Rejected |
| [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | Provider/API abstraction ideas | Compare adapter/auth semantics against NexusIDE's existing providers; add an adapter only for tested capabilities. | Medium; architecture review |
| [Understand Anything](https://github.com/Egonex-AI/Understand-Anything), [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp), [CodeGraph](https://github.com/colbymchenry/codegraph) | Code graph and codebase memory | Pick one optional provider behind MCP; expose explicit index/query grants and avoid redundant indexes. | Implemented locally; codebase-memory v0.11.0 verified |
| [Hyper-Extract](https://github.com/yifanfeng97/Hyper-Extract) | Knowledge-graph extraction for research material | Optional research MCP backend if lexical memory and Research Harness prove insufficient. | Low; defer |
| [REA](https://github.com/morluto/rea) | Reverse-engineering workflows and tools | Optional isolated security workspace; keep native binaries and MCP grants outside core defaults. | Low; separate setup |
| [ML-AI-Projects](https://github.com/pablorod11/ML-AI-Projects) | Selected notebook examples | Curate examples as references after checking code, dependencies, data and licenses; don't treat notebooks as agents. | Low; reference only |
| [Freebuff](https://github.com/CodebuffAI/freebuff) | Potential independent coding worker | Connect through a narrow command/ACP adapter with its own permission boundary and data review. | Low; not needed in core |
| [Voicebox](https://github.com/jamiepine/voicebox), [VoiceStudio](https://github.com/debpalash/VoiceStudio), [OpenVoice](https://github.com/myshell-ai/OpenVoice) | Voice input, speech generation, dubbing/model backends | Add optional film-workflow connectors for local media processing; keep model downloads, voice consent and each license explicit. | Medium for movie hobby; separate apps |
| [Video Summarizer AI](https://github.com/Muhammad-Abdullah-Waheed/video-summarizer-ai) | Possible video summarization pipeline | Evaluate as an input adapter after verifying its source, dependencies and privacy behavior. | Deferred; source details unverified |
| [Nexu.io projects](https://github.com/nexu-io) | Different projects under one organization | Select an individual repo such as open-design or html-video and adapt as an optional creative tool, not an organization-wide install. | Medium for movie hobby; repo selection pending |
| [Capacitor](https://github.com/ionic-team/capacitor) | Native shell for the existing web dashboard | Consider a mobile companion after dashboard workflows stabilize; it does not add agent capabilities. | Later interface phase |

The next build steps are: choose one UI skill from UI Skills or Garden Skills, expand the static scanner's rules with tests before accepting more packages, and add a reviewed media adapter for the movie-studio team. Provider-framework replacement, leaked prompts, bulk prompt ingestion, and multiple overlapping code graphs are not good next steps.

## Installed in this workspace

Five [Agency Agents](https://github.com/msitarzewski/agency-agents) definitions were imported at commit `83294689da3832c0a9f223221148c411fd3eacc0`: software architect, frontend developer, code reviewer, multi-agent systems architect, and data engineer. Instructions are preserved; NexusIDE assigns read-only permissions. Source URL, commit, original text, digest and license are recorded in `.nexus/imports`.

Three [scientific skills](https://github.com/k-dense-ai/scientific-agent-skills) were imported at `154988403bb5a18e9d3c0ce4e6d5e2e4b184a298`: statistical analysis, literature review and peer review. They are assigned to the corresponding research agents. Supporting files are retained as resources; Python packages and scripts were not executed.

[Diagram Design](https://github.com/cathrynlavery/diagram-design) was imported at `f903933a534ba92cde1c85a28186267b3a317bb2` with its references and assets. Assign `diagram-design` in an agent’s `skills` list to use it. Its styling setup instructions still apply when producing a diagram.

The defensive [indirect prompt injection skill](https://github.com/mukul975/anthropic-cybersecurity-skills) was imported at `54a798831d2266a3ca61ce68a7acb80b81160d57` and assigned to `security-reviewer`. It is guidance, not an active content scanner. Its model dependencies have not been installed. Runtime permissions do not depend on a detector’s judgment.

## Tool services

[Research Harness](https://github.com/reubebe/research-harness) was reviewed through authenticated GitHub access and installed in a project-local Python environment. A synthetic empty project was configured, and NexusIDE connected through its worker MCP server, discovered four explicitly granted evidence readers, and called `list_sources` successfully. Its receipt is `.nexus/verification/research-harness.json`. This verifies local transport and grants, not a complete research workflow. For real work, create/select the intended paper project and review its data and manuscript release steps; human attestation remains outside NexusIDE’s grants.

[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) is the selected optional code graph. Configure its allowed root and grant only required tools. [CodeGraph](https://github.com/colbymchenry/codegraph) is an alternative. codebase-memory-mcp v0.11.0 is now installed locally with checksum and GitHub build-attestation verification. Its MCP handshake, synthetic indexing, function search, caller tracing and root containment passed live checks. The read-only `codebase-navigator` agent uses a source-only index; see [code graph setup](codegraph.md). CodeGraph remains an alternative and is not installed. Native bounded text search already works without either service.

[Browser Use](https://github.com/browser-use/browser-use) fits the browser tool layer through MCP. Use a dedicated browser profile; do not assume a browser tool’s domain setting is an enforced network sandbox. [Agent Reach](https://github.com/Panniantong/agent-reach) can extend source coverage as a separately installed command integration. Its broad setup and account requirements are not part of core installation.

[agentmemory](https://www.agent-memory.dev) and [OpenViking](https://github.com/volcengine/OpenViking) are optional memory/context services. NexusIDE already has scoped local notes and lexical retrieval. Semantic/vector retrieval requires a separately configured backend; it is not silently simulated by the native search. OpenViking’s components have different licenses, so it is kept outside the core distribution.

## Hobby workspaces

`nexus packs install` provides `trading-research` and `movie-studio` teams, alongside the research team. Their workflows execute through the same runtime, memory and approval interfaces.

[TradingAgents](https://github.com/tauricresearch/tradingagents) is an optional independent research engine. A live integration requires its Python environment, chosen model credentials and market data access. NexusIDE’s team can plan experiments and review supplied reports now. No brokerage connection or order placement is implemented.

[OpenMontage](https://github.com/calesthio/OpenMontage) is an optional production application with media tooling, pipeline assets and provider dependencies. The movie team can develop stories, shot lists and editing plans now; actual OpenMontage rendering requires its separate runtime. Its code is not vendored into NexusIDE.

## Other reviewed sources

[Claude Plugins Community](https://github.com/anthropics/claude-plugins-community) is a marketplace mirror. A selected plugin’s Markdown agents and standard skill directories can be imported; vendor hooks, binaries and lifecycle semantics are not automatically supported.

[gstack](https://github.com/garrytan/gstack) provides product, design and QA workflows. Its instructions are candidates for selected skill imports; its browser/runtime setup requires separate review. [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) is an optional independent command worker rather than a core runtime dependency. [Awesome Harness Engineering](https://github.com/walkinglabs/awesome-harness-engineering) is a reference collection.

The [ECC-Tools](https://github.com/ECC-Tools) organization API exposed only `.github` at review time; no executable integration was selected from that organization URL.

## Security review approach

[Anthropic’s security review action](https://github.com/anthropics/claude-code-security-review) informed review areas: authorization, injection, data exposure, dependency risk, and races. Its own README warns that it is not hardened against prompt injection. We did not enable its PR-commenting workflow or send repository content to a paid review service.

NexusIDE instead enforces explicit grants and action approvals in code, validates imported data, protects local HTTP endpoints, records provenance, and tests negative paths. Those controls reduce specific risks; they do not establish immunity to prompt injection or hostile local processes.

## Installed skill re-evaluation

All six installed skills passed stored-content integrity checks on 2026-10-07. The v2 scanner inspected all their text resources. Literature-review produced 13 medium indicators: optional schematic scripts search parent directories for `.env` files and make external API requests. Those scripts remain stored resources without execution grants. Peer-review produced two medium indicators in text explicitly forbidding credential access and documenting removal of network helpers; these are contextual false positives. The other four packages had no matching indicators. These observations are limited static checks, not full upstream security audits.
