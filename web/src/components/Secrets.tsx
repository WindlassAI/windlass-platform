/**
 * A repository's secrets, where their user manages them: a section of a session's side panel and of
 * the repository's own page, beside the setup command (`SecretsBlock`, the same in both), and a field
 * of the launch form once a repository of the GitHub connection is chosen. All open the same dialog, in which a secret is added, its value replaced, its scope
 * changed, or it is deleted.
 *
 * A secret is a named value the platform hands to the repository's agents as an environment
 * variable. Its value goes to the server when it is saved and is never sent back: the list has
 * names, scopes and dates, and the value's field is empty whenever it is shown. What a secret reaches
 * depends on the sandbox as well as on its scope, so the list is asked for one sandbox (a profile,
 * and in a session's panel that session's own sandbox, whose Windlass may be an older one) and
 * carries, for each secret, the server's sentence about what is less than the scope says there.
 *
 * The account's secrets are managed with the same list and the same dialog, on the account's settings
 * page (`AccountSecretsBlock`). They are for MCP servers, the user's own and a project's that reads
 * one, and have a repository's two scopes without the setup command: MCP servers only, or the
 * agent's commands as well. Where a repository has a secret of the same name, its agents are handed
 * the repository's; both lists say so.
 */
import {
	MAX_ACCOUNT_SECRETS,
	MAX_SECRET_NAME_CHARS,
	MAX_SECRET_VALUE_BYTES,
	MAX_SECRETS_PER_REPOSITORY,
	MIN_SECRET_VALUE_CHARS,
	type SandboxProfileId,
	type SecretReach,
	type SecretScope,
	type SessionSummary,
} from "@contract";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { UserApi } from "../api/client";
import { absoluteTime, count, day } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";
import { WarnIcon } from "./Icons";

/** A secret as either list has it: the account's has the repositories that stand in for it. */
interface ListedSecret {
	name: string;
	updatedAt: number;
	reach: SecretReach;
	/** Who gets it. */
	scope: SecretScope;
	/** A repository's secret: the account has one of this name too, which this one stands in for. */
	account?: boolean;
	/** The account's secret: the repositories that have one of their own under this name. */
	repositories?: string[];
}

interface SecretList {
	secrets: ListedSecret[];
	profile: SandboxProfileId;
}

/**
 * Whose secrets a list is, and how they are read and changed: a repository's, as a sandbox of the
 * profile gets them (with `sessionId`, that session's own sandbox), or the account's.
 */
interface SecretsOwner {
	kind: "repository" | "account";
	/** What separates one owner's list from another's. */
	key: string;
	/** In words: "acme/harbor", or "your account". */
	name: string;
	/** How many it may keep. */
	limit: number;
	read(api: UserApi, profile: SandboxProfileId): Promise<SecretList>;
	save(api: UserApi, profile: SandboxProfileId, secret: { name: string; value?: string; scope: SecretScope }): Promise<SecretList>;
	remove(api: UserApi, profile: SandboxProfileId, name: string): Promise<SecretList>;
}

function repositoryOwner(repositoryId: number, name: string, sessionId?: string): SecretsOwner {
	return {
		kind: "repository",
		key: `repository:${repositoryId}:${sessionId ?? ""}`,
		name,
		limit: MAX_SECRETS_PER_REPOSITORY,
		read: (api, profile) => api.repositorySecrets(repositoryId, profile, sessionId),
		save: (api, profile, secret) => api.saveRepositorySecret(repositoryId, profile, secret, sessionId),
		remove: (api, profile, secretName) => api.deleteRepositorySecret(repositoryId, profile, secretName, sessionId),
	};
}

const ACCOUNT_OWNER: SecretsOwner = {
	kind: "account",
	key: "account",
	name: "your account",
	limit: MAX_ACCOUNT_SECRETS,
	read: (api, profile) => api.accountSecrets(profile),
	save: (api, profile, secret) => api.saveAccountSecret(profile, secret),
	remove: (api, profile, name) => api.deleteAccountSecret(profile, name),
};

/** What the wider scope lets in, for either owner. */
const COMMANDS_RISK = "Whatever those commands can read, a manipulated agent could send out once a command has network access, and whatever a command prints goes to the model.";

