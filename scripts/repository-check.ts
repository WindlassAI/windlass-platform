/**
 * The rules of a repository's defaults for new sessions (server/src/repository-defaults.ts), on their
 * own: no server, no sandbox, nothing sent anywhere. The storage runs against a SQLite database in
 * memory, behind a door that makes every statement wait a little, as the actor's database does: so
 * two saves started together take turns statement by statement, in an order that differs from round
 * to round.
 *
 *   cd server && npx tsx ../scripts/repository-check.ts
 *
 * What it holds to: a default is a sandbox this deployment can run and a model it offers, or none; a
 * save changes the fields it names and no others, also when another save runs between its statements;
 * nothing is kept for a repository until something is saved, and nothing is left when it is cleared.
 */

import { DatabaseSync } from "node:sqlite";
import { MAX_REPOSITORY_DEFAULTS, type ModelList, type RepositoryDefaults, type SandboxProfile } from "../server/src/contract.js";
import { DEFAULTS_TABLE, type DefaultsChange, type DefaultsDb, DefaultsProblem, cleanDefaults, readDefaults, saveDefaults } from "../server/src/repository-defaults.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
}

const plain = (value: unknown) => JSON.stringify(value);

// ---- what may be saved ---------------------------------------------------------------------------

const profile = (id: string, available = true): SandboxProfile => ({
	id: id as SandboxProfile["id"],
	name: id === "e2b" ? "E2B" : "Docker + Windlass sandbox",
	summary: "",
	layers: [],
	approval: "auto",
	commandNetwork: false,
	commandsCanReadAccessToken: false,
	available,
	...(available ? {} : { unavailableReason: "It needs an E2B key." }),
});
const PROFILES = [profile("docker-windlass-sandbox"), profile("docker-hardened"), profile("e2b", false)];
const MODELS: ModelList = { source: "account", models: ["gpt-6.1-sol", "gpt-6-luna"].map((id) => ({ id, name: null, efforts: [] })), defaultModel: "gpt-6.1-sol", fetchedAt: 1 };

function refused(raw: unknown): { code: string; message: string } | null {
	try {
		cleanDefaults(raw, PROFILES, MODELS);
		return null;
	} catch (error) {
		return error instanceof DefaultsProblem ? { code: error.code, message: error.message } : { code: "another error", message: String(error) };
	}
}

expect("a sandbox this deployment can run and one of the user's models are taken", plain(cleanDefaults({ profile: "docker-hardened", model: "gpt-6-luna" }, PROFILES, MODELS)) === plain({ profile: "docker-hardened", model: "gpt-6-luna" }));
expect("a field that is left out is not part of the change", plain(cleanDefaults({ model: "gpt-6-luna" }, PROFILES, MODELS)) === plain({ model: "gpt-6-luna" }) && plain(cleanDefaults({}, PROFILES, MODELS)) === "{}");
expect("null saves none for a field", plain(cleanDefaults({ profile: null, model: null }, PROFILES, MODELS)) === plain({ profile: null, model: null }));
expect("nothing else a client sends is kept", plain(cleanDefaults({ repositoryId: 7, model: "gpt-6-luna", publishUnasked: true, setupCommand: "rm -rf /" }, PROFILES, MODELS)) === plain({ model: "gpt-6-luna" }));
expect("a sandbox this deployment does not have is refused", refused({ profile: "firecracker" })?.code === "bad_input" && refused({ profile: 7 })?.code === "bad_input" && refused({ profile: "" })?.code === "bad_input");
expect("a sandbox it cannot run is refused, and the sentence says why", refused({ profile: "e2b" })?.code === "bad_input" && (refused({ profile: "e2b" })?.message ?? "").includes("It needs an E2B key."), refused({ profile: "e2b" })?.message);
expect("a model that is not among the user's is refused, and the sentence names the ones that are", refused({ model: "gpt-3" })?.code === "bad_model" && (refused({ model: "gpt-3" })?.message ?? "").includes("gpt-6.1-sol, gpt-6-luna") && refused({ model: "" })?.code === "bad_model" && refused({ model: ["gpt-6-luna"] })?.code === "bad_model");
expect("what is not an object changes nothing", [undefined, null, "docker-hardened", 7].every((raw) => plain(cleanDefaults(raw, PROFILES, MODELS)) === "{}"));

