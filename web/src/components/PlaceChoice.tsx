/**
 * "Where it runs": this platform, or one of the user's machines. One line names the choice and its
 * plain facts; a card for each place opens from that line, as the sandboxes' do. The launch form of an
 * agent (screens/NewAgent.tsx) and the form that files a work item (screens/Items.tsx) both use it,
 * each with what the choice means for what it makes (`purpose`), and each puts its own note under the
 * line (`children`).
 *
 * A machine whose runner never reported, or is too old for the platform, is listed and cannot be
 * chosen. An offline machine can: an agent made there waits for it, and so does an item. An item also
 * needs a sandbox its runner reported as usable, since the server gives it the machine's first one.
 */
import type { MachineSummary } from "@contract";
import { useId, useState, type ReactNode } from "react";
import { linkProps } from "../lib/router";
import { MachineState } from "../screens/Machines";

export type PlacePurpose = "agent" | "item";

/** Why a machine cannot be chosen; null when it can. An offline machine can: what is made there waits for it. */
export function machineUnusable(machine: MachineSummary, minRunnerVersion: string, purpose: PlacePurpose): string | null {
	if (machine.warnings.some((warning) => warning.kind === "outdated")) return `Its runner is ${machine.runnerVersion}; the platform needs ${minRunnerVersion} or later. Update it on the machine.`;
	if (machine.profiles.length === 0) return machine.status === "waiting" ? "Its runner has not connected since the machine was added." : "Its runner has not said yet which sandboxes it can make.";
	if (purpose === "item" && !machine.profiles.some((profile) => profile.available)) return "None of the sandboxes its runner reported can be used now.";
	return null;
}

/** One place it can run: this platform (`machine` null) or one of the user's machines, as a card like a sandbox's. */
function PlaceCard({ machine, why, name, checked, now, purpose, onChoose }: { machine: MachineSummary | null; why: string | null; name: string; checked: boolean; now: number; purpose: PlacePurpose; onChoose(machineId: string | null): void }) {
	const id = useId();
	const reasonId = `${id}-reason`;
	return (
		<label className={`profile place${checked ? " profile-chosen" : ""}${why === null ? "" : " profile-unavailable"}`} htmlFor={id}>
			<input id={id} className="profile-radio" type="radio" name={name} value={machine?.machineId ?? "platform"} checked={checked} disabled={why !== null} onChange={() => onChoose(machine?.machineId ?? null)} aria-describedby={why === null ? undefined : reasonId} />
			<span className="profile-head">
				<span className="profile-pick" aria-hidden="true" />
				<span className="profile-name">{machine ? machine.name : "This platform"}</span>
				{machine ? <MachineState machine={machine} now={now} /> : null}
			</span>
			<span className="profile-summary">
				{machine
					? `Your ${machine.os} ${machine.arch} machine. ${purpose === "agent" ? "The platform's limits do not apply." : "It costs no hosted time."}`
					: "A sandbox the platform makes and controls. It counts against your daily sandbox time."}
			</span>
			{why === null ? null : (
				<span className="profile-reason" id={reasonId}>
					<strong>Why not yet.</strong> {why}{" "}
					<a className="link" {...linkProps({ name: "machines" })}>
						Machines
					</a>
				</span>
			)}
		</label>
	);
}

/**
 * The choice, for a user who has machines (`machines` not empty). `chosen`: the machine chosen, when it
 * can be; null is this platform. `children` stand under the line, for what the choice means here.
 */
export function PlaceChoice({ machines, chosen, minRunnerVersion, now, purpose, onChoose, children }: { machines: MachineSummary[]; chosen: MachineSummary | null; minRunnerVersion: string; now: number; purpose: PlacePurpose; onChoose(machineId: string | null): void; children?: ReactNode }) {
	const [open, setOpen] = useState(false);
	const group = useId();
	const cards = useId();
	const why = (machine: MachineSummary) => machineUnusable(machine, minRunnerVersion, purpose);
	const usable = machines.filter((machine) => why(machine) === null);
	const unusable = machines.filter((machine) => why(machine) !== null);
	return (
		<fieldset className="new-agent-section sandbox-pick">
			<legend className="label">Where it runs</legend>
			<div className="sandbox-chosen">
				<span className="sandbox-chosen-text">
					<span className="sandbox-chosen-name">{chosen ? chosen.name : "This platform"}</span>
					<span className="sandbox-chosen-facts">
						{chosen ? (
							<>
								<MachineState machine={chosen} now={now} />
								<span>
									your {chosen.os} {chosen.arch} machine
								</span>
								{purpose === "agent" ? <span>the platform's limits do not apply</span> : null}
							</>
						) : (
							<>
								<span>a sandbox the platform makes and controls</span>
								<span>counts against your daily sandbox time</span>
							</>
						)}
					</span>
				</span>
				<button type="button" className="link" aria-expanded={open} aria-controls={cards} onClick={() => setOpen((value) => !value)}>
					{open ? "Hide" : "Change"}
				</button>
			</div>
			{children}
			<div id={cards} className="sandbox-cards" hidden={!open}>
				<p className="section-text">Where the {purpose === "agent" ? "agent's" : "item's"} sandbox is made: by this platform, or by the runner on one of your machines.</p>
				<div className="profiles places">
					<PlaceCard machine={null} why={null} name={group} checked={chosen === null} now={now} purpose={purpose} onChoose={onChoose} />
					{usable.map((machine) => (
						<PlaceCard key={machine.machineId} machine={machine} why={null} name={group} checked={chosen?.machineId === machine.machineId} now={now} purpose={purpose} onChoose={onChoose} />
					))}
				</div>
				{unusable.length > 0 ? (
					<>
						<p className="profiles-divider">Listed, but not usable now</p>
						<div className="profiles profiles-unavailable">
							{unusable.map((machine) => (
								<PlaceCard key={machine.machineId} machine={machine} why={why(machine)} name={group} checked={false} now={now} purpose={purpose} onChoose={onChoose} />
							))}
						</div>
					</>
				) : null}
			</div>
		</fieldset>
	);
}
