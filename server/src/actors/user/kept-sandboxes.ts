import type { ItemSummary, SessionSummary } from "../../contract.js";
import { placeKey } from "../../factory/placement.js";
import { itemActor, sessionActor } from "../internal.js";
import type { ItemsCtx } from "../user-items.js";

const ITEM_SANDBOX_IDLE_MS = 3 * 86_400_000;

export function releaseAt(item: ItemSummary): number {
	if (["done", "failed", "cancelled"].includes(item.state)) return 0;
	if (item.state === "review" || item.question || item.wait?.reason === "person") return item.updatedAt + ITEM_SANDBOX_IDLE_MS;
	return Infinity;
}

// Use the same account and runner inventories as admission, including sandboxes kept before this policy.
function candidates(c: ItemsCtx) {
	const { sessions, items, machines, usage } = c.vars;
	const busy = new Set([...items.slots.values(), ...items.requests.values()].map(turn => turn.session));
	return [...sessions.values()].flatMap(session => {
		if (busy.has(session.id) || session.status !== "idle" || session.environmentBuild || session.readiness) return [];
		const item = session.item && items.items.get(session.item.id);
		const due = item ? releaseAt(item) : Infinity;
		if (session.item && !Number.isFinite(due)) return [];
		const place = session.place;
		const box = place.kind === "machine" && machines.get(place.machineId)?.sandboxes.find(box => box.sessionId === session.id);
		if (session.sandbox === "none" && !box && !usage.keeps(session.id)) return [];
		const used = Math.max(session.updatedAt, box ? box.usedAt : 0);
		return [{ session, item, due, used }];
	});
}

export function nextSandboxRelease(c: ItemsCtx): number {
	return candidates(c).reduce((first, { session, due }) => Math.min(first, Math.max(due, c.vars.items.sandboxRetries?.get(session.id) ?? 0)), Infinity);
}

async function free(c: ItemsCtx, session: SessionSummary, reason: string, pressure = false) {
	try {
		if (session.item) {
			// Reports can trail feedback that already put the item back to work.
			const live = await itemActor(c, c.key[0]!, session.item.id).internalSummary();
			const due = releaseAt(live);
			if (!Number.isFinite(due) || (!pressure && due > Date.now())) return false;
		}
		const machine = session.place.kind === "machine" && c.vars.machines.get(session.place.machineId);
		const box = machine && machine.sandboxes.find(box => box.sessionId === session.id);
		const cutoff = session.item ? undefined : Date.now() - ITEM_SANDBOX_IDLE_MS;
		const { freed } = await sessionActor(c, c.key[0]!, session.id).internalFreeSandbox(undefined, undefined, { reason, cutoff });
		// The runner confirmed destruction. Its next inventory may still be in flight.
		if (freed && machine && box) machine.sandboxes = machine.sandboxes.filter(other => other !== box);
		return freed;
	} catch (error) {
		c.log.warn({ msg: "Could not free an idle sandbox", session: session.id, error: String(error) });
		return false;
	}
}

export async function releaseDueSandboxes(c: ItemsCtx) {
	const retries = c.vars.items.sandboxRetries ??= new Map();
	for (const [id, at] of retries) if (at <= Date.now()) retries.delete(id);
	for (const { session, due } of candidates(c)) {
		if (due > Date.now() || retries.has(session.id)) continue;
		retries.set(session.id, Date.now() + 60_000);
		const freed = await free(c, session, due === 0 ? "Freed the sandbox because the work item ended." : "Freed the sandbox after three days of item inactivity.");
		if (freed) retries.delete(session.id);
	}
}

export function keptFull(c: ItemsCtx, session: SessionSummary): boolean {
	if (session.place.kind === "hosted") return c.vars.usage.atCap(session.id);
	const machine = c.vars.machines.get(session.place.machineId);
	return !!machine && machine.maxSandboxes !== undefined && machine.sandboxes.length >= machine.maxSandboxes && !machine.sandboxes.some(box => box.sessionId === session.id);
}

export async function makeSandboxRoom(c: ItemsCtx, asking: SessionSummary): Promise<boolean> {
	if (!keptFull(c, asking)) return true;
	const place = asking.place;
	const oldest = candidates(c).sort((a, b) => a.used - b.used || a.session.id.localeCompare(b.session.id));
	for (const { session, item, used } of oldest) {
		if (!keptFull(c, asking)) return true;
		if (session.id === asking.id || (session.item && session.item.id === asking.item?.id)) continue;
		if (placeKey(session.place) !== placeKey(place)) continue;
		if (!item && used >= Date.now() - ITEM_SANDBOX_IDLE_MS) continue;
		if (place.kind === "hosted" && !c.vars.usage.keeps(session.id)) continue;
		const said = `Freed the sandbox of “${item?.title ?? session.title}” to make room.`;
		if (!await free(c, session, said, true)) continue;
		if (asking.item) await itemActor(c, c.key[0]!, asking.item.id).internalFact({ kind: "sandbox_reclaimed", said, at: Date.now() });
		else await sessionActor(c, c.key[0]!, asking.id).internalSandboxReclaimed(said);
	}
	return !keptFull(c, asking);
}
