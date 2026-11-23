/**
 * "Where it runs": this platform, or one of the user's machines. One line names the choice and its
 * plain facts; a card for each place opens from that line, as the sandboxes' do. The form that files a
 * work item (screens/Items.tsx) uses it, with what the choice means for what it makes (`purpose`), and
 * its own note under the line (`children`). The start composer of an agent (components/StartComposer.tsx)
 * holds the same cards (`PlaceCards`) in its place picker.
 *
 * A machine whose runner never reported, or is too old for the platform, is listed and cannot be
 * chosen. An offline machine can: an agent made there waits for it, and so does an item. An item also
 * needs a sandbox its runner reported as usable, since the server gives it the machine's first one.
 */
import type { HarnessId, MachineSummary, SandboxProfileId } from "@contract";
import { useId, useState, type ReactNode } from "react";
import { HARNESS_NAMES, type ReportedHarness } from "../lib/acp";
import { linkProps } from "../lib/router";
import { MachineState } from "../screens/Machines";
import { HarnessStatus } from "./HarnessStatus";
import { machineLabel } from "../lib/machines";
import { capabilitiesOf, checksSentence, itemModeOf, itemProfiles, machineAgentLine, machineHarness, worksWithoutAsking } from "../../../server/src/sandbox/harnesses.js";
import { AgentGlyph } from "./ui/Pill";

export type PlacePurpose = "agent" | "item";

/** Why a machine cannot be chosen; null when it can. An offline machine can: what is made there waits for it. */
export function machineUnusable(machine: MachineSummary, minRunnerVersion: string, purpose: PlacePurpose): string | null {
	if (machine.warnings.some(w => w.kind === "signing-disabled")) return "This runner requires signed connections to be enabled on the platform.";
	if (machine.warnings.some((warning) => warning.kind === "outdated")) return `Its runner is ${machine.runnerVersion}; the platform needs ${minRunnerVersion} or later. Update it on the machine.`;
	if (machine.profiles.length === 0) return machine.status === "waiting" ? "Its runner has not connected since the machine was added." : "Its runner has not said yet which sandboxes it can make.";
	if (purpose === "item" && !machine.profiles.some((profile) => profile.available)) return "None of the sandboxes its runner reported can be used now.";
	return null;
}

