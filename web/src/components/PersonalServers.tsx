/**
 * The user's own MCP servers, on the account's settings page: the list, and the dialog in which one is
 * added, changed or deleted.
 *
 * A server is a name and a definition, written as Windlass's own configuration takes one server
 * (its docs/mcp.md): a command to start, with its arguments and environment, or an address to reach,
 * with its headers. The server keeps exactly what Windlass would take, so the dialog shows the
 * server's refusal with the key that is wrong.
 *
 * The dialog takes a definition in two ways, which save the same thing. As JSON: one server's
 * definition, or a snippet as a server's README gives it, with the name around it
 * (`pastedServers`), from which the name and the definition are taken and shown. Or, for a server
 * that is reached at an address, a form: the address, and one header if it needs one
 * (`addressDefinition`).
 *
 * A server has one setting besides: its tools run without asking. The dialog says what that does,
 * what it does not, and what it risks, before it is saved.
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
import { Check } from "./ui/Check";

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

/** A server a pasted snippet names: its name there, and its definition as it was written. */
export interface PastedServer {
	name: string;
	definition: Record<string, unknown>;
}

/** The keys of one server's definition whose value is an object of the user's own keys: no server is taken to be named so. */
const OBJECT_KEYS = ["env", "headers", "tools"];

/**
 * The servers a snippet names, where it is written as a server's README gives one and not as one
 * server's definition: `{ "mcpServers": { "<name>": { ... } } }`, `{ "servers": { ... } }`, Windlass's
 * own `{ "mcp": { "servers": { ... } } }`, or `{ "<name>": { ... } }`. Null for what is one server's
 * definition, or not JSON: the field takes that as it is. What a definition found here holds is not
 * looked at: a key Windlass does not know is refused when it is saved, as in any definition.
 */
export function pastedServers(text: string): PastedServer[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(parsed) || typeof parsed.command === "string" || typeof parsed.url === "string") return null;
	const named = (servers: Record<string, unknown>): PastedServer[] => Object.entries(servers).flatMap(([name, definition]) => (isObject(definition) ? [{ name, definition }] : []));
	if (isObject(parsed.mcpServers)) return named(parsed.mcpServers);
	if (isObject(parsed.mcp) && isObject(parsed.mcp.servers)) return named(parsed.mcp.servers);
	if (isObject(parsed.servers)) return named(parsed.servers);
	// A name around a definition: every entry is something started or reached.
	const entries = Object.entries(parsed);
	const bare = entries.length > 0 && entries.every(([name, value]) => !OBJECT_KEYS.includes(name) && isObject(value) && (typeof value.command === "string" || typeof value.url === "string"));
	return bare ? named(parsed) : null;
}

/** The form for a server that is reached at an address: the address, and one header it is sent. */
export interface AddressForm {
	url: string;
	header: string;
	value: string;
}

const NO_ADDRESS: AddressForm = { url: "", header: "", value: "" };

/** The definition the form comes to, which is what the same server written as JSON would be; null while it has no address. */
export function addressDefinition(form: AddressForm): Record<string, unknown> | null {
	const url = form.url.trim();
	const header = form.header.trim();
	if (url === "") return null;
	return header === "" || form.value === "" ? { url } : { url, headers: { [header]: form.value } };
}

/** A definition as the form shows it; null for one that holds more than an address and one header, which only JSON can say. */
export function addressForm(definition: Record<string, unknown>): AddressForm | null {
	const { url, headers, ...rest } = definition;
	if (typeof url !== "string" || Object.keys(rest).length > 0) return null;
	if (headers === undefined) return { url, header: "", value: "" };
	const entries = isObject(headers) ? Object.entries(headers) : null;
	if (entries === null || entries.length > 1) return null;
	const [header, value] = entries[0] ?? ["", ""];
	return typeof value === "string" ? { url, header, value } : null;
}

/** What is wrong with the form as it stands, or null: an address Windlass can reach, and a header that is whole. */
function addressProblem(form: AddressForm): { url: string | null; header: string | null } {
	const url = form.url.trim();
	let reachable = false;
	try {
		reachable = ["http:", "https:"].includes(new URL(url).protocol);
	} catch {
		// Said below.
	}
	return {
		url: url === "" || reachable ? null : "An http or https address, in full: https://docs.example.com/mcp",
		header: (form.header.trim() === "") === (form.value === "") ? null : form.header.trim() === "" ? "The header needs a name, such as Authorization." : "The header needs a value, such as Bearer ${DOCS_TOKEN}.",
	};
}

/** What the switch does, what it risks, and what it does not do: said before it is saved. */
const UNASKED_MEANS =
	"Windlass asks before a call of an MCP tool. With this on, the platform answers for you and you are not interrupted, in every agent of yours. Nothing then stops to ask if something the agent read talks it into misusing a tool of this server, and such a tool runs outside the command sandbox, with network access.";
