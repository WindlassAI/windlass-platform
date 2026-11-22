import type { SandboxProfile } from "@contract";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { e2bOpenProfile, e2bProfile, profilesFor } from "../../../server/src/sandbox/profiles";
import { commandNetworkFact, ProfileFacts } from "./Layers";
import { SetupField } from "./SetupCommand";

it("uses the machine's command network sentence in the session panel", () => {
	const profile: SandboxProfile = { id: "docker-hardened", name: "Machine", summary: "", layers: [],
		approval: "full", available: true, commandsCanReadAccessToken: true, commandNetwork: true,
		commandNetworkText: "commands can reach public sites and hosts allowed by the owner through the web proxy" };
	expect(renderToStaticMarkup(createElement(ProfileFacts, { profile }))).toContain(profile.commandNetworkText);
});

it("describes the remaining Claude model route on a machine with general networking disabled", () => {
	const profile: SandboxProfile = { id: "docker-hardened", name: "Machine", summary: "", layers: [],
		approval: "full", available: true, commandsCanReadAccessToken: true, commandNetwork: false, claudeRelay: true };
	const html = renderToStaticMarkup(createElement(ProfileFacts, { profile, claude: { mode: { id: "default", name: "Default", description: null } } }));
	expect(html).toContain("only this session’s Claude model relay");
	expect(html).toContain("relay holds the setup token");
});

it("says what a hosted sandbox's commands reach under the deployment's network mode", () => {
	const restricted = e2bOpenProfile({ offered: true, network: "restricted" });
	expect(renderToStaticMarkup(createElement(ProfileFacts, { profile: restricted }))).toContain("commands can reach only the model API, GitHub and the hosts this deployment allows");
	expect(commandNetworkFact(e2bOpenProfile({ offered: true, network: "none" }), null)).toBe("commands can reach only the model API");
	expect(commandNetworkFact(e2bProfile({ windlassSandbox: true, network: "restricted" }), null)).toBe("commands have no network");
	expect(profilesFor("e2b", { windlassSandbox: false, openProfile: true, network: "open" })).toEqual(profilesFor("e2b", { windlassSandbox: false, openProfile: true }));
	expect(commandNetworkFact(e2bProfile({ windlassSandbox: false }), null)).toBe("commands can reach the network");
});

it("says what a hosted workspace's setup command reaches", () => {
	const setup = { draft: { repositoryId: null, text: "npm ci", saved: "npm ci", touched: false, limitMs: null, error: null }, setText: () => {}, toSave: undefined };
	const html = (egress?: "restricted" | "none") => renderToStaticMarkup(createElement(SetupField, { setup, repository: "acme/quay", disabled: false, egress, hosted: true }));
	expect(html("restricted")).toContain("The workspace can reach only the model API, GitHub and the hosts this deployment allows.");
	expect(html("none")).toContain("The workspace can reach only the model API.");
	expect(html()).toContain("Network access follows the workspace’s network policy.");
});

it("says a relayed sandbox's commands read only a placeholder, from both flags", () => {
	const [sandboxed, hardened] = profilesFor("docker", undefined, true).filter((p) => p.id.startsWith("docker-"));
	expect(hardened!.modelRelay).toBe(true);
	expect(hardened!.commandsCanReadAccessToken).toBe(true);
	expect(hardened!.summary).toContain("Commands can read only a placeholder for this turn. With it they can make model requests on your ChatGPT plan through the relay while the turn runs (8 at once, 32 waiting). The access token never enters the container.");
	expect(hardened!.summary).not.toMatch(/can read the session's access token/);
	expect(renderToStaticMarkup(createElement(ProfileFacts, { profile: hardened! }))).toContain("Commands can read only a placeholder for this turn");
	expect(sandboxed!.summary).toContain("cannot read the session's token file");
	expect(renderToStaticMarkup(createElement(ProfileFacts, { profile: sandboxed! }))).toContain("processes left from setup can read only a placeholder");
	const plain = profilesFor("docker").find((p) => p.id === "docker-hardened")!;
	expect(plain.modelRelay).toBeUndefined();
	expect(plain.summary).toContain("can read the session's access token and its replacements");
	const e2b = profilesFor("e2b", { windlassSandbox: false, openProfile: true, network: "restricted" }, true);
	expect(e2b.filter((p) => p.modelRelay).map((p) => p.id)).toEqual(["e2b", "e2b-open"]);
	expect(e2b.find((p) => p.id === "e2b-open")!.summary).toContain("The access token never enters the microVM.");
});
