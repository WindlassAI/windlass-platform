/**
 * The sandbox layer of a session whose place is one of its user's machines (Plans/2026-11-19 "bring
 * your own computer", sections 1.4 and 6). The machine's runner serves the provider's operations on its
 * own Docker; every one of them goes over the session's own socket, as a named operation on the
 * session's `ServerChannel` (runner/channel.ts). The turn code (turn.ts) runs here, on the server,
 * unchanged: `SandboxWindlass` over the handle this file makes.
 *
 * A machine's layer is made from the session's link alone (the session's owner, the machine's id),
 * on whichever server asks, and making it calls nothing: a session on a machine that is offline or
 * removed stays readable. Its operations fail instead, with a sentence a person can act on.
 *
 * The link (`RunnerLink`) is the session actor's, one per instance, kept in its vars and never stored:
 *
 *   - It has the runner attach on demand. An operation that finds no socket asks the machine's actor
 *     to send `attach` with a new one-use ticket (runner/ticket.ts), and waits up to ATTACH_WAIT_MS for
 *     the runner's hello; a machine its actor says is offline or removed is refused at once.
 *   - A socket lost while work is outstanding is asked for again, every REATTACH_MS, until the work
 *     is done or the channel's grace ends the conversation (the channel then fails the work).
 *   - With nothing outstanding for IDLE_DETACH_MS the socket is let go, so the runner's socket does
 *     not keep the session's actor awake.
 *
 * What is repeated after a lost conversation (`ConversationLost`), as the slice B contract allows: the
 * operations that are the same done twice (`again`); `create` only after the machine's last report
 * shows no sandbox of this session's; `run` and `start` never (the caller decides, and the turn's own
 * `stopLeftovers` ends what a lost `start` left).
 */
import type { SandboxProfile, SandboxProfileId, SessionSnapshot } from "../contract.js";
import { serviceParams } from "../auth.js";
import { type ChannelSocket, ConversationLost, ServerChannel } from "../runner/channel.js";
import type { Report } from "../runner/control.js";
import { machineProfiles } from "../runner/machine-profiles.js";
import type { Args, Name, Value } from "../runner/protocol.js";
import { AttachTickets } from "../runner/ticket.js";
import { type CreateSandboxInput, type ExecOptions, type ExecResult, type ListedSandbox, type SandboxLayer, type Sandboxes, SandboxUserError, type Windlass } from "./api.js";
import { findProfile } from "./profiles.js";
import { type Answer, type ProcessEnd, type SandboxProcess, type StartOptions, type TurnSandbox, markTurnSandbox, randomId } from "./provider.js";
import { SandboxWindlass } from "./turn.js";

/** The raw socket's path: `agentSession.get([uid, sessionId]).webSocket(RUNNER_SOCKET)` on the runner's side. */
export const RUNNER_SOCKET = "runner";
/** How long an operation waits for the runner's hello once the machine's actor has sent `attach`. */
export const ATTACH_WAIT_MS = 15_000;
/** With nothing outstanding this long, the session lets go of the socket (it sleeps 30 s after its last connection). */
export const IDLE_DETACH_MS = 20_000;
/** How often a socket lost under outstanding work is asked for again. */
const REATTACH_MS = 5_000;

// ---------------------------------------------------------------------------------------------
// The machine's actor, as the session sees it
// ---------------------------------------------------------------------------------------------

export interface MachineFacts {
	status: "waiting" | "online" | "offline" | "removed";
	name: string;
	/** The machine's last report (runner/control.ts), or null before its first. */
	report: Report | null;
}
export type Attachment = { ok: true; publicKey: string } | { ok: false; reason: "offline" | "removed" | "unknown" };

/** The three internal actions of the `machine` actor `[uid, machineId]` a session uses, and nothing else of it. */
export interface MachineSeam {
	/** Has the runner open this session's socket with `ticket`; the machine's key comes back to check its hello with. */
	attach(sessionId: string, ticket: string): Promise<Attachment>;
	facts(): Promise<MachineFacts>;
	/** Records that the sandbox must go, and tells the runner when it is next connected. */
	removeSandbox(sandboxId: string): Promise<void>;
}

/** The real `machine` actor, through the actor's client. A check passes a stand-in instead. */
// biome-ignore lint/suspicious/noExplicitAny: the registry's type would be circular here
export function machineActor(client: () => any, uid: string, machineId: string): MachineSeam {
	const machine = () => client().machine.get([uid, machineId], { params: serviceParams() });
	return {
		attach: (sessionId, ticket) => machine().internalAttach({ sessionId, ticket }),
		facts: () => machine().internalFacts(),
		removeSandbox: (sandboxId) => machine().internalRemoveSandbox({ sandboxId }),
	};
}

