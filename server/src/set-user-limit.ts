/** Run in the server environment with the deployment's service signing key. */
import { userInfo } from "node:os";
import { createClient } from "rivetkit/client";
import { ownEngineEndpoint } from "./config.js";
import type { Registry } from "./registry.js";
import { issueServiceToken } from "./tokens.js";
import { limitsSubject } from "./user-limits.js";

const [uid, key, raw, extra] = process.argv.slice(2);
const history = key === "--history";
const valid = history
	? raw === undefined || /^[1-9][0-9]*$/.test(raw)
	: raw && /^(default|unlimited|[0-9]+)$/.test(raw);
if (!uid || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(uid) || !key || !valid || extra) {
	console.error(
		"Usage: node --import tsx src/set-user-limit.ts <uid> <setting> <integer|default|unlimited> or <uid> --history [before-id]",
	);
	process.exitCode = 2;
} else {
	const operator = userInfo().username;
	const token = issueServiceToken(limitsSubject(uid, operator));
	const client = createClient<Registry>({ endpoint: ownEngineEndpoint() });
	try {
		const user = client.user.get([uid], { params: { token } });
		const result = history
			? await user.internalLimitHistory(operator, raw === undefined ? undefined : Number(raw))
			: await user.internalSetLimit({
					operator,
					key,
					value: raw === "default" || raw === "unlimited" ? raw : Number(raw),
				});
		console.log(JSON.stringify(result, null, 2));
	} finally {
		await client.dispose();
	}
}
