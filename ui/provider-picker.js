// Keep the advanced draft and acknowledged configuration separate while requests run.
function connectionLabel(configured, profile, catalog) {
  const sameEndpoint = p => p.kind === configured.kind
    && p.baseUrl?.replace(/\/+$/, '') === configured.baseUrl?.replace(/\/+$/, '');
  if (!configured.keySecret && configured.keyEnv) {
    const exact = catalog.find(p => sameEndpoint(p) && p.keyEnv === configured.keyEnv);
    if (exact) {
      const status = exact.credential === 'available' ? '' : exact.credential === 'placeholder' ? '; example key' : '; key missing';
      return `${exact.label} (${exact.keyEnv}${status})`;
    }
    // Numbered entries disappear when their export is absent. Keep the saved
    // account visible rather than attributing its route to the base credential.
    const base = catalog.find(p => sameEndpoint(p) && p.account === 1
      && configured.keyEnv.startsWith(p.keyEnv) && /^(?:[2-9]|[1-9][0-9])$/.test(configured.keyEnv.slice(p.keyEnv.length)));
    if (base) {
      const account = configured.keyEnv.slice(base.keyEnv.length);
      return `${base.label.replace(/ · Account 1$/, '')} · Account ${account} (${configured.keyEnv}; key missing)`;
    }
  }
  return `${profile}${configured.keySecret ? ` (vault: ${configured.keySecret})` : configured.keyEnv ? ` (${configured.keyEnv})` : ''}`;
}

export function createProviderPicker(api, changed = () => {}) {
  let catalogRequest = 0, modelRequest = 0;
  return {
    catalog: [], agents: [], models: [], provider: '', model: '', customModel: '', route: 'default',
    note: 'Select a provider and account to see available models.', busy: false, loading: false, refreshing: false,
    config: null, draft: '', saved: '',
    get dirty() { return this.draft !== this.saved; },
    get modelId() { return this.model === '__custom__' ? this.customModel.trim() : this.model; },
    get canConnect() {
      return !!this.config && !this.busy && !this.loading && !this.refreshing && !this.dirty
        && this.catalog.find(p => p.id === this.provider)?.credential === 'available'
        && !!this.modelId && !this.agents.find(a => a.name === this.route)?.provider;
    },
    get selectionStatus() {
      if (!this.config) return 'Loading saved connections…';
      const agent = this.agents.find(a => a.name === this.route);
      const profile = agent?.provider || this.config.routes[this.route] || this.config.routes.default;
      const configured = this.config.providers[profile];
      const label = this.route === 'default' ? 'Workspace default' : this.route;
      if (!configured) return `${label}: using the runtime environment settings. No model route saved.`;
      const source = agent?.provider ? 'Pinned in the agent definition; edit Agents to change it.'
        : this.route !== 'default' && !this.config.routes[this.route] ? 'Inherited from the workspace default.' : 'Applies to new tasks.';
      return `${label}: ${configured.model} · ${connectionLabel(configured, profile, this.catalog)}. ${source}`;
    },
    setDraft(value) { this.draft = value; changed(); },
    setAgents(agents) {
      this.agents = agents;
      if (this.route !== 'default' && !agents.some(a => a.name === this.route)) this.route = 'default';
      changed();
    },
    async loadConfig() {
      const config = await api('config');
      const preserve = this.dirty;
      this.config = config; this.saved = JSON.stringify(config, null, 2);
      if (!preserve) this.draft = this.saved;
      changed();
    },
    async refreshProviders() {
      const request = ++catalogRequest;
      this.refreshing = true; changed();
      try {
        const result = await api('providers');
        if (request !== catalogRequest) return;
        this.catalog = result.providers;
        if (this.provider && !this.catalog.some(p => p.id === this.provider)) await this.selectProvider('');
        changed();
      } finally {
        if (request === catalogRequest) { this.refreshing = false; changed(); }
      }
    },
    async selectProvider(id, preferredModel = '') {
      const request = ++modelRequest;
      const p = this.catalog.find(p => p.id === id);
      this.provider = id; this.model = ''; this.customModel = ''; this.models = [];
      this.loading = !!p && p.credential === 'available';
      this.note = !p ? 'Select a provider and account to see available models.'
        : p.credential !== 'available' ? `${p.keyEnv}: ${p.credential === 'placeholder' ? 'contains an example value. Replace it with your real API key' : 'not found in the Nexus environment'}. Relaunch Nexus after exporting it.`
        : `${p.keyEnv} detected. Loading account models…`;
      changed();
      if (!this.loading) return;
      try {
        const result = await api(`providers/models?provider=${encodeURIComponent(id)}`);
        if (request !== modelRequest) return;
        this.models = result.models; this.note = result.note;
      } catch (error) {
        if (request !== modelRequest) return;
        this.note = error.message; this.model = '__custom__';
      } finally {
        if (request === modelRequest) {
          if (preferredModel) {
            this.model = this.models.includes(preferredModel) ? preferredModel : '__custom__';
            if (this.model === '__custom__') this.customModel = preferredModel;
          }
          this.loading = false; changed();
        }
      }
    },
    async connect() {
      if (this.busy) throw new Error('Wait for the current connection save.');
      if (this.dirty) throw new Error('Save your advanced connection edits before choosing a model.');
      if (!this.canConnect) throw new Error('Choose an available provider, model, and editable route.');
      const selection = { provider: this.provider, model: this.modelId, route: this.route };
      this.busy = true; changed();
      try {
        await api('providers/select', 'POST', selection);
        await this.loadConfig();
      } finally { this.busy = false; changed(); }
    },
    async saveConfig() {
      if (this.busy) throw new Error('Wait for the current connection save.');
      const draft = this.draft, config = JSON.parse(draft);
      this.busy = true; changed();
      try {
        await api('config', 'PUT', config);
        this.config = config; this.saved = draft;
      } finally { this.busy = false; changed(); }
    },
  };
}
