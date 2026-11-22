/**
 * The start of an agent: a composer, not a form. Typing the task and pressing Enter launches it with
 * the choices already standing. The choices are a toolbar of pills inside the composer's box: the
 * agent and its model (effort in a submenu), where it runs (hosted or one of the user's machines,
 * each with its sandboxes in a submenu), the repository at a branch (filtered as you type, branches in
 * a submenu), and the mode; "+" holds the repository's setup command and secrets. Launch is a split
 * button whose menu creates the agent without sending the task. Under the box, one line says what
 * the chosen sandbox lets the agent's commands do and where it runs. On a phone the pills fold into
 * one summary row that opens a "Launch settings" sheet, each setting's list pushed into it. Home has
 * it at the top, and `/new` on a page of its own.
 *
 * What each choice starts on, field by field: the choice made here, then the chosen repository's saved
 * default, then the account's, then what the user's newest agent on that repository was launched with
 * (their newest of all where the repository has none, `lastUsed`), then the deployment's first. Only
 * the sandbox and the model have saved defaults. Where it runs, the agent and its mode start where the
 * user's last agent started, whatever the repository (`startedOn`): the server remembers that start
 * (`AccountSettings.lastStart`), so it holds in any browser and after that agent is deleted. The repository itself starts on the page it was
 * opened from, else the newest agent's. A pill that differs from its saved default is drawn in the
 * accent, and its picker offers to go back to it; a saved default that cannot be used, a last
 * machine that cannot be used now, an open mode and an open sandbox fact are a warning dot on their
 * pill, said in its picker.
 *
 * No title is sent: the server names the agent from its first prompt, with saved secret values taken
 * out of it. The model goes with the agent, the effort with its first prompt. An agent of another harness (Claude Code) starts on its own default model,
 * for which no model is sent; where its machine's runner reported its models (`harnessOptions`), that default is named, "Opus (default)", and another may be chosen.
 *
 * Connecting GitHub is offered only in the repository's picker. It leaves the page, so the task and
 * every choice made here are kept (`LaunchDraft`) and put back on the way in, with the picker open.
 *
 * Where the deployment offers work items and the page asks for it (`switchable`, the Factory page), a
 * switch turns it to filing one ("Work item"): the text's first line is the item's title and the rest
 * what to do (`itemOf`), a repository of the GitHub connection is required, and the pills are the
 * repository, where it runs, its agent and model and its acceptance criteria. An item runs Windlass in its profile's mode unless an agent
 * its machine is signed into is chosen (`itemHarnesses`), which runs Quick and without asking. Its effort, one its agent offers for the model, runs every turn of the item. Enter files and starts it,
 * the launch menu files a draft, and the page stays where it is: filing several in a row is the
 * factory's normal use. The repository starts on the page's, else the newest item's, else the newest
 * agent's.
 */
import { MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_PROMPT_CHARS, USAGE_LOW_SHARE, type CreateItemInput, type GithubId, type ItemMode, type ItemSummary, type HarnessId, type HarnessOptions, type MachineSummary, type RepositoryDefaults, type SandboxProfile, type SandboxProfileId, type SessionMode, type SessionSummary, type UsageNumbers } from "@contract";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { hasReason } from "../api/client";
import { isLimitRefusal } from "../api/errors";
import { HARNESS_NAMES, signInWords } from "../lib/acp";
import { count, localTime, sandboxTime } from "../lib/format";
import { effortChoices, effortsOf, harnessOptions, modelLabel, modelName, modelsNote, saysDefault } from "../lib/models";
import { OPEN_MODES, launchModes } from "../lib/modes";
import { itemOf, lastUsed, layerChoices, repositoryName, startedOn, startingChoices, startingModel, startingProfile } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { clockTime, useMachines } from "../screens/Machines";
import { useApp, useAuth } from "../state/app";
import { takeLaunchDraft, useGithub } from "../state/github";
import { handOver } from "../state/handover";
import { allowanceState, useAccount, useAllowance, useModels, useNow } from "../state/hooks";
import { ArrowUpIcon, BranchIcon, CloudIcon, MachineIcon, PlusIcon, RepoIcon, SendIcon, SlidersIcon, WarnIcon } from "./Icons";
import { accessTokenFact, claudeLoginFact, commandNetworkFact, type ClaudeFacts } from "./Layers";
import { ModePicker, modeMenu } from "./Modes";
import { HARNESS_PROFILE, itemHarnesses, machineUnusable, offeredHarnesses } from "./PlaceChoice";
import { repositoryMenu, useBranches, useRepositorySearch, type PickedRepository } from "./RepositoryMenu";
import { SecretsField } from "./Secrets";
import { SetupField, useSetupDraft } from "./SetupCommand";
import { HarnessStatus } from "./HarnessStatus";
import { KeyHints, Kbd } from "./ui/Kbd";
import { Menu, MenuSheet, PickerPanel, type MenuGroup, type MenuItem, type MenuSpec, type TriggerProps } from "./ui/Menu";
import { AgentGlyph, Pill } from "./ui/Pill";
import { SplitButton } from "./ui/Button";
import { Tooltip } from "./ui/Tooltip";
import { useSurface } from "./ui/useMediaQuery";
import { hardenedItemNote, machineLabel } from "../lib/machines";
import { ItemModePicker, ItemModeCost } from "./ItemModePicker";
import { orchestrateProblem } from "../lib/feature";

/** Whether any of the chosen sandbox's three facts is open: said in the warning tone. */
function sandboxOpen(profile: SandboxProfile, claude: ClaudeFacts | null): boolean {
	if (claude) return true;
	return profile.approval === "full" || profile.commandNetwork || profile.commandsCanReadAccessToken;
}

interface Fact {
	/** A few words: "network on". */
	text: string;
	/** The sentence it stands for, for a tooltip and assistive technology. */
	long: string;
	/** Something the sandbox leaves open: said in the warning tone. */
	open: boolean;
}

