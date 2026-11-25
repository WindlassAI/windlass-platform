/** The shell: which screen the address asks for, behind the sign-in where it has to be. */
import { lazy, Suspense, useEffect, useState } from "react";
import { MissingPageLinks } from "./components/MissingPageLinks";
import { Mark } from "./components/Icons";
import { TopBar } from "./components/TopBar";
import { navigate, rememberAppPage, useRoute, type Route } from "./lib/router";
import { useTheme } from "./lib/theme";
import { Factory } from "./screens/Factory";
import { Item, ItemCrumb, useItem } from "./screens/Item";
import { asking, useItems } from "./screens/Items";
import { Machines } from "./screens/Machines";
import { NewAgent } from "./screens/NewAgent";
import { Session, SessionCrumb, useSessionMachine } from "./screens/Session";
import { Settings } from "./screens/Settings";
import { Plans, PlansCrumb } from "./screens/Plans";
import { MockAuthorize } from "./components/ChatgptPlan";
import { LinkCallback, SignIn } from "./screens/SignIn";
import { Usage, UsageCrumb } from "./screens/Usage";
import { Workspace, type Selection } from "./screens/Workspace";
import { LANDING_TITLE } from "./site/content";
import { Landing } from "./site/Landing";
import { useApp } from "./state/app";
import { useSession } from "./state/hooks";

/** The public docs, in their own chunk: the app reaches them when one of its links leads there without a page load. */
const DocsApp = lazy(() => import("./docs/Docs").then((module) => ({ default: module.DocsApp })));

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
	const { platform } = useApp();
	// A work item's agent: its item, for the crumb (its feature, for a subtask) and to say when it waits for an answer.
	const item = useItem(state.summary?.item?.id ?? "", Boolean(state.summary?.item) && Boolean(platform.info?.items)).view;
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
				<SessionCrumb title={state.summary?.title ?? null} status={state.summary?.status ?? null} place={state.summary?.place} machine={machine} item={state.summary?.item} harness={state.summary?.harness} summary={state.summary ?? null} itemView={item} />
			</TopBar>
			<Session key={sessionId} sessionId={sessionId} state={state} machine={machine} item={item} />
		</div>
	);
}

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

/**
 * The Agents home, with "Agents · Factory" in the bar where the deployment offers work items: everything,
 * the agents on no repository, or one repository, chosen in its rail. The user's items are read once for
 * the bar's count and the page both.
 */
function WorkspaceRoute({ selection, theme, onToggleTheme }: { selection: Selection; theme: ReturnType<typeof useTheme>[0]; onToggleTheme(): void }) {
	const { platform } = useApp();
	const offered = Boolean(platform.info?.items);
	const items = useItems(offered);
	const waiting = asking(items.list ?? []).length;
	useEffect(() => {
		// A repository's side names itself in the title.
		if (selection.kind !== "repository") document.title = selection.kind === "none" ? "No repository · Agents · Windlass" : "Agents · Windlass";
	}, [selection.kind]);
	return (
		<div className="app app-workspace">
			<TopBar theme={theme} onToggleTheme={onToggleTheme} current={selection.kind === "repository" && selection.view === "settings" ? "settings" : "home"} asking={offered ? waiting : 0} />
			<Workspace selection={selection} items={items} />
		</div>
	);
}

/** The Factory page, with "Agents · Factory" in the bar: the user's items are read once for the bar's count and the page both. */
function FactoryRoute({ route, theme, onToggleTheme }: { route: Extract<Route, { name: "factory" }>; theme: ReturnType<typeof useTheme>[0]; onToggleTheme(): void }) {
	const { platform } = useApp();
	const offered = Boolean(platform.info?.items);
	const items = useItems(offered);
	const waiting = asking(items.list ?? []).length;
	useEffect(() => {
		document.title = `${waiting > 0 ? `(${waiting}) ` : ""}Factory · Windlass`;
	}, [waiting]);
	return (
		<div className="app">
			<TopBar theme={theme} onToggleTheme={onToggleTheme} current="factory" asking={offered ? waiting : 0} />
			<Factory filters={{ repository: route.repository, from: route.from }} items={items} />
		</div>
	);
}

