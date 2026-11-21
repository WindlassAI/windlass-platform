/**
 * The start of an agent: a composer, not a form. Typing the task and pressing Enter launches it with
 * the choices already standing; each other choice is a chip under the composer that shows its value
 * and opens the same controls the launch form had: the repository (with its setup command and its
 * secrets), where it runs, the agent with its model and effort, its mode, and the sandbox. Home has it
 * at the top, and `/new` on a page of its own.
 *
 * What each chip starts on, field by field: the choice made here, then the chosen repository's saved
 * default, then the account's, then what the user's newest agent on that repository was launched with
 * (their newest of all where the repository has none, `lastUsed`), then the deployment's first. Only
 * the sandbox and the model have saved defaults. The repository itself starts on the page it was
 * opened from, else the newest agent's. A chip that differs from its saved default is drawn
 * emphasised, and its picker offers to go back to it; a saved default that cannot be used, a last
 * machine that cannot be used now, an open mode and an open sandbox fact are a warning dot on their
 * chip, said in its picker.
 *
 * No title is sent: the server names the agent from its first prompt, with saved secret values taken
 * out of it. The model goes with the agent, the effort with its first prompt. An agent of another harness (Claude Code) starts on its own default model,
 * for which no model is sent; where its machine's runner reported its models (`harnessOptions`), that default is named, "Opus (default)", and another may be chosen.
 *
 * Connecting GitHub is offered only in the repository's picker. It leaves the page, so the task and
 * every choice made here are kept (`LaunchDraft`) and put back on the way in, with the picker open.
 *
 * Narrow, the chips after the second fold behind "more" where that hides more than one, until a
 * picker is used; an open mode or sandbox fact never folds.
 *
 * Where the deployment offers work items and the page asks for it (`switchable`, the Factory page), a
 * switch before the chips turns it to filing one ("Work item"): the text's first line is the item's
 * title and the rest what to do (`itemOf`), a repository of the GitHub connection is required, and
 * the chips are the repository, where it runs and its acceptance criteria; an item keeps its profile's mode and runs Windlass. Enter files and starts it,
 * the line under it files a draft, and the page stays where it is: filing several in a row is the
 * factory's normal use. The repository starts on the page's, else the newest item's, else the newest
 * agent's.
 */
import { MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_PROMPT_CHARS, USAGE_LOW_SHARE, type CreateItemInput, type GithubId, type ItemSummary, type HarnessId, type MachineSummary, type RepositoryDefaults, type SandboxProfile, type SandboxProfileId, type SessionMode, type SessionSummary, type UsageNumbers } from "@contract";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { hasReason } from "../api/client";
import { isLimitRefusal } from "../api/errors";
import { HARNESS_NAMES } from "../lib/acp";
import { count, localTime, sandboxTime } from "../lib/format";
import { effortsOf, harnessOptions, modelLabel, modelName, modelsNote, saysDefault } from "../lib/models";
import { CLAUDE_DEFAULT_MODE, OPEN_MODES, launchModes } from "../lib/modes";
import { itemOf, lastUsed, layerChoices, repositoryName, startingChoices, startingModel, startingProfile } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { clockTime, useMachines } from "../screens/Machines";
import { useApp, useAuth } from "../state/app";
import { takeLaunchDraft, useGithub } from "../state/github";
import { handOver } from "../state/handover";
import { allowanceState, useAccount, useAllowance, useModels, useNow } from "../state/hooks";
import { ChevronIcon, SendIcon, WarnIcon } from "./Icons";
import { Layers, ProfileFacts, type ClaudeFacts } from "./Layers";
import { ModePicker } from "./Modes";
import { HARNESS_PROFILE, HarnessChoice, PlaceCards, machineUnusable, offeredHarnesses } from "./PlaceChoice";
import { RepositoryPicker, type PickedRepository } from "./RepositoryPicker";
import { SecretsField } from "./Secrets";
import { SetupField, useSetupDraft } from "./SetupCommand";
import { machineLabel } from "../lib/machines";

function ProfileCard({ profile, name, checked, claude = null, onChoose }: { profile: SandboxProfile; name: string; checked: boolean; claude?: ClaudeFacts | null; onChoose(id: SandboxProfileId): void }) {
	const id = useId();
	const reasonId = `${id}-reason`;
	return (
		<label className={`profile${checked ? " profile-chosen" : ""}${profile.available ? "" : " profile-unavailable"}`} htmlFor={id}>
			<input id={id} className="profile-radio" type="radio" name={name} value={profile.id} checked={checked} disabled={!profile.available} onChange={() => onChoose(profile.id)} aria-describedby={profile.available ? undefined : reasonId} />
			<span className="profile-head">
				<span className="profile-pick" aria-hidden="true" />
				<span className="profile-name">{profile.name}</span>
				{profile.available ? null : <span className="chip">not available</span>}
			</span>
			<span className="profile-summary">{profile.summary}</span>
			<Layers profile={profile} compact={!profile.available} />
			{profile.available ? (
				<ProfileFacts profile={profile} claude={claude} />
			) : (
				<span className="profile-reason" id={reasonId}>
					<strong>Why not yet.</strong> {profile.unavailableReason ?? "This deployment cannot run it."}
				</span>
			)}
		</label>
	);
}

/** Whether any of the chosen sandbox's three facts is open: said in the warning tone. */
function sandboxOpen(profile: SandboxProfile, claude: ClaudeFacts | null): boolean {
	if (claude) return true;
	return profile.approval === "full" || profile.commandNetwork || profile.commandsCanReadAccessToken;
}

/** The chosen sandbox in one line: its name and the three facts of `ProfileFacts`, each in a few words. What is open is said in the warning tone. */
function ChosenSandbox({ profile, claude = null }: { profile: SandboxProfile; claude?: ClaudeFacts | null }) {
	return (
		<span className="sandbox-chosen-text">
			<span className="sandbox-chosen-name">{profile.name}</span>
			<span className="sandbox-chosen-facts">
				{claude ? (
					<span className={OPEN_MODES.has(claude.mode.id) ? "fact-open" : undefined}>runs in {claude.mode.name} mode</span>
				) : (
					<span className={profile.approval === "full" ? "fact-open" : undefined}>{profile.approval === "auto" ? "runs what the sandbox contains, refuses the rest" : "runs every call without asking"}</span>
				)}
				<span className={profile.commandNetwork ? "fact-open" : undefined}>{profile.commandNetworkText ?? (profile.commandNetwork ? "commands can reach the network" : "commands have no network")}</span>
				{claude ? (
					<span className="fact-open">commands can read your Claude login token</span>
				) : (
					<span className={profile.commandsCanReadAccessToken ? "fact-open" : undefined}>{profile.commandsCanReadAccessToken ? "commands can read the session's access token" : "commands cannot read the session's access token"}</span>
				)}
			</span>
		</span>
	);
}

