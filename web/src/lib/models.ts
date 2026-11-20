/**
 * The models a user may choose (`ModelList`), as the screens read them: what is offered, which efforts
 * go with the chosen model, and the one quiet line that says whose list it is, so that a model that
 * is missing from it is no mystery. The list is the user's ChatGPT plan's where it could be read, and
 * the platform's stand-in where not; the server says which, and the words here only repeat it.
 */
import type { HarnessId, MachineSummary, ModelChoice, ModelList, SessionMode } from "@contract";
import { localTime } from "./format";

/** The ids of the list's models, in its order; none while the list is not known. */
export const modelIds = (list: ModelList | null): string[] => list?.models.map((model) => model.id) ?? [];

/** The efforts a model accepts; none for a model that takes no effort, and for one the list does not have. */
export const effortsOf = (list: ModelList | null, model: string): string[] => list?.models.find((candidate) => candidate.id === model)?.efforts ?? [];

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
interface ReportedOptions {
	models?: ModelChoice[];
	defaultModel?: string;
	modes?: SessionMode[];
	checkedAt?: number;
}

/**
 * The models and modes another harness offers on a machine before an agent of it runs there, as the
 * machine's runner reported them (`MachineSummary.harnesses[].options`). The server holds a launch's
 * model against that same report, so no other list is offered: a model an earlier agent listed may
 * not be one the server takes yet. Null where there is none: the harness starts on its own default.
 */
export function harnessOptions(machine: MachineSummary | null, harness: HarnessId): { models: ModelList | null; modes: SessionMode[] | null } {
	if (machine === null || harness === "windlass") return { models: null, modes: null };
	const reported = (machine.harnesses?.find((entry) => entry.id === harness) as { options?: ReportedOptions } | undefined)?.options;
	const modes = reported?.modes && reported.modes.length > 0 ? reported.modes : null;
	const first = reported?.models?.[0];
	if (!reported?.models || first === undefined) return { models: null, modes };
	// The runner reports the adapter's own default; the first listed model stands in only when it names none it lists.
	const defaultModel = reported.models.some((model) => model.id === reported.defaultModel) ? (reported.defaultModel as string) : first.id;
	return { models: { source: "harness", models: reported.models, defaultModel, fetchedAt: reported.checkedAt ?? null }, modes };
}
