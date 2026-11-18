/** The bar across the top: the wordmark, where you are, the theme toggle and the account. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { absoluteTime, duration } from "../lib/format";
import { linkProps } from "../lib/router";
import type { Theme } from "../lib/theme";
import { useApp } from "../state/app";
import { useGithub } from "../state/github";
import { useChatgpt, useNow } from "../state/hooks";
import { ExternalIcon, Mark, MoonIcon, SunIcon, UserIcon } from "./Icons";

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

/** The GitHub connection in the account menu: what it is, the accounts it covers, and the way to change it. */
function GithubBlock({ github }: { github: ReturnType<typeof useGithub> }) {
	const connection = github.status?.connection ?? null;
	const busy = github.busy !== null;
	return (
		<div className="menu-github">
			<p className="menu-heading">GitHub</p>
			{github.notice?.where === "menu" && github.notice.tone === "bad" ? (
				<p className="menu-note tone-bad" role="alert">
					{github.notice.text}
				</p>
			) : null}
			{github.busy === "finishing" ? (
				<p className="menu-note" aria-busy="true">
					Finishing the GitHub connection…
				</p>
			) : github.error ? (
				<p className="menu-note tone-bad">
					{github.error}{" "}
					<button type="button" className="link" onClick={github.reload}>
						Try again
					</button>
				</p>
			) : github.status === null ? (
				<p className="menu-note">Checking the GitHub connection…</p>
			) : connection ? (
				<>
					<p className="menu-note">
						<span className="tone-good">GitHub connected</span> as {connection.login}. Agents can work on the repositories the app may see in:
					</p>
					<ul className="gh-accounts">
						{connection.accounts.map((account) => (
							<li key={account.installationId}>
								<span className="gh-account-name" title={account.login}>
									{account.login}
								</span>
								{account.kind === "organization" ? <span className="chip">organization</span> : null}
								<a className="gh-account-link" href={account.manageUrl} target="_blank" rel="noreferrer" aria-label={`Choose the repositories of ${account.login} at GitHub`}>
									repositories
									<ExternalIcon size={11} />
								</a>
							</li>
						))}
					</ul>
					<div className="gh-menu-actions">
						<button type="button" className="button button-quiet button-small" onClick={() => github.connect({ where: "menu", install: true })} disabled={busy}>
							{github.busy === "leaving" ? "Going to GitHub…" : "Add an account"}
						</button>
						<button type="button" className="button button-quiet button-small" onClick={() => void github.disconnect()} disabled={busy}>
							{github.busy === "disconnecting" ? "Disconnecting…" : "Disconnect"}
						</button>
					</div>
				</>
			) : (
				<>
					<p className="menu-note">Not connected. Connect it to launch agents on your own repositories, private ones included, and get their work as pull requests.</p>
					<button type="button" className="button button-outline button-small gh-menu-connect" onClick={() => github.connect({ where: "menu" })} disabled={busy}>
						{github.busy === "leaving" ? "Going to GitHub…" : "Connect GitHub"}
					</button>
				</>
			)}
		</div>
	);
}

function AccountMenu() {
	const { auth } = useApp();
	// The menu's parts ask about the signed-in user: without one there is no menu.
	return auth ? <SignedInMenu /> : null;
}

function SignedInMenu() {
	const { auth, signOut, client } = useApp();
	const github = useGithub();
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	const { notice, dismiss } = github;

	// Back from GitHub, when the connection was started here: the menu opens and says what came of it.
	useEffect(() => {
		if (notice?.where === "menu") setOpen(true);
	}, [notice]);
	// Said once: closing the menu puts it away.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (wasOpen.current && !open) dismiss();
		wasOpen.current = open;
	}, [open, dismiss]);

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
					{github.enabled ? <GithubBlock github={github} /> : null}
					{/* The account's own page: closing the menu is the link's doing, the way there is the router's. */}
					<a className="button button-quiet menu-action" {...linkProps({ name: "settings" })} onClickCapture={() => setOpen(false)}>
						Settings
					</a>
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
