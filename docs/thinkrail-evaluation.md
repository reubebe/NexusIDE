# ThinkRail comparison

Reviewed [JetBrains/thinkrail](https://github.com/JetBrains/thinkrail/tree/940d15ca5fb0838b9396832befd9ad60d6e51e66) on 28 October 2026. Its artifact view controls address a concrete gap in Nexus's new viewer: inspecting a dense graph or image at larger scale without losing the selected artifact.

Nexus now has bounded 25–500% zoom, Fit view and an expanded modal for existing 2D charts and images. Modifier-wheel zoom stays inside the visual region. Close or Escape returns the original view and focus; no duplicate GPU canvas is created. Spatial artifacts retain their own camera controls. This is a small native DOM implementation inspired by the interaction, not a copy of ThinkRail's React/runtime architecture.

ThinkRail's isolated worktrees, durable specifications and structured preview/review concepts also align with existing Nexus worktree, agent-memory and review workflows. Those similarities do not justify a second runtime or automatic instruction changes. Before/after artifact comparison remains a possible later enhancement, not an implemented capability in this release.

The upstream reference is Apache-2.0 licensed. Nexus does not bundle ThinkRail or execute its HTML/JS previews. Artifact schemas, path restrictions and explicit image-sharing consent remain Nexus's own boundaries.
