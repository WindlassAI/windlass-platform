/**
 * Sign in. One primary action, "Continue with ChatGPT", which starts Windlass's own sign-in: the
 * user approves on OpenAI's page in another tab, lands on a loopback address that cannot load, and
 * pastes that address back here. A demo sign-in is offered when the deployment has one.
 */
import type { LoginStart } from "@contract";
import { useId, useState, type FormEvent } from "react";
import { ExternalIcon, InfoIcon, Mark, WarnIcon } from "../components/Icons";
import { ThemeToggle, Wordmark } from "../components/TopBar";
import { countdown } from "../lib/format";
import { navigate } from "../lib/router";
import type { Theme } from "../lib/theme";
import { useApp } from "../state/app";
import { useNow } from "../state/hooks";

type Busy = "start" | "finish" | "demo" | null;

export function SignIn({ theme, onToggleTheme }: { theme: Theme; onToggleTheme(): void }) {
	const { client, signIn, signedOutReason, platform, explain } = useApp();
	const [attempt, setAttempt] = useState<LoginStart | null>(null);
	const [opened, setOpened] = useState(false);
	const [pasted, setPasted] = useState("");
	const [busy, setBusy] = useState<Busy>(null);
	const [error, setError] = useState<string | null>(null);
	const fieldId = useId();
	const hintId = useId();
	const now = useNow(1000, attempt !== null);

	const remaining = attempt ? attempt.expiresAt - now : 0;
	const expired = attempt !== null && remaining <= 0;
	const trimmed = pasted.trim();
	const matches = attempt !== null && trimmed.startsWith(attempt.redirectPrefix);
	const mismatch = attempt !== null && trimmed !== "" && !matches;

	const start = async () => {
		setBusy("start");
		setError(null);
		try {
			const started = await client.login.start();
			setAttempt(started);
			setOpened(false);
			setPasted("");
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	};

	const finish = async (event: FormEvent) => {
		event.preventDefault();
		if (!matches || expired || busy) return;
		setBusy("finish");
		setError(null);
		try {
			signIn(await client.login.finish(trimmed));
			navigate({ name: "home" }, { replace: true });
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	};

	const demo = async () => {
		setBusy("demo");
		setError(null);
		try {
			signIn(await client.login.demo());
			navigate({ name: "home" }, { replace: true });
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="signin">
			<div className="signin-bar">
				<Wordmark />
				<ThemeToggle theme={theme} onToggle={onToggleTheme} />
			</div>

			<main className="signin-main">
				<section className="signin-pitch" aria-labelledby="pitch">
					<Mark size={132} className="signin-mark" />
					<h1 id="pitch" className="display">
						Put an agent to work, and watch every turn.
					</h1>
					<p className="signin-lede">Windlass is a coding agent for the terminal. Here it runs in a sandbox you choose, and you see each file it reads, each command it runs and what the work cost.</p>
					<ul className="signin-points">
						<li>
							<span className="signin-point-key">sandbox</span>
							You pick what isolates each agent, and see the layers before it starts.
						</li>
						<li>
							<span className="signin-point-key">trace</span>
							Tool calls, checks, refusals and token counts, live.
						</li>
						<li>
							<span className="signin-point-key">changes</span>
							The diff of the workspace after every turn.
						</li>
					</ul>
				</section>

				<section className="signin-card" aria-label="Sign in">
					{signedOutReason ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{signedOutReason}</span>
						</p>
					) : null}

					{attempt === null ? (
						<>
							<h2 className="signin-title">Sign in</h2>
							<p className="signin-text">Agents call the model through your ChatGPT account.</p>
							<button type="button" className="button button-primary button-large signin-primary" onClick={start} disabled={busy !== null}>
								{busy === "start" ? "Preparing the sign-in…" : "Continue with ChatGPT"}
							</button>
							{platform.loading ? (
								<p className="signin-aside signin-aside-quiet">Asking the server what it offers…</p>
							) : platform.error ? (
								<p className="callout callout-bad" role="alert">
									<WarnIcon />
									<span>
										The server did not answer: {platform.error}{" "}
										<button type="button" className="link" onClick={platform.reload}>
											Try again
										</button>
									</span>
								</p>
							) : platform.info?.demoEnabled ? (
								<div className="signin-demo">
									<span className="signin-or" aria-hidden="true">
										or
									</span>
									<button type="button" className="button button-outline" onClick={demo} disabled={busy !== null}>
										{busy === "demo" ? "Starting the demo…" : "Try the demo"}
									</button>
									<p className="signin-aside">The demo runs a scripted model with real tool calls and needs no account.</p>
								</div>
							) : null}
							{error ? (
								<p className="callout callout-bad" role="alert">
									<WarnIcon />
									<span>{error}</span>
								</p>
							) : null}
						</>
					) : (
						<>
							<div className="signin-steps-head">
								<h2 className="signin-title">Two steps</h2>
								<span className={`signin-clock${expired ? " tone-bad" : remaining < 60_000 ? " tone-warn" : ""}`} role="timer" aria-label="Time left for this sign-in attempt">
									{expired ? "expired" : countdown(remaining)}
								</span>
							</div>
							<ol className="steps">
								<li className={`step${opened ? " step-done" : ""}`}>
									<span className="step-number" aria-hidden="true">
										1
									</span>
									<div className="step-body">
										<h3 className="step-title">Open the sign-in page</h3>
										<p className="step-text">It opens in a new tab. Approve the sign-in there.</p>
										<a className="button button-primary" href={attempt.url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)} aria-disabled={expired}>
											Open the sign-in page
											<ExternalIcon size={14} />
										</a>
									</div>
								</li>
								<li className="step">
									<span className="step-number" aria-hidden="true">
										2
									</span>
									<form className="step-body" onSubmit={finish} noValidate>
										<h3 className="step-title">Paste the address you land on</h3>
										<p className="step-text" id={hintId}>
											After you approve, the browser goes to a page at <code>{attempt.redirectPrefix}</code> that fails to load. That is expected. Copy that page's full address from the address bar and paste it here.
										</p>
										<label className="label" htmlFor={fieldId}>
											Address of the page that did not load
										</label>
										<input
											id={fieldId}
											className={`input input-mono${mismatch ? " input-invalid" : ""}`}
											type="url"
											inputMode="url"
											autoComplete="off"
											spellCheck={false}
											placeholder={`${attempt.redirectPrefix}?code=…`}
											value={pasted}
											onChange={(event) => setPasted(event.target.value)}
											aria-describedby={hintId}
											aria-invalid={mismatch}
											disabled={expired || busy === "finish"}
										/>
										{mismatch ? (
											<p className="field-note tone-warn" role="status">
												The address should start with <code>{attempt.redirectPrefix}</code>.
											</p>
										) : null}
										<button type="submit" className="button button-primary" disabled={!matches || expired || busy !== null}>
											{busy === "finish" ? "Finishing…" : "Finish signing in"}
										</button>
									</form>
								</li>
							</ol>
							{expired ? (
								<p className="callout callout-warn" role="status">
									<WarnIcon />
									<span>This attempt has run out of time.</span>
								</p>
							) : null}
							{error ? (
								<p className="callout callout-bad" role="alert">
									<WarnIcon />
									<span>{error}</span>
								</p>
							) : null}
							<button type="button" className="link signin-restart" onClick={start} disabled={busy !== null}>
								{busy === "start" ? "Starting again…" : "Start over"}
							</button>
						</>
					)}

					{client.kind === "mock" ? (
						<p className="signin-foot">
							<InfoIcon size={14} />
							Mock backend: the sign-in page is a stand-in and nothing leaves this browser.
						</p>
					) : null}
				</section>
			</main>
		</div>
	);
}

/** The mock's stand-in for OpenAI's page: approving sends the tab to the loopback address, which cannot load. */
export function MockAuthorize() {
	const params = new URLSearchParams(location.search);
	const redirect = params.get("redirect_uri") ?? "http://127.0.0.1:1455/auth/callback";
	const state = params.get("state") ?? "";
	const approve = `${redirect}?${new URLSearchParams({ code: "mock_code_4f2a91", scope: "openid profile email offline_access", state })}`;
	const deny = `${redirect}?${new URLSearchParams({ error: "access_denied", state })}`;
	return (
		<main className="mock-authorize">
			<div className="signin-card">
				<p className="eyebrow">mock · stands in for OpenAI's sign-in page</p>
				<h1 className="signin-title">Let Windlass use your ChatGPT account?</h1>
				<p className="signin-text">
					Approving sends this tab to <code>{redirect}</code>, which will fail to load. Copy that address and paste it into the tab you came from.
				</p>
				<div className="mock-authorize-actions">
					<a className="button button-primary" href={approve}>
						Approve
					</a>
					<a className="button button-outline" href={deny}>
						Deny
					</a>
				</div>
			</div>
		</main>
	);
}
