/** The shell: which screen the address asks for, behind the sign-in where it has to be. */
import { useEffect, useState } from "react";
import { Mark } from "./components/Icons";
import { TopBar } from "./components/TopBar";
import { linkProps, navigate, useRoute } from "./lib/router";
import { useTheme } from "./lib/theme";
import { Home } from "./screens/Home";
import { NewAgent } from "./screens/NewAgent";
import { Session, SessionCrumb } from "./screens/Session";
import { MockAuthorize, SignIn } from "./screens/SignIn";
import { useApp } from "./state/app";
import { useSession } from "./state/hooks";

/** Whether the page is in a background tab. */
function useHidden(): boolean {
	const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
	useEffect(() => {
		const onChange = () => setHidden(document.hidden);
		document.addEventListener("visibilitychange", onChange);
		return () => document.removeEventListener("visibilitychange", onChange);
	}, []);
	return hidden;
}

function SessionRoute({ sessionId, theme, onToggleTheme }: { sessionId: string; theme: ReturnType<typeof useTheme>[0]; onToggleTheme(): void }) {
	const state = useSession(sessionId);
	const hidden = useHidden();
	const waiting = state.summary?.status === "waiting";
	useEffect(() => {
		// A tab in the background says when its agent is waiting on the user.
		const mark = waiting && hidden ? "(?) Needs you · " : "";
		document.title = state.summary ? `${mark}${state.summary.title} · Windlass` : "Windlass";
	}, [state.summary, waiting, hidden]);
	return (
		<div className="app app-fixed">
			<TopBar theme={theme} onToggleTheme={onToggleTheme}>
				<SessionCrumb title={state.summary?.title ?? null} status={state.summary?.status ?? null} />
			</TopBar>
			<Session key={sessionId} sessionId={sessionId} state={state} />
		</div>
	);
}

export function App() {
	const route = useRoute();
	const { auth, client } = useApp();
	const [theme, toggleTheme] = useTheme();

	const needsAuth = route.name === "home" || route.name === "new" || route.name === "session";
	useEffect(() => {
		if (needsAuth && !auth) navigate({ name: "signin" }, { replace: true });
		if (route.name === "signin" && auth) navigate({ name: "home" }, { replace: true });
	}, [needsAuth, auth, route.name]);

	useEffect(() => {
		if (route.name !== "session") document.title = route.name === "signin" ? "Sign in · Windlass" : route.name === "notfound" ? "Not found · Windlass" : "Agents · Windlass";
	}, [route.name]);

	if (route.name === "mock-authorize" && client.kind === "mock") return <MockAuthorize />;

	if (route.name === "notfound" || route.name === "mock-authorize") {
		return (
			<div className="app">
				<TopBar theme={theme} onToggleTheme={toggleTheme} />
				<main className="state state-page">
					<Mark size={56} />
					<p className="eyebrow">404</p>
					<h1 className="display display-small">Nothing at this address</h1>
					<p>The page you asked for does not exist. Agents live under <code>/agents/…</code>.</p>
					<a className="button button-outline" {...linkProps(auth ? { name: "home" } : { name: "signin" })}>
						{auth ? "Back to your agents" : "Go to sign in"}
					</a>
				</main>
			</div>
		);
	}

	if (route.name === "signin" || !auth) {
		// While the redirect above is on its way, the sign-in screen is the right thing to show.
		return auth ? null : <SignIn theme={theme} onToggleTheme={toggleTheme} />;
	}

	if (route.name === "session") return <SessionRoute key={route.id} sessionId={route.id} theme={theme} onToggleTheme={toggleTheme} />;

	return (
		<div className="app">
			<TopBar theme={theme} onToggleTheme={toggleTheme} />
			<Home />
			{route.name === "new" ? <NewAgent /> : null}
		</div>
	);
}
