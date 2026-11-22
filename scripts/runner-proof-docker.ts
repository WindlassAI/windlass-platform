import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Map logical runner names to throwaway Docker resources, including archive requests. */
export async function writeProofDocker(dir: string, prefix: string, realDocker: string, fixture?: { adapter: string; scenarios: string; lan: string }, extraPrefixes: string[] = []) {
	await writeFile(join(dir, "package.json"), '{"type":"commonjs"}\n');
	await writeFile(join(dir, "docker"), `#!/usr/bin/env node
const {spawnSync} = require("node:child_process");
const {readFileSync} = require("node:fs");
const pairs=[["wlp-session-", "${prefix}agent-"], ["wlp-harness-claude-", "${prefix}login-"], ...${JSON.stringify(extraPrefixes.map((name, i) => [name, prefix + i + "-"]))}];
function names(value, reverse=false) {
	for(const [a,b] of pairs) value=reverse ? value.replaceAll(b,a) : value.replaceAll(a,b);
	return value;
}
const args=process.argv.slice(2).map(x=>names(x));
const fixture=${JSON.stringify(fixture ?? null)};
if (fixture && args[0]==="run") {
	if (args.includes("dev.windlass-platform.harness=claude")) {
		args.splice(1,0,"--volume",fixture.adapter+":/usr/local/bin/wlp-claude-acp:ro","--volume",fixture.scenarios+":/proof:ro");
	}
	// Give the broker a private test LAN with a real git remote. Sessions still use --network none.
	if (args.includes("wlp-egress-broker")) {
		const network=args.indexOf("--network");
		if (network<0 || args[network+1]!=="host") throw Error("Unexpected broker network");
		args[network+1]=fixture.lan;
	}
}
const listing=args[0]==="ps" || (args[0]==="volume" && args[1]==="ls");
const api=args[0]==="system" && args[1]==="dial-stdio";
const child=spawnSync(${JSON.stringify(realDocker)},args,{
	stdio:[api?"pipe":"inherit",listing?"pipe":"inherit","inherit"],
	...(api && {input:names(readFileSync(0,"utf8"))})
});
if(listing) process.stdout.write(names(child.stdout.toString(),true));
process.exit(child.status ?? 1);
`, { mode: 0o755 });
}
