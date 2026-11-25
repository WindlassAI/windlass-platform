/**
 * A repository's network list (server/src/repository-network.ts) and the hosted sandbox's side of it
 * (server/src/sandbox/e2b/network.ts), on their own: no server, no E2B, nothing sent anywhere. The
 * storage runs against a SQLite database in memory whose every statement waits a little, as the actor's
 * does; the lookup stub runs here with python3 on a free port, as it runs on port 53 in a sandbox.
 *
 *   cd server && npx tsx ../scripts/network-check.ts
 *
 * What it holds to: a list holds presets and exact host names, within MAX_REPOSITORY_HOSTS and, with
 * the deployment's, MAX_HOSTS; it applies only in `restricted`; two hosts allowed at once both stay; a
 * request goes when its host is allowed; the fixed reading of a repository's files proposes what they
 * name to fetch from, with where, and not the pages they link to; the stub answers every name NXDOMAIN at
 * once and writes each name once, and the platform reads back the names that are not allowed.
 */

import { spawn, spawnSync } from "node:child_process";
import dgram from "node:dgram";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MAX_REPOSITORY_HOSTS, NETWORK_PRESETS } from "../server/src/contract.js";
import type { DefaultsDb } from "../server/src/repository-defaults.js";
import {
	NETWORK_TABLE,
	NetworkProblem,
	REQUESTS_TABLE,
	addEntry,
	cleanEntries,
	dismissRequest,
	expandEntries,
	fileRequests,
	fits,
	mayChangeNetwork,
	networkLimit,
	readNetwork,
	readRequests,
	saveNetwork,
	scanForHosts,
	scanKind,
	scanPaths,
	SCAN_TOTAL_BYTES,
	MAX_SOURCE_CHARS,
	blockedHostNote,
	hostsForTurn,
} from "../server/src/repository-network.js";
import { GithubApp, type GithubAppSettings } from "../server/src/github/app.js";
import { MAX_HOSTS, PRESETS } from "../server/src/sandbox/hosted-network.js";
import { DNS_STUB, GUEST_DNS_SCRIPT, readE2bNetwork, withHosts, blockedLookups, guestDnsArgv, networkConfig } from "../server/src/sandbox/e2b/network.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
}
const plain = (value: unknown) => JSON.stringify(value);
function refusal(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return error instanceof NetworkProblem ? error.message : `another error: ${String(error)}`;
	}
}

// ---- what may be saved ---------------------------------------------------------------------------

for (const page of ["sessions", "settings"]) {
	const doc = readFileSync(new URL("../web/src/docs/content/" + page + ".md", import.meta.url), "utf8");
	expect(page + " documents the hosted timeline action and PR count", doc.includes("**Allow for this repository**") && /pull requests?[^.]*(count of observed network refusals|includes? a count of (them|blocked requests))/i.test(doc));
	expect(page + " describes only network observations the web app renders", !/Network refusals appear during the turn|refused DNS names appear during a turn/i.test(doc));
}

