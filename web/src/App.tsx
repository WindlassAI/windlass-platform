/** The shell: which screen the address asks for, behind the sign-in where it has to be. */
import { useEffect, useState } from "react";
import { Mark } from "./components/Icons";
import { TopBar } from "./components/TopBar";
import { linkProps, navigate, useRoute } from "./lib/router";
import { useTheme } from "./lib/theme";
import { Home } from "./screens/Home";
import { Machines, MachinesCrumb } from "./screens/Machines";
import { NewAgent } from "./screens/NewAgent";
import { Repository, RepositoryCrumb, useRepository } from "./screens/Repository";
import { Session, SessionCrumb } from "./screens/Session";
import { Settings, SettingsCrumb } from "./screens/Settings";
import { MockAuthorize, SignIn } from "./screens/SignIn";
import { Usage, UsageCrumb } from "./screens/Usage";
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

/** A repository's page, and the launch form over it when the address asks for one with that repository chosen. */
function RepositoryRoute({ repositoryId, launching, theme, onToggleTheme }: { repositoryId: number; launching: boolean; theme: ReturnType<typeof useTheme>[0]; onToggleTheme(): void }) {
	const page = useRepository(repositoryId);
	useEffect(() => {
		document.title = `${page.name ?? "Repository"} · Windlass`;
	}, [page.name]);
	return (
		<div className="app">
			<TopBar theme={theme} onToggleTheme={onToggleTheme}>
				<RepositoryCrumb name={page.name} />
			</TopBar>
			<Repository page={page} />
			{launching ? <NewAgent repositoryId={repositoryId} /> : null}
		</div>
	);
}

export function App() {
	const route = useRoute();
	const { auth, client, platform } = useApp();
	const [theme, toggleTheme] = useTheme();

	const needsAuth = route.name === "home" || route.name === "new" || route.name === "usage" || route.name === "settings" || route.name === "machines" || route.name === "session" || route.name === "repository";
	/** A deployment that does not offer machines has no such page. While its information loads, the page says it is loading. */
	const noMachines = route.name === "machines" && auth !== null && platform.info !== null && !platform.info.machines;
	/** The repository whose page is shown: its own address, or the launch form's over it. */
	const repositoryId = route.name === "repository" ? route.id : route.name === "new" ? (route.repository ?? null) : null;
	useEffect(() => {
		if (needsAuth && !auth) navigate({ name: "signin" }, { replace: true });
		if (route.name === "signin" && auth) navigate({ name: "home" }, { replace: true });
	}, [needsAuth, auth, route.name]);

	useEffect(() => {
		if (route.name !== "session" && repositoryId === null) document.title = route.name === "signin" ? "Sign in · Windlass" : route.name === "notfound" || noMachines ? "Not found · Windlass" : route.name === "usage" ? "Usage · Windlass" : route.name === "settings" ? "Settings · Windlass" : route.name === "machines" ? "Machines · Windlass" : "Agents · Windlass";
	}, [route.name, repositoryId, noMachines]);

	if (route.name === "mock-authorize" && client.kind === "mock") return <MockAuthorize />;

	if (route.name === "notfound" || route.name === "mock-authorize" || noMachines) {
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

	if (repositoryId !== null) return <RepositoryRoute key={repositoryId} repositoryId={repositoryId} launching={route.name === "new"} theme={theme} onToggleTheme={toggleTheme} />;

	if (route.name === "usage") {
		return (
			<div className="app">
				<TopBar theme={theme} onToggleTheme={toggleTheme}>
					<UsageCrumb />
				</TopBar>
				<Usage />
			</div>
		);
	}

	if (route.name === "machines") {
		return (
			<div className="app">
				<TopBar theme={theme} onToggleTheme={toggleTheme}>
					<MachinesCrumb />
				</TopBar>
				<Machines adding={route.add === true} />
			</div>
		);
	}

	if (route.name === "settings") {
		return (
			<div className="app">
				<TopBar theme={theme} onToggleTheme={toggleTheme}>
					<SettingsCrumb />
				</TopBar>
				<Settings />
			</div>
		);
	}

	return (
		<div className="app">
			<TopBar theme={theme} onToggleTheme={toggleTheme} />
			<Home />
			{route.name === "new" ? <NewAgent /> : null}
		</div>
	);
}
