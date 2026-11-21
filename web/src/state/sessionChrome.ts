/**
 * What the session's top bar and its page share, though React draws them apart (the bar is the
 * app's, the page the route's): "Publish pull request" pressed in the bar, which the panel's pull
 * request section answers, and whether the side panel is shown, which the bar toggles and is kept
 * for the browser.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

const publishListeners = new Set<(sessionId: string) => void>();

/** The bar asks the session's panel to publish: it opens its dialog, or shows why it cannot. */
export function requestPublish(sessionId: string): void {
	for (const listener of publishListeners) listener(sessionId);
}

/** Called with each request for `sessionId`, for as long as the caller is mounted. */
export function usePublishRequests(sessionId: string, onRequest: () => void): void {
	const latest = useRef(onRequest);
	latest.current = onRequest;
	useEffect(() => {
		const listener = (id: string) => {
			if (id === sessionId) latest.current();
		};
		publishListeners.add(listener);
		return () => {
			publishListeners.delete(listener);
		};
	}, [sessionId]);
}

const PANEL_KEY = "wlp.session.panel";
const panelListeners = new Set<() => void>();

function readPanelHidden(): boolean {
	try {
		return localStorage.getItem(PANEL_KEY) === "hidden";
	} catch {
		return false;
	}
}

let panelHidden = readPanelHidden();

export function setPanelHidden(hidden: boolean): void {
	panelHidden = hidden;
	try {
		if (hidden) localStorage.setItem(PANEL_KEY, "hidden");
		else localStorage.removeItem(PANEL_KEY);
	} catch {
		// Storage is unavailable: the choice lasts while the page is open.
	}
	for (const listener of panelListeners) listener();
}

/** Whether the user hid the side panel (on a wide screen; a narrow one shows it under the conversation). */
export function usePanelHidden(): boolean {
	return useSyncExternalStore(
		(listener) => {
			panelListeners.add(listener);
			return () => panelListeners.delete(listener);
		},
		() => panelHidden,
		() => false,
	);
}
