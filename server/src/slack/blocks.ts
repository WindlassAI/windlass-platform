import type { ChoiceId, FeaturePlan, ItemQuestion } from "../contract.js";
import { unattendedKeys } from "../factory/feature-plan.js";

export type Block = Record<string, unknown>;
export interface SlackMessage { text: string; blocks?: Block[] }
/** `brief` is the link-only form. A mapping that allows details posts `full` instead. */
export interface SlackPost { brief: SlackMessage; full?: SlackMessage }
/** What a button carries: item, question, plan version and choice. */
export interface ButtonValue { i: string; q: string; v?: number; c: ChoiceId }

// Slack's documented limits for these fields.
export const LIMITS = { section: 3000, header: 150, button: 75, actions: 25 };
const PARTS = 10, CHECKS = 6, QUESTIONS = 5;
// Choices that need more than a press: a note, a budget or a secret value.
const NEEDS_INPUT = new Set<ChoiceId>(["reply", "raise", "add_secret"]);

export function cut(text: string, most: number): string {
	if (text.length <= most) return text;
	let kept = text.slice(0, most - 1);
	if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
	return kept.trimEnd() + "…";
}
/** Escape our own mrkdwn. Untrusted text only goes into plain_text fields. */
export const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = (text: string, most = LIMITS.section) => ({ type: "plain_text", text: cut(text, most), emoji: false });
const section = (text: string): Block => ({ type: "section", text: plain(text) });
const mrkdwn = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
const link = (url: string, label: string) => `<${url}|${escapeText(label)}>`;
function list(lines: string[], most: number) {
	const shown = lines.slice(0, most).map(line => "• " + cut(line.replace(/\s+/g, " ").trim(), 300));
	if (lines.length > most) shown.push(`and ${lines.length - most} more`);
	return shown.join("\n");
}

/** Never offered in Slack: secret requests, questions whose meaning depends on builder text, and choices needing input. */
export function slackMayAnswer(question: ItemQuestion, choice: ChoiceId): boolean {
	return !question.secret && question.kind !== "secret_needed" && !question.asked && !NEEDS_INPUT.has(choice);
}
/** What Slack offers of the choices the web shows. Unattended parts are confirmed on the web. */
export function slackChoices(question: ItemQuestion, plan?: FeaturePlan | null): ItemQuestion["choices"] {
	const confirmUnattended = !!plan && unattendedKeys(plan).length > 0;
	return question.choices.filter(choice => slackMayAnswer(question, choice.id) && !(choice.id === "approve" && confirmUnattended));
}

function button(label: string, value: ButtonValue, primary: boolean, id = "choice:" + value.c): Block {
	return { type: "button", action_id: id, text: plain(label, LIMITS.button), value: JSON.stringify(value), ...(primary && { style: "primary" }) };
}
const openButton = (url: string, label = "Open in Windlass"): Block => ({ type: "button", action_id: "open", text: plain(label, LIMITS.button), url });
const actions = (elements: Block[]): Block => ({ type: "actions", elements: elements.slice(0, LIMITS.actions) });

function planButtons(itemId: string, question: ItemQuestion, plan: FeaturePlan, url: string): Block {
	const offered = new Set(slackChoices(question, plan).map(choice => choice.id));
	const elements: Block[] = [];
	if (offered.has("approve")) elements.push(button("Approve", { i: itemId, q: question.id, v: plan.version, c: "approve" }, true, "approve"));
	if (offered.has("revise")) elements.push(button("Request changes", { i: itemId, q: question.id, v: plan.version, c: "revise" }, false, "revise"));
	elements.push(openButton(url));
	return actions(elements);
}

export function planPost(itemId: string, question: ItemQuestion, plan: FeaturePlan, url: string): SlackPost {
	const line = `Plan ready for approval: ${url}`;
	const buttons = planButtons(itemId, question, plan, url);
	const brief = { text: line, blocks: [mrkdwn(escapeText(line)), buttons] };
	const blocks: Block[] = [{ type: "header", text: plain(`Plan ready for approval (version ${plan.version})`, LIMITS.header) }];
	blocks.push(section("Goal: " + plan.spec.goal));
	blocks.push(section("Parts\n" + list(plan.subtasks.map(s => `${s.title} (${s.budget.tokens.toLocaleString("en-US")} tokens)`), PARTS)));
	if (plan.spec.acceptance.length) blocks.push(section("Checks\n" + list(plan.spec.acceptance, CHECKS)));
	blocks.push(section(`Budget: ${plan.budget.tokens.toLocaleString("en-US")} tokens`));
	const open = plan.questions.filter(q => !q.answer);
	if (open.length) {
		const lines = open.map(q => q.text + (q.recommended ? ` (recommended: ${q.recommended})` : ""));
		blocks.push(section("Open questions\n" + list(lines, QUESTIONS)));
		blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Answer the open questions in Windlass before approving." }] });
	}
	if (unattendedKeys(plan).length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Some parts run an agent that works without asking. Confirm and approve them in Windlass." }] });
	blocks.push(mrkdwn(link(url, "Full plan")));
	blocks.push(buttons);
	return { brief, full: { text: line, blocks } };
}

export function questionPost(itemId: string, question: ItemQuestion, url: string): SlackPost {
	const line = `Question ready: ${url}`;
	if (question.secret || question.kind === "secret_needed") return { brief: { text: line } };
	const choices = slackChoices(question);
	const buttons = choices.length ? [actions([
		...choices.map(choice => button(choice.label, { i: itemId, q: question.id, c: choice.id }, choice.id === question.recommended)),
		openButton(url),
	])] : [];
	return {
		brief: buttons.length ? { text: line, blocks: [mrkdwn(escapeText(line)), ...buttons] } : { text: line },
		full: { text: line, blocks: [section(question.text), mrkdwn(link(url, "Open in Windlass")), ...buttons] },
	};
}

/** The line that replaces a question's message, with no buttons, once it is closed. `line` is our escaped mrkdwn. */
export function resolvedMessage(line: string, url: string): SlackMessage {
	return { text: line, blocks: [mrkdwn(`${line} · ${link(url, "Open in Windlass")}`)] };
}

export function revisionModal(value: ButtonValue & { ch: string }, most: number): Block {
	return {
		type: "modal", callback_id: "windlass_revise", private_metadata: JSON.stringify(value),
		title: plain("Request changes", 24), submit: plain("Send", 24), close: plain("Cancel", 24),
		blocks: [{ type: "input", block_id: "note", label: plain("What should change in the plan?"),
			element: { type: "plain_text_input", action_id: "note", multiline: true, max_length: most } }],
	};
}
