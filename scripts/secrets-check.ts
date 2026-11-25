/**
 * The rules of a repository's secrets (server/src/repo-secrets.ts), on their own: no server, no
 * sandbox, nothing sent anywhere. Every value in it is made up here, at random.
 *
 *   cd server && npx tsx ../scripts/secrets-check.ts
 *
 * What it holds to: a name is an environment variable's and none the sandbox relies on; a value has a
 * least and a greatest length and is kept exactly; a scope comes to what it says where Windlass
 * sandboxes commands. Windlass is handed only what the scope permits. A sealed value opens for its user,
 * repository and name and as nothing else; the list a client gets has no value; and a saved value is
 * taken out of text, whole, escaped, line by line, and split over two pieces.
 *
 * With Windlass's source beside this repository (~/projects/light-harness, or WLP_WINDLASS_SOURCE),
 * the names Windlass keeps from sandboxed commands are read from it and held against the copy here.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DefaultsDb } from "../server/src/repository-defaults.js";
import { MAX_SECRET_NAME_CHARS, MAX_SECRET_VALUE_BYTES, MIN_SECRET_VALUE_CHARS } from "../server/src/contract.js";
import {
	CREDENTIAL_RULE,
	NO_REDACTION,
	RedactingStream,
	SecretProblem,
	SecretRedactor,
	cleanSecretName,
	cleanSecretScope,
	cleanSecretValue,
	commandSandbox,
	isReservedName,
	listedSecrets,
	looksLikeCredential,
	openSecret,
	saveRepoSecret,
	sealSecret,
	secretMark,
	secretReach,
	setupEnvironment,
	windlassEnvironment,
	withheldFromServers,
} from "../server/src/repo-secrets.js";
import { PROFILES, e2bProfile } from "../server/src/sandbox/profiles.js";
import { SealError, createSealer } from "../server/src/signin/seal.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
}

function refused(clean: () => unknown): string | null {
	try {
		clean();
		return null;
	} catch (error) {
		return error instanceof SecretProblem ? error.message : `another error: ${String(error)}`;
	}
}

/** A made-up value: nothing here is a real credential. */
const made = (bytes = 18) => `wlpcheck_${randomBytes(bytes).toString("base64url")}`;

if (process.argv.includes("--redaction")) {
	checkRedaction();
	process.exit(failed ? 1 : 0);
}

// Names.
expect("an environment variable's name is taken as it is", cleanSecretName("NPM_TOKEN") === "NPM_TOKEN" && cleanSecretName("_x9") === "_x9" && cleanSecretName("database_url") === "database_url");
expect(
	"anything else is refused",
	["", "9LIVES", "MY-TOKEN", "MY TOKEN", "A=B", "TOKEN\n", "É", undefined, null, 7, ["A"]].every((name) => refused(() => cleanSecretName(name)) !== null),
);
expect(`a name of ${MAX_SECRET_NAME_CHARS} characters is taken, and one more is refused`, cleanSecretName("A".repeat(MAX_SECRET_NAME_CHARS)).length === MAX_SECRET_NAME_CHARS && refused(() => cleanSecretName("A".repeat(MAX_SECRET_NAME_CHARS + 1))) !== null);
const reserved = ["PATH", "HOME", "path", "WLP_SETUP", "WLP_RUN_TAG", "WINDLASS_ACCESS_TOKEN_FILE", "windlass_wake", "LD_PRELOAD", "LD_LIBRARY_PATH", "XDG_DATA_HOME", "BUN_BE_BUN", "NODE_OPTIONS", "DOCKER_HOST", "E2B_SANDBOX", "BASH_ENV", "ENV", "IFS", "TMPDIR", "HTTPS_PROXY", "https_proxy", "LC_ALL", "SHELL", "USER"];
expect("the names the sandbox, Windlass or the platform rely on are refused, in any case of letters", reserved.every((name) => isReservedName(name) && (refused(() => cleanSecretName(name)) ?? "").includes(name)), reserved.filter((name) => !isReservedName(name)).join(", "));
expect("names that only look like them are not", ["PATHS", "MY_HOME", "WLPX", "NODE", "GITHUB_TOKEN", "DATABASE_URL", "SENTRY_DSN", "PGPASSWORD", "AWS_ACCESS_KEY_ID"].every((name) => !isReservedName(name)));

