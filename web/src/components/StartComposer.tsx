import { resolveDefaultPlace, savedPlace } from "../../../server/src/factory/default-place";
/**
 * The start of an agent: a composer, not a form. Typing the task and pressing Enter launches it with
 * the choices already standing. The choices are one line inside the composer's box (the pieces are
 * components/TrayControls.tsx): "+" for the repository's setup command and secrets; the agent with its
 * model and effort bars, whose menu holds the agents' models and, last, the effort; one "where" pill,
 * the place and the repository at a branch, whose menu holds where it runs (hosted or one of the
 * user's machines, each with its sandboxes in a submenu) and the repository (filtered as you type,
 * branches in a submenu); an options icon for the rarer settings (the mode, and the sentence on what
 * the sandbox lets the agent's commands do); a lock whose tooltip is that sentence; and Launch, a split
 * button whose menu creates the agent without sending the task. On a phone the same line keeps its
 * glyphs and the repository's name, and each menu opens as a sheet. Home and a repository's page have
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
 * On the Factory page (`kind` "item") it files a work item: the text's first line is the item's title
 * and the rest what to do (`itemOf`), a repository of the GitHub connection is required, and the line
 * is the same: the agent and model, where (the place and the repository), options, and File. File's
 * main button says how the item runs, "File · Plan first" or "File · Quick", the last choice in this
 * browser; its menu switches between them and files a draft. The done-when criteria are one line under
 * the text, opened only when used. An item runs Windlass in its profile's mode unless an agent
 * its machine is signed into is chosen (`itemHarnesses`), which runs Quick and without asking (Codex: in its own sandbox by default, without asking only on "Docker, hardened"). Its effort, one its agent offers for the model, runs every turn of the item. Enter files and starts it,
 * the launch menu files a draft, and the page stays where it is: filing several in a row is the
 * factory's normal use. The repository starts on the page's, else the newest item's, else the newest
 * agent's.
 */
import { monthReset, monthState } from "../lib/hosted";
import { MAX_ACCEPTANCE_CRITERIA, MAX_ITEM_BODY_CHARS, MAX_NOTE_CHARS, MAX_PROMPT_CHARS, USAGE_LOW_SHARE, type CreateItemInput, type GithubId, type HostedSize, type ItemMode, type ItemSummary, type HarnessId, type HarnessOptions, type MachineSummary, type RepositoryDefaults, type SandboxProfile, type SandboxProfileId, type SessionMode, type SessionSummary, type UsageNumbers } from "@contract";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { hasReason } from "../api/client";
import { isLimitRefusal } from "../api/errors";
import { HARNESS_NAMES, signInWords } from "../lib/acp";
import { count, localTime, sandboxTime } from "../lib/format";
import { effortsOf, harnessOptions, modelLabel, modelName, modelsNote, saysDefault } from "../lib/models";
import { OPEN_MODES, launchModes } from "../lib/modes";
import { itemOf, lastUsed, layerChoices, repositoryName, startedOn, startingChoices, startingModel, startingProfile } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { perHour, sizeName, sizeSpec, startingSize } from "../lib/sizes";
import { clockTime, useMachines } from "../screens/Machines";
import { useApp, useAuth } from "../state/app";
import { takeLaunchDraft, useGithub } from "../state/github";
import { handOver } from "../state/handover";
import { allowanceState, useAccount, useAllowance, useModels, useNow } from "../state/hooks";
import { ArrowUpIcon, CheckIcon, CloudIcon, LockIcon, MachineIcon, PlusIcon, RepoIcon, SlidersIcon, WarnIcon } from "./Icons";
import { accessTokenFact, claudeLoginFact, commandNetworkFact, type ClaudeFacts } from "./Layers";
import { modeMenu } from "./Modes";
import { codexModes } from "../../../server/src/sandbox/codex-modes.js";
import { capabilitiesOf, machineAgentLine, machineHarness } from "../../../server/src/sandbox/harnesses.js";
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
import { AgentPill, LockHint, OptionsButton, WherePill, effortGroup } from "./TrayControls";
import { SplitButton } from "./ui/Button";
import { Tooltip } from "./ui/Tooltip";
import { useSurface } from "./ui/useMediaQuery";
import { hardenedItemNote, machineLabel } from "../lib/machines";

