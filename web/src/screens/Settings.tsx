/**
 * Settings: what a user keeps for their account, whatever the repository an agent works on. Three
 * things, each in the component its counterpart on a repository's page uses:
 *
 *   - the defaults a new agent starts with where neither its launch nor its repository says
 *     (`DefaultsSection`);
 *   - the user's own MCP servers, which Windlass starts in every agent of theirs (`PersonalServers`);
 *   - the secrets those servers read (`AccountSecretsBlock`), which reach MCP servers and, where
 *     their user says so for one, the agent's commands.
 *
 * Everything on the page is the user's actor's (`account`, `accountSecrets`): it is read when the
 * page opens, and every save answers with what is saved then. What a secret reaches depends on the
 * sandbox, so the list of secrets is said for the sandbox a new agent starts in when nothing else is
 * chosen: the account's default, or the deployment's first.
 */
import type { AccountSettings, LastStart } from "@contract";
import { useState } from "react";
import { Dialog } from "../components/Dialog";
import { ApiTokens } from "../components/ApiTokens";
import { AccountSecretsBlock } from "../components/Secrets";
import { DefaultsSection } from "../components/Defaults";
import { ArrowLeftIcon, WarnIcon } from "../components/Icons";
import { PersonalServers } from "../components/PersonalServers";
import { PlanSection } from "../components/Plan";
import { HARNESS_NAMES } from "../lib/acp";
import { machineLabel } from "../lib/machines";
import { modeName } from "../lib/modes";
import { startingChoices } from "../lib/repositories";
import { useMachines } from "./Machines";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useAccount, useModels } from "../state/hooks";
import { Check } from "../components/ui/Check";
import { AgentGlyph } from "../components/ui/Pill";

/**
 * Where a new agent runs, which agent it is, and its mode: not saved on purpose, but where the last
 * agent started, which the server remembers (`AccountSettings.lastStart`). Said in one line, with a
 * way to forget it; the next agent started is remembered again.
 */
