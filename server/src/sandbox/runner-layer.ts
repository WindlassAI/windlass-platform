/**
 * The sandbox layer of a session whose place is one of its user's machines (Plans/2026-11-19 "bring
 * your own computer", sections 1.4 and 6). The machine's runner serves the provider's operations on its
 * own Docker; every one of them goes over the session's own socket, as a named operation on the
 * session's `ServerChannel` (runner/channel.ts). The turn code (turn.ts) runs here, on the server,
 * unchanged: `SandboxWindlass` over the handle this file makes.
 *
 * A machine's layer is made from the session's link alone (the session's owner, the machine's id),
 * on whichever server asks. The link reads the machine actor's last report without attaching: an offline or
 * removed machine's session stays readable. Its operations fail with a sentence a person can act on.
 *
 * The link (`RunnerLink`) is the session actor's, one per instance, kept in its vars and never stored:
 *
 *   - It has the runner attach on demand. An operation that finds no socket asks the machine's actor
 *     to send `attach` with a new one-use ticket (machines/ticket.ts), again every REATTACH_MS while it
 *     waits, and waits up to ATTACH_WAIT_MS in all for the runner's hello; a machine its actor says is
 *     offline or removed is refused at once.
 *   - A socket lost while work is outstanding is asked for again, every REATTACH_MS, until the work
 *     is done or the channel's grace ends the conversation (the channel then fails the work).
 *   - With nothing outstanding for IDLE_DETACH_MS the socket is let go, so the runner's socket does
 *     not keep the session's actor awake.
 *   - Once closed it does nothing more: no call to the machine's actor, no timer, nobody left waiting.
 *
 * What is repeated after a lost conversation (`ConversationLost`), as the slice B contract allows: the
 * operations that are the same done twice (`again`), `create` among them, because the runner answers
 * a session's second `create` with the sandbox it already made for it; `run` and `start` never (the
 * caller decides, and the turn's own `stopLeftovers` ends what a lost `start` left).
 */
import { isActorGone } from "../actors/internal.js";
import type { Attachment, MachineFacts, TurnSlot } from "../actors/machine.js";
import type { SandboxProfile, SandboxProfileId, SessionSnapshot } from "../contract.js";
import { describeError, serviceParams } from "../auth.js";
import { type ChannelSocket, ConversationLost, ServerChannel } from "../runner/channel.js";
import { machineProfiles } from "../machines/profiles.js";
import type { Args, Name, Value } from "../runner/protocol.js";
import { AttachTickets } from "../machines/ticket.js";
import { type CreateSandboxInput, type ExecOptions, type ExecResult, type ListedSandbox, type SandboxLayer, type Sandboxes, SandboxUserError } from "./api.js";
import { findProfile } from "./profiles.js";
import { type Answer, type ProcessEnd, type SandboxProcess, type StartOptions, type TurnSandbox, markTurnSandbox, randomId } from "./provider.js";
import { SandboxWindlass } from "./turn.js";

/** The raw socket's path: `agentSession.get([uid, sessionId]).webSocket(RUNNER_SOCKET)` on the runner's side. */
export const RUNNER_SOCKET = "runner";
/** How long an operation waits for the runner's hello once the machine's actor has sent `attach`. */
export const ATTACH_WAIT_MS = 15_000;
/** With nothing outstanding this long, the session lets go of the socket (it sleeps 30 s after its last connection). */
export const IDLE_DETACH_MS = 20_000;
/** How often the runner is offered a new ticket while work waits for its socket. */
const REATTACH_MS = 5_000;

// ---------------------------------------------------------------------------------------------
// The machine's actor, as the session sees it
// ---------------------------------------------------------------------------------------------

/** The three internal actions of the `machine` actor `[uid, machineId]` a session uses, and nothing else of it. */
export interface MachineSeam {
	/** Has the runner open this session's socket with `ticket`. */
	attach(sessionId: string, ticket: string): Promise<Attachment>;
	/** With the machine's key, which checks the runner's hello. */
	facts(): Promise<MachineFacts>;
	/** Records that the sandbox must go, and tells the runner when it is next connected. */
	removeSandbox(sandboxId: string | null, sessionId?: string): Promise<void>;
}

