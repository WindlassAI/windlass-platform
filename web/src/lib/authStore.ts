/** The token and profile, kept in localStorage. The mock and the real backend keep theirs apart. */
import type { AuthResult } from "@contract";
import type { ClientKind } from "../api/client";

const key = (kind: ClientKind) => (kind === "mock" ? "wlp.auth.mock" : "wlp.auth");

export function loadAuth(kind: ClientKind): AuthResult | null {
	try {
		const text = localStorage.getItem(key(kind));
		if (text === null) return null;
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null) return null;
		const { token, profile } = value as Partial<AuthResult>;
		if (typeof token !== "string" || typeof profile !== "object" || profile === null || typeof profile.uid !== "string") return null;
		return { token, profile: { uid: profile.uid, email: typeof profile.email === "string" ? profile.email : null, demo: profile.demo === true } };
	} catch {
		return null;
	}
}

export function saveAuth(kind: ClientKind, auth: AuthResult | null): void {
	try {
		if (auth === null) localStorage.removeItem(key(kind));
		else localStorage.setItem(key(kind), JSON.stringify(auth));
	} catch {
		// Storage is unavailable: the sign-in lasts until the page is closed.
	}
}
