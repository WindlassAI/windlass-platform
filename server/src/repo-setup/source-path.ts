const source =
	/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|rb|php|scala|sh|vue|svelte|dart|exs?|hs|lua)$/i;
const generated =
	/(?:^|\/)(?:node_modules|vendor|third_party|generated|__generated__|dist|build|target|coverage)\/|(?:\.min|\.generated|\.g|\.pb)\.[^/]+$/i;

export function isSetupSource(path: string) {
	return source.test(path) && !generated.test(path);
}
