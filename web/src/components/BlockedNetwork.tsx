/**
 * The network requests a sandbox's egress policy refused (`BlockedNetwork`), as the session's timeline
 * row for a turn and the item page's roll-up draw them: each destination with its count and when it was
 * last seen, folded after three, and what can be done about it.
 *
 * - "repository": "Allow for this repository" (`allowHost`), the same button a hosted platform line had.
 * - "machine": the paired machine's own settings refused it; its owner adds it with `--egress-domains`.
 * - "deployment": only the deployment's operator can allow it.
 * - "never": a quiet reason (a private address, cloud metadata, the provider's policy).
 */
import type { BlockedHost, GithubId, HostAllowed } from "@contract";
import { useId, useState } from "react";
import { absoluteTime, count, plural } from "../lib/format";
import { linkProps } from "../lib/router";
import { blockedRequests } from "../lib/timeline";
import { FoldList, FoldToggle } from "./Fold";
import { CheckIcon, WarnIcon } from "./Icons";

/** What "Allow for this repository" needs: the call, null when nothing can be sent now, and the repository whose list it adds to. */
export interface AllowHostContext {
	allow: ((host: string) => Promise<HostAllowed>) | null;
	repositoryId: GithubId | null;
}

/** Addresses a cloud's instance metadata answers on: a refusal of one is "cloud metadata", not just a private address. */
const METADATA_HOSTS = new Set([
	"169.254.169.254",
	"fd00:ec2::254",
	"metadata.google.internal",
	"metadata.goog",
	"100.100.100.200",
	"169.254.170.2",
]);

/** "host:port"; the host alone where no port was seen (a hosted lookup), an IPv6 host in brackets. */
export function destinationWords(entry: Pick<BlockedHost, "host" | "port">): string {
	if (entry.host === null) return "malformed destination";
	const host = entry.host.includes(":") && entry.port !== null ? `[${entry.host}]` : entry.host;
	return entry.port === null ? host : `${host}:${entry.port}`;
}

/** Why a destination that cannot be allowed here was refused, in a few quiet words. */
export function refusalWords(entry: BlockedHost): string {
	if (entry.allow === "deployment") return "only the deployment's operator can allow it";
	switch (entry.reason) {
		case "private":
			return entry.host !== null && METADATA_HOSTS.has(entry.host.toLowerCase()) ? "cloud metadata" : "private address";
		case "provider":
			return "provider policy";
		case "malformed":
			return entry.host === null ? "could not be read" : "malformed request";
		default:
			return "not allowed here";
	}
}

/** "machine studio-mac's", "machines a and b's", or "this machine's" when the names are not known. */
function machineWords(names: readonly string[] | undefined): string {
	const known = (names ?? []).filter(name => name.trim() !== "");
	if (known.length === 0) return "this machine's";
	return known.length === 1
		? `machine ${known[0]}'s`
		: `machines ${known.slice(0, -1).join(", ")} and ${known.at(-1)}'s`;
}

/** "14 requests to 5 destinations", and the ones past the 50 kept. */
export function blockedHeadline(network: { hosts: readonly BlockedHost[]; overflow: number }): string {
	const requests = plural(blockedRequests(network), "request");
	if (network.hosts.length === 0) return `${requests}, to destinations past the first 50`;
	return `${requests} to ${plural(network.hosts.length, "destination")}${network.overflow > 0 ? " and others" : ""}`;
}

/**
 * "Allow for this repository": adds the host to the network list of the session's repository and lets
 * its sandbox reach it at once while a turn runs (from the next turn otherwise). Nothing is allowed
 * without the click. `listLink` adds the way to the list itself.
 */
