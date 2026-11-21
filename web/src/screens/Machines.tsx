/**
 * Machines: the user's own Linux machines with Docker, on which their agents can run. A program on
 * the machine, the runner, connects out to the platform; the user pairs it here by typing the code it
 * prints, after seeing what the machine says about itself.
 *
 * Everything on the page is the user's actor's (`MachineSummary`): the list is read when the page
 * opens, replaced whenever the actor says it changed (the user's live feed, `onMachines`), and read
 * again when that feed comes back after a drop, since what was said meanwhile is lost. Nothing is
 * asked on a timer. The install command is the deployment's (`PlatformInfo.machines`), and so are the
 * runner versions the page compares.
 *
 * `/machines/add` opens the dialog that pairs a machine: it is the address a runner prints with its code.
 *
 * Each machine shows its runner's last sign-in report and a copyable terminal command for each agent.
 */
import { MAX_MACHINES, type MachineClaim, type MachineSandbox, type MachineSummary, type MachineWarning, type MachinesInfo } from "@contract";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { hasReason } from "../api/client";
import { CopyButton } from "../components/Copy";
import { Command } from "../components/Command";
import { Dialog } from "../components/Dialog";
import { ArrowLeftIcon, CheckIcon, ChevronIcon, InfoIcon, MachineIcon, Mark, PencilIcon, PlusIcon, TrashIcon, WarnIcon } from "../components/Icons";
import { RowsSkeleton } from "../components/Skeleton";
import { SandboxState } from "../components/Status";
import { HARNESS_NAMES, loginCommand, type ReportedHarness } from "../lib/acp";
import { absoluteTime, plural, relativeTime, spelledDuration } from "../lib/format";
import { linkProps, navigate } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { MAX_WHEN_TO_USE, machineDetailsProblem, machineHostNote, machineLabel, tagsOf } from "../lib/machines";

/** What the top bar shows on this page: the way back and where one is. */
export function MachinesCrumb() {
	return (
		<nav className="crumb" aria-label="Where you are">
			<a className="crumb-back" {...linkProps({ name: "home" })}>
				<ArrowLeftIcon size={14} />
				<span>Agents</span>
			</a>
			<span className="crumb-sep" aria-hidden="true">
				/
			</span>
			<span className="crumb-title" aria-current="page">
				Machines
			</span>
		</nav>
	);
}

/** The command that starts the runner on a machine, as `MachinesInfo` describes it; null while no runner image is published. */
function installCommand(info: MachinesInfo, agents: { claude?: boolean; openCode?: boolean } = {}, setup?: { importKeys: boolean }): string | null {
	if (info.runnerImage === null) return null;
	return [
		(setup ? "docker run -it --rm" : "docker run -d --name windlass-runner --restart unless-stopped") + " \\",
		"  -v /var/run/docker.sock:/var/run/docker.sock \\",
		"  -v windlass-runner:/var/lib/windlass-runner \\",
		...(agents.openCode && setup?.importKeys ? ['  -v "${XDG_DATA_HOME:-$HOME/.local/share}/opencode:/import/opencode:ro" \\'] : []),
		`  ${info.runnerImage}${setup ? " setup" : ""} --platform ${info.platformUrl}${agents.claude ? " --harness claude" : ""}${agents.openCode ? " --harness opencode" : ""}`,
	].join("\n");
}

