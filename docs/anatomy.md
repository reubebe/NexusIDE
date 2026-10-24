# Optional technical illustrations

Nexus ships a compact, attributed adaptation of
[Anatomy](https://github.com/wheresryan22/anatomy), not the complete upstream skill.
It adds reusable isometric SVG authoring resources for documentation, explanations,
and research figures. It does not perform code analysis or replace the Code map.

## Install in a workspace

From the Nexus source folder:

```sh
npm start -- extras install anatomy
npm start -- skills audit anatomy
```

For another project use `nexus extras install anatomy` from that project. The
command imports the bundled skill and installs the optional agent. It keeps
existing records and does not execute scripts. For manual import use `nexus skills
import` and `nexus install` with absolute paths to the resources above. For a macOS
bundle, the bundled paths are under `NexusIDE.app/Contents/Resources/app/`.
Existing customizations must be reviewed before an update.
The source revision, original license, and copied-file hashes are recorded in
`integrations/anatomy/provenance.json`.

Choose **technical-illustrator** in the workspace and configure its model in
Connections. For example: “Create a static SVG explaining our queue's maximum
capacity. Use example values, clearly labeled, and save it in the existing docs
folder.” The agent can write approved files but cannot run commands by default.

## Included capabilities

- A dependency-free SVG geometry kit and its light/dark styles.
- A complete dial-indicator example with pointer and keyboard interaction,
  reduced-motion handling, and a readout derived from the same geometry model.
- Short Nexus-specific instructions covering source evidence, output handling,
  attribution, privacy, and honest validation claims.

All imported text resources fit Nexus's per-resource read limit. The subset is
small enough for the existing skill importer; the upstream PDF/gallery/large HTML
assets are omitted. No cloud, browser, package install, or script runs on import.
The full upstream WebGL, 3D, printing, browser-capture, and publishing tools are not
included. This integration does not claim an arbitrary generated figure is accurate.

## Try the supplied example manually

Copy `integrations/anatomy` into a separate work folder, then from that copy run:

```sh
node examples/dial-indicator/build.mjs --light
```

Open the generated `examples/dial-indicator/dial-indicator-light.html` in a browser.
No server or network connection is required. It is an educational gauge with
pixel-based values. The command replaces its derived HTML if rerun.

Resources imported into `.nexus` remain encoded skill data; the agent must read
and write requested resources through its granted tools before building a new
artifact. An installed skill does not itself provide a browser, filesystem path,
or execution permission. The full example needs its relative directory layout;
prepare output directories manually or grant a separate permitted setup operation.
