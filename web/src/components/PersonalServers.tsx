/**
 * The user's own MCP servers, on the account's settings page: the list, and the dialog in which one is
 * added, changed or deleted.
 *
 * A server is a name and a definition, written as Windlass's own configuration takes one server
 * (its docs/mcp.md): a command to start, with its arguments and environment, or an address to reach,
 * with its headers. The server keeps exactly what Windlass would take, so the dialog shows the
 * server's refusal with the key that is wrong.
 *
 * Windlass starts a server of its user's own configuration without asking, in every session. There
 * is no question to say what such a server gets, as there is for one a repository names, so the
 * dialog says it before the server is saved, in that question's words (`AccountSettings.serverReach`),
 * for each sandbox this deployment can run.
 *
 * A definition is stored and shown as it is written, so it is no place for a credential: the dialog
 * says to save one as a secret of the account and to read it as `${NAME}`, and points at a value that
 * looks written out.
 */
import { MAX_SERVER_NAME_CHARS, type AccountSettings, type PersonalServer } from "@contract";
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { absoluteTime, day } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";
import { WarnIcon } from "./Icons";

const EXAMPLE = `{
  "command": "tracker-mcp",
  "args": ["--stdio"],
  "env": { "TRACKER_TOKEN": "\${TRACKER_TOKEN}" }
}`;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** What the field holds, read as JSON: the definition, or why it is none yet. Null for an empty field. */
export function readDefinition(text: string): { definition: Record<string, unknown>; problem: null } | { definition: null; problem: string } | null {
	if (text.trim() === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { definition: null, problem: "This is not JSON yet: a definition is an object in braces, with its keys and texts in double quotes." };
	}
	if (!isObject(parsed)) return { definition: null, problem: "A definition is an object: a command to start, or a url to reach." };
	return { definition: parsed, problem: null };
}

/**
 * The keys of a definition's `env` and `headers` whose value looks like a credential written out: a
 * name that says so and a value that reads no variable. A hint for its user, not a rule: the server
 * saves what it is sent.
 */
export function writtenOut(definition: Record<string, unknown>): string[] {
	const found: string[] = [];
	for (const key of ["env", "headers"]) {
		const values = definition[key];
		if (!isObject(values)) continue;
		for (const [name, value] of Object.entries(values)) {
			if (typeof value === "string" && value.trim() !== "" && !value.includes("${") && /TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|CREDENTIAL/i.test(name)) found.push(`${key}.${name}`);
		}
	}
	// A user name and password in an address.
	if (typeof definition.url === "string" && /^[a-z]+:\/\/[^/@\s]+@/i.test(definition.url)) found.push("url");
	return found;
}

/** What a server of the user's own gets where it runs: one sentence where every sandbox says the same, otherwise one for each. */
function Reach({ reach, remote }: { reach: AccountSettings["serverReach"]; remote: boolean }) {
	const said = reach.map((one) => ({ name: one.name, text: remote ? one.address : one.command }));
	const same = said.every((one) => one.text === said[0]?.text);
	if (said.length === 0) return null;
	if (same) return <p>{said[0]?.text}</p>;
	return (
		<>
			{said.map((one) => (
				<p key={one.name}>
					<span className="server-ask-key">In {one.name}:</span> {one.text}
				</p>
			))}
		</>
	);
}