function LastStartLine({ lastStart, forget, onForgotten }: { lastStart: LastStart | null; forget(): Promise<AccountSettings>; onForgotten(next: AccountSettings): void }) {
	const { platform, explain } = useApp();
	const machines = useMachines(lastStart?.place.kind === "machine" && platform.info?.machines != null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState<string | null>(null);
	const machine = lastStart?.place.kind === "machine" ? (machines.list?.find((candidate) => candidate.machineId === (lastStart.place as { machineId: string }).machineId) ?? null) : null;
	const where = lastStart === null ? null : lastStart.place.kind === "hosted" ? "a hosted sandbox" : machine ? machineLabel(machine) : machines.list ? "a machine that is no longer yours" : "one of your machines";
	const run = async () => {
		setBusy(true);
		setFailed(null);
		try {
			onForgotten(await forget());
		} catch (failure) {
			setFailed(explain(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="field last-start">
			<span className="label">Where it runs, agent and mode</span>
			<p className="last-start-value" data-testid="last-start">
				{lastStart === null ? (
					<span className="last-start-none">Nothing remembered yet</span>
				) : (
					<>
						<span>{where}</span>
						<span className="last-start-sep" aria-hidden="true">·</span>
						<span>
							<AgentGlyph harness={lastStart.harness} size={11} inline />
							{HARNESS_NAMES[lastStart.harness]}
						</span>
						<span className="last-start-sep" aria-hidden="true">·</span>
						<span>{modeName(lastStart.harness, lastStart.mode)}</span>
						<button type="button" className="link last-start-forget" onClick={() => void run()} disabled={busy}>
							{busy ? "Forgetting…" : "Forget"}
						</button>
					</>
				)}
			</p>
			<p className={`field-note${failed ? " tone-bad" : ""}`} role={failed ? "alert" : undefined}>
				{failed ?? "A new agent starts where your last one did, with the same agent and mode, until you choose otherwise. A machine or agent that cannot be used then leaves it on a hosted sandbox with Windlass, and the launch says so."}
			</p>
		</div>
	);
}

/** What the top bar shows on this page: the way back and where one is. */
export function SettingsCrumb() {
	return (
		<nav className="crumb" aria-label="Where you are">
			<a className="crumb-back" {...linkProps({ name: "home" })}>
				<ArrowLeftIcon size={14} />
				<span>Agents</span>
			</a>
			<span className="crumb-sep" aria-hidden="true">
				/
			</span>
			<span className="crumb-title" aria-current="page">
				Settings
			</span>
		</nav>
	);
}

export function Settings() {
	const { client, platform, auth: signedIn } = useApp();
	const auth = useAuth();
	const account = useAccount();
	const models = useModels();
	const { settings } = account;
	const info = platform.info;
	const who = signedIn?.profile.demo ? "the demo account" : (signedIn?.profile.email ?? signedIn?.profile.uid ?? "your account");
	// What a secret reaches depends on the sandbox: the list is said for the one a new agent starts in when nothing else is chosen.
	const choices = startingChoices(settings?.defaults ?? null, info, models.list, "account");
	const reachProfile = info?.profiles.find((profile) => profile.id === choices.profile) ?? info?.profiles.find((profile) => profile.available) ?? info?.profiles[0] ?? null;

	return (
		<main className="home usage repo">
			<header className="home-head">
				<div className="repo-head">
					<p className="eyebrow">account</p>
					<h1 className="display display-small">Settings</h1>
					<p className="home-account">What {who} keeps for every agent, whatever the repository it works on. What is saved for one repository is on that repository's page.</p>
				</div>
			</header>

			{info?.billing ? <PlanSection /> : null}

			{settings === null ? (
				<section className="usage-section">
					{account.error ? (
						<div className="state state-error" role="alert">
							<WarnIcon size={22} />
							<h2>Your settings could not be loaded</h2>
							<p>{account.error}</p>
							<button type="button" className="button button-outline" onClick={account.reload}>
								Try again
							</button>
						</div>
					) : (
						<div className="usage-loading" aria-busy="true" aria-label="Loading your settings">
							<span className="skeleton skeleton-title" style={{ width: "34%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						</div>
					)}
				</section>
			) : (
				<>
					{account.error ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{account.error} What is shown may be behind.</span>
						</p>
					) : null}

					<DefaultsSection
						id="settings-defaults"
						lede="A new agent starts from these where its repository has no default of its own, and on no repository. A choice made when it is launched comes first, then the repository's default, then these, then what your newest agent was launched with, then the deployment's. Where it runs, the agent and the mode start where your last agent did."
						defaults={settings.defaults}
						whose="account"
						under={null}
						models={models}
						save={(change) => client.user(auth).saveAccountDefaults(change)}
						onSaved={(next) => account.replace({ ...settings, defaults: next })}
					>
						<LastStartLine lastStart={settings.lastStart} forget={() => client.user(auth).forgetLastStart()} onForgotten={account.replace} />
					</DefaultsSection>

					<PersonalServers settings={settings} onChanged={account.replace} />

					<section className="usage-section repo-saved" aria-labelledby="settings-secrets">
						<AccountSecretsBlock
							profile={reachProfile?.id ?? null}
							// A server's line says whether a secret sets the variable it reads: the servers are read again.
							onChanged={account.reload}
							title={(add) => (
								<h2 className="usage-title" id="settings-secrets">
									Secrets
									{add}
								</h2>
							)}
						/>
						{reachProfile ? (
							<p className="usage-note">
								For MCP servers, and for the agent's commands only where you choose so for a secret: never a repository's setup command. What each reaches is said for {reachProfile.name}, {choices.profile === reachProfile.id ? "your default sandbox" : "the sandbox a new agent starts in when none is chosen"}. An account can keep{" "}
								{settings.limits.secrets}.
							</p>
						) : null}
					</section>
				</>
			)}

			{info?.machines ? (
				<section className="usage-section" aria-labelledby="settings-machines">
					<h2 className="usage-title" id="settings-machines">
						Machines
					</h2>
					<p className="usage-lede">
						Your own computers with Docker, where the agents you launch can run.{" "}
						<a className="link" {...linkProps({ name: "machines" })}>
							Your machines
						</a>
					</p>
				</section>
			) : null}

			{info?.items ? <ApiTokens /> : null}
			<SessionSettings />
		</main>
	);
}

function SessionSettings() {
	const { client, signOut, explain } = useApp();
	const auth = useAuth();
	const [confirm, setConfirm] = useState(false);
	const [revokeApiTokens, setRevokeApiTokens] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function revoke() {
		setBusy(true);
		setError(null);
		try {
			await client.user(auth).signOutEverywhere({ revokeApiTokens });
			signOut("You signed out everywhere.");
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	}
	return (
		<section className="usage-section" aria-labelledby="settings-sessions">
			<h2 className="usage-title" id="settings-sessions">Sign-in</h2>
			<button type="button" className="button button-quiet button-small" onClick={() => { setError(null); setRevokeApiTokens(true); setConfirm(true); }}>
				Sign out everywhere
			</button>
			{confirm && (
				<Dialog title="Sign out everywhere?" size="small" dismissable={!busy} onClose={() => setConfirm(false)}
					footer={<>
						<button type="button" className="button button-quiet" disabled={busy} onClick={() => setConfirm(false)} data-autofocus>Cancel</button>
						<button type="button" className="button button-danger" disabled={busy} onClick={revoke}>{busy ? "Signing out…" : "Sign out everywhere"}</button>
					</>}>
					<p>You’ll need to sign in again on every device, including this one. Your running agents will keep working.</p>
					<p>Paired machines keep working. You can remove them on the <a className="link" {...linkProps({ name: "machines" })}>Machines</a> page.</p>
					<Check checked={revokeApiTokens} disabled={busy} onChange={setRevokeApiTokens} label="Also revoke all API tokens" />
					{error && <p className="callout callout-warn" role="alert">{error}</p>}
				</Dialog>
			)}
		</section>
	);
}