import { ITEM_MODE_WORDS, orchestrateProblem } from "../lib/feature";

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
		claude && (claude.codex || claude.opencode || profile.claudeRelay) && !profile.commandNetwork && profile.available
			? { text: claude.codex ? "Codex relay" : claude.opencode ? "OpenCode relay" : "Claude relay only", long: commandNetworkFact(profile, claude), open: false }
			: { text: profile.commandNetwork ? "network on" : "no network", long: commandNetworkFact(profile, claude), open: profile.commandNetwork },
		claude?.codex ? {text:"credentials on machine", long:"Commands can use the Codex model relay. OpenAI credentials stay on the machine.",open:true} : claude?.opencode
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

/** What launching runs into now, before anything is sent: `warn` when the agent could not start at all. */
function launchLimit(numbers: UsageNumbers | null, hostedNotice = false): { text: string; warn: boolean } | null {
	if (numbers === null) return null;
	const left = allowanceState(numbers, USAGE_LOW_SHARE);
	const resets = localTime(numbers.resetsAt);
	// The month's hosted minutes, where a plan sets them: one on the user's own machine is never counted.
	// Near the limit the page's own notice says so (components/Plan.tsx); at it, what launching here does, unless that notice is on the page too.
	if (numbers.hosted && monthState(numbers) === "used") return hostedNotice ? null : { warn: true, text: `Hosted minutes are used up until ${monthReset(numbers.hosted)}. A hosted agent launched now is created, and waits; one on your own machine starts at once.` };
	if (left === "used") return { warn: true, text: `Today's sandbox time is used up. An agent launched now is created, and cannot start working before ${resets}, when the allowance is whole again.` };
	const { kept, limit } = numbers.sandboxes;
	if (limit !== null && kept >= limit) return { warn: true, text: `You keep ${limit} hosted sandboxes, the most an account may have. An agent launched here now is created, and cannot start working until you free one. One on your own machine is not counted.` };
	if (left === "low" && numbers.leftSeconds !== null) return { warn: false, text: `${sandboxTime(numbers.leftSeconds)} of today's sandbox time is left. A turn that runs longer is stopped, with its files kept; the allowance is whole again at ${resets}.` };
	return null;
}

/** What is saved as the defaults of the repository that is chosen: read when the choice changes. `defaults` is null while it is read and when it could not be. */
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
	// What was read for another repository is not this one's.
	const mine = state.repositoryId === repositoryId;
	return { defaults: mine ? state.defaults : null, checks: mine ? state.checks : null, reading: repositoryId !== null && (!mine || (state.defaults === null && state.error === null)), error: mine ? state.error : null };
}