/** The real `machine` actor, through the actor's client. A check passes a stand-in instead. */
// biome-ignore lint/suspicious/noExplicitAny: the registry's type would be circular here
export function machineActor(client: () => any, uid: string, machineId: string) {
	const machine = () => client().machine.get([uid, machineId], { params: serviceParams() });
	return {
		turnSlot: (sessionId: string, turn: number): Promise<TurnSlot> => machine().internalTurnSlot(sessionId, turn),
		releaseSlot: (sessionId: string, turn: number): Promise<void> => machine().internalReleaseTurnSlot(sessionId, turn),
		attach: (sessionId: string, ticket: string) => machine().internalAttach({ sessionId, ticket }),
		facts: () => machine().internalFacts(),
		removeSandbox: async (sandboxId: string | null, sessionId?: string) => {
			try {
				await machine().internalRemoveSandbox({ sandboxId, sessionId });
			} catch (error) {
				if (!isActorGone(error)) throw error;
			}
		},
	};
}

/** The machine cannot be reached; `message` is the sentence a person reads. */
export class MachineUnreachable extends SandboxUserError {
	constructor(
		readonly reason: "offline" | "removed",
		message: string,
	) {
		super(message);
	}
}

const REMOVED = "This agent's machine was removed. Its files were there. Start a new agent to go on.";
const SLEPT = "The session went to sleep.";

/** The caller's abort signal fired before the operation was handed to the runner, which never had it. */
class Stopped extends Error {}

// ---------------------------------------------------------------------------------------------
// The session's link to the runner
// ---------------------------------------------------------------------------------------------

/** What a session's offline banner reads. */
export type MachineReach = NonNullable<SessionSnapshot["machine"]>;

interface Who {
	machineName?: string | null;
	uid: string;
	sessionId: string;
	machineId: string;
}

/** The socket RivetKit hands `onWebSocket`, as much of it as the link uses. */
interface RawSocket {
	send(text: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	addEventListener(type: "close", listener: () => void): void;
}

export class RunnerLink {
	readonly channel: ServerChannel;
	/** The first profile read is shared by snapshots and operations waiting to attach. */
	readonly initialFacts: Promise<MachineFacts | null>;
	private readonly tickets = new AttachTickets();
	/** What the machine's actor last said of it. Had before the first ticket goes out: its key checks the hello. */
	private heard: MachineFacts | null = null;
	private outstanding = 0;
	/** The callers waiting for a socket, with the one deadline they share. */
	private waiting: { promise: Promise<void>; settle(error?: Error): void } | null = null;
	/** A call to the machine's actor is under way: there is never more than one. */
	private inviting = false;
	private idle?: ReturnType<typeof setTimeout>;
	private retry?: ReturnType<typeof setTimeout>;
	/** What the link last found, for the banner; null before it needed the machine. */
	private found: MachineReach | null = null;
	private closed = false;

	/** `onReach` is told each time what the banner reads changes (answering, not answering, offline, removed). */
	constructor(
		readonly who: Who,
		private readonly machine: MachineSeam,
		onReset: (reason: string) => void,
		private readonly onReach?: (reach: MachineReach) => void,
	) {
		this.channel = new ServerChannel({
			accept: (hello) => this.tickets.admits(hello, { ...this.who, publicKey: this.heard?.publicKey ?? null }),
			onReset,
			onConnect: () => this.connected(),
			onDisconnect: () => this.lost(),
		});
		this.initialFacts = this.facts().catch(() => null);
	}

	/** A socket from `onWebSocket`. The channel decides by its hello whether it counts. */
	socket(ws: RawSocket): void {
		const socket: ChannelSocket = {
			send: (text) => ws.send(text),
			close: () => ws.close(1000),
			onMessage: (listener) => ws.addEventListener("message", (event) => listener(event.data)),
			onClose: (listener) => ws.addEventListener("close", () => listener()),
		};
		this.channel.attach(socket);
	}

	reach(): MachineReach | null {
		if (this.channel.connected) this.note("answering");
		return this.found;
	}

