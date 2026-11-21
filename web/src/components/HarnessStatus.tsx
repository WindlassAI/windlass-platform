import { HARNESS_NAMES, loginCommand, signInWords, type ReportedHarness } from "../lib/acp";
import { Command } from "./Command";

export function HarnessStatus({ harness, machineName }: { harness: ReportedHarness; machineName?: string }) {
	const name = HARNESS_NAMES[harness.id];
	if (machineName && harness.signIn === "token") return null;
	const status = machineName
		? `${name}: ${harness.signIn === "none" ? "not signed in" : "sign-in unknown"} on “${machineName}”, so this agent cannot run a turn.`
		: `${name}: ${signInWords(harness)}`;
	return <div className="machine-harness">
		<span>{status}</span>
		<Command text={loginCommand(harness)} label={`The command that signs ${name} in`} />
	</div>;
}
