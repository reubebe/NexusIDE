import os from 'node:os';

const gib = bytes => Math.round(bytes / 1024 ** 3 * 10) / 10;
const bytes = value => Number.isSafeInteger(value) && value > 0 ? value : null;

export function localHardware() {
  return { platform: os.platform(), arch: os.arch(), logicalCpus: os.cpus().length, totalBytes: os.totalmem(), freeBytes: os.freemem() };
}

// A file-size comparison is useful, but is not an inference-memory estimator.
// Do not infer GPU memory, context capacity, speed or tool support from a tag.
export function localModelGuidance(models, hardware = localHardware()) {
  const total = bytes(hardware.totalBytes), free = bytes(hardware.freeBytes);
  return {
    measuredAt: new Date().toISOString(),
    hardware: { platform: hardware.platform, arch: hardware.arch, logicalCpus: hardware.logicalCpus, totalGiB: total ? gib(total) : null, freeGiB: free ? gib(free) : null },
    note: 'Model download size is compared with total system RAM only. Runtime memory, context cache and other apps need additional space. Free RAM is a momentary OS snapshot, not a capacity estimate. GPU capacity, speed and tool calling are unverified.',
    models: models.map(model => {
      const size = bytes(model.size), ratio = size && total ? size / total : null;
      const status = ratio === null ? 'unknown' : ratio >= 1 ? 'exceeds-system-ram' : ratio >= 0.65 ? 'limited-headroom' : 'below-system-ram';
      const guidance = status === 'unknown' ? 'Model size is unavailable; memory needs are unknown.'
        : status === 'exceeds-system-ram' ? 'Download size meets or exceeds total system RAM. Choose a smaller model unless you have independently verified your hardware capacity.'
        : status === 'limited-headroom' ? 'Download size uses at least 65% of total system RAM. A smaller model leaves more space for context and other apps.'
        : 'Download size is below 65% of total system RAM. This leaves nominal headroom, but does not establish that the model fits or runs well.';
      return { model: model.name || model.model, downloadGiB: size ? gib(size) : null, status, guidance };
    }),
  };
}
