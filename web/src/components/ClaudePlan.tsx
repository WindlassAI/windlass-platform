import { useState } from "react";
import { useApp, useAuth } from "../state/app";
import { PROVIDERS_CHANGED } from "../state/hooks";
import { CONNECT_NOTES, PlanCommand, usePlanConnect } from "./PlanConnect";

/**
 * The Claude plan row: the command that, on the user's own computer, asks them to approve its code here and then
 * hands the token `claude setup-token` prints to the platform. After Connect the row watches for the plan to arrive.
 */
export function ClaudePlan() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const { allowed, plan, setPlan, waiting, wait, cancel } = usePlanConnect("anthropic");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!allowed) return null;

	function connect() {
		setError(null);
		wait();
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
		<li className="usage-kept-row provider-row claude-plan" id="plan-anthropic" data-provider="claude-plan">
			<div className="usage-kept-main">
				<span className="usage-kept-title">Claude plan</span>
				<p className="agent-meta">
					<span>
						{connected ? `Connected as ${plan.account ?? "your Claude account"}` : "Use your Claude Pro or Max plan"}
					</span>
				</p>
				{waiting ? <PlanCommand provider="anthropic">{CONNECT_NOTES.anthropic}</PlanCommand> : null}
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
					<button type="button" className="button button-quiet button-small" onClick={cancel}>
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
