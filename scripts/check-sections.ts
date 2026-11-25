const prefixes = (process.env.WLP_CHECK_SECTIONS ?? "").split(",").map(name => name.trim()).filter(Boolean);

export function matchesSection(name: string): boolean {
	return prefixes.length === 0 || prefixes.some(prefix => name.startsWith(prefix));
}
