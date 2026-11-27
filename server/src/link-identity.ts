import { parseArgs } from "node:util";
import { createClient, type Registry } from "./client.js";
import { ownEngineEndpoint } from "./config.js";
import { serviceParams } from "./auth.js";
import { githubId } from "./github/ids.js";
import { loginIssuer } from "./platform-login.js";

const {
	values: { uid, provider, id },
} = parseArgs({ options: { uid: { type: "string" }, provider: { type: "string" }, id: { type: "string" } } });
if (
	!uid ||
	!/^u_[A-Za-z0-9_-]{1,62}$/.test(uid) ||
	!id ||
	(provider !== "github" && provider !== "google") ||
	(provider === "github" ? !githubId(id) : !/^[\x21-\x7e]{1,255}$/.test(id))
) {
	throw new Error("Usage: link-identity --uid U --provider github|google --id SUBJECT");
}
const issuer = loginIssuer(provider);
if (!issuer) throw new Error("Configure this login provider first.");
const client = createClient<Registry>({ endpoint: ownEngineEndpoint() });
try {
	const params = serviceParams();
	await client.user.get([uid], { params }).internalTokenGeneration();
	await client.accountIdentities.getOrCreate(["platform"], { params }).internalLink(uid, { provider, issuer, sub: id });
	console.log(`Linked ${provider} identity ${id} at ${issuer} to ${uid}.`);
} finally {
	await client.dispose();
}
