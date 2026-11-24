/**
 * An item page's "Network" block: the requests the sandboxes of its builder and reviewer refused
 * (`ItemView.blockedNetwork`, their turns rolled up), with the top destinations and what can be done
 * about each. Nothing is drawn when none were refused, or for a server that does not say.
 */
import type { BlockedNetwork } from "@contract";
import { relativeTime } from "../lib/format";
import { blockedRequests } from "../lib/timeline";
import { BlockedList, blockedHeadline, type AllowHostContext } from "./BlockedNetwork";

/**
 * `context`: how "Allow for this repository" is sent, through the builder's session; null where it is
 * not offered (a feature over several repositories names no repository for a host).
 */
export function ItemNetwork({ network, context, now }: { network: BlockedNetwork | undefined; context: AllowHostContext | null; now: number }) {
	if (!network || blockedRequests(network) === 0) return null;
	return (
		<section className="usage-section item-network" aria-labelledby="item-network">
			<h2 className="usage-title" id="item-network">
				Network
			</h2>
			<p className="usage-lede">
				Blocked: {blockedHeadline(network)}, across the turns of its builder and reviewer. Their sandboxes' network policy refused them; the work went on without.
			</p>
			<BlockedList hosts={network.hosts} overflow={network.overflow} context={context} when={(at) => relativeTime(at, now)} label="Blocked destinations" />
			{context === null && network.hosts.some((entry) => entry.allow === "repository") ? <p className="usage-note">Allow a host in the network settings of the repository that needs it.</p> : null}
		</section>
	);
}
