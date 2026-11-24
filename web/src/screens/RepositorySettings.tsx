/**
 * A repository's settings, the second view of its page (Repository.tsx): what new agents on it start
 * with, whether its work items' agents take screenshots, its setup command, its checks and its secrets, the first and the last in the same components a
 * session's panel has; the approvals of its MCP servers that are remembered, each with the way to
 * forget it; and the way to delete everything saved for it at once. Nothing here is read until the
 * view is shown. An address's fragment (`#checks`) opens it at that section once what is saved was read.
 */
import type { RepositoryView } from "@contract";
import { useEffect, useState } from "react";
import { ChecksEditor } from "../components/Checks";
import { DefaultsSection } from "../components/Defaults";
import { EnvironmentSection } from "../components/Environments";
import { Dialog } from "../components/Dialog";
import { WarnIcon } from "../components/Icons";
import { NetworkSection } from "../components/Network";
import { SecretsBlock } from "../components/Secrets";
import { RepositoryApprovals } from "../components/Servers";
import { SetupEditor } from "../components/SetupCommand";
import { layerChoices, ownAgents, startingChoices } from "../lib/repositories";
import { sectionOf, useHash, type RepositorySection } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useAccount, useModels, useNow } from "../state/hooks";
import type { RepositoryPage } from "./Repository";
import { Check } from "../components/ui/Check";

/** The id of a section's heading: where a link to it lands. */
export const sectionHeading = (section: RepositorySection) => `repo-${section}`;

/**
 * Whether the agents of the repository's work items, the one that makes the change and the second
 * reviewer, take screenshots of the app for their reports (`RepositoryDefaults.screenshots`, off by default). Saved as soon as it is changed; read by each agent at its next turn.
 */