/** The two scopes, as each owner's secret has them: an account's has no setup command to go to. */
const SCOPES: Record<SecretsOwner["kind"], Array<{ scope: SecretScope; name: string; means: string }>> = {
	repository: [
		{
			scope: "setup",
			name: "Setup and MCP servers",
			means: "The repository's setup command gets it, and so do the MCP servers the repository names, where their definition reads it as ${NAME}. The commands the agent runs do not.",
		},
		{ scope: "agent", name: "Also the agent's commands", means: `The commands the agent runs get it as well. ${COMMANDS_RISK}` },
	],
	account: [
		{
			scope: "setup",
			name: "MCP servers only",
			means: "MCP servers get it where their definition reads it as ${NAME}: your own, and a project's once you have approved that server. The commands the agent runs do not. In a sandbox that does not sandbox those commands, MCP servers go without it too, and a server that reads it does not start there.",
		},
		{
			scope: "agent",
			name: "Also the agent's commands",
			means: `The commands the agent runs get it as well, so it is handed over in every sandbox, and a server that reads it starts where commands are not sandboxed too. ${COMMANDS_RISK}`,
		},
	],
};

/** What stands in for a secret of the same name, or never gets one, said under an account's scopes. */
const ACCOUNT_NEVER = "A repository's setup command never gets it. Where a repository has a secret of the same name, its agents are handed that one instead, with its scope.";

const scopeName = (scope: SecretScope, owner: SecretsOwner["kind"]) => (scope === "agent" ? "also the agent's commands" : owner === "account" ? "MCP servers only" : "setup and MCP servers");

/** When a change reaches whom. `workspace` is what the agent the panel is about has: none yet, or one that was set up already; null in the launch form. */
function applies(workspace: "none" | "made" | null, owner: SecretsOwner["kind"] = "repository"): string {
	if (owner === "account") return "A change reaches MCP servers, and the agent's commands where a secret is also for them, from each agent's next turn, also in a sandbox that exists already. A turn that is running keeps what it started with.";
	if (workspace === "none") return "A change reaches the setup command when this agent's workspace is created, with its next prompt, and MCP servers and the agent's commands from its next turn.";
	if (workspace === "made") return "A change reaches MCP servers and the agent's commands from this agent's next turn. The setup command has run in this workspace and is not run again: it gets a change when a workspace is next created.";
	return "A change reaches the setup command in workspaces created after it, and MCP servers and the agent's commands from an agent's next turn.";
}

const REMOVED =
	"The platform takes every saved value out of what it shows and keeps of an agent's work: the timeline, the output of commands, error messages. A value that a program changes before printing it, into base64 say, is not recognised.";

interface SecretsState {
	list: SecretList | null;
	error: string | null;
	set(list: SecretList): void;
}

/**
 * An owner's secrets as a sandbox of `profile` gets them: read when either changes. With `session` it
 * is that session's sandbox, and the list is read again when what is known of it changes: a sandbox
 * is made or removed, or a turn has asked its Windlass what it can be told. A null owner reads nothing.
 */
function useSecrets(owner: SecretsOwner | null, profile: SandboxProfileId | null, session?: Pick<SessionSummary, "id" | "sandbox" | "envLists">): SecretsState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [list, setList] = useState<SecretList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const sandbox = session === undefined ? "" : `${session.sandbox === "none" ? "none" : "made"}:${session.envLists ?? ""}`;
	/** What the list on show was asked for, the session's sandbox aside. */
	const shown = useRef("");
	const key = owner?.key ?? null;

	// biome-ignore lint/correctness/useExhaustiveDependencies: `sandbox` is not read here, it is what the server's answer depends on; the owner is the same while its key is
	useEffect(() => {
		// The same list said for a sandbox that changed stays on show until its new sentences are there: a dialog open over it is not closed.
		const asked = `${key}:${profile}`;
		if (shown.current !== asked) setList(null);
		shown.current = asked;
		setError(null);
		if (owner === null || profile === null) return;
		let current = true;
		owner.read(client.user(auth), profile).then(
			(next) => {
				if (current) setList(next);
			},
			(failure: unknown) => {
				if (current) setError(explain(failure));
			},
		);
		return () => {
			current = false;
		};
	}, [client, auth, explain, key, profile, sandbox]);

	const set = useCallback((next: SecretList) => {
		setList(next);
		setError(null);
	}, []);
	return { list, error, set };
}

/** Under a secret: where another one of its name is used in its place, or it is used in another's. */
function sharedName(secret: ListedSecret, owner: SecretsOwner): string | null {
	if (secret.account) return `Your account has a secret of this name too. ${owner.name}'s agents are handed this one, with its scope, and not the account's.`;
	const repositories = secret.repositories ?? [];
	if (repositories.length === 0) return null;
	const named = repositories.length <= 3 ? repositories : [...repositories.slice(0, 2), `${repositories.length - 2} more`];
	const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
	return `${list} ${repositories.length === 1 ? "has a secret" : "have secrets"} of ${repositories.length === 1 ? "its" : "their"} own under this name: ${repositories.length === 1 ? "its" : "their"} agents are handed that one, with its scope, and not this.`;
}

