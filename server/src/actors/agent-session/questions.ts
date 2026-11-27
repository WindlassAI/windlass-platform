import { randomBytes } from "node:crypto";
import { describeError } from "../../auth.js";
import { config } from "../../config.js";
import type { PendingQuestion, SessionServers } from "../../contract.js";
import type { TurnAnswer, TurnQuestion, TurnServer, TurnServerQuestion } from "../../sandbox/api.js";
import { type ServerApproval, knownServers, projectOf, sameServers, serversView } from "../../server-approvals.js";
import {
	SERVER_START,
	type ServerQuestionContext,
	forgettingWords,
	serverExpiredNote,
	serverNotNowNote,
	serverPanelWords,
	serverQuestionWords,
	serverUnansweredNote,
} from "../../server-question.js";
import { hostedLimitsApply } from "../../usage.js";
import { userActor } from "../internal.js";
import { PLATFORM_RESTART } from "../../sandbox/api.js";
import { machineHarnesses } from "../../sandbox/harnesses.js";
import { privateSessionData } from "../../sandbox/session-data.js";
import { note, persist } from "./timeline.js";
import type { Ctx, SessionMeta, ActiveTurn, Asked } from "./state.js";
import { layerOf, machineOf } from "./runner.js";
import { publish } from "./summary.js";

/** How long a turn waits for the `user` actor to say whether a server's approval is remembered, before it asks the user instead. */
export const RECALL_WAIT_MS = 10_000;

