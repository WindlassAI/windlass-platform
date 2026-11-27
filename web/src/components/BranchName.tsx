import { branchLabel } from "../lib/branch";
import { CopyButton } from "./Copy";

/** A branch in words a person reads (lib/branch.ts), with its exact name on hover and a copy control. */
export function BranchName({ branch }: { branch: string }) {
	const label = branchLabel(branch);
	return (
		<span className="branch-name">
			<span className="branch-name-text" title={branch}>
				{label}
			</span>
			<CopyButton text={branch} label={`Copy the branch name, ${branch}`} />
		</span>
	);
}
