/**
 * Routing by URL with the History API: sign-in, the Agents home (everything, the agents on no repository, or one
 * repository chosen in it, with its views), the new agent's page, the usage page, the account's settings and machines,
 * a session by its ID, a work item by its ID, the Factory page with its filters, and the public docs. A reload stays on
 * the same screen; `?mock=1` is carried from one address to the next.
 */
import { githubId } from "../../../server/src/github/ids.js";
import type { GithubId, ItemSummary } from "@contract";
import { useSyncExternalStore } from "react";

export type Route =
	/** The Agents home, with everything in it; with `scope: "none"`, the agents on no repository (`/repositories/none`). */
	| { name: "home"; scope?: "none" }
	/**
	 * The new agent's page. With `repository`, GitHub's id for one, it is that repository in the Agents home, with its
	 * composer focused: the address the repository's own page once had for it (`over` is from then, and kept for old links).
	 */
	| { name: "new"; repository?: GithubId; over?: "settings" }
	/**
	 * One repository of the user's GitHub connection, chosen in the Agents home: its overview, or with `view` its agents,
	 * its work items, its open pull requests, or what is kept for it ("settings"). `section` opens the settings at one
	 * of theirs, as the address's fragment.
	 */
	| { name: "repository"; id: GithubId; view?: RepositoryPaneView; section?: RepositorySection }
	/** The user's sandbox time and kept sandboxes. */
	| { name: "usage" }
	/** What the user keeps for their account, whatever the repository: defaults, their own MCP servers, and those servers' secrets. */
	| { name: "settings" }
	/** Free and Pro side by side, with the way to upgrade: where the deployment has billing (`PlatformInfo.billing`). */
	| { name: "plans" }
	/** The user's own machines. With `add`, the dialog that pairs one is open: the address a runner prints with its code. */
	| { name: "machines"; add?: boolean }
	| { name: "signin" }
	| { name: "session"; id: string }
	/** A work item: where it is, what it waits for, what it asks, its verdicts and its cost. */
	| { name: "item"; id: string }
	/** Every work item across repositories, by what its person must do: `repository` and `from` filter it (`?repository=`, `?from=`). */
	| { name: "factory"; repository?: GithubId; from?: ItemSource }
	/** The mock's stand-in for OpenAI's sign-in page. */
	| { name: "mock-authorize" }
	/** The public docs: `slug` names the page ("" for the overview), `section` one of its headings, as the fragment. */
	| { name: "docs"; slug: string; section?: string }
	| { name: "notfound" };

/** How a work item was filed, as the Factory page filters by it. */
export type ItemSource = ItemSummary["source"];
export const ITEM_SOURCES: readonly ItemSource[] = ["web", "api", "github"];

/** The views of a chosen repository beside its overview, each at its own address. */
export const REPOSITORY_VIEWS = ["agents", "items", "pulls", "settings"] as const;
export type RepositoryPaneView = (typeof REPOSITORY_VIEWS)[number];

/** The sections of a repository's settings a link can open at, in the order the page has them. */
export const REPOSITORY_SECTIONS = ["defaults", "screenshots", "setup", "checks", "network", "secrets", "servers", "forget"] as const;
export type RepositorySection = (typeof REPOSITORY_SECTIONS)[number];

/** The section the address's fragment names, on a repository's settings; null when it names none. */
export function sectionOf(hash: string): RepositorySection | null {
	return REPOSITORY_SECTIONS.find((section) => `#${section}` === hash) ?? null;
}