/** One place it can run: this platform (`machine` null) or one of the user's machines, as a card like a sandbox's. */
function PlaceCard({ machine, why, name, checked, now, onChoose }: { machine: MachineSummary | null; why: string | null; name: string; checked: boolean; now: number; onChoose(machineId: string | null): void }) {
	const id = useId();
	const reasonId = `${id}-reason`;
	return (
		<label className={`profile place${checked ? " profile-chosen" : ""}${why === null ? "" : " profile-unavailable"}`} htmlFor={id}>
			<input id={id} className="profile-radio" type="radio" name={name} value={machine?.machineId ?? "platform"} checked={checked} disabled={why !== null} onChange={() => onChoose(machine?.machineId ?? null)} aria-describedby={why === null ? undefined : reasonId} />
			<span className="profile-head">
				<span className="profile-pick" aria-hidden="true" />
				<span className="profile-name">{machine ? machineLabel(machine) : "This platform"}</span>
				{machine ? <MachineState machine={machine} now={now} /> : null}
			</span>
			<span className="profile-summary">
				{machine
					? `Your ${machine.os} ${machine.arch} machine. It costs no hosted time.`
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
	const cards = useId();
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
								{purpose === "agent" ? <span>costs no hosted time</span> : null}
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
				<PlaceCards machines={machines} chosen={chosen} minRunnerVersion={minRunnerVersion} now={now} purpose={purpose} onChoose={onChoose} />
			</div>
		</fieldset>
	);
}

/** A card for each place: this platform and the machines that can be chosen, then those that cannot, each with why. The start composer's place picker holds them too. */
export function PlaceCards({ machines, chosen, minRunnerVersion, now, purpose, onChoose }: { machines: MachineSummary[]; chosen: MachineSummary | null; minRunnerVersion: string; now: number; purpose: PlacePurpose; onChoose(machineId: string | null): void }) {
	const group = useId();
	const why = (machine: MachineSummary) => machineUnusable(machine, minRunnerVersion, purpose);
	const usable = machines.filter((machine) => why(machine) === null);
	const unusable = machines.filter((machine) => why(machine) !== null);
	return (
		<>
			<div className="profiles places">
				<PlaceCard machine={null} why={null} name={group} checked={chosen === null} now={now} onChoose={onChoose} />
				{usable.map((machine) => (
					<PlaceCard key={machine.machineId} machine={machine} why={null} name={group} checked={chosen?.machineId === machine.machineId} now={now} onChoose={onChoose} />
				))}
			</div>
			{unusable.length > 0 ? (
				<>
					<p className="profiles-divider">Listed, but not usable now</p>
					<div className="profiles profiles-unavailable">
						{unusable.map((machine) => (
							<PlaceCard key={machine.machineId} machine={machine} why={why(machine)} name={group} checked={false} now={now} onChoose={onChoose} />
						))}
					</div>
				</>
			) : null}
		</>
	);
}

/** The sandbox profile another harness runs in (server/src/actors/user.ts, `makeSession`). */
export const HARNESS_PROFILE = "docker-hardened";

/** The harnesses a machine offers besides Windlass, as its runner last reported them. */
export const offeredHarnesses = (machine: MachineSummary | null): ReportedHarness[] => machine?.harnesses ?? [];
/**
 * The harnesses a work item can run on this machine: those work items may run (server/src/sandbox/harnesses.ts,
 * `items`) that it reports signed in. An item is not watched, so one that needs a sign-in is not offered.
 */
export const itemHarnesses = (machine: MachineSummary | null): ReportedHarness[] => offeredHarnesses(machine).filter((harness) => machineHarness(harness.id)?.items === true && harness.signIn === "token");

/** What a machine agent's work item does in this profile, in one line (harnesses.ts, `worksWithoutAsking`). */
export function itemAgentLine(harness: Exclude<HarnessId, "windlass">, profile: SandboxProfileId): string {
	const name = HARNESS_NAMES[harness];
	const how = worksWithoutAsking(harness, profile)
		? `${name} works in the hardened container, without asking, and runs Quick.`
		: `${name} works in its own sandbox, without network, and runs Quick. A request to leave the sandbox ends the step.`;
	const sentence = checksSentence(harness, machineHarness(harness)?.sandboxedOn.includes(profile));
	return sentence ? `${how} ${sentence}` : how;
}

/**
 * What happens to the repository's checks with an agent of a person's session, and where CI's result is, after
 * its line (`HarnessCapabilities.checks`): " The platform runs …, and CI's result is on the pull request."
 */
export function onPullRequest(harness: HarnessId): string {
	const checks = capabilitiesOf(harness).checks;
	if (checks === "platform") return " The platform runs this repository's saved checks when it ends a turn, and CI's result is on the pull request.";
	return checks === "none" ? " It does not run this repository's checks; CI's result is on the pull request." : "";
}

/**
 * The profiles a work item of this harness can run in on this machine, its default first (harnesses.ts,
 * `itemModes`): available there, and for Codex's Windlass sandbox profile only once its probe passed.
 */
export function itemProfilesHere(machine: MachineSummary | null, harness: HarnessId): SandboxProfileId[] {
	const reported = offeredHarnesses(machine).find((offered) => offered.id === harness);
	// Where the agent's commands run in its own sandbox (`sandboxedOn`), only once the machine reported the item's mode there, which its probe decides.
	return itemProfiles(harness).filter((id) => machine?.profiles.some((profile) => profile.id === id && profile.available)
		&& (!machineHarness(harness)?.sandboxedOn.includes(id) || reported?.modes?.includes(itemModeOf(harness, id) ?? "") === true));
}

/**
 * "Agent: Windlass · Claude Code", for an agent on a machine that offers another harness: a segmented
 * choice of the two, the harness's sign-in on the machine where it is not known to be signed in, and,
 * once it is chosen, the one line that says what it does differently. Its mode is chosen beside it
 * (components/Modes.tsx, `ModePicker`). `hardened`: whether the machine
 * can make the container it runs in; without one it cannot be chosen.
 */
export function HarnessChoice({ machine, chosen, hardened, disabled = false, onChoose }: { machine: MachineSummary; chosen: HarnessId; hardened: boolean; disabled?: boolean; onChoose(harness: HarnessId): void }) {
	const label = useId();
	const group = useId();
	const offered = offeredHarnesses(machine);
	const options: Array<{ id: HarnessId; usable: boolean }> = [{ id: "windlass", usable: true }, ...offered.map((harness) => ({ id: harness.id, usable: hardened }))];
	return (
		<div className="harness-pick">
			<span className="label" id={label}>
				Agent
			</span>
			<div className="segmented" role="radiogroup" aria-labelledby={label}>
				{options.map((option) => (
					<label key={option.id} className={`segment${chosen === option.id ? " segment-chosen" : ""}${option.usable ? "" : " segment-unavailable"}`}>
						<input className="segment-radio" type="radio" name={group} value={option.id} checked={chosen === option.id} disabled={disabled || !option.usable} onChange={() => onChoose(option.id)} />
						<AgentGlyph harness={option.id} size={11} inline />
						{HARNESS_NAMES[option.id]}
					</label>
				))}
			</div>
			{offered.map((harness) => (
				<HarnessState key={harness.id} harness={harness} machine={machine} hardened={hardened} />
			))}
			{machineHarness(chosen) ? <p className="field-note">{machineAgentLine(machineHarness(chosen)!)}{onPullRequest(chosen)}</p> : null}
		</div>
	);
}

/** What stands in the way of a harness on the machine, if anything: its container, or its sign-in. */
function HarnessState({ harness, machine, hardened }: { harness: ReportedHarness; machine: MachineSummary; hardened: boolean }) {
	const name = HARNESS_NAMES[harness.id];
	if (!hardened) return <p className="field-note tone-warn">{name} runs only in the hardened container, which “{machineLabel(machine)}” cannot make now.</p>;
	return <HarnessStatus harness={harness} />;
}
