/**
 * The first-run setup on Home's empty page (lib/onboarding.ts says when it opens and what it keeps): ① install the
 * GitHub App, ② pick a repository, ③ connect the agents (a plan, an API key, or a computer of the user's own, the
 * same connects the Connections page has), ④ file a first work item from a starter task or the user's own words.
 * Dismissible at every step and resumed where it was left.
 */
import {
	type GithubRepository,
	type HarnessId,
	type MachineSummary,
	type ModelProvider,
	PLAN_NAMES,
	type PlanProvider,
	type StarterIssue,
} from "@contract";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { PAY_WITH_HARNESSES } from "../../../server/src/pay-with.js";
import { keyProviders, machineHarness } from "../../../server/src/sandbox/harnesses.js";
import { HARNESS_NAMES } from "../lib/acp";
import { type ConnectionInputs, anyAgentConnected, hostedCell } from "../lib/connections";
import { relativeTime } from "../lib/format";
import { machineLabel } from "../lib/machines";
import { SOURCE_NAMES } from "../lib/models";
import {
	loadOnboarding,
	ONBOARDING_STEPS,
	type OnboardingSaved,
	type OnboardingStep,
	type PickedRepository,
	saveOnboarding,
	shouldOnboard,
	startingStep,
	starterTasks,
} from "../lib/onboarding";
import { itemOf } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { useApp, useAuth } from "../state/app";
import { useConnectionInputs } from "../state/connections";
import { useGithub } from "../state/github";
import { PROVIDERS_CHANGED, useNow } from "../state/hooks";
import { BranchIcon, CheckIcon, Mark, PullRequestIcon, RepoIcon } from "./Icons";
import { KeyDialog } from "./ModelProviders";
import { PlanWait } from "./PlanConnect";
import { Failure } from "./ui/Failure";
import { AgentGlyph } from "./ui/Pill";
import { StatusTag } from "./ui/StatusTag";

/** What a plan is, under its option. */
const PLAN_KINDS: Record<PlanProvider, string> = { anthropic: "Pro, Max or Team", openai: "Plus, Pro or Business" };

/**
 * Home's empty page: the setup where it opens (`shouldOnboard`), else `children`, with the way back to a dismissed
 * setup while the account is still not set up.
 */
export function OnboardingGate({
	sessions,
	items,
	machines,
	children,
}: {
	sessions: number | null;
	items: number | null;
	machines: readonly MachineSummary[];
	children: ReactNode;
}) {
	const { platform } = useApp();
	const auth = useAuth();
	const github = useGithub();
	const { inputs } = useConnectionInputs();
	const uid = auth.profile.uid;
	const [saved, setSaved] = useState(() => loadOnboarding(uid));
	// Once open, it stays open for this visit (connecting the last thing does not close it) until dismissed or done.
	const [latched, setLatched] = useState(false);
	const offered = github.enabled && Boolean(platform.info?.items);
	const githubConnected = github.status === null ? null : github.status.connection !== null;
	const agentConnected = inputs === null ? null : anyAgentConnected(inputs, machines);
	const open = shouldOnboard({
		demo: auth.profile.demo,
		offered,
		githubConnected,
		agentConnected,
		sessions,
		items,
		saved,
	});
	useEffect(() => {
		if (open) setLatched(true);
	}, [open]);
	const keep = useCallback(
		(next: OnboardingSaved) => {
			setSaved(next);
			saveOnboarding(uid, next);
		},
		[uid],
	);
	const showing = (latched && !saved?.dismissed) || open === true;
	if (showing && inputs && githubConnected !== null)
		return (
			<Onboarding
				saved={saved}
				githubConnected={githubConnected}
				inputs={inputs}
				machines={machines}
				onSave={keep}
				onDismiss={() => {
					setLatched(false);
					keep({ step: saved?.step ?? 1, repository: saved?.repository ?? null, dismissed: true });
				}}
			/>
		);
	if (open === null && !latched) return null;
	const unfinished =
		saved?.dismissed && offered && (sessions ?? 0) === 0 && (items ?? 0) === 0 && !(githubConnected && agentConnected);
	return (
		<>
			{children}
			{unfinished ? (
				<p className="onboard-resume">
					Your setup is not finished.
					<button
						type="button"
						className="button button-outline button-small"
						onClick={() => saved && keep({ ...saved, dismissed: false })}
					>
						Resume setup
					</button>
				</p>
			) : null}
		</>
	);
}

