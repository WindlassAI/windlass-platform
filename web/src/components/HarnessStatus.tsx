import { HARNESS_NAMES, loginCommand, signInWords, type ReportedHarness } from "../lib/acp";
import { Command } from "./Command";
import { WarnIcon } from "./Icons";

/**
 * An agent's sign-in on its machine, with the command that signs it in. In a picker (no `machineName`): its
 * state in a few words (`signInWords`). On a session's page, in line with the composer: nothing while it is
 * signed in; a notice that it cannot run a turn only where the runner says it is signed out ("none"); and
 * where the runner could not check ("unknown"), a quiet line, the command folded under it, since the agent
 * may well run.
 */
export function HarnessStatus({ harness, machineName }: { harness: ReportedHarness; machineName?: string }) {
	const name = HARNESS_NAMES[harness.id];
	const command = <Command text={loginCommand(harness)} label={`The command that signs ${name} in`} />;
	if (!machineName)
		return (
			<div className="machine-harness">
				<span>
					{name}: {signInWords(harness)}
				</span>
				{command}
			</div>
		);
	if (harness.signIn === "token") return null;
	if (harness.signIn === "none")
		return (
			<div className="session-notice">
				<div className="callout callout-warn" role="status">
					<WarnIcon size={14} />
					<div>
						<p className="callout-text">
							{name} is not signed in on “{machineName}”, so this agent cannot run a turn. Sign it in there:
						</p>
						{command}
					</div>
				</div>
			</div>
		);
	return (
		<div className="session-notice">
			<details className="session-notice-quiet">
				<summary>
					Couldn't check {name}'s sign-in on “{machineName}”. If a turn fails to start, sign in again:
				</summary>
				{command}
			</details>
		</div>
	);
}
