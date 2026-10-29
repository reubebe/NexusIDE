# Visual tools, media previews and UI review

Nexus provides optional, scoped connections for Iris, Earshot and nnInteractive, and a local edit-decision preview workflow inspired by video-use. These are adapters, not bundled installations of those projects. Setup never downloads a model or installs an upstream package. Their executables, Python environments, browsers, GPU servers and model licenses remain separately managed. The standard Nexus approval flow still applies to connections and individual calls.

## Configure a connection

Use **Visualizations → Optional tools** to inspect status and review a configuration, or the CLI:

```sh
nexus visual-tools status
nexus visual-tools preview iris iris-options.json
nexus visual-tools configure iris iris-options.json
```

Supply the absolute path of an executable you have reviewed and installed. `scope` is an existing relative project directory. The generated profile uses a Nexus MCP proxy that permits only reviewed tool names and validates file arguments. Existing, differing profiles are not replaced; review those in Connections. Existing agent customizations are retained. Status checks only inspect the executable and project scope; “available” does not establish that a Python module, browser, model, GPU server or vision model works.

| Connection | Example options file | Result and boundaries |
| --- | --- | --- |
| Iris | `{"command":"/absolute/path/to/iris","scope":".","origins":["http://127.0.0.1:3000"]}` | Creates `visual-reviewer`, granting only `capture`. Only selected starting origins are accepted, with bounded capture time/viewport. Arbitrary output paths are not exposed. Browser redirects and page subresources can contact other origins: the origin check is not a browser network sandbox. Use trusted pages and review the requested URL. |
| Earshot | `{"command":"/absolute/earshot/.venv/bin/earshot","scope":"media","cachedModels":false}` | Creates `audio-reviewer`, granting `measure` only. Needs ffmpeg/ffprobe and the upstream Python environment. `cachedModels:true` additionally grants describe, match, find, timeline, sheet and critique. Offline flags prevent automatic model downloads. Missing cached models produce an error. Cloud critique, executable synthesis recipes and automatic sound generation are excluded. |
| nnInteractive | `{"command":"/absolute/nninteractive/.venv/bin/nninteractive-agent-mcp","scope":"images","server":"https://your-gpu-server.example","allowImageSharing":true,"acknowledgeModelLicense":true}` | Creates `imaging-reviewer`, with a narrow segmentation/correction/view/save tool set and `--python off`. This adapter uses a separately managed GPU server, avoiding implicit local model downloads. HTTPS or loopback HTTP is required. Set `NN_INTERACTIVE_API_KEY` in the runtime environment if the selected server requires it; no secret belongs in JSON. |

Input paths must remain within the approved project folder and cannot be protected paths, symlinks, hard links, or files larger than 500 MB. Earshot accepts recognized self-contained WAV, AIFF, FLAC, Ogg/Opus, MP3, M4A, MP4, MOV, WebM and MKV containers; playlists disguised with a media suffix are rejected. Imaging NRRD/MHA inputs must contain their data in the same file, without external sidecar paths. Earshot sheets and segmentation saves use unique directories under `<scope>/nexus-visual-output/`; user-supplied output destinations are rejected. A third-party executable still runs with the user's OS privileges. These validation rules do not turn an untrusted executable into a sandboxed program.

The imaging acknowledgments mean that the user has reviewed where inputs and rendered images go and the applicable weight license. Official nnInteractive weights use CC BY-NC-SA 4.0; the code's Apache-2.0 license does not remove those model restrictions. Do not use private images with an unapproved GPU server or model provider. Nexus does not claim clinical validation. Rendered evidence needs a configured vision-capable provider for model inspection; displaying an image does not prove that a model saw it.

## Plan, preview and review a video edit

Prepare an edit-decision list with explicit source ranges in seconds. The current local workflow deliberately does not transcribe or upload audio. It accepts already reviewed timing decisions, so existing OpenMontage work and manually prepared transcripts remain usable.

```json
{
  "version": 1,
  "title": "Opening and demonstration",
  "width": 1280,
  "height": 720,
  "fps": 30,
  "clips": [
    { "path": "media/source.mp4", "start": 2.1, "end": 6.8 },
    { "path": "media/demo.mp4", "start": 0, "end": 8.2 }
  ]
}
```

```sh
nexus media preview edit-plan.json
nexus media review nexus-visual-output/edit-EXAMPLE review.json
```

`review.json` contains `{"decision":"accepted","notes":"Describe the playback, audio and cut-boundary checks actually performed."}` or a rejected decision with corrective notes. A review is an append-only record tied to the preview receipt digest; accepting one does not overwrite source footage or publish anything.

