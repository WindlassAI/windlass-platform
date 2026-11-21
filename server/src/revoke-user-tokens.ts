/** Run in the server environment. The CLI looks up an existing user and never creates one. */
import { createClient } from "rivetkit/client";
import { ownEngineEndpoint } from "./config.js";
import type { Registry } from "./registry.js";
import { issueServiceToken } from "./tokens.js";

const [uid, extra] = process.argv.slice(2);
if (!uid || extra || !/^[A-Za-z0-9_-]{1,64}$/.test(uid)) {
	console.error("Usage: node --import tsx src/revoke-user-tokens.ts <uid>");
	process.exitCode = 2;
} else {
	const client = createClient<Registry>({ endpoint: ownEngineEndpoint() });
	try {
		const token = issueServiceToken("revoke:" + uid);
		await client.user.get([uid], { params: { token } }).internalRevokeTokens();
		console.log(`Revoked platform sign-ins for ${uid}.`);
	} finally {
		await client.dispose();
	}
}
