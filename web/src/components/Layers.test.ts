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
