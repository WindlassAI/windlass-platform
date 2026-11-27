import type { LoginStart } from "@contract";
import { useState } from "react";
import { useApp, useAuth } from "../state/app";
import { PROVIDERS_CHANGED, useChatgpt } from "../state/hooks";

export function ChatgptPlan() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const { status, error: statusError } = useChatgpt();
	const [attempt, setAttempt] = useState<LoginStart | null>(null);
	const [callback, setCallback] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function change(action: "start" | "finish" | "disconnect") {
		setBusy(true);
		setError(null);
		try {
			const user = client.user(auth);
			if (action === "start") {
				setAttempt(await user.startChatgpt());
				setCallback("");
			} else {
				if (action === "finish") await user.finishChatgpt(callback.trim());
				else await user.forgetChatgpt();
				setAttempt(null);
				setCallback("");
				window.dispatchEvent(new Event(PROVIDERS_CHANGED));
			}
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
							? status?.email
								? `Connected as ${status.email}`
								: "Connected"
							: "Use your ChatGPT subscription"}
					</span>
				</p>
				{attempt ? (
					<form
						className="chatgpt-plan-form"
						onSubmit={event => {
							event.preventDefault();
							void change("finish");
						}}
					>
						<a className="link" href={attempt.url} target="_blank" rel="noopener noreferrer">
							Authorize your plan at OpenAI ↗
						</a>
						<label className="field">
							Paste the full address from the page that ends at {attempt.redirectPrefix}.
							<input
								className="input"
								type="url"
								autoComplete="off"
								value={callback}
								onChange={e => setCallback(e.target.value)}
								required
							/>
						</label>
						<div className="chatgpt-plan-actions">
							<button className="button button-primary button-small" disabled={busy || !callback.trim()}>
								Finish connecting
							</button>
							<button
								type="button"
								className="button button-quiet button-small"
								disabled={busy}
								onClick={() => setAttempt(null)}
							>
								Cancel
							</button>
						</div>
					</form>
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
				{attempt ? null : connected ? (
					<>
						<button
							type="button"
							className="button button-outline button-small"
							disabled={busy}
							onClick={() => void change("start")}
						>
							Reconnect
						</button>
						<button
							type="button"
							className="button button-outline button-small"
							disabled={busy}
							onClick={() => void change("disconnect")}
						>
							Disconnect
						</button>
					</>
				) : (
					<button
						type="button"
						className="button button-outline button-small"
						disabled={busy}
						onClick={() => void change("start")}
					>
						Connect
					</button>
				)}
			</div>
		</li>
	);
}

/** The mock's stand-in for OpenAI's page: approving sends the tab to the loopback address, which cannot load. */
export function MockAuthorize() {
	const params = new URLSearchParams(location.search);
	const redirect = "http://127.0.0.1:1455/auth/callback";
	const state = params.get("state") ?? "";
	const approve = `${redirect}?${new URLSearchParams({ code: "mock_code_4f2a91", scope: "openid profile email offline_access", state })}`;
	const deny = `${redirect}?${new URLSearchParams({ error: "access_denied", state })}`;
	return (
		<main className="mock-authorize">
			<div className="signin-card">
				<p className="eyebrow">mock · stands in for OpenAI's sign-in page</p>
				<h1 className="signin-title">Let Windlass use your ChatGPT account?</h1>
				<p className="signin-text">
					Approving sends this tab to <code>{redirect}</code>, which will fail to load. Copy that address and paste it
					into the tab you came from.
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
