import { availableCatalog } from "../../../server/src/sandbox/harnesses.js";
import { resolveDefaultPlace, savedPlace } from "../../../server/src/factory/default-place";
import { monthReset, monthState } from "../lib/hosted";
import { MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_PROMPT_CHARS, USAGE_LOW_SHARE, type CreateItemInput, type GithubId, type HostedSize, type ItemMode, type ItemSummary, type HarnessId, type HarnessOptions, type MachineSummary, type RepositoryDefaults, type SandboxProfile, type SandboxProfileId, type SessionMode, type SessionSummary, type UsageNumbers } from "@contract";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { hasReason } from "../api/client";
import { isLimitRefusal } from "../api/errors";
import { HARNESS_NAMES } from "../lib/acp";
import { count, localTime, sandboxTime } from "../lib/format";
import { MODEL_SOURCES, SOURCE_NAMES, cleanModelName, credentialWords, effortsOf, harnessOptions, modelLabel, modelName, modelsNote, saysDefault, modelsBySource, type ModelSource } from "../lib/models";
import { safeStorage } from "../lib/workspace";
import { OPEN_MODES, launchModes } from "../lib/modes";
import { itemOf, lastUsed, layerChoices, repositoryName, startedOn, startingChoices, startingModel, startingProfile } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { perHour, sizeName, sizeSpec, startingSize } from "../lib/sizes";
import { clockTime, useMachines } from "../screens/Machines";
import { useApp, useAuth } from "../state/app";
import { takeLaunchDraft, useGithub } from "../state/github";
import { handOver } from "../state/handover";
import { useHostedProviders, allowanceState, useAccount, useAllowance, useModels, useNow } from "../state/hooks";
import { ArrowUpIcon, CheckIcon, CloudIcon, LockIcon, MachineIcon, PlusIcon, RepoIcon, SlidersIcon, WarnIcon } from "./Icons";
import { accessTokenFact, claudeLoginFact, commandNetworkFact, type ClaudeFacts } from "./Layers";
import { modeMenu } from "./Modes";
import { codexModes } from "../../../server/src/sandbox/codex-modes.js";
import { hostedAgentProblem, capabilitiesOf } from "../../../server/src/sandbox/harnesses.js";
import { HARNESS_PROFILE, itemHarnesses, itemProfilesHere, machineUnusable, offeredHarnesses, onPullRequest } from "./PlaceChoice";
import { repositoryMenu, useBranches, useRepositorySearch, type PickedRepository } from "./RepositoryMenu";
import { SecretsField } from "./Secrets";
import { SetupField, useSetupDraft } from "./SetupCommand";
import { HarnessStatus } from "./HarnessStatus";
import { KeyHints, Kbd } from "./ui/Kbd";
import { Menu, MenuList, PickerPanel, type MenuGroup, type MenuItem, type MenuSpec } from "./ui/Menu";
import { Popover } from "./ui/Popover";
import { AgentGlyph, AgentLogo } from "./ui/Pill";
import { RepoTile } from "./RepoTile";
import { AgentPill, EffortButton, LockHint, OptionsButton, WherePill, effortGroup } from "./TrayControls";
import { ProviderLogo } from "./AgentLogos";
import { SplitButton } from "./ui/Button";
import { Tooltip } from "./ui/Tooltip";
import { useSurface } from "./ui/useMediaQuery";
import { hardenedItemNote, machineLabel } from "../lib/machines";

import { ITEM_MODE_WORDS, orchestrateProblem } from "../lib/feature";

function sandboxOpen(profile: SandboxProfile, claude: ClaudeFacts | null): boolean {
	if (claude) return true;
	return profile.approval === "full" || profile.commandNetwork || profile.commandsCanReadAccessToken;
}

interface Fact {
	text: string;
	long: string;
	open: boolean;
}

export function sandboxFacts(profile: SandboxProfile, claude: ClaudeFacts | null = null): Fact[] {
	return [
		claude
			? { text: `${claude.mode.name} mode`, long: `runs in ${claude.mode.name} mode`, open: OPEN_MODES.has(claude.mode.id) }
			: profile.approval === "auto"
				? { text: "commands sandboxed", long: "runs what the sandbox contains, refuses the rest", open: false }
				: { text: "runs every call", long: "runs every call without asking", open: true },
		claude && (claude.codex || claude.opencode || profile.claudeRelay) && !profile.commandNetwork && profile.available
			? { text: claude.codex ? "Codex relay" : claude.opencode ? "OpenCode relay" : "Claude relay only", long: commandNetworkFact(profile, claude), open: false }
			: { text: profile.commandNetwork ? "network on" : "no network", long: commandNetworkFact(profile, claude), open: profile.commandNetwork },
		claude?.hosted ? { text: "Settings key via relay", long: "The sandbox can use a placeholder for this turn. Your provider key stays on the platform.", open: true } : claude?.codex ? {text:"credentials on machine", long:"Commands can use the Codex model relay. OpenAI credentials stay on the machine.",open:true} : claude?.opencode
			? { text: "credentials on machine", long: "Commands can use the OpenCode model relay. Provider credentials stay on the machine.", open: true }
			: claude
			? { text: profile.claudeRelay ? "Claude login via relay" : "Claude login readable", long: `commands can use your Claude login. ${claudeLoginFact(profile)}`, open: true }
			: profile.modelRelay
				? { text: profile.commandsCanReadAccessToken ? "placeholder readable" : "placeholder hidden from commands", long: accessTokenFact(profile), open: profile.commandsCanReadAccessToken }
			: profile.commandsCanReadAccessToken
				? { text: "token readable", long: accessTokenFact(profile), open: true }
				: { text: "token hidden from commands", long: accessTokenFact(profile), open: false },
	];
}

function launchLimit(numbers: UsageNumbers | null, hostedNotice = false): { text: string; warn: boolean } | null {
	if (numbers === null) return null;
	const left = allowanceState(numbers, USAGE_LOW_SHARE);
	const resets = localTime(numbers.resetsAt);
	if (numbers.hosted && monthState(numbers) === "used") return hostedNotice ? null : { warn: true, text: `Hosted minutes are used up until ${monthReset(numbers.hosted)}. A hosted agent launched now is created, and waits; one on your own machine starts at once.` };
	if (left === "used") return { warn: true, text: `Today's sandbox time is used up. An agent launched now is created, and cannot start working before ${resets}, when the allowance is whole again.` };
	const { kept, limit } = numbers.sandboxes;
	if (limit !== null && kept >= limit) return { warn: true, text: `You keep ${limit} hosted sandboxes, the most an account may have. An agent launched here now is created, and cannot start working until you free one. One on your own machine is not counted.` };
	if (left === "low" && numbers.leftSeconds !== null) return { warn: false, text: `${sandboxTime(numbers.leftSeconds)} of today's sandbox time is left. A turn that runs longer is stopped, with its files kept; the allowance is whole again at ${resets}.` };
	return null;
}

