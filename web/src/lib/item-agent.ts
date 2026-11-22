/**
 * A work item's agent as its page says it: who builds it, on which model, and what that agent reported
 * of its spend (server/src/factory/budget.ts, `noteAgentTurn`). Where its tokens are not counted against
 * the item's budget, no meter is drawn: a 0 that was never measured is not shown as one.
 */
import type { ItemAgent } from "@contract";
import { HARNESS_NAMES } from "./acp";

/** "Claude Code · sonnet", "Windlass · gpt-6.2-sol"; the agent's default model is said as such. */
export function agentLine(agent: ItemAgent | undefined): string {
	if (!agent) return "Windlass";
	return `${HARNESS_NAMES[agent.harness] ?? agent.harness} · ${agent.model === "default" ? "its default model" : agent.model}`;
}

/** The tokens row where it is no meter of the budget: null where the tokens count against it. */
export function agentTokens(agent: ItemAgent | undefined): string | null {
	if (!agent || agent.tokens === "counted") return null;
	const name = HARNESS_NAMES[agent.harness] ?? agent.harness;
	if (agent.tokens === "not_reported") return `Not reported by ${name}`;
	return `${agent.reportedTokens.toLocaleString("en-US")} reported by ${name}, not counted: a subscription is not billed by token`;
}

/** What else the agent reported: its cost, and Claude Code's 5-hour window at the first turn and now. */
export function agentFacts(agent: ItemAgent | undefined): { label: string; value: string }[] {
	if (!agent) return [];
	const facts: { label: string; value: string }[] = [];
	if (agent.cost) facts.push({ label: "Cost", value: `${agent.cost.amount.toLocaleString("en-US", { style: "currency", currency: agent.cost.currency, maximumFractionDigits: 2 })}, as ${HARNESS_NAMES[agent.harness] ?? agent.harness} reported it` });
	if (agent.fiveHour) facts.push({ label: "5-hour window", value: `${Math.round(agent.fiveHour.first)}% used at the first turn, ${Math.round(agent.fiveHour.latest)}% after the latest` });
	return facts;
}
