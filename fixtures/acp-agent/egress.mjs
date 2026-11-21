// The restricted-egress proof mounts this adapter only in its throwaway Claude session.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { FixturePeer } from "./agent.mjs";

const peer = new FixturePeer(line => process.stdout.write(line), {
	*plain() {
		const output = execFileSync("bash", ["/proof/egress.sh"], { encoding: "utf8" });
		const relay = execFileSync("curl", ["-sS", "--max-time", "5", process.env.ANTHROPIC_BASE_URL + "/"], { encoding: "utf8" });
		if (JSON.parse(relay).error.message !== "Claude credential relay refused the request.") throw Error("Unexpected relay response");
		writeFileSync("/tmp/proof-output", output);
		yield { sessionUpdate: "agent_message_chunk", content: { type: "text", text: output } };
	},
});
process.stdin.setEncoding("utf8").on("data", chunk => peer.input(chunk)).on("end", () => peer.stop());
