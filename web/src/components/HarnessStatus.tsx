import { HARNESS_NAMES, loginCommand, signInWords, type ReportedHarness } from "../lib/acp";
import { Command } from "./Command";

export function HarnessStatus({ harness }: { harness: ReportedHarness }) {
	const name = HARNESS_NAMES[harness.id];
	return <div className="machine-harness">
		<span>{name}: {signInWords(harness)}</span>
		<Command text={loginCommand(harness)} label={`The command that signs ${name} in`} />
	</div>;
}