const RESTRICTED = readE2bNetwork({ WLP_E2B_NETWORK: "restricted" });
{
	expect("presets and exact names are kept, lower case, each once, in the order given", plain(cleanEntries(["@playwright", "Registry.Example.com.", "@playwright", "registry.example.com"])) === plain(["@playwright", "registry.example.com"]));
	expect("presets expand to their hosts, sorted", plain(expandEntries(["@prisma", "a.example.org", "@node"])) === plain(["a.example.org", "binaries.prisma.sh", "nodejs.org"]));
	for (const [raw, says] of [
		["*.example.org", /not an exact host name/],
		["10.0.0.5", /not an exact host name/],
		["registry.example.com:8443", /not an exact host name/],
		["https://registry.example.com", /not an exact host name/],
		["localhost", /not an exact host name/],
		["@nope", /no preset/],
	] as const) {
		const said = refusal(() => cleanEntries([raw]));
		expect(`"${raw}" is refused, and the refusal says why`, said !== null && says.test(said), said ?? "accepted");
	}
	expect("what is not a list is refused", refusal(() => cleanEntries("@npm")) !== null);
	const many = Array.from({ length: MAX_REPOSITORY_HOSTS + 1 }, (_, index) => `h${index}.example.org`);
	expect(`more than ${MAX_REPOSITORY_HOSTS} hosts are refused`, /at most 40/.test(refusal(() => cleanEntries(many)) ?? ""));
	const deployment = Array.from({ length: MAX_HOSTS - 5 }, (_, index) => `d${index}.example.net`);
	const near = refusal(() => cleanEntries(["a.example.org", "b.example.org", "c.example.org", "d.example.org", "e.example.org", "f.example.org"], deployment));
	expect("a list that does not fit beside the deployment's hosts is refused, saying so", near !== null && /more than the 64/.test(near), near ?? "accepted");
	expect("a host the deployment allows already takes no room", fits(["d1.example.net", "a.example.org"], deployment) && networkLimit(deployment) === 5 && networkLimit([]) === MAX_REPOSITORY_HOSTS);
	expect("every preset is exact names only", Object.values(PRESETS).flat().every((host) => /^[a-z0-9.-]+$/.test(host) && !host.startsWith(".")));
	expect("the presets the repository settings offer include nodejs.org, Playwright, Prisma, Debian and Ubuntu", ["@node", "@playwright", "@prisma", "@debian", "@ubuntu"].every((id) => (PRESETS[id] ?? []).length > 0));
	const gcs = NETWORK_PRESETS.find((preset) => preset.id === "@gcs");
	expect("Google Cloud Storage is a preset of its own, which says it reaches every public bucket, and @playwright does not carry it", !PRESETS["@playwright"]!.includes("storage.googleapis.com") && plain(gcs?.hosts) === plain(["storage.googleapis.com"]) && /every public Google Cloud Storage bucket/.test(gcs?.about ?? "") && /@gcs/.test(NETWORK_PRESETS.find((preset) => preset.id === "@playwright")?.about ?? ""));
	expect("the timeline's line about a blocked storage.googleapis.com says what allowing it reaches; another host's does not", /every public Google Cloud Storage bucket/.test(blockedHostNote("storage.googleapis.com", "acme/harbor")) && !/Google Cloud Storage/.test(blockedHostNote("cdn.example.org", "acme/harbor")));
	const clicks = new Map([["clicked.example.org", 200], ["earlier.example.org", 50]]);
	const turnHosts = hostsForTurn(["listed.example.org", "earlier.example.org"], 100, clicks);
	expect("a host allowed from the session after its turn read the list is kept for the turn, not overwritten; one allowed before is in the list and forgotten", plain(turnHosts) === plain(["clicked.example.org", "earlier.example.org", "listed.example.org"]) && plain([...clicks.keys()]) === plain(["clicked.example.org"]));
	expect("only the person whose settings they are may change the list", mayChangeNetwork("u1", "u1") && !mayChangeNetwork("u2", "u1") && !mayChangeNetwork(null, "u1"));
}

// ---- what a sandbox is given -----------------------------------------------------------------------

{
	const extra = ["registry.example.com", "api.openai.com"];
	const { network, dropped } = withHosts(RESTRICTED, extra);
	expect("restricted: the repository's hosts are added to the deployment's, sorted, each once", network.hosts.includes("registry.example.com") && RESTRICTED.hosts.every((host) => network.hosts.includes(host)) && plain(network.hosts) === plain([...new Set(network.hosts)].sort()) && dropped.length === 0);
	expect("E2B is asked for the whole of it", plain(networkConfig(network)?.allowOut) === plain(network.hosts));
	expect("the guest script pins the repository's hosts too", guestDnsArgv(network).includes("registry.example.com"));
	const open = readE2bNetwork({});
	const none = readE2bNetwork({ WLP_E2B_NETWORK: "none" });
	expect("open and none are as the deployment has them: a repository's list applies only in restricted", withHosts(open, extra).network === open && withHosts(none, extra).network === none);
	const full = withHosts(RESTRICTED, Array.from({ length: 80 }, (_, index) => `x${String(index).padStart(2, "0")}.example.org`));
	expect("beyond MAX_HOSTS the repository's hosts that do not fit are left out and named, the deployment's all kept", full.network.hosts.length === MAX_HOSTS && full.dropped.length === 80 - (MAX_HOSTS - RESTRICTED.hosts.length) && RESTRICTED.hosts.every((host) => full.network.hosts.includes(host)));
	expect("names that are no host are never added", !withHosts(RESTRICTED, ["*.example.org", "10.0.0.1"]).network.hosts.some((host) => host.includes("*") || host === "10.0.0.1"));
}

