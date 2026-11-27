import { useState } from "react";
import { CONNECT_COMMAND } from "../components/ClaudePlan";
import { WarnIcon } from "../components/Icons";
import { ThemeToggle, Wordmark } from "../components/TopBar";
import { linkProps } from "../lib/router";
import type { Theme } from "../lib/theme";
import { useApp, useAuth } from "../state/app";

const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/;

type Outcome = "approved" | "denied";

/**
 * Where `npx @windlassai/cli connect claude` sends its user: the code the terminal shows, to compare and approve.
 * Only after approval does that terminal run `claude setup-token` and hand the token to this account.
 */
export function Connect({ code: raw, theme, onToggleTheme }: { code?: string; theme: Theme; onToggleTheme(): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<Outcome | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [error, setError] = useState<string | null>(null);
	const code = raw?.trim().toUpperCase() ?? "";
	const wellFormed = CODE_SHAPE.test(code);

	async function decide(choice: Outcome) {
		setBusy(choice);
		setError(null);
		try {
			const user = client.user(auth);
			await (choice === "approved" ? user.approvePlanConnect(code) : user.denyPlanConnect(code));
			setOutcome(choice);
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="connect-page">
			<div className="signin-bar">
				<Wordmark />
				<div className="signin-bar-end">
					<ThemeToggle theme={theme} onToggle={onToggleTheme} />
				</div>
			</div>
			<main className="connect-main">
				<section className="signin-card connect-card" aria-labelledby="connect-title">
					<h1 id="connect-title" className="signin-title">
						Connect your Claude plan from a terminal?
					</h1>
					{!wellFormed ? (
						<p className="signin-text">
							This link has no connect code. Run <code>{CONNECT_COMMAND}</code> in a terminal and follow the link it
							opens.
						</p>
					) : outcome === "approved" ? (
						<p className="signin-text" role="status">
							Approved. Go back to your terminal: it runs <code>claude setup-token</code> and finishes there.
						</p>
					) : outcome === "denied" ? (
						<p className="signin-text" role="status">
							Denied. Nothing was connected; the terminal stops.
						</p>
					) : (
						<>
							<p className="signin-text">Make sure this code matches the one in your terminal:</p>
							<p className="connect-code" aria-label="Connect code">
								{code.includes("-") ? code : `${code.slice(0, 4)}-${code.slice(4)}`}
							</p>
							<p className="signin-text">
								Approve only if you just ran the command yourself. Your plan connects to{" "}
								{auth.profile.email ?? "this account"}.
							</p>
							<div className="connect-actions">
								<button
									type="button"
									className="button button-primary"
									disabled={busy !== null}
									onClick={() => void decide("approved")}
								>
									{busy === "approved" ? "Approving…" : "Approve"}
								</button>
								<button
									type="button"
									className="button button-outline"
									disabled={busy !== null}
									onClick={() => void decide("denied")}
								>
									Deny
								</button>
							</div>
						</>
					)}
					{error ? (
						<p className="callout callout-bad" role="alert">
							<WarnIcon />
							<span>{error}</span>
						</p>
					) : null}
					{outcome || !wellFormed ? (
						<a className="link" {...linkProps({ name: "settings", section: "settings-models" })}>
							Go to Settings
						</a>
					) : null}
				</section>
			</main>
		</div>
	);
}
