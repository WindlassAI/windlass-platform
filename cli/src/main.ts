/**
 * `windlassai` (`npx @windlassai/cli`): connects what a user has on their own computer to Windlass.
 * Today `connect claude`; `connect codex` and `connect --machine` are planned beside it.
 */
import { parseArgs } from "node:util";
import { connectPlan, PLAN_SOURCES } from "./connect.ts";
import { CliError, platformOrigin } from "./platform.ts";
import { readStdin } from "./terminal.ts";
import { scrub } from "./token.ts";

const USAGE = `Usage: npx @windlassai/cli connect claude [--platform <url>] [--no-browser] [--token-stdin]

  connect claude    Connect your Claude Pro or Max plan: approve in the browser, then
                    claude setup-token runs here and its token goes to your account.

  --platform <url>  The Windlass platform (default: WINDLASS_PLATFORM, else the hosted one).
  --no-browser      Print the approval page instead of opening it.
  --token-stdin     Read a setup token from standard input instead of running claude setup-token.`;

async function main(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			platform: { type: "string" },
			"no-browser": { type: "boolean" },
			"token-stdin": { type: "boolean" },
			machine: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, target, ...rest] = positionals;
	if (values.help || command === undefined || command === "help") {
		console.log(USAGE);
		return command === undefined && !values.help ? 2 : 0;
	}
	if (command !== "connect" || rest.length) {
		console.error(USAGE);
		return 2;
	}
	if (values.machine) {
		console.error("Connecting a machine from here is not available yet. Use windlass-runner pair for now.");
		return 2;
	}
	const source = target === undefined ? undefined : PLAN_SOURCES[target];
	if (!source) {
		console.error(
			target === "codex"
				? "Connecting a ChatGPT plan from here is not available yet. Use Settings → Models on the platform."
				: USAGE,
		);
		return 2;
	}
	const platform = platformOrigin(values.platform ?? process.env.WINDLASS_PLATFORM);
	const token = values["token-stdin"] ? await readStdin() : undefined;
	await connectPlan(source, { platform, token, browser: !values["no-browser"] });
	return 0;
}

main(process.argv.slice(2)).then(
	code => {
		process.exitCode = code;
	},
	error => {
		const known = error instanceof CliError || (error as { code?: unknown })?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION";
		console.error(scrub(known ? (error as Error).message : `Something went wrong: ${String(error)}`));
		process.exitCode = 1;
	},
);
