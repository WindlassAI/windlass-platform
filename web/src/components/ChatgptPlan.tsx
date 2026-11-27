import { useState } from "react";
import { useApp, useAuth } from "../state/app";
import { PROVIDERS_CHANGED, useChatgpt } from "../state/hooks";
import { PlanCommand, usePlanConnect } from "./PlanConnect";

/**
 * The ChatGPT plan row, for any signed-in user: the command that, on the user's own computer, asks them to approve its
 * code here and then signs in with ChatGPT through Windlass, handing the sign-in to the platform. Where plans are on
 * (`allowed`, WLP_PLAN_USERS) the sign-in also pays for hosted Codex.
 */
export function ChatgptPlan() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const { status, error: statusError } = useChatgpt();
	const { allowed, plan, setPlan, waiting, wait, cancel } = usePlanConnect("openai", status);
	const [busy, setBusy] = useState(false);
	const [checking, setChecking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function connect() {
		setError(null);
		wait();
	}

	async function checkAgain() {
		setChecking(true);
		setError(null);
		try {
			setPlan(await client.user(auth).recheckModelPlan("openai"));
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setChecking(false);
		}
	}

	async function disconnect() {
		setBusy(true);
		setError(null);
		try {
			await client.user(auth).forgetChatgpt();
			setPlan(null);
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}

	const connected = Boolean(status?.connected);
	return (
		<li className="usage-kept-row provider-row chatgpt-plan" data-provider="chatgpt">
			<div className="usage-kept-main">
				<span className="usage-kept-title">ChatGPT plan</span>
				<p className="agent-meta">
					<span>
						{connected
							? plan?.account
								? `Connected as ${plan.account}`
								: status?.email
									? `Connected as ${status.email}`
									: "Connected"
							: "Use your ChatGPT subscription"}
					</span>
				</p>
				{connected && allowed && (
					<p className="agent-meta chatgpt-plan-codex">
						<span>
							Also pays for hosted Codex
							{plan?.models?.length ? ` · ${plan.models.length} models` : " · Agent default until its models are read"}
						</span>
						<button
							type="button"
							className="button button-quiet button-small"
							disabled={checking}
							onClick={() => void checkAgain()}
						>
							{checking ? "Checking…" : "Check again"}
						</button>
					</p>
				)}
				{waiting ? (
					<PlanCommand provider="openai">
						Run this in a terminal on your computer. It opens a page here to approve, then signs in with ChatGPT in your
						browser through Windlass on your computer.
					</PlanCommand>
				) : null}
				{(error || statusError) && (
					<p className="field-note tone-bad" role="alert">
						{error || statusError}
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
