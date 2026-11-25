import { useState } from "react";
import { Dialog } from "../components/Dialog";
import { ApiTokens } from "../components/ApiTokens";
import { SettingsSecrets } from "../components/Secrets";
import { DefaultsSection } from "../components/Defaults";
import { ArrowLeftIcon } from "../components/Icons";
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
import { SettingsGroup, SettingsLayout, SettingsPending, SettingsRefreshError } from "../components/SettingsGroups";

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
	const choices = startingChoices(settings?.defaults ?? null, info, models.list, "account");

	const upgrades = machines.list?.flatMap(machine => {
		const note = settingsKeyUpgrade(machine);
		return note ? [<p className="field-note" key={machine.machineId}>{machineLabel(machine)}: {note}</p>] : [];
	}) ?? [];
	const paired = machines.list?.length ?? null;

	return (
		<main className="home usage repo settings">
			<header className="home-head">
				<div className="repo-head">
					<h1 className="display display-small">Settings</h1>
					<p className="home-account">Used by all your agents. Settings for a single repository are on its page.</p>
				</div>
			</header>

			{account.error && settings !== null && <SettingsRefreshError error={account.error} reload={account.reload} />}

			<SettingsLayout label="Settings sections">
				<SettingsGroup id="settings-account" title="Account" lede="How you sign in, and your plan.">
					{!auth.profile.demo && <LoginMethods />}
					{info?.billing ? <PlanSection /> : null}
					<SessionSettings />
				</SettingsGroup>

				<SettingsGroup id="settings-defaults" title="Defaults" lede="Used wherever a repository has no default of its own. A choice made at launch always comes first.">
					{settings === null ? (
						<SettingsPending subject="Your settings" error={account.error} reload={account.reload} />
					) : (
						<DefaultsSection
							id="settings-defaults-fields"
							defaults={settings.defaults}
							whose="account"
							under={null}
							account={account}
							models={models}
							save={(change) => client.user(auth).saveAccountDefaults(change)}
							onSaved={(next) => account.replace({ ...settings, defaults: next })}

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
					{upgrades.length > 0 && <div className="settings-row settings-row-notes">{upgrades}</div>}
				</SettingsGroup>

				{settings !== null ? (
					<SettingsGroup id="settings-tools" title="Tools" lede="MCP servers every agent gets, and the secrets they read.">
						<PersonalServers settings={settings} onChanged={account.replace} />
						<SettingsSecrets profile={choices.profile} onChanged={account.reload} />
					</SettingsGroup>
				) : null}

				{info?.items ? (
					<SettingsGroup id="settings-integrations" title="Integrations" lede="File work items from other places.">
						<LinearSettings />
						<ApiTokens />
					</SettingsGroup>
				) : null}
			</SettingsLayout>
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