function ServerDialog({ settings, editing, onSaved, onClose }: { settings: AccountSettings; editing: PersonalServer | null; onSaved(next: AccountSettings): void; onClose(): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const ids = { name: useId(), nameNote: useId(), definition: useId(), definitionNote: useId(), gets: useId() };
	const [name, setName] = useState("");
	const [text, setText] = useState(() => (editing ? JSON.stringify(editing.definition, null, 2) : ""));
	const [busy, setBusy] = useState<"saving" | "deleting" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const read = readDefinition(text);
	const definition = read?.definition ?? null;
	const nameProblem = name === "" || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ? null : "Letters, digits, '_', '.' and '-' only, starting with a letter or a digit.";
	const taken = !editing && settings.servers.some((server) => server.name === name);
	const full = !editing && settings.servers.length >= settings.limits.servers;
	const bytes = new TextEncoder().encode(definition ? JSON.stringify(definition) : text).length;
	const tooLong = bytes > settings.limits.definitionBytes;
	const ready = definition !== null && !tooLong && (editing ? true : name !== "" && nameProblem === null && !taken && !full);
	const remote = definition !== null && typeof definition.url === "string";
	const spelled = definition === null ? [] : writtenOut(definition);

	const save = async () => {
		if (busy !== null || !ready || definition === null) return;
		setBusy("saving");
		setError(null);
		try {
			onSaved(await client.user(auth).savePersonalServer({ name: editing ? editing.name : name, definition, existing: editing !== null }));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(null);
		}
	};
	const remove = async () => {
		if (busy !== null || !editing) return;
		setBusy("deleting");
		setError(null);
		try {
			onSaved(await client.user(auth).deletePersonalServer(editing.name));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setConfirming(false);
			setBusy(null);
		}
	};

	return (
		<Dialog
			title={editing ? `Change ${editing.name}` : "Add an MCP server"}
			lede="For every agent of yours, whatever the repository"
			onClose={() => busy === null && onClose()}
			dismissable={busy === null}
			footer={
				confirming && editing ? (
					<>
						<span className="dialog-error secret-confirm">Delete {editing.name}? Agents stop starting it from their next turn.</span>
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
						<button type="button" className="button button-quiet" onClick={onClose} disabled={busy !== null}>
							Cancel
						</button>
						<button type="button" className="button button-primary" onClick={save} disabled={!ready || busy !== null} aria-describedby={ids.gets}>
							{busy === "saving" ? "Saving…" : editing ? "Save" : "Add server"}
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
							className={`input input-mono${nameProblem || taken ? " input-invalid" : ""}`}
							type="text"
							maxLength={MAX_SERVER_NAME_CHARS}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							autoComplete="off"
							placeholder="tracker"
							data-autofocus
							value={name}
							onChange={(event) => setName(event.target.value)}
							disabled={busy !== null}
							aria-describedby={ids.nameNote}
							aria-invalid={nameProblem !== null || taken}
						/>
						<p className={`field-note${nameProblem || taken ? " tone-warn" : ""}`} id={ids.nameNote}>
							{nameProblem ?? (taken ? `A server named ${name} is saved already. Change that one, or give this one another name.` : "What the agent calls it by, with its tools after it: tracker/create_issue.")}
						</p>
					</div>
				)}
				<div className="field">
					<label className="label" htmlFor={ids.definition}>
						Definition
					</label>
					<textarea
						id={ids.definition}
						className={`input input-mono textarea server-definition${read?.problem || tooLong ? " input-invalid" : ""}`}
						rows={6}
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						autoComplete="off"
						placeholder={EXAMPLE}
						value={text}
						onChange={(event) => setText(event.target.value)}
						disabled={busy !== null}
						aria-describedby={ids.definitionNote}
						aria-invalid={Boolean(read?.problem) || tooLong}
					/>
					<p className={`field-note${read?.problem || tooLong ? " tone-warn" : ""}`} id={ids.definitionNote}>
						{read?.problem ??
							(tooLong
								? `A definition can be at most ${settings.limits.definitionBytes.toLocaleString("en-US")} bytes long as JSON; this one is ${bytes.toLocaleString("en-US")}.`
								: "As Windlass's configuration takes one server, in JSON: a command to start, with args and env, or a url to reach, with headers. ${NAME} in a value of env or headers reads a secret of your account.")}
					</p>
				</div>
				<div className="server-ask-details" id={ids.gets}>
					<p className="label">What it gets</p>
					<p>Windlass starts it without asking, in every agent of yours, from each agent's next turn. No question is put first, as one is put for a server a repository names.</p>
					<Reach reach={settings.serverReach} remote={remote} />
					<p>Write no credential into the definition: it is stored and shown as it is written, here and in an agent's panel. Save it under Secrets below and read it as {"${NAME}"}.</p>
					{spelled.length > 0 ? (
						<p className="tone-warn" role="status">
							{spelled.length === 1 ? `${spelled[0]} looks` : `${spelled.slice(0, -1).join(", ")} and ${spelled[spelled.length - 1]} look`} written out here. If {spelled.length === 1 ? "it is" : "they are"} a credential, save {spelled.length === 1 ? "it" : "each"} as a secret and write{" "}
							{"${NAME}"} in its place.
						</p>
					) : null}
				</div>
				{full ? <p className="secret-about tone-warn">Your account keeps {settings.limits.servers} MCP servers, which is the most it can. Delete one first.</p> : null}
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

function Server({ server, onChange }: { server: PersonalServer; onChange(): void }) {
	const unset = server.reads.filter((read) => !read.saved).map((read) => read.name);
	const set = server.reads.filter((read) => read.saved).map((read) => read.name);
	const list = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
	return (
		<li className="server">
			<p className="server-head">
				<span className="server-name">{server.name}</span>
				<span className={`server-state${server.enabled ? "" : " server-state-off"}`}>{server.enabled ? (server.remote ? "reached at an address" : "started by a command") : "switched off in its definition"}</span>
			</p>
			<p className="server-subject server-subject-short">
				<span className="visually-hidden">{server.remote ? "reached at " : "started by "}</span>
				{server.subject}
			</p>
			{set.length > 0 ? <p className="server-reason">Reads {list(set)} from your account's secrets.</p> : null}
			{unset.length > 0 ? (
				<p className="server-reason tone-warn">
					Reads {list(unset)}, which no secret of your account sets: it does not start until {unset.length === 1 ? "one does" : "they are set"}, unless a repository's secret of that name does.
				</p>
			) : null}
			<p className="server-foot">
				<span className="server-held">
					changed{" "}
					<time dateTime={new Date(server.updatedAt).toISOString()} title={absoluteTime(server.updatedAt)}>
						{day(server.updatedAt)}
					</time>
				</span>
				<button type="button" className="link server-forget" onClick={onChange} aria-label={`Change the MCP server ${server.name}`}>
					Change…
				</button>
			</p>
		</li>
	);
}

/** The section of the settings page: `onChanged` is handed the settings as a save or a delete left them. */
export function PersonalServers({ settings, onChanged }: { settings: AccountSettings; onChanged(next: AccountSettings): void }) {
	const [open, setOpen] = useState<"add" | { name: string } | null>(null);
	const { servers } = settings;
	const editing = open !== null && open !== "add" ? (servers.find((server) => server.name === open.name) ?? null) : null;
	return (
		<section className="usage-section repo-saved" aria-labelledby="settings-servers">
			<h2 className="usage-title" id="settings-servers">
				MCP servers
				{servers.length > 0 ? <span className="usage-count">{servers.length}</span> : null}
				<button type="button" className="link secret-add" onClick={() => setOpen("add")} aria-label="Add an MCP server of your own">
					Add…
				</button>
			</h2>
			<p className="usage-lede">Servers of your own, which give every agent of yours their tools, whatever the repository. Windlass starts them without asking first.</p>
			{servers.length === 0 ? (
				<p className="usage-empty">No MCP server is saved for your account. A repository's own servers are named in the repository, and an agent asks before it starts one of those.</p>
			) : (
				<ul className="servers repo-approvals" aria-label="Your own MCP servers">
					{servers.map((server) => (
						<Server key={server.name} server={server} onChange={() => setOpen({ name: server.name })} />
					))}
				</ul>
			)}
			<p className="usage-note">
				A change holds from each agent's next turn, also in a sandbox that exists already; a turn that is running keeps the servers it started with. An agent's panel lists them once it has had a turn, with what Windlass says of each. An account can keep{" "}
				{settings.limits.servers}.
			</p>
			{open !== null && (open === "add" || editing !== null) ? createPortal(<ServerDialog settings={settings} editing={editing} onSaved={onChanged} onClose={() => setOpen(null)} />, document.body) : null}
		</section>
	);
}
