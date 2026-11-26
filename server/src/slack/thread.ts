import type { RawAccess } from "rivetkit/db";
import type { SlackPost } from "../actors/slack-workspace.js";
import type { ItemSummary } from "../contract.js";
import { currentKey } from "../factory/blueprint.js";
import type { SlackBinding } from "../factory/intake.js";
import type { FactoryItem } from "../factory/types.js";

type Event = SlackPost["event"];
export type SlackDestination = Omit<SlackPost, "itemId" | "event">;
export type SlackEffect = { kind: "slack_write"; key: string; event: Event };

export function slackEffects(meta: { source: ItemSummary["source"]; slack?: SlackBinding }, before: FactoryItem | null, next: FactoryItem): SlackEffect[] {
	if (meta.source !== "slack" || !meta.slack?.generation) return [];
	const effects: SlackEffect[] = [];
	function add(event: Event, identity = "") {
		effects.push({ kind: "slack_write", event, key: [next.id, event, identity].join(":") });
	}
	if (!before) add("started");
	if (next.question && next.question.id !== before?.question?.id) {
		const plan = next.featurePlan?.status === "proposed" && next.filedTurn === currentKey(next)
			&& ["plan_approval", "replan_approval"].includes(next.question.kind);
		add(plan ? "plan" : "question", next.question.id);
	}
	if (next.pr && next.pr.number !== before?.pr?.number) add("pr", String(next.pr.number));
	if (before?.state !== next.state && (next.state === "failed" || next.state === "done")) add(next.state);
	return effects;
}

// Separate from the versioned item snapshot: a concurrent blueprint commit cannot overwrite the root.
export const SLACK_RECEIPTS = "CREATE TABLE IF NOT EXISTS slack_receipts (key TEXT PRIMARY KEY, event TEXT NOT NULL, thread_ts TEXT)";

export async function performSlackWrite(db: Pick<RawAccess, "execute">, destination: SlackDestination, itemId: string, effect: SlackEffect, post: (input: SlackPost) => Promise<string>): Promise<void> {
	if ((await db.execute("SELECT 1 FROM slack_receipts WHERE key=?", effect.key)).length) return;
	let threadTs = destination.threadTs;
	if (effect.event !== "started") {
		const [receipt] = await db.execute<{ thread_ts: string | null }>("SELECT thread_ts FROM slack_receipts WHERE event='started'");
		if (!receipt) throw new Error("Slack acknowledgement pending");
		if (!receipt.thread_ts) return; // The original mapping was already unavailable at acknowledgement.
		threadTs = receipt.thread_ts;
	}
	try {
		const ts = await post({ ...destination, itemId, event: effect.event, threadTs });
		threadTs ??= ts;
	} catch (error) {
		if ((error as { code?: string } | null)?.code !== "slack_unavailable") throw error;
		threadTs = null;
	}
	await db.execute("INSERT OR IGNORE INTO slack_receipts VALUES(?,?,?)", effect.key, effect.event, threadTs);
}
