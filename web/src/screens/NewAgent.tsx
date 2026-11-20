/**
 * New agent, at `/new` and at a repository's `/new`: the start composer (components/StartComposer.tsx)
 * on a page of its own, under one heading. Opened from a repository's page, that repository is chosen.
 * Home has the same composer at its top.
 */
import type { GithubId } from "@contract";
import { StartComposer } from "../components/StartComposer";
import { linkProps } from "../lib/router";
import { useSessions } from "../state/hooks";

/** `repositoryId`: GitHub's id for the repository it opens with, when it was opened from that repository's page; `over`, the view of that page it was opened from. */
export function NewAgent({ repositoryId, over }: { repositoryId?: GithubId; over?: "settings" }) {
	const { sessions } = useSessions();
	const back = repositoryId === undefined ? ({ name: "home" } as const) : over === "settings" ? ({ name: "repository", id: repositoryId, view: "settings" } as const) : ({ name: "repository", id: repositoryId } as const);
	return (
		<main className="start-page">
			<header className="start-page-head">
				<h1 className="display display-small">New agent</h1>
				<a className="link" {...linkProps(back)}>
					{repositoryId === undefined ? "Back to your agents" : "Back to the repository"}
				</a>
			</header>
			<StartComposer sessions={sessions} repositoryId={repositoryId} autoFocus />
		</main>
	);
}
