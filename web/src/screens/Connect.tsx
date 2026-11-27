import { PLAN_NAMES, type PlanProvider } from "@contract";
import { useState } from "react";
import { WarnIcon } from "../components/Icons";
import { CONNECT_COMMANDS } from "../components/PlanConnect";
import { ThemeToggle, Wordmark } from "../components/TopBar";
import { linkProps } from "../lib/router";
import type { Theme } from "../lib/theme";
import { useApp, useAuth } from "../state/app";

const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/;

type Outcome = "approved" | "denied";

/** What the terminal does once its code is approved, by the plan it connects. */
const NEXT: Record<PlanProvider, React.ReactNode> = {
	anthropic: (
		<>
			it runs <code>claude setup-token</code> and finishes there.
		</>
	),
	openai: <>it signs in with ChatGPT through Windlass in your browser and finishes there.</>,
};

/**
 * Where `npx @windlassai/cli connect claude|codex` sends its user: the code the terminal shows, for the plan it
 * names, to compare and approve. Only after approval does that terminal hand the plan's sign-in to this account.
 */
export function Connect({
	code: raw,
	plan,
	theme,
	onToggleTheme,
}: {
	code?: string;
	plan?: PlanProvider;
	theme: Theme;
	onToggleTheme(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<Outcome | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [error, setError] = useState<string | null>(null);
	const code = raw?.trim().toUpperCase() ?? "";
	const wellFormed = CODE_SHAPE.test(code);

	async function decide(choice: Outcome) {
		if (!plan) return;
		setBusy(choice);
		setError(null);
		try {
			const user = client.user(auth);
			await (choice === "approved" ? user.approvePlanConnect(code, plan) : user.denyPlanConnect(code));
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
						{plan ? `Connect your ${PLAN_NAMES[plan]} from a terminal?` : "Connect a plan from a terminal?"}
					</h1>
					{!wellFormed || !plan ? (
						<p className="signin-text">
							This link has no connect code. Run <code>{CONNECT_COMMANDS.anthropic}</code> or{" "}
							<code>{CONNECT_COMMANDS.openai}</code> in a terminal and follow the link it opens.
						</p>
					) : outcome === "approved" ? (
						<p className="signin-text" role="status">
							Approved. Go back to your terminal: {NEXT[plan]}
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
					{outcome || !wellFormed || !plan ? (
						<a className="link" {...linkProps({ name: "connections", section: plan ? `plan-${plan}` : undefined })}>
							Go to Connections
						</a>
					) : null}
				</section>
			</main>
		</div>
	);
}