/** Each step's card: what it is called, why it matters, and what it needs first. */
const STEP_CARDS: Record<OnboardingStep, { title: string; why: string; after?: string }> = {
	1: { title: "Connect GitHub", why: "Windlass opens pull requests in the repositories you choose." },
	2: { title: "Pick a repository", why: "Start with one. You can add more any time.", after: "After GitHub" },
	3: { title: "Connect your agents", why: "A plan, an API key, or your own computer.", after: "After GitHub" },
	4: {
		title: "File your first item",
		why: "A starter task or your own words, ending in a pull request.",
		after: "After a repository",
	},
};

const STEP_ICONS: Record<OnboardingStep, ReactNode> = {
	1: <PullRequestIcon size={16} />,
	2: <RepoIcon size={16} />,
	3: <Mark size={16} />,
	4: <BranchIcon size={16} />,
};

/** What runs each plan agent now, in a few words: "Claude Code: Claude plan · Codex: OpenAI key". */
function agentsSummary(inputs: ConnectionInputs, machines: readonly MachineSummary[]): string {
	const lines = PAY_WITH_HARNESSES.flatMap(harness => {
		const hosted = hostedCell(harness, inputs);
		if (hosted.state === "plan" || hosted.state === "key") return [`${HARNESS_NAMES[harness]}: ${hosted.label}`];
		const machine = machines.find(one =>
			one.harnesses?.some(entry => entry.id === harness && entry.signIn === "token"),
		);
		return machine ? [`${HARNESS_NAMES[harness]}: ${machineLabel(machine)}`] : [];
	});
	return lines.length ? lines.join(" · ") : "An agent is connected";
}

/**
 * The setup as four cards in a row (stacked on a phone): each says why it matters and has its one action; a finished
 * one says what was chosen. The open card's choices (the repositories, the agents, the starter tasks) open under the
 * row, or under the card on a phone.
 */
function Onboarding({
	saved,
	githubConnected,
	inputs,
	machines,
	onSave,
	onDismiss,
}: {
	saved: OnboardingSaved | null;
	githubConnected: boolean;
	inputs: ConnectionInputs;
	machines: readonly MachineSummary[];
	onSave(saved: OnboardingSaved): void;
	onDismiss(): void;
}) {
	const github = useGithub();
	const [step, setStep] = useState<OnboardingStep>(() => startingStep(saved, githubConnected));
	const repository = saved?.repository ?? null;
	const go = (next: OnboardingStep, picked: PickedRepository | null = repository) => {
		setStep(next);
		onSave({ step: next, repository: picked, dismissed: false });
	};
	// A step is open once what it needs is there: GitHub for a repository, a repository for the first item.
	const reachable = (target: OnboardingStep) =>
		target === 1 || (githubConnected && (target < 4 || repository !== null));
	// GitHub is connected from its own card; once it is, the next card opens.
	const open: OnboardingStep = step === 1 && githubConnected ? 2 : step;
	const done: Record<OnboardingStep, string | null> = {
		1: githubConnected ? `Connected as ${github.status?.connection?.login ?? "you"}` : null,
		2: repository ? `${repository.owner}/${repository.name}` : null,
		3: anyAgentConnected(inputs, machines) ? agentsSummary(inputs, machines) : null,
		4: null,
	};
	const finished = Object.values(done).filter(Boolean).length;
	const waiting = github.busy === "leaving" || github.busy === "popup" || github.busy === "finishing";
	return (
		<section className="onboard" aria-label="Set up Windlass">
			<header className="onboard-head">
				<div>
					<p className="onboard-kicker">Get started</p>
					<p className="onboard-lede">Four steps to your first pull request.</p>
				</div>
				<div className="onboard-head-end">
					<span className="onboard-progress">
						{finished} of {ONBOARDING_STEPS.length} done
					</span>
					<button type="button" className="button button-quiet button-small" onClick={onDismiss}>
						Set up later
					</button>
				</div>
			</header>
			<ol className="onboard-cards">
				{([1, 2, 3, 4] as const).map(number => {
					const card = STEP_CARDS[number];
					const summary = done[number];
					const current = number === open;
					const can = reachable(number);
					const state = current ? "current" : summary ? "done" : can ? "todo" : "blocked";
					return (
						<li
							key={number}
							className="onboard-card"
							data-state={state}
							data-done={summary ? true : undefined}
							aria-current={current ? "step" : undefined}
							style={{ order: number * 2 }}
						>
							<div className="onboard-card-top">
								<span className="onboard-card-icon" aria-hidden="true">
									{summary ? <CheckIcon size={14} /> : STEP_ICONS[number]}
								</span>
								<span className="onboard-card-step">{summary ? "Done" : `Step ${number}`}</span>
							</div>
							<h3>{card.title}</h3>
							<p className="onboard-card-why">{summary ?? card.why}</p>
							<div className="onboard-card-action">
								{number === 1 ? (
									summary ? null : (
										<button
											type="button"
											className="button button-primary button-small"
											disabled={waiting}
											onClick={() => github.connect({ where: "launch", install: true })}
										>
											{waiting ? "Waiting for GitHub…" : "Install the GitHub App"}
										</button>
									)
								) : current ? null : !can ? (
									<span className="onboard-card-after">{card.after}</span>
								) : summary ? (
									<button type="button" className="button button-quiet button-small" onClick={() => go(number)}>
										Change<span className="visually-hidden"> {card.title.toLowerCase()}</span>
									</button>
								) : (
									<button type="button" className="button button-outline button-small" onClick={() => go(number)}>
										{number === 2 ? "Pick one" : number === 3 ? "Connect" : "Choose a task"}
									</button>
								)}
							</div>
							{number === 1 ? (
								<>
									{github.notice?.tone === "bad" ? <Failure error={github.notice.text} /> : null}
									<Failure error={github.error} />
								</>
							) : null}
						</li>
					);
				})}
				{open > 1 ? (
					<li className="onboard-open" style={{ order: open * 2 + 1 }} aria-label={STEP_CARDS[open].title}>
						{open === 2 ? (
							<RepositoryStep picked={repository} onNext={picked => go(3, picked)} />
						) : open === 3 ? (
							<AgentsStep inputs={inputs} machines={machines} onNext={() => go(4)} />
						) : repository ? (
							<FirstItemStep
								repository={repository}
								inputs={inputs}
								onFiled={() => onSave({ step: 4, repository, dismissed: true })}
							/>
						) : null}
					</li>
				) : null}
			</ol>
		</section>
	);
}

