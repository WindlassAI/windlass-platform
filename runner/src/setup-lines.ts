/**
 * The setup wizard in plain lines, for `--no-tui` or no terminal: numbered choices, Enter for the
 * default, b for Back and q to cancel. Without a terminal nobody can answer: it takes every default,
 * reads nothing, and does not sign agents in.
 */
import { createInterface } from "node:readline";
import { BACK, CANCEL, type Answer, type Choice, type Prompter } from "./setup-prompt.js";

export class LinePrompter implements Prompter {
	readonly interactive: boolean;
	readonly keys?: string;

	constructor(private readonly input = process.stdin, private readonly out: NodeJS.WritableStream = process.stdout) {
		this.interactive = !!(input as { isTTY?: boolean }).isTTY;
		if (this.interactive) this.keys = "Enter takes the default · b goes back · q cancels";
	}

	/** One line, or undefined without a terminal: then every question takes its default. */
	private async line(prompt: string): Promise<string | undefined> {
		this.out.write(prompt);
		if (!this.interactive) { this.out.write("\n"); return undefined; }
		// A reader per question: sign-in prompts read the same terminal between questions.
		const rl = createInterface({ input: this.input, output: this.out, terminal: false });
		try {
			return await new Promise(resolve => { rl.once("line", resolve); rl.once("close", () => resolve(undefined)); });
		} finally { rl.close(); }
	}

	intro(title: string) { this.out.write(`\n== ${title} ==\n`); }
	outro(message: string) { this.out.write(message + "\n"); }
	note(title: string, lines: string[]) { this.out.write(`\n-- ${title} --\n${lines.map(l => "  " + l).join("\n")}\n\n`); }
	log(kind: "info" | "success" | "warn" | "error" | "step", message: string) {
		this.out.write(({ info: "", success: "OK: ", warn: "Note: ", error: "Error: ", step: "> " })[kind] + message + "\n");
	}
	private help(back = true) { return this.interactive ? ` (Enter for the default${back ? ", b back" : ""}, q cancel)` : ""; }

	async select<T>(q: { message: string; options: Choice<T>[]; initial?: T }): Promise<Answer<T>> {
		const initial = Math.max(0, q.options.findIndex(o => o.value === q.initial));
		this.out.write(q.message + "\n" + q.options.map((o, i) => `  ${i + 1}) ${o.label}${o.hint ? " - " + o.hint : ""}${i === initial ? "  [default]" : ""}`).join("\n") + "\n");
		for (;;) {
			const answer = (await this.line(`Choose 1-${q.options.length}${this.help()}: `))?.trim().toLowerCase();
			if (answer === undefined || answer === "") return q.options[initial]!.value;
			if (answer === "b") return BACK;
			if (answer === "q") return CANCEL;
			const n = Number(answer);
			if (Number.isInteger(n) && n >= 1 && n <= q.options.length) return q.options[n - 1]!.value;
			this.out.write(`Give a number from 1 to ${q.options.length}.\n`);
			if (!this.interactive) return q.options[initial]!.value;
		}
	}
	async multiselect<T>(q: { message: string; options: Choice<T>[]; initial: T[] }): Promise<Answer<T[]>> {
		const ticked = q.options.flatMap((o, i) => q.initial.includes(o.value) ? [i + 1] : []);
		this.out.write(q.message + "\n" + q.options.map((o, i) => `  ${i + 1}) ${o.label}${o.hint ? " - " + o.hint : ""}`).join("\n") + "\n");
		for (;;) {
			const answer = (await this.line(`Numbers separated by commas, 0 for none [${ticked.join(",") || "0"}]${this.help()}: `))?.trim().toLowerCase();
			if (answer === undefined || answer === "") return q.options.filter(o => q.initial.includes(o.value)).map(o => o.value);
			if (answer === "b") return BACK;
			if (answer === "q") return CANCEL;
			if (answer === "0") return [];
			const picked = answer.split(/[\s,]+/).map(Number);
			if (picked.every(n => Number.isInteger(n) && n >= 1 && n <= q.options.length)) return q.options.filter((_, i) => picked.includes(i + 1)).map(o => o.value);
			this.out.write(`Give numbers from 1 to ${q.options.length}.\n`);
			if (!this.interactive) return q.options.filter(o => q.initial.includes(o.value)).map(o => o.value);
		}
	}
	async text(q: { message: string; initial: string; hint?: string; validate?: (value: string) => string | undefined }): Promise<Answer<string>> {
		if (q.hint) this.out.write(q.hint + "\n");
		for (;;) {
			const raw = await this.line(`${q.message} [${q.initial}]${this.interactive ? " (b back, q cancel)" : ""}: `);
			const answer = raw?.trim();
			if (this.interactive && answer === "b") return BACK;
			if (this.interactive && answer === "q") return CANCEL;
			const value = answer || q.initial;
			const problem = q.validate?.(value);
			if (!problem) return value;
			this.out.write(problem + "\n");
			if (raw === undefined) return CANCEL;
		}
	}
	async wait<T>(message: string, work: (signal: AbortSignal, update: (message: string) => void) => Promise<T>): Promise<Answer<T>> {
		this.out.write(message + "…\n");
		const abort = new AbortController();
		const stop = () => abort.abort();
		process.once("SIGINT", stop);
		try {
			const value = await work(abort.signal, line => this.out.write("  " + line + "\n"));
			return abort.signal.aborted ? CANCEL : value;
		} catch (error) {
			if (abort.signal.aborted) return CANCEL;
			throw error;
		} finally { process.off("SIGINT", stop); }
	}
}
