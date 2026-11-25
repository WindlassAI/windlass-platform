/**
 * Label rules from the jargon audit (vault: Projects/windlass-platform/Prep/Jargon and noise audit 2026-11-25, §13):
 *
 * 1. A sandbox profile reaches the user as "Strict" or "Open" with one outcome line. Provider and technology
 *    names (E2B, Firecracker, seccomp…) are only in its `details` and `layers`, shown behind "How it's isolated".
 * 2. A client is never sent a profile this deployment cannot run.
 * 3. No provider or technology name in a user-facing string of the web app: string literals and JSX text in
 *    screens, components, lib and site. Comments, tests, the mock, docs content and `<code>` are not looked at;
 *    a line that must say one (a "How it's isolated" fold) carries `jargon-ok: <reason>`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { SandboxProfile } from "@contract";
import { e2bOpenProfile, e2bProfile, offeredProfiles, PROFILES, profilesFor, windlassModes } from "../../../server/src/sandbox/profiles";
import { machineProfiles } from "../../../server/src/machines/profiles";
import { createMockClient } from "../api/mock";

/** Provider and technology names, and the old profile names: never in a label, a lede or a menu line. */
const BANNED = /\b(E2B|Firecracker|microVMs?|KVM|Daytona|agentOS|Rivet|bubblewrap|bwrap|seccomp|AppArmor)\b|Docker \+ Windlass|Docker, hardened|Hardened Docker|hardened container|E2B \+ Windlass/;

const offeredEverywhere = (): SandboxProfile[] => [
	...profilesFor("docker"),
	...profilesFor("docker", undefined, true),
	...profilesFor("e2b", { windlassSandbox: true, openProfile: true }),
	...profilesFor("e2b", { windlassSandbox: false, openProfile: true, network: "restricted" }, true),
	e2bProfile({ windlassSandbox: false, network: "none" }),
	e2bOpenProfile({ offered: true, network: "restricted" }),
	...machineProfiles("nas", null),
];

describe("sandbox profile labels", () => {
	it("names every profile Strict or Open, with an outcome line free of provider and technology names", () => {
		for (const profile of [...PROFILES, ...offeredEverywhere()]) {
			expect(["Strict", "Open"], profile.id).toContain(profile.name);
			expect(profile.summary, profile.id).not.toMatch(BANNED);
			expect(profile.summary.split(/\s+/).length, profile.id).toBeLessThanOrEqual(12);
		}
	});

	it("keeps the technical account in details, for the fold", () => {
		for (const profile of offeredEverywhere()) expect(profile.details, profile.id).toBeTruthy();
	});

	it("words the modes by outcome", () => {
		for (const mode of [...windlassModes("auto"), ...windlassModes("full")]) expect(mode.description).not.toMatch(/sandbox machine|command sandbox|Windlass’s/);
	});
});

describe("profiles sent to clients", () => {
	it("leaves out every profile this deployment cannot run", () => {
		for (const list of [profilesFor("docker"), profilesFor("e2b", { windlassSandbox: true, openProfile: false })]) {
			const offered = offeredProfiles(list);
			expect(offered.length).toBeGreaterThan(0);
			expect(offered.every((profile) => profile.available && profile.unavailableReason === undefined)).toBe(true);
		}
		expect(offeredProfiles(profilesFor("docker")).map((profile) => profile.id)).toEqual(["docker-windlass-sandbox", "docker-hardened"]);
		expect(offeredProfiles(profilesFor("e2b", { windlassSandbox: true, openProfile: true })).map((profile) => profile.id)).toEqual(["e2b", "e2b-open"]);
	});

	it("is what the mock serves too", async () => {
		for (const sandbox of [undefined, "e2b"] as const) {
			const client = createMockClient({ pace: 0, origin: "http://localhost:5173", ...(sandbox && { sandbox }) });
			const info = await client.info();
			expect(info.profiles.length).toBeGreaterThan(0);
			expect(info.profiles.every((profile) => profile.available)).toBe(true);
			expect(new Set(info.profiles.map((profile) => profile.name)).size).toBe(info.profiles.length);
			client.dispose();
		}
	});
});

/** Files that are the "How it's isolated" fold itself: the layers and the token's account, by design technical. */
const FOLDS = ["Layers.tsx"];

/** Every .ts and .tsx file under `dir` that ships user-facing words. */
function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return name === "docs" || name === "api" ? [] : sources(path);
		return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !FOLDS.includes(name) ? [path] : [];
	});
}

/** The user-facing words in one file that say a banned name, as "file:line text". */
function offences(path: string): string[] {
	const text = readFileSync(path, "utf8");
	const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const lines = text.split("\n");
	const found: string[] = [];
	const inCode = (node: ts.Node): boolean => {
		for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
			if (ts.isJsxElement(at) && ["code", "Command", "pre", "kbd"].includes(at.openingElement.tagName.getText(file))) return true;
			if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at)) return true;
		}
		return false;
	};
	const visit = (node: ts.Node) => {
		const words = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : ts.isJsxText(node) ? node.getText(file) : null;
		if (words !== null && BANNED.test(words) && !inCode(node)) {
			const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
			if (!/jargon-ok:/.test(lines[line] ?? "") && !/jargon-ok:/.test(lines[line - 1] ?? "")) found.push(`${relative(join(__dirname, ".."), path)}:${line + 1} ${words.trim().slice(0, 80)}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return found;
}

describe("user-facing words of the web app", () => {
	it("name no provider or technology outside code, comments and the isolation fold", () => {
		const root = join(__dirname, "..");
		const files = ["screens", "components", "lib", "site"].flatMap((dir) => sources(join(root, dir)));
		expect(files.flatMap(offences)).toEqual([]);
	});
});

it("keeps the retired levels and percentage rule out of repo setup", () => {
	for (const path of ["../components/RepositorySetupChecks.tsx", "../docs/content/factory.md", "../../../server/src/factory/readiness.ts"]) {
		expect(readFileSync(join(__dirname, path), "utf8"), path).not.toMatch(/\b(?:functional|documented|standardized)\b|80[%]/i);
	}
});
