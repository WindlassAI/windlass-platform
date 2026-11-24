/**
 * The setup wizard's full-screen prompts (@clack/prompts). ← or Shift+Tab answers BACK on a choice;
 * Shift+Tab does in a text field, where ← moves the cursor. Escape and Ctrl+C answer CANCEL.
 */
import * as clack from "@clack/prompts";
import { emitKeypressEvents, type Key } from "node:readline";
import { styleText } from "node:util";
import { BACK, CANCEL, type Answer, type Prompter } from "./setup-prompt.js";

const dim = (text: string) => styleText("dim", text);

/**
 * Runs one prompt. The prompt never sees a Back key: it gets Escape in its place, so that it closes
 * as a cancelled prompt draws itself, and the answer is BACK.
 */
async function withBack<T>(left: boolean, prompt: () => Promise<T | symbol>): Promise<Answer<T>> {
	const stdin = process.stdin as unknown as { emit: (event: string | symbol, ...args: unknown[]) => boolean };
	const emit = stdin.emit;
	let back = false;
	stdin.emit = function (this: unknown, event: string | symbol, ...args: unknown[]) {
		const key = args[1] as Key | undefined;
		if (event === "keypress" && !back && ((left && key?.name === "left") || (key?.name === "tab" && key.shift))) {
			back = true;
			return emit.call(this, "keypress", "\x1b", { name: "escape", sequence: "\x1b", ctrl: false, meta: false, shift: false });
		}
		return emit.call(this, event, ...args);
	};
	try {
		const value = await prompt();
		if (back) return BACK;
		return clack.isCancel(value) ? CANCEL : value as T;
	} finally { stdin.emit = emit; }
}

/** A hint under a question, inside the prompt's guide line. */
function hinted(message: string, hint?: string) {
	if (!hint) return message;
	const width = Math.max(40, (process.stdout.columns ?? 80) - 6);
	const lines: string[] = [];
	for (const word of hint.split(" ")) {
		if (lines.length && (lines.at(-1)! + " " + word).length <= width) lines[lines.length - 1] += " " + word;
		else lines.push(word);
	}
	return message + "\n" + lines.map(line => styleText("cyan", "│") + "  " + dim(line)).join("\n");
}

export class TuiPrompter implements Prompter {
	readonly interactive = true;
	readonly keys = "↑↓ move · Space ticks · Enter goes on · ← back · Esc cancels";
	private spin: { s: ReturnType<typeof clack.spinner>; message: string } | undefined;

	/** Output while a spinner turns: stop it, print, start it again. */
	private print(write: () => void) {
		const active = this.spin;
		if (!active) return write();
		active.s.clear();
		write();
		active.s = clack.spinner();
		active.s.start(active.message);
	}
	intro(title: string) { clack.intro(styleText(["bgCyan", "black"], ` ${title} `)); }
	outro(message: string) { clack.outro(message); }
	note(title: string, lines: string[], strong: string[] = []) {
		let text = lines.join("\n");
		for (const part of strong) text = text.replaceAll(part, styleText(["bold", "cyan"], part));
		this.print(() => clack.note(text, title));
	}
	log(kind: "info" | "success" | "warn" | "error" | "step", message: string) { this.print(() => clack.log[kind](message)); }
	select<T>(q: { message: string; options: { value: T; label: string; hint?: string }[]; initial?: T }) {
		return withBack<T>(true, () => clack.select<T>({ message: q.message, initialValue: q.initial,
			options: q.options.map(o => ({ value: o.value, label: o.label, ...(o.hint && { hint: o.hint }) })) as clack.Option<T>[] }));
	}
	multiselect<T>(q: { message: string; options: { value: T; label: string; hint?: string }[]; initial: T[] }) {
		return withBack<T[]>(true, () => clack.multiselect<T>({ message: q.message, initialValues: q.initial, required: false,
			options: q.options.map(o => ({ value: o.value, label: o.label, ...(o.hint && { hint: o.hint }) })) as clack.Option<T>[] }));
	}
	text(q: { message: string; initial: string; hint?: string; validate?: (value: string) => string | undefined }) {
		return withBack<string>(false, () => clack.text({ message: hinted(q.message, q.hint), initialValue: q.initial,
			validate: value => q.validate?.(value ?? "") }));
	}
	async wait<T>(message: string, work: (signal: AbortSignal, update: (message: string) => void) => Promise<T>): Promise<Answer<T>> {
		const abort = new AbortController();
		const stdin = process.stdin;
		const onKey = (_: string, key?: Key) => { if (key?.name === "escape" || (key?.ctrl && key.name === "c")) abort.abort(); };
		emitKeypressEvents(stdin);
		if (stdin.isTTY) stdin.setRawMode(true);
		stdin.on("keypress", onKey);
		stdin.resume();
		const s = clack.spinner();
		this.spin = { s, message: message + dim("  (Esc cancels)") };
		s.start(this.spin.message);
		try {
			const value = await work(abort.signal, line => {
				if (!this.spin) return;
				this.spin.message = message + dim(" · " + line);
				this.spin.s.message(this.spin.message);
			});
			this.spin.s.stop(abort.signal.aborted ? dim("Cancelled") : message.replace(/ \(.*\)$/, ""));
			return abort.signal.aborted ? CANCEL : value;
		} catch (error) {
			this.spin?.s.error(message.replace(/ \(.*\)$/, ""));
			if (abort.signal.aborted) return CANCEL;
			throw error;
		} finally {
			this.spin = undefined;
			stdin.off("keypress", onKey);
			if (stdin.isTTY) stdin.setRawMode(false);
			stdin.pause();
		}
	}
}