// ---- how it is kept -----------------------------------------------------------------------------

function database(): DefaultsDb {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(NETWORK_TABLE);
	sqlite.exec(REQUESTS_TABLE);
	return {
		async execute<Row extends Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> {
			for (let waits = Math.floor(Math.random() * 4); waits >= 0; waits -= 1) await new Promise<void>((done) => setImmediate(done));
			return sqlite.prepare(query).all(...(args as Array<string | number | null>)) as Row[];
		},
	};
}

const HARBOR = "github:7101";
{
	const db = database();
	expect("nothing is kept for a repository nobody saved a list for", plain(await readNetwork(db, HARBOR)) === plain({ entries: [], hosts: [], updatedAt: null }));
	const saved = await saveNetwork(db, HARBOR, "acme/harbor", ["@prisma", "registry.example.com"], 10);
	expect("a saved list reads back with its hosts", plain(saved.entries) === plain(["@prisma", "registry.example.com"]) && plain(saved.hosts) === plain(["binaries.prisma.sh", "registry.example.com"]) && saved.updatedAt === 10);
	await fileRequests(db, HARBOR, ["cdn.example.org", "registry.example.com", "Cdn.Example.org", "not a host"], "s1", 20);
	expect("a request is filed once per host, and not for a host the list allows", plain((await readRequests(db, HARBOR)).map((request) => request.host)) === plain(["cdn.example.org"]));
	await fileRequests(db, HARBOR, ["cdn.example.org"], "s2", 30);
	const [again] = await readRequests(db, HARBOR);
	expect("asking again moves it up and names the session that asked", again?.at === 30 && again.sessionId === "s2");
	for (let round = 0; round < 6; round += 1) {
		const both = await Promise.all([addEntry(db, HARBOR, "", `a${round}.example.org`, [], 40 + round), addEntry(db, HARBOR, "", `b${round}.example.org`, [], 40 + round)]);
		const after = await readNetwork(db, HARBOR);
		if (!after.entries.includes(`a${round}.example.org`) || !after.entries.includes(`b${round}.example.org`) || both.some((answer) => answer.entries.length === 0)) {
			expect("two hosts allowed at once both stay", false, plain(after.entries));
			break;
		}
		if (round === 5) expect("two hosts allowed at once both stay, round after round", true);
	}
	await addEntry(db, HARBOR, "", "cdn.example.org", [], 60);
	expect("allowing a host takes its request off", (await readRequests(db, HARBOR)).length === 0);
	expect("allowing a host the list has already changes nothing", (await addEntry(db, HARBOR, "", "binaries.prisma.sh", [], 61)).entries.length === (await readNetwork(db, HARBOR)).entries.length);
	let full: string | null = null;
	try {
		await addEntry(db, HARBOR, "", "one-more.example.org", Array.from({ length: MAX_HOSTS }, (_, index) => `d${index}.example.net`), 62);
	} catch (error) {
		full = error instanceof NetworkProblem ? error.message : String(error);
	}
	expect("adding to a list that would not fit is refused", full !== null && /more than the 64/.test(full), full ?? "added");
	await fileRequests(db, HARBOR, ["late.example.org"], null, 70);
	await dismissRequest(db, HARBOR, "LATE.example.org");
	expect("a dismissed request is gone", (await readRequests(db, HARBOR)).length === 0);
	await fileRequests(db, HARBOR, ["wanted.example.org"], "s3", 75);
	const junk = await fileRequests(db, HARBOR, Array.from({ length: 45 }, (_, index) => `r${index}.example.org`), "s3", 80);
	const kept = (await readRequests(db, HARBOR)).map((request) => request.host);
	expect("a repository keeps at most 30 requests, and the ones waiting stay over new ones: names looked up by the dozen push out none", kept.length === 30 && kept.includes("wanted.example.org") && junk.filed.length === 29 && junk.full.length === 16, `${kept.length} kept, ${junk.filed.length} filed, ${junk.full.length} not`);
	const again2 = await fileRequests(db, HARBOR, ["wanted.example.org", "r44.example.org"], "s4", 85);
	expect("a host waiting already is moved up even when the list is full; a new one is answered as not filed", plain(again2) === plain({ filed: ["wanted.example.org"], full: ["r44.example.org"] }) && (await readRequests(db, HARBOR))[0]?.host === "wanted.example.org");
	const both2 = await Promise.all([fileRequests(db, "github:7102", Array.from({ length: 20 }, (_, index) => `p${index}.example.org`), null, 86), fileRequests(db, "github:7102", Array.from({ length: 20 }, (_, index) => `q${index}.example.org`), null, 86)]);
	expect("two sessions filing at once still keep the cap", (await readRequests(db, "github:7102")).length === 30 && both2[0].filed.length + both2[1].filed.length === 30);
	await saveNetwork(db, HARBOR, "", [], 90);
	expect("an empty list removes the row", plain(await readNetwork(db, HARBOR)) === plain({ entries: [], hosts: [], updatedAt: null }));
}

