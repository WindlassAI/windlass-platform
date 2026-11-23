/** The harnesses the composer offers on a machine, for an agent and for a work item, and the profiles an item of each runs in. */
import type { MachineSummary } from "@contract";
import { afterEach, describe, expect, it } from "vitest";
import { OPENCODE } from "../../../server/src/sandbox/harnesses.js";
import { agentChoices } from "../lib/subtask-agents";
import { itemAgentLine, itemHarnesses, itemProfilesHere, offeredHarnesses, onPullRequest } from "./PlaceChoice";

const machine = (harnesses: { id: string; signIn: string; modes?: string[] }[], profiles = ["docker-hardened", "docker-windlass-sandbox"]) =>
	({ machineId: "m_1", name: "Bench", harnesses, profiles: profiles.map((id) => ({ id, available: true })) }) as unknown as MachineSummary;

describe("itemHarnesses", () => {
	it("offers a work item the signed-in agents work items run, Codex among them", () => {
		const bench = machine([
			{ id: "claude", signIn: "token" },
			{ id: "opencode", signIn: "token" },
			{ id: "codex", signIn: "token" },
		]);
		expect(offeredHarnesses(bench).map((h) => h.id)).toEqual(["claude", "opencode", "codex"]);
		expect(itemHarnesses(bench).map((h) => h.id)).toEqual(["claude", "opencode", "codex"]);
	});

	it("leaves out an agent the machine does not report signed in", () => {
		expect(itemHarnesses(machine([{ id: "claude", signIn: "none" }, { id: "opencode", signIn: "token" }])).map((h) => h.id)).toEqual(["opencode"]);
	});

	it("never offers Codex for a Plan-first subtask", () => {
		const bench = machine([{ id: "claude", signIn: "token" }, { id: "codex", signIn: "token" }]);
		expect(agentChoices(bench).map((choice) => choice.id)).toEqual(["windlass", "claude"]);
	});
});

describe("itemProfilesHere", () => {
	it("runs a Codex item in Codex's sandbox first, once its probe passed, and on Docker, hardened", () => {
		expect(itemProfilesHere(machine([{ id: "codex", signIn: "token", modes: ["agent-full-access", "read-only", "workspace-write"] }]), "codex")).toEqual(["docker-windlass-sandbox", "docker-hardened"]);
		expect(itemProfilesHere(machine([{ id: "codex", signIn: "token", modes: ["agent-full-access"] }]), "codex")).toEqual(["docker-hardened"]);
		expect(itemProfilesHere(machine([{ id: "codex", signIn: "token", modes: ["workspace-write"] }], ["docker-hardened"]), "codex")).toEqual(["docker-hardened"]);
	});

	it("runs Claude Code and OpenCode items only on Docker, hardened", () => {
		const bench = machine([{ id: "claude", signIn: "token" }]);
		expect(itemProfilesHere(bench, "claude")).toEqual(["docker-hardened"]);
		expect(itemProfilesHere(machine([{ id: "claude", signIn: "token" }], ["docker-windlass-sandbox"]), "claude")).toEqual([]);
	});
});

describe("itemAgentLine", () => {
	it("says Codex works without asking only on Docker, hardened", () => {
		expect(itemAgentLine("codex", "docker-hardened")).toMatch(/^Codex works in the hardened container, without asking, and runs Quick\./);
		expect(itemAgentLine("codex", "docker-windlass-sandbox")).toMatch(/^Codex works in its own sandbox, without network, and runs Quick\. A request to leave the sandbox ends the step\./);
		expect(itemAgentLine("claude", "docker-hardened")).toMatch(/^Claude Code works in the hardened container, without asking/);
	});
	it("says the platform runs the repository's saved checks for every machine agent", () => {
		for (const harness of ["claude", "opencode", "codex"] as const) expect(itemAgentLine(harness, "docker-hardened")).toMatch(/The platform runs your repository's saved checks when it ends a turn/);
	});
});

describe("itemAgentLine, by the agent's checks flag", () => {
	// OpenCode is given a record whose checks nobody runs: the lines follow the flag, not the name.
	const kept = OPENCODE.capabilities;
	afterEach(() => { OPENCODE.capabilities = kept; });

	it("says CI decides for an agent whose checks nobody runs, and where the platform cannot run them", () => {
		OPENCODE.capabilities = Object.freeze({ ...kept, checks: "none" as const });
		expect(itemAgentLine("opencode", "docker-hardened")).toBe("OpenCode works in the hardened container, without asking, and runs Quick. It does not run your repository's checks: CI decides.");
		expect(onPullRequest("opencode")).toBe(" It does not run this repository's checks; CI's result is on the pull request.");
		expect(itemAgentLine("claude", "docker-hardened")).toMatch(/The platform runs your repository's saved checks when it ends a turn/);
		expect(onPullRequest("claude")).toBe(" The platform runs this repository's saved checks when it ends a turn, and CI's result is on the pull request.");
		// Codex in its own sandbox: the platform does not run what it changed there (platform-checks.ts).
		expect(itemAgentLine("codex", "docker-windlass-sandbox")).toMatch(/CI decides\.$/);
	});
});
