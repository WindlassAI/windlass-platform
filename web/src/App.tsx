/** The shell: which screen the address asks for, behind the sign-in where it has to be. */
import { useEffect, useState } from "react";
import { Mark } from "./components/Icons";
import { TopBar } from "./components/TopBar";
import { linkProps, navigate, useRoute } from "./lib/router";
import { useTheme } from "./lib/theme";
import { Home } from "./screens/Home";
import { Item, ItemCrumb, useItem } from "./screens/Item";
import { Machines, MachinesCrumb } from "./screens/Machines";
import { NewAgent } from "./screens/NewAgent";
import { Repository, RepositoryCrumb, useRepository, type RepositoryTab } from "./screens/Repository";
import { Session, SessionCrumb, useSessionMachine } from "./screens/Session";
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
	// Read once for the bar and the session both: the machine an agent on one of the user's machines runs on.
	const machine = useSessionMachine(state.summary?.place);
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
				<SessionCrumb title={state.summary?.title ?? null} status={state.summary?.status ?? null} place={state.summary?.place} machine={machine} item={state.summary?.item} />
			</TopBar>
			<Session key={sessionId} sessionId={sessionId} state={state} machine={machine} />
		</div>
	);
}

/** A repository's page, and the launch form over it when the address asks for one with that repository chosen. */
/** A work item's page, with the way back to its repository. */
function ItemRoute({ itemId, theme, onToggleTheme }: { itemId: string; theme: ReturnType<typeof useTheme>[0]; onToggleTheme(): void }) {
	const { platform } = useApp();
	// Asked once the deployment says it offers work items (without them the page is not found); until then it is loading, or says why it is not.
	const item = useItem(itemId, Boolean(platform.info?.items));
	const page = platform.info === null && platform.error ? { ...item, error: platform.error, reload: platform.reload } : item;
	const title = page.view?.title ?? null;
	const asks = Boolean(page.view?.question);
	useEffect(() => {
		document.title = title ? `${asks ? "(?) Needs you · " : ""}${title} · Windlass` : "Work item · Windlass";
	}, [title, asks]);
	return (
		<div className="app">
			<TopBar theme={theme} onToggleTheme={onToggleTheme}>
				<ItemCrumb view={page.view} />
			</TopBar>
			<Item page={page} />
		</div>
	);
}

/** `view`: the page's work, or its settings; the launch form opens over the one it was opened from. */
function RepositoryRoute({ repositoryId, view, launching, theme, onToggleTheme }: { repositoryId: number; view: RepositoryTab; launching: boolean; theme: ReturnType<typeof useTheme>[0]; onToggleTheme(): void }) {
	const page = useRepository(repositoryId);
	useEffect(() => {
		document.title = `${page.name ?? "Repository"}${view === "settings" ? " · Settings" : ""} · Windlass`;
	}, [page.name, view]);
	return (
		<div className="app">
			<TopBar theme={theme} onToggleTheme={onToggleTheme}>
				<RepositoryCrumb name={page.name} />
			</TopBar>
			<Repository page={page} view={view} />
			{launching ? <NewAgent repositoryId={repositoryId} over={view === "settings" ? "settings" : undefined} /> : null}
		</div>
	);
}

export function App() {
	const route = useRoute();
	const { auth, client, platform } = useApp();
	const [theme, toggleTheme] = useTheme();

	const needsAuth = route.name === "home" || route.name === "new" || route.name === "usage" || route.name === "settings" || route.name === "machines" || route.name === "session" || route.name === "item" || route.name === "repository";
	/** A deployment that does not offer machines has no such page. While its information loads, the page says it is loading. */
	const noMachines = route.name === "machines" && auth !== null && platform.info !== null && !platform.info.machines;
	/** Nor one that does not offer work items an item's page. */
	const noItems = route.name === "item" && auth !== null && platform.info !== null && !platform.info.items;
	/** The repository whose page is shown: its own address, or the launch form's over it. */
	const repositoryId = route.name === "repository" ? route.id : route.name === "new" ? (route.repository ?? null) : null;
	useEffect(() => {
		if (needsAuth && !auth) navigate({ name: "signin" }, { replace: true });
		if (route.name === "signin" && auth) navigate({ name: "home" }, { replace: true });
	}, [needsAuth, auth, route.name]);

	useEffect(() => {
		if ((route.name !== "session" && route.name !== "item" && repositoryId === null) || noItems) document.title = route.name === "signin" ? "Sign in · Windlass" : route.name === "notfound" || noMachines || noItems ? "Not found · Windlass" : route.name === "usage" ? "Usage · Windlass" : route.name === "settings" ? "Settings · Windlass" : route.name === "machines" ? "Machines · Windlass" : "Agents · Windlass";
	}, [route.name, repositoryId, noMachines, noItems]);

	if (route.name === "mock-authorize" && client.kind === "mock") return <MockAuthorize />;

	if (route.name === "notfound" || route.name === "mock-authorize" || noMachines || noItems) {
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

	if (route.name === "item") return <ItemRoute key={route.id} itemId={route.id} theme={theme} onToggleTheme={toggleTheme} />;

	if (repositoryId !== null) return <RepositoryRoute key={repositoryId} repositoryId={repositoryId} view={(route.name === "repository" ? route.view : route.name === "new" ? route.over : undefined) ?? "work"} launching={route.name === "new"} theme={theme} onToggleTheme={toggleTheme} />;

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