/** What a machine's actor last said of it, on this server: only for `profiles()`, which cannot wait for an answer. */
const lastFacts = new Map<string, MachineFacts>();
const KNOWN_MACHINES = 1_000;

function remember(key: string, facts: MachineFacts): void {
	lastFacts.delete(key);
	lastFacts.set(key, facts);
	for (const oldest of lastFacts.keys()) {
		if (lastFacts.size <= KNOWN_MACHINES) break;
		lastFacts.delete(oldest);
	}
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

// ---------------------------------------------------------------------------------------------
// The session's link to the runner
// ---------------------------------------------------------------------------------------------

/** What a session's offline banner reads. */
export type MachineReach = NonNullable<SessionSnapshot["machine"]>;

interface Who {
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
	private readonly tickets = new AttachTickets();
	private publicKey: string | null = null;
	private outstanding = 0;
	private attaching: Promise<void> | null = null;
	private idle?: ReturnType<typeof setTimeout>;
	private retry?: ReturnType<typeof setTimeout>;
	/** What the link last found, for the banner; null before it needed the machine. */
	private found: MachineReach | null = null;
	private closed = false;

	constructor(
		readonly who: Who,
		private readonly machine: MachineSeam,
		onReset: (reason: string) => void,
	) {
		this.channel = new ServerChannel({
			accept: (hello) => this.tickets.admits(hello, { ...this.who, publicKey: this.publicKey }),
			onReset,
		});
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
		// After the channel's own listener, which lets go of the socket when it was the current one.
		ws.addEventListener("close", () => this.lost());
	}

	reach(): MachineReach | null {
		if (this.channel.connected) this.note("answering");
		return this.found;
	}

	/** Lets go for good: the actor is going to sleep or away, and its turn has been stopped. */
	close(): void {
		this.closed = true;
		clearTimeout(this.idle);
		clearTimeout(this.retry);
		this.channel.close("The session went to sleep.");
	}

	async facts(): Promise<MachineFacts> {
		const facts = await this.machine.facts();
		remember(`${this.who.uid}/${this.who.machineId}`, facts);
		return facts;
	}

	removeSandbox(id: string): Promise<void> {
		return this.machine.removeSandbox(id);
	}

	/** One operation: waits for a socket first, so that one the machine cannot give fails now and not after the grace. */
	request<N extends Exclude<Name, "start">>(name: N, args: Args<N>, options: { onOutput?: (fd: 1 | 2, data: string) => void; signal?: AbortSignal } = {}): Promise<Value<N>> {
		return this.busy(async () => {
			await this.ready();
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
			if (this.outstanding === 0) {
				// The work that waited on a lost socket is over: the machine did not come back for it.
				if (this.found?.state === "not_answering" && !this.channel.connected) this.note("offline");
				this.idle = setTimeout(() => this.rest(), IDLE_DETACH_MS);
			}
		}
	}

	/** Resolves once a socket is current. Throws MachineUnreachable when the machine's actor says it cannot be, or no hello comes in time. */
	ready(): Promise<void> {
		if (this.closed) return Promise.reject(new ConversationLost("The session went to sleep."));
		if (this.channel.connected) return Promise.resolve();
		this.attaching ??= this.attach().finally(() => {
			this.attaching = null;
		});
		return this.attaching;
	}

	private async attach(): Promise<void> {
		const answer = await this.machine.attach(this.who.sessionId, this.tickets.issue());
		if (!answer.ok) throw await this.unreachable(answer.reason === "offline" ? "offline" : "removed");
		this.publicKey = answer.publicKey;
		const deadline = Date.now() + ATTACH_WAIT_MS;
		while (!this.channel.connected) {
			if (Date.now() >= deadline) throw await this.unreachable("offline");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		this.note("answering");
	}

	private async unreachable(reason: "offline" | "removed"): Promise<MachineUnreachable> {
		// While work waits on a lost socket, the banner goes on saying that the machine stopped answering, and since when.
		if (reason === "removed" || this.found?.state !== "not_answering") this.note(reason);
		if (reason === "removed") {
			// It never comes back: what waits on it (a turn whose socket the runner dropped) ends now, not after the grace.
			this.channel.close(REMOVED);
			return new MachineUnreachable(reason, REMOVED);
		}
		const name = await this.facts().then(
			(facts) => facts.name,
			() => null,
		);
		return new MachineUnreachable(reason, `${name ? `Your machine "${name}"` : "Your machine"} is offline. The agent's files are there; send the prompt again when it is back.`);
	}

	/** The socket closed. With work outstanding the runner is asked back; the channel keeps the work for its grace. */
	private lost(): void {
		if (this.channel.connected || this.outstanding === 0) return;
		this.note("not_answering");
		this.askAgain();
	}

	private note(state: MachineReach["state"]): void {
		if (this.found?.state !== state) this.found = { state, since: Date.now() };
	}

	private askAgain(): void {
		clearTimeout(this.retry);
		if (this.closed || this.channel.connected || this.outstanding === 0) return;
		this.ready().catch(() => {
			this.retry = setTimeout(() => this.askAgain(), REATTACH_MS);
		});
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
	) {
		this.approval = findProfile(profile).approval;
		markTurnSandbox(this);
	}

	get uid(): string {
		return this.link.who.uid;
	}

	async run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const { onStdout, onStderr, signal, ...rest } = options;
		if (signal?.aborted) return { exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "" };
		// Not repeated: a clone, a push or a setup run that was lost is the caller's to try again or not.
		return this.link.request("run", { id: this.id, command, options: rest }, { signal, onOutput: (fd, data) => (fd === 1 ? onStdout : onStderr)?.(data) });
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

	/** Null when it could not be run, as the interface has it: the link is gone, or the machine with it. */
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
	 * Nothing, as on hosted Docker. The protocol's hold is named by the id of its `holdForTurn`, which
	 * `ServerChannel.request` does not give back, so it could never be released; the runner counts a
	 * session's processes and outstanding operations as use of its sandbox instead.
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

	/** From the machine's last report, as this server last heard it: none before any report (the launch checks the user's own list, which has it). */
	profiles(): SandboxProfile[] {
		const facts = lastFacts.get(`${this.link.who.uid}/${this.link.who.machineId}`);
		return facts ? machineProfiles(facts.name, facts.report) : [];
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
		const args = { profile: input.profile } as const;
		try {
			return await link.request("create", args);
		} catch (error) {
			if (!(error instanceof ConversationLost)) throw error;
			// The lost `create` may have made one: the machine reports every sandbox with the session it was made for.
			await link.ready();
			const made = (await link.facts()).report?.sandboxes.find((sandbox) => sandbox.sessionId === input.sessionId);
			return made ? made.id : await link.request("create", args);
		}
	}

	async connect(id: string): Promise<TurnSandbox | undefined> {
		const { link } = this;
		const found = await link.again("connect", { id });
		return found ? new RunnerHandle(link, id, found.profile, found.cwd) : undefined;
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

	/** A no-op on a machine that cannot be reached: one that is off has stopped it, and the runner stops one nobody uses by itself. */
	async suspend(id: string): Promise<void> {
		const { link } = this;
		try {
			await link.ready();
		} catch (error) {
			if (error instanceof MachineUnreachable) return;
			throw error;
		}
		await link.again("suspend", { id });
	}

	/** Recorded with the machine's actor first, which has the runner remove it when it is next connected: so a machine that is offline now still loses it. */
	async destroy(id: string): Promise<void> {
		const { link } = this;
		await link.removeSandbox(id);
		try {
			await link.ready();
		} catch (error) {
			if (error instanceof MachineUnreachable) return;
			throw error;
		}
		await link.again("destroy", { id });
	}
}

let windlass: SandboxWindlass | null = null;

/**
 * The layer of a machine. Its sign-ins and access tokens are the deployment's (`hosted`): the platform
 * keeps the one sign-in, and a turn on a machine is handed a token as any turn is. Windlass's version
 * is asked of each sandbox by the turn itself; what keeps a token from being had at all is the hosted
 * layer's to say.
 */
export function machineLayer(link: RunnerLink, hosted: SandboxLayer): SandboxLayer {
	const host = { version: async () => null, problem: () => hosted.windlass.problem(), tokenSourceProblem: () => hosted.windlass.problem() };
	// One for the server: what it learns of a sandbox (its Windlass's features) is kept by the sandbox's id, which carries its machine's.
	windlass ??= new SandboxWindlass(hosted.tokens, host);
	return { sandboxes: new RunnerSandboxes(link), windlass: windlass as Windlass, logins: hosted.logins, tokens: hosted.tokens, backups: null };
}
