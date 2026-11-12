# Astryx and Nexus GUI

Inspected `meta/astryx` at `558725695bb264985dd23e496eef3b3b6f1ee125`, including the root/core READMEs, root/core package manifests and MIT license. No code, assets or package were copied or installed. This is a source assessment, not a Nexus integration test.

| Useful contribution | Decision for Nexus |
| --- | --- |
| Consistent controls, layout and CSS theme variables | Use the conventions to keep new Studio, Foundry and coordination controls consistent with the existing Nexus visual identity. Nexus already has shared theme variables. |
| Keyboard and accessibility contracts | Apply to command search, focus restoration, modal dismissal, accessible labels, responsive controls and visible focus. Continue testing actual Nexus behavior. Upstream claims do not certify Nexus accessibility. |
| Documentation usable by people and coding agents | Keep component examples, supported behavior and limitations aligned with the user guide and runtime. |
| React components and templates | Do not migrate this release. Core 0.7.14 declares React/React DOM >=19 and StyleX peers; Nexus currently serves plain JavaScript/CSS with no React build. Adoption would require a separate, justified frontend migration. |
| Chart wrappers | Do not replace the working Nexus charts or spatial views. Upstream currently marks charts/Vega packages canary-only. |
| License and distribution | The inspected source is MIT with notice-retention obligations. If components/assets are later bundled, review the exact package and third-party notices at that revision. |

The concrete recommendation is to use Astryx as a GUI consistency and testing reference now. A future isolated component pilot should measure bundle size, WKWebView behavior, accessibility, theme fidelity and maintenance cost before any library migration.

Sources: [root documentation](https://github.com/meta/astryx/blob/558725695bb264985dd23e496eef3b3b6f1ee125/README.md), [core manifest](https://github.com/meta/astryx/blob/558725695bb264985dd23e496eef3b3b6f1ee125/packages/core/package.json), [license](https://github.com/meta/astryx/blob/558725695bb264985dd23e496eef3b3b6f1ee125/LICENSE).

## Reassessment, 2026-11-12

Decision: retain the current native ESM frontend and shared CSS for this audit. Do not add a second state owner or frontend build pipeline to fix execution-status presentation. This is a bounded engineering decision, not a claim that vanilla JavaScript is universally preferable.

Inspected upstream revision `bef2f834aa7ca6111428aa6cb87619da2807dc38` directly through GitHub's commit API and raw source. Core is now **0.7.15**, still beta in the README. The manifest declares React and React DOM `>=19.0.0`, StyleX `^0.19.0`, and `intl-messageformat` as a dependency. Current upstream documentation describes prebuilt CSS for consumers; a custom StyleX compilation plugin is therefore not necessarily required. This updates the prior assessment without implying a Nexus compatibility test. [Pinned manifest](https://github.com/meta/astryx/blob/bef2f834aa7ca6111428aa6cb87619da2807dc38/packages/core/package.json), [pinned README](https://github.com/meta/astryx/blob/bef2f834aa7ca6111428aa6cb87619da2807dc38/README.md).

### Evidence and tradeoffs

| Option | Benefit for this codebase | Cost or required validation | Decision |
| --- | --- | --- | --- |
| React 19 island | Component ownership could help complicated editor forms. React officially supports mounting into a small existing-page region. | The current dashboard already splits editors, providers, Studio and visualizations into modules; a new island would need explicit ownership of shared state, draft protection, authenticated requests and polling. No defect found here requires React. | Defer a prototype until one complex component has a demonstrated maintenance benefit. |
| TypeScript | Static contracts could catch inconsistent job/event and provider shapes. | Requires a type-checking workflow; conversion does not validate runtime model responses or permissions. TypeScript can check JavaScript incrementally through JSDoc/`checkJs`. | Prefer a separately scoped contract-checking pilot over converting the application in this audit. |
| Vite | Local production bundling, module transformation and asset hashing. | Existing static allowlist and desktop copy/package verification must recognize output assets. Current documented default target includes Safari 16.4; supported WKWebView versions need direct testing and explicit target selection. | No bundler needed for the implemented native modules. |
| Astryx | Reusable controls, themes and accessibility patterns. | React/StyleX dependencies, theme integration, license notices and exact-release review. Prebuilt CSS must work under the unchanged CSP; upstream accessibility claims do not establish Nexus accessibility. | Use design principles; no package or assets copied. |
| Targeted native components | Fixes the observed status/progress and hierarchy problems within the established runtime. | Requires direct behavior and rendered tests; does not solve all frontend maintenance debt. | Adopt for this change. |

The existing `ui/app.js` was 47,481 bytes, `workbench.js` 3,756 bytes and `style.css` 24,436 bytes before this change (raw source bytes, not network or memory measurements). Their combined size is now 81,870 bytes, an increase of 6,197 bytes. No dependency was added. The application still serves same-origin local production source assets through the authenticated server and packages the native AppKit/WKWebView host. Authentication, host/origin checks and CSP are unchanged.

The bounded native implementation groups all 14 existing destinations by purpose and adds an event-derived task timeline, distinct attempted/completed/failed/denied tool counts, approval status, and a progress indicator driven by actual job state. Full records remain under a disclosure control. A locally persisted System/Dark/Light theme selector uses shared color variables, follows system appearance changes in System mode, and stays keyboard accessible at narrow widths. Completion explicitly asks for result review; tool return success is never labeled independent validation. The new pure presentation tests include misleading model success text, declined approval, unfinished cancellation, unknown outcomes and bounded visible history. Seven targeted tests passed (`node --test test/task-activity.test.js test/foundry-generation.test.js`). The extended `scripts/verify-ui-quality.js` passed 112 rendered combinations (14 workspaces, four widths, two themes), with no sampled contrast failures or browser errors, plus an offline task timeline, theme persistence, and system-theme changes. Light/dark task screenshots and the light desktop navigation screenshot were visually inspected. The receipt lives at `.nexus/verification/ui-quality/receipt.json`; this is bounded Chrome evidence, not VoiceOver or WKWebView certification.

No React/Astryx prototype was built because the conditional adoption gate was not met. Consequently bundle size, render performance, WKWebView behavior and accessibility of an Astryx island remain **unmeasured**. A future prototype must use the same task fixture and acceptance tests as the native component, retain local assets and current security policy, measure production bundle cost and interaction behavior, and pass native packaging before adoption. No framework performance advantage is claimed.

Additional primary references: [React incremental integration](https://react.dev/learn/add-react-to-an-existing-project), [Vite production browser targets](https://vite.dev/guide/build), [TypeScript checking JavaScript](https://www.typescriptlang.org/docs/handbook/intro-to-js-ts.html). These establish available approaches, not their measured suitability for Nexus.
