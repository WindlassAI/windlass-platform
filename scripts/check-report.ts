/** A command's output on one line, so each expectation prints as one line. */
export const oneLine = (text: string) => text.trim().replace(/\s*\n\s*/g, " | ");

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface ReportOptions {
	/** Where lines go; a check that also keeps its output passes its own. */
	print?: (line: string) => void;
	/** "plain" prints `FAIL  name  detail` ("condition not met" without one); "dash" prints `FAIL  name  -- detail`. */
	failure?: "plain" | "dash";
	/** Fold a multi-line detail onto one line (the default). */
	fold?: boolean;
}

/**
 * Counts and prints `PASS  name  (detail)`, `FAIL  name  ...` and `SKIP  name  (why)` lines.
 * Its methods are bound, so a check can take `const { expect } = report`.
 */
export class Report {
	passes = 0;
	failures = 0;
	skips = 0;
	private readonly print: (line: string) => void;
	private readonly dash: boolean;
	private readonly fold: boolean;

	constructor(options: ReportOptions = {}) {
		this.print = options.print ?? ((line) => console.log(line));
		this.dash = options.failure === "dash";
		this.fold = options.fold ?? true;
	}

	private text(detail: string): string {
		return this.fold ? oneLine(detail) : detail;
	}

	pass = (name: string, detail = ""): void => {
		this.passes += 1;
		const text = this.text(detail);
		this.print(`PASS  ${name}${text ? `  (${text})` : ""}`);
	};

	fail = (name: string, detail = ""): void => {
		this.failures += 1;
		const text = this.text(detail);
		if (this.dash) this.print(`FAIL  ${name}${text ? `  -- ${text}` : ""}`);
		else this.print(`FAIL  ${name}  ${text || "condition not met"}`);
	};

	skip = (name: string, why: string): void => {
		this.skips += 1;
		this.print(`SKIP  ${name}  (${why})`);
	};

	expect = (name: string, ok: boolean, detail = ""): boolean => {
		if (ok) this.pass(name, detail);
		else this.fail(name, detail);
		return ok;
	};

	/** Runs one check: PASS with what `body` returns, FAIL with what it throws. */
	check = async (name: string, body: () => Promise<string | undefined | void> | string | undefined | void, describe: (error: unknown) => string = messageOf): Promise<boolean> => {
		try {
			this.pass(name, (await body()) ?? "");
			return true;
		} catch (error) {
			this.fail(name, describe(error));
			return false;
		}
	};

	/**
	 * Prints `N passed, M failed` (after `ALL PASSED: ` or `FAILED: ` with `verdict`), the skips when
	 * there were any and `extra`, on a line of its own. Returns the exit code.
	 */
	summary(verdict = false, extra = ""): 0 | 1 {
		const head = verdict ? `${this.failures === 0 ? "ALL PASSED" : "FAILED"}: ` : "";
		const skipped = this.skips > 0 ? `, ${this.skips} skipped` : "";
		this.print(`\n${head}${this.passes} passed, ${this.failures} failed${skipped}${extra}`);
		return this.failures === 0 ? 0 : 1;
	}
}

/** Counts and prints `ok    name` and `FAIL  name` lines, with a failure's detail on the next line. */
export class OkReport {
	failures = 0;

	expect = (what: string, ok: boolean, detail = ""): void => {
		if (!ok) this.failures += 1;
		console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
	};

	/** Prints `allPassed` or `someFailed(failures)` and returns the exit code. */
	summary(allPassed: string, someFailed: (failures: number) => string): 0 | 1 {
		console.log(this.failures === 0 ? allPassed : someFailed(this.failures));
		return this.failures === 0 ? 0 : 1;
	}
}
