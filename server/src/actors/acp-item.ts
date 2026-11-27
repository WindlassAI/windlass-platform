import type { AcpUpdate, TimelineItem } from "../contract.js";

type AcpItem = Extract<TimelineItem, { kind: "acp" }>;
export const ACP_ITEM_LIMIT = 64_000;

/** A prefix that fits inside a JSON string, allowing for escapes and surrogate pairs. */
export function jsonPrefix(text: string, room: number): { text: string; size: number } {
	const size = (s: string) => JSON.stringify(s).length - 2;
	let hi = Math.min(text.length, room);
	let piece = text.slice(0, hi);
	if (size(piece) > room) {
		let lo = 0;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (size(text.slice(0, mid)) <= room) lo = mid;
			else hi = mid - 1;
		}
		piece = text.slice(0, lo);
	}
	if (piece.length < text.length && /[\uD800-\uDBFF]$/.test(piece)) piece = piece.slice(0, -1);
	return { text: piece, size: size(piece) };
}

const identifiers = new Set([
	"sessionUpdate",
	"originalSessionUpdate",
	"toolCallId",
	"type",
	"kind",
	"status",
	"priority",
	"currentModeId",
]);

/** Called after numbering and redaction. Keys, punctuation, metadata and the truncation flag all count. */
export function boundedAcpItem(item: AcpItem): AcpItem {
	if (JSON.stringify(item).length <= ACP_ITEM_LIMIT) return item;
	const clipped = { ...item, truncated: true };
	function base(key: string, value: unknown) {
		if (typeof value !== "string") return value;
		return identifiers.has(key) ? value.slice(0, 256) : "";
	}
	// Measure the envelope and structural JSON with just the identifiers left. Long values can use the rest.
	const envelope = JSON.stringify({ ...clipped, update: null }).length - "null".length;
	let remaining = ACP_ITEM_LIMIT - envelope - JSON.stringify(item.update, base).length;
	if (remaining >= 0) {
		const json = JSON.stringify(item.update, (key, value: unknown) => {
			if (typeof value !== "string" || identifiers.has(key)) return base(key, value);
			const piece = jsonPrefix(value, remaining);
			remaining -= piece.size;
			return piece.text;
		});
		return { ...clipped, update: JSON.parse(json) as AcpUpdate };
	}
	// The keys or containers alone overflow. Keep a bounded summary with a valid discriminator.
	const u = item.update;
	const update: AcpUpdate =
		u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update"
			? { sessionUpdate: u.sessionUpdate, toolCallId: u.toolCallId.slice(0, 256), status: u.status?.slice(0, 256) }
			: {
					sessionUpdate: "unknown",
					originalSessionUpdate: (u.sessionUpdate === "unknown" ? u.originalSessionUpdate : u.sessionUpdate).slice(
						0,
						256,
					),
				};
	return { ...clipped, update };
}
