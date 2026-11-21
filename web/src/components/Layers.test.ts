import type { SandboxProfile } from "@contract";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProfileFacts } from "./Layers";

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
