// Match the accepted setup-token format. No reader needs the actual login, including
// during rotation or after logout. Only hold a possible prefix, never a token body.
const prefix = "sk-ant-oat01-";
const replacement = "[claude token]";
export const cleanClaudeOutput = (text: string) => text.replace(/sk-ant-oat01-[A-Za-z0-9_-]*/g, replacement);

export function claudeStream(emit: (text: string) => void) {
	let pending = "";
	let inToken = false;
	return {
		write(chunk: string) {
			let text = pending + chunk;
			pending = "";
			if (inToken) {
				text = text.replace(/^[A-Za-z0-9_-]*/, "");
				if (!text) return;
				inToken = false;
			}
			const last = text.lastIndexOf(prefix);
			if (last >= 0 && /^[A-Za-z0-9_-]*$/.test(text.slice(last + prefix.length))) {
				inToken = true;
			} else {
				for (let n = Math.min(prefix.length - 1, text.length); n > 0; n--) {
					if (!text.endsWith(prefix.slice(0, n))) continue;
					pending = text.slice(-n);
					text = text.slice(0, -n);
					break;
				}
			}
			if (text) emit(cleanClaudeOutput(text));
		},
		end() { if (pending) emit(pending); },
	};
}