export function AllowHost({
	host,
	context,
	listLink = false,
}: {
	host: string;
	context: AllowHostContext;
	listLink?: boolean;
}) {
	const [state, setState] = useState<
		{ kind: "idle" } | { kind: "busy" } | { kind: "done"; text: string } | { kind: "failed"; text: string }
	>({ kind: "idle" });
	const { allow, repositoryId } = context;
	if (repositoryId === null) return null;
	const go = async () => {
		if (!allow || state.kind === "busy") return;
		setState({ kind: "busy" });
		try {
			const answer = await allow(host);
			setState({
				kind: "done",
				text: answer.applied
					? `${host} is allowed. This sandbox reaches it now.`
					: `${host} is allowed. It applies from the next turn.`,
			});
		} catch (failure) {
			setState({ kind: "failed", text: failure instanceof Error ? failure.message : String(failure) });
		}
	};
	return (
		<span className="system-actions allow-host">
			{state.kind === "done" ? (
				<span className="system-done tone-good" role="status">
					<CheckIcon size={13} /> {state.text}
				</span>
			) : (
				<button
					type="button"
					className="button button-outline button-small"
					onClick={() => void go()}
					disabled={!allow || state.kind === "busy"}
					aria-label={`Allow ${host} for this repository`}
				>
					{state.kind === "busy" ? "Allowing…" : "Allow for this repository"}
				</button>
			)}
			{listLink ? (
				<a
					className="link"
					{...linkProps({ name: "repository", id: repositoryId, view: "settings", section: "network" })}
				>
					Network list
				</a>
			) : null}
			{state.kind === "failed" ? (
				<span className="system-failed tone-bad" role="alert">
					<WarnIcon size={13} /> {state.text}
				</span>
			) : null}
		</span>
	);
}

/** A destination its machine's settings refused, and, folded, how its owner allows it. */
function MachineRefusal({ entry }: { entry: BlockedHost }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	const host = entry.host ?? "";
	const names = (entry.machineNames ?? []).filter(name => name.trim() !== "");
	return (
		<span className="blocked-why">
			<span>Blocked by {machineWords(entry.machineNames)} settings</span>
			<FoldToggle open={open} controls={id} label="How to allow" onToggle={() => setOpen(value => !value)} />
			<span id={id} className="blocked-hint" hidden={!open}>
				Its owner adds <code>{host}</code> to <code>--egress-domains</code> when starting the runner
				{names.length === 1 ? ` on ${names[0]}` : ""}.
			</span>
		</span>
	);
}

/** What can be done about one destination, by `allow`. */
function HostAction({ entry, context }: { entry: BlockedHost; context: AllowHostContext | null }) {
	if (entry.allow === "repository" && entry.host !== null) {
		if (context && context.repositoryId !== null) return <AllowHost host={entry.host} context={context} />;
		return <span className="blocked-why">the repository's network list can allow it</span>;
	}
	if (entry.allow === "machine") return <MachineRefusal entry={entry} />;
	return <span className="blocked-why tone-faint">{refusalWords(entry)}</span>;
}

/** One destination: where, how often, when last, and what can be done. */
function Destination({
	entry,
	context,
	when,
}: {
	entry: BlockedHost;
	context: AllowHostContext | null;
	when(at: number): string;
}) {
	return (
		<div className="blocked-host" data-allow={entry.allow}>
			<span className="blocked-where">
				<code className="blocked-dest" title={destinationWords(entry)}>
					{destinationWords(entry)}
				</code>
				<span className="blocked-facts">
					<span title={`${plural(entry.count, "request")} refused`}>×{count(entry.count)}</span>
					<time
						dateTime={new Date(entry.lastAt).toISOString()}
						title={`first ${absoluteTime(entry.firstAt)}, last ${absoluteTime(entry.lastAt)}`}
					>
						{when(entry.lastAt)}
					</time>
				</span>
			</span>
			<HostAction entry={entry} context={context} />
		</div>
	);
}

/** The destinations, the ones that can be allowed first, each with its count; folded after three. `when` says when one was last seen. */
export function BlockedList({
	hosts,
	overflow,
	context,
	when,
	label,
}: {
	hosts: readonly BlockedHost[];
	overflow: number;
	context: AllowHostContext | null;
	when(at: number): string;
	label: string;
}) {
	const order = { repository: 0, machine: 1, deployment: 2, never: 3 } as const;
	const sorted = [...hosts].sort((a, b) => order[a.allow] - order[b.allow] || b.count - a.count || b.lastAt - a.lastAt);
	return (
		<div className="blocked-list">
			{sorted.length > 0 ? (
				<FoldList
					items={sorted}
					className="blocked-hosts"
					label={label}
					render={entry => <Destination entry={entry} context={context} when={when} />}
				/>
			) : null}
			{overflow > 0 ? (
				<p className="blocked-overflow">
					{plural(overflow, "more request")} to destinations past the first 50 kept are counted, not listed.
				</p>
			) : null}
			{context?.repositoryId != null && hosts.some(entry => entry.allow === "repository") ? (
				<p className="blocked-foot">
					<a
						className="link"
						{...linkProps({ name: "repository", id: context.repositoryId, view: "settings", section: "network" })}
					>
						Network list
					</a>
				</p>
			) : null}
		</div>
	);
}
