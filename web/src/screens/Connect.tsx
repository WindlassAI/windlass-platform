import { MACHINE_CONNECT_COMMAND, type MachineClaim, PLAN_NAMES, type PlanProvider } from "@contract";
import { useEffect, useState } from "react";
import { WarnIcon } from "../components/Icons";
import { CONNECT_COMMANDS } from "../components/PlanConnect";
import { ThemeToggle, Wordmark } from "../components/TopBar";
import { machineLabel } from "../lib/machines";
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
 * With `kind: "machine"`, `connect --machine` sends its user here to approve a machine's pairing code instead.
 */
export function Connect({
	code: raw,
	plan,
	kind,
	theme,
	onToggleTheme,
}: {
	code?: string;
	plan?: PlanProvider;
	kind?: "machine";
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

	if (kind === "machine")
		return <ConnectMachine code={wellFormed ? code : null} theme={theme} onToggleTheme={onToggleTheme} />;

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
		<ConnectPage
			title={plan ? `Connect your ${PLAN_NAMES[plan]} from a terminal?` : "Connect a plan from a terminal?"}
			theme={theme}
			onToggleTheme={onToggleTheme}
		>
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
						{shownCode(code)}
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
			<Failed error={error} />
			{outcome || !wellFormed || !plan ? (
				<a className="link" {...linkProps({ name: "connections", section: plan ? `plan-${plan}` : undefined })}>
					Go to Connections
				</a>
			) : null}
		</ConnectPage>
	);
}

/** The page around a connect card: the bar with the wordmark and theme toggle, and the card with its title. */
function ConnectPage({
	title,
	theme,
	onToggleTheme,
	children,
}: {
	title: string;
	theme: Theme;
	onToggleTheme(): void;
	children: React.ReactNode;
}) {
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
						{title}
					</h1>
					{children}
				</section>
			</main>
		</div>
	);
}

const shownCode = (code: string) => (code.includes("-") ? code : `${code.slice(0, 4)}-${code.slice(4)}`);

function Failed({ error }: { error: string | null }) {
	return error ? (
		<p className="callout callout-bad" role="alert">
			<WarnIcon />
			<span>{error}</span>
		</p>
	) : null;
}

/**
 * Where `npx @windlassai/cli connect --machine` sends its user: the machine's pairing code and machine key, as its
 * terminal shows them, to compare and approve. Approving pairs the machine with this account; denying ends the
 * pairing, and the terminal stops.
 */
function ConnectMachine({
	code,
	theme,
	onToggleTheme,
}: {
	/** The code from the link; null for a link without a well-formed one. */
	code: string | null;
	theme: Theme;
	onToggleTheme(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [claim, setClaim] = useState<MachineClaim | null>(null);
	const [busy, setBusy] = useState<Outcome | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (code === null) return;
		let live = true;
		client
			.user(auth)
			.claimMachine({ code })
			.then(
				found => live && setClaim(found),
				(failure: unknown) => live && setError(explain(failure)),
			);
		return () => {
			live = false;
		};
	}, [client, auth, explain, code]);

	async function decide(choice: Outcome) {
		if (code === null) return;
		setBusy(choice);
		setError(null);
		try {
			const user = client.user(auth);
			if (choice === "approved") await user.confirmMachine({ code, keyConfirmed: true });
			else await user.denyMachine({ code });
			setOutcome(choice);
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	}

	const looking = code !== null && claim === null && error === null;
	return (
		<ConnectPage title="Connect this machine to your account?" theme={theme} onToggleTheme={onToggleTheme}>
			{code === null ? (
				<p className="signin-text">
					This link has no pairing code. To connect a machine, run <code>{MACHINE_CONNECT_COMMAND}</code> in a terminal
					on it; to connect a plan, run <code>{CONNECT_COMMANDS.anthropic}</code> or{" "}
					<code>{CONNECT_COMMANDS.openai}</code>. Then follow the link the terminal opens.
				</p>
			) : outcome === "approved" ? (
				<p className="signin-text" role="status">
					Approved. Go back to your terminal: the runner starts there and the machine appears on Machines.
				</p>
			) : outcome === "denied" ? (
				<p className="signin-text" role="status">
					Denied. Nothing was connected; the terminal stops.
				</p>
			) : looking ? (
				<p className="signin-text" role="status">
					Looking up the machine…
				</p>
			) : claim ? (
				<>
					<p className="signin-text">Make sure this code and machine key match the ones in your terminal:</p>
					<p className="connect-code" aria-label="Pairing code">
						{shownCode(code)}
					</p>
					<dl className="machine-claim">
						<dt>Machine key</dt>
						<dd className="connect-machine-key">
							{claim.keyFingerprint ?? <span className="tone-faint">not known</span>}
						</dd>
						<dt>Name</dt>
						<dd>{machineLabel(claim)}</dd>
						<dt>System</dt>
						<dd>
							{claim.os} · {claim.arch}
						</dd>
					</dl>
					<p className="signin-text">
						{claim.keyPrinted
							? "Approve only if you just ran the command yourself. If the terminal shows another key, or someone gave you this link, deny it."
							: `Runner ${claim.runnerVersion} does not print its machine key, so it cannot be compared. Approve only if you started it yourself in the last few minutes.`}{" "}
						The machine connects to {auth.profile.email ?? "this account"}, and its agents' work is sent to it: your
						repositories' files and saved secrets.
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
							{busy === "denied" ? "Denying…" : "Deny"}
						</button>
					</div>
				</>
			) : null}
			<Failed error={error} />
			{outcome || code === null || (error && claim === null) ? (
				<a className="link" {...linkProps({ name: "machines" })}>
					Go to Machines
				</a>
			) : null}
		</ConnectPage>
	);
}
