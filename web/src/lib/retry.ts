/** A read tried once more, a moment later, before its failure is shown: one failed refresh is usually a passing blip. */
export function readTwice<T>(read: () => Promise<T>, wait = 2_000): Promise<T> {
	return read().catch(() => new Promise<T>((resolve, reject) => setTimeout(() => read().then(resolve, reject), wait)));
}
