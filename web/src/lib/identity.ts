/**
 * Who the signed-in person is, for the account menu: a name and an address from the sign-ins linked to the
 * account (GitHub first, then Google), with the GitHub picture. The account's own id is never shown as a name.
 */
import type { LinkedLogin, UserProfile } from "@contract";
import { useEffect, useState } from "react";
import { useApp, useAuth } from "../state/app";

export interface Identity {
	/** A name, a login or an address: "Your account" when nothing better is known. */
	name: string;
	/** Under the name: the address, or the GitHub login when there is no address. Null when it would repeat the name. */
	detail: string | null;
	avatar: string | null;
	/** The letter in the avatar's place; null where there is no name to take one from. */
	initial: string | null;
}

export function whoIs(profile: UserProfile, linked: LinkedLogin[] | null): Identity {
	if (profile.demo) return { name: "Demo user", detail: null, avatar: null, initial: "D" };
	const github = linked?.find((login) => login.provider === "github");
	const google = linked?.find((login) => login.provider === "google");
	const login = github?.display ?? null;
	const email = profile.email ?? google?.display ?? null;
	const name = github?.name ?? google?.name ?? login ?? email;
	const detail = email ?? (login ? `@${login}` : null);
	return {
		name: name ?? "Your account",
		detail: detail && detail !== name ? detail : null,
		avatar: github?.avatar ?? google?.avatar ?? null,
		initial: name ? name.slice(0, 1).toUpperCase() : null,
	};
}

/** Read once per sign-in: the menu is in every page's bar. */
let cache: { token: string; linked: LinkedLogin[] } | null = null;

export function useIdentity(): Identity {
	const { client } = useApp();
	const auth = useAuth();
	const [linked, setLinked] = useState<LinkedLogin[] | null>(cache?.token === auth.token ? cache.linked : null);
	useEffect(() => {
		if (auth.profile.demo || cache?.token === auth.token) return;
		let live = true;
		client
			.user(auth)
			.linkedLogins()
			.then(
				(found) => {
					cache = { token: auth.token, linked: found };
					if (live) setLinked(found);
				},
				// Without them the menu names the address, or "Your account".
				() => undefined,
			);
		return () => {
			live = false;
		};
	}, [client, auth]);
	return whoIs(auth.profile, linked);
}