The preview command shows the source digests and proposed render before execution. It checks source identity after approval, probes actual durations, normalizes video dimensions/frame rate and audio layout, generates a fresh MP4 and before/after PNGs at each cut, and saves a typed timeline and receipt. Inputs are MP4/MOV/M4V/WebM/MKV, with 1–24 clips, at most ten output minutes, 1920×1080, 60 fps and 500 MB per source. Missing audio receives a silent stereo track so concatenation remains valid. Network protocols and arbitrary filter expressions are not exposed by this workflow. ffmpeg and ffprobe must be installed separately.

Outputs are retained in a fresh `nexus-visual-output/edit-*` directory, including failed-render receipts. Source footage is never replaced. Original embedded subtitles are not burned in or translated; inspect the preview and prepare subtitle work separately. Rendering and boundary extraction establish that a preview was produced, not that an edit is editorially correct or that synchronization is perceptually perfect.

## Graphify experiment

The existing Code map backend remains the default. A bounded experiment compares reviewed executables on a synthetic JavaScript corpus, records source hashes, source-linked symbol/caller evidence, elapsed time and a changed-symbol pass, and retains raw results:

```sh
node scripts/compare-graph-backends.js /absolute/path/to/graphify /absolute/path/to/codebase-memory-mcp
```

Use `-` for an unavailable backend. Graphify is invoked with `extract --code-only --no-cluster --no-dedup`; no semantic backend or provider credential is selected. The experiment does not install Graphify, change agent hooks, index a private project or adopt a second index. Its receipt distinguishes an unavailable backend from a completed comparison, and preserves schema/version fields where the upstream graph provides them. Raw edge endpoint order is retained; undirected adjacency alone is not treated as proof of call direction.

Both Graphify 0.9.96 and codebase-memory 0.11.0 completed the initial and changed-symbol/caller checks on the synthetic corpus. The measured result does not establish a gap that warrants a second index. See [the executed comparison](graph-comparison.md) for provenance, adapter corrections and limits. This small experiment is not a general accuracy, latency or token-saving benchmark.

## Curated UI checks

The Hallmark-inspired review takes objective checks while retaining Nexus styling. Run:

```sh
node scripts/verify-ui-quality.js
```

It starts a disposable project and a separate headless Chrome profile, blocks page requests to other origins, checks every dashboard tab at 360, 390, 768 and 1280 pixels, and records overflow, visible control names, sampled text contrast, reduced motion, keyboard focus, navigation preservation and browser exceptions. It captures visualization screenshots and writes `.nexus/verification/ui-quality/receipt.json`, then closes Chrome and deletes the temporary profile/project. `NEXUS_CHROME_PATH` can select an installed Chrome-compatible executable.

Review the receipt's failures and limitations. Automated checks cover synthetic states and solid computed backgrounds; they are not a full accessibility-tree audit, VoiceOver check or verification of remote integrations. Manual review should also test actual control actions, loading/error states, zoom, assistive technology, and visuals that depend on data or GPU behavior.

## Validation and upstream evidence

Focused automated tests exercise missing prerequisites, non-destructive repeated setup, tool allowlists, origin/path containment, link rejection, managed outputs and an actual MCP proxy handshake with a synthetic upstream. Real local ffmpeg tests render two synthetic color clips, verify unchanged source bytes, verify an output audio stream and distinct cut-boundary images, validate the shared timeline schema and append a review record. A separate timeout test confirms termination and retention of a failed receipt. These checks validate Nexus's boundary and local preview workflow; Iris, Earshot models and nnInteractive GPU inference were not installed or end-to-end tested.

Interfaces were checked against these reviewed snapshots: [Iris MCP](https://github.com/brijr/iris/blob/227d3109be29c87c2bed85d214c122795a640210/src/mcp.rs), [Earshot MCP](https://github.com/Leonxlnx/earshot/blob/591fa3e028032e6dce56620a20e932e35667e8d8/earshot/mcp_server.py), [nnInteractive MCP](https://github.com/MIC-DKFZ/nninteractive-agent/blob/57b06cb4bac0aedaf4946b8f4a65247d998eff6e/src/nninteractive_agent/mcp_server.py), [nnInteractive licensing](https://github.com/MIC-DKFZ/nninteractive-agent/blob/57b06cb4bac0aedaf4946b8f4a65247d998eff6e/README.md#license-and-citation), [video-use workflow](https://github.com/browser-use/video-use/blob/43cfc566833548093455c9d4a46bd69913b7e552/SKILL.md), [Graphify CLI](https://github.com/Graphify-Labs/graphify/blob/dac063456bc1f5d92354ec3936fd9dd1513a83f3/graphify/cli.py), and [Hallmark](https://github.com/nutlope/hallmark/blob/7ec868225c6caa040558c321ee0fefa0e73f83a8/README.md). An upstream interface change requires another review; a source link is not a compatibility guarantee.