// ---- how it is saved -----------------------------------------------------------------------------

/** A database whose every statement waits a moment first: whoever started another call meanwhile gets a turn. */
function database(): { db: DefaultsDb; rows(): Array<Record<string, unknown>> } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DEFAULTS_TABLE);
	const db: DefaultsDb = {
		async execute<Row extends Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> {
			for (let waits = Math.floor(Math.random() * 4); waits >= 0; waits -= 1) await new Promise<void>((done) => setImmediate(done));
			return sqlite.prepare(query).all(...(args as Array<string | number | null>)) as Row[];
		},
	};
	return { db, rows: () => sqlite.prepare("SELECT project, label, profile, model, updated_at FROM repository_defaults ORDER BY project").all() as Array<Record<string, unknown>> };
}

const HARBOR = "github:7101";
const QUAY = "github:7105";
const values = (defaults: RepositoryDefaults) => plain([defaults.profile, defaults.model]);

{
	const { db, rows } = database();
	expect("nothing is kept for a repository nobody saved anything for", plain(await readDefaults(db, HARBOR)) === plain({ profile: null, model: null, updatedAt: null }) && rows().length === 0);
	expect("a change that names no field keeps nothing either", values(await saveDefaults(db, HARBOR, "acme/harbor", {}, 1)) === plain([null, null]) && rows().length === 0);
	const first = await saveDefaults(db, HARBOR, "acme/harbor", { profile: "docker-hardened" }, 10);
	expect("a sandbox saved alone leaves the model as none, and says when", values(first) === plain(["docker-hardened", null]) && first.updatedAt === 10, plain(first));
	const second = await saveDefaults(db, HARBOR, "", { model: "gpt-6-luna" }, 20);
	expect("a model saved after it leaves the sandbox as it is", values(second) === plain(["docker-hardened", "gpt-6-luna"]) && second.updatedAt === 20, plain(second));
	expect("a save that cannot name the repository keeps the name it had", rows()[0]?.label === "acme/harbor", plain(rows()));
	await saveDefaults(db, HARBOR, "acme/haven", { model: "gpt-6.1-sol" }, 30);
	expect("a save that names it anew is believed", rows()[0]?.label === "acme/haven");
	await saveDefaults(db, QUAY, "acme/quay", { model: "gpt-6-luna" }, 40);
	expect("another repository has its own", values(await readDefaults(db, QUAY)) === plain([null, "gpt-6-luna"]) && values(await readDefaults(db, HARBOR)) === plain(["docker-hardened", "gpt-6.1-sol"]));
	const cleared = await saveDefaults(db, HARBOR, "", { profile: null }, 50);
	expect("clearing one field keeps the other", values(cleared) === plain([null, "gpt-6.1-sol"]) && rows().length === 2);
	const gone = await saveDefaults(db, HARBOR, "", { model: null }, 60);
	expect("clearing the last one leaves no row", plain(gone) === plain({ profile: null, model: null, updatedAt: null }) && rows().length === 1 && rows()[0]?.project === QUAY, plain(rows()));
}

// ---- two saves at once ---------------------------------------------------------------------------

const ROUNDS = 300;

/** Runs `saves` together on a row that holds `before`, `ROUNDS` times; answers how often the row came out as `after`. */
async function together(before: DefaultsChange, saves: (db: DefaultsDb, round: number) => Array<Promise<unknown>>, after: [string | null, string | null]): Promise<{ right: number; wrong: string[] }> {
	let right = 0;
	const wrong = new Set<string>();
	for (let round = 0; round < ROUNDS; round += 1) {
		const { db } = database();
		await saveDefaults(db, HARBOR, "acme/harbor", before, 1);
		await Promise.all(saves(db, round));
		const now = values(await readDefaults(db, HARBOR));
		if (now === plain(after)) right += 1;
		else wrong.add(now);
	}
	return { right, wrong: [...wrong] };
}

