/**
 * What the dialog for a user's own MCP server reads of what is typed or pasted into it: a snippet
 * as a server's README gives one, and the form for a server that is reached at an address. What
 * either comes to is held against what the server keeps (server/src/personal-servers.ts).
 */
import { describe, expect, it } from "vitest";
import { ServerProblem, cleanServerDefinition } from "../../../server/src/personal-servers";
import { addressDefinition, addressForm, pastedServers, readDefinition } from "./PersonalServers";

const TRACKER = { command: "npx", args: ["-y", "@acme/tracker-mcp"], env: { TRACKER_TOKEN: "${TRACKER_TOKEN}" } };
const DOCS = { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } };
const text = (value: unknown) => JSON.stringify(value, null, 2);

describe("a snippet pasted as a server's README gives it", () => {
	it("is one server's definition as it always was: nothing is taken apart", () => {
		for (const definition of [TRACKER, DOCS, { command: "x" }, { url: "https://example.com/mcp", servers: {} }]) expect(pastedServers(text(definition))).toBeNull();
		expect(pastedServers("")).toBeNull();
		expect(pastedServers('{ "mcpServers": ')).toBeNull();
		expect(pastedServers("[]")).toBeNull();
		// A definition that is not whole yet is still a definition: the server says which key is wrong.
		expect(pastedServers(text({ env: { command: "x" } }))).toBeNull();
		expect(pastedServers(text({ args: ["--stdio"] }))).toBeNull();
	});

	it("gives the name and the definition from each of the wrapped forms", () => {
		const one = [{ name: "tracker", definition: TRACKER }];
		expect(pastedServers(text({ mcpServers: { tracker: TRACKER } }))).toEqual(one);
		expect(pastedServers(text({ servers: { tracker: TRACKER } }))).toEqual(one);
		expect(pastedServers(text({ mcp: { servers: { tracker: TRACKER } } }))).toEqual(one);
		expect(pastedServers(text({ tracker: TRACKER }))).toEqual(one);
		expect(pastedServers(text({ docs: DOCS }))).toEqual([{ name: "docs", definition: DOCS }]);
		// What stands beside the servers in such a file is not a server.
		expect(pastedServers(text({ inputs: [{ id: "token" }], servers: { tracker: TRACKER } }))).toEqual(one);
	});

	it("names every server of a snippet that has several, and none is taken for the user", () => {
		expect(pastedServers(text({ mcpServers: { tracker: TRACKER, docs: DOCS } }))?.map((server) => server.name)).toEqual(["tracker", "docs"]);
		expect(pastedServers(text({ tracker: TRACKER, docs: DOCS }))?.map((server) => server.name)).toEqual(["tracker", "docs"]);
		expect(pastedServers(text({ mcpServers: {} }))).toEqual([]);
	});

	it("leaves a key Windlass does not know to the server's own refusal", () => {
		const [found] = pastedServers(text({ mcpServers: { tracker: { ...TRACKER, type: "stdio" } } })) ?? [];
		expect(found?.definition).toEqual({ ...TRACKER, type: "stdio" });
		expect(() => cleanServerDefinition(found?.definition)).toThrowError(ServerProblem);
		expect(() => cleanServerDefinition(found?.definition)).toThrowError(/a key Windlass does not know, "type"/);
		// And what was taken out of a snippet is what the field reads as a definition.
		expect(readDefinition(text(found?.definition))?.definition).toEqual(found?.definition);
	});
});

describe("the form for a server that is reached at an address", () => {
	it("comes to the definition the same server has as JSON, which the server keeps as it is", () => {
		const withHeader = addressDefinition({ url: " https://docs.example.com/mcp ", header: "Authorization", value: "Bearer ${DOCS_TOKEN}" });
		expect(withHeader).toEqual(DOCS);
		expect(cleanServerDefinition(withHeader)).toEqual(DOCS);
		const plain = addressDefinition({ url: "https://docs.example.com/mcp", header: "", value: "" });
		expect(plain).toEqual({ url: "https://docs.example.com/mcp" });
		expect(cleanServerDefinition(plain)).toEqual(plain);
		expect(addressDefinition({ url: "  ", header: "Authorization", value: "x" })).toBeNull();
	});

	it("shows a definition that is an address and at most one header, and no other", () => {
		expect(addressForm(DOCS)).toEqual({ url: "https://docs.example.com/mcp", header: "Authorization", value: "Bearer ${DOCS_TOKEN}" });
		expect(addressForm({ url: "https://docs.example.com/mcp" })).toEqual({ url: "https://docs.example.com/mcp", header: "", value: "" });
		expect(addressForm({ url: "https://docs.example.com/mcp", headers: {} })).toEqual({ url: "https://docs.example.com/mcp", header: "", value: "" });
		for (const more of [TRACKER, { ...DOCS, timeoutSeconds: 30 }, { ...DOCS, untrusted: false }, { url: "https://docs.example.com/mcp", headers: { A: "1", B: "2" } }, { url: "https://docs.example.com/mcp", headers: { A: 1 } }]) expect(addressForm(more)).toBeNull();
		// There and back again changes nothing.
		expect(addressDefinition(addressForm(DOCS) ?? { url: "", header: "", value: "" })).toEqual(DOCS);
	});
});