export function useDefaults(repositoryId: GithubId | null): { defaults: RepositoryDefaults | null; checks: number | null; reading: boolean; error: string | null } {
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
	const mine = state.repositoryId === repositoryId;
	return { defaults: mine ? state.defaults : null, checks: mine ? state.checks : null, reading: repositoryId !== null && (!mine || (state.defaults === null && state.error === null)), error: mine ? state.error : null };
}

/** Fetch the chosen machine's catalog once per digest, even as its host samples change. */
export function useCatalog(machine: MachineSummary | null, id: "claude" | "opencode" | "codex") {
	const { client, explain } = useApp();
	const auth = useAuth();
	const machineId = machine?.machineId;
	const entry = machine?.harnesses?.find(h => h.id === id);
	const digest = entry?.optionsDigest;
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
	const options = useMemo(() => availableCatalog(match?.options, entry), [match?.options, entry]);
	return { options, reading: !!digest && !match, error: match?.error, retry: () => { setResult(undefined); setRetry(n => n + 1); } };
}

type Picker = "repo" | "where" | "agent" | "effort" | "options" | "plus";

const ITEM_MODE_KEY = "wlp.factory.item-mode";

export function loadItemMode(storage: Pick<Storage, "getItem"> | null = safeStorage()): ItemMode {
	try {
		return storage?.getItem(ITEM_MODE_KEY) === "single" ? "single" : "orchestrate";
	} catch {
		return "orchestrate";
	}
}

function saveItemMode(mode: ItemMode, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
	try {
		storage?.setItem(ITEM_MODE_KEY, mode);
	} catch {
		// Kept for this visit only.
	}
}

export const ITEM_MODE_LINES: Record<ItemMode, string> = {
	orchestrate: "A planner splits it into subtasks you approve, then they run.",
	single: "One agent goes straight to a pull request.",
};

