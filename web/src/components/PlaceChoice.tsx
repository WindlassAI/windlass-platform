import type { HarnessId, MachineSummary, SandboxProfileId } from "@contract";
import { useId, useState, type ReactNode } from "react";
import { HARNESS_NAMES, type ReportedHarness } from "../lib/acp";
import { linkProps } from "../lib/router";
import { MachineState } from "./MachineState";
import { machineLabel } from "../lib/machines";
import {
	capabilitiesOf,
	checksSentence,
	itemModeOf,
	itemProfiles,
	machineHarness,
	worksWithoutAsking,
} from "../../../server/src/sandbox/harnesses.js";

export type PlacePurpose = "agent" | "item";

// Offline machines can accept work; it waits for the runner to return.
export function machineUnusable(
	machine: MachineSummary,
	_minRunnerVersion: string,
	purpose: PlacePurpose,
): string | null {
	if (machine.warnings.some(w => w.kind === "signing-disabled"))
		return "This runner requires signed connections to be enabled on the platform.";
	if (machine.warnings.some(warning => warning.kind === "outdated")) return "Its runner needs an update.";
	if (machine.profiles.length === 0) return machine.status === "waiting" ? "Not connected yet." : "Still connecting.";
	if (purpose === "item" && !machine.profiles.some(profile => profile.available))
		return "Can't run sandboxes right now.";
	return null;
}

function PlaceCard({
	machine,
	why,
	name,
	checked,
	now,
	onChoose,
}: {
	machine: MachineSummary | null;
	why: string | null;
	name: string;
	checked: boolean;
	now: number;
	onChoose(machineId: string | null): void;
}) {
	const id = useId();
	const reasonId = `${id}-reason`;
	return (
		<label
			className={`profile place${checked ? " profile-chosen" : ""}${why === null ? "" : " profile-unavailable"}`}
			htmlFor={id}
		>
			<input
				id={id}
				className="profile-radio"
				type="radio"
				name={name}
				value={machine?.machineId ?? "platform"}
				checked={checked}
				disabled={why !== null}
				onChange={() => onChoose(machine?.machineId ?? null)}
				aria-describedby={why === null ? undefined : reasonId}
			/>
			<span className="profile-head">
				<span className="profile-pick" aria-hidden="true" />
				<span className="profile-name">{machine ? machineLabel(machine) : "Hosted"}</span>
				{machine ? <MachineState machine={machine} now={now} /> : null}
			</span>
			<span className="profile-summary">
				{machine ? `Your ${machine.os} ${machine.arch} machine. Free.` : "Uses your daily hosted time."}
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

export function PlaceChoice({
	machines,
	chosen,
	minRunnerVersion,
	now,
	purpose,
	onChoose,
	children,
}: {
	machines: MachineSummary[];
	chosen: MachineSummary | null;
	minRunnerVersion: string;
	now: number;
	purpose: PlacePurpose;
	onChoose(machineId: string | null): void;
	children?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const cards = useId();
	return (
		<fieldset className="new-agent-section sandbox-pick">
			<legend className="label">Where it runs</legend>
			<div className="sandbox-chosen">
				<span className="sandbox-chosen-text">
					<span className="sandbox-chosen-name">{chosen ? chosen.name : "Hosted"}</span>
					<span className="sandbox-chosen-facts">
						{chosen ? (
							<>
								<MachineState machine={chosen} now={now} />
								<span>
									your {chosen.os} {chosen.arch} machine
								</span>
								{purpose === "agent" ? <span>free</span> : null}
							</>
						) : (
							<>
								<span>uses your daily hosted time</span>
							</>
						)}
					</span>
				</span>
				<button
					type="button"
					className="link"
					aria-expanded={open}
					aria-controls={cards}
					onClick={() => setOpen(value => !value)}
				>
					{open ? "Hide" : "Change"}
				</button>
			</div>
			{children}
			<div id={cards} className="sandbox-cards" hidden={!open}>
				<p className="section-text">Hosted, or on one of your machines.</p>
				<PlaceCards
					machines={machines}
					chosen={chosen}
					minRunnerVersion={minRunnerVersion}
					now={now}
					purpose={purpose}
					onChoose={onChoose}
				/>
			</div>
		</fieldset>
	);
}

export function PlaceCards({
	machines,
	chosen,
	minRunnerVersion,
	now,
	purpose,
	onChoose,
}: {
	machines: MachineSummary[];
	chosen: MachineSummary | null;
	minRunnerVersion: string;
	now: number;
	purpose: PlacePurpose;
	onChoose(machineId: string | null): void;
}) {
	const group = useId();
	const why = (machine: MachineSummary) => machineUnusable(machine, minRunnerVersion, purpose);
	const usable = machines.filter(machine => why(machine) === null);
	const unusable = machines.filter(machine => why(machine) !== null);
	return (
		<>
			<div className="profiles places">
				<PlaceCard machine={null} why={null} name={group} checked={chosen === null} now={now} onChoose={onChoose} />
				{usable.map(machine => (
					<PlaceCard
						key={machine.machineId}
						machine={machine}
						why={null}
						name={group}
						checked={chosen?.machineId === machine.machineId}
						now={now}
						onChoose={onChoose}
					/>
				))}
			</div>
			{unusable.length > 0 ? (
				<>
					<p className="profiles-divider">Listed, but not usable now</p>
					<div className="profiles profiles-unavailable">
						{unusable.map(machine => (
							<PlaceCard
								key={machine.machineId}
								machine={machine}
								why={why(machine)}
								name={group}
								checked={false}
								now={now}
								onChoose={onChoose}
							/>
						))}
					</div>
				</>
			) : null}
		</>
	);
}

export const HARNESS_PROFILE = "docker-hardened";

export const offeredHarnesses = (machine: MachineSummary | null): ReportedHarness[] => machine?.harnesses ?? [];
// Unattended items require a machine agent that is already signed in.
export const itemHarnesses = (machine: MachineSummary | null): ReportedHarness[] =>
	offeredHarnesses(machine).filter(harness => machineHarness(harness.id)?.items === true && harness.signIn === "token");

export function itemAgentLine(harness: Exclude<HarnessId, "windlass">, profile: SandboxProfileId): string {
	const name = HARNESS_NAMES[harness];
	const how = worksWithoutAsking(harness, profile)
		? `${name} works in Open isolation, without asking, and runs Quick.`
		: `${name} works in its own sandbox, without network, and runs Quick. A request to leave the sandbox ends the step.`;
	const sentence = checksSentence(harness, machineHarness(harness)?.sandboxedOn.includes(profile));
	return sentence ? `${how} ${sentence}` : how;
}

export function onPullRequest(harness: HarnessId): string {
	const checks = capabilitiesOf(harness).checks;
	if (checks === "platform")
		return " The platform runs this repository's saved checks when it ends a turn, and CI's result is on the pull request.";
	return checks === "none" ? " It does not run this repository's checks; CI's result is on the pull request." : "";
}

export function itemProfilesHere(machine: MachineSummary | null, harness: HarnessId): SandboxProfileId[] {
	const reported = offeredHarnesses(machine).find(offered => offered.id === harness);
	// A machine must report the probed item mode before we offer the harness's own sandbox.
	return itemProfiles(harness).filter(
		id =>
			machine?.profiles.some(profile => profile.id === id && profile.available) &&
			(!machineHarness(harness)?.sandboxedOn.includes(id) ||
				reported?.modes?.includes(itemModeOf(harness, id) ?? "") === true),
	);
}