// Values.
const value = made();
expect("a value is kept exactly, spaces at its ends included", cleanSecretValue(` ${value} `) === ` ${value} `);
expect("the line ends of a text field are made plain, and nothing else is changed", cleanSecretValue("-----BEGIN KEY-----\r\nabc\r\n-----END KEY-----\r\n") === "-----BEGIN KEY-----\nabc\n-----END KEY-----\n");
expect(`a value shorter than ${MIN_SECRET_VALUE_CHARS} characters is refused, also one padded with spaces`, refused(() => cleanSecretValue("1234567")) !== null && refused(() => cleanSecretValue("  1234567  ")) !== null && cleanSecretValue("12345678") === "12345678");
expect(`a value of ${MAX_SECRET_VALUE_BYTES} bytes is taken, and one byte more is refused`, cleanSecretValue("x".repeat(MAX_SECRET_VALUE_BYTES)).length === MAX_SECRET_VALUE_BYTES && refused(() => cleanSecretValue("x".repeat(MAX_SECRET_VALUE_BYTES + 1))) !== null);
expect("the limit is in bytes: characters of several bytes count as that many", refused(() => cleanSecretValue("é".repeat(MAX_SECRET_VALUE_BYTES / 2 + 1))) !== null && refused(() => cleanSecretValue("é".repeat(MAX_SECRET_VALUE_BYTES / 2))) === null);
expect("a NUL and anything that is not text are refused", [`${value}\0`, undefined, null, 12345678, [value], { value }].every((raw) => refused(() => cleanSecretValue(raw)) !== null));
expect(
	"no refusal repeats the value",
	[`${value}\0`, `${value}${"x".repeat(MAX_SECRET_VALUE_BYTES)}`].every((raw) => !(refused(() => cleanSecretValue(raw)) ?? "").includes(value)),
);
expect("a scope is one of the two", cleanSecretScope("setup") === "setup" && cleanSecretScope("agent") === "agent" && ["", "all", undefined, null, 1].every((scope) => refused(() => cleanSecretScope(scope)) !== null));

// What a scope comes to.
const sandboxed = PROFILES.find((profile) => profile.id === "docker-windlass-sandbox")!;
const hardened = PROFILES.find((profile) => profile.id === "docker-hardened")!;
const e2bUnknown = e2bProfile({ windlassSandbox: false });
const e2bSandboxed = e2bProfile({ windlassSandbox: true });
expect(
	"each profile is read as what it promises of the agent's commands",
	commandSandbox(sandboxed) === "windlass" && commandSandbox(e2bSandboxed) === "windlass" && commandSandbox(hardened) === "none" && commandSandbox(e2bUnknown) === "unknown" && commandSandbox(PROFILES.find((profile) => profile.id === "e2b-open")!) === "none",
);
expect("the names Windlass keeps from sandboxed commands are told from the others", ["NPM_TOKEN", "DATABASE_URL", "aws_region", "GH_PAT", "API_KEY", "PGPASSWORD", "BASIC_AUTH"].every(looksLikeCredential) && ["SENTRY_DSN", "PGHOST", "AUTHOR", "PATTERN", "REGION", "API_URL"].every((name) => !looksLikeCredential(name)));
const e2bOpen = PROFILES.find((profile) => profile.id === "e2b-open")!;
const everyProfile = [sandboxed, e2bSandboxed, hardened, e2bOpen, e2bUnknown];

{
	expect(
		"setup and MCP servers, commands sandboxed, whatever the name: MCP servers get it, commands do not, and nothing has to be said",
		[sandboxed, e2bSandboxed].every((profile) => JSON.stringify(secretReach("setup", profile)) === JSON.stringify({ servers: true, commands: "no", note: null })),
	);
	expect(
		"also the agent's commands, in every profile and whatever the name: MCP servers and commands get it, and nothing has to be said",
		everyProfile.every((profile) => JSON.stringify(secretReach("agent", profile)) === JSON.stringify({ servers: true, commands: "yes", note: null })),
	);
	for (const [label, profile, words] of [
		["commands not sandboxed", hardened, "run there without Windlass's sandbox"],
		["commands not sandboxed until untrusted content arrives", e2bOpen, "run there without Windlass's sandbox"],
		["a sandbox of which nothing is promised", e2bUnknown, "has not been established"],
	] as const) {
		const reach = secretReach("setup", profile);
		expect(
			`setup and MCP servers, ${label}: only the setup command gets it, whatever the name, and the sentence says that a command could read it from Windlass's process`,
			!reach.servers && reach.commands === "no" && (reach.note ?? "").includes(words) && (reach.note ?? "").includes("from Windlass's own process") && (reach.note ?? "").endsWith("Only the setup command gets it."),
		);
	}
}