// ---- the fixed reading of a repository's files ------------------------------------------------------

{
	expect("the scan reads manifests, lockfiles, CI files and install scripts, and passes over vendored copies", scanKind("package.json") === "package" && scanKind(".github/workflows/ci.yml") === "ci" && scanKind("scripts/install.sh") === "shell" && scanKind("node_modules/x/package.json") === null && scanKind("src/deep/a/b/c/d/package.json") === null && scanKind("README.md") === null && scanKind("src/util.sh") === null);
	const picked = scanPaths([
		{ path: "package-lock.json", type: "blob", size: 3_000_000 },
		{ path: "package.json", type: "blob", size: 900 },
		{ path: "huge/package.json", type: "blob", size: 900_000 },
		{ path: "docs/package.json", type: "blob", size: 100 },
		{ path: "src", type: "tree", size: null },
	]);
	expect("the files read are the shallowest, a lockfile up to 4 MiB, nothing too large", plain(picked.paths) === plain(["package.json", "package-lock.json"]) && !picked.more);
	const locks = scanPaths(Array.from({ length: 8 }, (_, index) => ({ path: `p${index}/yarn.lock`, type: "blob", size: 3_900_000 })));
	expect("the files read come to at most 16 MiB together, and the rest are said to be left out", locks.paths.length === 4 && locks.more && locks.maxBytes === SCAN_TOTAL_BYTES, `${locks.paths.length} read`);
	const unsized = scanPaths(Array.from({ length: 8 }, (_, index) => ({ path: `p${index}/yarn.lock`, type: "blob", size: null })));
	expect("a file whose size the tree does not give counts as the most it may be", unsized.paths.length === 4 && unsized.more);
	const files = [
		{
			path: "package.json",
			text: JSON.stringify({
				name: "harbor",
				homepage: "https://harbor.dev",
				repository: { url: "git+https://gitlab.com/acme/harbor.git" },
				funding: "https://opencollective.com/harbor",
				scripts: { postinstall: "curl -fsSL https://downloads.toolhost.io/bin.tgz | tar xz", test: "playwright install chromium && vitest" },
				dependencies: { "@prisma/client": "^6.1.0", widget: "github:acme/widget" },
				devDependencies: { "@playwright/test": "^1.65.0" },
			}),
		},
		{ path: ".npmrc", text: "@acme:registry=https://npm.pkg.github.com\n# registry=https://old.example-mirror.org\n" },
		{ path: "package-lock.json", text: JSON.stringify({ packages: { "node_modules/a": { resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz", funding: { url: "https://patreon.com/a" } }, "node_modules/b": { resolved: "https://npm.internal-mirror.io/b/-/b-2.0.0.tgz" } } }) },
		{ path: "requirements.txt", text: "--extra-index-url https://pypi.acme-packages.net/simple\nrequests==2.32\n" },
		{ path: "pyproject.toml", text: '[project]\nname = "harbor"\n[project.urls]\nHomepage = "https://docs.harbor.dev"\n[[tool.uv.index]]\nname = "torch"\nurl = "https://download.pytorch.org/whl/cpu"\n' },
		{ path: ".github/workflows/ci.yml", text: "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Docs\n        with:\n          url: https://not-a-step.docs-host.io\n      - run: |\n          sudo apt-get install -y libvips\n          curl -sSL https://get.toolchain.dev/install.sh | sh\n" },
		{ path: "binding.gyp", text: "{}" },
	];
	const proposals = scanForHosts(files, "wget https://assets.cdn-host.org/fixtures.zip\nnpm ci", ["registry.npmjs.org", "github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "release-assets.githubusercontent.com", "pypi.org", "files.pythonhosted.org", "registry.yarnpkg.com"]);
	const entries = proposals.map((proposal) => proposal.entry);
	const sourceOf = (entry: string) => proposals.find((proposal) => proposal.entry === entry)?.sources ?? [];
	expect("what install scripts, a dependency and CI steps fetch from is proposed", ["downloads.toolhost.io", "get.toolchain.dev", "npm.pkg.github.com", "npm.internal-mirror.io", "pypi.acme-packages.net", "download.pytorch.org", "assets.cdn-host.org"].every((host) => entries.includes(host)), plain(entries));
	expect("presets are proposed for the tools that fetch more: Playwright, Prisma, apt, node-gyp", ["@playwright", "@prisma", "@ubuntu", "@node"].every((preset) => entries.includes(preset)), plain(entries));
	expect("each says where it was found", sourceOf("downloads.toolhost.io").includes("package.json scripts.postinstall") && sourceOf("@playwright").includes("package.json devDependencies.@playwright/test") && sourceOf("@playwright").includes("package.json scripts.test") && sourceOf("get.toolchain.dev").includes(".github/workflows/ci.yml line 12") && sourceOf("assets.cdn-host.org").includes("the setup command, line 1"));
	expect("pages about the project, funding links, comments and CI settings that are no steps are not proposed", !["harbor.dev", "gitlab.com", "opencollective.com", "patreon.com", "docs.harbor.dev", "old.example-mirror.org", "not-a-step.docs-host.io"].some((host) => entries.includes(host)), plain(entries));
	expect("what the sandboxes reach already is not proposed, and neither is a preset they reach whole", !entries.includes("registry.npmjs.org") && !entries.includes("@github") && !entries.includes("@npm") && !entries.includes("@pypi"), plain(entries));
	expect("presets come first, then hosts by name", entries.findIndex((entry) => !entry.startsWith("@")) > entries.lastIndexOf("@ubuntu") && plain(entries.filter((entry) => !entry.startsWith("@"))) === plain(entries.filter((entry) => !entry.startsWith("@")).sort()));
	expect("a preset's proposal names its hosts", plain(proposals.find((proposal) => proposal.entry === "@prisma")?.hosts) === plain(["binaries.prisma.sh"]));
	expect("an empty repository proposes nothing", scanForHosts([], "", []).length === 0);
	expect("Playwright's tests propose @gcs too, saying why, since its Chromium download redirects to Google Cloud Storage", /Playwright's Chromium redirects there/.test(sourceOf("@gcs").join(" ")));
	const longKey = "x".repeat(5000);
	const long = scanForHosts([{ path: "package.json", text: JSON.stringify({ config: { [longKey]: "https://downloads.long-key.io/a.tgz" } }) }], "", []);
	expect(`each "where found" is at most ${MAX_SOURCE_CHARS} characters, whatever a manifest's keys are`, long.length === 1 && long.every((proposal) => proposal.sources.every((source) => source.length <= MAX_SOURCE_CHARS)), plain(long.map((proposal) => proposal.sources.map((source) => source.length))));
}

// ---- reading the files from GitHub, within the budget ------------------------------------------------

{
	const sha = (n: number) => n.toString(16).padStart(40, "0");
	const sizes = [3_900_000, 3_900_000, 3_900_000, 3_900_000, 3_900_000, 100];
	const app = new GithubApp({} as GithubAppSettings, { clientSecret: () => null, privateKey: () => null });
	let blobs = 0;
	// The tree says every file is small; the blobs are as large as `sizes` says. The budget holds to what is read, not to what the tree said.
	(app as unknown as { call: (call: { path: string }) => Promise<{ body: unknown }> }).call = async ({ path }) => {
		if (path.includes("/commits/")) return { body: { sha: sha(1), commit: { tree: { sha: sha(2) } } } };
		if (path.includes("/git/trees/")) return { body: { truncated: false, tree: sizes.map((_, index) => ({ path: `p${index}/yarn.lock`, type: "blob", sha: sha(100 + index), size: 10 })) } };
		const index = Number.parseInt(path.split("/").at(-1)!, 16) - 100;
		blobs += 1;
		return { body: { encoding: "base64", content: Buffer.alloc(sizes[index] ?? 0, 97).toString("base64") } };
	};
	const read = await app.scanFiles("t", "acme", "harbor", "main", scanPaths);
	const total = read.files.reduce((sum, file) => sum + file.text.length, 0);
	expect("the files read from GitHub come to at most 16 MiB in all, even where the tree's sizes were wrong, and the scan says it is incomplete", total <= SCAN_TOTAL_BYTES && read.files.length === 5 && !read.files.some((file) => file.path === "p4/yarn.lock") && read.incomplete, `${read.files.length} files, ${total} bytes, ${blobs} blobs asked for`);
	sizes[0] = 5_000_000;
	const big = await app.scanFiles("t", "acme", "harbor", "main", scanPaths);
	expect("a blob larger than a lockfile may be is passed over", !big.files.some((file) => file.path === "p0/yarn.lock") && big.incomplete);
}

// ---- the lookup stub ----------------------------------------------------------------------------

expect("the guest script is valid shell", spawnSync("sh", ["-n", "-c", GUEST_DNS_SCRIPT]).status === 0);
expect("blocked lookups: each once, without reverse lookups, single labels and allowed names", plain(blockedLookups("1 1 cdn.example.org\n1 28 cdn.example.org\n1 12 4.3.2.1.in-addr.arpa\n1 1 printer\n1 28 registry.npmjs.org\n1 1 Other.Example.net.\ngarbage line\n", ["registry.npmjs.org"])) === plain(["cdn.example.org", "other.example.net"]));
{
	const noise = Array.from({ length: 60 }, (_, index) => `n${index}.example.org`);
	const log = [...noise, "real.example.org"].map((name) => `1 1 ${name}`).join("\n");
	expect("blocked lookups: names seen already are left out before the limit, so 60 of them do not hide a later one", plain(blockedLookups(log, noise)) === plain(["real.example.org"]) && !blockedLookups(log, []).includes("real.example.org"));
	expect("the guest script stages under a name of its own in /run and holds a lock for all of it", /mktemp \/run\/wlp-hosts\.XXXXXX/.test(GUEST_DNS_SCRIPT) && /flock -w \d+ 9/.test(GUEST_DNS_SCRIPT) && !GUEST_DNS_SCRIPT.includes("/tmp/wlp-hosts") && /9>&- &/.test(GUEST_DNS_SCRIPT));
}

function question(name: string, type = 1, id = 0x4242): Buffer {
	const labels = name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "latin1")]));
	return Buffer.concat([Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, type >> 8, type & 0xff, 0, 1])]);
}
function udp(port: number, packet: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const socket = dgram.createSocket("udp4");
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error("no answer"));
		}, 3000);
		socket.on("message", (message) => {
			clearTimeout(timer);
			socket.close();
			resolve(message);
		});
		socket.send(packet, port, "127.0.0.1");
	});
}
function tcp(port: number, packet: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1");
		let data = Buffer.alloc(0);
		socket.setTimeout(3000, () => {
			socket.destroy();
			reject(new Error("no answer"));
		});
		socket.on("connect", () => socket.write(Buffer.concat([Buffer.from([packet.length >> 8, packet.length & 0xff]), packet])));
		socket.on("data", (chunk) => (data = Buffer.concat([data, chunk])));
		socket.on("close", () => resolve(data.subarray(2)));
		socket.on("error", reject);
	});
}