/** A time of day, with the day when it is not today: "14:02", "17 Nov, 14:02". */
export function clockTime(at: number, now: number): string {
	const date = new Date(at);
	const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
	return date.toDateString() === new Date(now).toDateString() ? time : `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

/** Free disk in a sentence: "61 GB", "3.2 GB", "820 MB". */
function diskSize(bytes: number): string {
	if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1).replace(/\.0$/, "")} TB`;
	if (bytes >= 1e9) return `${bytes >= 1e10 ? Math.round(bytes / 1e9) : (bytes / 1e9).toFixed(1).replace(/\.0$/, "")} GB`;
	return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** A code as it is typed: the eight characters the runner printed, in two groups of four. */
function formatCode(typed: string): string {
	const characters = typed.toUpperCase().replace(/[^0-9A-Z]/g, "").slice(0, 8);
	return characters.length > 4 ? `${characters.slice(0, 4)}-${characters.slice(4)}` : characters;
}

export interface MachinesState {
	/** Null until it was read, and when it could not be. */
	list: MachineSummary[] | null;
	/** Why it could not be read the last time it was asked for. */
	error: string | null;
	reload(): void;
	/** Takes the list as an action answered it. */
	replace(list: MachineSummary[]): void;
}

/**
 * The user's machines: read when the screen opens, then as the user's actor sends them, and again
 * after the live feed was down. `enabled` false asks nothing: for a deployment that offers no machines,
 * and for a screen that needs them only sometimes (a session on a machine).
 */
export function useMachines(enabled = true): MachinesState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ list: MachineSummary[] | null; error: string | null }>({ list: null, error: null });
	const asked = useRef(0);

	const reload = useCallback(() => {
		const mine = ++asked.current;
		client
			.user(auth)
			.machines()
			.then(
				(list) => mine === asked.current && setState({ list, error: null }),
				(failure: unknown) => mine === asked.current && setState((now) => ({ list: now.list, error: explain(failure) })),
			);
	}, [client, auth, explain]);

	const replace = useCallback((list: MachineSummary[]) => {
		asked.current += 1;
		setState({ list, error: null });
	}, []);

	useEffect(() => {
		if (!enabled) return;
		reload();
		let connected = false;
		const close = client.user(auth).watch({
			onSessions: () => undefined,
			onMachines: replace,
			onConnection: (connection) => {
				if (connection !== "connected") return;
				// What the actor sent while the feed was down is lost: the list is read again when it is back.
				if (connected) reload();
				connected = true;
			},
		});
		return () => {
			asked.current += 1;
			close();
		};
	}, [client, auth, reload, replace, enabled]);

	return { ...state, reload, replace };
}

/** Where a machine is, as a dot and a few words. A runner that is too old is refused, so that is what it says. */
export function MachineState({ machine, now }: { machine: MachineSummary; now: number }) {
	const outdated = machine.warnings.some((warning) => warning.kind === "outdated");
	const kind = outdated ? "outdated" : machine.status;
	const word = outdated ? "Needs an update" : machine.status === "online" ? "Online" : machine.status === "offline" ? `Offline since ${clockTime(machine.since, now)}` : "Waiting for the runner";
	return (
		<span className={`sandbox-state machine-state machine-state-${kind}`} title={machine.status === "offline" ? absoluteTime(machine.since) : undefined}>
			<span className="sandbox-state-dot" aria-hidden="true" />
			{word}
		</span>
	);
}

/** What the runner reported that needs the user, each only while it holds. */
function Warning({ warning, machine, info, now }: { warning: MachineWarning; machine: MachineSummary; info: MachinesInfo; now: number }) {
	if (warning.kind === "outdated") {
		const install = installCommand(info);
		return (
			<div className="callout callout-warn" role="status">
				<WarnIcon />
				<div>
					<p className="callout-text">
						This machine's runner is {machine.runnerVersion}; the platform needs {info.minRunnerVersion} or later, so it cannot connect.{" "}
						{install ? "Update it on the machine: its volume keeps the key, so it stays paired." : "No newer runner is published yet."}
					</p>
					{install ? <Command text={`docker rm -f windlass-runner\n${install}`} label="The update command" /> : null}
				</div>
			</div>
		);
	}
	if (warning.kind === "docker") {
		return (
			<div className="callout callout-warn" role="status">
				<WarnIcon />
				<div>
					<p className="callout-text">The runner cannot reach Docker on this machine, so no agent can start here. The runner reports:</p>
					<p className="callout-detail">{warning.reason}</p>
				</div>
			</div>
		);
	}
	if (warning.kind === "clock") {
		const off = spelledDuration(Math.abs(warning.offsetSeconds) * 1000);
		return (
			<p className="callout callout-warn" role="status">
				<WarnIcon />
				<span>
					This machine's clock is {off} {warning.offsetSeconds > 0 ? "ahead of" : "behind"} the platform's, so a turn's access token can read as expired too early or too late. Set the clock from the network, for example with{" "}
					<code>timedatectl set-ntp true</code>.
				</span>
			</p>
		);
	}
	return (
		<p className="callout callout-warn" role="status">
			<WarnIcon />
			<span>
				This machine's key was used from two places at <span title={absoluteTime(warning.at)}>{clockTime(warning.at, now)}</span>; if you did not copy it, remove the machine.
			</span>
		</p>
	);
}