export function duration(ms: number): string {
	const plural = (count: number, unit: string) => (count === 1 ? `1 ${unit}` : `${count} ${unit}s`);
	if (ms >= 2 * 86_400_000 || (ms >= 86_400_000 && ms % 86_400_000 === 0))
		return plural(Math.round(ms / 86_400_000), "day");
	if (ms >= 2 * 3_600_000 || (ms >= 3_600_000 && ms % 3_600_000 === 0))
		return plural(Math.round(ms / 3_600_000), "hour");
	if (ms >= 60_000) {
		const minutes = Math.round(ms / 60_000);
		return minutes === 1 ? "1 minute" : `${minutes} minutes`;
	}
	const seconds = Math.max(1, Math.round(ms / 1000));
	return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

/** What the sandbox layer hands over is typed, but it is another module's word: nothing is assumed of it. */
export function str(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

// Take synchronously so only one concurrent answer can settle the question.
export function takeQuestion(c: Ctx, meta: SessionMeta, active: ActiveTurn): Asked | null {
	const asked = active.question;
	if (!asked) return null;
	active.question = null;
	meta.updatedAt = Date.now();
	clearTimeout(asked.timer);
	if (meta.status === "waiting") meta.status = "running";
	c.broadcast("question", null);
	// A server's question that stood aside is put again, unless the turn is on its way out.
	if (!active.closed && !active.stopping) active.aside.shift()?.put?.();
	return asked;
}

export function askQuestion(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	question: TurnQuestion,
	withdrawn: AbortSignal,
): Promise<TurnAnswer> {
	const choices = (Array.isArray(question?.choices) ? question.choices : []).map(choice => ({
		id: str(choice?.id),
		label: str(choice?.label) || str(choice?.id),
		approve: choice?.approve === true,
		remembers: typeof choice?.remembers === "string" && choice.remembers !== "" ? choice.remembers : null,
	}));
	// "deny" is Windlass's own id for it; a rejection declines a question that has no such choice.
	const refusal =
		choices.find(choice => choice.id === "deny" && !choice.approve) ?? choices.find(choice => !choice.approve);
	const declined = (why?: string): Promise<TurnAnswer> =>
		refusal
			? Promise.resolve({ choice: refusal.id, note: why })
			: Promise.reject(new Error(why ?? "the question was declined"));
	const title = str(question?.title) || "Allow this tool call?";

	if (active.closed || active.controller.signal.aborted || withdrawn.aborted) return declined();
	if (active.question?.put) {
		// A tool call takes precedence. Requeue the server question when the call is answered.
		const aside = active.question;
		clearTimeout(aside.timer);
		aside.timer = undefined;
		active.question = null;
		active.aside.unshift(aside);
		if (meta.status === "waiting") meta.status = "running";
	} else if (active.question) {
		// Windlass asks one question at a time, and the contract shows one. A second one is not left to hang.
		note(
			c,
			active.number,
			"warn",
			`${meta.harness && meta.harness !== "windlass" ? machineHarnesses[meta.harness].name : "Windlass"} asked "${title}" while another question was waiting for an answer, so it was declined.`,
		);
		return declined(
			"Another question was waiting for the user's answer, so the platform declined this call. Ask again if it is still needed.",
		);
	}

	const now = Date.now();
	const pending: PendingQuestion = {
		id: `q_${randomBytes(8).toString("hex")}`,
		turn: active.number,
		messageId: str(question.messageId),
		callId: str(question.callId),
		title,
		subject: str(question.subject),
		details: Array.isArray(question.details) ? question.details.map(str) : [],
		choices,
		subagent: typeof question.subagent === "string" && question.subagent !== "" ? question.subagent : null,
		askedAt: now,
		expiresAt: now + questionWait(meta),
	};
	return new Promise<TurnAnswer>((resolve, reject) => {
		const settled = (): void => {
			withdrawn.removeEventListener("abort", onWithdrawn);
			active.unsettled.delete(asked);
		};
		const wait = questionWait(meta);
		const asked: Asked = {
			pending,
			timer: setTimeout(() => {
				// Nobody answered: the turn must not wait for ever, and the model should know why it was refused.
				if (active.question !== asked) return;
				takeQuestion(c, meta, active);
				// A hosted sandbox runs, and costs, while it waits: the turn ends, and the sandbox pauses at once (`pauseNow`).
				const hosted = hostedLimitsApply(meta.place);
				note(
					c,
					active.number,
					"warn",
					hosted
						? `Nobody answered "${pending.title}" within ${duration(wait)}, so the turn was ended and its sandbox paused. Send a prompt to go on.`
						: `Nobody answered "${pending.title}" within ${duration(wait)}, so it was declined.`,
					{
						code: "question_expired",
						call: { messageId: pending.messageId, callId: pending.callId },
					},
				);
				if (hosted) meta.pauseNow = true;
				publish(c);
				void persist(c);
				asked.decline(`Nobody answered within ${duration(wait)}, so the platform declined this call for the user.`);
				if (hosted) abortTurn(c, meta, active);
			}, wait),
			answer: answer => {
				settled();
				resolve(answer);
			},
			decline: why => {
				settled();
				if (refusal) resolve({ choice: refusal.id, note: why });
				else reject(new Error(why ?? "the question was withdrawn"));
			},
		};
		// The harness withdrew this question or stopped the turn.
		function onWithdrawn(): void {
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			asked.decline();
		}
		withdrawn.addEventListener("abort", onWithdrawn, { once: true });
		active.unsettled.add(asked);
		active.question = asked;
		meta.updatedAt = now;
		if (meta.status === "running") meta.status = "waiting";
		c.broadcast("question", pending);
		publish(c);
		void persist(c);
	});
}

// Approvals bind to the owner, project and exact definition fingerprint.
export const serverApprovals = {
	/** The approvals remembered for this session's project that have not run out, the newest first. */
	of(c: Ctx, meta: SessionMeta): Promise<ServerApproval[]> {
		return userActor(c, meta.uid).internalServerApprovals(projectOf(meta).key);
	},
	async approved(
		c: Ctx,
		meta: SessionMeta,
		question: Pick<TurnServerQuestion, "name" | "fingerprint">,
	): Promise<ServerApproval | null> {
		if (question.name === "" || question.fingerprint === "") return null;
		const approvals = await serverApprovals.of(c, meta);
		return (
			approvals.find(approval => approval.name === question.name && approval.fingerprint === question.fingerprint) ??
			null
		);
	},
	async remember(c: Ctx, meta: SessionMeta, question: Pick<TurnServerQuestion, "name" | "fingerprint">): Promise<void> {
		const project = projectOf(meta);
		await userActor(c, meta.uid).internalServerApprove({
			project: project.key,
			label: project.label,
			name: question.name,
			fingerprint: question.fingerprint,
		});
	},
	async forget(c: Ctx, meta: SessionMeta, name: string): Promise<number> {
		return (await userActor(c, meta.uid).internalServerForget({ project: projectOf(meta).key, name })).forgotten;
	},
};

export const serverKey = (question: Pick<TurnServerQuestion, "name" | "fingerprint">) =>
	`${question.name}:${question.fingerprint}`;

/** `promise`'s value, or null when it fails or takes longer than `ms`. */
export function orNull<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise.catch(() => null),
		new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), ms))),
	]).finally(() => clearTimeout(timer));
}