const python = spawnSync("python3", ["--version"]).status === 0;
if (!python) console.log("skip  the lookup stub: no python3 here");
else {
	const dir = mkdtempSync(join(tmpdir(), "wlp-dns-"));
	const port = 20000 + Math.floor(Math.random() * 20000);
	const log = join(dir, "dns.log");
	writeFileSync(join(dir, "wlp-dns.py"), DNS_STUB);
	const stub = spawn("python3", ["-I", join(dir, "wlp-dns.py"), String(port), log], { stdio: "ignore" });
	try {
		await new Promise((resolve) => setTimeout(resolve, 600));
		const asked = question("Cdn.Example.org");
		const answer = await udp(port, asked);
		expect("the stub answers NXDOMAIN at once, with the question and its id", answer.readUInt16BE(0) === 0x4242 && (answer[2]! & 0x80) !== 0 && (answer[3]! & 0x0f) === 3 && answer.readUInt16BE(4) === 1 && answer.subarray(12).equals(asked.subarray(12)));
		expect("over TCP too", ((await tcp(port, question("tcp.example.net")))[3]! & 0x0f) === 3);
		await udp(port, question("cdn.example.org", 28));
		await udp(port, question("bad label.example.org"));
		const malformed = await udp(port, Buffer.from([0, 7, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 40, 97]));
		expect("a question it cannot read is answered FORMERR", (malformed[3]! & 0x0f) === 1 && malformed.readUInt16BE(0) === 7);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const written = readFileSync(log, "utf8");
		expect("each name is written once, lower case, and one with other characters not at all", plain(written.trim().split("\n").map((line) => line.split(" ")[2])) === plain(["cdn.example.org", "tcp.example.net"]), written);
		expect("the platform reads back the names the sandbox may not reach", plain(blockedLookups(written, ["tcp.example.net"])) === plain(["cdn.example.org"]));
		// A client that sends its question a byte at a time, slower than any one wait: it has one second in all, and the lookups behind it go on.
		const slow = net.connect(port, "127.0.0.1");
		await new Promise<void>((resolve) => slow.on("connect", () => resolve()));
		const drip = question("drip.example.net");
		const framed = Buffer.concat([Buffer.from([drip.length >> 8, drip.length & 0xff]), drip]);
		let sent = 0;
		const dripping = setInterval(() => {
			if (sent < framed.length && !slow.destroyed) slow.write(framed.subarray(sent, ++sent));
		}, 400);
		slow.on("error", () => undefined);
		await new Promise((resolve) => setTimeout(resolve, 150));
		const waits: number[] = [];
		for (let index = 0; index < 4; index += 1) {
			const began = Date.now();
			await udp(port, question(`after${index}.example.net`));
			waits.push(Date.now() - began);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		clearInterval(dripping);
		slow.destroy();
		expect("a TCP client that sends a byte now and then holds the stub for at most a second: the lookups behind it are answered", Math.max(...waits) < 1500 && waits.slice(1).every((wait) => wait < 300), plain(waits));
	} catch (error) {
		expect("the lookup stub answered", false, String(error));
	} finally {
		stub.kill();
		rmSync(dir, { recursive: true, force: true });
	}
}

if (failed > 0) {
	console.log(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall passed");