/** The switch that says whether saved secrets go to the machine: changed at once, and the list it answers with says what it is. */
function SecretsSwitch({ machine, onChanged }: { machine: MachineSummary; onChanged(list: MachineSummary[]): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const set = (send: boolean) => {
		setBusy(true);
		setError(null);
		client
			.user(auth)
			.setMachineSecrets({ machineId: machine.machineId, send })
			.then(
				(list) => {
					onChanged(list);
					setBusy(false);
				},
				(failure: unknown) => {
					setError(explain(failure));
					setBusy(false);
				},
			);
	};
	return (
		<div>
			<label className={`check${machine.sendSecrets ? " check-on" : ""}`}>
				<input className="check-input" type="checkbox" checked={machine.sendSecrets} disabled={busy} onChange={(event) => set(event.target.checked)} />
				<span className="check-box" aria-hidden="true" />
				<span className="check-text">
					<span className="check-name">Send saved secrets to this machine</span>
					<span className="check-means">
						{machine.sendSecrets
							? "Each turn of an agent here gets the saved secrets it is allowed, the repository's and the account's. Turned off, none are sent, and what needs one fails on this machine."
							: "No saved secret is sent here, so what needs one fails on this machine. Turned on, each agent gets them from its next turn."}
					</span>
				</span>
			</label>
			{error ? (
				<p className="field-note tone-bad" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}

/** An agent's sandbox on a machine: the agent, whether the sandbox runs, and when it was last used. */
/** How many sandboxes the machine's runner may run and keep, as its owner started it: "no limit" unless a cap is set. */
function sandboxLimit(machine: MachineSummary): string {
	const caps = [machine.maxRunning === undefined ? null : `at most ${machine.maxRunning} running at once`, machine.maxSandboxes === undefined ? null : `at most ${machine.maxSandboxes} kept`].filter((cap) => cap !== null);
	return caps.length === 0 ? "no limit" : caps.join(", ");
}

export function SandboxLine({ sandbox, now }: { sandbox: MachineSandbox; now: number }) {
	return (
		<li>
			{sandbox.title === null ? (
				<span className="tone-dim">an agent that was deleted</span>
			) : (
				<a className="usage-agent" {...linkProps({ name: "session", id: sandbox.sessionId })}>
					{sandbox.title}
				</a>
			)}
			<SandboxState state={sandbox.state} />
			<span className="machine-used" title={absoluteTime(sandbox.usedAt)}>
				used {relativeTime(sandbox.usedAt, now)}
			</span>
		</li>
	);
}

/**
 * A machine's agents as a status list: each one signed in or not, as its runner last said, with the
 * command that signs it in on the machine. Signing in is done in the machine's terminal only.
 */
function MachineAgents({ harnesses }: { harnesses: ReportedHarness[] }) {
	if (harnesses.length === 0) return null;
	return (
		<ul className="machine-agents" aria-label="Agents on this machine">
			{harnesses.map((harness) => {
				const command = loginCommand(harness);
				return (
					<li key={harness.id} className={`machine-agent machine-agent-${harness.signIn}`}>
						<span className="machine-agent-name">{HARNESS_NAMES[harness.id]}</span>
						{harness.signIn === "token" ? (
							<span className="machine-agent-state">
								{" "}
								<CheckIcon size={13} />
								signed in
							</span>
						) : (
							<span className="machine-agent-state">: {harness.signIn === "none" ? "sign in needed" : "sign-in not reported"}</span>
						)}
						<span className="machine-agent-command">
							<code>{command}</code>
							<CopyButton text={command} label={`Copy the command that signs ${HARNESS_NAMES[harness.id]} in`} />
						</span>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * What the owner says of the machine for the planner of a feature: when to use it, and tags. One
 * quiet line in its card, edited in place; saved with `setMachineDetails`, checked first as the
 * server checks it.
 */
function MachineUse({ machine, onChanged }: { machine: MachineSummary; onChanged(list: MachineSummary[]): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState("");
	const [tagText, setTagText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { text: useId(), tags: useId(), note: useId() };
	const whenToUse = machine.whenToUse ?? "";
	const tags = machine.tags ?? [];
	const typedTags = tagsOf(tagText);
	const problem = editing ? machineDetailsProblem(text.trim(), typedTags) : null;
	const changed = text.trim() !== whenToUse || JSON.stringify(typedTags) !== JSON.stringify(tags);
	const edit = () => {
		setText(whenToUse);
		setTagText(tags.join(", "));
		setError(null);
		setEditing(true);
	};
	const save = (event: FormEvent) => {
		event.preventDefault();
		if (problem || busy) return;
		setBusy(true);
		setError(null);
		client
			.user(auth)
			.setMachineDetails({ machineId: machine.machineId, whenToUse: text.trim(), tags: typedTags })
			.then(
				(list) => {
					onChanged(list);
					setBusy(false);
					setEditing(false);
				},
				(failure: unknown) => {
					setError(explain(failure));
					setBusy(false);
				},
			);
	};
	if (!editing) {
		return (
			<div className="machine-use">
				{whenToUse === "" && tags.length === 0 ? (
					<span className="machine-use-empty">No note on when to use it.</span>
				) : (
					<>
						{whenToUse !== "" ? <span className="machine-use-text">{whenToUse}</span> : null}
						{tags.map((tag) => (
							<span key={tag} className="machine-tag">
								{tag}
							</span>
						))}
					</>
				)}
				<button type="button" className="link machine-use-edit" onClick={edit} aria-label={`Edit when to use ${machineLabel(machine)}`}>
					<PencilIcon size={11} />
					{whenToUse === "" && tags.length === 0 ? "Add" : "Edit"}
				</button>
			</div>
		);
	}
	return (
		<form className="machine-use-form" onSubmit={save}>
			<div className="machine-use-fields">
				<div>
					<label className="label" htmlFor={ids.text}>
						When to use it
					</label>
					<input id={ids.text} className="input" value={text} maxLength={MAX_WHEN_TO_USE + 50} placeholder="Builds and browser tests; it has the GPU" onChange={(event) => setText(event.target.value)} readOnly={busy} aria-describedby={ids.note} data-autofocus autoFocus />
				</div>
				<div>
					<label className="label" htmlFor={ids.tags}>
						Tags<span className="label-optional">comma or space between</span>
					</label>
					<input id={ids.tags} className="input input-mono" value={tagText} placeholder="gpu, big-build" onChange={(event) => setTagText(event.target.value)} readOnly={busy} aria-describedby={ids.note} aria-invalid={problem !== null || undefined} />
				</div>
			</div>
			<p className={`field-note${problem || error ? " tone-bad" : ""}`} id={ids.note} role={problem || error ? "alert" : undefined}>
				{problem ?? error ?? "The planner of a feature reads this, with the machine's OS, capacity and what it can run, when it splits the work."}
			</p>
			<div className="machine-use-actions">
				<button type="submit" className="button button-primary button-small" disabled={busy || problem !== null || !changed}>
					{busy ? "Saving…" : "Save"}
				</button>
				<button type="button" className="button button-quiet button-small" onClick={() => setEditing(false)} disabled={busy}>
					Cancel
				</button>
			</div>
		</form>
	);
}

function MachineRow({ machine, info, now, onChanged, onRemove }: { machine: MachineSummary; info: MachinesInfo; now: number; onChanged(list: MachineSummary[]): void; onRemove(machine: MachineSummary): void }) {
	const [open, setOpen] = useState(false);
	const details = useId();
	const reported = machine.commandSandbox !== null;
	const paired = relativeTime(machine.since, now);

	const host = machineHostNote(machine);
	return (
		<li className={`usage-kept-row machine-row machine-row-${machine.warnings.some((warning) => warning.kind === "outdated") ? "outdated" : machine.status}`}>
			<span className="machine-glyph" aria-hidden="true">
				<MachineIcon size={17} />
			</span>
			<div className="usage-kept-main">
				<div className="machine-name">
					<h3 className="usage-kept-title">{machineLabel(machine)}</h3>
					{host === null ? (
						<>
							<span className="chip">{machine.os}</span>
							<span className="chip">{machine.arch}</span>
						</>
					) : (
						<span className="machine-host" title="The host name its runner reported: a Docker container's id, so the machine is called by its OS and architecture here.">
							host {host}
						</span>
					)}
				</div>
				<p className="agent-meta">
					<span>runner {machine.runnerVersion}</span>
					<span className="machine-sandbox-count">
						{machine.sandboxes.length === 0 ? "no sandbox on it" : plural(machine.sandboxes.length, "agent's sandbox", "agents' sandboxes")}
						{machine.maxSandboxes ? (
							<span className="machine-meter" role="img" aria-label={`${machine.sandboxes.length} of at most ${machine.maxSandboxes} kept`}>
								<span style={{ width: `${Math.min(100, (machine.sandboxes.length / machine.maxSandboxes) * 100)}%` }} />
							</span>
						) : null}
					</span>
					<span>
						<button type="button" className="link machine-toggle" aria-expanded={open} aria-controls={details} onClick={() => setOpen((value) => !value)}>
							<ChevronIcon size={11} className="machine-chevron" />
							{open ? "Hide details" : "Details"}
						</button>
					</span>
				</p>
				<MachineUse machine={machine} onChanged={onChanged} />
				<MachineAgents harnesses={machine.harnesses ?? []} />
			</div>
			<MachineState machine={machine} now={now} />
			<button type="button" className="button button-outline button-small machine-remove" onClick={() => onRemove(machine)}>
				<TrashIcon size={13} />
				<span>
					Remove<span className="visually-hidden"> {machineLabel(machine)}</span>…
				</span>
			</button>

			{machine.status === "waiting" || machine.warnings.length > 0 ? (
				<div className="machine-notes">
					{machine.status === "waiting" && machine.warnings.length === 0 ? (
						<p className="usage-note">
							Paired {paired === "now" ? "a moment ago" : paired}; its runner has not connected since. Check <code>docker logs windlass-runner</code> on the machine. A runner that lost its key before it connected never will: remove this machine and add it again.
						</p>
					) : null}
					{machine.warnings.map((warning) => (
						<Warning key={warning.kind} warning={warning} machine={machine} info={info} now={now} />
					))}
				</div>
			) : null}

			<div id={details} className="machine-details" hidden={!open}>
				<div>
					<h4 className="eyebrow">Sandboxes</h4>
					{machine.sandboxes.length === 0 ? (
						<p className="usage-lede">{reported ? "No agent's sandbox is on it." : "Its runner has not reported yet."}</p>
					) : (
						<ul className="machine-sandboxes">
							{machine.sandboxes.map((sandbox) => (
								<SandboxLine key={sandbox.sessionId} sandbox={sandbox} now={now} />
							))}
						</ul>
					)}
				</div>
				<dl className="machine-facts">
					<div>
						<dt>Commands sandboxed by Windlass</dt>
						<dd>{machine.commandSandbox === null ? <span className="tone-faint">not reported yet</span> : machine.commandSandbox.ok ? "yes" : <>no: {machine.commandSandbox.reason}</>}</dd>
					</div>
					{machine.turns || machine.host ? (
						<div>
							<dt>Capacity</dt>
							<dd>
								{machine.turns ? `${machine.turns.running} of ${machine.turns.max ?? "any number of"} turns running${machine.turns.queued ? `, ${machine.turns.queued} queued` : ""}` : null}
								{machine.turns && machine.host ? " · " : null}
								{machine.host ? `${machine.host.sandboxCpus} of ${machine.host.cpus} CPUs for sandboxes, ${diskSize(machine.host.memoryFreeBytes)} of ${diskSize(machine.host.memoryBytes)} memory free` : null}
							</dd>
						</div>
					) : null}
					<div>
						<dt>Free disk</dt>
						<dd>{machine.freeDiskBytes === null ? <span className="tone-faint">not reported yet</span> : diskSize(machine.freeDiskBytes)}</dd>
					</div>
					<div>
						<dt>Sandbox limit</dt>
						<dd>
							{reported ? sandboxLimit(machine) : <span className="tone-faint">not reported yet</span>}
							<p className="field-note">
								Set on the machine, not here: start its runner with <code>--max-running</code> or <code>--max-sandboxes</code>.
							</p>
						</dd>
					</div>
				</dl>
				<SecretsSwitch machine={machine} onChanged={onChanged} />
			</div>
		</li>
	);
}

type AddStep = { step: "command" } | { step: "code" } | { step: "confirm"; claim: MachineClaim };

/** Pairing a machine: the command that starts its runner, the code the runner prints, and what that machine says it is. */
function AddDialog({ info, onClose, onAdded }: { info: MachinesInfo; onClose(): void; onAdded(machine: MachineSummary): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [step, setStep] = useState<AddStep>({ step: "command" });
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Whether the code itself was refused, rather than the asking failing. */
	const [unknown, setUnknown] = useState(false);
	/** The control each step after the first starts on: the field, or the button that decides. */
	const start = useRef<HTMLElement | null>(null);
	const aim = (element: HTMLElement | null) => {
		start.current = element;
	};
	const ids = { form: useId(), code: useId(), codeNote: useId(), trust: useId() };
	const [claude, setClaude] = useState(false);
	const [openCode, setOpenCode] = useState(false);
	const [importKeys, setImportKeys] = useState(false);
	const agents = { claude, openCode };
	const setup = installCommand(info, agents, { importKeys });
	const install = installCommand(info, agents);
	const complete = code.replace(/-/g, "").length === 8;

	const shown = useRef(step.step);
	useEffect(() => {
		if (shown.current === step.step) return;
		shown.current = step.step;
		start.current?.focus();
	}, [step.step]);

	const go = (next: AddStep) => {
		setError(null);
		setStep(next);
	};

	const check = async (event?: FormEvent) => {
		event?.preventDefault();
		if (!complete || busy) return;
		setBusy(true);
		setError(null);
		try {
			const claim = await client.user(auth).claimMachine({ code });
			setStep({ step: "confirm", claim });
		} catch (failure) {
			setError(explain(failure));
			setUnknown(hasReason(failure, "pairing_not_found"));
		} finally {
			setBusy(false);
		}
	};

	const connect = async () => {
		setBusy(true);
		setError(null);
		try {
			onAdded(await client.user(auth).confirmMachine({ code }));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	const failed = error ? (
		<p className="callout callout-bad" role="alert">
			<WarnIcon />
			<span>{error}</span>
		</p>
	) : null;

	if (step.step === "confirm") {
		const { claim } = step;
		return (
			<Dialog
				title="Add a machine"
				lede={<>Connect “{machineLabel(claim)}” to your account?</>}
				onClose={onClose}
				dismissable={!busy}
				footer={
					<>
						<button type="button" className="button button-quiet" onClick={() => go({ step: "code" })} disabled={busy}>
							Back
						</button>
						<button type="button" className="button button-primary" onClick={connect} disabled={busy} aria-describedby={ids.trust} ref={aim}>
							{busy ? "Connecting…" : "Connect"}
						</button>
					</>
				}
			>
				<div className="machine-dialog">
					<div>
						<p className="eyebrow">What the machine says about itself</p>
						<dl className="machine-claim">
							<dt>Name</dt>
							<dd>
								{claim.name || <span className="tone-faint">none reported</span>}
								{machineHostNote(claim) === null ? null : <span className="field-note machine-claim-note">A Docker container's id: the page calls it “{machineLabel(claim)}”.</span>}
							</dd>
							<dt>OS</dt>
							<dd>{claim.os}</dd>
							<dt>Architecture</dt>
							<dd>{claim.arch}</dd>
							<dt>Runner</dt>
							<dd>{claim.runnerVersion}</dd>
						</dl>
						<p className="field-note">Nobody has checked these: connect it only if it is the machine you started the runner on.</p>
					</div>
					<p id={ids.trust}>
						It will run the agents you start on it and receive what they need: your repository's files, its saved secrets and a one-hour ChatGPT token for each turn. The platform does not control this machine, and what a session there shows of checks and changes is what the machine reports.
					</p>
					{failed}
				</div>
			</Dialog>
		);
	}

	if (step.step === "code") {
		return (
			<Dialog
				title="Add a machine"
				lede="The runner prints a code. Enter it here."
				onClose={onClose}
				dismissable={!busy}
				footer={
					<>
						<button type="button" className="button button-quiet" onClick={() => go({ step: "command" })} disabled={busy}>
							Back
						</button>
						<button type="submit" form={ids.form} className="button button-primary" disabled={!complete || busy}>
							{busy ? "Checking…" : "Check code"}
						</button>
					</>
				}
			>
				<form id={ids.form} className="machine-dialog" onSubmit={check}>
					<div>
						<label className="label" htmlFor={ids.code}>
							Code
						</label>
						<input
							id={ids.code}
							className={`input input-mono machine-code${unknown ? " input-invalid" : ""}`}
							value={code}
							placeholder="XXXX-XXXX"
							inputMode="text"
							autoComplete="one-time-code"
							autoCapitalize="characters"
							spellCheck={false}
							maxLength={9}
							aria-describedby={ids.codeNote}
							aria-invalid={unknown || undefined}
							readOnly={busy}
							onChange={(event) => {
								setCode(formatCode(event.target.value));
								setError(null);
								setUnknown(false);
							}}
							ref={aim}
						/>
						<p className="field-note" id={ids.codeNote}>
							It is in <code>docker logs windlass-runner</code> on the machine, and lasts ten minutes.
						</p>
					</div>
					{failed}
				</form>
			</Dialog>
		);
	}

	return (
		<Dialog
			title="Add a machine"
			lede="Run this in a terminal on a Linux machine with Docker. The runner connects out to the platform; nothing needs to reach your machine from outside."
			onClose={onClose}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose}>
						Cancel
					</button>
					<button type="button" className="button button-primary" onClick={() => go({ step: "code" })} ref={aim}>
						Enter the code
					</button>
				</>
			}
		>
			<div className="machine-dialog">
				{setup ? (
					<div>
						<p className="machine-step">Set it up</p>
						<div className="machine-setup-agents">
							<label><input type="checkbox" checked={claude} onChange={event => setClaude(event.target.checked)} /> Enable Claude Code</label>
							<label><input type="checkbox" checked={openCode} onChange={event => setOpenCode(event.target.checked)} /> Enable OpenCode</label>
							{openCode && <label><input type="checkbox" checked={importKeys} onChange={event => setImportKeys(event.target.checked)} /> Import existing OpenCode API keys during setup</label>}
						</div>
						<Command text={setup} label="The setup command" />
						<p className="field-note">It pairs the machine and signs its agents in, asking in the terminal as it goes. Sign an agent in or out later with <code>windlass-runner login</code> or <code>logout</code> and the agent's name.</p>
					</div>
				) : null}
				{install ? (
					<div>
						<p className="machine-step">Or start the runner in the background</p>
						<Command text={install} label="The install command" />
						<p className="field-note">
							Where rootless Docker works, use it: the runner then gets less of your machine. Mount <code>$XDG_RUNTIME_DIR/docker.sock</code> in place of <code>/var/run/docker.sock</code>.
						</p>
					</div>
				) : (
					<p className="callout callout-info">
						<InfoIcon />
						<span>The runner is not published yet, so there is nothing to install from here. Once it is, its command is shown here.</span>
					</p>
				)}
				<p>The runner prints a code to pair the machine with: the next step asks for it.</p>
			</div>
		</Dialog>
	);
}

function RemoveDialog({ machine, onClose, onRemoved }: { machine: MachineSummary; onClose(): void; onRemoved(list: MachineSummary[]): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [sandboxes, setSandboxes] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const agents = machine.agents;

	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			onRemoved(await client.user(auth).removeMachine({ machineId: machine.machineId, removeSandboxes: sandboxes }));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title={`Remove “${machineLabel(machine)}”?`}
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={remove} disabled={busy}>
						{busy ? "Removing…" : "Remove machine"}
					</button>
				</>
			}
		>
			<p>
				Its key stops working at once.{" "}
				{agents === 0
					? "No agent was launched on it."
					: `${agents === 1 ? "The agent on it keeps its conversation" : `The ${agents} agents on it keep their conversations`} here but cannot run again; ${agents === 1 ? "its" : "their"} files stay on the machine unless you also remove its sandboxes.`}
			</p>
			{agents > 0 || machine.sandboxes.length > 0 ? (
				<label className={`check machine-remove-check${sandboxes ? " check-on" : ""}`}>
					<input className="check-input" type="checkbox" checked={sandboxes} disabled={busy} onChange={(event) => setSandboxes(event.target.checked)} />
					<span className="check-box" aria-hidden="true" />
					<span className="check-text">
						<span className="check-name">Also remove the agents' sandboxes on it</span>
						<span className="check-means">{machine.status === "online" ? "Its runner removes them now." : "Its runner removes them when it is next online."}</span>
					</span>
				</label>
			) : null}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</Dialog>
	);
}

export function Machines({ adding }: { adding: boolean }) {
	const { platform } = useApp();
	const machines = useMachines();
	const now = useNow(30_000);
	const [removing, setRemoving] = useState<MachineSummary | null>(null);
	const info = platform.info?.machines ?? null;
	const { list } = machines;
	const full = list !== null && list.length >= MAX_MACHINES;
	const add = () => navigate({ name: "machines", add: true });
	const closeAdd = () => navigate({ name: "machines" }, { replace: true });
	// The address a runner prints opens the dialog once what it needs is known; an account that cannot add another goes to its list.
	const canAdd = (list !== null || machines.error !== null) && !full;
	useEffect(() => {
		if (adding && full) navigate({ name: "machines" }, { replace: true });
	}, [adding, full]);

	return (
		<main className="home usage repo machines">
			<header className="home-head">
				<div className="repo-head">
					<p className="eyebrow">account</p>
					<h1 className="display display-small">Machines</h1>
					<p className="home-account">Run agents on your own Linux machine with Docker. The runner on it connects out to the platform; nothing needs to reach your machine from outside.</p>
				</div>
				<div className="machines-add">
					<button type="button" className="button button-outline" onClick={add} disabled={info === null || full}>
						<PlusIcon />
						Add a machine
					</button>
					{full ? <p className="field-note">An account can connect up to {MAX_MACHINES} machines.</p> : null}
				</div>
			</header>

			{list === null || info === null ? (
				<section className="usage-section">
					{machines.error || (platform.error && info === null) ? (
						<div className="state state-error" role="alert">
							<WarnIcon size={22} />
							<h2>Your machines could not be loaded</h2>
							<p>{machines.error ?? platform.error}</p>
							<button
								type="button"
								className="button button-outline"
								onClick={() => {
									if (info === null) platform.reload();
									machines.reload();
								}}
							>
								Try again
							</button>
						</div>
					) : (
						<RowsSkeleton label="Loading your machines" rows={2} chips={2} />
					)}
				</section>
			) : (
				<>
					{machines.error ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{machines.error} What is shown may be behind.</span>
						</p>
					) : null}

					<section className="usage-section" aria-labelledby="machines-list">
						<h2 className="usage-title" id="machines-list">
							Your machines
							{list.length > 0 ? <span className="usage-count">{`${list.length} of ${MAX_MACHINES}`}</span> : null}
						</h2>
						{list.length === 0 ? (
							<div className="state state-empty">
								<Mark size={44} />
								<p>No machine is connected yet. Add one, and the agents you launch can run there.</p>
								<button type="button" className="button button-outline" onClick={add}>
									<PlusIcon />
									Add a machine
								</button>
							</div>
						) : (
							<>
								<ul className="usage-kept">
									{list.map((machine) => (
										<MachineRow key={machine.machineId} machine={machine} info={info} now={now} onChanged={machines.replace} onRemove={setRemoving} />
									))}
								</ul>
								<p className="usage-note">The platform does not control these machines. It sends one only what its own agents need, and nothing once it is removed.</p>
							</>
						)}
					</section>
				</>
			)}

			{adding && info !== null && canAdd ? <AddDialog info={info} onClose={closeAdd} onAdded={(machine) => machines.replace([...(list ?? []).filter((one) => one.machineId !== machine.machineId), machine])} /> : null}
			{removing ? <RemoveDialog machine={removing} onClose={() => setRemoving(null)} onRemoved={machines.replace} /> : null}
		</main>
	);
}