/** What launching runs into now, before anything is sent: `warn` when the agent could not start at all. */
function launchLimit(numbers: UsageNumbers | null): { text: string; warn: boolean } | null {
	if (numbers === null) return null;
	const left = allowanceState(numbers, USAGE_LOW_SHARE);
	const resets = localTime(numbers.resetsAt);
	if (left === "used") return { warn: true, text: `Today's sandbox time is used up. An agent launched now is created, and cannot start working before ${resets}, when the allowance is whole again.` };
	const { kept, limit } = numbers.sandboxes;
	if (limit !== null && kept >= limit) return { warn: true, text: `You keep ${limit} sandboxes, the most an account may have. An agent launched now is created, and cannot start working until you free a sandbox.` };
	if (left === "low" && numbers.leftSeconds !== null) return { warn: false, text: `${sandboxTime(numbers.leftSeconds)} of today's sandbox time is left. A turn that runs longer is stopped, with its files kept; the allowance is whole again at ${resets}.` };
	return null;
}

/** What is saved as the defaults of the repository that is chosen: read when the choice changes. `defaults` is null while it is read and when it could not be. */
function useDefaults(repositoryId: GithubId | null): { defaults: RepositoryDefaults | null; reading: boolean; error: string | null } {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ repositoryId: GithubId | null; defaults: RepositoryDefaults | null; error: string | null }>({ repositoryId: null, defaults: null, error: null });
	useEffect(() => {
		setState({ repositoryId, defaults: null, error: null });
		if (repositoryId === null) return;
		let current = true;
		client
			.user(auth)
			.repository(repositoryId)
			.then(
				(view) => current && setState({ repositoryId, defaults: view.defaults, error: null }),
				(failure: unknown) => current && setState({ repositoryId, defaults: null, error: explain(failure) }),
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, repositoryId]);
	// What was read for another repository is not this one's.
	const mine = state.repositoryId === repositoryId;
	return { defaults: mine ? state.defaults : null, reading: repositoryId !== null && (!mine || (state.defaults === null && state.error === null)), error: mine ? state.error : null };
}

/** Whether the screen is narrow enough for the chips to fold. */
function useNarrow(): boolean {
	const query = "(max-width: 600px)";
	const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const list = window.matchMedia(query);
		const onChange = () => setNarrow(list.matches);
		onChange();
		list.addEventListener("change", onChange);
		return () => list.removeEventListener("change", onChange);
	}, []);
	return narrow;
}

/** The pickers a chip opens. The mode's is its own (`ModePicker`). */
type Picker = "repo" | "place" | "agent" | "sandbox" | "criteria";

/**
 * One chip: a quiet label, its value, and the picker it opens under the row. `warn` puts the warning
 * dot on it; `changed` draws it emphasised, for a value that differs from its saved default.
 */
export function Chip({ label, value, open, warn = false, changed = false, busy = false, disabled = false, onToggle, onClose, children }: { label: string; value: ReactNode; open: boolean; warn?: boolean; changed?: boolean; busy?: boolean; disabled?: boolean; onToggle(): void; onClose(): void; children: ReactNode }) {
	const ids = { label: useId(), button: useId(), pop: useId() };
	const button = useRef<HTMLButtonElement>(null);
	const pop = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (open) pop.current?.focus({ preventScroll: true });
	}, [open]);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		// A dialog opened from the picker (the secrets') has its own Escape.
		if (event.key !== "Escape" || (event.target as Element).closest?.("dialog")) return;
		event.preventDefault();
		event.stopPropagation();
		onClose();
		button.current?.focus();
	};
	return (
		<div className={`start-chip${warn ? " start-chip-warn" : ""}${changed ? " start-chip-changed" : ""}`}>
			<span className="mini-select">
				<span id={ids.label}>{label}</span>
				<button ref={button} id={ids.button} type="button" className="mini-pick" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? ids.pop : undefined} aria-labelledby={`${ids.label} ${ids.button}`} aria-busy={busy} disabled={disabled} onClick={onToggle}>
					<span className="start-chip-value">{value}</span>
					{warn ? <span className="start-dot" aria-hidden="true" /> : null}
				</button>
			</span>
			{open ? (
				<div ref={pop} id={ids.pop} className="start-pop" role="dialog" aria-labelledby={ids.label} tabIndex={-1} onKeyDown={onKeyDown}>
					{children}
				</div>
			) : null}
		</div>
	);
}

