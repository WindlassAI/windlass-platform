/**
 * Signing Claude Code in on one of the user's machines from the page (`UserActions.startClaudeLogin`
 * and the two calls after it). The machine's runner starts Claude Code's own setup there and reports
 * Anthropic's authorize link, nothing else. The code Anthropic then shows goes back to that setup, which
 * makes the token on the machine; the runner never sends the token to the platform.
 *
 * Where it shows: the Machines page, the start composer's agent picker, and a Claude Code agent's page,
 * each on its line that says Claude Code is not signed in. A machine that is not online cannot start a
 * sign-in, so there the line keeps the command that signs it in on the machine.
 *
 * - The pasted code is checked here before anything is sent (`codeProblem`): trimmed, not empty, not
 *   longer than a code, only the characters a code has, and never a token (`sk-ant-`), which someone may
 *   paste by mistake. A refused paste is cleared from the field.
 * - The runner holds one sign-in per machine for ten minutes. The pending one is kept per client and
 *   machine (`useLogin`), not per line, so a picker that closes while the user is on Anthropic's page,
 *   or another line of the same machine, takes it up again instead of leaving it stranded.
 * - A wrong code makes Claude Code wait before it fails, so Finish can take about twenty seconds. A
 *   failure ends the runner's sign-in, apart from a refusal of the code itself and a rate limit, both
 *   of which come before the runner is asked: those keep the link and let the code be pasted again.
 * - Once signed in, the line says so. The machine's own report follows on the live list of machines.
 */
import type { MachineSummary } from "@contract";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { hasReason, type PlatformClient } from "../api/client";
import { loginCommand } from "../lib/acp";
import { spelledDuration } from "../lib/format";
import { Command } from "../screens/Machines";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { CheckIcon, ExternalIcon } from "./Icons";
import { machineLabel } from "../lib/machines";

/** The longest code the server takes (server/src/runner/protocol.ts, `approvalCode`). */
export const MAX_CODE_CHARS = 2048;

