/**
 * New agent, at `/new`: the start composer (components/StartComposer.tsx) on a page of its own, under
 * one heading. The Agents home has the same composer at its top, and a repository chosen there has one
 * that launches on it (the old `/repositories/<id>/new` addresses lead there).
 */
import { StartComposer } from "../components/StartComposer";
import { linkProps } from "../lib/router";
import { useSessions } from "../state/hooks";

export function NewAgent() {
	const { sessions } = useSessions();
	return (
		<main className="start-page">
			<header className="start-page-head">
				<h1 className="display display-small">New agent</h1>
				<a className="link" {...linkProps({ name: "home" })}>
					Back to your agents
				</a>
			</header>
			<StartComposer sessions={sessions} autoFocus />
		</main>
	);
}
