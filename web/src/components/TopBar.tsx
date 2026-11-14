/** The bar across the top: the wordmark, where you are, the theme toggle and the account. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { absoluteTime, duration } from "../lib/format";
import { linkProps } from "../lib/router";
import type { Theme } from "../lib/theme";
import { useApp } from "../state/app";
import { useChatgpt, useNow } from "../state/hooks";
import { Mark, MoonIcon, SunIcon, UserIcon } from "./Icons";

export function Wordmark({ size = "small" }: { size?: "small" | "large" }) {
	return (
		<span className={`wordmark wordmark-${size}`}>
			<Mark size={size === "large" ? 44 : 22} />
			<span className="wordmark-name">windlass</span>
		</span>
	);
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle(): void }) {
	const next = theme === "dark" ? "light" : "dark";
	return (
		<button type="button" className="icon-button" onClick={onToggle} aria-label={`Switch to the ${next} theme`} title={`Switch to the ${next} theme`}>
			{theme === "dark" ? <SunIcon /> : <MoonIcon />}
		</button>
	);
}

function ChatgptLine() {
	const { status, error } = useChatgpt();
	const now = useNow(30_000);
	if (error) return <p className="menu-note tone-bad">{error}</p>;
	if (!status) return <p className="menu-note">Checking the ChatGPT connection…</p>;
	if (!status.connected) return <p className="menu-note tone-warn">ChatGPT is not connected. Sign in again to run agents.</p>;
	return (
		<p className="menu-note">
			<span className="tone-good">ChatGPT connected</span>
			{status.email ? ` as ${status.email}` : ""}
			{status.accessExpiresAt !== null ? (
				<span title={absoluteTime(status.accessExpiresAt)}>
					{status.accessExpiresAt > now ? `. The access token renews itself in ${duration(status.accessExpiresAt - now)}.` : ". The access token renews itself on the next turn."}
				</span>
			) : null}
		</p>
	);
}

function AccountMenu() {
	const { auth, signOut, client } = useApp();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (!auth) return null;
	const name = auth.profile.demo ? "Demo user" : (auth.profile.email ?? auth.profile.uid);
	return (
		<div className="account" ref={ref}>
			<button type="button" className="account-button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
				<UserIcon size={15} />
				<span className="account-name">{name}</span>
			</button>
			{open ? (
				<div className="menu" role="group" aria-label="Account">
					<p className="menu-title">{name}</p>
					<p className="menu-id">{auth.profile.uid}</p>
					{auth.profile.demo ? <p className="menu-note">The demo runs a scripted model with real tool calls. It has no ChatGPT account.</p> : <ChatgptLine />}
					{client.kind === "mock" ? <p className="menu-note">Mock backend: nothing leaves this page.</p> : null}
					<button type="button" className="button button-quiet menu-action" onClick={() => signOut()}>
						Sign out
					</button>
				</div>
			) : null}
		</div>
	);
}

export function TopBar({ theme, onToggleTheme, children }: { theme: Theme; onToggleTheme(): void; children?: ReactNode }) {
	const { auth, client } = useApp();
	return (
		<header className="topbar">
			<a className="topbar-home" {...linkProps(auth ? { name: "home" } : { name: "signin" })} aria-label="Windlass, home">
				<Wordmark />
			</a>
			{client.kind === "mock" ? (
				<span className="mock-flag" title="The mock backend is in use: no network, scripted turns.">
					mock
				</span>
			) : null}
			<div className="topbar-middle">{children}</div>
			<div className="topbar-end">
				<ThemeToggle theme={theme} onToggle={onToggleTheme} />
				<AccountMenu />
			</div>
		</header>
	);
}