	/** What the machine's actor last said of the machine, as this link heard it; null before it asked. */
	get known(): MachineFacts | null {
		return this.heard;
	}

	/** Lets go for good: the actor is going to sleep or away, and its turn has been stopped. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.idle);
		clearTimeout(this.retry);
		this.waiting?.settle(new ConversationLost(SLEPT));
		this.channel.close(SLEPT);
	}

	async facts(): Promise<MachineFacts> {
		const facts = await this.machine.facts();
		this.heard = facts;
		return facts;
	}

	removeSandbox(id: string): Promise<void> {
		return this.machine.removeSandbox(id);
	}

	/** On deletion the machine also queues any sandbox it reported before the session learnt its id. */
	removeSessionSandboxes(savedId: string | null): Promise<void> {
		return this.machine.removeSandbox(savedId, this.who.sessionId);
	}

	/** One operation: waits for a socket first, so that one the machine cannot give fails now and not after the grace. */
	request<N extends Exclude<Name, "start">>(name: N, args: Args<N>, options: { onOutput?: (fd: 1 | 2, data: string) => void; signal?: AbortSignal } = {}): Promise<Value<N>> {
		return this.busy(async () => {
			await this.wait(options.signal);
			// Stopped in the moment since the socket came: the runner must never be handed it, as the channel would hand it over before its cancel.
			if (options.signal?.aborted) throw new Stopped();
			return await this.channel.request(name, args, options);
		});
	}

	/** An operation that is the same done twice: once more after a lost conversation. */
	async again<N extends Exclude<Name, "start">>(name: N, args: Args<N>): Promise<Value<N>> {
		try {
			return await this.request(name, args);
		} catch (error) {
			if (!(error instanceof ConversationLost)) throw error;
			return await this.request(name, args);
		}
	}

	/** A process: `ready` and the channel's `start`, with what is written meanwhile held in order. */
	start(args: Args<"start">, onOutput: (fd: 1 | 2, data: string) => void): RunnerProcess {
		return new RunnerProcess(this, args, onOutput);
	}

	/** Counts `work` as outstanding while it runs. */
	async busy<T>(work: () => Promise<T>): Promise<T> {
		this.outstanding += 1;
		clearTimeout(this.idle);
		try {
			return await work();
		} finally {
			this.outstanding -= 1;
			if (this.outstanding === 0 && !this.closed) {
				clearTimeout(this.retry);
				// The work that waited on a lost socket is over: the machine did not come back for it.
				if (this.found?.state === "not_answering" && !this.channel.connected) this.note("offline");
				this.restLater();
			}
		}
	}

	/** Resolves once a socket is current. Throws MachineUnreachable when the machine's actor says it cannot be, or no hello comes in time. */
	ready(): Promise<void> {
		return this.busy(() => this.wait());
	}

	/** An abort settles this caller at once; the others go on waiting. */
	private wait(signal?: AbortSignal): Promise<void> {
		if (this.closed) return Promise.reject(new ConversationLost(SLEPT));
		if (signal?.aborted) return Promise.reject(new Stopped());
		if (this.channel.connected) return Promise.resolve();
		const { promise } = this.waiting ?? this.begin();
		if (!signal) return promise;
		return new Promise<void>((resolve, reject) => {
			const stop = () => reject(new Stopped());
			signal.addEventListener("abort", stop, { once: true });
			promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
		});
	}

	/** The first caller to find no socket: one deadline from now, before the machine is even asked, for it and all who join it. */
	private begin(): NonNullable<RunnerLink["waiting"]> {
		let settle!: (error?: Error) => void;
		const promise = new Promise<void>((resolve, reject) => {
			settle = (error) => (error ? reject(error) : resolve());
		});
		// Each caller handles it; this only keeps it from counting as unhandled when the only one stopped waiting.
		promise.catch(() => undefined);
		const deadline = setTimeout(() => this.unreachable("offline"), ATTACH_WAIT_MS);
		const waiting = {
			promise,
			settle: (error?: Error) => {
				if (this.waiting !== waiting) return;
				this.waiting = null;
				clearTimeout(deadline);
				settle(error);
			},
		};
		this.waiting = waiting;
		this.ask();
		return waiting;
	}

