const warned = new Set<string>();

/** Select the operator's explicit setting, keeping the E2B deployment names in use. */
export function hostedName(env: NodeJS.ProcessEnv, suffix: string, e2bSuffix = suffix): string {
	const name = "WLP_HOSTED_" + suffix;
	const old = "WLP_E2B_" + e2bSuffix;
	if (env[name] === undefined) return env[old] === undefined ? name : old;
	const oldValue = suffix === "IDLE_ACTION" ? ({ "0": "destroy", "1": "pause" }[env[old]?.trim() ?? ""]) : env[old]?.trim();
	if (env[old] !== undefined && oldValue !== env[name]?.trim() && !warned.has(name)) {
		warned.add(name);
		console.warn(`[wlp] ${name} overrides ${old}`);
	}
	return name;
}

export function wholeNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, least: number, most = Number.MAX_SAFE_INTEGER): number {
	const raw = env[name]?.trim();
	const value = raw ? Number(raw) : fallback;
	if (!Number.isSafeInteger(value) || value < least || value > most) throw new Error(`${name} must be a whole number from ${least} to ${most}; got "${raw ?? fallback}"`);
	return value;
}
