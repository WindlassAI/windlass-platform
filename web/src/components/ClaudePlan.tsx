import type { ModelPlanStatus } from "@contract";
import { useEffect, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { PROVIDERS_CHANGED } from "../state/hooks";

/** The command a terminal runs to connect a Claude plan (the `cli/` package); the connect page names it too. */
export const CONNECT_COMMAND = "npx @windlassai/cli connect claude";
const POLL_MS = 2_000;

/**
 * The Claude plan row: the command that, on the user's own computer, asks them to approve its code here and then
 * hands the token `claude setup-token` prints to the platform. After Connect the row watches for the plan to arrive.
 */
export function ClaudePlan() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [allowed, setAllowed] = useState(false);
	const [plan, setPlan] = useState<ModelPlanStatus | null>(null);
	/** Set by Connect: the plan's `addedAt` then, so a new or replaced plan ends the wait. */
	const [waiting, setWaiting] = useState<{ since: number | null } | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		const read = () =>
			client
				.user(auth)
				.modelPlans()
				.then(
					found => {
						if (!live) return;
						setAllowed(found.allowed);
						setPlan(found.plans.find(p => p.provider === "anthropic") ?? null);
					},
					() => undefined,
				);
		void read();
		if (!waiting) return () => void (live = false);
		const timer = setInterval(read, POLL_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [client, auth, waiting]);

	// The plan arrived (or was replaced) since Connect: stop waiting and let the pickers know.
	useEffect(() => {
		if (waiting && plan && plan.addedAt !== waiting.since) {
			setWaiting(null);
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		}
	}, [waiting, plan]);

	if (!allowed) return null;

	function connect() {
		setError(null);
		setCopied(false);
		setWaiting({ since: plan?.addedAt ?? null });
	}

	async function disconnect() {
		setBusy(true);
		setError(null);
		try {
			await client.user(auth).removeModelPlan("anthropic");
			setPlan(null);
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}

	const connected = plan?.ok === true;
	return (
		<li className="usage-kept-row provider-row claude-plan" data-provider="claude-plan">
			<div className="usage-kept-main">
				<span className="usage-kept-title">Claude plan</span>
				<p className="agent-meta">
					<span>
						{connected ? `Connected as ${plan.account ?? "your Claude account"}` : "Use your Claude Pro or Max plan"}
					</span>
				</p>
				{waiting ? (
					<div className="claude-plan-connect">
						<p className="field-note">
							Run this in a terminal on your computer. It opens a page here to approve, then runs{" "}
							<code>claude setup-token</code>.
						</p>
						<div className="claude-plan-command">
							<code>{CONNECT_COMMAND}</code>
							<button
								type="button"
								className="button button-outline button-small"
								onClick={() => {
									void navigator.clipboard?.writeText(CONNECT_COMMAND).then(() => setCopied(true));
								}}
							>
								{copied ? "Copied" : "Copy"}
							</button>
						</div>
						<p className="field-note" role="status">
							Waiting for your plan…
						</p>
					</div>
				) : null}
				{error && (
					<p className="field-note tone-bad" role="alert">
						{error}
					</p>
				)}
			</div>
			<span className={`machine-used${connected ? " tone-good" : ""}`}>
				{connected ? "connected" : "not connected"}
			</span>
			<div className="provider-actions">
				{waiting ? (
					<button type="button" className="button button-quiet button-small" onClick={() => setWaiting(null)}>
						Cancel
					</button>
				) : connected ? (
					<>
						<button type="button" className="button button-outline button-small" disabled={busy} onClick={connect}>
							Reconnect
						</button>
						<button
							type="button"
							className="button button-outline button-small"
							disabled={busy}
							onClick={() => void disconnect()}
						>
							Disconnect
						</button>
					</>
				) : (
					<button type="button" className="button button-outline button-small" disabled={busy} onClick={connect}>
						Connect
					</button>
				)}
			</div>
		</li>
	);
}
