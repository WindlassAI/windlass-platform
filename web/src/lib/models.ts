/**
 * The models a user may choose (`ModelList`), as the screens read them: what is offered, which efforts
 * go with the chosen model, and the one quiet line that says whose list it is, so that a model that
 * is missing from it is no mystery. The list is the user's ChatGPT plan's where it could be read, and
 * the platform's stand-in where not; the server says which, and the words here only repeat it.
 */
import type { HarnessId, MachineSummary, ModelChoice, ModelList, SessionMode } from "@contract";
import { hostedCatalog, type CheckedProvider } from "../../../server/src/sandbox/harnesses.js";
import { localTime } from "./format";

/** The ids of the list's models, in its order; none while the list is not known. */
export const modelIds = (list: ModelList | null): string[] => list?.models.map((model) => model.id) ?? [];

/** The efforts a model accepts; none for a model that takes no effort, and for one the list does not have. */
export const effortsOf = (list: ModelList | null, model: string): string[] => list?.models.find((candidate) => candidate.id === model)?.efforts ?? [];

/** Use an adapter's explicit reset value when it offers one. Other models reset by omitting effort. */
export const effortChoices = (efforts: string[]): string[] =>
	[efforts.includes("default") ? "default" : "", ...efforts.filter(level => level !== "default")];

/** Whose list it is, in a sentence, for under a field. */
export function modelsNote(list: ModelList): string {
	switch (list.source) {
		case "harness":
			return "The models offered by the session’s harness.";
		case "account":
			return `The models of your ChatGPT plan${list.fetchedAt === null ? "" : `, as read at ${localTime(list.fetchedAt)}`}.`;
		case "demo":
			return "A stand-in list: the demo's scripted model answers under any of these names.";
		case "signed-out":
			return "A stand-in list: your plan's models are read once you are signed in with ChatGPT.";
		case "unavailable":
			return "A stand-in list: your ChatGPT plan's models could not be read just now, so one of yours may be missing.";
	}
}

/** The same in a few words, for beside the composer's pickers. */
export function modelsNoteShort(list: ModelList): string {
	switch (list.source) {
		case "harness":
			return "harness models";
		case "account":
			return "your plan's models";
		case "demo":
			return "stand-in models: demo";
		case "signed-out":
			return "stand-in models: no ChatGPT sign-in";
		case "unavailable":
			return "stand-in models: your plan's could not be read";
	}
}

/** What a machine's runner may report of a harness's options beside it: read as optional, so that a runner that reports none, and a summary without the field, read as nothing. */
export interface ReportedOptions {
	models?: ModelChoice[];
	defaultModel?: string;
	modes?: SessionMode[];
	checkedAt?: number;
}

/**
 * Launch options come from the runner on a machine and the owner's checked provider keys when hosted.
 * Without a catalog the agent starts on its own default.
 */
export function harnessOptions(machine: MachineSummary | null, harness: HarnessId, catalog?: ReportedOptions, providers?: readonly CheckedProvider[] | null): { models: ModelList | null; modes: SessionMode[] | null } {
	if (harness === "windlass") return { models: null, modes: null };
	const entry = machine?.harnesses?.find(entry => entry.id === harness);
	const reported = machine ? catalog ?? entry?.options : hostedCatalog(harness, providers ?? []);
	const modes = reported?.modes && reported.modes.length > 0 ? reported.modes : null;
	const first = reported?.models?.[0];
	if (!reported?.models || first === undefined) return { models: null, modes };
	// The runner reports the adapter's own default; the first listed model stands in only when it names none it lists.
	const defaultModel = reported.models.some((model) => model.id === reported.defaultModel) ? (reported.defaultModel as string) : first.id;
	return { models: { source: "harness", models: reported.models, defaultModel, fetchedAt: entry?.optionsCheckedAt ?? reported.checkedAt ?? null }, modes };
}

/** What a model is called on screen: the harness's name for it where it gave one, its id otherwise. */
export const modelName = (list: ModelList | null, id: string): string => list?.models.find((model) => model.id === id)?.name || id;

/** Whether a model's name says it is the default already, as Claude Code's "Default (recommended)" does: no second "default" is put beside it. */
export const saysDefault = (name: string): boolean => /\bdefault\b/i.test(name);

/** A model in a few words, its list's default marked: "Opus (default)", "Haiku". What a harness starts on when no model is sent is its default. */
export function modelLabel(list: ModelList, id: string): string {
	const name = modelName(list, id);
	return id === list.defaultModel && !saysDefault(name) ? `${name} (default)` : name;
}
