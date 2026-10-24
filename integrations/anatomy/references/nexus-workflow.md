# Using the illustration kit in Nexus

Install the bundled skill with `nexus skills import /path/to/integrations/anatomy`,
then install the optional `technical-illustrator` agent. Import records a content
digest and scanner findings. Import never executes the example, installs packages,
or grants additional tools.

The agent can fetch the stored files using `read_skill` with `name: anatomy` and
the relative resource path listed in SKILL.md. Every resource in this subset fits
the current 100 KB text-resource limit. A context budget may still require loading
the kit and example in separate steps.

For a new diagram, agree on the intended artifact location and choose existing
directories: the standard file writer does not create directories. Preserve the
relative `kit/`, `scripts/`, and `examples/dial-indicator/` layout when copying the
complete example. For a smaller custom build, use an explicit import from the
copied kit, or produce static SVG from the inspected helper functions.

The complete example uses only Node built-in file/path/URL APIs and the local kit.
It writes the HTML beside its builder. Re-running the builder replaces that derived
HTML. Work in a disposable copy when exploring; keep originals and user artwork.

The helper `pageHtml` embeds arbitrary caller-supplied `body` and `script` markup
by design. These are authoring APIs, not HTML sanitizers. Do not feed untrusted
source text into markup or JavaScript; use escaping or textContent for text. Only
preview a generated HTML artifact after reviewing its script. Nexus does not embed
generated HTML into the authenticated dashboard.

Readout values in the example are pixel-based geometry, not scientific calibration.
Replace the model and label units appropriately for a real measurement. Default
animation can be disabled using the operating system's reduced-motion setting;
arrow keys, Home, and End move between the three gauge blocks.
