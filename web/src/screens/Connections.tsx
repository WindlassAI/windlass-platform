/**
 * Connections: each agent and every place it runs (Hosted, each paired machine), what pays for it there, and the one
 * action that connects it (lib/connections.ts). Under the grid, who pays for each plan agent (Pay with, saved in the
 * user's actor: server/src/pay-with.ts), the plans' connect commands and the API keys, which moved here from
 * Settings → Models. A link names one cell as the fragment (`/connections#claude-hosted`): the page scrolls to it
 * and marks it.
 */
import {
	type HarnessId,
	type MachineSummary,
	type ModelProvider,
	PLAN_NAMES,
	type PayWith,
	type PayWithChoice,
	type PlanProvider,
	type WhenLimited,
} from "@contract";
import { type ReactNode, useCallback, useState } from "react";
import { payWithFor } from "../../../server/src/pay-with.js";
import { keyProviders, machineHarness } from "../../../server/src/sandbox/harnesses.js";
import { ChatgptPlan } from "../components/ChatgptPlan";
import { ClaudePlan } from "../components/ClaudePlan";
import { CredentialChoice } from "../components/CredentialChoice";
import { Dialog } from "../components/Dialog";
import { WarnIcon } from "../components/Icons";
import { KeyDialog, ModelProviders } from "../components/ModelProviders";
import { PlanWait } from "../components/PlanConnect";
import { SettingsGroup, SettingsLayout } from "../components/SettingsGroups";
import { AgentGlyph } from "../components/ui/Pill";
import { HARNESS_DISPLAY_ORDER, HARNESS_NAMES } from "../lib/acp";
import {
	type CellAction,
	type ConnectionCell,
	type ConnectionInputs,
	choosableKeys,
	hostedCell,
	machineCell,
} from "../lib/connections";
import { machineLabel, settingsKeyUpgrade } from "../lib/machines";
import { SOURCE_NAMES } from "../lib/models";
import { linkProps, useHash } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useConnectionInputs, usePayWith } from "../state/connections";
import { PROVIDERS_CHANGED } from "../state/hooks";
import { useMachines } from "../state/machines";

const PAY_WITH_WORDS: Record<PayWith, string> = {
	"plan-then-key": "Plan first, then key",
	plan: "Plan only",
	key: "Key only",
};
const WHEN_LIMITED_WORDS: Record<WhenLimited, string> = {
	wait: "Wait for the reset",
	key: "Use my key",
	ask: "Ask me",
};
/** The select's value for "no choice saved": the defaults by origin. */
const DEFAULT_LIMITED = "default";

/** What a cell's action button says. */
function actionWords(action: CellAction, state: ConnectionCell["state"]): string {
	if (action.kind === "plan") return action.reconnect ? "Reconnect" : `Connect ${PLAN_NAMES[action.provider]}`;
	if (action.kind === "key") return `${state === "bad" ? "Replace" : "Add"} ${SOURCE_NAMES[action.provider]} key`;
	return state === "absent" ? "Add on Machines" : "Open Machines";
}

const TONES: Record<ConnectionCell["state"], string> = {
	plan: "good",
	key: "good",
	machine: "good",
	bad: "bad",
	none: "warn",
	unknown: "warn",
	absent: "quiet",
};

/** What the page opens over itself from a cell: a plan's connect command, or a key's entry. */
type Opened = { kind: "plan"; provider: PlanProvider } | { kind: "key"; provider: ModelProvider; replacing: boolean };

function Cell({
	cell,
	target,
	onAct,
	choice,
}: {
	cell: ConnectionCell;
	target: boolean;
	onAct(action: CellAction, state: ConnectionCell["state"]): void;
	choice?: ReactNode;
}) {
	const { action } = cell;
	return (
		<div
			id={cell.id}
			className={`conn-cell${target ? " conn-cell-target" : ""}`}
			data-state={cell.state}
			aria-current={target || undefined}
		>
			<span className={`conn-state conn-state-${TONES[cell.state]}`}>{cell.label}</span>
			{cell.badge ? (
				<span className={`conn-state conn-badge conn-state-${cell.badge.tone}`}>{cell.badge.text}</span>
			) : null}
			{cell.detail ? <span className="conn-detail">{cell.detail}</span> : null}
			{action?.kind === "machines" ? (
				<a className="button button-outline button-small conn-action" {...linkProps({ name: "machines" })}>
					{actionWords(action, cell.state)}
				</a>
			) : action ? (
				<button
					type="button"
					className="button button-outline button-small conn-action"
					onClick={() => onAct(action, cell.state)}
				>
					{actionWords(action, cell.state)}
				</button>
			) : null}
			{choice}
		</div>
	);
}