/** Fetch the chosen machine's catalog once per digest, even as its host samples change. */
export function useCatalog(machine: MachineSummary | null, id: "claude" | "opencode" | "codex") {
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

/** The pickers the composer opens: one at a time. "repo" is the address form, opened from the where menu. */
type Picker = "repo" | "where" | "agent" | "options" | "plus";

const ITEM_MODE_KEY = "wlp.factory.item-mode";

/** How the last work item filed in this browser runs; Plan first where it keeps nothing. */
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

function safeStorage(): Storage | null {
	try {
		return typeof localStorage === "undefined" ? null : localStorage;
	} catch {
		return null;
	}
}

/** The two ways a work item runs, as File's menu says them. */
export const ITEM_MODE_LINES: Record<ItemMode, string> = {
	orchestrate: "A planner splits it into subtasks you approve, then they run.",
	single: "One agent goes straight to a pull request.",
};

/** "github.com/acme/web" for a pasted address: the chip's few words. */
const shortAddress = (url: string) => url.replace(/^https:\/\//, "").replace(/\.git$/, "");

export interface StartComposerProps {
	/** The user's sessions, live: what their newest agents were launched with. Null until they arrive. */
	sessions: readonly SessionSummary[] | null;
	/** GitHub's id of the repository to start on, when it was opened from that repository's page. */
	repositoryId?: GithubId;
	/** Puts the focus in the field when it is shown. */
	autoFocus?: boolean;
	/** What it starts on: an agent, or a work item to file (the Factory page). Work items need the deployment to offer them. */
	kind?: StartKind;
	/** The user's work items, live, where the page has them: a work item starts on the newest one's repository. Null until they arrive. */
	items?: readonly ItemSummary[] | null;
	/** The page shows the month's hosted minutes in its own notice (components/Plan.tsx, `HostedNotice`): not said again here. */
	hostedNotice?: boolean;
}

export type StartKind = "agent" | "item";

/** The refusals of a machine that the list of machines may be behind on: it is read again. */
const MACHINE_REFUSALS = ["machine_not_found", "machine_not_connected", "runner_outdated", "bad_profile"] as const;

export function StartComposer({ sessions, repositoryId, autoFocus = false, kind: kindChoice = "agent", items, hostedNotice = false }: StartComposerProps) {
	const { client, platform, explain } = useApp();
	const auth = useAuth();
	const info = platform.info;
	const github = useGithub();
	const allowance = useAllowance();
	const limit = launchLimit(allowance, hostedNotice);
	// Where the deployment has plans, the sizes the account's plan offers (Free has no large).
	const planSizes = allowance?.hosted?.plan ? (info?.billing?.plans.find((plan) => plan.id === allowance.hosted!.plan)?.sizes ?? null) : null;
	const surface = useSurface();
	const phone = surface === "sheet";
	const ids = { text: useId(), hint: useId(), keys: useId(), repo: useId(), repoLabel: useId(), repoNote: useId(), criteria: useId(), criteriaNote: useId() };
	// What the composer held before its user left to connect GitHub, once.
	const [draft] = useState(takeLaunchDraft);

	const [prompt, setPrompt] = useState(draft?.prompt ?? "");
	// Agent or work item: the page's. Without work items on this deployment, an agent.
	const item = kindChoice === "item" && Boolean(info?.items);
	// How a work item runs: what it was before leaving for GitHub, else the last choice in this browser.
	const [itemMode, setItemModeState] = useState<ItemMode>(() => draft?.itemMode ?? loadItemMode());
	const setItemMode = (mode: ItemMode) => {
		setItemModeState(mode);
		saveItemMode(mode);
	};
	const [criteria, setCriteria] = useState(draft?.criteria ?? "");
	const [criteriaOpen, setCriteriaOpen] = useState(false);
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
	const [harnessChoice, setHarness] = useState<HarnessId | null>(draft?.harness === "windlass" || draft?.harness === "claude" || draft?.harness === "opencode" || draft?.harness === "codex" ? draft.harness : null);
	const [modeChoice, setMode] = useState<string | null>(draft?.mode ?? null);
	/** The hosted size chosen here; null: the repository's saved one, else the default for agents or work items. */
	const [sizeChoice, setSizeChoice] = useState<HostedSize | null>(null);
	const [open, setOpen] = useState<Picker | null>(null);
	const [busy, setBusy] = useState<"creating" | "prompting" | "filing" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const anchors = { where: useRef<HTMLSpanElement>(null), plus: useRef<HTMLButtonElement>(null) };
	const search = useRepositorySearch(open === "repo" || open === "where", github.status?.connection?.connectedAt ?? null);
	const branches = useBranches();

	// Back from GitHub: the where menu is open, where its user left. Connected from the popup, it
	// opens again once the connection is there, with the repositories in it.
	const returned = github.notice?.where === "launch" || github.busy === "finishing";
	const nowConnected = github.status?.connection != null;
	useEffect(() => {
		if (!returned) return;
		// After the swap has settled: the address form's focus going back to the pill closes the list as it opens.
		const timer = setTimeout(() => setOpen(phone ? "where" : "repo"), 0);
		return () => clearTimeout(timer);
	}, [returned, nowConnected, phone]);

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
	// Items inherit the repository or account placement. Personal agents remember their last start.
	const started = startedOn(account.settings?.lastStart ?? null);
	const lastMachineId = !item && started.place?.kind === "machine" ? started.place.machineId : null;
	const policy = item && placeChoice === undefined ? savedPlace(saved.defaults, account.settings?.defaults) : undefined;
	const usePolicy = !!policy && harnessChoice === null && profileChoice === null;
	const destination = policy && resolveDefaultPlace(policy, mine, usePolicy && info?.items?.orchestrate ? itemMode : "single");
	const wantedMachine = placeChoice !== undefined ? placeChoice : destination?.place.kind === "machine" ? destination.place.machineId : lastMachineId;
	// A machine that was removed or can no longer be chosen leaves the agent on this platform, which its chip says.
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
	const placeProfiles = chosenMachine ? chosenMachine.profiles : (info?.profiles ?? []);
	// Another harness runs in the hardened container (Codex also in the Windlass sandbox): without one that can be used it cannot be chosen, and a machine that does not offer it leaves Windlass.
	const hardened = placeProfiles.some((candidate) => candidate.id === HARNESS_PROFILE && candidate.available);
	// A work item starts on Windlass unless chosen otherwise, and only on an agent its machine is signed into.
	const wantedHarness = harnessChoice ?? (item ? destination?.harness ?? "windlass" : (started.harness ?? "windlass"));
	const harnessesHere = (machine: MachineSummary | null) => (item ? itemHarnesses(machine) : offeredHarnesses(machine));
	const runsHere = (id: HarnessId) => (item ? itemProfilesHere(chosenMachine, id).length > 0 : hardened);
	const harness: HarnessId = wantedHarness !== "windlass" && runsHere(wantedHarness) && harnessesHere(chosenMachine).some((offered) => offered.id === wantedHarness) ? wantedHarness : "windlass";
	const other = harness === "windlass" ? null : HARNESS_NAMES[harness];
	// ---- the hosted size: where the deployment offers more than one, for a hosted sandbox -----------------
	const sizes = chosenMachine === null && other === null ? (info?.hostedSizes ?? []).filter((size) => planSizes === null || planSizes.includes(size.id)) : [];
	const savedSize = saved.defaults?.hostedSize ?? null;
	const defaultSize = sizes.length > 1 ? startingSize(sizes, savedSize, item) : null;
	const hostedSize = defaultSize === null ? null : sizeChoice !== null && sizes.some((size) => size.id === sizeChoice) ? sizeChoice : defaultSize;
	const hostedOption = sizes.find((size) => size.id === hostedSize) ?? null;
	// The agent the last one was, where it cannot be this one's: said in the agent's picker.
	const harnessProblem =
		item || harnessChoice !== null || started.harness === null || started.harness === harness || machinesReading
			? null
			: `Your last agent was ${HARNESS_NAMES[started.harness]}, which ${chosenMachine ? `“${machineLabel(chosenMachine)}” does not offer now` : "runs only on a machine of yours"}, so this one is ${HARNESS_NAMES[harness]}.`;
	const catalogs = { codex: useCatalog(chosenMachine, "codex"), claude: useCatalog(chosenMachine, "claude"), opencode: useCatalog(chosenMachine, "opencode") };
	const selectedCatalog = harness === "windlass" ? null : catalogs[harness];
	const options = harnessOptions(chosenMachine, harness, selectedCatalog?.options);
	const lastOf = last.of[harness] ?? null;

	// ---- the sandbox, the model and effort, the mode ------------------------------------------
	const hasCodexSandbox = (machine: MachineSummary | null) => harness === "codex" && machine?.harnesses?.some(h => h.id === "codex" && h.modes?.includes("workspace-write"));
	// A Codex work item runs in Codex's sandbox unless "Docker, hardened" is picked (server/src/sandbox/harnesses.ts, `itemModes`).
	const askedProfile = profileChoice ?? (destination?.place.kind === "machine" ? destination.profile ?? null : null);
	const codexItemSandbox = item && hasCodexSandbox(chosenMachine) && askedProfile !== HARNESS_PROFILE;
	const profile = hasCodexSandbox(chosenMachine) && (askedProfile === "docker-windlass-sandbox" || codexItemSandbox) ? "docker-windlass-sandbox" : other ? HARNESS_PROFILE : startingProfile(askedProfile, defaults, info ? { profiles: placeProfiles } : null, last.of.windlass?.profile ?? null);
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
	const reportedModes = harness === "codex" && chosenProfile
		? codexModes(chosenProfile.id, chosenMachine?.harnesses?.find(h => h.id === "codex")?.modes ?? [])
		: options.modes;
	// Claude Code's modes as its machine reported them, where it did.
	const modes = launch && other && reportedModes?.length ? { modes: reportedModes, default: reportedModes.some((mode) => mode.id === launch.default) ? launch.default : (reportedModes[0] as SessionMode).id } : launch;
	const mode = modes ? (modes.modes.find((candidate) => candidate.id === modeChoice) ?? (started.harness === harness ? modes.modes.find((candidate) => candidate.id === started.mode) : undefined) ?? modes.modes.find((candidate) => candidate.id === lastOf?.mode) ?? modes.modes.find((candidate) => candidate.id === modes.default) ?? null) : null;
	const claude: ClaudeFacts | null = other ? { codex: harness === "codex", opencode: harness === "opencode", mode: mode ?? { id: "build", name: "Build", description: null } } : null;
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
	// Wait for the selected repository and its inherited place before filing.
	const reading = item
		? info === null || (items === null && repositoryId === undefined) || (sessions === null && repositoryId === undefined && newestItem === null) || repoReading || saved.reading || accountReading || (machinesReading && !!policy?.place && policy.place !== "hosted")
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
				...(hostedSize ? { hostedSize } : {}),
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
		const mode = info?.items?.orchestrate && (!other || usePolicy) ? itemMode : "single";
		const input: Omit<CreateItemInput, "idempotencyKey"> = {
			repository: { id: chosen.repository.id, branch: chosen.branch },
			title: filing.title,
			mode,
			body: filing.body,
			acceptance,
			start: now,
			...(usePolicy ? { useDefaultPlace: true } : { place: chosenMachine ? { kind: "machine", machineId: chosenMachine.machineId } : { kind: "hosted" } }),
			// The agent and its model: Windlass on the account's model unless one was chosen here.
			...(!usePolicy && other ? { harness } : {}),
			// Codex runs items in either of its profiles; the other agents only in their hardened container.
			...(!usePolicy && profile && (chosenMachine || profileChoice) ? { profile } : {}),
			...(model && (other || modelChoice !== "") ? { model } : {}),
			// Every turn of the item runs at it; left out, at the agent's default.
			...(effort && effort !== "default" ? { effort } : {}),
			...(hostedSize ? { hostedSize } : {}),
		};
		// Filing the same again after an answer that never came, with nothing changed, makes no second item.
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
	// ---- where it runs, and its sandbox -------------------------------------------------------------
	const available = placeProfiles.filter((candidate) => candidate.available && (!other || candidate.id === HARNESS_PROFILE || (hasCodexSandbox(chosenMachine) && candidate.id === "docker-windlass-sandbox")));
	const sandboxWarn = (chosenProfile !== null && sandboxOpen(chosenProfile, claude)) || (!other && ignored.profile !== null) || defaultsErrors.length > 0 || available.length === 0;
	/** The sandboxes of a place, as rows: choosing one chooses the place too. */
	const profileRows = (machine: MachineSummary | null): MenuItem[] => {
		const here = machine === null ? (chosenMachine === null) : chosenMachine?.machineId === machine.machineId;
		const list = machine ? machine.profiles : (info?.profiles ?? []);
		return list
			.filter((candidate) => !other || candidate.id === HARNESS_PROFILE || (hasCodexSandbox(machine) && candidate.id === "docker-windlass-sandbox"))
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
		other && !hasCodexSandbox(chosenMachine) ? { text: `${other} runs in the hardened container only.`, warn: false } : null,
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
	// The repository, as the where menu's last row: its picker in a submenu, or the address form.
	const repoRow: MenuItem = {
		id: "repo",
		value: "repo",
		label: repoReading ? "Repository" : repo.kind === "github" ? repositoryName(repo.picked.repository) : repo.kind === "address" && repo.url !== "" ? shortAddress(repo.url) : item ? "Choose a repository" : "No repository",
		textValue: "repository",
		description: repoReading ? "being read" : repo.kind === "github" ? `at ${repo.picked.branch}` : repo.kind === "address" && repo.url !== "" ? "cloned from its address" : item ? "a repository of your GitHub connection" : "starts in an empty repository",
		icon: repo.kind === "github" ? <RepoTile name={repo.picked.repository.name} size="sm" /> : <RepoIcon size={15} />,
		tone: repoWarn ? ("warn" as const) : undefined,
		// On a phone its list or form is pushed into the sheet; on a wide screen it takes the menu's place, anchored to the pill.
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

	// ---- the agent and its model --------------------------------------------------------------------
	/** The rows of one harness's models: models only, the effort being the menu's last group. */
	const modelRows = (harnessId: HarnessId, list: typeof modelList): MenuItem[] => {
		if (list === null || list.models.length === 0) return [];
		const isOther = harnessId !== "windlass";
		return list.models.map(({ id, name: reportedName }) => {
			const isDefault = id === list.defaultModel;
			const name = isOther && reportedName ? reportedName : id;
			const here = harness === harnessId;
			// Another harness's reported default is its "": chosen, nothing is sent.
			const checked = here && (isOther && model === "" ? isDefault : model === id);
			return {
				id: `${harnessId}:${id}`,
				label: name,
				icon: <AgentGlyph harness={HARNESS_NAMES[harnessId]} accent={harnessId === "windlass" && isDefault} />,
				trailing: isDefault && !saysDefault(name) ? <span className="ui-tag">default</span> : undefined,
				checked,
				onSelect: () => {
					setHarness(harnessId);
					setModel(id);
				},
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
		...(["claude", "opencode", "codex"] as const).flatMap(id => {
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
	// One button a logo for each agent the chosen place offers: a press switches to it, on its default model.
	const agentsHere = agentGroups.filter((group) => !group.id.endsWith(":elsewhere") && group.items.some((row) => !row.disabled));
	const agentSwitch =
		agentsHere.length > 1 ? (
			<div className="agent-switch" role="group" aria-label="Switch agent">
				{agentsHere.map((group) => {
					const id = group.id as HarnessId;
					const chosen = harness === id;
					return (
						<Tooltip key={id} content={HARNESS_NAMES[id]}>
							<button
								type="button"
								className={`agent-switch-button${chosen ? " agent-switch-chosen" : ""}`}
								aria-pressed={chosen}
								aria-label={HARNESS_NAMES[id]}
								onClick={() => {
									if (!chosen) {
										setHarness(id);
										setModel("");
									}
									setOpen(null);
								}}
							>
								<AgentLogo id={id} size={18} />
							</button>
						</Tooltip>
					);
				})}
			</div>
		) : null;
	// The effort, the agent menu's last group: the pill shows it as bars.
	const effortModel = !other ? model || "default model" : model !== "" ? modelName(modelList, model) : reportedDefault !== null && modelList ? modelLabel(modelList, reportedDefault) : "default model";
	const effortRows = effortGroup(efforts, effort, effortModel, setEffort);
	const agentSpec: MenuSpec = {
		label: "Agent and model",
		width: 304,
		maxHeight: 520,
		filter: agentGroups.reduce((sum, group) => sum + group.items.length, 0) > 7 ? { placeholder: "Filter models…" } : undefined,
		header:
			agentSwitch || offersOther || (!other && ignored.model) || harnessProblem ? (
				<>
					{agentSwitch}
					{chosenMachine && offersOther
						? <details className="agent-commands">
								<summary>Terminal sign-in commands</summary>
								{offeredHarnesses(chosenMachine).map(offered => <HarnessStatus key={offered.id} harness={offered} />)}
							</details>
						: null}
					{(["claude", "opencode", "codex"] as const).map(id => catalogs[id].error && <p key={id} role="status">
						{HARNESS_NAMES[id]} models: {catalogs[id].error} <button type="button" className="link" onClick={catalogs[id].retry}>Retry</button>
					</p>)}
					{harnessProblem ? <p className="tone-warn" role="status">{harnessProblem}</p> : null}
					{!other && ignored.model ? <p className="tone-warn">{ignored.model}</p> : null}
				</>
			) : undefined,
		groups: [...agentGroups, ...(effortRows ? [effortRows] : [])],
		footer: (
			<>
				{item && other ? <p className="ui-menu-note">{other} works on the item in the hardened container without asking, and runs Quick: Plan first is Windlass's.{capabilitiesOf(harness).checks === "platform" ? " The platform runs this repository's saved checks when it ends a turn." : capabilitiesOf(harness).checks === "none" ? " It does not run this repository's checks, so CI decides." : ""}</p> : null}
				{!item && machineHarness(harness) ? <p className="ui-menu-note">{machineAgentLine(machineHarness(harness)!)}{onPullRequest(harness)}</p> : null}
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

	// ---- how a work item runs: plan first or quick ------------------------------------
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

	// ---- the launch ----------------------------------------------------------------------------------
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

	// ---- what the sandbox lets its commands do, and where: the lock's tooltip and the options' last line ----
	const facts = !item && chosenProfile ? sandboxFacts(chosenProfile, claude) : [];
	const where = chosenMachine ? `runs on ${machineLabel(chosenMachine)}` : hostedOption ? `runs hosted, ${sizeName(hostedOption.id)} (${sizeSpec(hostedOption.id)}${perHour(hostedOption.usdPerHour) ? `, about ${perHour(hostedOption.usdPerHour)}` : ""})` : "runs hosted";
	const anyOpen = facts.some((fact) => fact.open);
	const safety = facts.length > 0 ? sentence([...facts.map((fact) => fact.long), where]) : null;

	// ---- the options: the rarer settings ------------------------------------------------------------
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
	// The size of a hosted sandbox, with what an hour of it is estimated to cost; the daily sandbox time counts every size the same.
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

	// ---- the done-when criteria of a work item: one line under the text, opened only when used --------
	const criteriaLine = item ? (
		criteriaOpen ? (
			<div className="start-criteria-inline">
				{criteriaField}
				<button type="button" className="button button-quiet button-small start-criteria-done" onClick={() => (setCriteriaOpen(false), area.current?.focus())}>
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
							<AgentPill trigger={props} harness={harness} name={HARNESS_NAMES[harness]} model={agentModel} effort={effort} efforts={efforts} dot={agentWarn ? "warn" : modelChanged ? "changed" : null} dotLabel={harnessProblem ? "the last agent cannot be used here" : agentWarn ? "the saved default cannot be used" : undefined} changed={modelChanged} data-value={agentValue} data-effort={effort || "default"} />
						)}
					/>
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

/** Phrases as sentences: "runs hosted" → "Runs hosted.", one after another. */
function sentence(parts: readonly string[]): string {
	return parts
		.map((part) => part.trim().replace(/\.$/, ""))
		.filter((part) => part !== "")
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}.`)
		.join(" ");
}