function Secret({ secret, owner, onChange }: { secret: ListedSecret; owner: SecretsOwner; onChange(): void }) {
	const shared = sharedName(secret, owner);
	return (
		<li className="secret">
			<p className="secret-head">
				<span className="secret-name">{secret.name}</span>
				<span className="secret-scope">{scopeName(secret.scope, owner.kind)}</span>
			</p>
			<p className="secret-foot">
				<span className="secret-when">
					changed{" "}
					<time dateTime={new Date(secret.updatedAt).toISOString()} title={absoluteTime(secret.updatedAt)}>
						{day(secret.updatedAt)}
					</time>
				</span>
				<button type="button" className="link secret-change" onClick={onChange} aria-label={`Change the secret ${secret.name}`}>
					Change…
				</button>
			</p>
			{secret.reach.note ? <p className="secret-note">{secret.reach.note}</p> : null}
			{shared ? <p className="secret-note">{shared}</p> : null}
		</li>
	);
}

function SecretList({ secrets, owner, onChange }: { secrets: ListedSecret[]; owner: SecretsOwner; onChange(name: string): void }) {
	if (secrets.length === 0) return <p className="panel-empty">No secret is saved for {owner.name}.</p>;
	return (
		<ul className="secrets" aria-label={`The secrets saved for ${owner.name}`}>
			{secrets.map((secret) => (
				<Secret key={secret.name} secret={secret} owner={owner} onChange={() => onChange(secret.name)} />
			))}
		</ul>
	);
}

/** What the dialog opens on: the list, an empty form, or the form of the secret of that name. */
type DialogView = "list" | "add" | { name: string };

interface SecretsDialogProps {
	/** Whose they are: a repository's, said for a session's sandbox where the panel is that session's, or the account's. */
	owner: SecretsOwner;
	profile: SandboxProfileId;
	secrets: ListedSecret[];
	/** Where it starts. From the list, a finished form goes back to the list; otherwise it closes the dialog. */
	start: DialogView;
	workspace: "none" | "made" | null;
	onSaved(list: SecretList): void;
	onClose(): void;
}

