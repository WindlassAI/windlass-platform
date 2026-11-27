/**
 * The side panel's last section: what is saved for the agent's repository rather than for this agent, its
 * setup command, its secrets and the MCP servers it names (with the user's own), in one place with the way to
 * the repository's settings ("Edit"). The editing itself sits behind one fold.
 *
 * Above the fold stands only what needs the user now, each with its fix: an MCP server that could not start
 * (amber, the panel's one amber line: "wiki can't connect: WIKI_TOKEN isn't set · Add secret"), and a server
 * that waits for an approval (plain ink, "Approve…").
 *
 * A session with no repository of the GitHub connection has no setup command or secrets of its own: the
 * section is then its MCP servers alone, and is there only when it has some.
 */
import type { EgressMode, PendingQuestion, SessionServer, SessionServers, SessionSummary } from "@contract";
import { useCallback, useId, useRef, useState } from "react";
import { linkProps } from "../lib/router";
import { ChevronIcon } from "./Icons";
import { AddSecretDialog, SecretsSection } from "./Secrets";
import { ServersSection } from "./Servers";
import { SetupSection } from "./SetupCommand";

/** The variable a server could not start without, from the reason Windlass gave; null for any other reason. */
export function missingVariable(reason: string | null): string | null {
	return reason ? (/environment variable ([A-Za-z_][A-Za-z0-9_]*)/.exec(reason)?.[1] ?? null) : null;
}

/** "wiki can't connect": the server and what went wrong, in a few words. */
export const failedWords = (server: Pick<SessionServer, "name" | "remote">) =>
	`${server.name} can't ${server.remote ? "connect" : "start"}`;

export function RepositorySetupSection({
	sessionId,
	summary,
	question,
	egress,
	hosted,
	domains,
}: {
	sessionId: string;
	summary: SessionSummary;
	question: PendingQuestion | null;
	egress?: EgressMode;
	hosted?: boolean;
	domains?: number;
}) {
	const title = useId();
	const fold = useRef<HTMLDetailsElement>(null);
	const [servers, setServers] = useState<SessionServers | null>(null);
	const [adding, setAdding] = useState<{ name: string; account: boolean } | null>(null);
	const heard = useCallback((state: SessionServers | null) => setServers(state), []);
	const repository = summary.repository ?? null;
	const hasServers = (summary.servers?.count ?? 0) > 0;
	if (!repository && !hasServers) return null;

	const failed = (servers?.servers ?? []).filter(server => server.state === "failed");
	const waiting = (servers?.servers ?? []).filter(server => server.asks && question?.server?.name !== server.name);
	const name = repository ? `${repository.owner}/${repository.name}` : null;
	/** Opens the fold and brings the server's row into view. */
	const show = (server: string) => {
		const details = fold.current;
		if (!details) return;
		details.open = true;
		const row = [...details.querySelectorAll<HTMLElement>(".server")].find(
			one => one.querySelector(".server-name")?.textContent === server,
		);
		(row ?? details).scrollIntoView({
			block: "nearest",
			behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
		});
		row?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
	};

	return (
		<section className="panel-section repo-setup" aria-labelledby={title}>
			<h2 className="panel-title" id={title}>
				{repository ? "Repository setup" : "MCP servers"}
				{repository ? (
					<a
						className="link panel-title-link"
						{...linkProps({ name: "repository", id: repository.id, view: "settings" })}
						aria-label={`Edit the setup of ${name}`}
					>
						Edit
					</a>
				) : null}
			</h2>
			{failed.map(server => {
				const variable = missingVariable(server.reason);
				return (
					<p key={server.name} className="repo-setup-problem" role="status">
						<span className="repo-setup-problem-text">
							{failedWords(server)}
							{variable ? (
								<>
									: <code>{variable}</code> isn't set
								</>
							) : null}
						</span>
						{variable && (repository || server.origin === "user") ? (
							<button
								type="button"
								className="link repo-setup-fix"
								onClick={() => setAdding({ name: variable, account: server.origin === "user" })}
							>
								Add secret
							</button>
						) : (
							<button type="button" className="link repo-setup-fix" onClick={() => show(server.name)}>
								See why
							</button>
						)}
					</p>
				);
			})}
			{waiting.map(server => (
				<p key={server.name} className="repo-setup-ask">
					<span>{server.name} waits for your approval</span>
					<button type="button" className="link" onClick={() => show(server.name)}>
						Review
					</button>
				</p>
			))}
			<details className="panel-more repo-setup-fold" ref={fold}>
				<summary>
					<ChevronIcon size={12} className="panel-more-chevron" />
					{repository ? `Setup, secrets and tools for ${name}` : "Servers and approvals"}
				</summary>
				<div className="repo-setup-body">
					<SetupSection summary={summary} egress={egress} hosted={hosted} domains={domains} />
					{summary.capabilities.envLists ? <SecretsSection summary={summary} /> : null}
					<ServersSection sessionId={sessionId} summary={summary} question={question} onServers={heard} />
				</div>
			</details>
			{adding ? (
				<AddSecretDialog
					repository={adding.account || !repository ? null : { id: repository.id, name: name ?? "" }}
					profile={summary.profile}
					name={adding.name}
					onClose={() => setAdding(null)}
				/>
			) : null}
		</section>
	);
}
