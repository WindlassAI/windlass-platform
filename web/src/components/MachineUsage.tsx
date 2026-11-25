/**
 * Usage, the "My machines" tab: the sandboxes of the user's agents on their own machines, each machine
 * with its own. They are outside the platform's limits: their time is not metered (no cost, no hours,
 * no allowance here), and they are not counted among the user's running agents or hosted kept sandboxes.
 * Each machine shows the only limits it has, the ones its owner set on its runner. Shown only where the
 * deployment offers machines; with none paired, the way to add one.
 */
import { useApp } from "../state/app";
import { useNow } from "../state/hooks";
import { linkProps } from "../lib/router";
import { MachineState, SandboxLine, sandboxLimit, storeLimits, useMachines } from "../screens/Machines";
import { machineLabel } from "../lib/machines";

export function MachineUsage() {
	const { platform } = useApp();
	const offered = Boolean(platform.info?.machines);
	const { list, error } = useMachines(offered);
	const now = useNow(30_000);
	if (!offered || (list === null && error === null)) return null;
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
					{list.map((machine) => (
						<li key={machine.machineId} className="usage-machine">
							<div className="usage-machine-head">
								<h3 className="usage-machine-name">{machineLabel(machine)}</h3>
								<MachineState machine={machine} now={now} />
							</div>
							{/* The only limits a machine has: the ones its owner set on its runner. */}
							<p className="usage-machine-limits">
								Sandboxes: {sandboxLimit(machine)}
								{machine.storeLimits ? <>; snapshots and mirrors: {storeLimits(machine.storeLimits)}</> : null}
							</p>
							{machine.sandboxes.length === 0 ? (
								<p className="usage-machine-empty">No sandbox on it.</p>
							) : (
								<ul className="machine-sandboxes usage-machine-sandboxes">
									{machine.sandboxes.map((sandbox) => (
										<SandboxLine key={sandbox.sessionId} sandbox={sandbox} now={now} />
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
