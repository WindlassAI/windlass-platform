/**
 * The models a user may choose (`ModelList`), as the screens read them: what is offered, which efforts
 * go with the chosen model, and the one quiet line that says whose list it is, so that a model that
 * is missing from it is no mystery. The list is the user's ChatGPT plan's where it could be read, and
 * the platform's stand-in where not; the server says which, and the words here only repeat it.
 */
import type { ModelList } from "@contract";
import { localTime } from "./format";

/** The ids of the list's models, in its order; none while the list is not known. */
export const modelIds = (list: ModelList | null): string[] => list?.models.map((model) => model.id) ?? [];

/** The efforts a model accepts; none for a model that takes no effort, and for one the list does not have. */
export const effortsOf = (list: ModelList | null, model: string): string[] => list?.models.find((candidate) => candidate.id === model)?.efforts ?? [];

/** Whose list it is, in a sentence, for under a field. */
export function modelsNote(list: ModelList): string {
	switch (list.source) {
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
