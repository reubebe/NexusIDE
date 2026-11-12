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
