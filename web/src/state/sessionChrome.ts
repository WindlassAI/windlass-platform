/**
 * What the session's top bar and its page share, though React draws them apart (the bar is the
 * app's, the page the route's): "Publish pull request" pressed in the bar, which the panel's pull
 * request section answers, and whether the side panel is shown, which the bar toggles and is kept
 * for the browser.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";

/** What the bar asks of the panel: "publish" opens the dialog where it can; "show" brings the pull request section into view. */
export type PublishRequest = "publish" | "show";

const publishListeners = new Set<(sessionId: string, request: PublishRequest) => void>();

/** The bar asks the session's panel to publish: it opens its dialog, or says why it cannot (`usePublishFeedback`). */
export function requestPublish(sessionId: string, request: PublishRequest = "publish"): void {
	for (const listener of publishListeners) listener(sessionId, request);
}

/** Called with each request for `sessionId`, for as long as the caller is mounted. */
export function usePublishRequests(sessionId: string, onRequest: (request: PublishRequest) => void): void {
	const latest = useRef(onRequest);
	latest.current = onRequest;
	useEffect(() => {
		const listener = (id: string, request: PublishRequest) => {
			if (id === sessionId) latest.current(request);
		};
		publishListeners.add(listener);
		return () => {
			publishListeners.delete(listener);
		};
	}, [sessionId]);
}

/**
 * What the panel answers the bar's "Publish pull request" with, shown at the button so a press is never
 * silent: "reading" while the panel still reads what there is to publish (the dialog opens by itself once
 * it can), "refused" with why it cannot open. Null once the dialog opened or the answer was dismissed.
 */
export type PublishFeedback = { kind: "reading" } | { kind: "refused"; reason: string } | null;

const feedback = new Map<string, PublishFeedback>();
const feedbackListeners = new Set<() => void>();

export function setPublishFeedback(sessionId: string, value: PublishFeedback): void {
	if ((feedback.get(sessionId) ?? null) === value) return;
	if (value === null) feedback.delete(sessionId);
	else feedback.set(sessionId, value);
	for (const listener of feedbackListeners) listener();
}

export function usePublishFeedback(sessionId: string): PublishFeedback {
	return useSyncExternalStore(
		(listener) => {
			feedbackListeners.add(listener);
			return () => feedbackListeners.delete(listener);
		},
		() => feedback.get(sessionId) ?? null,
		() => null,
	);
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
