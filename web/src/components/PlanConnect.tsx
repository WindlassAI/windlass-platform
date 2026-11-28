import type { ModelPlanStatus, PlanProvider } from "@contract";
import { type ReactNode, useEffect, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { PROVIDERS_CHANGED } from "../state/hooks";

/** The command a terminal runs to connect each plan (the `cli/` package); the connect page names them too. */
export const CONNECT_COMMANDS: Record<PlanProvider, string> = {
	anthropic: "npx @windlassai/cli connect claude",
	openai: "npx @windlassai/cli connect codex",
};
const POLL_MS = 2_000;

/**
 * One plan as `modelPlans` has it, and whether the account may connect plans. `wait` starts watching for the plan to
 * arrive from the command: a new or replaced plan (its `addedAt` changed) ends the wait and lets the pickers know.
 * `refresh` reads the plans again when it changes.
 */
export function usePlanConnect(provider: PlanProvider, refresh?: unknown) {
	const { client } = useApp();
	const auth = useAuth();
	const [allowed, setAllowed] = useState(false);
	const [plan, setPlan] = useState<ModelPlanStatus | null>(null);
	/** Whether the plans were read once: before that `plan` is null whether one is connected or not. */
	const [loaded, setLoaded] = useState(false);
	/** Set by `wait`: the plan's `addedAt` then. */
	const [waiting, setWaiting] = useState<{ since: number | null } | null>(null);

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
						setPlan(found.plans.find(p => p.provider === provider) ?? null);
						setLoaded(true);
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
	}, [client, auth, provider, waiting, refresh]);

	useEffect(() => {
		if (waiting && plan && plan.addedAt !== waiting.since) {
			setWaiting(null);
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		}
	}, [waiting, plan]);

	return {
		allowed,
		loaded,
		plan,
		setPlan,
		waiting: waiting !== null,
		wait: () => setWaiting({ since: plan?.addedAt ?? null }),
		cancel: () => setWaiting(null),
	};
}

/** What the command does, said beside it. */
export const CONNECT_NOTES: Record<PlanProvider, ReactNode> = {
	anthropic: (
		<>
			Run this in a terminal on your computer. It opens a page here to approve, then runs{" "}
			<code>claude setup-token</code>.
		</>
	),
	openai:
		"Run this in a terminal on your computer. It opens a page here to approve, then signs in with ChatGPT in your browser through Windlass on your computer.",
};

/**
 * A plan's connect on its own, outside its row (a Connections cell's dialog, the first-run setup): the command,
 * waiting for the plan from the moment it is shown. `onConnected` is told once a new or replaced plan arrives.
 */
export function PlanWait({ provider, onConnected }: { provider: PlanProvider; onConnected?(): void }) {
	const { loaded, waiting, wait } = usePlanConnect(provider);
	const [started, setStarted] = useState(false);
	useEffect(() => {
		if (!loaded || started) return;
		setStarted(true);
		wait();
	}, [loaded, started, wait]);
	useEffect(() => {
		if (started && !waiting) onConnected?.();
	}, [started, waiting, onConnected]);
	if (started && !waiting) return null;
	return <PlanCommand provider={provider}>{CONNECT_NOTES[provider]}</PlanCommand>;
}

/** The command to run for a plan, with a copy button, while its row waits for the plan. `children` says what it does. */
export function PlanCommand({ provider, children }: { provider: PlanProvider; children: ReactNode }) {
	const [copied, setCopied] = useState(false);
	const command = CONNECT_COMMANDS[provider];
	return (
		<div className="plan-connect">
			<p className="field-note">{children}</p>
			<div className="plan-command">
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
				Waiting for your plan…
			</p>
		</div>
	);
}
