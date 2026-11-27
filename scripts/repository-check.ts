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
import { MAX_REPOSITORY_DEFAULTS, type MachineSummary, type ModelList, type RepositoryDefaults, type SandboxProfile } from "../server/src/contract.js";
import { readAccountDefaults, saveAccountDefaults } from "../server/src/repository-defaults.js";
import { resolveStartPlace } from "../server/src/start-place.js";
import { DEFAULTS_TABLE, type DefaultsChange, type DefaultsDb, DefaultsProblem, cleanDefaults, readDefaults, saveDefaults } from "../server/src/repository-defaults.js";
import { OkReport } from "./check-report.js";

const tally = new OkReport();
const { expect } = tally;

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
expect("a review model must be offered by the account or a checked key", refused({ reviewModel: "anthropic/missing" })?.code === "bad_model" && cleanDefaults({ reviewModel: "gpt-6-luna" }, PROFILES, MODELS).reviewModel === "gpt-6-luna");
expect("a field that is left out is not part of the change", plain(cleanDefaults({ model: "gpt-6-luna" }, PROFILES, MODELS)) === plain({ model: "gpt-6-luna" }) && plain(cleanDefaults({}, PROFILES, MODELS)) === "{}");
expect("null saves none for a field", plain(cleanDefaults({ profile: null, model: null }, PROFILES, MODELS)) === plain({ profile: null, model: null }));
expect("screenshots must be a boolean", [null, 0, "false"].every(screenshots => refused({ screenshots })?.code === "bad_input"));
expect("autonomy settings require booleans", ["autoApprovePlans", "autoMergeSingles", "waitForCiOnEachPart"].every(key => [null, 1, "false"].every(value => refused({ [key]: value })?.code === "bad_input")));
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
	return { db, rows: () => sqlite.prepare("SELECT project, label, settings, updated_at FROM repository_defaults ORDER BY project").all() as Array<Record<string, unknown>> };
}

const HARBOR = "github:7101";
const QUAY = "github:7105";
const values = (defaults: RepositoryDefaults) => plain([defaults.profile, defaults.model]);

{
	const { db, rows } = database();
	expect("nothing is kept for a repository nobody saved anything for", plain(await readDefaults(db, HARBOR)) === plain({ place: null, harness: null, machineProfile: null, placeFallback: null, screenshots: false, profile: null, model: null, hostedSize: null, updatedAt: null }) && rows().length === 0);
	expect("a change that names no field keeps nothing either", values(await saveDefaults(db, HARBOR, "acme/harbor", {}, 1)) === plain([null, null]) && rows().length === 0);
	expect("screenshot opt-in is stored without other defaults", (await saveDefaults(db, HARBOR, "", cleanDefaults({ screenshots: true }, PROFILES, MODELS), 2)).screenshots && (await readDefaults(db, HARBOR)).screenshots);
	expect("opting out restores the repository default", (await saveDefaults(db, HARBOR, "", { screenshots: false }, 3)).screenshots === false && rows().length === 0);
	await saveDefaults(db, HARBOR, "", { reviewModel: "gpt-6-luna", reviewEffort: "high" }, 4);
	await saveDefaults(db, HARBOR, "", { reviewModel: null }, 5);
	expect("clearing the review model preserves the separate effort", (await readDefaults(db, HARBOR)).reviewEffort === "high");
	await saveDefaults(db, HARBOR, "", { reviewEffort: null }, 6);
	const first = await saveDefaults(db, HARBOR, "acme/harbor", { profile: "docker-hardened" }, 10);
	expect("a sandbox saved alone leaves the model as none, and says when", !first.screenshots && values(first) === plain(["docker-hardened", null]) && first.updatedAt === 10, plain(first));
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
	expect("clearing the last one leaves no row", plain(gone) === plain({ place: null, harness: null, machineProfile: null, placeFallback: null, screenshots: false, profile: null, model: null, hostedSize: null, updatedAt: null }) && rows().length === 1 && rows()[0]?.project === QUAY, plain(rows()));
}

// ---- where interactive agents start ---------------------------------------------------------------

