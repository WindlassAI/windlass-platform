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