function RepositoryStep({
	picked,
	onNext,
}: {
	picked: PickedRepository | null;
	onNext(picked: PickedRepository): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const now = useNow(60_000);
	const [list, setList] = useState<GithubRepository[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [chosen, setChosen] = useState<PickedRepository | null>(picked);
	useEffect(() => {
		let live = true;
		client
			.user(auth)
			.githubRepositories("")
			.then(
				found => live && setList(found.repositories),
				(failure: unknown) => live && setError(explain(failure)),
			);
		return () => {
			live = false;
		};
	}, [client, auth, explain]);
	const wanted = filter.trim().toLowerCase();
	const shown = (list ?? [])
		.filter(one => `${one.owner}/${one.name}`.toLowerCase().includes(wanted))
		.sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0))
		.slice(0, 8);
	return (
		<>
			<div className="onboard-box">
				{list && list.length > 8 ? (
					<input
						className="input"
						placeholder="Filter repositories…"
						aria-label="Filter repositories"
						value={filter}
						onChange={event => setFilter(event.target.value)}
					/>
				) : null}
				{list === null && !error ? (
					<p className="usage-empty" aria-busy="true">
						Reading your repositories…
					</p>
				) : null}
				{list?.length === 0 ? (
					<p className="field-note">
						The GitHub App can reach no repository yet. Add one to its installation at GitHub, then come back.
					</p>
				) : null}
				<div role="radiogroup" aria-label="Repository" className="onboard-panel">
					{shown.map(one => (
						<button
							key={String(one.id)}
							type="button"
							role="radio"
							aria-checked={chosen?.id === one.id}
							className="onboard-choice"
							onClick={() => setChosen({ id: one.id, owner: one.owner, name: one.name })}
						>
							<span className="onboard-choice-mono">
								{one.owner}/{one.name}
							</span>
							<small>
								{one.private ? "Private" : "Public"}
								{one.pushedAt ? ` · pushed ${relativeTime(one.pushedAt, now)}` : ""}
								{one.canPush ? "" : " · read only: no pull request can be opened"}
							</small>
						</button>
					))}
				</div>
				<Failure error={error} />
			</div>
			<div className="onboard-foot">
				<div className="onboard-foot-end">
					<button
						type="button"
						className="button button-primary"
						disabled={chosen === null}
						onClick={() => chosen && onNext(chosen)}
					>
						Continue
					</button>
				</div>
			</div>
		</>
	);
}

