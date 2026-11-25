# Configuration and information pages

Settings went from **645 to 264 visible words**, a **59% reduction**. Both counts use the same signed-in mock account with GitHub linked, the same deployment and the default collapsed sections. The count includes headings, selected values, statuses and controls in the main content. Each whitespace-delimited word counts once. The base was `b17b8363`.

## Before and after

Desktop dark mode, 1440 × 1000 viewport. Screenshots include the full page or the open dialog.

| Page | Before | After |
| --- | --- | --- |
| Settings | [Before](before/settings.png) | [After](after/settings.png) |
| Add a secret | [Before](before/add-secret.png) | [After](after/add-secret.png) |
| Repository settings | [Before](before/repository.png) | [After](after/repository.png) |
| My machines | [Before](before/machines.png) | [After](after/machines.png) |
| Add a machine | [Before](before/machines-add.png) | [After](after/machines-add.png) |
| Factory | [Before](before/factory.png) | [After](after/factory.png) |
| Work item | [Before](before/item.png) | [After](after/item.png) |
| Feature plan | [Before](before/feature.png) | [After](after/feature.png) |
| Usage | [Before](before/usage.png) | [After](after/usage.png) |
| Plans | [Before](before/plans.png) | [After](after/plans.png) |
| Agents and usage rail | [Before](before/agents.png) | [After](after/agents.png) |
| Sign-in | [Before](before/signin.png) | [After](after/signin.png) |
| Landing | [Before](before/landing.png) | [After](after/landing.png) |
| Docs index | [Before](before/docs.png) | [After](after/docs.png) |
| Settings docs | [Before](before/docs-settings.png) | [After](after/docs-settings.png) |

## Audit rows

| Area | Changes |
| --- | --- |
| Settings | Shortened the page and section introductions. MCP counts and missing-secret actions appear beside servers. Secret scope rules fold away and repository overrides fit on one line. Model keys link to their precedence rules. My machines is a link. Linear label syntax is in connected Details and docs. API header syntax is in the create dialog and docs. Saved-choice fallback text uses normal ink. |
| Add a secret | Shortened Name, Value and both scope options. Length limits appear on invalid input. Several lines switches to a textarea. Details explains sandbox restrictions, repository precedence and redaction. The repository version names setup as a recipient. |
| Repository settings | Shortened screenshots, approvals, setup, checks, prepared-environment and network descriptions. Setup execution rules fold away. Glob examples appear in the field, repository file rules in docs and preset explanations on hover. Updated the saved-secrets environment refusal and host-discovery hint. |
| My machines | Shortened the overview, credential choices, limits and footer. Current versions and signed-in login commands are hidden. Rate-limited keys identify the provider. Setup uses three steps. Additional setup questions fold away and CLI options stay in commands and the Runner reference. Removed the Docker host-name explanation. |
| Factory | Shortened hosted-slot and machine capacity, the empty-checks note, budget questions and usage-panel introduction. Unavailable CI results share a neutral “CI unknown” label. Failed CI is still actionable. |
| Work item | The budget figure is visible. Raw tokens, cache weighting and working-time rules are in Details. Zero fixes disappear. Review text identifies when a subtask is reviewed with the whole feature. Full failure output remains available. |
| Feature plan | Shortened the review heading, removed its duplicate version, and moved budget rules behind Details. Routing options describe waiting or using another free place. Chips name Hosted or the machine and show whether it gets secrets, with the rule in a tooltip. Agent descriptions identify the place or key. The input label spells out its unit, millions of tokens. |
| Usage and plans | Used Hosted time and Kept sandboxes. Visible totals show used and left. Details exposes held time. Shortened token, estimated-cost, unmeasured-time and kept-sandbox notes. The plan comparison shows the time multiplier per size. |
| Agents, sign-in, landing and docs | Disconnected ChatGPT uses quiet ink with a Connect link. The rail names hosted time and kept sandboxes. Shortened sign-in and landing copy and removed warning colour from isolation facts. The security docs card describes outcomes. Settings docs cover the rules moved off the pages. |

## Kept or handled separately

- The base already includes the two Defaults introductions, last-start grouping, size hint and unified model select. Shared isolation and size labels come from the parallel naming change. The screenshots show the labels available on this branch.
- The feature-plan budget input stores millions of tokens. “Medium” would describe a sandbox size. The routing control says “place” because Hosted is also a valid destination.
- Machine key verification and actionable connection or Docker warnings stay visible. Full check-failure output, the Runner reference card and the mock sign-in footnote were marked to keep.
- The composer, pickers, session page and sidebar belong to the parallel changes.
