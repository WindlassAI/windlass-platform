import type { ItemFeed, ItemSummary } from "@contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "./app";

export interface ItemsState {
	/** What the feed holds, open items first: every open item and the newest ended ones. Null until it was read, and when it could not be. */
	list: ItemSummary[] | null;
	/** The feed itself, with the counts of every item (`ItemFeed.counts`). Null as `list` is. */
	feed: ItemFeed | null;
	/** Why it could not be read the last time it was asked for. */
	error: string | null;
	reload(): void;
}

const listOf = (feed: ItemFeed): ItemSummary[] => [...feed.open, ...feed.ended];

/**
 * The user's work items: read when the screen opens, then as the user's actor sends them, and again
 * after the live feed was down. `enabled` false asks nothing: for a deployment that offers no work
 * items (`PlatformInfo.items`), and while its information loads.
 */
export function useItems(enabled = true): ItemsState {
	// Read once for the whole app, so it is also called where no one is signed in: it asks nothing then.
	const { client, explain, auth } = useApp();
	const [state, setState] = useState<{ list: ItemSummary[] | null; feed: ItemFeed | null; error: string | null }>({
		list: null,
		feed: null,
		error: null,
	});
	const asked = useRef(0);

	const reload = useCallback(() => {
		const mine = ++asked.current;
		if (!auth) return;
		setState(now => ({ ...now, error: null }));
		client
			.user(auth)
			.itemFeed()
			.then(
				feed => mine === asked.current && setState({ list: listOf(feed), feed, error: null }),
				(failure: unknown) => mine === asked.current && setState(now => ({ ...now, error: explain(failure) })),
			);
	}, [client, auth, explain]);

	useEffect(() => {
		if (!auth) setState({ list: null, feed: null, error: null });
		if (!enabled || !auth) return;
		reload();
		let connected = false;
		const close = client.user(auth).watch({
			onSessions: () => undefined,
			onItems: feed => {
				asked.current += 1;
				setState({ list: listOf(feed), feed, error: null });
			},
			onConnection: connection => {
				if (connection !== "connected") return;
				// What the actor sent while the feed was down is lost: the list is read again when it is back.
				if (connected) reload();
				connected = true;
			},
		});
		return () => {
			asked.current += 1;
			close();
		};
	}, [client, auth, reload, enabled]);

	return { ...state, reload };
}