/** "github.com/acme/web" for a pasted address: the chip's few words. */
const shortAddress = (url: string) => url.replace(/^https:\/\//, "").replace(/\.git$/, "");

export interface StartComposerProps {
	/** The user's sessions, live: what their newest agents were launched with. Null until they arrive. */
	sessions: readonly SessionSummary[] | null;
	/** GitHub's id of the repository to start on, when it was opened from that repository's page. */
	repositoryId?: GithubId;
	/** Puts the focus in the field when it is shown. */
	autoFocus?: boolean;
	/** What it starts on: an agent, or a work item to file. Work items need the deployment to offer them. */
	kind?: StartKind;
	/** Offers the switch between the two, where the deployment offers work items. */
	switchable?: boolean;
	/** The user's work items, live, where the page has them: a work item starts on the newest one's repository. Null until they arrive. */
	items?: readonly ItemSummary[] | null;
}

export type StartKind = "agent" | "item";

/** The refusals of a machine that the list of machines may be behind on: it is read again. */
const MACHINE_REFUSALS = ["machine_not_found", "machine_not_connected", "runner_outdated", "bad_profile"] as const;

export function StartComposer({ sessions, repositoryId, autoFocus = false, kind: startKind = "agent", switchable = false, items }: StartComposerProps) {
	const { client, platform, explain } = useApp();
	const auth = useAuth();
	const info = platform.info;
	const github = useGithub();
	const limit = launchLimit(useAllowance());
	const narrow = useNarrow();
	const ids = { text: useId(), hint: useId(), repo: useId(), repoLabel: useId(), repoNote: useId(), sandboxes: useId(), models: useId(), efforts: useId(), kind: useId(), criteria: useId(), criteriaNote: useId() };
	// What the composer held before its user left to connect GitHub, once.
	const [draft] = useState(takeLaunchDraft);

	const [prompt, setPrompt] = useState(draft?.prompt ?? "");
	// Agent or work item: the page's, unless its user switched before leaving for GitHub on a page that offers the switch. Without work items on this deployment, an agent.
	const [kindChoice, setKind] = useState<StartKind>((switchable ? draft?.kind : null) ?? startKind);
	const item = kindChoice === "item" && Boolean(info?.items);
	const [criteria, setCriteria] = useState(draft?.criteria ?? "");
	// The work item filed last from here, said under the field until another is written.
	const [filed, setFiled] = useState<{ id: string; title: string; started: boolean } | null>(null);
	// The user's own choices here: none until they make one, so that the defaults can stand in.
	const [repoChoice, setRepoChoice] = useState<{ kind: "github"; picked: PickedRepository } | { kind: "address" } | { kind: "none" } | null>(draft?.repoUrl ? { kind: "address" } : null);
	const [repoUrl, setRepoUrl] = useState(draft?.repoUrl ?? "");
	const [chosenSource, setChosenSource] = useState<"github" | "address" | null>(draft?.repoUrl ? "address" : null);
	const [profileChoice, setProfile] = useState<SandboxProfileId | null>((draft?.profile as SandboxProfileId | null | undefined) ?? null);
	const [modelChoice, setModel] = useState(draft?.model ?? "");
	const [effortChoice, setEffort] = useState(draft?.effort ?? "");
	// Where it runs: undefined until chosen; null is this platform.
	const [placeChoice, setPlace] = useState<string | null | undefined>(draft?.place === "platform" ? null : (draft?.place ?? undefined));
	const [harnessChoice, setHarness] = useState<HarnessId | null>(draft?.harness === "windlass" || draft?.harness === "claude" ? draft.harness : null);
	const [modeChoice, setMode] = useState<string | null>(draft?.mode ?? null);
	const [open, setOpen] = useState<Picker | null>(null);
	const [more, setMore] = useState(false);
	const [busy, setBusy] = useState<"creating" | "prompting" | "filing" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const chips = useRef<HTMLDivElement>(null);

	// Back from GitHub: the repository's picker is open, where its user left.
	const returned = github.notice?.where === "launch" || github.busy === "finishing";
	useEffect(() => {
		if (returned) setOpen("repo");
	}, [returned]);

	// A press outside the chips and their pickers closes the open one. A dialog opened from a picker is part of it.
	useEffect(() => {
		if (open === null) return;
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (!target || chips.current?.contains(target) || target.closest?.("dialog")) return;
			setOpen(null);
		};
		document.addEventListener("pointerdown", onPointer);
		return () => document.removeEventListener("pointerdown", onPointer);
	}, [open]);

	useEffect(() => {
		if (autoFocus) area.current?.focus();
	}, [autoFocus]);

	// Grows with the text, up to a limit; then it scrolls.
	useLayoutEffect(() => {
		const element = area.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
	}, [prompt]);

	// ---- the repository -----------------------------------------------------------------------
	const connection = github.enabled ? (github.status?.connection ?? null) : null;
	const connected = connection !== null;
	const knowsConnection = !github.enabled || github.status !== null || github.error !== null;
	const newest = lastUsed(sessions, null).repository;
	const newestItem = items?.reduce<ItemSummary | null>((found, candidate) => (found === null || candidate.createdAt > found.createdAt ? candidate : found), null) ?? null;
	// The repository it starts on: the page it was opened from, else, for a work item, the newest item's, else the one the newest agent was launched on.
	const startRepoId = repositoryId ?? (item && newestItem ? newestItem.repository.id : newest?.kind === "github" ? newest.repository.id : null);
	const [opening, setOpening] = useState<{ id: GithubId | null; picked: PickedRepository | null; reading: boolean; error: string | null }>({ id: null, picked: null, reading: false, error: null });
	useEffect(() => {
		if (startRepoId === null || !knowsConnection) {
			setOpening({ id: startRepoId, picked: null, reading: startRepoId !== null, error: null });
			return;
		}
		if (!connected) {
			setOpening({ id: startRepoId, picked: null, reading: false, error: repositoryId !== undefined && github.enabled ? "GitHub is not connected, so the repository this was opened for cannot be chosen." : null });
			return;
		}
		let current = true;
		setOpening({ id: startRepoId, picked: null, reading: true, error: null });
		client
			.user(auth)
			.githubRepository(startRepoId)
			.then(
				(repository) => current && setOpening({ id: startRepoId, picked: { repository, branch: repository.defaultBranch }, reading: false, error: null }),
				(failure: unknown) => current && setOpening({ id: startRepoId, picked: null, reading: false, error: explain(failure) }),
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, startRepoId, repositoryId, connected, knowsConnection, github.enabled]);
	const startPicked = opening.id === startRepoId ? opening.picked : null;
	const repo: { kind: "github"; picked: PickedRepository } | { kind: "address"; url: string } | { kind: "none" } = item
		? // A work item is on a repository of the GitHub connection: a pasted address or none is not one.
			repoChoice?.kind === "github"
			? repoChoice
			: startPicked
				? { kind: "github", picked: startPicked }
				: { kind: "none" }
		: repoChoice?.kind === "address"
			? { kind: "address", url: repoUrl.trim() }
			: (repoChoice ?? (startPicked ? { kind: "github", picked: startPicked } : repositoryId === undefined && newest?.kind === "address" ? { kind: "address", url: newest.url } : { kind: "none" }));
	// While the repository it starts on is asked of GitHub, nothing launches: it would go without it a moment too early.
	const repoReading = (repoChoice === null || (item && repoChoice.kind !== "github")) && startRepoId !== null && (opening.id !== startRepoId || opening.reading);
	const repoInvalid = repo.kind === "address" && repo.url !== "" && !/^https:\/\/[^\s/]+\/\S+$/.test(repo.url);
	const chosen = repo.kind === "github" ? repo.picked : null;
	const source = connection ? (item ? "github" : (chosenSource ?? (repo.kind === "address" ? "address" : "github"))) : "address";
	const notice = github.notice?.where === "launch" ? github.notice : null;

	// ---- the defaults, and what the user chose last ---------------------------------------------
	const last = lastUsed(sessions, chosen?.repository.id ?? null);
	const saved = useDefaults(chosen?.repository.id ?? null);
	const account = useAccount();
	const models = useModels();
	const repositoryDefaults = startingChoices(saved.defaults, info, models.list);
	const accountDefaults = startingChoices(account.settings?.defaults ?? null, info, models.list, "account");
	const defaults = layerChoices(repositoryDefaults, accountDefaults);
	const whose = (from: "repository" | "account" | null) => (from === "repository" && chosen ? `${repositoryName(chosen.repository)}'s` : "your account's");

	// ---- where it runs, and the agent ---------------------------------------------------------
	const machinesInfo = info?.machines ?? null;
	const machines = useMachines(machinesInfo !== null);
	const now = useNow(30_000);
	const mine = machinesInfo === null ? [] : (machines.list ?? []);
	const why = (machine: MachineSummary) => machineUnusable(machine, machinesInfo?.minRunnerVersion ?? "", item ? "item" : "agent");
	// A work item starts on this platform, as filing one always has; an agent where the last one ran.
	const lastMachineId = !item && last.place?.kind === "machine" ? last.place.machineId : null;
	const wantedMachine = placeChoice !== undefined ? placeChoice : lastMachineId;
	// A machine that was removed or can no longer be chosen leaves the agent on this platform, which its chip says.
	const chosenMachine = mine.find((machine) => machine.machineId === wantedMachine && why(machine) === null) ?? null;
	const machinesReading = machinesInfo !== null && machines.list === null && machines.error === null;
	const lastMachine = mine.find((machine) => machine.machineId === lastMachineId) ?? null;
	const placeProblem =
		wantedMachine === null || chosenMachine !== null || machinesReading
			? null
			: placeChoice !== undefined
				? `The machine chosen can no longer be used, so this ${item ? "work item" : "agent"} runs on this platform.`
				: lastMachine === null
					? "The machine your last agent ran on is not one of yours any more, so this one runs on this platform."
					: `Your last agent ran on “${machineLabel(lastMachine)}”, which cannot be used now, so this one runs on this platform. ${why(lastMachine) ?? ""}`.trim();
	const placeProfiles = chosenMachine ? chosenMachine.profiles : (info?.profiles ?? []);
	// Another harness runs in the hardened container only: without one that can be used it cannot be chosen, and a machine that does not offer it leaves Windlass.
	const hardened = placeProfiles.some((candidate) => candidate.id === HARNESS_PROFILE && candidate.available);
	const wantedHarness = harnessChoice ?? last.harness ?? "windlass";
	const harness: HarnessId = wantedHarness !== "windlass" && hardened && offeredHarnesses(chosenMachine).some((offered) => offered.id === wantedHarness) ? wantedHarness : "windlass";
	const other = harness === "windlass" ? null : HARNESS_NAMES[harness];
	const options = harnessOptions(chosenMachine, harness);
	const lastOf = last.of[harness] ?? null;

	// ---- the sandbox, the model and effort, the mode ------------------------------------------
	const profile = other ? HARNESS_PROFILE : startingProfile(profileChoice, defaults, info ? { profiles: placeProfiles } : null, last.of.windlass?.profile ?? null);
	const modelList = other ? options.models : models.list;
	const offers = (id: string) => modelList?.models.some((candidate) => candidate.id === id) === true;
	// Another harness's "" is its own default model, the one its runner reported as that: nothing is sent for it, so the adapter starts on its own.
	const reportedDefault = other && modelList !== null && modelList.models.length > 0 ? modelList.defaultModel : null;
	const harnessModel = (id: string) => (offers(id) ? (id === reportedDefault ? "" : id) : null);
	const model = other ? (harnessModel(modelChoice) ?? (lastOf ? harnessModel(lastOf.model) : null) ?? "") : startingModel(modelChoice, defaults, models.list, last.of.windlass?.model ?? null);
	const efforts = effortsOf(modelList, model === "" && reportedDefault !== null ? reportedDefault : model);
	const effort = efforts.includes(effortChoice) ? effortChoice : "";
	const chosenProfile = placeProfiles.find((candidate) => candidate.id === profile) ?? null;
	const launch = launchModes(harness, chosenProfile);
	// Claude Code's modes as its machine reported them, where it did.
	const modes = launch && other && options.modes ? { modes: options.modes, default: options.modes.some((mode) => mode.id === CLAUDE_DEFAULT_MODE) ? CLAUDE_DEFAULT_MODE : (options.modes[0] as SessionMode).id } : launch;
	const mode = modes ? (modes.modes.find((candidate) => candidate.id === modeChoice) ?? modes.modes.find((candidate) => candidate.id === lastOf?.mode) ?? modes.modes.find((candidate) => candidate.id === modes.default) ?? null) : null;
	const claude: ClaudeFacts | null = harness === "claude" && mode ? { mode } : null;
	const setup = useSetupDraft(chosen?.repository.id ?? null);

	// Saved defaults that differ from what is chosen, and those that cannot be used.
	const profileChanged = !other && defaults.profile !== null && profile !== defaults.profile;
	const modelChanged = !other && defaults.model !== null && model !== defaults.model;
	const ignored = {
		profile: repositoryDefaults.ignored.profile ?? (repositoryDefaults.profile === null ? accountDefaults.ignored.profile : null),
		model: repositoryDefaults.ignored.model ?? (repositoryDefaults.model === null ? accountDefaults.ignored.model : null),
	};
	const defaultsErrors = [chosen && saved.error ? `The defaults saved for ${repositoryName(chosen.repository)} could not be read: ${saved.error}` : null, account.settings === null && account.error ? `Your account's defaults could not be read: ${account.error}` : null].filter((line) => line !== null);

	// ---- launching ------------------------------------------------------------------------------
	const accountReading = account.reading && account.settings === null;
	// A work item waits for what its repository starts on, and where it runs; none of an agent's defaults.
	const reading = item
		? info === null || (items === null && repositoryId === undefined) || (sessions === null && repositoryId === undefined && newestItem === null) || repoReading || (machinesReading && wantedMachine !== null)
		: info === null || sessions === null || repoReading || saved.reading || accountReading || models.reading || (machinesReading && wantedMachine !== null);
	const canCreate = !item && !reading && profile !== null && !repoInvalid && busy === null;
	const task = prompt.trim();
	const maxChars = item ? MAX_ITEM_BODY_CHARS : MAX_PROMPT_CHARS;
	const tooLong = prompt.length > maxChars;
	const canLaunch = canCreate && task !== "" && !tooLong;

	// ---- the work item ----------------------------------------------------------------------------
	const filing = item ? itemOf(prompt) : null;
	const acceptance = criteria
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const criteriaWrong = acceptance.length > MAX_ACCEPTANCE_CRITERIA ? `At most ${MAX_ACCEPTANCE_CRITERIA}; there are ${acceptance.length}.` : acceptance.some((line) => line.length > MAX_NOTE_CHARS) ? `Each is at most ${count(MAX_NOTE_CHARS)} characters.` : null;
	const canFile = item && !reading && chosen !== null && filing !== null && !tooLong && criteriaWrong === null && busy === null;

	/** The agent that was asked for and not answered with, with its key: launching the same again is another attempt of it. */
	const asked = useRef<Submission | null>(null);

	/** Creates the agent, and sends it the task unless `send` is false: the task is then put in its composer, unsent. */
	const start = async (send: boolean) => {
		if (!canCreate || profile === null || tooLong) return;
		setOpen(null);
		setError(null);
		setBusy("creating");
		let sessionId: string;
		try {
			const repository = chosen ? { id: chosen.repository.id, branch: chosen.branch } : undefined;
			const input = {
				place: chosenMachine ? { kind: "machine" as const, machineId: chosenMachine.machineId } : undefined,
				...(other ? { harness } : {}),
				profile,
				mode: mode?.id,
				model: model || undefined,
				repoUrl: repo.kind === "address" && repo.url !== "" ? repo.url : undefined,
				repository,
				setupCommand: repository ? setup.toSave : undefined,
			};
			// One key for the agent: launching again after an answer that never came, with nothing changed, makes no second one.
			asked.current = submissionOf(JSON.stringify(input), asked.current);
			const session = await client.user(auth).createSession({ ...input, idempotencyKey: asked.current.idempotencyKey });
			sessionId = session.id;
		} catch (failure) {
			setError(explain(failure));
			setBusy(null);
			return;
		}
		if (task !== "" && !send) handOver(sessionId, { text: task, idempotencyKey: submissionOf(task, null).idempotencyKey });
		else if (task !== "") {
			setBusy("prompting");
			// And one for the prompt, which keeps it when it is handed over.
			const { idempotencyKey } = submissionOf(task, null);
			try {
				await client.session(auth, sessionId).prompt({ text: task, idempotencyKey, effort: effort || undefined });
			} catch (failure) {
				// The agent exists; its screen shows why the prompt was not accepted, with the text kept.
				handOver(sessionId, { text: task, error: explain(failure), limit: isLimitRefusal(failure), idempotencyKey });
			}
		}
		navigate({ name: "session", id: sessionId });
	};

	/** Files the work item, started at once unless `now` is false, and stays: the field is emptied for the next one. */
	const file = async (now: boolean) => {
		if (!canFile || !chosen || !filing) return;
		setOpen(null);
		setError(null);
		const input: Omit<CreateItemInput, "idempotencyKey"> = {
			repository: { id: chosen.repository.id, branch: chosen.branch },
			title: filing.title,
			body: filing.body,
			acceptance,
			start: now,
			...(chosenMachine ? { place: { kind: "machine" as const, machineId: chosenMachine.machineId } } : {}),
		};
		// Filing the same again after an answer that never came, with nothing changed, makes no second item.
		asked.current = submissionOf(JSON.stringify(input), asked.current);
		setBusy("filing");
		try {
			const made = await client.user(auth).createItem({ ...input, idempotencyKey: asked.current.idempotencyKey });
			asked.current = null;
			setPrompt("");
			setCriteria("");
			setFiled({ id: made.id, title: made.title, started: now });
		} catch (failure) {
			setError(explain(failure));
			if (MACHINE_REFUSALS.some((reason) => hasReason(failure, reason))) machines.reload();
		}
		setBusy(null);
		area.current?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
		event.preventDefault();
		if (item) void file(!event.altKey);
		else if (event.altKey) void start(false);
		else if (canLaunch) void start(true);
	};

	const toggle = (picker: Picker) => {
		// Once a picker is used, nothing folds: a choice made in one must not fold away the chip it is in.
		setMore(true);
		setOpen((now) => (now === picker ? null : picker));
	};
	const close = () => setOpen(null);

	if (!info && !platform.loading) {
		return (
			<div className="callout callout-bad start-failed" role="alert">
				<WarnIcon />
				<span>
					The sandboxes could not be loaded, so no agent can be launched: {platform.error ?? "the server did not answer."}{" "}
					<button type="button" className="link" onClick={platform.reload}>
						Try again
					</button>
				</span>
			</div>
		);
	}

	// ---- the chips --------------------------------------------------------------------------------
	const repoValue = repoReading ? "…" : repo.kind === "github" ? `${repositoryName(repo.picked.repository)} @ ${repo.picked.branch}` : repo.kind === "address" && repo.url !== "" ? shortAddress(repo.url) : item ? "choose one" : "none";
	const repoMissing = item && !repoReading && chosen === null;
	const repoChip = (
		<Chip key="repo" label="repo" value={repoValue} open={open === "repo"} busy={repoReading} warn={repoMissing || repoInvalid || (opening.error !== null && repositoryId !== undefined && repoChoice === null) || notice?.tone === "bad"} onToggle={() => toggle("repo")} onClose={close}>
			<div className="gh-field-head">
				<label className="label" id={ids.repoLabel} htmlFor={ids.repo}>
					{github.enabled ? "Repository" : "Git repository to clone"}
				</label>
				<span className="start-pop-links">
					{connection && !item ? (
						<button type="button" className="link gh-switch" onClick={() => setChosenSource(source === "github" ? "address" : "github")} disabled={busy !== null}>
							{source === "github" ? "Paste an address" : "Choose from GitHub"}
						</button>
					) : null}
					{repo.kind !== "none" && !item ? (
						<button
							type="button"
							className="link"
							onClick={() => {
								setRepoChoice({ kind: "none" });
								setRepoUrl("");
							}}
							disabled={busy !== null}
						>
							No repository
						</button>
					) : null}
				</span>
			</div>
			{source === "github" && connection ? (
				<RepositoryPicker
					value={chosen}
					onChange={(next) => {
						setRepoChoice(next ? { kind: "github", picked: next } : { kind: "none" });
						github.dismiss();
					}}
					accounts={connection.accounts}
					disabled={busy !== null}
					inputId={ids.repo}
					labelledBy={ids.repoLabel}
					describedBy={ids.repoNote}
				/>
			) : (
				<input
					id={ids.repo}
					className={`input input-mono${repoInvalid ? " input-invalid" : ""}`}
					type="url"
					inputMode="url"
					spellCheck={false}
					autoComplete="off"
					placeholder="https://github.com/you/project.git"
					value={repo.kind === "address" ? repo.url : ""}
					onChange={(event) => {
						setRepoUrl(event.target.value);
						setRepoChoice({ kind: "address" });
					}}
					onKeyDown={(event) => {
						// Enter in the address takes it; it does not launch.
						if (event.key === "Enter") {
							event.preventDefault();
							close();
						}
					}}
					aria-invalid={repoInvalid}
					aria-describedby={ids.repoNote}
				/>
			)}
			<p className={`field-note${repoInvalid || (chosen && !chosen.repository.canPush) ? " tone-warn" : ""}`} id={ids.repoNote}>
				{item
					? !github.enabled
						? "A work item is a pull request on a repository at GitHub, and this deployment has no GitHub App."
						: !connection
							? "A work item is a pull request on one of your repositories at GitHub."
							: chosen
								? chosen.repository.canPush
									? `The work comes back as a pull request into ${chosen.branch}.`
									: `You can read ${repositoryName(chosen.repository)} on GitHub but not push to it, so no pull request can be opened for the work.`
								: "A work item is a pull request on one of your repositories, private ones included."
					: source === "github" && connection
					? chosen
						? chosen.repository.canPush
							? `Cloned at ${chosen.branch} when the sandbox is created. The work can come back as a pull request.`
							: `You can read ${repositoryName(chosen.repository)} on GitHub but not push to it: the agent can work on it, and no pull request can be opened.`
						: notice?.tone === "good"
							? `${notice.text} Choose a repository, or leave this empty to start in an empty one.`
							: "One of your repositories at GitHub, private ones included. Without one the agent starts in an empty repository."
					: repoInvalid
						? "Use the repository's https address, for example https://github.com/you/project.git."
						: "Cloned into the workspace when the sandbox is created. Without one the agent starts in an empty repository."}
			</p>
			{opening.error !== null && repoChoice === null ? (
				<p className="field-note tone-warn" role="status">
					{repositoryId !== undefined ? opening.error : `The repository your newest ${item && newestItem ? "work item is on" : "agent was launched on"} could not be read: ${opening.error}`} {item ? "Choose another repository." : "Choose another repository, or launch without one."}
				</p>
			) : null}
			{github.enabled && !connection ? (
				<p className={`field-note gh-connect-line${notice?.tone === "bad" || github.error ? " tone-bad" : ""}`} role={notice?.tone === "bad" ? "alert" : undefined}>
					{github.busy === "finishing" ? (
						"Finishing the GitHub connection…"
					) : github.busy === "leaving" ? (
						"Going to GitHub…"
					) : github.status === null && !github.error ? (
						"Checking the GitHub connection…"
					) : (
						<>
							{notice?.tone === "bad" ? `${notice.text} ` : github.error ? `${github.error} ` : null}
							<button type="button" className="link" onClick={() => github.connect({ where: "launch", draft: { prompt, repoUrl, profile: profileChoice, model: modelChoice, effort: effortChoice, place: placeChoice === undefined ? null : (placeChoice ?? "platform"), harness: harnessChoice, mode: modeChoice, kind: kindChoice, criteria } })} disabled={busy !== null}>
								Connect GitHub
							</button>{" "}
							to choose one of your own repositories, private ones included, and get the work back as a pull request. What you wrote here is kept.
						</>
					)}
				</p>
			) : null}
			{chosen && !item ? <SetupField setup={setup} repository={repositoryName(chosen.repository)} disabled={busy !== null} /> : null}
			{chosen && !other && !item ? <SecretsField repositoryId={chosen.repository.id} repository={repositoryName(chosen.repository)} profile={profile} disabled={busy !== null} /> : null}
			{chosen && item && saved.defaults ? (
				<p className="field-note start-shots">
					{saved.defaults.screenshots ? "Its agents take screenshots of the app for their reports" : "Screenshots are off for this repository"}:{" "}
					<a className="link" {...linkProps({ name: "repository", id: chosen.repository.id, view: "settings", section: "screenshots" })}>
						{saved.defaults.screenshots ? "change it" : "turn them on"}
					</a>
					.
				</p>
			) : null}
		</Chip>
	);

	const placeChip =
		mine.length > 0 ? (
			<Chip
				key="place"
				label="on"
				value={
					chosenMachine ? (
						<>
							{machineLabel(chosenMachine)} <span className={`machine-state machine-state-${chosenMachine.status}`} aria-label={chosenMachine.status}>
								<span className="sandbox-state-dot" aria-hidden="true" />
							</span>
						</>
					) : (
						"this platform"
					)
				}
				open={open === "place"}
				warn={placeProblem !== null || chosenMachine?.status === "offline"}
				onToggle={() => toggle("place")}
				onClose={close}
			>
				<span className="label">Where it runs</span>
				<p className="section-text">Where the agent's sandbox is made: by this platform, or by the runner on one of your machines.</p>
				{placeProblem ? <p className="field-note tone-warn">{placeProblem}</p> : null}
				<PlaceCards
					machines={mine}
					chosen={chosenMachine}
					minRunnerVersion={machinesInfo?.minRunnerVersion ?? ""}
					now={now}
					purpose={item ? "item" : "agent"}
					onChoose={(machineId) => {
						setPlace(machineId);
						close();
					}}
				/>
				{item && chosenMachine ? (
					<p className="field-note place-note">
						It runs without asking on “{machineLabel(chosenMachine)}”, inside its container, and costs no hosted time.{" "}
						{chosenMachine.status === "online" ? "If the machine is away, the item waits until it is back." : `“${machineLabel(chosenMachine)}” is offline since ${clockTime(chosenMachine.since, now)}, so the item waits until it is back.`}
						{chosenMachine.profiles.find((candidate) => candidate.available)?.id === HARNESS_PROFILE ? " This machine cannot sandbox each command, so the agent's commands can reach the machine's network and its access token." : ""}
					</p>
				) : null}
			</Chip>
		) : null;

	const criteriaChip = (
		<Chip key="criteria" label="criteria" value={acceptance.length === 0 ? "none" : count(acceptance.length)} open={open === "criteria"} warn={criteriaWrong !== null} onToggle={() => toggle("criteria")} onClose={close}>
			<label className="label" htmlFor={ids.criteria}>
				Acceptance criteria<span className="label-optional">optional</span>
			</label>
			<textarea id={ids.criteria} className={`input textarea item-criteria${criteriaWrong ? " input-invalid" : ""}`} value={criteria} onChange={(event) => setCriteria(event.target.value)} readOnly={busy !== null} aria-describedby={ids.criteriaNote} aria-invalid={criteriaWrong !== null || undefined} />
			<p className={`field-note${criteriaWrong ? " tone-bad" : ""}`} id={ids.criteriaNote}>
				{criteriaWrong ?? "One per line. The agent is given them, and the verdict lists them for you to check: no machine checks them."}
			</p>
		</Chip>
	);

	// Agent or work item: the first of the row, where the deployment offers work items.
	const kindSwitch =
		switchable && info?.items ? (
			<div key="kind" className="segmented start-kind" role="radiogroup" aria-label="What to start">
				{(["agent", "item"] as const).map((option) => (
					<label key={option} className={`segment${kindChoice === option ? " segment-chosen" : ""}`}>
						<input
							className="segment-radio"
							type="radio"
							name={ids.kind}
							value={option}
							checked={kindChoice === option}
							disabled={busy !== null}
							onChange={() => {
								setKind(option);
								setOpen(null);
								setError(null);
								setFiled(null);
							}}
						/>
						{option === "agent" ? "Agent" : "Work item"}
					</label>
				))}
			</div>
		) : null;

	const agentModel = !other ? model || "default model" : model !== "" ? modelName(modelList, model) : reportedDefault !== null && modelList ? modelLabel(modelList, reportedDefault) : "default model";
	const agentValue = `${HARNESS_NAMES[harness]} · ${agentModel}${effort ? ` · ${effort}` : ""}`;
	const agentChip = (
		<Chip key="agent" label="agent" value={agentValue} open={open === "agent"} changed={modelChanged} warn={!other && ignored.model !== null} onToggle={() => toggle("agent")} onClose={close}>
			{chosenMachine && offeredHarnesses(chosenMachine).length > 0 ? (
				<HarnessChoice machine={chosenMachine} chosen={harness} hardened={hardened} disabled={busy !== null} onChoose={setHarness} />
			) : (
				<div className="harness-pick">
					<span className="label">Agent</span>
					<p className="field-fixed">Windlass</p>
					{mine.some((machine) => offeredHarnesses(machine).length > 0) ? <p className="field-note">Claude Code is offered on a machine whose runner reports it: choose that machine under “on” first.</p> : null}
				</div>
			)}
			<div className="start-pop-section">
				<span className="label" id={ids.models}>
					Model
				</span>
				{modelList === null || (other && modelList.models.length === 0) ? (
					<>
						<p className="field-fixed">{other ? `${other}'s default model` : model || "Your default model"}</p>
						<p className="field-note" aria-busy={models.reading}>
							{other ? `“${chosenMachine ? machineLabel(chosenMachine) : "The machine"}”'s runner reports ${other}'s models once it has checked.` : models.reading ? "Reading your models…" : `${models.error ?? "Your models could not be read."} The agent starts on your default model.`}
						</p>
					</>
				) : (
					<>
						<div className="start-options" role="radiogroup" aria-labelledby={ids.models}>
							{modelList.models.map(({ id }) => {
								const isDefault = id === modelList.defaultModel;
								// Another harness's reported default is its "": chosen, nothing is sent.
								const checked = other && model === "" ? isDefault : model === id;
								const name = other ? modelName(modelList, id) : id;
								return (
									<label key={id} className={`mode-option start-option${checked ? " start-option-chosen" : ""}`}>
										<input className="segment-radio" type="radio" name={ids.models} value={id} checked={checked} onChange={() => setModel(id)} disabled={busy !== null} />
										<span className="mode-option-name">
											{name}
											{isDefault && !saysDefault(name) ? <span className="mode-option-text"> default</span> : null}
										</span>
									</label>
								);
							})}
						</div>
						<p className="field-note">{other ? `The models “${chosenMachine ? machineLabel(chosenMachine) : ""}”'s runner reported for ${other}.` : modelsNote(modelList)}</p>
					</>
				)}
				{ignored.model && !other ? <p className="field-note tone-warn">{ignored.model}</p> : null}
			</div>
			{efforts.length > 0 ? (
				<div className="start-pop-section">
					<span className="label" id={ids.efforts}>
						Effort
					</span>
					<div className="segmented" role="radiogroup" aria-labelledby={ids.efforts}>
						{["", ...efforts].map((name) => (
							<label key={name || "default"} className={`segment${effort === name ? " segment-chosen" : ""}`}>
								<input className="segment-radio" type="radio" name={ids.efforts} value={name} checked={effort === name} onChange={() => setEffort(name)} disabled={busy !== null} />
								{name || "default"}
							</label>
						))}
					</div>
				</div>
			) : null}
			{modelChanged ? (
				<button type="button" className="link start-back" onClick={() => setModel("")}>
					Back to the default ({whose(defaults.from.model)}: {defaults.model})
				</button>
			) : null}
		</Chip>
	);

	const modeOpen = mode !== null && OPEN_MODES.has(mode.id);
	const modeChip =
		modes && mode ? (
			<div
				key="mode"
				className={`start-chip-mode${modeOpen ? " start-chip-warn" : ""}`}
				onPointerDownCapture={() => {
					setMore(true);
					close();
				}}
			>
				{/* Opened from the keyboard too, it closes the chip's picker: one list is open at a time. */}
				<ModePicker modes={modes.modes} current={mode.id} disabled={busy !== null} onChoose={setMode} onOpen={close} />
			</div>
		) : null;

	const available = placeProfiles.filter((candidate) => candidate.available && (!other || candidate.id === HARNESS_PROFILE));
	const unavailable = other ? [] : placeProfiles.filter((candidate) => !candidate.available);
	const sandboxWarn = (chosenProfile !== null && sandboxOpen(chosenProfile, claude)) || (!other && ignored.profile !== null) || defaultsErrors.length > 0 || available.length === 0;
	const sandboxChip = (
		<Chip key="sandbox" label="sandbox" value={chosenProfile?.name ?? "none"} open={open === "sandbox"} changed={profileChanged} warn={sandboxWarn} onToggle={() => toggle("sandbox")} onClose={close}>
			<span className="label">Sandbox</span>
			{available.length === 0 ? <p className="field-note tone-warn">{chosenMachine ? `“${machineLabel(chosenMachine)}” has no sandbox that can be used right now.` : "This deployment has no sandbox that can be used right now."}</p> : null}
			{chosenProfile ? (
				<div className="sandbox-chosen">
					<ChosenSandbox profile={chosenProfile} claude={claude} />
				</div>
			) : null}
			<p className="section-text">Where the agent's files live and its commands run. The boxes show what isolates it, outermost first.{other ? ` ${other} runs in this one only.` : ""}</p>
			<div className="profiles" id={ids.sandboxes}>
				{available.map((candidate) => (
					<ProfileCard
						key={candidate.id}
						profile={candidate}
						name={ids.sandboxes}
						checked={profile === candidate.id}
						claude={claude}
						onChoose={(id) => {
							setProfile(id);
							close();
						}}
					/>
				))}
			</div>
			{unavailable.length > 0 ? (
				<>
					<p className="profiles-divider">{chosenMachine ? `Listed, but not usable on “${machineLabel(chosenMachine)}”` : "Listed, but not usable on this deployment"}</p>
					<div className="profiles profiles-unavailable">
						{unavailable.map((candidate) => (
							<ProfileCard key={candidate.id} profile={candidate} name={ids.sandboxes} checked={false} onChoose={setProfile} />
						))}
					</div>
				</>
			) : null}
			{!other && ignored.profile ? <p className="field-note tone-warn">{ignored.profile}</p> : null}
			{defaultsErrors.map((line) => (
				<p key={line} className="field-note tone-warn">
					{line}
				</p>
			))}
			{profileChanged ? (
				<button type="button" className="link start-back" onClick={() => setProfile(null)}>
					Back to the default ({whose(defaults.from.profile)}: {info?.profiles.find((candidate) => candidate.id === defaults.profile)?.name ?? defaults.profile})
				</button>
			) : null}
		</Chip>
	);

	// Narrow, the chips after the second fold behind "more"; one that warns of something open stays. A work item has too few to fold.
	const all: Array<{ chip: ReactNode; keep: boolean }> = item
		? [{ chip: repoChip, keep: true }, ...(placeChip ? [{ chip: placeChip, keep: true }] : []), { chip: criteriaChip, keep: true }]
		: [
				{ chip: repoChip, keep: true },
				...(placeChip ? [{ chip: placeChip, keep: true }] : []),
				{ chip: agentChip, keep: !placeChip },
				...(modeChip ? [{ chip: modeChip, keep: modeOpen }] : []),
				{ chip: sandboxChip, keep: sandboxWarn && chosenProfile !== null && sandboxOpen(chosenProfile, claude) },
			];
	// A fold that would hide one chip is not worth its own.
	const folds = narrow && !more && all.filter((entry) => !entry.keep).length > 1;
	const folded = folds ? all.filter((entry) => !entry.keep) : [];
	const shown = folds ? all.filter((entry) => entry.keep) : all;

	const reason = item
		? info === null
			? "Asking the server what it offers…"
			: busy === "filing"
				? "Filing the work item…"
				: reading
					? "Reading your repositories…"
					: repoMissing
						? "A work item needs a repository: choose one under “repo”."
						: null
		: info === null
			? "Asking the server which sandboxes it has…"
			: sessions === null
				? "Reading your agents…"
				: reading
					? "Reading your defaults…"
					: busy === "creating"
						? "Creating the agent…"
						: busy === "prompting"
							? "Sending the task…"
							: null;
	const secondary = item ? "File as a draft" : task === "" ? "Create without a prompt" : "Create without sending it";

	return (
		<form
			className={`composer start${busy ? " composer-busy" : ""}`}
			onSubmit={(event) => {
				event.preventDefault();
				if (item) void file(true);
				else if (canLaunch) void start(true);
			}}
		>
			{error ? (
				<p className="composer-error" role="alert">
					<WarnIcon size={14} />
					<span>{error}</span>
				</p>
			) : limit && chosenMachine === null && !item ? (
				<p className={`composer-error composer-allowance${limit.warn ? "" : " start-allowance-low"}`} role="status">
					<WarnIcon size={14} />
					<span>
						{limit.text}{" "}
						<a className="link" {...linkProps({ name: "usage" })}>
							Usage
						</a>
					</span>
				</p>
			) : null}
			<div className="composer-box">
				<label className="composer-caret" htmlFor={ids.text}>
					<ChevronIcon size={16} />
					<span className="visually-hidden">{item ? "What the work item asks for: its first line is the title" : "What the agent should do"}</span>
				</label>
				<textarea
					ref={area}
					id={ids.text}
					className="composer-text"
					rows={1}
					value={prompt}
					placeholder={item ? "What should be done?" : "What should it do?"}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onKeyDown}
					disabled={busy !== null}
					aria-describedby={ids.hint}
					enterKeyHint="send"
				/>
				<button type="submit" className="button button-primary composer-action" disabled={item ? !canFile : !canLaunch}>
					<SendIcon size={15} />
					<span>{busy === "creating" ? "Creating" : busy === "prompting" ? "Sending" : busy === "filing" ? "Filing" : item ? "File" : "Launch"}</span>
				</button>
			</div>
			<div className="start-chips composer-selects" ref={chips}>
				{kindSwitch}
				{shown.map((entry) => entry.chip)}
				{folded.length > 0 ? (
					<span className="mini-select">
						<button type="button" className="mini-pick start-more" onClick={() => setMore(true)}>
							⋯ {folded.length} more
						</button>
					</span>
				) : null}
			</div>
			{filing ? (
				<p className="composer-hint start-line start-title">
					Title: <span className="start-title-text">{filing.title}</span>
				</p>
			) : null}
			{filed && !filing ? (
				<p className="field-note start-line start-filed" role="status">
					Filed “{filed.title}”{filed.started ? "" : " as a draft"}.{" "}
					<a className="link" {...linkProps({ name: "item", id: filed.id })}>
						Open
					</a>
				</p>
			) : null}
			{chosenMachine?.status === "offline" && !item ? (
				<p className="field-note tone-warn start-line" role="status">
					“{machineLabel(chosenMachine)}” is offline since {clockTime(chosenMachine.since, now)}. The agent is created now, and a prompt sent before the machine is back fails. {task === "" ? "Write to it once the machine is online." : "Create it without sending the task, and the task waits in its composer."}
				</p>
			) : null}
			<div className="start-foot">
				<p className={`composer-hint${reason ? " composer-reason" : ""}${tooLong ? " tone-bad" : ""}`} id={ids.hint} role={reason ? "status" : undefined}>
					{tooLong ? (
						`${count(prompt.length - maxChars)} characters over the limit of ${count(maxChars)}`
					) : (
						(reason ?? (
							<>
								<kbd>Enter</kbd> {item ? "file and start" : "launch"} <span aria-hidden="true">·</span> <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
							</>
						))
					)}
				</p>
				<button type="button" className="link start-secondary" onClick={() => void (item ? file(false) : start(false))} disabled={item ? !canFile : !canCreate || tooLong}>
					{secondary}
				</button>
			</div>
		</form>
	);
}