/** The address's query (`location.search`) is read for the Factory page's filters only. */
export function parseRoute(pathname: string, search = ""): Route {
	const path = pathname.replace(/\/+$/, "") || "/";
	if (path === "/") return { name: "home" };
	if (path === "/factory") {
		const query = new URLSearchParams(search);
		const repository = githubId(query.get("repository") ?? "");
		const from = ITEM_SOURCES.find((source) => source === query.get("from"));
		return { name: "factory", ...(repository !== null ? { repository } : {}), ...(from ? { from } : {}) };
	}
	if (path === "/new") return { name: "new" };
	if (path === "/usage") return { name: "usage" };
	if (path === "/settings") return { name: "settings" };
	if (path === "/plans") return { name: "plans" };
	if (path === "/machines") return { name: "machines" };
	if (path === "/machines/add") return { name: "machines", add: true };
	if (path === "/signin") return { name: "signin" };
	if (path === "/mock/authorize") return { name: "mock-authorize" };
	if (path === "/docs") return { name: "docs", slug: "" };
	const docs = /^\/docs\/([^/]+)$/.exec(path);
	if (docs?.[1]) return { name: "docs", slug: docs[1] };
	if (path === "/repositories/none") return { name: "home", scope: "none" };
	const repository = /^\/repositories\/([1-9][0-9]{0,18})(\/new|\/agents|\/items|\/pulls|\/settings|\/settings\/new)?$/.exec(path);
	if (repository?.[1]) {
		const id = githubId(repository[1]);
		if (id === null) return { name: "notfound" };
		if (repository[2] === "/new") return { name: "new", repository: id };
		if (repository[2] === "/settings/new") return { name: "new", repository: id, over: "settings" };
		const view = REPOSITORY_VIEWS.find((one) => `/${one}` === repository[2]);
		return view ? { name: "repository", id, view } : { name: "repository", id };
	}
	const session = /^\/agents\/([^/]+)$/.exec(path);
	if (session?.[1]) return { name: "session", id: decodeURIComponent(session[1]) };
	const item = /^\/items\/([^/]+)$/.exec(path);
	if (item?.[1]) return { name: "item", id: decodeURIComponent(item[1]) };
	return { name: "notfound" };
}

function pathOf(route: Route): string {
	switch (route.name) {
		case "home":
			return route.scope === "none" ? "/repositories/none" : "/";
		case "new":
			return route.repository === undefined ? "/new" : `/repositories/${route.repository}${route.over === "settings" ? "/settings" : ""}/new`;
		case "repository":
			return `/repositories/${route.id}${route.section ? "/settings" : route.view ? `/${route.view}` : ""}`;
		case "usage":
			return "/usage";
		case "settings":
			return "/settings";
		case "plans":
			return "/plans";
		case "machines":
			return route.add ? "/machines/add" : "/machines";
		case "signin":
			return "/signin";
		case "session":
			return `/agents/${encodeURIComponent(route.id)}`;
		case "item":
			return `/items/${encodeURIComponent(route.id)}`;
		case "factory":
			return "/factory";
		case "mock-authorize":
			return "/mock/authorize";
		case "docs":
			return route.slug === "" ? "/docs" : `/docs/${route.slug}`;
		case "notfound":
			return "/404";
	}
}

export function href(route: Route): string {
	const mock = new URLSearchParams(location.search).get("mock");
	const query = new URLSearchParams();
	if (route.name === "factory" && route.repository !== undefined) query.set("repository", String(route.repository));
	if (route.name === "factory" && route.from) query.set("from", route.from);
	if (mock !== null) query.set("mock", mock);
	const fragment = (route.name === "repository" || route.name === "docs") && route.section ? `#${route.section}` : "";
	const search = query.toString();
	return pathOf(route) + (search ? `?${search}` : "") + fragment;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	window.addEventListener("popstate", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("popstate", listener);
	};
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
	const target = href(route);
	if (target === location.pathname + location.search + location.hash) return;
	if (options.replace) history.replaceState(null, "", target);
	else history.pushState(null, "", target);
	for (const listener of listeners) listener();
}

let cachedPath = "";
let cachedRoute: Route = { name: "home" };

export function useRoute(): Route {
	return useSyncExternalStore(subscribe, () => {
		const path = location.pathname + location.search;
		if (path !== cachedPath) {
			cachedPath = path;
			cachedRoute = parseRoute(location.pathname, location.search);
		}
		return cachedRoute;
	});
}

function subscribeHash(listener: () => void): () => void {
	const unsubscribe = subscribe(listener);
	window.addEventListener("hashchange", listener);
	return () => {
		unsubscribe();
		window.removeEventListener("hashchange", listener);
	};
}

/** The address's fragment ("#checks"), as `navigate`, the back button or an edit of the address changes it. */
export function useHash(): string {
	return useSyncExternalStore(subscribeHash, () => location.hash);
}

/** Props for an anchor that navigates without a page load, and still opens in a new tab on a modified click. */
export function linkProps(route: Route): { href: string; onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void } {
	return {
		href: href(route),
		onClick: (event) => {
			if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			event.preventDefault();
			navigate(route);
		},
	};
}
