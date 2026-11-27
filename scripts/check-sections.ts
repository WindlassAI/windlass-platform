/** The comma-separated, trimmed case-name prefixes in an environment variable such as `FACTORY_ONLY`. */
export function sectionPrefixes(variable: string): string[] {
	return (process.env[variable] ?? "").split(",").map(name => name.trim()).filter(Boolean);
}

/** Whether a case runs under that variable: every case does when it is unset or empty. */
export function sectionMatcher(variable: string): (name: string) => boolean {
	const prefixes = sectionPrefixes(variable);
	return name => prefixes.length === 0 || prefixes.some(prefix => name.startsWith(prefix));
}

export const matchesSection = sectionMatcher("WLP_CHECK_SECTIONS");
