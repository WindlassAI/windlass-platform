/** Service-only directory shared by the webhook receiver and account actors. Customer ownership is immutable. */
import type { createClient } from "rivetkit/client";
import type { Registry } from "../registry.js";
import { issueServiceToken } from "../tokens.js";
import { actor } from "rivetkit";
import { db } from "rivetkit/db";
import { assertOrigin, requireServiceFor } from "../auth.js";

export const billingCustomers = actor({
	onBeforeConnect: (c, params) => {
		assertOrigin(c);
		requireServiceFor({ key: c.key, conn: { params } }, "billing");
	},
	db: db({ onMigrate: async db => {
		await db.execute("CREATE TABLE IF NOT EXISTS customers (customer TEXT PRIMARY KEY, uid TEXT NOT NULL)");
	} }),
	actions: {
		lookup: async (c, customer: string): Promise<string | null> => {
			requireServiceFor(c, "billing");
			const [row] = await c.db.execute<{ uid: string }>("SELECT uid FROM customers WHERE customer = ?", customer);
			return row?.uid ?? null;
		},
		claim: async (c, customer: string, uid: string): Promise<string> => {
			requireServiceFor(c, "billing");
			await c.db.execute("INSERT INTO customers (customer, uid) VALUES (?, ?) ON CONFLICT DO NOTHING", customer, uid);
			const [row] = await c.db.execute<{ uid: string }>("SELECT uid FROM customers WHERE customer = ?", customer);
			return row!.uid;
		},
	},
});

export function customerDirectory(client: unknown) {
	return (client as ReturnType<typeof createClient<Registry>>).billingCustomers.getOrCreate(["dodo"], { params: { token: issueServiceToken("billing") } });
}
