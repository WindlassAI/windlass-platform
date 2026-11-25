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
import { useState } from "react";
import { Dialog } from "../components/Dialog";
import { ApiTokens } from "../components/ApiTokens";
import { AccountSecretsBlock } from "../components/Secrets";
import { DefaultsSection } from "../components/Defaults";
import { ArrowLeftIcon, WarnIcon } from "../components/Icons";
import { LinearSettings } from "../components/LinearSettings";
import { LoginMethods } from "../components/LoginMethods";
import { ModelProviders } from "../components/ModelProviders";
import { PersonalServers } from "../components/PersonalServers";
import { PlanSection } from "../components/Plan";
import { machineLabel } from "../lib/machines";
import { startingChoices } from "../lib/repositories";
import { settingsKeyUpgrade, useMachines } from "./Machines";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useAccount, useModels } from "../state/hooks";
import { Check } from "../components/ui/Check";
import { SettingsGroup, SettingsLayout, SettingsNav } from "../components/SettingsGroups";

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
	const { client, platform } = useApp();
	const auth = useAuth();
	const account = useAccount();
	const models = useModels();
	const { settings } = account;
	const info = platform.info;
	const machines = useMachines(!!info?.machines);
	// What a secret reaches depends on the sandbox: the list is said for the one a new agent starts in when nothing else is chosen.
	const choices = startingChoices(settings?.defaults ?? null, info, models.list, "account");
	const reachProfile = info?.profiles.find((profile) => profile.id === choices.profile) ?? info?.profiles.find((profile) => profile.available) ?? info?.profiles[0] ?? null;

	const items = Boolean(info?.items);
	const groups = [
		{ id: "settings-account", title: "Account" },
		{ id: "settings-defaults", title: "Defaults" },
		{ id: "settings-models", title: "Models" },
		...(settings === null ? [] : [{ id: "settings-tools", title: "Tools" }]),
		...(items ? [{ id: "settings-integrations", title: "Integrations" }] : []),
	];
	const paired = machines.list?.length ?? null;

	return (
		<main className="home usage repo settings">
			<header className="home-head">
				<div className="repo-head">
					<h1 className="display display-small">Settings</h1>
					<p className="home-account">Used by all your agents. Settings for a single repository are on its page.</p>
				</div>
			</header>

			{account.error && settings !== null ? (
				<p className="callout callout-warn" role="status">
					<WarnIcon />
					<span>{account.error} <button className="link" onClick={account.reload}>Try again</button></span>
				</p>
			) : null}

			<SettingsLayout nav={<SettingsNav label="Settings sections" groups={groups} />}>
				<SettingsGroup id="settings-account" title="Account" lede="How you sign in, and your plan.">
					{!auth.profile.demo && <LoginMethods />}
					{info?.billing ? <PlanSection /> : null}
					<SessionSettings />
				</SettingsGroup>

				<SettingsGroup id="settings-defaults" title="Defaults" lede="Used wherever a repository has no default of its own. A choice made at launch always comes first.">
					{settings === null ? (
						<SettingsLoading error={account.error} reload={account.reload} />
					) : (
						<DefaultsSection
							id="settings-defaults-fields"
							defaults={settings.defaults}
							whose="account"
							under={null}
							account={null}
							models={models}
							save={(change) => client.user(auth).saveAccountDefaults(change)}
							onSaved={(next) => account.replace({ ...settings, defaults: next })}
							lastStart={settings.lastStart}
							forgetLastStart={() => client.user(auth).forgetLastStart()}
							onForgotten={account.replace}
						/>
					)}
					{info?.machines ? (
						<div className="settings-row">
							<span className="settings-row-name">My machines</span>
							{paired !== null ? <span className="settings-row-meta">{paired === 0 ? "none paired" : `${paired} paired`}</span> : null}
							<a className="link settings-row-end" {...linkProps({ name: "machines" })}>
								{paired === 0 ? "Add a machine →" : "Manage →"}
							</a>
						</div>
					) : null}
				</SettingsGroup>

				<SettingsGroup
					id="settings-models"
					title="Models"
					lede={<>Hosted agents use these. Keys stay on Windlass. <a className="link" href="/docs/settings#model-providers">How keys are used →</a></>}
				>
					<ModelProviders />
					{machines.list?.some((machine) => settingsKeyUpgrade(machine)) ? (
						<div className="settings-row settings-row-notes">
							{machines.list.map((machine) => {
								const upgrade = settingsKeyUpgrade(machine);
								return upgrade && <p className="field-note" key={machine.machineId}>{machineLabel(machine)}: {upgrade}</p>;
							})}
						</div>
					) : null}
				</SettingsGroup>

				{settings !== null ? (
					<SettingsGroup id="settings-tools" title="Tools" lede="MCP servers every agent gets, and the secrets they read.">
						<PersonalServers settings={settings} onChanged={account.replace} />
						<section className="usage-section repo-saved" aria-labelledby="settings-secrets">
							<AccountSecretsBlock
								profile={reachProfile?.id ?? null}
								// A server's line says whether a secret sets the variable it reads: the servers are read again.
								onChanged={account.reload}
								title={(add) => (
									<h3 className="usage-title" id="settings-secrets">
										Secrets
										{add}
									</h3>
								)}
							/>
						</section>
					</SettingsGroup>
				) : null}

				{items ? (
					<SettingsGroup id="settings-integrations" title="Integrations" lede="File work items from other places.">
						<LinearSettings />
						<ApiTokens />
					</SettingsGroup>
				) : null}
			</SettingsLayout>
		</main>
	);
}

/** What stands in a group whose settings are not read yet, or could not be. */
function SettingsLoading({ error, reload }: { error: string | null; reload(): void }) {
	return error ? (
		<div className="usage-section">
			<div className="state state-error" role="alert">
				<WarnIcon size={22} />
				<h3>Your settings could not be loaded</h3>
				<p>{error}</p>
				<button type="button" className="button button-outline" onClick={reload}>
					Try again
				</button>
			</div>
		</div>
	) : (
		<div className="usage-section usage-loading" aria-busy="true" aria-label="Loading your settings">
			<span className="skeleton skeleton-title" style={{ width: "34%" }} />
			<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
			<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
		</div>
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
		<section className="settings-row" aria-label="Sign out">
			<span className="settings-row-text">Signed in on this device</span>
			<button type="button" className="button button-outline button-small settings-row-end" onClick={() => { setError(null); setRevokeApiTokens(true); setConfirm(true); }}>
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
