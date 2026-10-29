// Ignore stale directory responses and retain the displayed path on failures.
export function createFileBrowser(api) {
  let request = 0;
  return {
    path: '.', entries: [],
    async open(path = this.path) {
      const current = ++request;
      try {
        const result = await api('files?path=' + encodeURIComponent(path));
        if (current !== request) return false;
        this.path = path; this.entries = result.entries;
        this.metadata = result.metadata || []; this.truncated = result.truncated === true;
        return true;
      } catch (error) {
        if (current !== request) return false;
        throw error;
      }
    },
  };
}

// Keep a saved snapshot separate from the draft, including during async requests.
export function createFileEditor(api) {
  return {
    path: null, hash: null, saved: '', draft: '', busy: false, loading: false,
    get dirty() { return this.path !== null && this.draft !== this.saved; },
    async open(path, discard = false) {
      if (this.busy) throw new Error('Wait for the current file request.');
      if (this.dirty && !discard) throw new Error('Save or discard your edits before opening another file.');
      this.busy = this.loading = true;
      try {
        const file = await api('file?path=' + encodeURIComponent(path));
        this.path = path; this.hash = file.hash;
        this.saved = this.draft = file.content;
      } finally { this.busy = this.loading = false; }
    },
    async save() {
      if (!this.path) throw new Error('Select a file first.');
      if (this.busy) throw new Error('Wait for the current file request.');
      const content = this.draft;
      this.busy = true;
      try {
        const result = await api('file', 'PUT', { path: this.path, hash: this.hash, content });
        this.saved = content; this.hash = result.hash;
      } finally { this.busy = false; }
    },
  };
}