export function App() {
	const route = useRoute();
	const { auth, client, platform } = useApp();
	const [theme, toggleTheme] = useTheme();

	useEffect(() => {
		if (route.name === "docs") return;
		rememberAppPage();
		window.addEventListener("pagehide", rememberAppPage);
		return () => window.removeEventListener("pagehide", rememberAppPage);
	}, [route]);

	// Home is the landing page for someone who is not signed in, so it is the one list that does not send them to sign in.
	const needsAuth = (route.name === "home" && route.scope === "none") || route.name === "factory" || route.name === "new" || route.name === "usage" || route.name === "settings" || route.name === "plans" || route.name === "machines" || route.name === "session" || route.name === "item" || route.name === "repository";
	/** A deployment that does not offer machines has no such page. While its information loads, the page says it is loading. */
	const noMachines = route.name === "machines" && auth !== null && platform.info !== null && !platform.info.machines;
	/** Nor one that does not offer work items an item's page. */
	const noItems = (route.name === "item" || route.name === "factory") && auth !== null && platform.info !== null && !platform.info.items;
	/** The repository chosen in the Agents home: its own address, or the address that once launched a new agent on it. */
	const repositoryId = route.name === "repository" ? route.id : route.name === "new" ? (route.repository ?? null) : null;
	useEffect(() => {
		if (needsAuth && !auth) navigate({ name: "signin" }, { replace: true });
	}, [needsAuth, auth, route.name]);

	useEffect(() => {
		if (route.name === "docs") return;
		if ((route.name !== "session" && route.name !== "item" && route.name !== "home" && route.name !== "factory" && repositoryId === null) || noItems) document.title = route.name === "signin" ? "Sign in · Windlass" : route.name === "notfound" || noMachines || noItems ? "Not found · Windlass" : route.name === "usage" ? "Usage · Windlass" : route.name === "settings" ? "Settings · Windlass" : route.name === "plans" ? "Plans · Windlass" : route.name === "machines" ? "Machines · Windlass" : route.name === "new" ? "New agent · Windlass" : "Agents · Windlass";
	}, [route.name, repositoryId, noMachines, noItems]);

	useEffect(() => {
		if (route.name === "home" && !auth) document.title = LANDING_TITLE;
	}, [route.name, auth]);

	if (route.name === "mock-authorize" && client.kind === "mock") return <MockAuthorize />;

	// Open to everyone, signed in or not.
	if (route.name === "docs") {
		return (
			<Suspense fallback={null}>
				<DocsApp theme={theme} onToggleTheme={toggleTheme} />
			</Suspense>
		);
	}

	if (route.name === "notfound" || route.name === "mock-authorize" || noMachines || noItems) {
		return (
			<div className="app">
				<TopBar theme={theme} onToggleTheme={toggleTheme} />
				<main className="state state-page">
					<Mark size={56} />
					<p className="eyebrow">404</p>
					<h1 className="display display-small">Nothing at this address</h1>
					<MissingPageLinks section={!auth ? "signin" : platform.info?.items ? "both" : "home"} />
				</main>
			</div>
		);
	}

	if (route.name === "home" && !auth) return <Landing onToggleTheme={toggleTheme} />;

	if (route.name === "signin" || !auth) {
		// While the redirect above is on its way, the sign-in screen is the right thing to show.
		return auth ? <LinkCallback /> : <SignIn theme={theme} onToggleTheme={toggleTheme} />;
	}

	if (route.name === "session") return <SessionRoute key={route.id} sessionId={route.id} theme={theme} onToggleTheme={toggleTheme} />;

	if (route.name === "item") return <ItemRoute key={route.id} itemId={route.id} theme={theme} onToggleTheme={toggleTheme} />;

	if (repositoryId !== null) return <WorkspaceRoute selection={{ kind: "repository", id: repositoryId, view: route.name === "repository" ? route.view : undefined, launching: route.name === "new" }} theme={theme} onToggleTheme={toggleTheme} />;

	if (route.name === "home") return <WorkspaceRoute selection={route.scope === "none" ? { kind: "none" } : { kind: "everything" }} theme={theme} onToggleTheme={toggleTheme} />;

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
				<TopBar theme={theme} onToggleTheme={toggleTheme} current="machines" />
				<Machines adding={route.add === true} />
			</div>
		);
	}

	if (route.name === "settings") {
		return (
			<div className="app">
				<TopBar theme={theme} onToggleTheme={toggleTheme} current="settings" />
				<Settings />
			</div>
		);
	}

	if (route.name === "plans") {
		return (
			<div className="app">
				<TopBar theme={theme} onToggleTheme={toggleTheme}>
					<PlansCrumb />
				</TopBar>
				<Plans />
			</div>
		);
	}

	if (route.name === "factory") return <FactoryRoute route={route} theme={theme} onToggleTheme={toggleTheme} />;

	return (
		<div className="app">
			<TopBar theme={theme} onToggleTheme={toggleTheme} />
			<NewAgent />
		</div>
	);
}
