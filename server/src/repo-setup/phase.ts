import { redact } from "../github/redact.js";
import type { RunTurnInput, RunTurnResult, TurnPublishRequest } from "../sandbox/api.js";
import { skillPath } from "./guide-check.js";
import { privateLine } from "./filing.js";
import type { SetupDiagnosis, SetupNote, SkillFiling } from "./types.js";

export class SetupPhase {
	leftOut: string[] = [];
	readonly skills: SetupDiagnosis["skills"] = { filings: [], kept: 0, droppedByReview: [] };
	private phase: SetupDiagnosis["phase"] = "draft";
	private offered = false;
	private readonly calls = new Map<string, string | null>();
	private lastMessage: string | null = null;
	private outcome = "failed";
	private stopReason: string | null = null;
	private noteLines: string[] = [];

	constructor(private readonly model: string, private readonly redactSaved: (text: string) => string) {}

	setNotes(notes: SetupNote[]) {
		this.noteLines = notes.flatMap(note => [note.label, ...note.text.split(/\r?\n/)]).map(s => s.trim()).filter(Boolean);
	}

	clean(text: string, limit = 240) {
		const scrubbed = redact(this.redactSaved(text));
		if (privateLine(scrubbed, { owner: "", host: "github.com", read: new Map(), redact: s => s }) ||
			this.noteLines.some(line => scrubbed.includes(line))) return "[redacted]";
		return scrubbed.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, limit);
	}

	begin(phase: SetupDiagnosis["phase"]) {
		this.phase = phase;
		this.calls.clear();
		this.offered = false;
		this.lastMessage = null;
		this.outcome = "failed";
		this.stopReason = null;
	}

	startSkillFiling(files: unknown, revision: boolean): SkillFiling {
		const proposed = Array.isArray(files) ? files.filter(f => f?.kind === "skill" || typeof f?.path === "string" && skillPath.test(f.path)).length : 0;
		const filing: SkillFiling = { phase: revision ? "revision" : "draft", proposed, staticallyRejected: [], smokeTested: 0, droppedBySmoke: [], kept: 0 };
		this.skills.filings.push(filing);
		return filing;
	}

	diagnosis(): SetupDiagnosis {
		const cleanDrop = ({ path, reason }: { path: string; reason: string }) => ({ path: this.clean(path), reason: this.clean(reason) });
		const skills = { kept: this.skills.kept, droppedByReview: this.skills.droppedByReview.map(cleanDrop),
			filings: this.skills.filings.map(f => ({ ...f, staticallyRejected: f.staticallyRejected.map(cleanDrop), droppedBySmoke: f.droppedBySmoke.map(cleanDrop) })) };
		return { skills, phase: this.phase, model: this.clean(this.model), toolOffered: this.offered, attempts: this.calls.size,
			...(this.leftOut.length > 0 && { leftOut: this.leftOut }),
			rejections: [...this.calls.values()].filter((s): s is string => s !== null),
			lastMessage: this.lastMessage, outcome: this.outcome, stopReason: this.stopReason };
	}

	async file<T>(input: RunTurnInput, run: (input: RunTurnInput) => Promise<RunTurnResult>,
		check: (args: TurnPublishRequest["arguments"], signal: AbortSignal) => T | Promise<T>) {
		const reviewing = this.phase === "review";
		const agent = reviewing ? "The reviewing agent" : "The drafting agent";
		const tool = reviewing ? "file_repo_setup_review" : "file_repo_setup";
		let filing: T | undefined;
		let checking = false;
		const handle = async (call: TurnPublishRequest, withdrawn: AbortSignal) => {
			const id = call.messageId + "/" + call.callId;
			this.calls.set(id, null);
			const signal = AbortSignal.any([input.signal!, withdrawn]);
			if (checking || filing !== undefined || signal.aborted) {
				this.calls.set(id, "This filing is closed.");
				return "This filing is closed.";
			}
			checking = true;
			try {
				const checked = await check(call.arguments, signal);
				signal.throwIfAborted();
				filing = checked;
				return reviewing ? "Review filed. End the turn." : "Guides filed. End the turn.";
			} catch (error) {
				const reason = this.clean(error instanceof Error ? error.message : "Check the filing format.");
				this.calls.set(id, reason);
				return "Filing refused. " + reason + " Correct the filing and call " + tool + " again.";
			} finally { checking = false; }
		};
		const result = await run({ ...input,
			onHostTools: names => { this.offered = names.includes(tool); },
			onEvent: event => {
				const data = event.data;
				if (event.type === "text.ended" && typeof data?.text === "string") this.lastMessage = this.clean(data.text, 300);
				if (data && typeof data.callId === "string") {
					const id = data.messageId + "/" + data.callId;
					if (event.type === "tool.called" && data.name === tool && !this.calls.has(id)) this.calls.set(id, null);
					if (event.type === "tool.settled" && data.outcome !== "success" && this.calls.has(id))
						this.calls.set(id, this.clean(typeof data.output === "string" ? data.output : "Windlass refused the call."));
				}
				input.onEvent?.(event);
			},
			...(reviewing ? { onSetupReview: handle } : { onSetup: handle }),
		});
		const timeout = result.timedOut || input.signal?.reason?.name === "TimeoutError";
		this.outcome = timeout ? "timed_out" : result.aborted ? "interrupted" : result.failure ? "failed" : String(result.summary?.outcome ?? "ended");
		this.stopReason = this.clean(result.failure?.reason ?? result.stopReason ?? "") || null;
		if (timeout) throw Error(agent + " ran out of time. Run setup again.");
		if (result.aborted) throw Error(agent + " was interrupted. Run setup again.");
		if (result.failure) throw Error(agent + (this.offered ? " could not finish. " : " could not start. ") + this.clean(result.failure.message));
		if (filing === undefined) {
			const refused = this.diagnosis().rejections.at(-1);
			if (refused) throw Error((reviewing ? "The review was refused. " : "The proposed guides were refused. ") + refused);
			throw Error(agent + (reviewing ? " stopped without filing a review." : " stopped without proposing any guides.") + " Run setup again.");
		}
		return { filed: filing, result };
	}
}