type AgentOption = "plan" | "key" | "machine";

/** One agent's card: how it is connected, and the three ways to connect it. */
function AgentCard({
	harness,
	inputs,
	machines,
}: {
	harness: HarnessId;
	inputs: ConnectionInputs;
	machines: readonly MachineSummary[];
}) {
	const plan = machineHarness(harness)?.planProviders[0];
	const key: ModelProvider = keyProviders(harness)[0] ?? "openai";
	const allowed = inputs.plans.allowed && plan !== undefined;
	const [option, setOption] = useState<AgentOption>(allowed ? "plan" : "key");
	const [keying, setKeying] = useState(false);
	const hosted = hostedCell(harness, inputs);
	const onMachine = machines.find(machine =>
		machine.harnesses?.some(entry => entry.id === harness && entry.signIn === "token"),
	);
	const connected = hosted.state === "plan" || hosted.state === "key" || onMachine !== undefined;
	const options: { id: AgentOption; label: string; hint: string; disabled?: boolean }[] = [
		...(plan
			? [
					{
						id: "plan" as const,
						label: `Use my ${PLAN_NAMES[plan]}`,
						hint: allowed ? PLAN_KINDS[plan] : "Not available on this account yet",
						disabled: !allowed,
					},
				]
			: []),
		{ id: "key", label: `${SOURCE_NAMES[key]} API key`, hint: `Billed to your ${SOURCE_NAMES[key]} account` },
		{ id: "machine", label: "Run on my computer", hint: "Your own machine, with its own sign-in" },
	];
	const name = HARNESS_NAMES[harness];
	return (
		<div className="onboard-box" data-agent={harness}>
			<div className="onboard-agent-head">
				<AgentGlyph harness={harness} size={14} />
				<h3 className="conn-agent">{name}</h3>
				<StatusTag tone={connected ? "good" : "off"} className="conn-state">
					{connected ? (hosted.state === "none" ? "On your computer" : hosted.label) : "Not connected"}
				</StatusTag>
			</div>
			<div role="radiogroup" aria-label={`How ${name} is paid for`} className="onboard-panel">
				{options.map(one => (
					<button
						key={one.id}
						type="button"
						role="radio"
						aria-checked={option === one.id}
						className="onboard-choice"
						disabled={one.disabled}
						onClick={() => setOption(one.id)}
					>
						{one.label}
						<small>{one.hint}</small>
					</button>
				))}
			</div>
			<div className="onboard-panel">
				{option === "plan" && plan && allowed ? (
					hosted.state === "plan" ? (
						<p className="onboard-done">
							<CheckIcon size={15} />
							{PLAN_NAMES[plan]} connected
						</p>
					) : (
						<PlanWait key={plan} provider={plan} />
					)
				) : null}
				{option === "key" ? (
					hosted.state === "key" ? (
						<p className="onboard-done">
							<CheckIcon size={15} />
							{hosted.label} saved {hosted.detail ? `(${hosted.detail})` : ""}
						</p>
					) : (
						<button type="button" className="button button-outline" onClick={() => setKeying(true)}>
							Add the {SOURCE_NAMES[key]} key…
						</button>
					)
				) : null}
				{option === "machine" ? (
					onMachine ? (
						<p className="onboard-done">
							<CheckIcon size={15} />
							Signed in on {machineLabel(onMachine)}
						</p>
					) : (
						<>
							<p className="field-note">
								Pair the computer you want to use. One pairing serves every agent signed in on it.
							</p>
							<a className="button button-outline" {...linkProps({ name: "machines", add: true })}>
								Pair a computer
							</a>
						</>
					)
				) : null}
			</div>
			{keying ? <KeyDialog provider={key} replacing={false} onClose={() => setKeying(false)} onSaved={notify} /> : null}
		</div>
	);
}

/** Every reader of keys and plans reads them again. */
function notify() {
	window.dispatchEvent(new Event(PROVIDERS_CHANGED));
}

