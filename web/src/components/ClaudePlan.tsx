import type { ModelPlanStatus } from "@contract";
import { useEffect, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { PROVIDERS_CHANGED } from "../state/hooks";

// The connect command's package name is not settled yet; this is the one place the page names it.
const CONNECT_COMMAND = "npx windlass connect";
const POLL_MS = 2_000;

type Pending = { code: string; expiresAt: number; since: number | null };

/**
 * The Claude plan row: a one-time code and the command that runs `claude setup-token` on the user's own
 * computer and hands the token to the platform. The row watches for the plan to arrive.
 */
export function ClaudePlan() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [allowed, setAllowed] = useState(false);
	const [plan, setPlan] = useState<ModelPlanStatus | null>(null);
	const [pending, setPending] = useState<Pending | null>(null);
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
		if (!pending) return () => void (live = false);
		const timer = setInterval(read, POLL_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [client, auth, pending]);

	// The plan arrived (or was replaced) since the code was shown: stop waiting and let the pickers know.
	useEffect(() => {
		if (pending && plan && plan.addedAt !== pending.since) {
			setPending(null);
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		}
	}, [pending, plan]);

	if (!allowed) return null;

	async function start() {
		setBusy(true);
		setError(null);
		try {
			const issued = await client.user(auth).startPlanConnect("anthropic");
			setPending({ ...issued, since: plan?.addedAt ?? null });
			setCopied(false);
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
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

	const command = pending && `${CONNECT_COMMAND} claude --code ${pending.code}`;
	const expired = pending !== null && pending.expiresAt <= Date.now();
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
				{command ? (
					<div className="claude-plan-connect">
						<p className="field-note">Run this in a terminal. It opens claude.ai so you can approve.</p>
						<div className="claude-plan-command">
							<code>{command}</code>
							<button
								type="button"
								className="button button-outline button-small"
								onClick={() => {
									void navigator.clipboard?.writeText(command).then(() => setCopied(true));
								}}
							>
								{copied ? "Copied" : "Copy"}
							</button>
						</div>
						<p className="field-note" role="status">
							{expired ? "This code expired." : "Waiting for you to approve…"}
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
				{pending && !expired ? (
					<button type="button" className="button button-quiet button-small" onClick={() => setPending(null)}>
						Cancel
					</button>
				) : connected ? (
					<>
						<button
							type="button"
							className="button button-outline button-small"
							disabled={busy}
							onClick={() => void start()}
						>
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
					<button
						type="button"
						className="button button-outline button-small"
						disabled={busy}
						onClick={() => void start()}
					>
						{expired ? "New code" : "Connect"}
					</button>
				)}
			</div>
		</li>
	);
}
