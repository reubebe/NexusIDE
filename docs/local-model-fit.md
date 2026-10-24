# Local model memory guidance

Choose **Connections → Ollama**, then an installed model. Nexus displays system
RAM, the model's download size and a cautious memory advisory.
The CLI offers the same information plus logical CPU count and free RAM:

```sh
nexus providers local
```

The existing bounded, read-only request to `127.0.0.1:11434/api/tags` supplies the
model size. System information comes from Node's OS API. No model is downloaded,
loaded or benchmarked, and no API key or cloud request is involved. The connection
picker still requires you to choose and save a route.

Download size below 65% of total RAM receives a nominal-headroom note; 65–100%
receives a limited-headroom note; 100% or more receives a smaller-model suggestion.
Missing size data stays unknown. These thresholds are Nexus heuristics, not
empirically calibrated recommendations. Runtime allocations, context caches,
other apps and GPU/unified-memory behavior can change the actual requirement.
The free-RAM value in the CLI is only a momentary OS snapshot. No speed, GPU fit,
context capacity or tool-call compatibility is certified.

The idea follows the local hardware guidance in
[Odysseus](https://github.com/odysseus-dev/odysseus) and its credited upstream
[llmfit](https://github.com/AlexsJones/llmfit). Nexus implements this modest advisory
directly. Neither project is bundled, installed, launched or required; no upstream
source was copied. Full GPU-aware sizing and blind model comparisons remain
future work. A second Odysseus workspace/HTTP connector is unnecessary unless
you operate a separate Odysseus instance with data Nexus should access.
