/** What every screen shares: the client, who is signed in, and the deployment's public facts. */
import type { AuthResult, PlatformInfo } from "@contract";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { errorMessage, PlatformError, type PlatformClient } from "../api/client";
import { loadAuth, saveAuth } from "../lib/authStore";
import { navigate } from "../lib/router";

export interface InfoState {
	info: PlatformInfo | null;
	error: string | null;
	loading: boolean;
	reload(): void;
}

interface AppContextValue {
	client: PlatformClient;
	auth: AuthResult | null;
	/** Why the user was sent back to the sign-in screen, when they were. */
	signedOutReason: string | null;
	signIn(auth: AuthResult): void;
	signOut(reason?: string): void;
	/** A message for something thrown at the client. A refused token also signs the user out. */
	explain(error: unknown): string;
	platform: InfoState;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ client, children }: { client: PlatformClient; children: ReactNode }) {
	const [auth, setAuth] = useState<AuthResult | null>(() => loadAuth(client.kind));
	const [signedOutReason, setSignedOutReason] = useState<string | null>(null);
	const [info, setInfo] = useState<PlatformInfo | null>(null);
	const [infoError, setInfoError] = useState<string | null>(null);
	const [infoLoading, setInfoLoading] = useState(true);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let current = true;
		setInfoLoading(true);
		client.info().then(
			(value) => {
				if (!current) return;
				setInfo(value);
				setInfoError(null);
				setInfoLoading(false);
			},
			(error: unknown) => {
				if (!current) return;
				setInfoError(errorMessage(error));
				setInfoLoading(false);
			},
		);
		return () => {
			current = false;
		};
	}, [client, attempt]);

	const signIn = useCallback(
		(next: AuthResult) => {
			saveAuth(client.kind, next);
			setSignedOutReason(null);
			setAuth(next);
		},
		[client],
	);

	const signOut = useCallback(
		(reason?: string) => {
			saveAuth(client.kind, null);
			setSignedOutReason(reason ?? null);
			setAuth(null);
			navigate({ name: "signin" });
		},
		[client],
	);

	const explain = useCallback(
		(error: unknown) => {
			if (error instanceof PlatformError && error.code === "unauthorized") signOut("Your sign-in is no longer accepted. Sign in again to carry on.");
			return errorMessage(error);
		},
		[signOut],
	);

	const platform = useMemo<InfoState>(() => ({ info, error: infoError, loading: infoLoading, reload: () => setAttempt((value) => value + 1) }), [info, infoError, infoLoading]);
	const value = useMemo<AppContextValue>(() => ({ client, auth, signedOutReason, signIn, signOut, explain, platform }), [client, auth, signedOutReason, signIn, signOut, explain, platform]);
	return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
	const value = useContext(AppContext);
	if (!value) throw new Error("useApp outside AppProvider");
	return value;
}

/** For the screens behind the sign-in: the signed-in user is known to be there. */
export function useAuth(): AuthResult {
	const { auth } = useApp();
	if (!auth) throw new Error("useAuth on a screen that is not behind the sign-in");
	return auth;
}