/** Why a pasted code is not sent, in a sentence; null when it can be. */
export function codeProblem(pasted: string): string | null {
	const code = pasted.trim();
	if (code === "") return "Paste the code Anthropic shows after you authorize.";
	if (/sk-ant-/i.test(code)) return "That is a Claude token, not the code. Do not paste the token here or anywhere else: paste the code Anthropic shows after you authorize.";
	if (code.length > MAX_CODE_CHARS) return "That is longer than any code from Anthropic. Paste only the code it shows.";
	if (/[^A-Za-z0-9._~#%+=/-]/.test(code)) return "That is not a code from Anthropic: it has spaces or characters a code does not have. Paste only the code it shows.";
	return null;
}

/** How long a time of day reads: "14:32". */
const timeOfDay = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

type Login = { kind: "pending"; url: string; expiresAt: number; startedAt: number } | { kind: "done"; at: number };

/** How long the line says "signed in" while the machine's report still says it is not. */
const DONE_SHOWN_MS = 60_000;

/** The sign-ins of this tab, per client (a test's mock is a new one) and by user and machine. */
const stores = new WeakMap<PlatformClient, { logins: Map<string, Login>; listeners: Set<() => void> }>();

function storeOf(client: PlatformClient) {
	let store = stores.get(client);
	if (!store) {
		store = { logins: new Map(), listeners: new Set() };
		stores.set(client, store);
	}
	return store;
}

/** The machine's sign-in from the page, as every line of it sees it, and the way to change it. */
function useLogin(machineId: string): [Login | undefined, (login: Login | undefined) => void] {
	const { client } = useApp();
	const auth = useAuth();
	const store = storeOf(client);
	const key = `${auth.profile.uid}/${machineId}`;
	const login = useSyncExternalStore(
		(listener) => {
			store.listeners.add(listener);
			return () => void store.listeners.delete(listener);
		},
		() => store.logins.get(key),
	);
	const set = (next: Login | undefined) => {
		if (next) store.logins.set(key, next);
		else store.logins.delete(key);
		for (const listener of store.listeners) listener();
	};
	return [login, set];
}

/**
 * The line of a machine whose Claude Code is not signed in, with the way to sign it in from here, or
 * the line that says it now is; nothing for a machine that does not offer it or is signed in already.
 * `children` is the line's own sentence.
 */
export function ClaudeSignIn({ machine, children, className }: { machine: MachineSummary; children: ReactNode; className?: string }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const api = useMemo(() => client.user(auth), [client, auth]);
	const harness = machine.harnesses?.find((one) => one.id === "claude");
	const [login, setLogin] = useLogin(machine.machineId);
	const [busy, setBusy] = useState<"start" | "finish" | "cancel" | null>(null);
	const [code, setCode] = useState("");
	/** Why the code was not taken: refused here, or by the server before the runner was asked. The link still works. */
	const [problem, setProblem] = useState<string | null>(null);
	/** Why the sign-in ended: the runner's sentence, or the server's. */
	const [failure, setFailure] = useState<string | null>(null);
	/** Why the last cancel was not taken; shown under the button once the panel is closed. */
	const [note, setNote] = useState<string | null>(null);
	const [command, setCommand] = useState(false);
	/** Whether Anthropic's page was opened from this line: the first step is then marked done. */
	const [opened, setOpened] = useState(false);
	const pending = login?.kind === "pending" ? login : null;
	// The clock matters while a link may expire, and while "signed in" waits for the machine's report.
	const now = useNow(5_000, pending !== null || (login?.kind === "done" && harness?.signIn === "none"));
	const ids = { code: useId(), problem: useId(), command: useId() };
	const link = useRef<HTMLAnchorElement>(null);
	const field = useRef<HTMLInputElement>(null);
	const retry = useRef<HTMLButtonElement>(null);
	const opener = useRef<HTMLButtonElement>(null);

	const expired = pending !== null && now >= pending.expiresAt;
	const open = pending !== null || failure !== null || busy === "start";
	const step = failure !== null || expired ? "ended" : pending ? "code" : "closed";
	const shown = useRef(step);
	// Focus follows the panel: to the link once it is there, to "Start again" when the sign-in ended.
	useEffect(() => {
		if (shown.current === step) return;
		shown.current = step;
		if (step === "code") link.current?.focus();
		else if (step === "ended") retry.current?.focus();
	}, [step]);

	if (!harness) return null;
	const done = login?.kind === "done" && (harness.signIn !== "none" || now - login.at < DONE_SHOWN_MS);
	if (done) {
		return (
			<p className={`claude-signin-done tone-good${className ? ` ${className}` : ""}`} role="status">
				<CheckIcon size={13} />
				Claude Code: signed in
			</p>
		);
	}
	if (harness.signIn !== "none") return null;

	const close = () => {
		setLogin(undefined);
		setOpened(false);
		setCode("");
		setProblem(null);
		setFailure(null);
	};

	const start = async () => {
		setBusy("start");
		close();
		setNote(null);
		try {
			const begun = await api.startClaudeLogin({ machineId: machine.machineId });
			setLogin({ kind: "pending", url: begun.url, expiresAt: begun.expiresAt, startedAt: Date.now() });
		} catch (error) {
			setFailure(explain(error));
		} finally {
			setBusy(null);
		}
	};

	const finish = async () => {
		if (busy !== null || !pending) return;
		const refused = codeProblem(code);
		if (refused) {
			// A token must not sit in the page: the field is emptied.
			if (/sk-ant-/i.test(code)) setCode("");
			setProblem(refused);
			field.current?.focus();
			return;
		}
		setBusy("finish");
		setProblem(null);
		try {
			await api.finishClaudeLogin({ machineId: machine.machineId, code: code.trim() });
			setCode("");
			setLogin({ kind: "done", at: Date.now() });
		} catch (error) {
			const sentence = explain(error);
			// Refused before the runner was asked: its sign-in is still waiting for a code.
			if (hasReason(error, "bad_input") || hasReason(error, "rate_limited")) {
				setProblem(sentence);
				field.current?.focus();
			} else {
				setLogin(undefined);
				setCode("");
				setFailure(sentence);
			}
		} finally {
			setBusy(null);
		}
	};

	const cancel = async () => {
		setBusy("cancel");
		try {
			await api.cancelClaudeLogin({ machineId: machine.machineId });
			setNote(null);
		} catch (error) {
			// The runner ends a sign-in nobody finishes after ten minutes on its own.
			setNote(explain(error));
		} finally {
			close();
			setBusy(null);
			opener.current?.focus();
		}
	};

	const online = machine.status === "online";
	const lasts = pending ? spelledDuration(Math.round((pending.expiresAt - pending.startedAt) / 60_000) * 60_000) : null;

	return (
		<div className={`claude-signin${className ? ` ${className}` : ""}`}>
			<div className="claude-signin-line">
				<span className="tone-warn">{children}</span>
				{online && !open ? (
					<button ref={opener} type="button" className="button button-outline button-small" onClick={() => void start()}>
						Sign in
					</button>
				) : null}
			</div>
			{note && !open ? <p className="field-note tone-bad">{note}</p> : null}

			{!online ? (
				<Command text={loginCommand(harness)} label="The command that signs Claude Code in" />
			) : open ? (
				<div className="claude-signin-panel" role="group" aria-label="Sign Claude Code in">
					{busy === "start" ? (
						<p className="field-note" role="status">
							Asking the runner on “{machineLabel(machine)}” to start Claude Code's sign-in…
						</p>
					) : step === "ended" ? (
						<>
							<p className="claude-signin-failure" role="alert">
								{failure ?? `The sign-in expired: it lasts ${lasts}. Start again for a new link.`}
							</p>
							<div className="claude-signin-actions">
								<button ref={retry} type="button" className="button button-outline button-small" disabled={busy !== null} onClick={() => void start()}>
									Start again
								</button>
								<button type="button" className="button button-quiet button-small" disabled={busy !== null} onClick={() => void cancel()}>
									Cancel
								</button>
							</div>
						</>
					) : pending ? (
						<>
							<ol className="steps claude-signin-steps">
								<li className={`step${opened ? " step-done" : ""}`}>
									<span className="step-number" aria-hidden="true">
										1
									</span>
									<div className="step-body">
										<a ref={link} className="button button-outline button-small" href={pending.url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
											Open Anthropic to authorize
											<ExternalIcon size={13} />
										</a>
										<p className="field-note">
											It opens in a new tab. The sign-in lasts {lasts}, until {timeOfDay(pending.expiresAt)}.
										</p>
									</div>
								</li>
								<li className="step">
									<span className="step-number" aria-hidden="true">
										2
									</span>
									<div className="step-body">
										<label className="label" htmlFor={ids.code}>
											Paste the code Anthropic shows
										</label>
										<div className="claude-signin-code">
											<input
												ref={field}
												id={ids.code}
												className={`input input-mono${problem ? " input-invalid" : ""}`}
												value={code}
												autoComplete="off"
												autoCapitalize="off"
												autoCorrect="off"
												spellCheck={false}
												aria-invalid={problem !== null}
												aria-describedby={problem ? ids.problem : undefined}
												disabled={busy === "finish"}
												onChange={(event) => {
													setCode(event.target.value);
													setProblem(null);
												}}
												onKeyDown={(event) => {
													// The start composer is a form of its own: Enter here finishes the sign-in, not the composer.
													if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
													event.preventDefault();
													void finish();
												}}
											/>
											<button type="button" className="button button-primary button-small" disabled={busy !== null} onClick={() => void finish()}>
												{busy === "finish" ? "Finishing…" : "Finish"}
											</button>
										</div>
										{problem ? (
											<p id={ids.problem} className="field-note tone-bad" role="alert">
												{problem}
											</p>
										) : null}
										{busy === "finish" ? (
											<p className="field-note" role="status">
												This can take up to about 20 seconds: a wrong code makes Claude Code wait before it fails.
											</p>
										) : null}
									</div>
								</li>
							</ol>
							<p className="field-note">Your token is created on your machine and the runner never sends it to the platform.</p>
							<div className="claude-signin-actions">
								<button type="button" className="button button-quiet button-small" disabled={busy !== null} onClick={() => void cancel()}>
									Cancel
								</button>
							</div>
						</>
					) : null}
				</div>
			) : (
				<>
					<button type="button" className="link claude-signin-or" aria-expanded={command} aria-controls={ids.command} onClick={() => setCommand((value) => !value)}>
						or run this on the machine
					</button>
					<div id={ids.command} className="claude-signin-command" hidden={!command}>
						<Command text={loginCommand(harness)} label="The command that signs Claude Code in" />
					</div>
				</>
			)}
		</div>
	);
}
