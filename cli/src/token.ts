/**
 * Reading the token `claude setup-token` prints off its terminal output. The output is a TUI's: colours, cursor
 * moves, redraws, and a long token hard-wrapped at the terminal's width, sometimes inside a box. Nothing here
 * prints or keeps the token.
 */

const PREFIX = "sk-ant-oat01-";
const TOKEN_CHARS = /[A-Za-z0-9_-]/;
/** What a box or indentation puts around a wrapped line. */
const EDGE = /^[\s│┃║|]+|[\s│┃║|]+$/g;

/**
 * Plain text from terminal output: a cursor move, an erase or a line feed becomes a line break (so two redrawn
 * pieces never run together), a cursor step forward a space, and every other escape nothing.
 */
export function plainText(output: string): string {
	return (
		output
			// OSC (titles, hyperlinks): ESC ] … BEL or ESC \
			.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
			// CSI: ESC [ params final
			.replace(/\x1b\[[0-?]*[ -/]*([@-~])/g, (_, final: string) =>
				final === "C" ? " " : /[ABEFGHJKSTdf]/.test(final) ? "\n" : "",
			)
			// Other two-character escapes (ESC 7, ESC 8, ESC M …)
			.replace(/\x1b[@-_]/g, "\n")
			// A pseudo-terminal turns "\r\n" into "\r\r\n": one line break however many carriage returns.
			.replace(/\r*\n|\r+/g, "\n")
			// Other control characters but tab and line feed
			.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
	);
}

/**
 * The last setup token in the output, joined back together where the terminal wrapped it: while a piece of the
 * token fills its line to the full width, the next line continues it when that line holds nothing but token
 * characters (inside the same box edges) and is no wider. Null when there is none.
 */
export function extractToken(output: string): string | null {
	const lines = plainText(output)
		.split("\n")
		.map(line => line.replace(EDGE, ""));
	let found: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const at = line.lastIndexOf(PREFIX);
		if (at === -1) continue;
		let end = at + PREFIX.length;
		while (end < line.length && TOKEN_CHARS.test(line[end]!)) end++;
		let token = line.slice(at, end);
		const width = line.length;
		let full = end === width;
		while (full && i + 1 < lines.length) {
			const more = lines[i + 1]!;
			const continues =
				more !== "" && more.length <= width && !more.includes(PREFIX) && [...more].every(ch => TOKEN_CHARS.test(ch));
			if (!continues) break;
			token += more;
			full = more.length === width;
			i++;
		}
		if (token.length >= PREFIX.length + 20) found = token;
	}
	return found;
}

/** Text with anything that looks like an Anthropic secret taken out, for every message the CLI shows. */
export function scrub(text: string): string {
	return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…");
}
