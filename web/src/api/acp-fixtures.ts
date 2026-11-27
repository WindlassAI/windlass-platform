/**
 * The recorded ACP turns in src/api/fixtures/: what the fake ACP agent (fixtures/acp-agent/scenarios.mjs)
 * sends for each of its scenarios, in wire order. Used by the mock client, which plays them as a Claude
 * Code agent's turns, and by the reducer's tests.
 */
import type { AcpFixture } from "./feed";

const files = import.meta.glob<AcpFixture>("./fixtures/acp-claude-*.json", { import: "default", eager: true });

/** Every recorded turn by its file name without the extension, e.g. "acp-claude-tools". */
export const ACP_FIXTURES: Record<string, AcpFixture> = Object.fromEntries(
	Object.entries(files).map(([path, fixture]) => [
		path
			.split("/")
			.at(-1)
			?.replace(/\.json$/, "") ?? path,
		fixture,
	]),
);

export function acpFixture(name: string): AcpFixture {
	const found = ACP_FIXTURES[name];
	if (!found) throw new Error(`no such ACP fixture: ${name}`);
	return found;
}