function SecretsDialog({ owner, profile, secrets, start, workspace, onSaved, onClose }: SecretsDialogProps) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const account = owner.kind === "account";
	const ids = { name: useId(), value: useId(), nameNote: useId(), valueNote: useId(), scope: useId() };
	const [view, setView] = useState<DialogView>(start);
	const editing = typeof view === "object" ? (secrets.find((secret) => secret.name === view.name) ?? null) : null;
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [scope, setScope] = useState<SecretScope>("setup");
	/** The value's field takes several lines: a key, a certificate. */
	const [lines, setLines] = useState(false);
	const [busy, setBusy] = useState<"saving" | "deleting" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// A form starts empty each time it is opened: a value is never carried from one secret to the next, and never prefilled.
	const viewKey = typeof view === "object" ? view.name : view;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the form is reset when another one is opened, not when the list is read again
	useEffect(() => {
		setName("");
		setValue("");
		setLines(false);
		setScope(editing?.scope ?? "setup");
		setConfirming(false);
		setError(null);
	}, [viewKey]);

	const done = (list: SecretList) => {
		onSaved(list);
		setValue("");
		if (start === "list") setView("list");
		else onClose();
	};
	const leave = () => {
		if (busy !== null) return;
		if (start === "list" && view !== "list") setView("list");
		else onClose();
	};

	const bytes = new TextEncoder().encode(value).length;
	const nameProblem = name === "" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? null : "Letters, digits and underscores only, not starting with a digit.";
	const valueProblem =
		value === ""
			? null
			: value.trim().length < MIN_SECRET_VALUE_CHARS
				? `At least ${MIN_SECRET_VALUE_CHARS} characters.`
				: bytes > MAX_SECRET_VALUE_BYTES
					? `At most ${count(MAX_SECRET_VALUE_BYTES)} bytes; this is ${count(bytes)}.`
					: null;
	const full = !editing && secrets.length >= owner.limit;
	const ready = editing ? (value !== "" ? valueProblem === null : scope !== editing.scope) : name !== "" && nameProblem === null && value !== "" && valueProblem === null && !full;

	const save = async () => {
		if (busy !== null || !ready) return;
		setBusy("saving");
		setError(null);
		try {
			done(await owner.save(client.user(auth), profile, { name: editing ? editing.name : name, scope, ...(value === "" ? {} : { value }) }));
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	};
	const remove = async () => {
		if (busy !== null || !editing) return;
		setBusy("deleting");
		setError(null);
		try {
			done(await owner.remove(client.user(auth), profile, editing.name));
		} catch (failure) {
			setError(explain(failure));
			setConfirming(false);
		} finally {
			setBusy(null);
		}
	};

	if (view === "list") {
		return (
			<Dialog
				title="Secrets"
				lede={account ? "Saved for your account · handed to MCP servers as environment variables" : `Saved for ${owner.name} · handed to its agents as environment variables`}
				onClose={onClose}
				footer={
					<>
						<button type="button" className="button button-quiet" onClick={onClose}>
							Done
						</button>
						<button type="button" className="button button-outline" onClick={() => setView("add")} disabled={secrets.length >= owner.limit}>
							Add a secret
						</button>
					</>
				}
			>
				<div className="secret-dialog">
					<SecretList secrets={secrets} owner={owner} onChange={(chosen) => setView({ name: chosen })} />
					<p className="secret-about">{applies(workspace, owner.kind)}</p>
					<p className="secret-about">
						A saved value is never shown again: it can be replaced or deleted. {account ? "An account" : "A repository"} can have {owner.limit} secrets.
					</p>
				</div>
			</Dialog>
		);
	}

	const valueField = {
		id: ids.value,
		value,
		disabled: busy !== null,
		spellCheck: false,
		autoCapitalize: "off",
		autoCorrect: "off",
		// Never filled in by the browser, and not offered to a password manager as a sign-in.
		autoComplete: "off",
		"data-1p-ignore": true,
		"data-lpignore": "true",
		"data-bwignore": true,
		"aria-describedby": ids.valueNote,
		"aria-invalid": valueProblem !== null,
	};

	return (
		<Dialog
			title={editing ? `Change ${editing.name}` : "Add a secret"}
			lede={account ? "For your account's MCP servers" : `For ${owner.name}`}
			onClose={leave}
			dismissable={busy === null}
			footer={
				confirming && editing ? (
					<>
						<span className="dialog-error secret-confirm">
							Delete {editing.name}? {account ? "MCP servers" : "Agents"} stop being handed it from {account ? "each agent's" : "their"} next turn.
						</span>
						<button type="button" className="button button-quiet" onClick={() => setConfirming(false)} disabled={busy !== null}>
							Keep it
						</button>
						<button type="button" className="button button-danger" onClick={remove} disabled={busy !== null}>
							{busy === "deleting" ? "Deleting…" : "Delete"}
						</button>
					</>
				) : (
					<>
						{editing ? (
							<button type="button" className="button button-quiet secret-delete" onClick={() => setConfirming(true)} disabled={busy !== null}>
								Delete…
							</button>
						) : null}
						<button type="button" className="button button-quiet" onClick={leave} disabled={busy !== null}>
							{start === "list" ? "Back" : "Cancel"}
						</button>
						<button type="button" className="button button-primary" onClick={save} disabled={!ready || busy !== null}>
							{busy === "saving" ? "Saving…" : editing ? "Save" : "Add secret"}
						</button>
					</>
				)
			}
		>
			<div className="secret-dialog">
				{editing ? null : (
					<div className="field">
						<label className="label" htmlFor={ids.name}>
							Name
						</label>
						<input
							id={ids.name}
							className={`input input-mono${nameProblem ? " input-invalid" : ""}`}
							type="text"
							maxLength={MAX_SECRET_NAME_CHARS}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							autoComplete="off"
							placeholder={account ? "TRACKER_TOKEN" : "NPM_TOKEN"}
							value={name}
							onChange={(event) => setName(event.target.value)}
							disabled={busy !== null}
							aria-describedby={ids.nameNote}
							aria-invalid={nameProblem !== null}
						/>
						<p className={`field-note${nameProblem ? " tone-warn" : ""}`} id={ids.nameNote}>
							{nameProblem ?? (account ? "The environment variable a server's definition reads it as: ${NAME} in its env or headers." : "The environment variable it is handed over as.")}
						</p>
					</div>
				)}
				<div className="field">
					<label className="label" htmlFor={ids.value}>
						{editing ? "New value" : "Value"} {editing ? <span className="label-optional">optional</span> : null}
					</label>
					{lines ? (
						<textarea {...valueField} className={`input input-mono textarea secret-lines${valueProblem ? " input-invalid" : ""}`} rows={4} onChange={(event) => setValue(event.target.value)} />
					) : (
						<input
							{...valueField}
							className={`input input-mono${valueProblem ? " input-invalid" : ""}`}
							type="password"
							onChange={(event) => setValue(event.target.value)}
							onPaste={(event) => {
								// A value of several lines does not fit a field of one: the field that takes them is opened with what was pasted.
								const pasted = event.clipboardData.getData("text").replace(/\r\n?/g, "\n");
								if (!pasted.replace(/\n+$/, "").includes("\n")) return;
								event.preventDefault();
								setLines(true);
								setValue(pasted);
							}}
						/>
					)}
					<p className={`field-note${valueProblem ? " tone-warn" : ""}`} id={ids.valueNote}>
						{valueProblem ??
							(editing
								? "The saved value cannot be shown. Leave this empty to keep it."
								: `${MIN_SECRET_VALUE_CHARS} characters or more, so that it can be taken out of what is shown, and at most ${count(MAX_SECRET_VALUE_BYTES)} bytes. It is not shown again once saved.`)}{" "}
						{lines ? null : (
							<button type="button" className="link" onClick={() => setLines(true)} disabled={busy !== null}>
								Several lines
							</button>
						)}
					</p>
				</div>
				<fieldset className="secret-scopes" aria-describedby={ids.scope}>
					<legend className="label">Who gets it</legend>
					{SCOPES[owner.kind].map((choice) => (
						<label key={choice.scope} className={`secret-choice${scope === choice.scope ? " secret-choice-chosen" : ""}`}>
							<input className="secret-radio" type="radio" name={ids.scope} value={choice.scope} checked={scope === choice.scope} onChange={() => setScope(choice.scope)} disabled={busy !== null} />
							<span className="secret-pick" aria-hidden="true" />
							<span className="secret-choice-text">
								<span className="secret-choice-name">{choice.name}</span>
								<span className="secret-choice-means">{choice.means}</span>
							</span>
						</label>
					))}
					<p className="field-note" id={ids.scope}>
						What a choice comes to also depends on the agent's sandbox. Where a secret reaches less than chosen here, the list says so under it.{account ? ` ${ACCOUNT_NEVER}` : ""}
					</p>
				</fieldset>
				<p className="secret-about">{REMOVED}</p>
				{full ? (
					<p className="secret-about tone-warn">
						{account ? "Your account" : "This repository"} has {owner.limit} secrets, which is the most it can have. Delete one first.
					</p>
				) : null}
				{error ? (
					<p className="callout callout-bad" role="alert">
						<WarnIcon />
						<span className="callout-text">{error}</span>
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

/**
 * The secrets of one repository, listed and changed in place, as a sandbox of `profile` gets them.
 * With `session`, one of the user's on that repository, the list is said for that session's own
 * sandbox and the sentences about when a change applies are about that agent; without, for a sandbox
 * made now. `title` draws the heading the list stands under, around the control that adds a secret.
 * `onChanged` hears of every save and delete.
 */
export function SecretsBlock({
	repositoryId,
	name,
	profile,
	session,
	title,
	onChanged,
}: {
	repositoryId: number;
	/** The repository in words. */
	name: string;
	profile: SandboxProfileId | null;
	session?: SessionSummary;
	title(add: ReactNode): ReactNode;
	onChanged?(): void;
}) {
	const sessionId = session?.id;
	const owner = useMemo(() => repositoryOwner(repositoryId, name, sessionId), [repositoryId, name, sessionId]);
	return <OwnedSecrets owner={owner} profile={profile} session={session} title={title} onChanged={onChanged} />;
}

/**
 * The account's secrets, listed and changed in place, as a sandbox of `profile` made now gets them:
 * the list and the dialog a repository's secrets have. `title` and `onChanged` as for `SecretsBlock`.
 */
export function AccountSecretsBlock({ profile, title, onChanged }: { profile: SandboxProfileId | null; title(add: ReactNode): ReactNode; onChanged?(): void }) {
	return <OwnedSecrets owner={ACCOUNT_OWNER} profile={profile} title={title} onChanged={onChanged} />;
}

function OwnedSecrets({ owner, profile, session, title, onChanged }: { owner: SecretsOwner; profile: SandboxProfileId | null; session?: SessionSummary; title(add: ReactNode): ReactNode; onChanged?(): void }) {
	const secrets = useSecrets(owner, profile, session);
	const { list, error } = secrets;
	const [open, setOpen] = useState<DialogView | null>(null);
	const workspace = session === undefined ? null : session.sandbox === "none" ? "none" : "made";
	const account = owner.kind === "account";
	const set = (next: SecretList) => {
		secrets.set(next);
		onChanged?.();
	};
	return (
		<>
			{title(
				<button type="button" className="link secret-add" onClick={() => setOpen("add")} disabled={list === null} aria-label={`Add a secret for ${owner.name}`}>
					Add…
				</button>,
			)}
			{list === null ? (
				error ? null : (
					<p className="panel-empty" aria-busy="true">
						Reading the secrets…
					</p>
				)
			) : (
				<>
					{list.secrets.length > 0 ? <p className="panel-empty secret-lede">{account ? "Environment variables for MCP servers. A saved value is not shown again." : `Environment variables for ${owner.name}'s agents. A saved value is not shown again.`}</p> : null}
					<SecretList secrets={list.secrets} owner={owner} onChange={(chosen) => setOpen({ name: chosen })} />
					<p className="panel-empty secret-applies">{applies(workspace, owner.kind)}</p>
				</>
			)}
			{error ? (
				<p className="panel-empty tone-bad secret-applies" role="alert">
					<WarnIcon size={13} /> {error}
				</p>
			) : null}
			{open !== null && list !== null && profile !== null ? createPortal(<SecretsDialog owner={owner} profile={profile} secrets={list.secrets} start={open} workspace={workspace} onSaved={set} onClose={() => setOpen(null)} />, document.body) : null}
		</>
	);
}

/** The side panel's section, for a session on a repository of the GitHub connection. */
export function SecretsSection({ summary }: { summary: SessionSummary }) {
	const repository = summary.repository ?? null;
	if (!repository) return null;
	return (
		<section className="panel-section" aria-labelledby="panel-secrets">
			<SecretsBlock
				repositoryId={repository.id}
				name={`${repository.owner}/${repository.name}`}
				profile={summary.profile}
				session={summary}
				title={(add) => (
					<h2 className="panel-title" id="panel-secrets">
						Secrets
						{add}
					</h2>
				)}
			/>
		</section>
	);
}

/** The launch form's field: what is saved for the chosen repository, and the way to the dialog. `repository` is the chosen one, in words. */
export function SecretsField({ repositoryId, repository, profile, disabled }: { repositoryId: number; repository: string; profile: SandboxProfileId | null; disabled: boolean }) {
	const owner = useMemo(() => repositoryOwner(repositoryId, repository), [repositoryId, repository]);
	const { list, error, set } = useSecrets(owner, profile);
	const [open, setOpen] = useState(false);
	const note = useId();
	const names = list?.secrets.map((secret) => secret.name) ?? [];
	const narrowed = list?.secrets.filter((secret) => secret.reach.note !== null).length ?? 0;
	return (
		<div className="field field-wide">
			<span className="label">
				Secrets <span className="label-optional">optional</span>
			</span>
			<div className="secret-field">
				<p className="secret-field-names" aria-busy={profile !== null && list === null && error === null}>
					{profile === null ? "Choose a sandbox first: what a secret reaches depends on it." : list === null ? (error ? "Not read." : "Reading…") : names.length === 0 ? `None saved for ${repository}.` : names.join(", ")}
				</p>
				<button type="button" className="button button-outline button-small" onClick={() => setOpen(true)} disabled={disabled || list === null || profile === null} aria-describedby={note}>
					Manage…
				</button>
			</div>
			<p className="field-note" id={note}>
				Environment variables for {repository}'s setup command, its MCP servers and, where you choose so, the agent's commands. They are saved for the repository at once, not with this launch.
				{narrowed > 0 ? ` In the sandbox chosen above, ${narrowed === 1 ? "one of them reaches" : `${narrowed} of them reach`} less than its scope says: the list says which, and why.` : ""}
			</p>
			{error ? (
				<p className="field-note tone-warn" role="status">
					The secrets saved for {repository} could not be read: {error}
				</p>
			) : null}
			{open && list !== null && profile !== null
				? // Outside the launch form: Enter in one of its fields must not launch an agent.
					createPortal(<SecretsDialog owner={owner} profile={profile} secrets={list.secrets} start="list" workspace={null} onSaved={set} onClose={() => setOpen(false)} />, document.body)
				: null}
		</div>
	);
}