	/** While work waits for a socket: a ticket now, and another every REATTACH_MS, whatever the machine's actor took to answer the last. */
	private ask(): void {
		clearTimeout(this.retry);
		if (this.closed || this.channel.connected || this.outstanding === 0) return;
		void this.invite();
		this.retry = setTimeout(() => this.ask(), REATTACH_MS);
	}

	/** One ticket through the machine's actor; skipped while the last call has not answered, so a slow actor is never asked twice at once. */
	private async invite(): Promise<void> {
		if (this.inviting) return;
		this.inviting = true;
		try {
			// The runner's hello can come before the actor's answer to `attach`: the key must be had first.
			await this.initialFacts;
			if (this.closed) return;
			if (!this.heard) await this.facts();
			if (this.closed || this.channel.connected) return;
			const answer = await this.machine.attach(this.who.sessionId, this.tickets.issue());
			if (!answer.ok && !this.closed) this.unreachable(answer.reason === "offline" ? "offline" : "removed");
		} catch (error) {
			// Asked again on the cadence; the deadline answers whoever waits.
			if (!this.closed) console.warn(`[wlp] runner.attach_unanswered session=${this.who.sessionId} machine=${this.who.machineId}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.inviting = false;
		}
	}

	/** Settles whoever waits for a socket. The name is what the link already has: nothing more is asked of an actor that may be what is slow. */
	private unreachable(reason: "offline" | "removed"): void {
		const error = this.away(reason);
		this.waiting?.settle(error);
	}

	away(reason: "offline" | "removed"): MachineUnreachable {
		if (reason === "removed" || this.found?.state !== "not_answering") this.note(reason);
		if (reason === "removed") {
			this.channel.close(REMOVED);
			return new MachineUnreachable(reason, REMOVED);
		}
		const name = this.heard?.name ?? this.who.machineName;
		return new MachineUnreachable(reason, `${name ? `Your machine "${name}"` : "Your machine"} is offline. The agent's files are there; send the prompt again when it is back.`);
	}

	/** A hello made a socket current. */
	private connected(): void {
		this.note("answering");
		clearTimeout(this.retry);
		this.waiting?.settle();
		// A runner can answer a ticket after the work it was for gave up: that socket goes like any idle one.
		if (this.outstanding === 0) this.restLater();
	}

	/** The socket closed. With work outstanding the runner is asked back; the channel keeps the work for its grace. */
	private lost(): void {
		if (this.closed || this.channel.connected) return;
		this.note(this.outstanding ? "not_answering" : "offline");
		if (this.outstanding) this.ask();
	}

	private note(state: MachineReach["state"]): void {
		if (this.found?.state === state) return;
		this.found = { state, since: Date.now() };
		this.onReach?.(this.found);
	}

	private restLater(): void {
		clearTimeout(this.idle);
		this.idle = setTimeout(() => this.rest(), IDLE_DETACH_MS);
	}

	private rest(): void {
		if (this.outstanding === 0 && this.channel.connected) this.channel.detach();
	}
}

/** `SandboxProcess` over the link: started once the socket is there, with stdin and a close held until then. */
class RunnerProcess implements SandboxProcess {
	readonly ended: Promise<ProcessEnd>;
	hasEnded = false;
	private id: string | null = null;
	private held: string[] = [];
	private closing = false;

	constructor(
		private readonly link: RunnerLink,
		readonly args: Args<"start">,
		onOutput: (fd: 1 | 2, data: string) => void,
	) {
		const ran = link.busy(async () => {
			await link.ready();
			const { id, ended } = link.channel.start(args, onOutput);
			this.id = id;
			for (const text of this.held.splice(0)) link.channel.write(id, text);
			if (this.closing) link.channel.closeIn(id);
			return await ended;
		});
		this.ended = ran.then(
			(end) => end,
			(error: unknown): ProcessEnd => ({ code: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) }),
		).then((end) => {
			this.hasEnded = true;
			return end;
		});
	}

	get tag(): string {
		return this.args.tag;
	}

	write(text: string): boolean {
		if (this.hasEnded || this.closing) return false;
		if (this.id === null) {
			this.held.push(text);
			return true;
		}
		return this.link.channel.write(this.id, text);
	}

	closeStdin(): void {
		if (this.id === null) this.closing = true;
		else this.link.channel.closeIn(this.id);
	}

	async signal(sig: "INT" | "TERM" | "KILL", who: "leader" | "all"): Promise<void> {
		// A process not started yet has nothing to signal; one whose link is gone has nobody to tell.
		if (this.id === null || this.hasEnded) return;
		await this.link.request("signal", { process: this.id, sig, who }).catch(() => undefined);
	}

	killClient(): void {
		if (this.id !== null && !this.hasEnded) void this.link.request("killClient", { process: this.id }).catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------------------------

class RunnerHandle implements TurnSandbox {
	readonly approval: "auto" | "full";

	constructor(
		private readonly link: RunnerLink,
		readonly id: string,
		readonly profile: SandboxProfileId,
		readonly cwd: string,
		readonly runnerScreenshots: boolean,
	) {
		this.approval = findProfile(profile).approval;
		markTurnSandbox(this);
	}

	get uid(): string {
		return this.link.who.uid;
	}

	async run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const { onStdout, onStderr, signal, ...rest } = options;
		try {
			// Not repeated: a clone, a push or a setup run that was lost is the caller's to try again or not.
			return await this.link.request("run", { id: this.id, command, options: rest }, { signal, onOutput: (fd, data) => (fd === 1 ? onStdout : onStderr)?.(data) });
		} catch (error) {
			if (error instanceof Stopped) return { exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "" };
			throw error;
		}
	}

	readTextFile(path: string): Promise<string> {
		return this.link.again("readTextFile", { id: this.id, path });
	}

	async writeTextFile(path: string, content: string): Promise<void> {
		await this.link.again("writeTextFile", { id: this.id, path, content });
	}

	start(argv: string[], options: StartOptions = {}): SandboxProcess {
		const { onStdout, onStderr, ...rest } = options;
		// The server names the tag, so the process has it before the runner answers.
		return this.link.start({ id: this.id, tag: `r${randomId(6)}`, argv, options: rest }, (fd, data) => (fd === 1 ? onStdout : onStderr)?.(data));
	}

	/**
	 * Null when it could not be run, as the interface has it: the link is gone, or the machine with it.
	 * Repeated after a lost conversation, which is safe only for an `ask` that reads: every `ask` of
	 * turn.ts does. An `ask` that is not the same done twice needs its own path through `request`, not
	 * this one.
	 */
	ask(argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<Answer | null> {
		return this.link.again("ask", { id: this.id, argv, options }).catch(() => null);
	}

	stopLeftovers(program: string): Promise<number> {
		return this.link.again("stopLeftovers", { id: this.id, program });
	}

	sweep(tag: string, options?: { waitMs?: number; files?: string[] }): Promise<number> {
		return this.link.again("sweep", { id: this.id, tag, options });
	}

	async writeSecretFile(path: string, content: string): Promise<void> {
		await this.link.again("writeSecretFile", { id: this.id, path, content });
	}

	async removeFiles(paths: string[]): Promise<void> {
		await this.link.again("removeFiles", { id: this.id, paths });
	}

	/**
	 * Nothing, as on hosted Docker: the runner never stops a sandbox while its session's socket is
	 * connected or anything runs in it, so a turn has nothing to vouch for.
	 */
	async holdForTurn(): Promise<() => Promise<void>> {
		return async () => undefined;
	}
}

class RunnerSandboxes implements Sandboxes {
	/** A sandbox on the machine stops when its session suspends it or by the runner's own idle rule, and costs the platform nothing. */
	readonly idleStopMs = null;
	/** Windlass's data is in the user's volume on the machine, which outlives every sandbox there. */
	readonly sessionsLiveInSandbox = false;

	constructor(private readonly link: RunnerLink) {}

	price(): null {
		return null;
	}

	/** From the machine's last report, with availability unknown while the actor cannot answer. */
	profiles(): SandboxProfile[] {
		const facts = this.link.known;
		return machineProfiles(facts?.name || this.link.who.machineName, facts?.report ?? null);
	}

	/** Never throws for a profile the platform knows: a session must stay readable whatever its machine reports. */
	profile(id: SandboxProfileId): SandboxProfile {
		return this.profiles().find((profile) => profile.id === id) ?? findProfile(id);
	}

	async list(uid: string): Promise<ListedSandbox[]> {
		if (uid !== this.link.who.uid) return [];
		const { report } = await this.link.facts();
		return (report?.sandboxes ?? []).map(({ id, sessionId, state }) => ({ id, sessionId, state }));
	}

	async create(input: CreateSandboxInput): Promise<string> {
		const { link } = this;
		if (input.uid !== link.who.uid || input.sessionId !== link.who.sessionId) throw new Error("A machine's sandbox is made only for the session whose socket asks for it.");
		if (input.profile !== "docker-windlass-sandbox" && input.profile !== "docker-hardened") throw new SandboxUserError(`${findProfile(input.profile).name} does not run on a machine of yours.`);
		// A `create` lost with its conversation may have made the sandbox: the runner answers the repeat with that one.
		// Request the screenshots image only when this runner offers it.
		if (input.harness === "claude" && input.profile !== "docker-hardened") throw new SandboxUserError("Claude Code requires the docker-hardened profile.");
		const report = input.harness || input.screenshots ? (await link.facts()).report : null;
		if (input.harness && !report?.harnesses?.some(h => h.id === input.harness))
			throw new SandboxUserError("This machine's runner does not offer Claude Code. Update it and start it with --harness claude.");
		return await link.again("create", { profile: input.profile, ...(input.harness ? { harness: input.harness } : {}),
			...(input.screenshots && !input.harness && report?.screenshots ? { screenshots: true } : {}) });
	}

	async connect(id: string): Promise<TurnSandbox | undefined> {
		const { link } = this;
		const found = await link.again("connect", { id });
		return found ? new RunnerHandle(link, id, found.profile, found.cwd, found.screenshots === true) : undefined;
	}

	/** On a machine that cannot be reached, what its last report said. */
	async state(id: string): Promise<"none" | "running" | "paused"> {
		const { link } = this;
		try {
			await link.ready();
		} catch (error) {
			if (!(error instanceof MachineUnreachable)) throw error;
			return (await link.facts()).report?.sandboxes.find((sandbox) => sandbox.id === id)?.state ?? "none";
		}
		return link.again("state", { id });
	}

	/**
	 * Throws MachineUnreachable on a machine that cannot be reached, so that its caller keeps the state it
	 * had: one whose network is down may still be running it, and a session that said "paused" would not
	 * ask again. The runner stops one nobody uses by itself.
	 */
	async suspend(id: string): Promise<void> {
		await this.link.again("suspend", { id });
	}

	/** Recorded with the machine's actor first, which has the runner remove it when it is next connected: so a machine that is offline now still loses it. */
	async destroy(id: string): Promise<void> {
		const { link } = this;
		await link.removeSandbox(id);
		// Recorded: the removal happens whatever follows, so only a record not written fails the caller
		// (a session's delete is refused then, agent-session.ts `internalDestroy`). Asking now is only sooner.
		try {
			await link.ready();
			await link.again("destroy", { id });
		} catch (error) {
			if (!(error instanceof MachineUnreachable)) console.warn(`[wlp] sandbox.destroy_later id=${id}: recorded with the machine, which removes it when its runner is next connected (${describeError(error)})`);
		}
	}
}

/**
 * The layer of a machine. Its sign-ins and access tokens are the deployment's (`hosted`): the platform
 * keeps the one sign-in, and a turn on a machine is handed a token as any turn is.
 * The turn checks the machine sandbox's own engine for host tools.
 */
export function machineLayer(link: RunnerLink, hosted: SandboxLayer): SandboxLayer {
	const host = { version: async () => null, problem: () => hosted.windlass.problem() };
	const windlass = new SandboxWindlass(hosted.tokens, host);
	return { machine: { name: link.known?.name || link.who.machineName || link.who.machineId }, sandboxes: new RunnerSandboxes(link), windlass, logins: hosted.logins, tokens: hosted.tokens, backups: null };
}