/** Says that what the session knows of its project's servers, or of their approvals, changed: clients ask `servers()` again. */
export function serversChanged(c: Ctx, meta: SessionMeta): void {
	const now = Date.now();
	meta.serversChangedAt = meta.serversChangedAt >= now ? meta.serversChangedAt + 1 : now;
	publish(c);
	void persist(c);
}

/** The layer's `onServers`: keeps what Windlass says of the project's servers, for the side panel. */
export function knowServers(c: Ctx, meta: SessionMeta, said: TurnServer[]): void {
	const known = meta.servers ?? [];
	const next = knownServers(known, Array.isArray(said) ? said : [], Date.now());
	if (sameServers(known, next)) return;
	meta.servers = next;
	serversChanged(c, meta);
}

/** Keeps the user's yes for the session's project. A failure costs one more question in another session, and is logged. */
export function rememberServer(
	c: Ctx,
	meta: SessionMeta,
	question: Pick<TurnServerQuestion, "name" | "fingerprint">,
): Promise<void> {
	const work = serverApprovals.remember(c, meta, question).then(
		() => serversChanged(c, meta),
		(error: unknown) =>
			c.log.warn({
				msg: "could not remember the approval of a project's MCP server",
				session: meta.sessionId,
				server: question.name,
				error: describeError(error),
			}),
	);
	return c.vars.stopping ? work : c.keepAwake(work);
}

/** When the user approved, in the words of a line: "3 days ago". */
export function ago(ms: number): string {
	return ms < 60_000 ? "a moment ago" : `${duration(ms)} ago`;
}

/** The session's servers as the side panel shows them: what the session kept, and what the user's record says of each. */
export async function sessionServers(c: Ctx, meta: SessionMeta): Promise<SessionServers> {
	const known = meta.servers ?? [];
	const { sandboxes } = await layerOf(c, meta);
	// A session whose project names no server asks nobody: the user's own have no approval.
	const approvals = known.some(server => server.origin !== "user") ? await serverApprovals.of(c, meta) : [];
	const project = projectOf(meta);
	const context: ServerQuestionContext = {
		profile: sandboxes.profile(meta.profile),
		demo: meta.demo,
		dataInSandbox: await privateSessionData(meta, sandboxes, meta.sandboxId),
		project,
		machine: machineOf(meta),
		hostedEgress: meta.place.kind === "hosted" ? sandboxes.egress?.() : undefined,
	};
	const view = serversView(project, known, approvals, forgettingWords(context), server =>
		serverPanelWords(server, context),
	);
	// Why a server of the user's own that reads an account's secret does not start here, where that is so.
	return known.some(server => server.origin === "user")
		? { ...view, accountSecrets: meta.accountSecrets ?? null }
		: view;
}

