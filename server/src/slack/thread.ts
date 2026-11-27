import type { RawAccess } from "rivetkit/db";
import { config } from "../config.js";
import type { ItemQuestion } from "../contract.js";
import { currentKey } from "../factory/blueprint.js";
import type { SlackBinding } from "../factory/intake.js";
import type { FactoryItem } from "../factory/types.js";
import { planPost, questionPost, resolvedMessage, type SlackMessage, type SlackPost } from "./blocks.js";

const messages = {
	started: "Work item filed", plan: "Plan ready for approval", question: "Question ready",
	pr: "Pull request opened", done: "Work item finished", failed: "Work item failed", cancelled: "Work item cancelled",
};
type Event = keyof typeof messages | "resolved";
export type SlackEffect = { kind: "slack_write"; key: string; event: Event; question?: string; line?: string };

/** How a question closed. A Slack press passes the presser's Slack user id. */
export function resolvedLine(question: ItemQuestion, fact: { kind: string }, slackUser?: string): string {
	const f = fact as { kind: string; by?: unknown; choice?: unknown; question?: unknown };
	const approved = f.kind === "approve_plan" || (f.kind === "answer" && f.choice === "approve");
	const label = approved ? "Approve" : f.kind === "answer" && f.question === question.id ? question.choices.find(c => c.id === f.choice)?.label : undefined;
	if (!label || typeof f.by !== "string" || !f.by.startsWith("person:")) return "This question is no longer open.";
	if (slackUser) return approved ? `Approved by <@${slackUser}> in Slack` : `Answered by <@${slackUser}> in Slack: ${label}`;
	return approved ? "Approved on the web" : `Answered on the web: ${label}`;
}

export function slackEffects(before: FactoryItem | null, next: FactoryItem, fact?: { kind: string }, slackUser?: string): SlackEffect[] {
	const effects: SlackEffect[] = [];
	function add(event: Event, identity = "", extra: Partial<SlackEffect> = {}) {
		effects.push({ kind: "slack_write", event, key: [next.id, event, identity].join(":"), ...extra });
	}
	if (!before) add("started");
	const closed = before?.question;
	if (closed && closed.id !== next.question?.id)
		add("resolved", closed.id, { question: closed.id, line: fact ? resolvedLine(closed, fact, slackUser) : "This question is no longer open." });
	if (next.question && next.question.id !== before?.question?.id) {
		const plan = next.featurePlan?.status === "proposed" && next.filedTurn === currentKey(next)
			&& ["plan_approval", "replan_approval"].includes(next.question.kind);
		add(plan ? "plan" : "question", next.question.id, { question: next.question.id });
	}
	if (next.pr && next.pr.number !== before?.pr?.number) add("pr", String(next.pr.number));
	if (before?.state !== next.state && (next.state === "failed" || next.state === "done" || next.state === "cancelled")) add(next.state, String(next.revision));
	return effects;
}

// Separate from the versioned item snapshot: a concurrent blueprint commit cannot overwrite the root.
export const SLACK_RECEIPTS = "CREATE TABLE IF NOT EXISTS slack_receipts (key TEXT PRIMARY KEY, event TEXT NOT NULL, thread_ts TEXT)";
/** The message posted for each question, so that closing it can replace its buttons. */
export const SLACK_QUESTIONS = "CREATE TABLE IF NOT EXISTS slack_questions (question TEXT PRIMARY KEY, ts TEXT NOT NULL)";

export interface SlackIo {
	post(message: SlackPost, thread: string | null): Promise<string>;
	update(ts: string, message: SlackMessage): Promise<void>;
}

/** What to post for an event. A question that closed before its turn in the queue gets only the link line. */
export function postFor(item: FactoryItem, effect: SlackEffect, url: string): SlackPost {
	const line = { brief: { text: `${messages[effect.event as keyof typeof messages]}: ${url}` } };
	const question = item.question;
	if (!question || question.id !== effect.question) return line;
	if (effect.event === "plan" && item.featurePlan) return planPost(item.id, question, item.featurePlan, url);
	if (effect.event === "question") return questionPost(item.id, question, url);
	return line;
}

export async function performSlackWrite(db: Pick<RawAccess, "execute">, destination: SlackBinding, item: FactoryItem, effect: SlackEffect, io: SlackIo): Promise<void> {
	if ((await db.execute("SELECT 1 FROM slack_receipts WHERE key=?", effect.key)).length) return;
	let threadTs = destination.threadTs;
	if (effect.event !== "started") {
		const [receipt] = await db.execute<{ thread_ts: string | null }>("SELECT thread_ts FROM slack_receipts WHERE event='started'");
		if (!receipt) throw new Error("Slack acknowledgement pending");
		if (!receipt.thread_ts) return; // The original mapping was already unavailable at acknowledgement.
		threadTs = receipt.thread_ts;
	}
	const url = `${config.origins[0]}/items/${item.id}`;
	try {
		if (effect.event === "resolved") {
			const [posted] = await db.execute<{ ts: string }>("SELECT ts FROM slack_questions WHERE question=?", effect.question);
			if (posted) await io.update(posted.ts, resolvedMessage(effect.line!, url));
		} else {
			const post = postFor(item, effect, url);
			const ts = await io.post(post, threadTs);
			if (effect.question) await db.execute("INSERT OR IGNORE INTO slack_questions VALUES(?,?)", effect.question, ts);
			threadTs ??= ts;
		}
	} catch (error) {
		if ((error as { code?: string } | null)?.code !== "slack_unavailable") throw error;
		if (effect.event === "started") threadTs = null;
	}
	await db.execute("INSERT OR IGNORE INTO slack_receipts VALUES(?,?,?)", effect.key, effect.event, threadTs);
}
