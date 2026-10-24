// Acknowledge only the submitted draft so edits made during a save survive.
export function createAgentEditor(api) {
  return {
    name: null, saved: '', draft: '', busy: false, loading: false,
    get dirty() { return this.draft !== this.saved; },
    select(agent, discard = false) {
      if (this.busy) throw new Error('Wait for the current agent save.');
      if (this.dirty && !discard) throw new Error('Save your agent edits, or use Reload agent to discard them, before selecting another agent.');
      this.name = agent.name;
      this.saved = this.draft = JSON.stringify(agent, null, 2);
    },
    async reload() {
      if (this.busy) throw new Error('Wait for the current agent save.');
      if (!this.name) throw new Error('Select an agent first.');
      this.busy = this.loading = true;
      try {
        const { agents } = await api('state');
        const agent = agents.find(a => a.name === this.name);
        if (!agent) throw new Error('This agent is no longer available. Your draft has been retained.');
        this.saved = this.draft = JSON.stringify(agent, null, 2);
        return agent;
      } finally { this.busy = this.loading = false; }
    },
    async save() {
      if (this.busy) throw new Error('Wait for the current agent save.');
      const draft = this.draft, definition = JSON.parse(draft);
      this.busy = true;
      try {
        const agent = await api('agent', 'PUT', definition);
        this.name = agent.name;
        this.saved = draft;
      } finally { this.busy = false; }
    },
  };
}
