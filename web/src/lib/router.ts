/**
 * Routing by URL with the History API: sign-in, home, the new-agent dialog over home, the usage page, the account's settings and machines,
 * a session by its ID, and a repository's page by GitHub's id for it, with the new-agent dialog over
 * that page too. A reload stays on the same screen; `?mock=1` is carried from one address to the next.
 */
import { useSyncExternalStore } from "react";

export type Route =
	| { name: "home" }
	/** The launch form. With `repository`, GitHub's id for one, it opens over that repository's page with it chosen. */
	| { name: "new"; repository?: number }
	/** What is kept for one repository of the user's GitHub connection, and the agents on it. */
	| { name: "repository"; id: number }
	/** The user's sandbox time and kept sandboxes. */
	| { name: "usage" }
	/** What the user keeps for their account, whatever the repository: defaults, their own MCP servers, and those servers' secrets. */
	| { name: "settings" }
	/** The user's own machines. With `add`, the dialog that pairs one is open: the address a runner prints with its code. */
	| { name: "machines"; add?: boolean }
	| { name: "signin" }
	| { name: "session"; id: string }
	/** The mock's stand-in for OpenAI's sign-in page. */
	| { name: "mock-authorize" }
	| { name: "notfound" };

export function parseRoute(pathname: string): Route {
	const path = pathname.replace(/\/+$/, "") || "/";
	if (path === "/") return { name: "home" };
	if (path === "/new") return { name: "new" };
	if (path === "/usage") return { name: "usage" };
	if (path === "/settings") return { name: "settings" };
	if (path === "/machines") return { name: "machines" };
	if (path === "/machines/add") return { name: "machines", add: true };
	if (path === "/signin") return { name: "signin" };
	if (path === "/mock/authorize") return { name: "mock-authorize" };
	const repository = /^\/repositories\/([1-9][0-9]{0,15})(\/new)?$/.exec(path);
	if (repository?.[1]) return repository[2] ? { name: "new", repository: Number(repository[1]) } : { name: "repository", id: Number(repository[1]) };
	const session = /^\/agents\/([^/]+)$/.exec(path);
	if (session?.[1]) return { name: "session", id: decodeURIComponent(session[1]) };
	return { name: "notfound" };
}

function pathOf(route: Route): string {
	switch (route.name) {
		case "home":
			return "/";
		case "new":
			return route.repository === undefined ? "/new" : `/repositories/${route.repository}/new`;
		case "repository":
			return `/repositories/${route.id}`;
		case "usage":
			return "/usage";
		case "settings":
			return "/settings";
		case "machines":
			return route.add ? "/machines/add" : "/machines";
		case "signin":
			return "/signin";
		case "session":
			return `/agents/${encodeURIComponent(route.id)}`;
		case "mock-authorize":
			return "/mock/authorize";
		case "notfound":
			return "/404";
	}
}

export function href(route: Route): string {
	const mock = new URLSearchParams(location.search).get("mock");
	return pathOf(route) + (mock !== null ? `?mock=${encodeURIComponent(mock)}` : "");
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
	if (target === location.pathname + location.search) return;
	if (options.replace) history.replaceState(null, "", target);
	else history.pushState(null, "", target);
	for (const listener of listeners) listener();
}

let cachedPath = "";
let cachedRoute: Route = { name: "home" };

export function useRoute(): Route {
	return useSyncExternalStore(subscribe, () => {
		if (location.pathname !== cachedPath) {
			cachedPath = location.pathname;
			cachedRoute = parseRoute(cachedPath);
		}
		return cachedRoute;
	});
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