const UNASKED_KEEPS =
	"Each call still shows in the agent's timeline, with a line that says it was allowed for you. What the server returns stays content Windlass does not trust: the model is told so, and other things that can send data out are asked about again. Only this server as it is saved here is covered, never one a repository names, also under this name.";

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
	const ids = { name: useId(), nameNote: useId(), way: useId(), definition: useId(), definitionNote: useId(), url: useId(), urlNote: useId(), header: useId(), value: useId(), headerNote: useId(), gets: useId() };
	const [name, setName] = useState("");
	const [text, setText] = useState(() => (editing ? JSON.stringify(editing.definition, null, 2) : ""));
	// A server that is an address and one header opens in the form; anything else, and a new one, as JSON.
	const [form, setForm] = useState<AddressForm>(() => (editing ? (addressForm(editing.definition) ?? NO_ADDRESS) : NO_ADDRESS));
	const [way, setWay] = useState<"json" | "address">(() => (editing && addressForm(editing.definition) !== null ? "address" : "json"));
	const [unasked, setUnasked] = useState(editing?.unasked ?? false);
	/** The server the definition was last taken from, where a snippet named it. */
	const [taken, setTaken] = useState<string | null>(null);
	const [busy, setBusy] = useState<"saving" | "deleting" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// A snippet that names one server was taken apart as it was written into the field: what still reads as one names several, or none, and is no definition yet.
	const found = way === "json" ? pastedServers(text) : null;
	const several = found !== null;
	const read = way === "json" && !several ? readDefinition(text) : null;
	const wrong = way === "address" ? addressProblem(form) : { url: null, header: null };
	const definition = way === "address" ? (wrong.url === null && wrong.header === null ? addressDefinition(form) : null) : (read?.definition ?? null);
	const nameProblem = name === "" || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) ? null : "Letters, digits, '_', '.' and '-' only, starting with a letter or a digit.";
	const nameTaken = !editing && settings.servers.some((server) => server.name === name);
	const full = !editing && settings.servers.length >= settings.limits.servers;
	const bytes = new TextEncoder().encode(definition ? JSON.stringify(definition) : way === "json" ? text : "").length;
	const tooLong = bytes > settings.limits.definitionBytes;
	const ready = definition !== null && !tooLong && (editing ? true : name !== "" && nameProblem === null && !nameTaken && !full);
	const remote = definition !== null && typeof definition.url === "string";
	const spelled = definition === null ? [] : writtenOut(definition);
	// The form can show what the field holds when that is nothing, or an address and one header.
	const fits = text.trim() === "" ? NO_ADDRESS : read?.definition ? addressForm(read.definition) : null;

	/** One server out of a snippet: its definition goes into the field, and its name into the name's, where there is one to fill. */
	const fill = (server: PastedServer) => {
		setText(JSON.stringify(server.definition, null, 2));
		if (!editing) setName(server.name);
		setTaken(server.name);
	};
	const write = (raw: string) => {
		const servers = pastedServers(raw);
		if (servers?.length === 1 && servers[0]) fill(servers[0]);
		else {
			setText(raw);
			setTaken(null);
		}
	};
	const choose = (next: "json" | "address") => {
		if (next === way) return;
		if (next === "address") {
			if (fits === null) return;
			setForm(fits);
		} else {
			const made = addressDefinition(form);
			if (made !== null) setText(JSON.stringify(made, null, 2));
		}
		setTaken(null);
		setWay(next);
	};

	const save = async () => {
		if (busy !== null || !ready || definition === null) return;
		setBusy("saving");
		setError(null);
		try {
			onSaved(await client.user(auth).savePersonalServer({ name: editing ? editing.name : name, definition, unasked, existing: editing !== null }));
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

	const plain = { spellCheck: false, autoCapitalize: "off", autoCorrect: "off", autoComplete: "off", disabled: busy !== null };
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
							{...plain}
							id={ids.name}
							className={`input input-mono${nameProblem || nameTaken ? " input-invalid" : ""}`}
							type="text"
							maxLength={MAX_SERVER_NAME_CHARS}
							placeholder="tracker"
							data-autofocus
							value={name}
							onChange={(event) => setName(event.target.value)}
							aria-describedby={ids.nameNote}
							aria-invalid={nameProblem !== null || nameTaken}
						/>
						<p className={`field-note${nameProblem || nameTaken ? " tone-warn" : ""}`} id={ids.nameNote}>
							{nameProblem ?? (nameTaken ? `A server named ${name} is saved already. Change that one, or give this one another name.` : "What the agent calls it by, with its tools after it: tracker/create_issue.")}
						</p>
					</div>
				)}
				<fieldset className="server-ways">
					<legend className="visually-hidden">How the server is given</legend>
					{(
						[
							["json", "As JSON"],
							["address", "At an address"],
						] as const
					).map(([value, label]) => (
						<label key={value} className={`server-way${way === value ? " server-way-chosen" : ""}${value === "address" && fits === null && way === "json" ? " server-way-off" : ""}`}>
							<input className="secret-radio" type="radio" name={ids.way} value={value} checked={way === value} onChange={() => choose(value)} disabled={busy !== null || (value === "address" && fits === null && way === "json")} />
							{label}
						</label>
					))}
				</fieldset>
				{way === "address" ? (
					<>
						<div className="field">
							<label className="label" htmlFor={ids.url}>
								Address
							</label>
							<input
								{...plain}
								id={ids.url}
								className={`input input-mono${wrong.url ? " input-invalid" : ""}`}
								type="url"
								inputMode="url"
								placeholder="https://docs.example.com/mcp"
								value={form.url}
								onChange={(event) => setForm({ ...form, url: event.target.value })}
								aria-describedby={ids.urlNote}
								aria-invalid={wrong.url !== null}
							/>
							<p className={`field-note${wrong.url ? " tone-warn" : ""}`} id={ids.urlNote}>
								{wrong.url ?? "Where Windlass reaches the server. Nothing is started. A server that is started by a command, or needs more than this, is written as JSON."}
							</p>
						</div>
						<div className="field">
							<label className="label" htmlFor={ids.header}>
								Header <span className="label-optional">optional</span>
							</label>
							<div className="server-header">
								<input
									{...plain}
									id={ids.header}
									className={`input input-mono${wrong.header && form.header.trim() === "" ? " input-invalid" : ""}`}
									type="text"
									placeholder="Authorization"
									aria-label="The header's name"
									value={form.header}
									onChange={(event) => setForm({ ...form, header: event.target.value })}
									aria-describedby={ids.headerNote}
								/>
								<input
									{...plain}
									id={ids.value}
									className={`input input-mono${wrong.header && form.value === "" ? " input-invalid" : ""}`}
									type="text"
									placeholder={"Bearer ${DOCS_TOKEN}"}
									aria-label="The header's value"
									value={form.value}
									onChange={(event) => setForm({ ...form, value: event.target.value })}
									aria-describedby={ids.headerNote}
								/>
							</div>
							<p className={`field-note${wrong.header ? " tone-warn" : ""}`} id={ids.headerNote}>
								{wrong.header ?? "Sent with every request to the address. ${NAME} in its value reads a secret of your account: save the secret under Secrets, and write its name here."}
							</p>
						</div>
					</>
				) : (
					<div className="field">
						<label className="label" htmlFor={ids.definition}>
							Definition
						</label>
						<textarea
							{...plain}
							id={ids.definition}
							className={`input input-mono textarea server-definition${read?.problem || tooLong ? " input-invalid" : ""}`}
							rows={6}
							placeholder={EXAMPLE}
							value={text}
							onChange={(event) => write(event.target.value)}
							aria-describedby={ids.definitionNote}
							aria-invalid={Boolean(read?.problem) || tooLong}
						/>
						<p className={`field-note${read?.problem || tooLong ? " tone-warn" : ""}`} id={ids.definitionNote}>
							{read?.problem ??
								(tooLong
									? `A definition can be at most ${settings.limits.definitionBytes.toLocaleString("en-US")} bytes long as JSON; this one is ${bytes.toLocaleString("en-US")}.`
									: "As Windlass's configuration takes one server, in JSON: a command to start, with args and env, or a url to reach, with headers. ${NAME} in a value of env or headers reads a secret of your account. A snippet from a server's README, with mcpServers and the name around it, can be pasted as it is.")}
						</p>
						{taken !== null ? (
							<p className="field-note server-taken" role="status">
								{editing
									? taken === editing.name
										? `Taken from what you pasted: the definition of ${taken}.`
										: `Taken from what you pasted: the definition of ${taken}. This server keeps its name, ${editing.name}.`
									: `Taken from what you pasted: the server ${taken}. Its name and its definition are filled in; look them over before you add it.`}
							</p>
						) : null}
						{several ? (
							<p className="field-note tone-warn server-taken" role="status">
								{found === null || found.length === 0 ? (
									"This names no server: there is nothing in it to take."
								) : (
									<>
										This names {found.length} servers, and one is saved at a time. Take{" "}
										{found.map((server, index) => (
											<span key={server.name}>
												{index > 0 ? (index === found.length - 1 ? " or " : ", ") : ""}
												<button type="button" className="link" onClick={() => fill(server)} disabled={busy !== null}>
													{server.name}
												</button>
											</span>
										))}
										.
									</>
								)}
							</p>
						) : null}
					</div>
				)}
				<Check checked={unasked} disabled={busy !== null} onChange={(on) => setUnasked(on)}>
					<span className="check-name">Run this server's tools without asking</span>
					<span className="check-means">{UNASKED_MEANS}</span>
					<span className="check-means">{UNASKED_KEEPS}</span>
				</Check>
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
			{server.unasked ? <p className="server-reason">Its tools run without asking: the platform allows each call for you.</p> : null}
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