function Grid({
	inputs,
	machines,
	onMachines,
	onAct,
}: {
	inputs: ConnectionInputs;
	machines: readonly MachineSummary[];
	onMachines(list: MachineSummary[]): void;
	onAct(action: CellAction, state: ConnectionCell["state"]): void;
}) {
	const hash = decodeURIComponent(useHash().slice(1));
	return (
		<div className="conn-scroll">
			<table className="conn-grid">
				<thead>
					<tr>
						<th scope="col">Agent</th>
						<th scope="col">Hosted</th>
						{machines.map(machine => (
							<th scope="col" key={machine.machineId}>
								{machineLabel(machine)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{HARNESS_DISPLAY_ORDER.map(harness => {
						const hosted = hostedCell(harness, inputs);
						return (
							<tr key={harness} data-agent={harness}>
								<th scope="row">
									<span className="conn-agent">
										<AgentGlyph harness={harness} size={13} />
										{HARNESS_NAMES[harness]}
									</span>
								</th>
								<td data-place="Hosted">
									<Cell cell={hosted} target={hash === hosted.id} onAct={onAct} />
								</td>
								{machines.map(machine => {
									const cell = machineCell(harness, machine, hosted);
									const entry = machine.harnesses?.find(one => one.id === harness);
									const providers = entry ? choosableKeys(entry, inputs.keys) : [];
									return (
										<td key={machine.machineId} data-place={machineLabel(machine)}>
											<Cell
												cell={cell}
												target={hash === cell.id}
												onAct={onAct}
												choice={
													entry && providers.length > 0 ? (
														<CredentialChoice
															machine={machine}
															harness={entry}
															providers={providers}
															onChanged={onMachines}
														/>
													) : undefined
												}
											/>
										</td>
									);
								})}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/** What the choice means for each kind of turn, in a sentence (`payWithFor`, the rule the resolver will apply). */
function payWithMeaning(choices: readonly PayWithChoice[], harness: HarnessId, keyName: string, hasKey: boolean) {
	const item = payWithFor(choices, harness, "item", hasKey);
	const session = payWithFor(choices, harness, "interactive", hasKey);
	if (item.payWith === "key") return `Only your ${keyName} key pays; a connected plan is not used.`;
	if (!hasKey) return `No ${keyName} key is saved, so a limited plan always waits for its reset.`;
	if (item.payWith === "plan") return "Only the plan pays; when it is limited, turns wait for the reset.";
	const words: Record<WhenLimited, string> = {
		wait: "wait for the reset",
		key: `switch to your ${keyName} key`,
		ask: "ask you first",
	};
	if (item.whenLimited === session.whenLimited)
		return `When the plan is limited, work items and your sessions ${words[item.whenLimited]}.`;
	return `When the plan is limited, work items ${words[item.whenLimited]} and your sessions ${words[session.whenLimited]}.`;
}

function PayWithCard({
	choice,
	choices,
	inputs,
	saving,
	onSave,
}: {
	choice: PayWithChoice;
	choices: readonly PayWithChoice[];
	inputs: ConnectionInputs;
	saving: boolean;
	onSave(patch: Pick<PayWithChoice, "harness" | "payWith" | "whenLimited">): void;
}) {
	const { harness } = choice;
	const keyProvider = keyProviders(harness)[0] ?? "openai";
	const keyName = SOURCE_NAMES[keyProvider];
	const key = inputs.keys.find(one => one.ok && keyProviders(harness).includes(one.provider));
	const planProviders: readonly string[] = machineHarness(harness)?.planProviders ?? [];
	const plan = inputs.plans.plans.find(one => one.ok && planProviders.includes(one.provider));
	const limitedApplies = choice.payWith === "plan-then-key" && key !== undefined;
	const ids = { pay: `pay-${harness}-with`, limited: `pay-${harness}-limited` };
	return (
		<div className="conn-pay" id={`pay-${harness}`}>
			<h3 className="conn-agent">
				<AgentGlyph harness={harness} size={13} />
				{HARNESS_NAMES[harness]}
			</h3>
			<div className="conn-pay-fields">
				<label className="label" htmlFor={ids.pay}>
					Pay with
				</label>
				<select
					id={ids.pay}
					className="select"
					value={choice.payWith}
					disabled={saving}
					onChange={event => onSave({ ...choice, payWith: event.target.value as PayWith })}
				>
					{(Object.keys(PAY_WITH_WORDS) as PayWith[]).map(id => (
						<option key={id} value={id}>
							{PAY_WITH_WORDS[id]}
						</option>
					))}
				</select>
				<label className="label" htmlFor={ids.limited}>
					When limited
				</label>
				<select
					id={ids.limited}
					className="select"
					value={choice.whenLimited ?? DEFAULT_LIMITED}
					disabled={saving || !limitedApplies}
					onChange={event =>
						onSave({
							...choice,
							whenLimited: event.target.value === DEFAULT_LIMITED ? null : (event.target.value as WhenLimited),
						})
					}
				>
					<option value={DEFAULT_LIMITED}>Default: items wait, sessions ask</option>
					{(Object.keys(WHEN_LIMITED_WORDS) as WhenLimited[]).map(id => (
						<option key={id} value={id}>
							{WHEN_LIMITED_WORDS[id]}
						</option>
					))}
				</select>
			</div>
			<p className="field-note" role="status">
				{payWithMeaning(choices, harness, keyName, key !== undefined)}
			</p>
			<p className="field-note conn-pay-what">
				Plan: {plan ? (plan.account ?? PLAN_NAMES[plan.provider]) : "not connected"} · Key:{" "}
				{key ? `${keyName} …${key.last4}` : "none saved"}
			</p>
		</div>
	);
}

export function Connections() {
	const { platform } = useApp();
	const auth = useAuth();
	const { inputs, error } = useConnectionInputs();
	const machinesOffered = Boolean(platform.info?.machines);
	const machines = useMachines(machinesOffered);
	const list = machinesOffered ? (machines.list ?? []) : [];
	const payWith = usePayWith();
	const [opened, setOpened] = useState<Opened | null>(null);
	const close = useCallback(() => setOpened(null), []);
	const act = (action: CellAction, state: ConnectionCell["state"]) => {
		if (action.kind === "plan") setOpened({ kind: "plan", provider: action.provider });
		else if (action.kind === "key") setOpened({ kind: "key", provider: action.provider, replacing: state === "bad" });
	};
	const upgrades = list.flatMap(machine => {
		const note = settingsKeyUpgrade(machine);
		return note ? [{ machine, note }] : [];
	});

	return (
		<main className="home usage repo settings connections">
			<header className="home-head">
				<div className="repo-head">
					<h1 className="display display-small">Connections</h1>
					<p className="home-account">
						Each agent, everywhere it can run. Connect once here and every item and session uses it. Your plans pay only
						for your own work, never a teammate's.
					</p>
				</div>
			</header>

			<SettingsLayout label="Connections sections">
				<SettingsGroup
					id="connections-agents"
					title="Agents"
					lede="What pays for each agent at each place right now. Hosted uses a connected plan first, then a key; a machine uses its own sign-in unless you chose your key there."
				>
					{inputs === null ? (
						error ? (
							<div className="state state-error" role="alert">
								<WarnIcon size={22} />
								<h3>Your connections could not be read</h3>
								<p>{error}</p>
							</div>
						) : (
							<p className="usage-empty" aria-busy="true">
								Reading your connections…
							</p>
						)
					) : (
						<Grid inputs={inputs} machines={list} onMachines={machines.replace} onAct={act} />
					)}
				</SettingsGroup>

				<SettingsGroup
					id="connections-pay"
					title="Who pays"
					lede="For agents a plan can pay for: whether hosted turns use the plan, the key or both, and what happens when the plan hits its limit."
				>
					{payWith.choices === null || inputs === null ? (
						payWith.error ? (
							<p className="field-note tone-bad" role="alert">
								{payWith.error}
							</p>
						) : (
							<p className="usage-empty" aria-busy="true">
								Reading who pays…
							</p>
						)
					) : (
						<div className="conn-pays">
							{payWith.choices.map(choice => (
								<PayWithCard
									key={choice.harness}
									choice={choice}
									choices={payWith.choices ?? []}
									inputs={inputs}
									saving={payWith.saving === choice.harness}
									onSave={patch => void payWith.save(patch)}
								/>
							))}
							{payWith.error ? (
								<p className="field-note tone-bad" role="alert">
									{payWith.error}
								</p>
							) : null}
						</div>
					)}
				</SettingsGroup>

				{!auth.profile.demo ? (
					<SettingsGroup
						id="connections-plans"
						title="Plans"
						lede="Connect a plan with one command in a terminal on your computer. The token stays on Windlass and never reaches an agent."
					>
						<ul className="settings-list" aria-label="Your plans">
							<ChatgptPlan />
							<ClaudePlan />
						</ul>
					</SettingsGroup>
				) : null}

				<SettingsGroup
					id="connections-keys"
					title="API keys"
					lede={
						<>
							Keys serve every agent that can use their provider, hosted and on your machines. They stay on Windlass.{" "}
							<a className="link" href="/docs/settings#model-providers">
								How keys are used →
							</a>
						</>
					}
				>
					<ModelProviders />
					{upgrades.length > 0 ? (
						<div className="settings-row settings-row-notes">
							{upgrades.map(({ machine, note }) => (
								<p className="field-note" key={machine.machineId}>
									{machineLabel(machine)}: {note}
								</p>
							))}
						</div>
					) : null}
				</SettingsGroup>
			</SettingsLayout>

			{opened?.kind === "plan" ? (
				<Dialog title={`Connect your ${PLAN_NAMES[opened.provider]}`} onClose={close}>
					<PlanWait provider={opened.provider} onConnected={close} />
				</Dialog>
			) : null}
			{opened?.kind === "key" ? (
				<KeyDialog
					provider={opened.provider}
					replacing={opened.replacing}
					onClose={close}
					onSaved={() => window.dispatchEvent(new Event(PROVIDERS_CHANGED))}
				/>
			) : null}
		</main>
	);
}
