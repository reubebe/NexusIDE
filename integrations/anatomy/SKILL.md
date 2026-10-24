---
name: anatomy
description: Create readable, interactive isometric SVG explanations from a concrete technical concept, using a small local geometry kit and an accessible dial-indicator example. Optional Nexus adaptation for documentation and research illustrations; not a code-analysis or graph-discovery tool.
license: MIT
compatibility: Nexus instruction and resource import. Node.js 22.18+ for optional builds. No network, model, or browser service is required by the supplied SVG generator.
---

# Anatomy for Nexus

This is a small Nexus adaptation of Ryan's Anatomy skill, pinned and attributed
in `provenance.json` and `LICENSE`. It includes the SVG geometry kit, style sheet,
and one complete interactive example. WebGL, 3D, PDF publishing, upstream gallery
upload tools, and the larger example collection are not included.

## Start with meaning

Identify one concept the reader needs to understand and the evidence supporting
it. Choose a familiar physical object whose operation makes that concept clear:
a gauge for a measured quantity, a rack for capacity, or a valve for a rate limit.
Describe the mapping and a short parts list before drawing. If a direct table or
code map explains the fact better, recommend that instead of adding decoration.

An illustration is explanatory, not measured execution evidence. Label hypothetical
values as examples. For real values, cite their source and drive the image, labels,
and live readout from the same model. Never invent benchmark numbers, scientific
findings, tests, or completed Nexus actions to make a visual persuasive.

## Resources available through read_skill

- `kit/iso-kit.mjs`: projection, slabs, cylinders, paths, ticks, SVG and HTML helpers.
- `kit/iso.css`: light/dark SVG styles; the kit also embeds these styles in HTML.
- `examples/dial-indicator/build.mjs`: a working physical model, layered SVG,
  keyboard controls, reduced-motion handling, and a live readout.
- `scripts/inline-kit.mjs`: supplies the example's inline browser geometry helpers.
- `references/nexus-workflow.md`: how to use these files within Nexus's permissions.

Read the relevant resource before using its API. Resources are stored data, not
automatically installed executable files. `read_skill` returns text; it does not
run scripts or create a directory. When implementing an artifact, copy only the
needed text through approved file writes into an existing user-selected output
folder, preserve relative imports, and include `LICENSE`. Do not assume the original
source checkout exists on the user's computer.

## Drawing and interaction

1. Make the subject recognizable at ordinary size. Use a few meaningful materials,
   real mounting points, and consistent isometric projection. Add detail where it
   explains the mechanism, without obscuring labels or filling empty space merely
   for decoration.
2. Paint back parts before front parts. Fit the camera to all expected positions.
   Test extremes; avoid clipped text and overlapping geometry.
3. Keep actual source-derived relationships distinct from an analogy. This kit
   draws pictures; it does not inspect repository callers, dependencies, or tests.
4. Supply a title, explanatory caption, SVG accessible name, visible keyboard focus,
   and keyboard alternatives for pointer actions. Respect reduced motion. The main
   idea should remain legible without animation.
5. Make the layout readable at narrow and desktop widths. Provide static SVG or a
   still frame when motion is unnecessary. Keep scripts and fonts local.
6. Report only checks actually performed. If browser preview or accessibility
   verification was unavailable, state that limitation.

## Execution boundaries

The optional `technical-illustrator` agent starts with file read/write access and
no command permission. Scripts require the user's normal execution authorization
and an execution-enabled agent before Nexus can run them. Never auto-install
dependencies, start a server, launch a browser, upload, publish, or contact external
services merely because a skill describes that action. Do not embed private
project content in a shareable diagram unless requested.

For a manually built example, copy this skill folder to a chosen work folder and
run `node examples/dial-indicator/build.mjs --light` there. It writes
`examples/dial-indicator/dial-indicator-light.html`. Open that file manually to
inspect the gauge. This example is a synthetic illustration, not a Nexus usage demo.
