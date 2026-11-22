import { NETWORK_PRESETS, type NetworkProposal } from "@contract";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProposalItem, WideHostNote } from "./Network";

const preset = (id: string) => NETWORK_PRESETS.find((item) => item.id === id);
const render = (proposal: NetworkProposal) => renderToStaticMarkup(createElement(ProposalItem, { proposal, preset: preset(proposal.entry), busy: null, onAllow: () => {} }));

it("shows a preset proposal's own words beside its hosts, where it is allowed", () => {
	const html = render({ entry: "@prisma", hosts: ["binaries.prisma.sh"], sources: ["package.json dependencies.@prisma/client"] });
	expect(html).toContain("The engines Prisma downloads when it is installed");
	expect(html).toContain("binaries.prisma.sh");
});

it("warns on the Google Cloud Storage proposal that it reaches every public bucket", () => {
	const html = render({ entry: "@gcs", hosts: ["storage.googleapis.com"], sources: ["package.json devDependencies.@playwright/test (Playwright's Chromium redirects there)"] });
	expect(html).toContain("every public Google Cloud Storage bucket");
	expect(html).toContain("tone-warn");
	expect(render({ entry: "storage.googleapis.com", hosts: ["storage.googleapis.com"], sources: [".npmrc line 1"] })).toContain("tone-warn");
});

it("says nothing more for a host that serves only itself", () => {
	expect(renderToStaticMarkup(createElement(WideHostNote, { hosts: ["registry.example.com"] }))).toBe("");
	expect(render({ entry: "npm.pkg.github.com", hosts: ["npm.pkg.github.com"], sources: [".npmrc line 1"] })).not.toContain("tone-warn");
});