const shortAddress = (url: string) => url.replace(/^https:\/\//, "").replace(/\.git$/, "");

export interface StartComposerProps {
	sessions: readonly SessionSummary[] | null;
	repositoryId?: GithubId;
	autoFocus?: boolean;
	kind?: StartKind;
	items?: readonly ItemSummary[] | null;
	/** The page already shows its own hosted-minutes notice. */
	hostedNotice?: boolean;
}

export type StartKind = "agent" | "item";

const MACHINE_REFUSALS = ["machine_not_found", "machine_not_connected", "runner_outdated", "bad_profile"] as const;

export function StartComposer({ sessions, repositoryId, autoFocus = false, kind: kindChoice = "agent", items, hostedNotice = false }: StartComposerProps) {
	const { client, platform, explain } = useApp();
	const auth = useAuth();
	const info = platform.info;
	const github = useGithub();
	const allowance = useAllowance();
	const limit = launchLimit(allowance, hostedNotice);
	const planSizes = allowance?.hosted?.plan ? (info?.billing?.plans.find((plan) => plan.id === allowance.hosted!.plan)?.sizes ?? null) : null;
	const surface = useSurface();
	const phone = surface === "sheet";
	const ids = { text: useId(), hint: useId(), keys: useId(), repo: useId(), repoLabel: useId(), repoNote: useId(), criteria: useId(), criteriaNote: useId() };
	const [draft] = useState(takeLaunchDraft);

	const [prompt, setPrompt] = useState(draft?.prompt ?? "");
	const item = kindChoice === "item" && Boolean(info?.items);
	const [itemMode, setItemModeState] = useState<ItemMode>(() => draft?.itemMode ?? loadItemMode());
	const setItemMode = (mode: ItemMode) => {
		setItemModeState(mode);
		saveItemMode(mode);
	};
	const [criteria, setCriteria] = useState(draft?.criteria ?? "");
	const [criteriaOpen, setCriteriaOpen] = useState(false);
	const [filed, setFiled] = useState<{ id: string; title: string; started: boolean; feature: boolean } | null>(null);
	const [repoChoice, setRepoChoice] = useState<{ kind: "github"; picked: PickedRepository } | { kind: "address" } | { kind: "none" } | null>(draft?.repoUrl ? { kind: "address" } : null);
	const [repoUrl, setRepoUrl] = useState(draft?.repoUrl ?? "");
	const [chosenSource, setChosenSource] = useState<"github" | "address" | null>(draft?.repoUrl ? "address" : null);
	const [profileChoice, setProfile] = useState<SandboxProfileId | null>((draft?.profile as SandboxProfileId | null | undefined) ?? null);
	const [modelChoice, setModel] = useState(draft?.model ?? "");
	const [effortChoice, setEffort] = useState(draft?.effort ?? "");
	// Where it runs: undefined until chosen; null is this platform.
	const [placeChoice, setPlace] = useState<string | null | undefined>(draft?.place === "platform" ? null : (draft?.place ?? undefined));
	const [harnessChoice, setHarness] = useState<HarnessId | null>(draft?.harness === "windlass" || draft?.harness === "claude" || draft?.harness === "opencode" || draft?.harness === "codex" ? draft.harness : null);
	const [modeChoice, setMode] = useState<string | null>(draft?.mode ?? null);
	const [sizeChoice, setSizeChoice] = useState<HostedSize | null>(null);
	const [open, setOpen] = useState<Picker | null>(null);
	const [providerTab, setProviderTab] = useState<ModelSource | null>(null);
	const [busy, setBusy] = useState<"creating" | "prompting" | "filing" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const anchors = { where: useRef<HTMLSpanElement>(null), plus: useRef<HTMLButtonElement>(null) };
	const search = useRepositorySearch(open === "repo" || open === "where", github.status?.connection?.connectedAt ?? null);
	const branches = useBranches();

	const returned = github.notice?.where === "launch" || github.busy === "finishing";
	const nowConnected = github.status?.connection != null;
	useEffect(() => {
		if (!returned) return;
		// Restore after focus returns to the pill, or the menu immediately closes.
		const timer = setTimeout(() => setOpen(phone ? "where" : "repo"), 0);
		return () => clearTimeout(timer);
	}, [returned, nowConnected, phone]);

	useEffect(() => {
		if (autoFocus) area.current?.focus();
	}, [autoFocus]);

	useLayoutEffect(() => {
		const element = area.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
	}, [prompt]);

	const connection = github.enabled ? (github.status?.connection ?? null) : null;
	const connected = connection !== null;
	const knowsConnection = !github.enabled || github.status !== null || github.error !== null;
	const newest = lastUsed(sessions, null).repository;
	const newestItem = items?.reduce<ItemSummary | null>((found, candidate) => (found === null || candidate.createdAt > found.createdAt ? candidate : found), null) ?? null;
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
	// Work items require a connected repository. Personal sessions can also use a URL or no repository.
	let repo: { kind: "github"; picked: PickedRepository } | { kind: "address"; url: string } | { kind: "none" };
	if (repoChoice?.kind === "github") repo = repoChoice;
	else if (!item && repoChoice?.kind === "address") repo = { kind: "address", url: repoUrl.trim() };
	else if (!item && repoChoice?.kind === "none") repo = repoChoice;
	else if (startPicked) repo = { kind: "github", picked: startPicked };
	else if (!item && repositoryId === undefined && newest?.kind === "address") repo = newest;
	else repo = { kind: "none" };
	// Wait for the initial GitHub lookup to avoid launching without its repository.
	const repoReading = (repoChoice === null || (item && repoChoice.kind !== "github")) && startRepoId !== null && (opening.id !== startRepoId || opening.reading);
	const repoInvalid = repo.kind === "address" && repo.url !== "" && !/^https:\/\/[^\s/]+\/\S+$/.test(repo.url);
	const chosen = repo.kind === "github" ? repo.picked : null;
	const source = connection ? (item ? "github" : (chosenSource ?? (repo.kind === "address" ? "address" : "github"))) : "address";
	const notice = github.notice?.where === "launch" ? github.notice : null;

	const last = lastUsed(sessions, chosen?.repository.id ?? null);
	const saved = useDefaults(chosen?.repository.id ?? null);
	const account = useAccount();
	const models = useModels();
	const repositoryDefaults = startingChoices(saved.defaults, info, models.list);
	const accountDefaults = startingChoices(account.settings?.defaults ?? null, info, models.list, "account");
	const defaults = layerChoices(repositoryDefaults, accountDefaults);
	const whose = (from: "repository" | "account" | null) => (from === "repository" && chosen ? `${repositoryName(chosen.repository)}'s` : "your account's");

	const machinesInfo = info?.machines ?? null;
	const machines = useMachines(machinesInfo !== null);
	const now = useNow(30_000);
	const mine = machinesInfo === null ? [] : (machines.list ?? []);
	const why = (machine: MachineSummary) => machineUnusable(machine, machinesInfo?.minRunnerVersion ?? "", item ? "item" : "agent");
	// Items inherit the repository or account placement. Personal agents remember their last start.
	const started = startedOn(account.settings?.lastStart ?? null);
	const lastMachineId = !item && started.place?.kind === "machine" ? started.place.machineId : null;
	const policy = item && placeChoice === undefined ? savedPlace(saved.defaults, account.settings?.defaults) : undefined;
	const usePolicy = !!policy && harnessChoice === null && profileChoice === null;
	const destination = policy && resolveDefaultPlace(policy, mine, usePolicy && info?.items?.orchestrate ? itemMode : "single");
	const wantedMachine = placeChoice !== undefined ? placeChoice : destination?.place.kind === "machine" ? destination.place.machineId : lastMachineId;
	const chosenMachine = mine.find((machine) => machine.machineId === wantedMachine && why(machine) === null) ?? null;
	const machinesReading = machinesInfo !== null && machines.list === null && machines.error === null;
	const lastMachine = mine.find((machine) => machine.machineId === lastMachineId) ?? null;
	const placeProblem = destination?.note ?? (
		wantedMachine === null || chosenMachine !== null || machinesReading
			? null
			: placeChoice !== undefined
				? `The machine chosen can no longer be used, so this ${item ? "work item" : "agent"} runs on this platform.`
				: lastMachine === null
					? "The machine your last agent ran on is not one of yours any more, so this one runs on this platform."
					: `Your last agent ran on “${machineLabel(lastMachine)}”, which cannot be used now, so this one runs on this platform. ${why(lastMachine) ?? ""}`.trim());
	const keys = useHostedProviders();
	const placeProfiles = chosenMachine ? chosenMachine.profiles : (info?.profiles ?? []);
	const hardened = placeProfiles.some((candidate) => candidate.id === HARNESS_PROFILE && candidate.available);
	const wantedHarness = harnessChoice ?? (item ? destination?.harness ?? "windlass" : (started.harness ?? "windlass"));
	const harnessesHere = (machine: MachineSummary | null) => (item ? itemHarnesses(machine) : offeredHarnesses(machine));
	const hostedProfile = placeProfiles.find(p => p.available && p.platformKeys);
	const hostedProblem = (id: Exclude<HarnessId, "windlass">) => hostedAgentProblem(id, keys, !!hostedProfile);
	const runsHere = (id: HarnessId) => (item ? itemProfilesHere(chosenMachine, id).length > 0 : hardened);
	const harness: HarnessId = wantedHarness !== "windlass" && (chosenMachine ? runsHere(wantedHarness) && harnessesHere(chosenMachine).some((offered) => offered.id === wantedHarness) : !hostedProblem(wantedHarness)) ? wantedHarness : "windlass";
	const other = harness === "windlass" ? null : HARNESS_NAMES[harness];
	const sizes = chosenMachine === null ? (info?.hostedSizes ?? []).filter((size) => planSizes === null || planSizes.includes(size.id)) : [];
	const savedSize = saved.defaults?.hostedSize ?? null;
	const defaultSize = sizes.length > 1 ? startingSize(sizes, savedSize, item) : null;
	const hostedSize = defaultSize === null ? null : sizeChoice !== null && sizes.some((size) => size.id === sizeChoice) ? sizeChoice : defaultSize;
	const hostedOption = sizes.find((size) => size.id === hostedSize) ?? null;
	const harnessProblem =
		item || harnessChoice !== null || started.harness === null || started.harness === harness || machinesReading
			? null
			: `Your last agent was ${HARNESS_NAMES[started.harness]}, which ${chosenMachine ? `“${machineLabel(chosenMachine)}” does not offer now` : "is unavailable here"}, so this one is ${HARNESS_NAMES[harness]}.`;
	const catalogs = { codex: useCatalog(chosenMachine, "codex"), claude: useCatalog(chosenMachine, "claude"), opencode: useCatalog(chosenMachine, "opencode") };
	const options = harnessOptions(chosenMachine, harness, harness === "windlass" ? undefined : catalogs[harness].options, keys);
	const lastOf = last.of[harness] ?? null;

	const hasCodexSandbox = (machine: MachineSummary | null) => harness === "codex" && machine?.harnesses?.some(h => h.id === "codex" && h.modes?.includes("workspace-write"));
	// A Codex work item runs in Codex's sandbox unless "Docker, hardened" is picked (server/src/sandbox/harnesses.ts, `itemModes`).
	const askedProfile = profileChoice ?? (destination?.place.kind === "machine" ? destination.profile ?? null : null);
	const codexItemSandbox = item && hasCodexSandbox(chosenMachine) && askedProfile !== HARNESS_PROFILE;
	const profile = hasCodexSandbox(chosenMachine) && (askedProfile === "docker-windlass-sandbox" || codexItemSandbox) ? "docker-windlass-sandbox" : other ? chosenMachine ? HARNESS_PROFILE : hostedProfile?.id ?? null : startingProfile(askedProfile, defaults, info ? { profiles: placeProfiles } : null, last.of.windlass?.profile ?? null);
	const modelList = other ? options.models : models.list;
	const offers = (id: string) => modelList?.models.some((candidate) => candidate.id === id) === true;
	// An empty model lets the harness select its reported default.
	const reportedDefault = other && modelList !== null && modelList.models.length > 0 ? modelList.defaultModel : null;
	const harnessModel = (id: string) => (offers(id) ? (id === reportedDefault ? "" : id) : null);
	// A work item's agent starts on its own default model unless one is chosen here: not on the last agent's.
	const model = other ? (harnessModel(modelChoice) ?? (lastOf && !item ? harnessModel(lastOf.model) : null) ?? "") : startingModel(modelChoice, defaults, models.list, last.of.windlass?.model ?? null);
	const efforts = effortsOf(modelList, model === "" && reportedDefault !== null ? reportedDefault : model);
	const effort = efforts.includes(effortChoice) ? effortChoice : "";
	const chosenProfile = placeProfiles.find((candidate) => candidate.id === profile) ?? null;
	const launch = launchModes(harness, chosenProfile);
	const reportedModes = harness === "codex" && chosenProfile
		? codexModes(chosenProfile.id, chosenMachine ? chosenMachine.harnesses?.find(h => h.id === "codex")?.modes ?? [] : undefined)
		: options.modes;
	const modes = launch && other && reportedModes?.length ? { modes: reportedModes, default: reportedModes.some((mode) => mode.id === launch.default) ? launch.default : (reportedModes[0] as SessionMode).id } : launch;
	const mode = modes ? (modes.modes.find((candidate) => candidate.id === modeChoice) ?? (started.harness === harness ? modes.modes.find((candidate) => candidate.id === started.mode) : undefined) ?? modes.modes.find((candidate) => candidate.id === lastOf?.mode) ?? modes.modes.find((candidate) => candidate.id === modes.default) ?? null) : null;
	const claude: ClaudeFacts | null = other ? { hosted: !chosenMachine, codex: harness === "codex", opencode: harness === "opencode", mode: mode ?? { id: "build", name: "Build", description: null } } : null;
	const setup = useSetupDraft(chosen?.repository.id ?? null);

	const profileChanged = !other && defaults.profile !== null && profile !== defaults.profile;
	const modelChanged = !other && defaults.model !== null && model !== defaults.model;
	const ignored = {
		profile: repositoryDefaults.ignored.profile ?? (repositoryDefaults.profile === null ? accountDefaults.ignored.profile : null),
		model: repositoryDefaults.ignored.model ?? (repositoryDefaults.model === null ? accountDefaults.ignored.model : null),
	};
	const defaultsErrors = [chosen && saved.error ? `The defaults saved for ${repositoryName(chosen.repository)} could not be read: ${saved.error}` : null, account.settings === null && account.error ? `Your account's defaults could not be read: ${account.error}` : null].filter((line) => line !== null);

	const accountReading = account.reading && account.settings === null;
	// Wait for the selected repository and its inherited place before filing.
	const checkingKeys = !chosenMachine && wantedHarness !== "windlass" && keys === null;
	const reading = checkingKeys || (item
		? info === null || (items === null && repositoryId === undefined) || (sessions === null && repositoryId === undefined && newestItem === null) || repoReading || saved.reading || accountReading || (machinesReading && !!policy?.place && policy.place !== "hosted")
		: info === null || sessions === null || repoReading || saved.reading || accountReading || models.reading || (harness !== "windlass" && catalogs[harness].reading) || (machinesReading && wantedMachine !== null));
	const canCreate = !item && !reading && profile !== null && !repoInvalid && busy === null;
	const task = prompt.trim();
	const maxChars = item ? MAX_ITEM_BODY_CHARS : MAX_PROMPT_CHARS;
	const tooLong = prompt.length > maxChars;
	const canLaunch = canCreate && task !== "" && !tooLong;

	const filing = item ? itemOf(prompt) : null;
	const acceptance = criteria
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const criteriaWrong = acceptance.length > MAX_ACCEPTANCE_CRITERIA ? `At most ${MAX_ACCEPTANCE_CRITERIA}; there are ${acceptance.length}.` : acceptance.some((line) => line.length > MAX_NOTE_CHARS) ? `Each is at most ${count(MAX_NOTE_CHARS)} characters.` : null;
	const canFile = item && !reading && chosen !== null && filing !== null && !tooLong && criteriaWrong === null && busy === null;

	// Reuse the key if a launch or filing succeeded but its response was lost.
	const asked = useRef<Submission | null>(null);

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
				...(hostedSize ? { hostedSize } : {}),
			};
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

	const file = async (now: boolean) => {
		if (!canFile || !chosen || !filing) return;
		setOpen(null);
		setError(null);
		const mode = info?.items?.orchestrate && (!other || usePolicy) ? itemMode : "single";
		const input: Omit<CreateItemInput, "idempotencyKey"> = {
			repository: { id: chosen.repository.id, branch: chosen.branch },
			title: filing.title,
			mode,
			body: filing.body,
			acceptance,
			start: now,
			...(usePolicy ? { useDefaultPlace: true } : { place: chosenMachine ? { kind: "machine", machineId: chosenMachine.machineId } : { kind: "hosted" } }),
			...(!usePolicy && other ? { harness } : {}),
			...(!usePolicy && profile && (chosenMachine || profileChoice || other) ? { profile } : {}),
			...(model && (other || modelChoice !== "") ? { model } : {}),
			...(effort && effort !== "default" ? { effort } : {}),
			...(hostedSize ? { hostedSize } : {}),
		};
		asked.current = submissionOf(JSON.stringify(input), asked.current);
		setBusy("filing");
		try {
			const made = await client.user(auth).createItem({ ...input, idempotencyKey: asked.current.idempotencyKey });
			asked.current = null;
			setPrompt("");
			setCriteria("");
			setCriteriaOpen(false);
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
		chosen && item && platform.info?.items?.screenshots === false ? (
			<p className="ui-menu-note start-shots">Screenshots are turned off for this deployment.</p>
		) : chosen && item && saved.defaults ? (
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
	const supportsHarness = (candidate: SandboxProfile, machine: MachineSummary | null) =>
		!other || (!machine && candidate.platformKeys) || candidate.id === HARNESS_PROFILE ||
		(hasCodexSandbox(machine) && candidate.id === "docker-windlass-sandbox");
	const hasAvailableProfile = placeProfiles.some((candidate) => candidate.available && supportsHarness(candidate, chosenMachine));
	const sandboxWarn = (chosenProfile !== null && sandboxOpen(chosenProfile, claude)) || (!other && ignored.profile !== null) || defaultsErrors.length > 0 || !hasAvailableProfile;
	const profileRows = (machine: MachineSummary | null): MenuItem[] => {
		const here = machine === null ? (chosenMachine === null) : chosenMachine?.machineId === machine.machineId;
		const list = machine ? machine.profiles : (info?.profiles ?? []);
		return list
			.filter((candidate) => supportsHarness(candidate, machine))
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
		!hasAvailableProfile ? { text: chosenMachine ? `“${machineLabel(chosenMachine)}” has no sandbox that can be used right now.` : "This deployment has no sandbox that can be used right now.", warn: true } : null,
		!other && ignored.profile ? { text: ignored.profile, warn: true } : null,
		...defaultsErrors.map((line) => ({ text: line, warn: true })),
		item && chosenMachine
			? {
					text: `It runs without asking on “${machineLabel(chosenMachine)}”, inside its container, and costs no hosted time. ${chosenMachine.status === "online" ? "If the machine is away, the item waits until it is back." : `“${machineLabel(chosenMachine)}” is offline since ${clockTime(chosenMachine.since, now)}, so the item waits until it is back.`}${hardenedItemNote(chosenMachine)}`,
					warn: false,
				}
			: null,
		other && chosenMachine && !hasCodexSandbox(chosenMachine) ? { text: `${other} runs in the hardened container only.`, warn: false } : null,
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
	const repoRow: MenuItem = {
		id: "repo",
		value: "repo",
		label: repoReading ? "Repository" : repo.kind === "github" ? repositoryName(repo.picked.repository) : repo.kind === "address" && repo.url !== "" ? shortAddress(repo.url) : item ? "Choose a repository" : "No repository",
		textValue: "repository",
		description: repoReading ? "being read" : repo.kind === "github" ? `at ${repo.picked.branch}` : repo.kind === "address" && repo.url !== "" ? "cloned from its address" : item ? "a repository of your GitHub connection" : "starts in an empty repository",
		icon: repo.kind === "github" ? <RepoTile name={repo.picked.repository.name} size="sm" /> : <RepoIcon size={15} />,
		tone: repoWarn ? ("warn" as const) : undefined,
		...(phone ? (repoSpec ? { submenu: repoSpec } : { panel: addressForm }) : { onSelect: () => setTimeout(() => setOpen("repo"), 0) }),
	};
	// A work item on no machine of the user's runs hosted: only the repository is chosen.
	const whereChoices: MenuGroup[] = item && mine.length === 0 ? [] : whereGroups;
	const whereSpec: MenuSpec = {
		label: "Where it runs, and on what",
		width: 320,
		submenuWidth: 340,
		hints: { right: "open" },
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
		groups: [...whereChoices, { id: "repository", label: "Repository", items: [repoRow] }],
		footer: profileChanged ? (
			<button type="button" className="ui-menu-action start-back" onClick={() => setProfile(null)}>
				Back to the default ({whose(defaults.from.profile)}: {info?.profiles.find((candidate) => candidate.id === defaults.profile)?.name ?? defaults.profile})
			</button>
		) : undefined,
	};
	let placeName = "Hosted";
	if (chosenMachine) placeName = machineLabel(chosenMachine);
	else if (destination?.wait) placeName = policy?.place === "any-machine" ? "Any of my machines" : "Saved machine";

	const whereWarn = placeProblem !== null || chosenMachine?.status === "offline" || (!item && sandboxWarn);

	const machineEntry = chosenMachine?.harnesses?.find(entry => entry.id === harness) ?? null;
	const machineName = chosenMachine ? machineLabel(chosenMachine) : null;
	const machineProblem = chosenMachine && !hardened ? `Runs only in the hardened container, which “${machineName}” cannot make now.` : null;
	const agentButtons: { id: HarnessId; reason?: string | null }[] = [{ id: "windlass" }];
	if (chosenMachine) {
		const here = harnessesHere(chosenMachine);
		for (const { id } of here) agentButtons.push({ id, reason: machineProblem });
		for (const id of ["claude", "opencode", "codex"] as const) {
			if (here.some(h => h.id === id)) continue;
			const hosts = mine.filter(m => why(m) === null && harnessesHere(m).some(h => h.id === id));
			if (hosts.length) agentButtons.push({ id, reason: `On ${hosts.map(machineLabel).join(", ")}: choose that machine first` });
		}
	} else {
		for (const id of ["claude", "codex", "opencode"] as const) agentButtons.push({ id, reason: hostedProblem(id) });
	}

	const bySource = modelsBySource(harness, other && machineProblem ? null : modelList);
	const rowsFor = (source: ModelSource | null): MenuItem[] => (bySource.get(source) ?? []).map(({ id, name: reportedName }) => {
		const name = cleanModelName(id, other ? reportedName : null);
		const isDefault = id === modelList?.defaultModel;
		return {
			id: `${harness}:${id}`, label: name, textValue: `${name} ${id}`,
			icon: source ? <ProviderGlyph source={source} /> : <AgentGlyph harness={HARNESS_NAMES[harness]} />,
			trailing: isDefault && !saysDefault(name) ? <span className="ui-tag">default</span> : undefined,
			checked: other && !model ? isDefault : model === id,
			onSelect: () => { setHarness(harness); setModel(id); },
		};
	});
	const defaultRows = rowsFor(null);
	if (!bySource.size) {
		const name = HARNESS_NAMES[harness];
		let label: string = name;
		let description: string;
		if (harness === "windlass") {
			label = model || "Your default model";
			description = models.reading ? "Reading your models…" : `${models.error ?? "Your models could not be read."} The agent starts on your default model.`;
		} else if (chosenMachine && !machineProblem) {
			label = `${name}'s default model`;
			description = catalogs[harness].reading ? "Reading models…" : `“${machineName}”'s runner reports ${name}'s models once it has checked.`;
		} else description = machineProblem ?? "Use your Settings key";
		const blocked = !!(other && machineProblem);
		defaultRows.push({ id: `${harness}:${blocked ? "none" : "default"}`, label, description, icon: <AgentGlyph harness={name} accent={!other} />,
			...(chosenMachine && other && !blocked && { value: harness }), disabled: blocked, checked: !blocked, onSelect: () => setHarness(harness) });
	}
	const sources = MODEL_SOURCES.filter((source) => bySource.has(source));
	// One tab per provider: a ChatGPT plan's models and an OpenAI key's are both OpenAI's.
	const tabOf = (source: ModelSource): ModelSource => (source === "chatgpt" ? "openai" : source);
	const tabs = [...new Set(sources.map(tabOf))];
	const shownTab = providerTab !== null && tabs.includes(providerTab) ? providerTab : null;
	const modelGroups: MenuGroup[] = [
		...(defaultRows.length && shownTab === null ? [{ id: "agent-default", items: defaultRows }] : []),
		...sources.filter((source) => shownTab === null || tabOf(source) === shownTab).map((source) => ({
			id: `provider:${source}`,
			label: SOURCE_NAMES[source],
			note: credentialWords(harness, source, machineEntry, machineName) || undefined,
			items: rowsFor(source),
		})),
	];
	const chooseAgent = (id: HarnessId) => {
		if (id === harness) return;
		setHarness(id);
		setModel("");
		setProviderTab(null);
	};
	const agentSwitch = (
		<div className="picker-agents">
			<div className="agent-switch" role="group" aria-label="Switch agent">
				{agentButtons.map(({ id, reason }) => {
					const chosen = harness === id;
					return (
						<Tooltip key={id} content={reason ? `${HARNESS_NAMES[id]}: ${reason}` : HARNESS_NAMES[id]}>
							<button
								type="button"
								className={`agent-switch-button${chosen ? " agent-switch-chosen" : ""}`}
								aria-pressed={chosen}
								aria-label={HARNESS_NAMES[id]}
								aria-disabled={!!reason || undefined}
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => !reason && chooseAgent(id)}
							>
								<AgentLogo id={id} size={17} />
							</button>
						</Tooltip>
					);
				})}
			</div>
			<span className="picker-agent-name">
				{HARNESS_NAMES[harness]}
				<span className="picker-agent-where">{chosenMachine ? `on ${machineName}` : harness === "windlass" ? "hosted or any machine" : "hosted"}</span>
			</span>
		</div>
	);
	const providerTabs =
		tabs.length > 1 ? (
			<div className="picker-providers" role="toolbar" aria-label="Show one provider's models">
				<span className="picker-providers-label" aria-hidden="true">
					{shownTab ? SOURCE_NAMES[shownTab] : "All providers"}
				</span>
				{tabs.map((tab) => (
					<Tooltip key={tab} content={shownTab === tab ? "Show every provider" : `Only ${SOURCE_NAMES[tab]}`}>
						<button type="button" className="picker-provider" data-source={tab} aria-label={SOURCE_NAMES[tab]} aria-pressed={shownTab === tab} onPointerDown={(event) => event.preventDefault()} onClick={() => setProviderTab(shownTab === tab ? null : tab)}>
							<ProviderLogo provider={tab === "other" ? "opencode" : tab} size={13} />
						</button>
					</Tooltip>
				))}
			</div>
		) : null;
	const displayModel = model || reportedDefault;
	const reportedName = other && displayModel ? (model ? modelName(modelList, model) : modelLabel(modelList, displayModel)) : null;
	const agentModel = displayModel ? cleanModelName(displayModel, reportedName) : "default model";
	const agentSpec: MenuSpec = {
		label: "Agent and model",
		width: 340,
		maxHeight: 540,
		filter: bySource.size && (modelList?.models.length ?? 0) > 7 ? { placeholder: "Filter models…" } : undefined,
		header: (
			<>
				{agentSwitch}
				{providerTabs}
				{(["claude", "opencode", "codex"] as const).map(id => catalogs[id].error && <p key={id} role="status">
					{HARNESS_NAMES[id]} models: {catalogs[id].error} <button type="button" className="link" onClick={catalogs[id].retry}>Retry</button>
				</p>)}
				{harnessProblem ? <p className="tone-warn" role="status">{harnessProblem}</p> : null}
				{!other && ignored.model ? <p className="tone-warn">{ignored.model}</p> : null}
			</>
		),
		groups: modelGroups,
		footer: (
			<>
				{item && other ? <p className="ui-menu-note">{other} works on the item in the hardened container without asking, and runs Quick: Plan first is Windlass's.{capabilitiesOf(harness).checks === "platform" ? " The platform runs this repository's saved checks when it ends a turn." : capabilitiesOf(harness).checks === "none" ? " It does not run this repository's checks, so CI decides." : ""}</p> : null}
				{other && !chosenMachine ? <p className="ui-menu-note">Hosted agents always use your Settings keys.</p> : null}
				{other && chosenMachine ? <p className="ui-menu-note">Choose whose sign-in it uses on the <a className="link" {...linkProps({ name: "machines" })}>Machines</a> page.{onPullRequest(harness)}</p> : null}
				{!other && modelList && modelList.source !== "account" ? <p className="ui-menu-note">{modelsNote(modelList)}</p> : null}
				{other && chosenMachine && machineEntry && machineEntry.signIn !== "token" ? (
					<details className="agent-commands">
						<summary>Sign-in command</summary>
						<HarnessStatus harness={machineEntry} />
					</details>
				) : null}
				{modelChanged ? (
					<button type="button" className="ui-menu-action start-back" onClick={() => setModel("")}>
						Back to the default ({whose(defaults.from.model)}: {cleanModelName(defaults.model ?? "")})
					</button>
				) : null}
			</>
		),
	};
	const effortSpec: MenuSpec | null = efforts.length > 0 ? { label: "Effort", width: 220, groups: [effortGroup(efforts, effort, agentModel, setEffort)], hints: false } : null;
	const agentValue = `${HARNESS_NAMES[harness]} · ${agentModel}`;
	const agentWarn = harnessProblem !== null || (!other && ignored.model !== null);

	const criteriaValue = acceptance.length === 0 ? "none" : count(acceptance.length);
	const criteriaField = (
		<div className="start-criteria">
			<label className="label" htmlFor={ids.criteria}>
				Done when<span className="label-optional">optional</span>
			</label>
			<textarea id={ids.criteria} className={`input textarea item-criteria${criteriaWrong ? " input-invalid" : ""}`} value={criteria} onChange={(event) => setCriteria(event.target.value)} readOnly={busy !== null} aria-describedby={ids.criteriaNote} aria-invalid={criteriaWrong !== null || undefined} data-autofocus />
			<p className={`field-note${criteriaWrong ? " tone-bad" : ""}`} id={ids.criteriaNote}>
				{criteriaWrong ?? "One per line. The agent is given them, and the verdict lists them for you to check: no machine checks them."}
			</p>
		</div>
	);

	const orchestrateOffered = item && Boolean(info?.items?.orchestrate);
	const quickOnly = !!other && !usePolicy;
	const orchestrating = orchestrateOffered && itemMode === "orchestrate" && !quickOnly;
	const orchestrateWarn = orchestrating ? orchestrateProblem(saved.checks) : null;
	const shownItemMode: ItemMode = quickOnly ? "single" : itemMode;

	const hasSetup = chosen !== null && !item;
	const setupForm = hasSetup ? (
		<div className="start-setup">
			<SetupField egress={chosenMachine?.egress ?? (chosenMachine ? undefined : info?.hostedEgress)} hosted={!chosenMachine} domains={chosenMachine?.egressDomains} setup={setup} repository={repositoryName(chosen.repository)} disabled={busy !== null} />
			{!other ? <SecretsField repositoryId={chosen.repository.id} repository={repositoryName(chosen.repository)} profile={profile} disabled={busy !== null} /> : null}
		</div>
	) : null;
	const setupSummary = hasSetup ? (setup.draft.text.trim() === "" ? "no setup command" : setup.draft.text.trim().split("\n")[0]) : null;

	const reason = item
		? info === null
			? "Asking the server what it offers…"
			: busy === "filing"
				? "Filing the work item…"
				: reading
					? "Reading your repositories…"
					: repoMissing
						? "A work item needs a repository: choose one under “where”."
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
		width: item ? 300 : 260,
		hints: false,
		groups: [
			...(item && orchestrateOffered
				? [
						{
							id: "how",
							label: "How it runs",
							items: (["orchestrate", "single"] as const).map((one) => ({
								id: one,
								value: one,
								label: ITEM_MODE_WORDS[one].name,
								description: one === "orchestrate" && quickOnly ? `${other} runs Quick: Plan first is Windlass's.` : ITEM_MODE_LINES[one],
								wrap: true,
								checked: shownItemMode === one,
								disabled: busy !== null || (one === "orchestrate" && quickOnly),
								onSelect: () => setItemMode(one),
							})),
						},
					]
				: []),
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
	const launchLabel = item && orchestrateOffered && busy === null ? `${launchWord} · ${ITEM_MODE_WORDS[shownItemMode].name}` : launchWord;

	const facts = !item && chosenProfile ? sandboxFacts(chosenProfile, claude) : [];
	const where = chosenMachine ? `runs on ${machineLabel(chosenMachine)}` : hostedOption ? `runs hosted, ${sizeName(hostedOption.id)} (${sizeSpec(hostedOption.id)}${perHour(hostedOption.usdPerHour) ? `, about ${perHour(hostedOption.usdPerHour)}` : ""})` : "runs hosted";
	const anyOpen = facts.some((fact) => fact.open);
	const safety = facts.length > 0 ? sentence([...facts.map((fact) => fact.long), where]) : null;

	const modeOpen = mode !== null && OPEN_MODES.has(mode.id);
	const modeRows: MenuItem[] = modes && mode ? (modeMenu(modes.modes, mode.id, setMode, modeOpen).groups[0]?.items ?? []).map((row) => ({ ...row, wrap: true })) : [];
	const optionsGroups: MenuGroup[] = item
		? [
				{
					id: "repository",
					label: "Repository",
					items: [
						chosen
							? {
									id: "saved",
									label: "Saved settings",
									description: platform.info?.items?.screenshots === false ? "Screenshots are off for this deployment" : saved.defaults ? (saved.defaults.screenshots ? "Its agents take screenshots for their reports" : "Screenshots are off for this repository") : `What is saved for ${chosen.repository.name}`,
									icon: <SlidersIcon size={15} />,
									onSelect: () => navigate({ name: "repository", id: chosen.repository.id, view: "settings", section: saved.defaults ? "screenshots" : undefined }),
								}
							: { id: "saved", label: "Saved settings", description: "Choose a repository first", icon: <SlidersIcon size={15} />, disabled: true },
					],
				},
			]
		: [{ id: "modes", label: "Mode", items: modeRows.length > 0 ? modeRows : [{ id: "mode:none", label: "No modes", description: "This agent has no modes to choose", disabled: true }] }];
	const sizeGroups: MenuGroup[] = hostedSize
		? [
				{
					id: "size",
					label: "Hosted size",
					items: sizes.map((size) => ({
						id: `size:${size.id}`,
						value: size.id,
						label: `${sizeName(size.id)} · ${sizeSpec(size.id)}`,
						description: size.id === savedSize && chosen ? `Saved for ${chosen.repository.name}` : size.id === defaultSize ? (item ? "The default for work items" : "The default for agents") : undefined,
						trailing: perHour(size.usdPerHour) ?? undefined,
						checked: hostedSize === size.id,
						disabled: busy !== null,
						onSelect: () => setSizeChoice(size.id),
					})),
				},
			]
		: [];
	const optionsSpec: MenuSpec = {
		label: item ? "Filing options" : "Options",
		width: 320,
		hints: false,
		groups: [...sizeGroups, ...optionsGroups],
		footer:
			safety || (item && chosenMachine) ? (
				<p className={`ui-menu-note tray-safety${anyOpen ? " tone-warn" : ""}`}>
					{anyOpen ? <WarnIcon size={13} /> : <LockIcon size={13} />}
					<span>{safety ?? whereNotes.find((note) => !note.warn)?.text}</span>
				</p>
			) : undefined,
	};
	const optionsLabel = item ? "Filing options" : `Options${mode ? `: mode ${mode.name}` : ""}${hostedSize ? `, ${sizeName(hostedSize)} sandbox` : ""}`;

	const criteriaLine = item ? (
		criteriaOpen ? (
			<div className="start-criteria-inline">
				{criteriaField}
				<button type="button" className="button button-quiet button-small start-criteria-done" onClick={() => {
					setCriteriaOpen(false);
					area.current?.focus();
				}}>
					Done
				</button>
			</div>
		) : acceptance.length > 0 ? (
			<div className="start-criteria-list" data-picker="criteria-list">
				<ul aria-label="Done when">
					{acceptance.slice(0, 4).map((line, index) => (
						<li key={index}>
							<CheckIcon size={12} />
							<span>{line}</span>
						</li>
					))}
					{acceptance.length > 4 ? <li className="start-criteria-more">and {count(acceptance.length - 4)} more</li> : null}
				</ul>
				<button type="button" className="link start-criteria-edit" data-picker="criteria" data-value={criteriaValue} onClick={() => setCriteriaOpen(true)} aria-label={`Done-when criteria: ${criteriaValue}. Edit`}>
					Edit
				</button>
				{criteriaWrong ? <p className="field-note tone-bad">{criteriaWrong}</p> : null}
			</div>
		) : (
			<button type="button" className="start-criteria-add" data-picker="criteria" data-value={criteriaValue} onClick={() => setCriteriaOpen(true)} disabled={busy !== null}>
				<PlusIcon size={13} />
				Add done-when criteria
			</button>
		)
	) : null;

	return (
		<form
			className={`composer start start-line${item ? " start-item" : ""}${busy ? " composer-busy" : ""}${phone ? " start-phone" : ""}`}
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
				{criteriaLine}
				<div className="start-tools tray">
					{hasSetup ? (
						<Tooltip content="Setup command and secrets">
							<button type="button" ref={anchors.plus} className="tray-icon start-plus" data-picker="setup" aria-haspopup="dialog" aria-expanded={open === "plus"} aria-label={`Setup command and secrets${setupSummary ? `: ${setupSummary}` : ""}`} onClick={() => setOpen(open === "plus" ? null : "plus")}>
								<PlusIcon size={15} />
							</button>
						</Tooltip>
					) : null}
					<Menu
						spec={agentSpec}
						open={open === "agent"}
						onOpenChange={openOnly("agent")}
						surface={phone ? undefined : "popover"}
						trigger={(props) => (
							<AgentPill trigger={props} harness={harness} name={HARNESS_NAMES[harness]} model={agentModel} dot={agentWarn ? "warn" : modelChanged ? "changed" : null} dotLabel={harnessProblem ? "the last agent cannot be used here" : agentWarn ? "the saved default cannot be used" : undefined} changed={modelChanged} data-value={agentValue} />
						)}
					/>
					{effortSpec ? <Menu spec={effortSpec} open={open === "effort"} onOpenChange={openOnly("effort")} surface={phone ? undefined : "popover"} trigger={(props) => <EffortButton trigger={props} effort={effort} efforts={efforts} />} /> : null}
					<span className="tray-where-anchor" ref={anchors.where}>
						<Menu
							spec={whereSpec}
							open={open === "where"}
							onOpenChange={openOnly("where")}
							surface={phone ? undefined : "popover"}
							trigger={(props) => (
								<WherePill
									trigger={props}
									machine={chosenMachine !== null}
									place={placeName}
									repository={repo.kind === "github" ? repositoryName(repo.picked.repository) : repo.kind === "address" && repo.url !== "" ? shortAddress(repo.url) : null}
									branch={repo.kind === "github" ? repo.picked.branch : null}
									empty={item ? "Choose a repository" : "No repository"}
									emptyShort={item ? "Repo?" : "No repo"}
									required={item}
									reading={repoReading}
									dot={whereWarn || repoWarn ? "warn" : profileChanged ? "changed" : chosenMachine ? (chosenMachine.status === "online" ? "ok" : "off") : null}
									dotLabel={whereWarn || repoWarn ? "something is open, or cannot be used: see its menu" : chosenMachine ? chosenMachine.status : undefined}
									changed={profileChanged}
									data-value={placeName}
									data-sandbox={chosenProfile?.name ?? "none"}
									data-repo={repoValue}
								/>
							)}
						/>
					</span>
					<span className="start-tools-end tray-end">
						<Menu spec={optionsSpec} open={open === "options"} onOpenChange={openOnly("options")} align="end" surface={phone ? undefined : "popover"} trigger={(props) => <OptionsButton trigger={props} label={optionsLabel} value={mode?.name} dot={modeOpen || orchestrateWarn !== null ? "warn" : null} />} />
						{safety && !phone ? (
							<LockHint sentence={safety} open={anyOpen}>
								<span className="visually-hidden">
									{facts.map((fact) => (
										<span key={fact.text} className={fact.open ? "start-fact-open" : undefined}>
											{fact.text} ({fact.long})
										</span>
									))}
									<span>{where}</span>
								</span>
							</LockHint>
						) : null}
						<SplitButton type="submit" className="start-launch" icon={<ArrowUpIcon size={14} />} disabled={item ? !canFile : !canLaunch} menu={launchMenu} menuLabel={item ? "Filing options" : "Launch options"} aria-label={launchLabel} data-mode={item && orchestrateOffered ? shownItemMode : undefined}>
							<span className="tray-hide-phone">{launchLabel}</span>
						</SplitButton>
					</span>
					{repoSpec && !phone ? (
						<Popover open={open === "repo"} anchor={anchors.where} onClose={close} width={repoSpec.width ?? 340} maxHeight={repoSpec.maxHeight ?? 420} role="group" label={repoSpec.label} initialFocus="none" className="ui-pop-menu">
							<MenuList spec={repoSpec} surface="popover" onClose={close} />
						</Popover>
					) : (
						<PickerPanel open={open === "repo"} onClose={close} anchor={anchors.where} title="Repository" surface="popover">
							{addressForm}
						</PickerPanel>
					)}
					<PickerPanel open={open === "plus"} onClose={close} anchor={anchors.plus} title={`Before the agent starts${chosen ? ` · ${chosen.repository.name}` : ""}`} width={380}>
						{setupForm}
					</PickerPanel>
				</div>
			</div>
			{filing ? (
				<p className="start-line-note start-title">
					Title: <span className="start-title-text">{filing.title}</span>
				</p>
			) : null}
			{orchestrateWarn ? (
				<p className="field-note tone-warn start-line-note" role="status">
					{orchestrateWarn}
				</p>
			) : null}
			{filed && !filing ? (
				<p className="field-note start-line-note start-filed" role="status">
					Filed “{filed.title}”{filed.started ? (filed.feature ? ": its plan comes to you for approval" : "") : " as a draft"}.{" "}
					<a className="link" {...linkProps({ name: "item", id: filed.id })}>
						Open
					</a>
				</p>
			) : null}
			{chosenMachine?.status === "offline" && !item ? (
				<p className="field-note tone-warn start-line-note" role="status">
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

function sentence(parts: readonly string[]): string {
	return parts
		.map((part) => part.trim().replace(/\.$/, ""))
		.filter((part) => part !== "")
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}.`)
		.join(" ");
}

/** A model's provider mark in the square an agent's badge has (`AgentGlyph`). */
function ProviderGlyph({ source }: { source: ModelSource }) {
	return (
		<span className="ui-glyph ui-glyph-logo" aria-hidden="true" data-source={source}>
			<ProviderLogo provider={source === "other" ? "opencode" : source} size={12} />
		</span>
	);
}
