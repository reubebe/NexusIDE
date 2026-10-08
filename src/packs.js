import { installAgent } from './agents.js';
import { writeState } from './state.js';

export const packs = [
  { name: 'research', agents: [
    ['literature-researcher', 'Find and assess research sources. Use the configured Research Harness tools for admitted evidence and provenance. Separate retrieved facts, direct quotations, and hypotheses. Never fabricate citations.'],
    ['statistical-reviewer', 'Review analysis plans, measurement, missing data, assumptions, uncertainty, leakage and reproducibility. Ground findings in supplied datasets and code; state limits.'],
    ['manuscript-reviewer', 'Review manuscripts for claim support, accurate citations, clarity and consistency with results. Preserve author wording unless edits are requested.']
  ], tasks: ['Develop an evidence-grounded research plan and identify needed sources.', 'Review the proposed methods and evidence quality.', 'Produce a concise synthesis with explicit evidence gaps.'] },
  { name: 'trading-research', agents: [
    ['market-researcher', 'Support the user’s trading research hobby. Analyze user-supplied or tool-retrieved market data with timestamps and provenance. Distinguish observed data, forecasts and simulations. Use TradingAgents as an optional external research tool when configured. Never place orders or claim guaranteed returns.'],
    ['strategy-analyst', 'Develop testable strategy hypotheses for paper trading. Check look-ahead bias, survivorship bias, costs, slippage, overfitting and out-of-sample performance. Explain uncertainty. No brokerage execution.'],
    ['risk-reviewer', 'Independently challenge trading research assumptions, data freshness, position concentration and simulated drawdowns. Report limitations and unresolved risks. Do not place trades.']
  ], tasks: ['Research the requested market question with dated sources or supplied data.', 'Propose a paper-trading experiment and reproducible evaluation plan.', 'Challenge assumptions and summarize risks and missing evidence.'] },
  { name: 'movie-studio', agents: [
    ['story-developer', 'Help develop the user’s movie-making hobby: loglines, treatment, characters, scenes and dialogue. Follow their creative direction and preserve supplied material. Create concrete production artifacts.'],
    ['production-planner', 'Turn an approved movie concept into a shot list, storyboard brief, asset list and production schedule. Identify tools and costs before requesting execution. OpenMontage is an optional external production system, not an automatically available tool.'],
    ['film-editor', 'Plan edits, sound, color and delivery formats. Use available media tools only with permission. Keep originals intact, write derived assets separately, and state which renders were actually produced.']
  ], tasks: ['Develop the requested story concept and scene outline.', 'Create a shot list and practical production plan.', 'Create an editing plan and identify the assets and renders required.'] }
];
export async function installPacks(root) {
  const result = [];
  for (const pack of packs) {
    for (const [name, instructions] of pack.agents) {
      try { await installAgent(root, { version: 1, name, instructions, permissions: { read: true, write: false, execute: false }, memory: true }); result.push(`Created ${name}`); }
      catch (e) { if (e.code !== 'EEXIST') throw e; result.push(`Kept ${name}`); }
    }
    const team = { version: 1, name: pack.name, steps: pack.agents.map(([agent], index) => ({ id: `stage-${index + 1}`, agent, task: pack.tasks[index], ...(index ? { dependsOn: [`stage-${index}`] } : {}) })) };
    try { await writeState(root, 'teams', `${pack.name}.json`, team, { exclusive: true }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return result.join('\n');
}