const held = [
	{ name: "NPM_TOKEN", scope: "setup" as const, value: made() },
	{ name: "SENTRY_DSN", scope: "setup" as const, value: made() },
	{ name: "PREVIEW_HOST", scope: "agent" as const, value: made() },
	{ name: "DEPLOY_KEY", scope: "agent" as const, value: made() },
];
const sorted = (names: Iterable<string>) => [...names].sort().join();
expect("the setup command is handed every secret", sorted(Object.keys(setupEnvironment(held))) === "DEPLOY_KEY,NPM_TOKEN,PREVIEW_HOST,SENTRY_DSN");
{
	// What a command gets of Windlass's environment by Windlass's own rule (its `filterEnv`): never a withheld name, and a credential-looking one only when it runs without the sandbox or the name is passed.
	const commandGets = (handed: { env: Record<string, string>; withholdEnv: string[]; passEnv: string[] }, inSandbox: boolean) =>
		sorted(Object.keys(handed.env).filter((name) => !handed.withholdEnv.includes(name) && (!inSandbox || handed.passEnv.includes(name) || !looksLikeCredential(name))));
	for (const profile of [sandboxed, e2bSandboxed]) {
		const handed = windlassEnvironment(held, profile);
		expect(
			`in ${profile.name}, Windlass is handed every secret, with the names of the first scope to withhold and the credential-looking names of the second to pass`,
			sorted(Object.keys(handed.env)) === "DEPLOY_KEY,NPM_TOKEN,PREVIEW_HOST,SENTRY_DSN" && sorted(handed.withholdEnv) === "NPM_TOKEN,SENTRY_DSN" && sorted(handed.passEnv) === "DEPLOY_KEY",
		);
		expect("so a sandboxed command gets exactly the second scope, and so would one that ran without the sandbox", commandGets(handed, true) === "DEPLOY_KEY,PREVIEW_HOST" && commandGets(handed, false) === "DEPLOY_KEY,PREVIEW_HOST");
		expect("and the values are the saved ones", held.every((secret) => handed.env[secret.name] === secret.value));
	}
	for (const profile of [hardened, e2bOpen, e2bUnknown]) {
		const handed = windlassEnvironment(held, profile);
		expect(
			`in ${profile.name}, where a withheld variable could be read all the same, Windlass is handed only what is also for commands, and nothing to withhold`,
			sorted(Object.keys(handed.env)) === "DEPLOY_KEY,PREVIEW_HOST" && handed.withholdEnv.length === 0 && sorted(handed.passEnv) === "DEPLOY_KEY",
		);
		expect("so a command gets the second scope there with the sandbox and without", commandGets(handed, true) === "DEPLOY_KEY,PREVIEW_HOST" && commandGets(handed, false) === "DEPLOY_KEY,PREVIEW_HOST");
	}
	expect(
		"whatever is named to withhold or to pass is in the environment, and no name is in both lists",
		everyProfile.every((profile) => {
			const handed = windlassEnvironment(held, profile);
			return [...handed.withholdEnv, ...handed.passEnv].every((name) => name in handed.env) && !handed.withholdEnv.some((name) => handed.passEnv.includes(name));
		}),
	);
	expect(
		"a saved secret that is kept from MCP servers is said with its reason, one that is handed over or not saved is not",
		withheldFromServers("SENTRY_DSN", held, sandboxed) === null &&
			withheldFromServers("OTHER", held, sandboxed) === null &&
			(withheldFromServers("SENTRY_DSN", held, hardened) ?? "").includes("from Windlass's own process") &&
			withheldFromServers("DEPLOY_KEY", held, hardened) === null,
	);
}