export function ScreenshotsSetting({ page, view }: { page: Pick<RepositoryPage, "id" | "replace">; view: RepositoryView }) {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
	const on = view.defaults.screenshots;
	// WLP_FACTORY_SCREENSHOTS=off: no work item takes screenshots, whatever is saved here. A saved "on" can still be turned off.
	const deploymentOff = platform.info?.items?.screenshots === false;
	const set = async (screenshots: boolean) => {
		if (busy) return;
		setBusy(true);
		setSaid(null);
		try {
			const defaults = await client.user(auth).saveRepositoryDefaults(page.id, { screenshots });
			page.replace({ ...view, defaults });
			setSaid({ tone: "good", text: "Saved." });
		} catch (failure) {
			setSaid({ tone: "bad", text: explain(failure) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="usage-section repo-saved repo-screenshots" aria-labelledby="repo-screenshots">
			<h2 className="usage-title" id="repo-screenshots">
				Screenshots
			</h2>
			<p className="usage-lede">Let builders and reviewers attach pictures of the app to their work item reports. Screenshots are off by default.</p>
			<div className="usage-card repo-form">
				<Check checked={on} disabled={busy || (deploymentOff && !on)} onChange={(on) => set(on)}>
					<span className="check-name">Take screenshots for work items</span>
					<span className="check-means">
						{deploymentOff
							? "Screenshots are turned off for this whole deployment, so no work item takes them, whatever is chosen here."
							: on
							? "New work item sandboxes include a browser where available. Turning this off stops screenshot filing from the next turn."
							: "Turning this on gives new work item sandboxes a browser where available. An existing builder keeps its sandbox."}
					</span>
				</Check>
				{said ? (
					<p className={`field-note tone-${said.tone}`} role={said.tone === "bad" ? "alert" : "status"}>
						{said.text}
					</p>
				) : null}
			</div>
		</section>
	);
}

function AutonomySettings({ page, view }: { page: RepositoryPage; view: RepositoryView }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function save(field: "autoApprovePlans" | "autoMergeSingles", on: boolean) {
		setBusy(true);
		setError("");
		try {
			const defaults = await client.user(auth).saveRepositoryDefaults(page.id, { [field]: on });
			page.replace({ ...view, defaults });
		} catch (failure) { setError(explain(failure)); }
		finally { setBusy(false); }
	}
	return <section className="usage-section repo-saved" aria-labelledby="repo-autonomy">
		<h2 className="usage-title" id="repo-autonomy">Work item approvals</h2>
		<div className="usage-card repo-form">
			<Check checked={!!view.defaults.autoApprovePlans} disabled={busy} onChange={on => save("autoApprovePlans", on)}>
				<span className="check-name">Auto-approve small plans</span>
				<span className="check-means">Let an independent critic approve plans with up to three parts and no open questions.</span>
			</Check>
			<Check checked={!!view.defaults.autoMergeSingles} disabled={busy} onChange={on => save("autoMergeSingles", on)}>
				<span className="check-name">Auto-merge single items</span>
				<span className="check-means">Squash-merge a current single-item PR when its verdict, CI and second review all pass.</span>
			</Check>
			{error && <p className="field-note tone-bad" role="alert">{error}</p>}
		</div>
	</section>;
}

/** What deleting everything saved takes with it, and what it leaves. */
/** `agents`: the user's own agents on it; `items`: the sessions of its work items, which stay with their items. */
function ForgetDialog({ page, view, name, agents, items, onClose, onDone }: { page: RepositoryPage; view: RepositoryView; name: string; agents: number; items: number; onClose(): void; onDone(): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const parts = [
		view.saved.setup ? "the setup command" : null,
		view.saved.checks > 0 ? (view.saved.checks === 1 ? "its one check" : `its ${view.saved.checks} checks`) : null,
		view.saved.secrets > 0 ? (view.saved.secrets === 1 ? "its one secret" : `its ${view.saved.secrets} secrets`) : null,
		view.saved.network > 0 ? "its network list" : null,
		view.defaults.profile !== null || view.defaults.model !== null ? "the defaults for new agents" : null,
		view.defaults.place ? "where new work items run" : null,
		view.defaults.autoApprovePlans || view.defaults.autoMergeSingles ? "automatic work item approvals" : null,
		view.defaults.screenshots ? "the choice to take screenshots" : null,
		view.approvals.length > 0 ? (view.approvals.length === 1 ? "the remembered approval of one MCP server" : `the remembered approvals of ${view.approvals.length} MCP servers`) : null,
	].filter((part): part is string => part !== null);
	const listed = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

	const forget = async () => {
		setBusy(true);
		setError(null);
		try {
			page.replace(await client.user(auth).forgetRepository(page.id));
			onDone();
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title="Delete what is saved?"
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={forget} disabled={busy}>
						{busy ? "Deleting…" : "Delete"}
					</button>
				</>
			}
		>
			<p>
				What you saved for <strong>{name}</strong> is deleted: {listed}. This cannot be undone; a secret's value cannot be read back from here, so keep a copy of any you still need.
			</p>
			{agents + items > 0 ? (
				<p>
					{[agents === 0 ? null : agents === 1 ? "The agent on it" : `The ${agents} agents on it`, items === 0 ? null : items === 1 ? "the agent of its work item" : `the agents of its ${items} work items`]
						.filter((part) => part !== null)
						.join(" and ")
						.replace(/^t/, "T")}{" "}
					{agents + items === 1 ? "stays" : "stay"}, with {agents + items === 1 ? "its conversation and its workspace" : "their conversations and their workspaces"}. A sandbox made after this is set up without them, and {agents + items === 1 ? "its" : "their"} MCP servers are asked about again.
				</p>
			) : null}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</Dialog>
	);
}

export function RepositorySettings({ page }: { page: RepositoryPage }) {
	const { client, platform } = useApp();
	const auth = useAuth();
	// What the account says new agents start with: what a field left without a default here comes to.
	const account = useAccount();
	const models = useModels();
	const now = useNow(15_000);
	const ids = { setup: sectionHeading("setup"), checks: sectionHeading("checks"), network: sectionHeading("network") };
	const [forgetting, setForgetting] = useState(false);
	/** Counted up when everything saved was deleted: the setup command and the secrets are read anew. */
	const [generation, setGeneration] = useState(0);
	const { view, sessions } = page;
	const name = page.name ?? `Repository ${page.id}`;
	const info = platform.info;
	// What a secret reaches depends on the sandbox: the list is said for the one new agents here start in.
	const accountChoices = startingChoices(account.settings?.defaults ?? null, info, models.list, "account");
	const choices = layerChoices(startingChoices(view?.defaults ?? null, info, models.list), accountChoices);
	const reachProfile = info?.profiles.find((profile) => profile.id === choices.profile) ?? info?.profiles.find((profile) => profile.available) ?? info?.profiles[0] ?? null;
	const anything = view !== null && (view.saved.setup || view.saved.checks > 0 || view.saved.secrets > 0 || view.saved.network > 0 || view.defaults.profile !== null || view.defaults.model !== null || view.defaults.place || view.defaults.screenshots || view.defaults.autoApprovePlans || view.defaults.autoMergeSingles || view.approvals.length > 0);

	// Opened at a section: it is gone to once the sections stand, which is when what is saved was read. The sections
	// above it read their own lists after that and grow: it is kept in view while they do, until its person scrolls.
	const loaded = view !== null;
	const section = sectionOf(useHash());
	useEffect(() => {
		const heading = loaded && section ? document.getElementById(sectionHeading(section)) : null;
		if (!heading) return;
		const go = () => heading.scrollIntoView({ block: "start" });
		go();
		const keep = new ResizeObserver(go);
		keep.observe(document.body);
		const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
		const stop = () => {
			keep.disconnect();
			for (const event of events) removeEventListener(event, stop);
		};
		for (const event of events) addEventListener(event, stop, { passive: true });
		const timer = setTimeout(stop, 3000);
		return () => {
			clearTimeout(timer);
			stop();
		};
	}, [loaded, section]);

	return (
		<>
			{view === null ? (
				<section className="usage-section">
					{page.error ? (
						<div className="state state-error" role="alert">
							<WarnIcon size={22} />
							<h2>What is saved for this repository could not be loaded</h2>
							<p>{page.error}</p>
							<button type="button" className="button button-outline" onClick={page.reload}>
								Try again
							</button>
						</div>
					) : (
						<div className="usage-loading" aria-busy="true" aria-label="Loading what is saved for this repository">
							<span className="skeleton skeleton-title" style={{ width: "34%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
							<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						</div>
					)}
				</section>
			) : (
				<>
					{page.error ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{page.error} What is shown may be behind.</span>
						</p>
					) : null}

					<DefaultsSection
						key={generation}
						id="repo-defaults"
						lede={`A new agent on ${name} starts from these. They can still be changed when it is launched, for that agent only, and an agent that exists keeps what it was launched with.`}
						defaults={view.defaults}
						whose="repository"
						under={accountChoices}
						models={models}
						save={(change) => client.user(auth).saveRepositoryDefaults(page.id, change)}
						onSaved={(next) => page.replace({ ...view, defaults: { ...view.defaults, place: null, harness: null, machineProfile: null, placeFallback: null, ...next } })}
					/>

					<ScreenshotsSetting page={page} view={view} />
					<AutonomySettings page={page} view={view} />

					<section className="usage-section repo-saved" aria-labelledby={ids.setup}>
						<h2 className="usage-title" id={ids.setup}>
							Setup command
						</h2>
						<div className="usage-card repo-form">
							<SetupEditor key={generation} repositoryId={page.id} name={name} labelledBy={ids.setup} applies="A change applies to workspaces created after it: an agent that has one is not set up again." onSaved={page.reload} />
						</div>
					</section>

					<section className="usage-section repo-saved" aria-labelledby={ids.checks}>
						<h2 className="usage-title" id={ids.checks}>
							Checks
							{view.saved.checks > 0 ? <span className="usage-count">{view.saved.checks}</span> : null}
						</h2>
						<div className="usage-card repo-form">
							<ChecksEditor key={generation} repositoryId={page.id} name={name} labelledBy={ids.checks} onSaved={page.reload} />
						</div>
					</section>

					<section className="usage-section repo-saved" aria-labelledby="repo-environment">
						<h2 className="usage-title" id="repo-environment">
							Environment
						</h2>
						<p className="usage-lede">A prepared sandbox for {name}, rebuilt on a schedule and after pushes, run through the setup command and every check above. Sessions and work items start from it only while it passes; otherwise they start cold.</p>
						<EnvironmentSection key={generation} repositoryId={page.id} labelledBy="repo-environment" />
					</section>

					<section className="usage-section repo-saved repo-network" aria-labelledby={ids.network}>
						<h2 className="usage-title" id={ids.network}>
							Network
							{view.saved.network > 0 ? <span className="usage-count">{view.saved.network}</span> : null}
						</h2>
						<NetworkSection key={generation} repositoryId={page.id} name={name} labelledBy={ids.network} onSaved={page.reload} />
					</section>

					<section className="usage-section repo-saved" aria-labelledby="repo-secrets">
						<SecretsBlock
							key={generation}
							repositoryId={page.id}
							name={name}
							profile={reachProfile?.id ?? null}
							onChanged={page.reload}
							title={(add) => (
								<h2 className="usage-title" id="repo-secrets">
									Secrets
									{view.saved.secrets > 0 ? <span className="usage-count">{view.saved.secrets}</span> : null}
									{add}
								</h2>
							)}
						/>
						{reachProfile && view.saved.secrets > 0 ? (
							<p className="usage-note">
								What each reaches is said for {reachProfile.name}, {choices.profile === reachProfile.id ? "the sandbox new agents here start in" : "the sandbox a new agent starts in when none is chosen"}. An agent's own panel says it for the sandbox that agent has.
							</p>
						) : null}
					</section>

					<section className="usage-section repo-saved" aria-labelledby="repo-servers">
						<h2 className="usage-title" id="repo-servers">
							MCP server approvals
							{view.approvals.length > 0 ? <span className="usage-count">{view.approvals.length}</span> : null}
						</h2>
						<RepositoryApprovals repositoryId={page.id} name={name} approvals={view.approvals} forgetting={view.forgetting} now={now} onChanged={page.replace} />
					</section>

					<section className="usage-section" aria-labelledby="repo-forget">
						<h2 className="usage-title" id="repo-forget">
							Delete what is saved
						</h2>
						<p className="usage-lede">
							{anything
								? `Deletes the setup command, the checks, the network list, the secrets, the defaults (screenshots return to off) and the remembered approvals saved for ${name}, all at once. Its agents are not deleted with them.`
								: `Nothing is saved for ${name}.`}
						</p>
						{anything ? (
							<p className="repo-forget">
								<button type="button" className="button button-outline button-small" onClick={() => setForgetting(true)}>
									Delete what is saved…
								</button>
							</p>
						) : null}
					</section>

					{forgetting ? <ForgetDialog page={page} view={view} name={name} agents={ownAgents(sessions ?? []).length} items={(sessions ?? []).length - ownAgents(sessions ?? []).length} onClose={() => setForgetting(false)} onDone={() => setGeneration((count) => count + 1)} /> : null}
				</>
			)}
		</>
	);
}
