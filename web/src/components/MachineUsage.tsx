import { useNow } from "../state/hooks";
import { linkProps } from "../lib/router";
import { MachineState, SandboxLine } from "./MachineState";
import { sandboxLimit, storeLimits } from "../lib/machines";
import { useMachines } from "../state/machines";
import { machineLabel } from "../lib/machines";

export function MachineUsage() {
	const { list, error } = useMachines();
	const now = useNow(30_000);
	if (list === null && error === null) return null;
	if (list !== null && list.length === 0)
		return (
			<p className="usage-empty">
				No machine paired.{" "}
				<a className="link" {...linkProps({ name: "machines" })}>
					Add one →
				</a>
			</p>
		);

	return (
		<>
			<p className="usage-lede">
				Not counted against your hosted time or kept sandboxes. A machine has only the limits set on it.{" "}
				<a className="link" {...linkProps({ name: "machines" })}>
					Machines →
				</a>
			</p>
			{list === null ? (
				<p className="usage-empty tone-warn" role="status">
					Your machines could not be read: {error}
				</p>
			) : (
				<ul className="usage-machines">
					{list.map(machine => (
						<li key={machine.machineId} className="usage-machine">
							<div className="usage-machine-head">
								<h3 className="usage-machine-name">{machineLabel(machine)}</h3>
								<MachineState machine={machine} now={now} />
							</div>
							<p className="usage-machine-limits">
								Sandboxes: {sandboxLimit(machine)}
								{machine.storeLimits ? <>; snapshots and mirrors: {storeLimits(machine.storeLimits)}</> : null}
							</p>
							{machine.sandboxes.length === 0 ? (
								<p className="usage-machine-empty">No sandbox on it.</p>
							) : (
								<ul className="machine-sandboxes usage-machine-sandboxes">
									{machine.sandboxes.map(sandbox => (
										<SandboxLine
											key={sandbox.sessionId}
											sandbox={sandbox}
											now={now}
											offlineSince={machine.status === "offline" ? machine.since : null}
										/>
									))}
								</ul>
							)}
						</li>
					))}
				</ul>
			)}
		</>
	);
}