// Windlass's own lists, when its source is here.
{
	const source = join(process.env.WLP_WINDLASS_SOURCE ?? join(homedir(), "projects", "light-harness"), "packages", "core", "src", "sandbox", "policy.ts");
	if (!existsSync(source)) {
		console.log(`skip  Windlass's source is not at ${source}: its rule for credential names was not compared`);
	} else {
		const text = readFileSync(source, "utf8");
		const list = (name: string): string[] => [...(new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(text)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
		const same = (mine: readonly string[], theirs: string[]) => theirs.length > 0 && mine.length === theirs.length && mine.every((item, index) => item === theirs[index]);
		expect(
			"the names Windlass keeps from sandboxed commands are the ones this platform takes them to be",
			same(CREDENTIAL_RULE.words, list("CREDENTIAL_WORDS")) && same(CREDENTIAL_RULE.segments, list("CREDENTIAL_SEGMENTS")) && same(CREDENTIAL_RULE.prefixes, list("CREDENTIAL_PREFIXES")) && same(CREDENTIAL_RULE.names, list("CREDENTIAL_NAMES")),
			`Windlass's lists in ${source} differ from CREDENTIAL_RULE in server/src/repo-secrets.ts`,
		);
	}
}

// Sealing.
{
	const sealer = createSealer(randomBytes(32));
	const secret = made(24);
	const sealed = sealSecret(sealer, "u_ada", "github:7101", "NPM_TOKEN", secret);
	const opens = (how: () => string): string => {
		try {
			return how();
		} catch (error) {
			return error instanceof SealError ? `SealError:${error.reason}` : `another error: ${String(error)}`;
		}
	};
	expect("a sealed value opens as what it was", openSecret(sealer, "u_ada", "github:7101", "NPM_TOKEN", sealed) === secret);
	expect("the blob does not hold the value, in any plain form", !sealed.includes(secret) && !sealed.includes(Buffer.from(secret).toString("base64url")) && !Buffer.from(sealed.split(".")[3] ?? "", "base64url").toString("latin1").includes(secret));
	expect("two sealings of one value differ", sealSecret(sealer, "u_ada", "github:7101", "NPM_TOKEN", secret) !== sealed);
	expect("it does not open for another user", opens(() => openSecret(sealer, "u_bob", "github:7101", "NPM_TOKEN", sealed)) === "SealError:tampered");
	expect("nor for another repository", opens(() => openSecret(sealer, "u_ada", "github:7102", "NPM_TOKEN", sealed)) === "SealError:tampered");
	expect("nor under another name", opens(() => openSecret(sealer, "u_ada", "github:7101", "NPM_TOKEN2", sealed)) === "SealError:tampered");
	expect("nor as a sign-in, nor a sign-in as a secret", opens(() => sealer.open("user", "u_ada", sealed)) === "SealError:tampered" && opens(() => openSecret(sealer, "u_ada", "github:7101", "NPM_TOKEN", sealer.seal("user", "u_ada", secret))) === "SealError:tampered");
	expect("nor with another server secret, which is said as that", opens(() => openSecret(createSealer(randomBytes(32)), "u_ada", "github:7101", "NPM_TOKEN", sealed)) === "SealError:key");
	const parts = sealed.split(".");
	parts[3] = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;
	expect("nor after a change", opens(() => openSecret(sealer, "u_ada", "github:7101", "NPM_TOKEN", parts.join("."))) === "SealError:tampered");
	expect("a value of several lines and of the greatest length comes back exactly", [`-----BEGIN-----\n${made(40)}\n-----END-----\n`, "é".repeat(MAX_SECRET_VALUE_BYTES / 2)].every((long) => openSecret(sealer, "u", "p", "N", sealSecret(sealer, "u", "p", "N", long)) === long));
}

// Let every database statement yield so saves started together overlap, including their limit checks.
{
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE repo_secret (project TEXT, name TEXT, label TEXT, scope TEXT, sealed TEXT, updated_at INTEGER, PRIMARY KEY (project, name))");
	const db: DefaultsDb = {
		async execute<Row extends Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> {
			await new Promise<void>((done) => setImmediate(done));
			return sqlite.prepare(query).all(...(args as Array<string | number>)) as Row[];
		},
	};
	const initial = { uid: "u_ada", project: "here", label: "acme/harbor", sealed: "fixture", scope: "setup" as const, now: 10 };
	const save = (name: string) => saveRepoSecret(db, { ...initial, name });
	const seed = sqlite.prepare("INSERT INTO repo_secret VALUES (?, ?, '', 'setup', 'fixture', 1)");
	for (let i = 0; i < 49; i++) seed.run("here", `OLD_${i}`);
	const count = (project?: string) => (project === undefined
		? sqlite.prepare("SELECT COUNT(*) AS n FROM repo_secret").get()
		: sqlite.prepare("SELECT COUNT(*) AS n FROM repo_secret WHERE project = ?").get(project))?.n;
	const pair = await Promise.all([save("NEW_0"), save("NEW_1")]);
	expect("two concurrent saves at 49 leave 50 secrets and one repository refusal", count("here") === 50 && pair.sort().join() === "repository_full,saved");

	sqlite.exec("DELETE FROM repo_secret WHERE name LIKE 'NEW%'");
	for (let i = 0; i < 1950; i++) seed.run(`other_${Math.floor(i / 50)}`, `OLD_${i}`);
	const many = await Promise.all(Array.from({ length: 20 }, (_, i) => save(`NEW_${i}`)));
	expect("twenty saves at 49 in the repository and 1,999 in the account fill the last place once", count("here") === 50 && count() === 2000 && many.filter((r) => r === "saved").length === 1 && many.filter((r) => r === "repository_full").length === 19);
	expect("a repository with room reports the account limit", await saveRepoSecret(db, { ...initial, project: "empty", name: "NEW" }) === "account_full" && count() === 2000);
	const winner = `NEW_${many.indexOf("saved")}`;
	const replaced = await saveRepoSecret(db, { ...initial, name: winner, label: "", sealed: "replacement", scope: "agent", now: 20 });
	const row = sqlite.prepare("SELECT label, scope, updated_at, sealed = 'replacement' AS updated FROM repo_secret WHERE project = 'here' AND name = ?").get(winner);
	expect("at both limits a replacement updates the value, scope and time and keeps the last known label", replaced === "replaced" && row?.label === initial.label && row.scope === "agent" && row.updated_at === 20 && row.updated === 1);
	sqlite.exec("DELETE FROM repo_secret WHERE project = 'here'");
	const same = await Promise.all([save("SAME"), save("SAME")]);
	expect("concurrent saves of one new name report one creation and one replacement", same.sort().join() === "replaced,saved" && count("here") === 1);
	sqlite.close();
}

// What a client is sent.
{
	const secret = made();
	const rows = [{ name: "NPM_TOKEN", scope: "setup", updated_at: 1_700_000_000_000, sealed: `wlps1.x.y.${secret}.z`, value: secret, label: "acme/harbor", project: "github:7101" }];
	const listed = listedSecrets(rows, sandboxed);
	expect("the list has the name, the scope, the time and what it reaches", listed.profile === sandboxed.id && listed.secrets.length === 1 && listed.secrets[0]!.name === "NPM_TOKEN" && listed.secrets[0]!.scope === "setup" && listed.secrets[0]!.updatedAt === 1_700_000_000_000 && listed.secrets[0]!.reach.servers);
	expect("and nothing else of a row: no value, sealed or not", !JSON.stringify(listed).includes(secret) && Object.keys(listed.secrets[0]!).sort().join() === "name,reach,scope,updatedAt");
	expect("a scope it does not know is listed as the narrower one", listedSecrets([{ name: "X_TOKEN", scope: "everything", updated_at: 1 }], sandboxed).secrets[0]!.scope === "setup");
}

function checkRedaction() {
	const token = made();
	const quoted = `pa"ss\\word ${made(6)}`;
	const key = `-----BEGIN PRIVATE KEY-----\n${made(30)}\n${made(30)}\n-----END PRIVATE KEY-----\n`;
	const redactor = new SecretRedactor([
		{ name: "NPM_TOKEN", value: token },
		{ name: "DB_PASSWORD", value: quoted },
		{ name: "DEPLOY_KEY", value: key },
	]);
	const mark = secretMark("NPM_TOKEN");
	expect("a value is replaced by the name of its secret, wherever it stands and however often", redactor.text(`a ${token} b ${token}`) === `a ${mark} b ${mark}` && redactor.text(token) === mark);
	expect("text without one is left as it is", redactor.text("npm ci\nadded 3 packages\n") === "npm ci\nadded 3 packages\n" && redactor.text("") === "");
	const asJson = JSON.stringify({ output: `password is ${quoted}` });
	const escaped = JSON.stringify(quoted).slice(1, -1);
	expect("a value is found as a JSON string holds it, with its quote and backslash escaped", escaped !== quoted && asJson.includes(escaped) && !redactor.text(asJson).includes(escaped) && redactor.text(asJson).includes(secretMark("DB_PASSWORD")));
	const printed = redactor.text(`cat key.pem\n${key}`);
	expect("a value of several lines is taken out whole, and line by line when its lines are printed apart", !key.split("\n").filter((line) => line.length >= MIN_SECRET_VALUE_CHARS).some((line) => printed.includes(line)) && !redactor.text(key.split("\n").map((line) => `  | ${line}`).join("\n")).includes(key.split("\n")[1]!));
	const event = { type: "tool.settled", data: { callId: "c1", output: `token=${token}`, nested: [{ text: `again ${token}` }], count: 3, flag: true, none: null }, [token]: "field name" };
	const cleaned = redactor.deep(event);
	expect("every text of an event is cleaned, at any depth, and nothing else of it is touched", cleaned.data.output === `token=${mark}` && cleaned.data.nested[0]!.text === `again ${mark}` && cleaned.data.count === 3 && cleaned.data.flag === true && cleaned.data.none === null && cleaned.type === "tool.settled" && !(token in cleaned) && cleaned[mark] === "field name");
	const untouched = { type: "step.started", data: { step: 1 } };
	expect("an event without a value is handed on as the same object", redactor.deep(untouched) === untouched && event.data.output.includes(token));
	expect("a redactor with nothing to take out changes nothing", !new SecretRedactor([]).active && new SecretRedactor([]).text(token) === token && NO_REDACTION.deep(event) === event);

	// A stream cut at every possible place: no piece that is passed on, and no joining of them, holds the value.
	const whole = `before ${token} between ${token} after`;
	let leaks = 0;
	let wrong = 0;
	for (let cut = 0; cut <= whole.length; cut += 1) {
		const stream = new RedactingStream(redactor);
		const pieces = [stream.push(whole.slice(0, cut)), stream.push(whole.slice(cut)), stream.flush()];
		if (pieces.some((piece) => piece.includes(token)) || pieces.join("").includes(token)) leaks += 1;
		if (pieces.join("") !== `before ${mark} between ${mark} after`) wrong += 1;
	}
	expect("a value split over two pieces of a stream is taken out wherever the split falls, and nothing else is lost", leaks === 0 && wrong === 0, `${leaks} leaks, ${wrong} wrong joins`);
	let dribbled = "";
	const slow = new RedactingStream(redactor);
	for (const character of whole) dribbled += slow.push(character);
	dribbled += slow.flush();
	expect("also when it arrives one character at a time", dribbled === `before ${mark} between ${mark} after`);
	const partial = new RedactingStream(redactor);
	const first = partial.push(`ends with ${token.slice(0, 10)}`);
	expect("what only begins like a value is held back, and passed on when the stream ends or goes on otherwise", first === "ends with " && partial.flush() === token.slice(0, 10) && (() => {
		const other = new RedactingStream(redactor);
		return other.push(`x ${token.slice(0, 10)}`) + other.push("!? and more") === `x ${token.slice(0, 10)}!? and more`;
	})());
	expect("held counts no more than a value's beginning", redactor.held(`abc ${token.slice(0, 5)}`) === 5 && redactor.held("abc") === 0 && redactor.held(`${token} tail`) === 0);
	const big = "x".repeat(200_000) + token;
	const began = performance.now();
	const out = redactor.text(big);
	redactor.held(big.slice(0, -3));
	expect("a long output costs little", !out.includes(token) && performance.now() - began < 500, `${Math.round(performance.now() - began)} ms`);
}

checkRedaction();
console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