/** The save this file does not do: reads the row, changes it in memory, writes all of it back. */
async function wholeRowSave(db: DefaultsDb, change: DefaultsChange, now: number): Promise<void> {
	const row = await readDefaults(db, HARBOR);
	const next = { profile: change.profile === undefined ? row.profile : change.profile, model: change.model === undefined ? row.model : change.model };
	await db.execute("INSERT OR REPLACE INTO repository_defaults (project, label, profile, model, updated_at) VALUES (?, 'acme/harbor', ?, ?, ?)", HARBOR, next.profile, next.model, now);
}

{
	const start: DefaultsChange = { profile: "docker-windlass-sandbox", model: "gpt-6.1-sol" };
	const both = await together(start, (db, round) => [saveDefaults(db, HARBOR, "", { profile: "docker-hardened" }, 100 + round), saveDefaults(db, HARBOR, "", { model: "gpt-6-luna" }, 100 + round)], ["docker-hardened", "gpt-6-luna"]);
	expect(`a save of the sandbox and a save of the model that run together both stay (${ROUNDS} rounds)`, both.right === ROUNDS, `${both.right} of ${ROUNDS}; otherwise ${both.wrong.join(" | ")}`);

	const naive = await together(start, (db, round) => [wholeRowSave(db, { profile: "docker-hardened" }, 100 + round), wholeRowSave(db, { model: "gpt-6-luna" }, 100 + round)], ["docker-hardened", "gpt-6-luna"]);
	expect("the same two saves made by reading the row and writing it back whole lose one: these rounds do interleave", naive.right < ROUNDS, `all ${ROUNDS} rounds kept both, so the check above proves nothing`);

	const clearing = await together({ profile: "docker-windlass-sandbox" }, (db, round) => [saveDefaults(db, HARBOR, "", { profile: null }, 100 + round), saveDefaults(db, HARBOR, "", { model: "gpt-6-luna" }, 100 + round)], [null, "gpt-6-luna"]);
	expect("clearing the only field while another is saved leaves the other, and its row", clearing.right === ROUNDS, `${clearing.right} of ${ROUNDS}; otherwise ${clearing.wrong.join(" | ")}`);

	const other = await together(start, (db, round) => [saveDefaults(db, HARBOR, "", { profile: "docker-hardened" }, 100 + round), saveDefaults(db, QUAY, "acme/quay", { profile: "docker-windlass-sandbox", model: "gpt-6-luna" }, 100 + round), saveDefaults(db, QUAY, "", { profile: null, model: null }, 200 + round)], ["docker-hardened", "gpt-6.1-sol"]);
	expect("saves for another repository, and its clearing, leave this one's alone", other.right === ROUNDS, `${other.right} of ${ROUNDS}; otherwise ${other.wrong.join(" | ")}`);
}

// ---- how many are kept ---------------------------------------------------------------------------

{
	const { db, rows } = database();
	const extra = 5;
	for (let index = 0; index < MAX_REPOSITORY_DEFAULTS + extra; index += 1) await saveDefaults(db, `github:${index + 1}`, "", { model: "gpt-6-luna" }, 1_000 + index);
	const kept = rows().map((row) => String(row.project));
	expect(
		`a user keeps defaults for ${MAX_REPOSITORY_DEFAULTS} repositories at most, and the ones saved longest ago go`,
		kept.length === MAX_REPOSITORY_DEFAULTS && !kept.includes("github:1") && !kept.includes(`github:${extra}`) && kept.includes(`github:${extra + 1}`) && kept.includes(`github:${MAX_REPOSITORY_DEFAULTS + extra}`),
		`${kept.length} rows`,
	);
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
