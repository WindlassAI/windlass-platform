/** A machine's state and one of its sandboxes, as the machines page, usage and the place cards show them. */
import type { MachineSandbox, MachineSummary } from "@contract";
import { absoluteTime, clockTime, relativeTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { SandboxState } from "./Status";

/** Where a machine is, as a dot and a few words. A runner that is too old is refused, so that is what it says. */
export function MachineState({ machine, now }: { machine: MachineSummary; now: number }) {
	const outdated = machine.warnings.some(warning => warning.kind === "outdated");
	const kind = outdated ? "outdated" : machine.status;
	const word = outdated
		? "Needs an update"
		: machine.status === "online"
			? "Online"
			: machine.status === "offline"
				? `Offline since ${clockTime(machine.since, now)}`
				: "Waiting for the runner";
	return (
		<span
			className={`sandbox-state machine-state machine-state-${kind}`}
			title={machine.status === "offline" ? absoluteTime(machine.since) : undefined}
		>
			<span className="sandbox-state-dot" aria-hidden="true" />
			{word}
		</span>
	);
}

export function SandboxLine({
	sandbox,
	now,
	offlineSince = null,
}: {
	sandbox: MachineSandbox;
	now: number;
	offlineSince?: number | null;
}) {
	return (
		<li>
			{sandbox.title === null ? (
				<span className="tone-dim">an agent that was deleted</span>
			) : (
				<a className="usage-agent" {...linkProps({ name: "session", id: sandbox.sessionId })}>
					{sandbox.title}
				</a>
			)}
			<SandboxState
				state={sandbox.state}
				asOf={
					offlineSince === null ? undefined : `Reported before the machine went offline, ${absoluteTime(offlineSince)}.`
				}
			/>
			{sandbox.resizePending && <span>resized at next restart</span>}
			<span className="machine-used" title={absoluteTime(sandbox.usedAt)}>
				used {relativeTime(sandbox.usedAt, now)}
			</span>
		</li>
	);
}
