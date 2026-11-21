import type { ModelList, SessionMode } from "../contract.js";

export type Fields = Record<string, unknown>;
export const object = (value: unknown): Fields => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
export const objects = (value: unknown): Fields[] => Array.isArray(value) ? value.map(object) : [];
export const text = (value: unknown): string => typeof value === "string" ? value : "";

function choiceFields(option: Fields | undefined) {
	return objects(option?.options).flatMap(group => Array.isArray(group.options) ? objects(group.options) : [group])
		.filter(value => typeof value.value === "string" && value.value.length > 0);
}

export function configChoices(option: Fields | undefined) {
	return choiceFields(option).map(value => ({ id: text(value.value), name: text(value.name) || null }));
}

export function optionsOf(raw: unknown, previous?: ModelList | null) {
	const options = objects(raw);
	const model = options.find(o => o.category === "model" && o.type === "select");
	const effort = options.find(o => o.category === "thought_level" && o.type === "select");
	const efforts = configChoices(effort).map(value => value.id);
	const current = text(model?.currentValue);
	const models = configChoices(model).map(choice => ({
		...choice, efforts: choice.id === current ? efforts : previous?.models.find(m => m.id === choice.id)?.efforts ?? [],
	}));
	const list: ModelList | null = models.length ? {
		source: "harness", models, defaultModel: previous && models.some(m => m.id === previous.defaultModel) ? previous.defaultModel : current, fetchedAt: Date.now(),
	} : null;
	return { model, effort, list };
}

export function modesOf(raw: unknown): SessionMode[] {
	return objects(object(raw).availableModes).map(m => ({ id: text(m.id), name: text(m.name), description: text(m.description) || null }));
}

export function modeSelection(legacy: unknown, config: unknown) {
	const modes = modesOf(legacy);
	const select = objects(config).find(o => o.type === "select" && (o.category === "mode" || o.id === "mode"));
	if (modes.length || !select) return { modes, current: text(object(legacy).currentModeId), select: undefined };
	return {
		select, current: text(select.currentValue),
		modes: choiceFields(select).map(o => ({ id: text(o.value), name: text(o.name) || text(o.value), description: text(o.description) || null })),
	};
}