function AgentsStep({
	inputs,
	machines,
	onNext,
}: {
	inputs: ConnectionInputs;
	machines: readonly MachineSummary[];
	onNext(): void;
}) {
	const ready = anyAgentConnected(inputs, machines);
	return (
		<>
			<p className="onboard-sub">Pick how each one runs. You can change it later on Connections.</p>
			<div className="onboard-agents">
				{PAY_WITH_HARNESSES.map(harness => (
					<AgentCard key={harness} harness={harness} inputs={inputs} machines={machines} />
				))}
			</div>
			<p className="onboard-note">
				{inputs.chatgpt ? "Your ChatGPT plan also runs the Windlass agent. " : ""}
				OpenCode, and keys for Google and OpenRouter, are on the{" "}
				<a className="link" {...linkProps({ name: "connections" })}>
					Connections
				</a>{" "}
				page.
			</p>
			<div className="onboard-foot">
				<div className="onboard-foot-end">
					{ready ? null : (
						<button type="button" className="button button-outline" onClick={onNext}>
							Skip for now
						</button>
					)}
					<button type="button" className="button button-primary" disabled={!ready} onClick={onNext}>
						Continue
					</button>
				</div>
			</div>
		</>
	);
}

/**
 * The agent a first item runs: Windlass on the ChatGPT sign-in (its default model needs it), else the first plan agent
 * something pays for on Hosted, else the defaults' (null).
 */
function firstAgent(inputs: ConnectionInputs): HarnessId | null {
	if (inputs.chatgpt) return "windlass";
	const paid = PAY_WITH_HARNESSES.find(harness => {
		const { state } = hostedCell(harness, inputs);
		return state === "plan" || state === "key";
	});
	return paid ?? null;
}

const OWN = -1;

function FirstItemStep({
	repository,
	inputs,
	onFiled,
}: {
	repository: PickedRepository;
	inputs: ConnectionInputs;
	onFiled(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [issues, setIssues] = useState<StarterIssue[] | null>(null);
	const [chosen, setChosen] = useState(0);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const asked = useRef<Submission | null>(null);
	useEffect(() => {
		let live = true;
		client
			.user(auth)
			.githubStarterIssues(repository.id)
			.then(
				found => live && setIssues(found),
				// Without them the generic tasks stand.
				() => live && setIssues([]),
			);
		return () => {
			live = false;
		};
	}, [client, auth, repository.id]);
	const tasks = starterTasks(issues ?? []);
	const agent = firstAgent(inputs);
	const own = chosen === OWN ? itemOf(text) : null;
	const task = own
		? { title: own.title, body: own.body || text.trim() }
		: chosen === OWN
			? null
			: (tasks[chosen] ?? null);
	const start = async () => {
		if (!task || busy) return;
		const input = {
			repository: { id: repository.id },
			title: task.title,
			body: task.body,
			// A starter task is small: one agent, no plan first.
			mode: "single" as const,
			start: true,
			...(agent && agent !== "windlass" && { harness: agent }),
		};
		asked.current = submissionOf(JSON.stringify(input), asked.current);
		setBusy(true);
		setError(null);
		try {
			const made = await client.user(auth).createItem({ ...input, idempotencyKey: asked.current.idempotencyKey });
			onFiled();
			navigate({ name: "item", id: made.id });
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};
	return (
		<>
			<p className="onboard-sub">
				A starter task for{" "}
				<span className="onboard-choice-mono">
					{repository.owner}/{repository.name}
				</span>
				, or your own words{agent ? `. ${HARNESS_NAMES[agent]} builds it` : ""}.
			</p>
			<div className="onboard-box">
				{issues === null ? (
					<p className="usage-empty" aria-busy="true">
						Looking for open bugs…
					</p>
				) : null}
				<div role="radiogroup" aria-label="Starter task" className="onboard-panel">
					{tasks.map((one, index) => (
						<button
							key={one.title}
							type="button"
							role="radio"
							aria-checked={chosen === index}
							className="onboard-choice"
							onClick={() => setChosen(index)}
						>
							{one.title}
							<small>{one.hint}</small>
						</button>
					))}
				</div>
				<textarea
					className="input"
					aria-label="Or say what it should do"
					placeholder="Or say what it should do…"
					value={text}
					onChange={event => {
						setText(event.target.value);
						setChosen(event.target.value.trim() ? OWN : 0);
					}}
				/>
				<Failure error={error} />
			</div>
			<div className="onboard-foot">
				<div className="onboard-foot-end">
					<button type="button" className="button button-primary" disabled={!task || busy} onClick={() => void start()}>
						{busy ? "Starting…" : "Start item"}
					</button>
				</div>
			</div>
		</>
	);
}