{
	const { db } = database();
	const nas: MachineSummary = {
		machineId: "nas", name: "nas", os: "linux", arch: "arm64", status: "offline", runnerVersion: "1", since: 0, agents: 0,
		sandboxes: [], commandSandbox: null, freeDiskBytes: null, profiles: PROFILES.slice(0, 2), sendSecrets: false, warnings: [],
	};
	const laptop = { ...nas, machineId: "laptop", name: "laptop" };
	const machines = [nas, laptop];
	const machine = { kind: "machine", machineId: nas.machineId, profile: "docker-hardened" } as const;
	const hosted = { kind: "hosted" } as const;
	const clean = (startPlace: unknown) => cleanDefaults({ startPlace }, PROFILES, MODELS, [], machines);
	for (const bad of [{ ...machine, machineId: "foreign" }, { ...machine, profile: "e2b" }, { kind: "machine", machineId: "nas" }, "any-machine"]) {
		let rejected = false;
		try { clean(bad); } catch (e) { rejected = e instanceof DefaultsProblem && e.code === "bad_input"; }
		expect("rejects an invalid start place " + plain(bad), rejected);
	}
	await saveAccountDefaults(db, clean(machine), 1);
	await saveAccountDefaults(db, { profile: "docker-windlass-sandbox" }, 2);
	await saveDefaults(db, HARBOR, "", clean({ ...machine, machineId: "laptop" }), 3);
	const account = (await readAccountDefaults(db)).startPlace;
	const repo = await readDefaults(db, HARBOR);
	expect("each scope retains its machine and profile independently of hosted sandbox and work items",
		plain(account) === plain(machine) && plain(repo.startPlace) === plain({ ...machine, machineId: "laptop" }) && typeof repo.place === "object" && repo.place?.machine === "laptop");
	const saved = { machines, account, repository: repo.startPlace };
	expect("a launch choice precedes saved places", resolveStartPlace({ ...saved, launch: hosted }).source === "launch");
	const chosen = resolveStartPlace(saved);
	expect("a repository machine and its own profile win", chosen.machine === laptop && chosen.profile === machine.profile);
	const unpaired = resolveStartPlace({ ...saved, machines: [nas] });
	expect("an unpaired repository machine falls through to the account with an explanation", unpaired.machine === nas && unpaired.notes[0]?.includes("no longer paired") === true);
	const disallowed = resolveStartPlace({ ...saved, machines: [nas, { ...laptop, allowedProfiles: ["docker-windlass-sandbox"] }] });
	expect("a withdrawn profile falls through too", disallowed.machine === nas && disallowed.notes.length === 1);
	expect("with no usable machine the deployment wins", resolveStartPlace({ ...saved, machines: [] }).source === "deployment default");
	expect("a pending inventory cannot launch the fallback early", resolveStartPlace({ ...saved, machines: null }).pending === true);
	await saveDefaults(db, HARBOR, "", clean(hosted), 4);
	expect("explicit Hosted overrides an account machine", resolveStartPlace({ ...saved, repository: (await readDefaults(db, HARBOR)).startPlace }).source === "repository default");
	await saveDefaults(db, HARBOR, "", clean(null), 5);
	await saveAccountDefaults(db, clean(null), 6);
	expect("clearing the start place leaves work-item placement and the hosted profile intact", !(await readDefaults(db, HARBOR)).startPlace && (await readDefaults(db, HARBOR)).place === null &&
		!(await readAccountDefaults(db)).startPlace && (await readAccountDefaults(db)).profile === "docker-windlass-sandbox");
}

// ---- the hosted size ------------------------------------------------------------------------------

{
	const { db, rows } = database();
	const sizes = ["small", "standard", "large"] as const;
	expect("a hosted size is taken only where the deployment offers it", cleanDefaults({ hostedSize: "large" }, PROFILES, MODELS, sizes).hostedSize === "large" && cleanDefaults({ hostedSize: null }, PROFILES, MODELS, sizes).hostedSize === null);
	expect("one it does not offer, or that is no size, is refused", ["huge", 4].every((raw) => { try { cleanDefaults({ hostedSize: raw }, PROFILES, MODELS, sizes); return false; } catch (error) { return error instanceof DefaultsProblem && error.code === "bad_input"; } }) && (() => { try { cleanDefaults({ hostedSize: "standard" }, PROFILES, MODELS, ["small"]); return false; } catch { return true; } })());
	const saved = await saveDefaults(db, HARBOR, "acme/harbor", { hostedSize: "standard" }, 10);
	expect("a size saved alone is a row of its own", saved.hostedSize === "standard" && saved.profile === null && rows().length === 1, plain(saved));
	const model = await saveDefaults(db, HARBOR, "", { model: "gpt-6-luna" }, 20);
	expect("a model saved after it leaves the size as it is", model.hostedSize === "standard" && model.model === "gpt-6-luna");
	await saveDefaults(db, HARBOR, "", { model: null }, 30);
	expect("clearing the model keeps the row for the size", (await readDefaults(db, HARBOR)).hostedSize === "standard" && rows().length === 1);
	const gone = await saveDefaults(db, HARBOR, "", { hostedSize: null }, 40);
	expect("clearing the size, the last field, leaves no row", gone.hostedSize === null && rows().length === 0);

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
	await db.execute("INSERT OR REPLACE INTO repository_defaults (project, label, settings, updated_at) VALUES (?, 'acme/harbor', ?, ?)", HARBOR, JSON.stringify(next), now);
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
	for (let index = 0; index < MAX_REPOSITORY_DEFAULTS; index += 1) await saveDefaults(db, `github:${index + 1}`, "", { model: "gpt-6-luna" }, 1_000 + index);
	const refused = await saveDefaults(db, `github:${MAX_REPOSITORY_DEFAULTS + 1}`, "", { model: "gpt-6-luna" }, 9_000).then(() => null, (error: Error) => error.name);
	const resaved = await saveDefaults(db, "github:1", "", { model: "gpt-6-sol" }, 9_001).then(() => true, () => false);
	const kept = rows().map((row) => String(row.project));
	expect(
		`at ${MAX_REPOSITORY_DEFAULTS} repositories a new one is refused, and no other repository's defaults are dropped`,
		refused === "RepositoryLimit" && resaved && kept.length === MAX_REPOSITORY_DEFAULTS && kept.includes("github:1") && !kept.includes(`github:${MAX_REPOSITORY_DEFAULTS + 1}`),
		`${kept.length} rows, refused ${refused}, resaved ${resaved}`,
	);
}

process.exit(tally.summary("\nAll checks passed.", (failed) => `\n${failed} check(s) failed.`));