/** A sandbox's three facts (components/Layers.tsx, `ProfileFacts`) in a few words each. For Claude Code the approval is its mode, and its commands can use its login. */
export function sandboxFacts(profile: SandboxProfile, claude: ClaudeFacts | null = null): Fact[] {
	return [
		claude
			? { text: `${claude.mode.name} mode`, long: `runs in ${claude.mode.name} mode`, open: OPEN_MODES.has(claude.mode.id) }
			: profile.approval === "auto"
				? { text: "commands sandboxed", long: "runs what the sandbox contains, refuses the rest", open: false }
				: { text: "runs every call", long: "runs every call without asking", open: true },
		claude && (claude.opencode || profile.claudeRelay) && !profile.commandNetwork && profile.available
			? { text: claude.opencode ? "OpenCode relay" : "Claude relay only", long: commandNetworkFact(profile, claude), open: false }
			: { text: profile.commandNetwork ? "network on" : "no network", long: commandNetworkFact(profile, claude), open: profile.commandNetwork },
		claude?.opencode
			? { text: "credentials on machine", long: "Commands can use the OpenCode model relay. Provider credentials stay on the machine.", open: true }
			: claude
			? { text: profile.claudeRelay ? "Claude login via relay" : "Claude login readable", long: `commands can use your Claude login. ${claudeLoginFact(profile)}`, open: true }
			: profile.commandsCanReadAccessToken
				? { text: "token readable", long: accessTokenFact(profile), open: true }
				: { text: "token hidden from commands", long: accessTokenFact(profile), open: false },
	];
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
function useDefaults(repositoryId: GithubId | null): { defaults: RepositoryDefaults | null; checks: number | null; reading: boolean; error: string | null } {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [state, setState] = useState<{ repositoryId: GithubId | null; defaults: RepositoryDefaults | null; checks: number | null; error: string | null }>({ repositoryId: null, defaults: null, checks: null, error: null });
	useEffect(() => {
		setState({ repositoryId, defaults: null, checks: null, error: null });
		if (repositoryId === null) return;
		let current = true;
		client
			.user(auth)
			.repository(repositoryId)
			.then(
				(view) => current && setState({ repositoryId, defaults: view.defaults, checks: view.saved.checks, error: null }),
				(failure: unknown) => current && setState({ repositoryId, defaults: null, checks: null, error: explain(failure) }),
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, repositoryId]);
	// What was read for another repository is not this one's.
	const mine = state.repositoryId === repositoryId;
	return { defaults: mine ? state.defaults : null, checks: mine ? state.checks : null, reading: repositoryId !== null && (!mine || (state.defaults === null && state.error === null)), error: mine ? state.error : null };
}

/** Fetch the chosen machine's catalog once per digest, even as its host samples change. */
export function useCatalog(machine: MachineSummary | null, id: "claude" | "opencode") {
	const { client, explain } = useApp();
	const auth = useAuth();
	const machineId = machine?.machineId;
	const digest = machine?.harnesses?.find(entry => entry.id === id)?.optionsDigest;
	const [result, setResult] = useState<{ machineId: string; digest: string; options?: HarnessOptions; error?: string }>();
	const [retry, setRetry] = useState(0);
	useEffect(() => {
		if (!machineId || !digest) return;
		let current = true;
		client.user(auth).machineCatalog({ machineId, id, digest }).then(
			options => current && setResult({ machineId, digest, options: options ?? undefined }),
			error => current && setResult({ machineId, digest, error: explain(error) }),
		);
		return () => { current = false; };
	}, [client, auth, machineId, id, digest, explain, retry]);
	const match = result?.machineId === machineId && result?.digest === digest ? result : undefined;
	return { options: match?.options, reading: !!digest && !match, error: match?.error, retry: () => { setResult(undefined); setRetry(n => n + 1); } };
}

/** The pickers the composer opens: one at a time. The phone's settings sheet is one of them. */
type Picker = "repo" | "where" | "agent" | "mode" | "criteria" | "plus" | "settings";

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
	const surface = useSurface();
	const phone = surface === "sheet";
	const ids = { text: useId(), hint: useId(), keys: useId(), repo: useId(), repoLabel: useId(), repoNote: useId(), sandboxes: useId(), models: useId(), efforts: useId(), kind: useId(), criteria: useId(), criteriaNote: useId() };
	// What the composer held before its user left to connect GitHub, once.
	const [draft] = useState(takeLaunchDraft);

	const [prompt, setPrompt] = useState(draft?.prompt ?? "");
	// Agent or work item: the page's, unless its user switched before leaving for GitHub on a page that offers the switch. Without work items on this deployment, an agent.
	const [kindChoice, setKind] = useState<StartKind>((switchable ? draft?.kind : null) ?? startKind);
	const item = kindChoice === "item" && Boolean(info?.items);
	const [itemMode, setItemMode] = useState<ItemMode>(draft?.itemMode ?? "orchestrate");
	const [criteria, setCriteria] = useState(draft?.criteria ?? "");
	// The work item filed last from here, said under the field until another is written.
	const [filed, setFiled] = useState<{ id: string; title: string; started: boolean; feature: boolean } | null>(null);
	// The user's own choices here: none until they make one, so that the defaults can stand in.
	const [repoChoice, setRepoChoice] = useState<{ kind: "github"; picked: PickedRepository } | { kind: "address" } | { kind: "none" } | null>(draft?.repoUrl ? { kind: "address" } : null);
	const [repoUrl, setRepoUrl] = useState(draft?.repoUrl ?? "");
	const [chosenSource, setChosenSource] = useState<"github" | "address" | null>(draft?.repoUrl ? "address" : null);
	const [profileChoice, setProfile] = useState<SandboxProfileId | null>((draft?.profile as SandboxProfileId | null | undefined) ?? null);
	const [modelChoice, setModel] = useState(draft?.model ?? "");
	const [effortChoice, setEffort] = useState(draft?.effort ?? "");
	// Where it runs: undefined until chosen; null is this platform.
	const [placeChoice, setPlace] = useState<string | null | undefined>(draft?.place === "platform" ? null : (draft?.place ?? undefined));
	const [harnessChoice, setHarness] = useState<HarnessId | null>(draft?.harness === "windlass" || draft?.harness === "claude" || draft?.harness === "opencode" ? draft.harness : null);
	const [modeChoice, setMode] = useState<string | null>(draft?.mode ?? null);
	const [open, setOpen] = useState<Picker | null>(null);
	const [busy, setBusy] = useState<"creating" | "prompting" | "filing" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const anchors = { repo: useRef<HTMLButtonElement>(null), plus: useRef<HTMLButtonElement>(null), criteria: useRef<HTMLButtonElement>(null), settings: useRef<HTMLButtonElement>(null) };
	const search = useRepositorySearch(open === "repo" || open === "settings", github.status?.connection?.connectedAt ?? null);
	const branches = useBranches();

	// Back from GitHub: the repository's picker is open, where its user left. Connected from the popup, it
	// opens again once the connection is there: its address form gives way to the list, and closes as it goes.
	const returned = github.notice?.where === "launch" || github.busy === "finishing";
	const nowConnected = github.status?.connection != null;
	useEffect(() => {
		if (!returned) return;
		// After the swap has settled: the address form's focus going back to the pill closes the list as it opens.
		const timer = setTimeout(() => setOpen((now) => (now === "settings" ? now : "repo")), 0);
		return () => clearTimeout(timer);
	}, [returned, nowConnected]);

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
	const started = startedOn(account.settings?.lastStart ?? null);
	const lastMachineId = !item && started.place?.kind === "machine" ? started.place.machineId : null;
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
	// A work item starts on Windlass unless chosen otherwise, and only on an agent its machine is signed into.
	const wantedHarness = harnessChoice ?? (item ? "windlass" : (started.harness ?? "windlass"));
	const harnessesHere = (machine: MachineSummary | null) => (item ? itemHarnesses(machine) : offeredHarnesses(machine));
	const harness: HarnessId = wantedHarness !== "windlass" && hardened && harnessesHere(chosenMachine).some((offered) => offered.id === wantedHarness) ? wantedHarness : "windlass";
	const other = harness === "windlass" ? null : HARNESS_NAMES[harness];
	// The agent the last one was, where it cannot be this one's: said in the agent's picker.
	const harnessProblem =
		item || harnessChoice !== null || started.harness === null || started.harness === harness || machinesReading
			? null
			: `Your last agent was ${HARNESS_NAMES[started.harness]}, which ${chosenMachine ? `“${machineLabel(chosenMachine)}” does not offer now` : "runs only on a machine of yours"}, so this one is ${HARNESS_NAMES[harness]}.`;
	const catalogs = { claude: useCatalog(chosenMachine, "claude"), opencode: useCatalog(chosenMachine, "opencode") };
	const selectedCatalog = harness === "windlass" ? null : catalogs[harness];
	const options = harnessOptions(chosenMachine, harness, selectedCatalog?.options);
	const lastOf = last.of[harness] ?? null;

	// ---- the sandbox, the model and effort, the mode ------------------------------------------
	const profile = other ? HARNESS_PROFILE : startingProfile(profileChoice, defaults, info ? { profiles: placeProfiles } : null, last.of.windlass?.profile ?? null);
	const modelList = other ? options.models : models.list;
	const offers = (id: string) => modelList?.models.some((candidate) => candidate.id === id) === true;
	// Another harness's "" is its own default model, the one its runner reported as that: nothing is sent for it, so the adapter starts on its own.
	const reportedDefault = other && modelList !== null && modelList.models.length > 0 ? modelList.defaultModel : null;
	const harnessModel = (id: string) => (offers(id) ? (id === reportedDefault ? "" : id) : null);
	// A work item's agent starts on its own default model unless one is chosen here: not on the last agent's.
	const model = other ? (harnessModel(modelChoice) ?? (lastOf && !item ? harnessModel(lastOf.model) : null) ?? "") : startingModel(modelChoice, defaults, models.list, last.of.windlass?.model ?? null);
	const efforts = effortsOf(modelList, model === "" && reportedDefault !== null ? reportedDefault : model);
	const effort = efforts.includes(effortChoice) ? effortChoice : "";
	const chosenProfile = placeProfiles.find((candidate) => candidate.id === profile) ?? null;
	const launch = launchModes(harness, chosenProfile);
	// Claude Code's modes as its machine reported them, where it did.
	const modes = launch && other && options.modes ? { modes: options.modes, default: options.modes.some((mode) => mode.id === launch.default) ? launch.default : (options.modes[0] as SessionMode).id } : launch;
	const mode = modes ? (modes.modes.find((candidate) => candidate.id === modeChoice) ?? (started.harness === harness ? modes.modes.find((candidate) => candidate.id === started.mode) : undefined) ?? modes.modes.find((candidate) => candidate.id === lastOf?.mode) ?? modes.modes.find((candidate) => candidate.id === modes.default) ?? null) : null;
	const claude: ClaudeFacts | null = other ? { opencode: harness === "opencode", mode: mode ?? { id: "build", name: "Build", description: null } } : null;
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
		: info === null || sessions === null || repoReading || saved.reading || accountReading || models.reading || !!selectedCatalog?.reading || (machinesReading && wantedMachine !== null);
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
			mode: info?.items?.orchestrate && !other ? itemMode : "single",
			body: filing.body,
			acceptance,
			start: now,
			...(chosenMachine ? { place: { kind: "machine" as const, machineId: chosenMachine.machineId } } : {}),
			// The agent and its model: Windlass on the account's model unless one was chosen here.
			...(other ? { harness } : {}),
			...(model && (other || modelChoice !== "") ? { model } : {}),
			// Every turn of the item runs at it; left out, at the agent's default.
			...(effort && effort !== "default" ? { effort } : {}),
		};
		// Filing the same again after an answer that never came, with nothing changed, makes no second item.
		asked.current = submissionOf(JSON.stringify(input), asked.current);
		setBusy("filing");
		try {
			const made = await client.user(auth).createItem({ ...input, idempotencyKey: asked.current.idempotencyKey });
			asked.current = null;
			setPrompt("");
			setCriteria("");
			setItemMode("orchestrate");
			setFiled({ id: made.id, title: made.title, started: now, feature: input.mode === "orchestrate" });
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

	const close = () => setOpen(null);
	/** Opens one picker, or closes it: one is open at a time. */
	const openOnly = (picker: Picker) => (next: boolean) => setOpen((now) => (next ? picker : now === picker ? null : now));

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

	// ---- the repository ---------------------------------------------------------------------------
	const repoValue = repoReading ? "…" : repo.kind === "github" ? `${repositoryName(repo.picked.repository)} @ ${repo.picked.branch}` : repo.kind === "address" && repo.url !== "" ? shortAddress(repo.url) : item ? "choose one" : "none";
	const repoMissing = item && !repoReading && chosen === null;
	const repoWarn = repoMissing || repoInvalid || (opening.error !== null && repositoryId !== undefined && repoChoice === null) || notice?.tone === "bad";
	const chooseRepo = (next: PickedRepository | null) => {
		setRepoChoice(next ? { kind: "github", picked: next } : { kind: "none" });
		github.dismiss();
	};
	const noRepository = () => {
		setRepoChoice({ kind: "none" });
		setRepoUrl("");
	};
	const repoNote = item
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
				: "Cloned into the workspace when the sandbox is created. Without one the agent starts in an empty repository.";
	const repoNoteWarn = repoInvalid || (chosen !== null && !chosen.repository.canPush);
	const openingNote =
		opening.error !== null && repoChoice === null ? (
			<p className="ui-menu-note tone-warn" role="status">
				{repositoryId !== undefined ? opening.error : `The repository your newest ${item && newestItem ? "work item is on" : "agent was launched on"} could not be read: ${opening.error}`} {item ? "Choose another repository." : "Choose another repository, or launch without one."}
			</p>
		) : null;
	const shots =
		chosen && item && saved.defaults ? (
			<p className="ui-menu-note start-shots">
				{saved.defaults.screenshots ? "Its agents take screenshots of the app for their reports" : "Screenshots are off for this repository"}:{" "}
				<a className="link" {...linkProps({ name: "repository", id: chosen.repository.id, view: "settings", section: "screenshots" })}>
					{saved.defaults.screenshots ? "change it" : "turn them on"}
				</a>
				.
			</p>
		) : null;
	const connectGithub = () => github.connect({ where: "launch", draft: { prompt, repoUrl, profile: profileChoice, model: modelChoice, effort: effortChoice, place: placeChoice === undefined ? null : (placeChoice ?? "platform"), harness: harnessChoice, mode: modeChoice, kind: kindChoice, itemMode, criteria } });
	const connectLine =
		github.enabled && !connection ? (
			<p className={`ui-menu-note gh-connect-line${notice?.tone === "bad" || github.error ? " tone-bad" : ""}`} role={notice?.tone === "bad" ? "alert" : undefined}>
				{github.busy === "finishing" ? (
					"Finishing the GitHub connection…"
				) : github.busy === "leaving" ? (
					"Opening GitHub…"
				) : github.busy === "popup" ? (
					<>
						Finish connecting in the GitHub window.{" "}
						<button type="button" className="link" onClick={() => github.connect({ where: "launch" })}>
							Show it
						</button>
					</>
				) : github.status === null && !github.error ? (
					"Checking the GitHub connection…"
				) : (
					<>
						{notice?.tone === "bad" ? `${notice.text} ` : github.error ? `${github.error} ` : null}
						<button type="button" className="link" onClick={connectGithub} disabled={busy !== null}>
							Connect GitHub
						</button>{" "}
						to choose one of your own repositories, private ones included, and get the work back as a pull request. It opens in a new window; what you wrote here stays.
					</>
				)}
			</p>
		) : null;
	const repoActions = (
		<div className="ui-menu-actions">
			{connection && !item ? (
				<button type="button" className="ui-menu-action" onClick={() => setChosenSource(source === "github" ? "address" : "github")} disabled={busy !== null}>
					{source === "github" ? "Paste an address" : "Choose from GitHub"}
				</button>
			) : null}
			{repo.kind !== "none" && !item ? (
				<button type="button" className="ui-menu-action" onClick={noRepository} disabled={busy !== null}>
					No repository
				</button>
			) : null}
		</div>
	);
	// Connected and choosing from GitHub: a menu. Otherwise a small form: the address, or the way to connect.
	const repoSpec: MenuSpec | null =
		source === "github" && connection
			? repositoryMenu({
					search,
					branches,
					chosen,
					accounts: connection.accounts,
					onChoose: chooseRepo,
					header: openingNote,
					footer: (
						<>
							{repoActions}
							<p className="ui-menu-note">
								Installed by someone else? <button type="button" className="link" onClick={connectGithub} disabled={busy !== null}>Reconnect GitHub</button> to pick it up.
							</p>
							{repoNoteWarn || item ? <p className={`ui-menu-note${repoNoteWarn ? " tone-warn" : ""}`}>{repoNote}</p> : null}
							{shots}
						</>
					),
				})
			: null;
	const addressForm = (
		<div className="start-address">
			{source !== "github" || !connection ? (
				<>
					<label className="label" htmlFor={ids.repo}>
						{github.enabled ? "Repository address" : "Git repository to clone"}
					</label>
					<input
						id={ids.repo}
						className={`input input-mono${repoInvalid ? " input-invalid" : ""}`}
						type="url"
						inputMode="url"
						spellCheck={false}
						autoComplete="off"
						placeholder="https://github.com/you/project.git"
						value={repo.kind === "address" ? repo.url : ""}
						data-autofocus
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
					<p className={`field-note${repoNoteWarn ? " tone-warn" : ""}`} id={ids.repoNote}>
						{repoNote}
					</p>
				</>
			) : null}
			{openingNote}
			{connectLine}
			{shots}
			{repoActions}
		</div>
	);
	const repoPill = (props: TriggerProps) => (
		<Pill {...props} data-picker="repo" data-value={repoValue} icon={<RepoIcon size={15} />} secondary={repo.kind === "github" ? <BranchSecondary branch={repo.picked.branch} /> : undefined} dot={repoWarn ? "warn" : null} dotLabel={repoWarn ? "needs a look" : undefined} aria-busy={repoReading} aria-label={`Repository: ${repoValue}`}>
			{repoReading ? "…" : repo.kind === "github" ? repo.picked.repository.name : repo.kind === "address" && repo.url !== "" ? shortAddress(repo.url) : item ? "Choose a repository" : "No repository"}
		</Pill>
	);

	// ---- where it runs, and its sandbox -------------------------------------------------------------
	const available = placeProfiles.filter((candidate) => candidate.available && (!other || candidate.id === HARNESS_PROFILE));
	const sandboxWarn = (chosenProfile !== null && sandboxOpen(chosenProfile, claude)) || (!other && ignored.profile !== null) || defaultsErrors.length > 0 || available.length === 0;
	/** The sandboxes of a place, as rows: choosing one chooses the place too. */
	const profileRows = (machine: MachineSummary | null): MenuItem[] => {
		const here = machine === null ? (chosenMachine === null) : chosenMachine?.machineId === machine.machineId;
		const list = machine ? machine.profiles : (info?.profiles ?? []);
		return list
			.filter((candidate) => !other || candidate.id === HARNESS_PROFILE)
			.map((candidate) => {
				const facts = sandboxFacts(candidate, here ? claude : null);
				return {
					id: candidate.id,
					label: candidate.name,
					description: candidate.available ? facts.map((fact) => fact.text).join(" · ") : (candidate.unavailableReason ?? "This deployment cannot run it."),
					title: candidate.available ? facts.map((fact) => fact.long).join("; ") : (candidate.unavailableReason ?? undefined),
					tone: candidate.available && facts.some((fact) => fact.open) ? ("warn" as const) : undefined,
					disabled: !candidate.available,
					checked: here && profile === candidate.id,
					onSelect: () => {
						setPlace(machine?.machineId ?? null);
						setProfile(candidate.id);
					},
				};
			});
	};
	const profileMenu = (machine: MachineSummary | null): MenuSpec | undefined =>
		item ? undefined : { label: `Sandbox ${machine ? `on ${machineLabel(machine)}` : "hosted"}`, width: 300, groups: [{ id: "profiles", label: "Sandbox", note: machine ? machineLabel(machine) : "hosted", items: profileRows(machine) }] };
	const machineState = (machine: MachineSummary) => (machine.status === "online" ? "online" : machine.status === "offline" ? `offline since ${clockTime(machine.since, now)}` : "waiting for its runner");
	const whereNotes = [
		placeProblem ? { text: placeProblem, warn: true } : null,
		available.length === 0 ? { text: chosenMachine ? `“${machineLabel(chosenMachine)}” has no sandbox that can be used right now.` : "This deployment has no sandbox that can be used right now.", warn: true } : null,
		!other && ignored.profile ? { text: ignored.profile, warn: true } : null,
		...defaultsErrors.map((line) => ({ text: line, warn: true })),
		item && chosenMachine
			? {
					text: `It runs without asking on “${machineLabel(chosenMachine)}”, inside its container, and costs no hosted time. ${chosenMachine.status === "online" ? "If the machine is away, the item waits until it is back." : `“${machineLabel(chosenMachine)}” is offline since ${clockTime(chosenMachine.since, now)}, so the item waits until it is back.`}${hardenedItemNote(chosenMachine)}`,
					warn: false,
				}
			: null,
		other ? { text: `${other} runs in the hardened container only.`, warn: false } : null,
	].filter((note) => note !== null);
	const whereGroups: MenuGroup[] =
		mine.length > 0
			? [
					{
						id: "hosted",
						label: "Hosted",
						note: "counts against your daily sandbox time",
						items: [{ id: "platform", label: "Hosted sandbox", icon: <CloudIcon size={15} />, description: chosenMachine === null && chosenProfile ? chosenProfile.name : "A sandbox the platform makes and controls", checked: chosenMachine === null, onSelect: () => setPlace(null), submenu: profileMenu(null) }],
					},
					{
						id: "machines",
						label: "Your machines",
						note: "costs no hosted time",
						items: mine.map((machine) => {
							const unusable = why(machine);
							const isChosen = chosenMachine?.machineId === machine.machineId;
							return {
								id: machine.machineId,
								label: machineLabel(machine),
								icon: <MachineIcon size={15} />,
								description: unusable ?? `${machine.os} ${machine.arch} · ${machineState(machine)}${isChosen && chosenProfile ? ` · ${chosenProfile.name}` : ""}`,
								title: unusable ?? undefined,
								trailing: <span className={`ui-dot ui-dot-${machine.status === "online" ? "ok" : "off"}`} aria-hidden="true" />,
								disabled: unusable !== null,
								tone: unusable === null && machine.status !== "online" ? ("warn" as const) : undefined,
								checked: isChosen,
								onSelect: () => setPlace(machine.machineId),
								submenu: unusable === null ? profileMenu(machine) : undefined,
							};
						}),
					},
				]
			: [{ id: "profiles", label: "Sandbox", note: "hosted", items: profileRows(null) }];
	const whereSpec: MenuSpec = {
		label: mine.length > 0 ? "Where it runs" : "Sandbox",
		width: 320,
		hints: { right: "sandbox" },
		header:
			whereNotes.length > 0 ? (
				<>
					{whereNotes.map((note) => (
						<p key={note.text} className={note.warn ? "tone-warn" : undefined}>
							{note.text}
						</p>
					))}
				</>
			) : undefined,
		groups: whereGroups,
		footer: profileChanged ? (
			<button type="button" className="ui-menu-action start-back" onClick={() => setProfile(null)}>
				Back to the default ({whose(defaults.from.profile)}: {info?.profiles.find((candidate) => candidate.id === defaults.profile)?.name ?? defaults.profile})
			</button>
		) : undefined,
	};
	const placeName = chosenMachine ? machineLabel(chosenMachine) : "Hosted";
	const whereWarn = placeProblem !== null || chosenMachine?.status === "offline" || (!item && sandboxWarn);
	const showWhere = mine.length > 0 || !item;
	const wherePill = (props: TriggerProps) => (
		<Pill
			{...props}
			data-picker="where"
			data-value={placeName}
			data-sandbox={chosenProfile?.name ?? "none"}
			icon={chosenMachine ? <MachineIcon size={15} /> : <CloudIcon size={15} />}
			secondary={!item && chosenProfile ? `· ${chosenProfile.name}` : undefined}
			dot={whereWarn ? "warn" : profileChanged ? "changed" : chosenMachine ? (chosenMachine.status === "online" ? "ok" : "off") : null}
			dotLabel={whereWarn ? "something is open, or cannot be used: see its picker" : chosenMachine ? chosenMachine.status : undefined}
			className={profileChanged ? "ui-pill-changed" : undefined}
			aria-label={`Where it runs: ${placeName}${!item && chosenProfile ? `, ${chosenProfile.name}` : ""}`}
		>
			{placeName}
		</Pill>
	);

	// ---- the agent and its model --------------------------------------------------------------------
	/** The rows of one harness's models, each with its efforts in a submenu. */
	const modelRows = (harnessId: HarnessId, list: typeof modelList): MenuItem[] => {
		if (list === null || list.models.length === 0) return [];
		const isOther = harnessId !== "windlass";
		return list.models.map(({ id, name: reportedName, efforts: rowEfforts }) => {
			const isDefault = id === list.defaultModel;
			const name = isOther && reportedName ? reportedName : id;
			const here = harness === harnessId;
			// Another harness's reported default is its "": chosen, nothing is sent.
			const checked = here && (isOther && model === "" ? isDefault : model === id);
			const pick = (to: string | null) => {
				setHarness(harnessId);
				setModel(id);
				if (to !== null) setEffort(to);
			};
			return {
				id: `${harnessId}:${id}`,
				label: name,
				icon: <AgentGlyph harness={HARNESS_NAMES[harnessId]} accent={harnessId === "windlass" && isDefault} />,
				description: rowEfforts.length > 0 ? (checked && effort ? `effort ${effort} · ${rowEfforts.length} levels` : `${rowEfforts.length} effort levels`) : undefined,
				trailing: isDefault && !saysDefault(name) ? <span className="ui-tag">default</span> : undefined,
				checked,
				onSelect: () => pick(null),
				submenu:
					rowEfforts.length > 0
						? {
								label: `Effort for ${name}`,
								width: 200,
								groups: [
									{
										id: "efforts",
										label: `Effort for ${name}`,
										items: effortChoices(rowEfforts).map((level, index) => ({
											id: level || "default",
											label: level || "default",
											icon: <EffortBars level={index} of={rowEfforts.length} />,
											checked: checked && (effort || "default") === (level || "default"),
											onSelect: () => pick(level),
										})),
									},
								],
							}
						: undefined,
			};
		});
	};
	const offersOther = chosenMachine !== null && harnessesHere(chosenMachine).length > 0;
	const windlassList = models.list;
	const agentGroups: MenuGroup[] = [
		{
			id: "windlass",
			label: "Windlass",
			note: chosenMachine ? `on ${machineLabel(chosenMachine)}` : "hosted or any machine",
			items:
				windlassList === null || windlassList.models.length === 0
					? [{ id: "windlass:default", label: model && !other ? model : "Your default model", icon: <AgentGlyph harness="Windlass" accent />, description: models.reading ? "Reading your models…" : `${models.error ?? "Your models could not be read."} The agent starts on your default model.`, checked: harness === "windlass", onSelect: () => setHarness("windlass") }]
					: modelRows("windlass", windlassList),
		},
		...(chosenMachine && offersOther
			? harnessesHere(chosenMachine).map((offered) => {
					const options = harnessOptions(chosenMachine, offered.id, catalogs[offered.id].options);
					const name = HARNESS_NAMES[offered.id];
					const rows = modelRows(offered.id, options.models);
					return {
						id: offered.id,
						label: name,
						note: signInWords(offered),
						items: !hardened
							? [{ id: `${offered.id}:none`, label: name, icon: <AgentGlyph harness={name} />, description: `Runs only in the hardened container, which “${machineLabel(chosenMachine)}” cannot make now.`, disabled: true }]
							: rows.length > 0
								? rows
								: [{ id: `${offered.id}:default`, value: offered.id, label: `${name}'s default model`, icon: <AgentGlyph harness={name} />, description: catalogs[offered.id].reading ? "Reading models…" : `“${machineLabel(chosenMachine)}”'s runner reports ${name}'s models once it has checked.`, checked: harness === offered.id, onSelect: () => setHarness(offered.id) }],
					};
				})
			: []),
		...(["claude", "opencode"] as const).flatMap(id => {
			if (harnessesHere(chosenMachine).some(h => h.id === id)) return [];
			const hosts = mine.filter(machine => why(machine) === null && harnessesHere(machine).some(h => h.id === id));
			if (hosts.length === 0) return [];
			const name = HARNESS_NAMES[id];
			return [{
				id: id + ":elsewhere",
				label: name,
				note: "on your machines",
				items: [{
					id: id + ":elsewhere",
					label: name,
					icon: <AgentGlyph harness={name} />,
					description: `On ${hosts.map(machineLabel).join(", ")}: choose that machine first`,
					disabled: true,
				}],
			}];
		}),
	];
	const agentSpec: MenuSpec = {
		label: "Agent and model",
		width: 304,
		maxHeight: 520,
		submenuWidth: 200,
		hints: { right: "effort" },
		filter: agentGroups.reduce((sum, group) => sum + group.items.length, 0) > 7 ? { placeholder: "Filter models…" } : undefined,
		header:
			offersOther || (!other && ignored.model) || harnessProblem ? (
				<>
					{chosenMachine && offersOther
						? <details className="agent-commands">
								<summary>Terminal sign-in commands</summary>
								{offeredHarnesses(chosenMachine).map(offered => <HarnessStatus key={offered.id} harness={offered} />)}
							</details>
						: null}
					{(["claude", "opencode"] as const).map(id => catalogs[id].error && <p key={id} role="status">
						{HARNESS_NAMES[id]} models: {catalogs[id].error} <button type="button" className="link" onClick={catalogs[id].retry}>Retry</button>
					</p>)}
					{harnessProblem ? <p className="tone-warn" role="status">{harnessProblem}</p> : null}
					{!other && ignored.model ? <p className="tone-warn">{ignored.model}</p> : null}
				</>
			) : undefined,
		groups: agentGroups,
		footer: (
			<>
				{item && other ? <p className="ui-menu-note">{other} works on the item in the hardened container without asking, and runs Quick: Plan first is Windlass's. It does not run this repository's checks, so CI decides, and there is no second reviewer on a machine.</p> : null}
				{!item && other === "Claude Code" ? <p className="ui-menu-note">Claude Code runs in the hardened container with your Claude subscription, in the mode chosen for it. It does not run this repository's checks; CI's result is on the pull request.</p> : null}
				<p className="ui-menu-note">{other ? `The models “${chosenMachine ? machineLabel(chosenMachine) : ""}”'s runner reported for ${other}.` : modelList ? modelsNote(modelList) : null}</p>
				{modelChanged ? (
					<button type="button" className="ui-menu-action start-back" onClick={() => setModel("")}>
						Back to the default ({whose(defaults.from.model)}: {defaults.model})
					</button>
				) : null}
			</>
		),
	};
	const agentModel = !other ? model || "default model" : model !== "" ? modelName(modelList, model) : reportedDefault !== null && modelList ? modelLabel(modelList, reportedDefault) : "default model";
	const shownEffort = effort;
	const agentValue = `${HARNESS_NAMES[harness]} · ${agentModel}${shownEffort ? ` · ${shownEffort}` : ""}`;
	const agentWarn = harnessProblem !== null || (!other && ignored.model !== null);
	const agentPill = (props: TriggerProps) => (
		<Pill
			{...props}
			data-picker="agent"
			data-value={agentValue}
			icon={<AgentGlyph harness={HARNESS_NAMES[harness]} accent={harness === "windlass"} />}
			secondary={`· ${agentModel}${shownEffort ? ` · ${shownEffort}` : ""}`}
			dot={agentWarn ? "warn" : modelChanged ? "changed" : null}
			dotLabel={harnessProblem ? "the last agent cannot be used here" : agentWarn ? "the saved default cannot be used" : undefined}
			className={modelChanged ? "ui-pill-changed" : undefined}
			aria-label={`Agent: ${agentValue}`}
		>
			{HARNESS_NAMES[harness]}
		</Pill>
	);

	// ---- the mode, the criteria, the setup ------------------------------------------------------------
	const modeOpen = mode !== null && OPEN_MODES.has(mode.id);
	const modeSpec = modes && mode ? modeMenu(modes.modes, mode.id, setMode, modeOpen) : null;
	const modeControl = modes && mode ? <ModePicker modes={modes.modes} current={mode.id} disabled={busy !== null} warn={modeOpen} onChoose={setMode} open={open === "mode"} onOpenChange={openOnly("mode")} /> : null;

	const criteriaValue = acceptance.length === 0 ? "none" : count(acceptance.length);
	const criteriaField = (
		<div className="start-criteria">
			<label className="label" htmlFor={ids.criteria}>
				Acceptance criteria<span className="label-optional">optional</span>
			</label>
			<textarea id={ids.criteria} className={`input textarea item-criteria${criteriaWrong ? " input-invalid" : ""}`} value={criteria} onChange={(event) => setCriteria(event.target.value)} readOnly={busy !== null} aria-describedby={ids.criteriaNote} aria-invalid={criteriaWrong !== null || undefined} data-autofocus />
			<p className={`field-note${criteriaWrong ? " tone-bad" : ""}`} id={ids.criteriaNote}>
				{criteriaWrong ?? "One per line. The agent is given them, and the verdict lists them for you to check: no machine checks them."}
			</p>
		</div>
	);

	// ---- how a work item runs: plan first or quick ------------------------------------
	const orchestrateOffered = item && Boolean(info?.items?.orchestrate);
	const orchestrating = orchestrateOffered && itemMode === "orchestrate" && !other;
	const orchestrateWarn = orchestrating ? orchestrateProblem(saved.checks) : null;
	const itemModeControl = orchestrateOffered ? <ItemModePicker costId={ids.kind + "-cost"} value={other ? "single" : itemMode} onChange={setItemMode} disabled={busy !== null || other !== null} /> : null;

	const hasSetup = chosen !== null && !item;
	const setupForm = hasSetup ? (
		<div className="start-setup">
			<SetupField egress={chosenMachine?.egress ?? (chosenMachine ? undefined : info?.hostedEgress)} hosted={!chosenMachine} setup={setup} repository={repositoryName(chosen.repository)} disabled={busy !== null} />
			{!other ? <SecretsField repositoryId={chosen.repository.id} repository={repositoryName(chosen.repository)} profile={profile} disabled={busy !== null} /> : null}
		</div>
	) : null;
	const setupSummary = hasSetup ? (setup.draft.text.trim() === "" ? "no setup command" : setup.draft.text.trim().split("\n")[0]) : null;

	// ---- the launch ----------------------------------------------------------------------------------
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
	const secondaryDisabled = item ? !canFile : !canCreate || tooLong;
	const runSecondary = () => void (item ? file(false) : start(false));
	const launchMenu: MenuSpec = {
		label: item ? "Filing options" : "Launch options",
		width: 260,
		hints: false,
		groups: [
			{
				id: "launch",
				items: [
					{
						id: "secondary",
						label: secondary,
						description: item ? "Filed, not started" : task === "" ? "An agent with an empty composer" : "The task waits in its composer",
						trailing: <Kbd>⌥↵</Kbd>,
						disabled: secondaryDisabled,
						onSelect: runSecondary,
					},
				],
			},
		],
	};
	const launchWord = busy === "creating" ? "Creating" : busy === "prompting" ? "Sending" : busy === "filing" ? "Filing" : item ? "File" : "Launch";

	// ---- the line under the box: what the sandbox lets its commands do, and where -----------------
	const facts = !item && chosenProfile ? sandboxFacts(chosenProfile, claude) : [];
	const where = chosenMachine ? `runs on ${machineLabel(chosenMachine)}` : "runs hosted";
	const anyOpen = facts.some((fact) => fact.open);

	// ---- the phone: one summary row, a sheet of settings --------------------------------------------------
	const summary = [item && !other ? null : agentModel, placeName, repo.kind === "github" ? repo.picked.repository.name : repo.kind === "address" && repo.url !== "" ? shortAddress(repo.url) : item ? "no repository" : null, item ? null : (mode?.name ?? null), item && acceptance.length > 0 ? `${count(acceptance.length)} criteria` : null].filter((part) => part !== null);
	const anyWarn = repoWarn || whereWarn || agentWarn || modeOpen || criteriaWrong !== null || orchestrateWarn !== null;
	const settingsSpec: MenuSpec = {
		label: "Settings",
		groups: [
			{
				id: "settings",
				items: [
					{ id: "agent", label: "Agent & model", icon: <AgentGlyph harness={HARNESS_NAMES[harness]} accent={harness === "windlass"} />, description: agentValue, tone: agentWarn ? ("warn" as const) : undefined, submenu: agentSpec },
					...(showWhere ? [{ id: "where", label: mine.length > 0 ? "Where it runs" : "Sandbox", icon: chosenMachine ? <MachineIcon size={16} /> : <CloudIcon size={16} />, description: !item && chosenProfile ? `${placeName} · ${chosenProfile.name}` : placeName, tone: whereWarn ? ("warn" as const) : undefined, submenu: whereSpec }] : []),
					{ id: "repo", label: "Repository", icon: <RepoIcon size={16} />, description: repoValue, tone: repoWarn ? ("warn" as const) : undefined, onSubmenuOpen: () => setOpen("settings"), ...(repoSpec ? { submenu: repoSpec } : { panel: addressForm }) },
					...(!item && modeSpec && mode ? [{ id: "mode", label: "Mode", icon: <ShieldGlyph />, description: mode.name, tone: modeOpen ? ("warn" as const) : undefined, submenu: modeSpec }] : []),
					...(item ? [{ id: "criteria", label: "Acceptance criteria", icon: <SlidersIcon size={16} />, description: criteriaValue, tone: criteriaWrong ? ("warn" as const) : undefined, panel: criteriaField }] : []),
					...(hasSetup && setupForm ? [{ id: "setup", label: "Setup and secrets", icon: <PlusIcon size={16} />, description: setupSummary ?? undefined, panel: setupForm }] : []),
				],
			},
		],
	};

	const kindSwitch =
		switchable && info?.items ? (
			<div className="segmented start-kind" role="radiogroup" aria-label="What to start">
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

	return (
		<form
			className={`composer start${busy ? " composer-busy" : ""}${phone ? " start-phone" : ""}`}
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
			{phone && (kindSwitch || itemModeControl) ? <div className="start-kinds">{kindSwitch}{itemModeControl}</div> : null}
			{phone && itemModeControl && <ItemModeCost id={ids.kind + "-cost"} mode={itemMode} />}
			<div className="start-box">
				<label className="visually-hidden" htmlFor={ids.text}>
					{item ? "What the work item asks for: its first line is the title" : "What the agent should do"}
				</label>
				<textarea
					ref={area}
					id={ids.text}
					className="start-text"
					rows={phone ? 1 : 2}
					value={prompt}
					placeholder={item ? (phone ? "What should be done?" : "What should be done? The first line is its title.") : "What should an agent do?"}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onKeyDown}
					disabled={busy !== null}
					aria-describedby={`${ids.hint} ${ids.keys}`}
					enterKeyHint="send"
				/>
				<KeyHints id={ids.keys} className="start-keys" hints={item ? [["↵", "file and start"], ["⇧↵", "new line"]] : [["↵", "launch"], ["⇧↵", "new line"]]} />
				<div className="start-tools">
					{phone ? (
						<>
							<button type="button" ref={anchors.settings} className="start-summary" data-picker="settings" aria-haspopup="dialog" aria-expanded={open === "settings"} onClick={() => setOpen(open === "settings" ? null : "settings")}>
								<SlidersIcon size={15} />
								<span className="start-summary-text">
									{summary.map((part, index) => (
										<span key={index}>{index === 0 ? <b>{part}</b> : ` · ${part}`}</span>
									))}
								</span>
								{anyWarn ? <span className="ui-dot ui-dot-warn" role="img" aria-label="something needs a look" /> : chosenMachine?.status === "online" ? <span className="ui-dot ui-dot-ok" aria-hidden="true" /> : null}
							</button>
							<button type="submit" className="start-send" disabled={item ? !canFile : !canLaunch} aria-label={launchWord}>
								<ArrowUpIcon size={16} />
							</button>
							<MenuSheet open={open === "settings"} spec={settingsSpec} title={item ? "Filing settings" : "Launch settings"} onClose={close} anchor={anchors.settings} settings footer={<button type="button" className="ui-menu-action start-secondary" onClick={() => (close(), runSecondary())} disabled={secondaryDisabled}>{secondary}</button>} />
						</>
					) : (
						<>
							{kindSwitch}
							{hasSetup || (item && chosen) ? (
								<Tooltip content={item ? "Repository notes" : "Setup command and secrets"}>
									<button type="button" ref={anchors.plus} className="start-plus" data-picker="setup" aria-haspopup="dialog" aria-expanded={open === "plus"} aria-label={item ? "Repository notes" : `Setup command and secrets${setupSummary ? `: ${setupSummary}` : ""}`} onClick={() => setOpen(open === "plus" ? null : "plus")}>
										<PlusIcon size={15} />
									</button>
								</Tooltip>
							) : null}
							<Menu spec={agentSpec} open={open === "agent"} onOpenChange={openOnly("agent")} trigger={agentPill} surface="popover" />
							{showWhere && (mine.length > 0 || !item) ? <Menu spec={whereSpec} open={open === "where"} onOpenChange={openOnly("where")} trigger={wherePill} surface="popover" /> : null}
							{repoSpec ? (
								<Menu spec={repoSpec} open={open === "repo"} onOpenChange={openOnly("repo")} trigger={repoPill} surface="popover" />
							) : (
								repoPill({ ref: anchors.repo, "aria-haspopup": "dialog", "aria-expanded": open === "repo", "data-state": open === "repo" ? "open" : "closed", onClick: () => setOpen(open === "repo" ? null : "repo"), onKeyDown: () => undefined })
							)}
							{item ? (
								<Pill ref={anchors.criteria} data-picker="criteria" data-value={criteriaValue} icon={<SlidersIcon size={14} />} dot={criteriaWrong ? "warn" : null} aria-haspopup="dialog" aria-expanded={open === "criteria"} data-state={open === "criteria" ? "open" : "closed"} onClick={() => setOpen(open === "criteria" ? null : "criteria")} aria-label={`Acceptance criteria: ${criteriaValue}`}>
									{acceptance.length === 0 ? "Criteria" : `${count(acceptance.length)} criteria`}
								</Pill>
							) : null}
							<span className="start-tools-end">
								{item ? itemModeControl : modeControl}
								<SplitButton type="submit" className="start-launch" icon={<SendIcon size={14} />} disabled={item ? !canFile : !canLaunch} menu={launchMenu} menuLabel={item ? "Filing options" : "Launch options"}>
									{launchWord}
								</SplitButton>
							</span>
							<PickerPanel open={open === "repo" && !repoSpec} onClose={close} anchor={anchors.repo} title="Repository" surface="popover">
								{addressForm}
							</PickerPanel>
							<PickerPanel open={open === "plus"} onClose={close} anchor={anchors.plus} title={item ? "Repository" : `Before the agent starts${chosen ? ` · ${chosen.repository.name}` : ""}`} width={380} surface="popover">
								{item ? shots : setupForm}
							</PickerPanel>
							<PickerPanel open={open === "criteria"} onClose={close} anchor={anchors.criteria} title="Acceptance criteria" surface="popover">
								{criteriaField}
							</PickerPanel>
						</>
					)}
				</div>
			</div>
			{!phone && itemModeControl && <ItemModeCost id={ids.kind + "-cost"} mode={itemMode} />}
			{facts.length > 0 || chosenMachine ? (
				<p className={`start-sandbox${anyOpen ? " start-sandbox-open" : ""}`} title={facts.map((fact) => fact.long).join("; ") || undefined}>
					{anyOpen ? <WarnIcon size={13} /> : <ShieldGlyph />}
					{facts.map((fact) => (
						<span key={fact.text} className={fact.open ? "start-fact-open" : undefined}>
							{fact.text}
							<span className="visually-hidden"> ({fact.long})</span>
						</span>
					))}
					<span>{where}</span>
				</p>
			) : null}
			{filing ? (
				<p className="start-line start-title">
					Title: <span className="start-title-text">{filing.title}</span>
				</p>
			) : null}
			{orchestrateWarn ? (
				<p className="field-note tone-warn start-line" role="status">
					{orchestrateWarn}
				</p>
			) : null}
			{filed && !filing ? (
				<p className="field-note start-line start-filed" role="status">
					Filed “{filed.title}”{filed.started ? (filed.feature ? ": its plan comes to you for approval" : "") : " as a draft"}.{" "}
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
			{/* A reason that only says what is loading (it ends in "…") is announced, not drawn: the pills and Launch show it, and nothing moves when it goes. */}
			<p className={`start-status${tooLong ? " tone-bad" : ""}${!tooLong && reason?.endsWith("…") ? " visually-hidden" : ""}`} id={ids.hint} role={reason || tooLong ? "status" : undefined}>
				{tooLong ? `${count(prompt.length - maxChars)} characters over the limit of ${count(maxChars)}` : reason}
			</p>
		</form>
	);
}

/** The branch after the repository's name: "/ ⑂ main". */
function BranchSecondary({ branch }: { branch: string }) {
	return (
		<span className="start-branch">
			<span className="start-branch-slash" aria-hidden="true">
				/
			</span>
			<BranchIcon size={13} />
			{branch}
		</span>
	);
}

/** An effort as bars, filled to its level. */
function EffortBars({ level, of }: { level: number; of: number }) {
	return (
		<span className="effort-bars" aria-hidden="true">
			{Array.from({ length: Math.max(of, 3) }, (_, index) => (
				<i key={index} className={index < level ? "effort-bar-on" : undefined} style={{ height: 3 + index * (7 / Math.max(of - 1, 1)) }} />
			))}
		</span>
	);
}

function ShieldGlyph() {
	return (
		<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
			<path d="M8 2 13 4v3.6c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4V4z" />
		</svg>
	);
}
