/**
 * Usage, "On your machines": the sandboxes of the user's agents on their own machines, each machine
 * with its own. They are outside the platform's limits: their time is not metered (no cost, no hours,
 * no allowance here), and they are not counted among the user's running agents or kept sandboxes. Shown only where the deployment offers machines and the user has one.
 */
import { useApp } from "../state/app";
import { useNow } from "../state/hooks";
import { linkProps } from "../lib/router";
import { plural } from "../lib/format";
import { MachineState, SandboxLine, useMachines } from "../screens/Machines";

export function MachineUsage() {
	const { platform } = useApp();
	const offered = Boolean(platform.info?.machines);
	const { list, error } = useMachines(offered);
	const now = useNow(30_000);
	if (!offered || (list !== null && list.length === 0) || (list === null && error === null)) return null;
	const sandboxes = list?.reduce((sum, machine) => sum + machine.sandboxes.length, 0) ?? 0;

	return (
		<section className="usage-section" aria-labelledby="usage-machines">
			<h2 className="usage-title" id="usage-machines">
				On your machines
				{list ? <span className="usage-count">{plural(sandboxes, "sandbox", "sandboxes")}</span> : null}
			</h2>
			<p className="usage-lede">
				Not counted against your daily sandbox time, running agents or kept sandboxes.{" "}
				<a className="link" {...linkProps({ name: "machines" })}>
					Machines
				</a>
			</p>
			{list === null ? (
				<p className="usage-empty tone-warn" role="status">
					Your machines could not be read: {error}
				</p>
			) : (
				<ul className="usage-kept">
					{list.map((machine) => (
						<li key={machine.machineId} className="usage-kept-row machine-row">
							<div className="usage-kept-main">
								<h3 className="usage-kept-title">{machine.name}</h3>
								{machine.sandboxes.length === 0 ? (
									<p className="agent-meta">no sandbox on it</p>
								) : (
									<ul className="machine-sandboxes">
										{machine.sandboxes.map((sandbox) => (
											<SandboxLine key={sandbox.sessionId} sandbox={sandbox} now={now} />
										))}
									</ul>
								)}
							</div>
							<MachineState machine={machine} now={now} />
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
