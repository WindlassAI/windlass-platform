# Work-item factory

The blueprint decides the next step for an item or feature from observed facts.

## Quick commands

Run one command from the repository root.

- `cd server && npx tsx ../scripts/factory-check.ts` exercises the step transitions.
- `cd server && npx tsx ../scripts/orchestrator-check.ts` exercises feature planning and subtasks.
- `cd server && FACTORY_ONLY=memory npx tsx ../scripts/factory-e2e.ts` covers the in-memory actor cases.

## Key files

- `./blueprint.ts` holds `advance(item, fact)` and the rules for waits, questions and retries.
- `./types.ts` defines the stored item, incoming facts, outgoing effects and decision result.
- `./feature-plan.ts` validates the planner's proposed subtasks and dependencies.
- `./untrusted.ts` names the sources to carry with text supplied to a turn.

## Non-obvious patterns

- Change decisions in `advance`. Return effects for I/O, then feed the observed result back as a fact.
- Preserve the effect key on retry. The work-item actor commits the decision before performing it and can replay after waking.
- When adding third-party issue text, another author's feedback or CI logs to a prompt, carry its sources through delivery so the harness can apply the trust rules.

## See also

[Work-item actor](../actors/work-item.ts) persists decisions and performs effects. [Factory behaviour](../../../web/src/docs/content/factory.md) describes the user's view.