// A tool-call question may interrupt this question and requeue it with a fresh timeout.
export async function askServer(
	c: Ctx,
	meta: SessionMeta,
	active: ActiveTurn,
	context: ServerQuestionContext,
	given: TurnServerQuestion,
	withdrawn: AbortSignal,
): Promise<boolean> {
	const gone = () => active.closed || active.stopping || active.controller.signal.aborted || withdrawn.aborted;
	const argv = Array.isArray(given?.argv) ? given.argv.map(str) : null;
	const question: TurnServerQuestion = {
		name: str(given?.name),
		fingerprint: str(given?.fingerprint),
		argv,
		url: argv === null ? str(given?.url) : null,
		file: typeof given?.file === "string" && given.file !== "" ? given.file : null,
		unset: Array.isArray(given?.unset) ? given.unset.map(str) : [],
		secrets: Array.isArray(given?.secrets) ? given.secrets.map(str) : [],
		holdsTurn: given?.holdsTurn === true,
	};
	if (gone()) return false;
	// The user's own record first. Should it not answer in time, the user is asked, which is never wrong.
	const recalled = await orNull(serverApprovals.approved(c, meta, question), RECALL_WAIT_MS);
	if (gone()) return false;
	if (recalled) {
		active.recalled.set(serverKey(question), recalled);
		return true;
	}

	const words = serverQuestionWords(question, context);
	const now = Date.now();
	return new Promise<boolean>(resolve => {
		let done = false;
		let shown = false;
		const settle = (start: boolean): void => {
			if (done) return;
			done = true;
			withdrawn.removeEventListener("abort", onWithdrawn);
			active.unsettled.delete(asked);
			const at = active.aside.indexOf(asked);
			if (at >= 0) active.aside.splice(at, 1);
			clearTimeout(asked.timer);
			resolve(start);
		};
		const asked: Asked = {
			pending: {
				id: `q_${randomBytes(8).toString("hex")}`,
				turn: active.number,
				messageId: "",
				callId: "",
				title: words.title,
				subject: words.subject,
				details: words.details,
				choices: words.choices,
				subagent: null,
				askedAt: now,
				expiresAt: now + config.questionTimeoutMs,
				server: {
					name: question.name,
					file: question.file,
					remote: argv === null,
					unset: question.unset,
					holdsTurn: question.holdsTurn,
				},
			},
			timer: undefined,
			server: { name: question.name, fingerprint: question.fingerprint },
			answer: answer => {
				if (done) return;
				const start = answer.choice === SERVER_START;
				// A yes gets its line, and is remembered, when Windlass has said what became of the server (`onServerApproved`).
				if (!start) note(c, active.number, "info", serverNotNowNote(question));
				settle(start);
			},
			decline: () => settle(false),
			put: () => {
				// Put again after it stood aside, it has the whole time to be answered in once more.
				if (shown) asked.pending = { ...asked.pending, expiresAt: Date.now() + config.questionTimeoutMs };
				shown = true;
				asked.timer = setTimeout(
					() => {
						// Nobody answered: "not now", and the turn goes on without the server.
						if (active.question !== asked) return;
						takeQuestion(c, meta, active);
						note(c, active.number, "warn", serverExpiredNote(question, duration(config.questionTimeoutMs)));
						publish(c);
						void persist(c);
						settle(false);
					},
					Math.max(0, asked.pending.expiresAt - Date.now()),
				);
				active.question = asked;
				meta.updatedAt = Date.now();
				if (question.holdsTurn && meta.status === "running") meta.status = "waiting";
				c.broadcast("question", asked.pending);
				publish(c);
				void persist(c);
			},
		};
		// The layer withdrew the question: the turn was stopped, or ended under a question put while it ran.
		function onWithdrawn(): void {
			if (done) return;
			if (!active.stopping && !active.controller.signal.aborted)
				note(c, active.number, "info", serverUnansweredNote(question));
			if (active.question === asked) {
				takeQuestion(c, meta, active);
				publish(c);
				void persist(c);
			}
			settle(false);
		}
		withdrawn.addEventListener("abort", onWithdrawn, { once: true });
		active.unsettled.add(asked);
		if (active.question) active.aside.push(asked);
		else asked.put?.();
	});
}

/** How long a turn's question waits for its answer: shorter in a hosted sandbox, which runs while it waits. */
function questionWait(meta: SessionMeta): number {
	return hostedLimitsApply(meta.place) ? config.hostedQuestionTimeoutMs : config.questionTimeoutMs;
}

/** Stops the turn. The question it may be waiting on goes first: nobody can answer a turn that is ending. */
export function abortTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn): void {
	active.stopping = true;
	if (takeQuestion(c, meta, active)) {
		publish(c);
		void persist(c);
	}
	const shutdown =
		active.pausing === "restart" && meta.place.kind === "hosted" && (meta.harness ?? "windlass") === "windlass";
	active.controller.abort(shutdown ? PLATFORM_RESTART : undefined);
}

/** Closes the turn to steering, stopping one call and answering, and leaves no question behind. Never throws. */
export function sealTurn(c: Ctx, meta: SessionMeta, active: ActiveTurn): void {
	active.closed = true;
	active.control = null;
	try {
		takeQuestion(c, meta, active);
		for (const asked of [...active.unsettled]) asked.decline();
	} catch (error) {
		active.question = null;
		c.log.error({ msg: "could not withdraw the turn's question", error: describeError(error) });
	}
}
