/**
 * Settings: what a user keeps for their account, whatever the repository an agent works on. Three
 * things, each in the component its counterpart on a repository's page uses:
 *
 *   - the defaults a new agent starts with where neither the launch form nor its repository says
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
import { ApiTokens } from "../components/ApiTokens";
import { AccountSecretsBlock } from "../components/Secrets";
import { DefaultsSection } from "../components/Defaults";
import { ArrowLeftIcon, WarnIcon } from "../components/Icons";
import { PersonalServers } from "../components/PersonalServers";
import { startingChoices } from "../lib/repositories";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useAccount, useModels } from "../state/hooks";

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
						lede="The launch form starts from these where the chosen repository has no default of its own, and for an agent on no repository. A choice made in the form comes first, then the repository's default, then these, then the deployment's."
						defaults={settings.defaults}
						whose="account"
						under={null}
						models={models}
						save={(change) => client.user(auth).saveAccountDefaults(change)}
						onSaved={(next) => account.replace({ ...settings, defaults: next })}
					/>

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
						Your own Linux machines with Docker, where the agents you launch can run.{" "}
						<a className="link" {...linkProps({ name: "machines" })}>
							Your machines
						</a>
					</p>
				</section>
			) : null}

			<ApiTokens />
		</main>
	);
}
