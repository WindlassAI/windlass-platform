/**
 * Whose credential an agent on a machine uses where its own sign-in there and the owner's saved key both serve it
 * (`setCredentialSource`, `credential_sources` in server/src/actors/user-machines.ts). Shown in that agent's
 * Connections cell; only the chosen one is used.
 */
import type { CredentialSource, MachineSummary, ModelProvider } from "@contract";
import { useId, useState } from "react";
import { anyOf } from "../../../server/src/sandbox/harnesses.js";
import type { ReportedHarness } from "../lib/acp";
import { machineLabel } from "../lib/machines";
import { SOURCE_NAMES } from "../lib/models";
import { useApp, useAuth } from "../state/app";

export function CredentialChoice({
	machine,
	harness,
	providers,
	onChanged,
}: {
	machine: MachineSummary;
	harness: ReportedHarness;
	providers: ModelProvider[];
	onChanged(list: MachineSummary[]): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<CredentialSource | null>(null);
	const [error, setError] = useState<string | null>(null);
	const label = useId();
	const saved: CredentialSource = harness.source ?? "machine";
	const shown = busy ?? saved;
	const here =
		machine.os.toLowerCase().startsWith("mac") || machine.os === "Darwin" ? "this Mac" : `“${machineLabel(machine)}”`;
	const keys = anyOf(providers.map(provider => SOURCE_NAMES[provider]));
	const plan =
		harness.id === "claude"
			? "Claude subscription"
			: harness.machineMethod === "chatgpt" ||
					(providers.includes("openai") && harness.machineProviders?.includes("chatgpt"))
				? "ChatGPT plan"
				: `${keys} login${providers.length > 1 ? "s" : ""}`;
	const choices: Array<{ id: CredentialSource; label: string }> = [
		{ id: "machine", label: `Use ${here}'s ${plan}` },
		{ id: "key", label: `Use your ${keys} key${providers.length > 1 ? "s" : ""}` },
	];
	const set = (source: CredentialSource) => {
		if (source === saved || busy) return;
		setBusy(source);
		setError(null);
		client
			.user(auth)
			.setCredentialSource({ machineId: machine.machineId, harness: harness.id, source })
			.then(
				list => {
					onChanged(list);
					setBusy(null);
				},
				(failure: unknown) => {
					setError(explain(failure));
					setBusy(null);
				},
			);
	};
	return (
		<div className="machine-credential">
			<span className="label" id={label}>
				Paid by
			</span>
			<div className="segmented machine-credential-choice" role="radiogroup" aria-labelledby={label}>
				{choices.map(choice => (
					<label
						key={choice.id}
						className={`segment${shown === choice.id ? " segment-chosen" : ""}`}
						data-source={choice.id}
					>
						<input
							className="segment-radio"
							type="radio"
							name={label}
							value={choice.id}
							checked={shown === choice.id}
							disabled={busy !== null}
							onChange={() => set(choice.id)}
						/>
						{choice.label}
					</label>
				))}
			</div>
			<p className="field-note">Only this one is used. If it can't be, the item stops and asks.</p>
			{error && (
				<p className="field-note tone-bad" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
