import { WarnIcon } from "../Icons";

/** Why an action failed, as an alert; nothing while it has not. */
export function Failure({ error }: { error: string | null }) {
	if (!error) return null;
	return (
		<p className="callout callout-bad" role="alert">
			<WarnIcon />
			<span>{error}</span>
		</p>
	);
}
