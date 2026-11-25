import { setTimeout as sleep } from "node:timers/promises";
import type { workItem } from "../server/src/actors/work-item.js";

type ItemContext = Parameters<NonNullable<typeof workItem.config.actions>["internalView"]>[0];

export async function readProvenance(c: ItemContext) {
	const { meta, item } = c.vars.stored!;
	const [binding] = await c.db.execute<{ n: number }>("SELECT count(*) AS n FROM github_binding");
	return {
		github: meta.github ?? null,
		linear: meta.linear ?? null,
		untrusted: item.untrusted ?? null,
		bindingRows: binding?.n ?? 0,
		issueEffects: (await c.db.execute("SELECT 1 FROM effects WHERE id LIKE '%issue%'")).length,
	};
}

export function pollUntil(defaultTimeout: number) {
	return async function until<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeout = defaultTimeout): Promise<T> {
		const end = Date.now() + timeout;
		do {
			const answer = await probe();
			if (answer) return answer;
			await sleep(60);
		} while (Date.now() < end);
		throw new Error("timed out waiting for " + label);
	};
}
