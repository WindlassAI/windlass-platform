// The stand-in feeds the same newline-delimited stream as the node fixture.
// @ts-expect-error The dependency-free Node fixture is plain ESM.
import { FixturePeer } from "../fixtures/acp-agent/agent.mjs";
// @ts-expect-error The scenario table is shared directly with the stdio entry point.
import { scenarios } from "../fixtures/acp-agent/scenarios.mjs";

export class FakeAcpAgent {
	private readonly peer: { input(chunk: string): void; stop(): void };

	constructor(say: (line: string) => void, stateDir?: string) {
		this.peer = new FixturePeer(say, scenarios, stateDir);
	}

	input(chunk: string): void {
		this.peer.input(chunk);
	}
	stop(): void {
		this.peer.stop();
	}
}
