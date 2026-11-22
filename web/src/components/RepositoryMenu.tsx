/**
 * The start composer's repository picker, as a menu: a filter field that searches the user's
 * repositories at GitHub a moment after each keystroke, a row per repository (private ones with a
 * lock, read-only ones said), and a submenu of each one's branches, its default marked, read when
 * it first opens. The menu's foot says what the list may be missing and links to where the GitHub
 * App is given more.
 */
import type { GithubAccount, GithubBranchList, GithubId, GithubRepository, GithubRepositoryList } from "@contract";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { relativeTime } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { BranchIcon, ExternalIcon, LockIcon, RefreshIcon, RepoIcon } from "./Icons";
import type { MenuItem, MenuSpec } from "./ui/Menu";

export interface PickedRepository {
	repository: GithubRepository;
	branch: string;
}

/** How long the field waits after a keystroke before it asks. */
const SEARCH_DELAY_MS = 220;

interface Found {
	query: string;
	list: GithubRepositoryList | null;
	error: string | null;
	loading: boolean;
}

/** The search behind the menu: asked when it opens and a moment after each keystroke. */
/** `connection` is who GitHub is connected as: a connection made while the picker is open lists again. */
export function useRepositorySearch(open: boolean, connection: string | null = null) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [query, setQuery] = useState("");
	const [found, setFound] = useState<Found>({ query: "", list: null, error: null, loading: false });
	const asked = useRef(0);
	const search = useCallback(
		(text: string, fresh = false) => {
			const mine = ++asked.current;
			setFound((current) => ({ ...current, query: text, loading: true, error: null }));
			client
				.user(auth)
				.githubRepositories(text, fresh)
				.then(
					(list) => mine === asked.current && setFound({ query: text, list, error: null, loading: false }),
					(error: unknown) => mine === asked.current && setFound({ query: text, list: null, error: explain(error), loading: false }),
				);
		},
		[client, auth, explain],
	);
	const first = useRef(true);
	useEffect(() => {
		if (!open) {
			first.current = true;
			return;
		}
		const timer = setTimeout(() => search(query.trim()), first.current ? 0 : SEARCH_DELAY_MS);
		first.current = false;
		return () => clearTimeout(timer);
	}, [open, query, search, connection]);
	useEffect(() => {
		if (!open) setQuery("");
	}, [open]);
	return { query, setQuery, found, reload: () => search(query.trim(), true) };
}

/** The branches of each repository whose submenu was opened, read once each. */
export function useBranches() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [lists, setLists] = useState<Record<string, { list: GithubBranchList | null; error: string | null }>>({});
	const asked = useRef(new Set<GithubId>());
	const want = useCallback(
		(id: GithubId) => {
			if (asked.current.has(id)) return;
			asked.current.add(id);
			client
				.user(auth)
				.githubBranches(id)
				.then(
					(list) => setLists((current) => ({ ...current, [id]: { list, error: null } })),
					(error: unknown) => {
						asked.current.delete(id);
						setLists((current) => ({ ...current, [id]: { list: null, error: explain(error) } }));
					},
				);
		},
		[client, auth, explain],
	);
	return { of: (id: GithubId) => lists[id] ?? null, want };
}

/** The repository's name, the owner quieter, with the letters the query matched marked. */
function RepositoryLabel({ repository, query }: { repository: Pick<GithubRepository, "owner" | "name">; query: string }) {
	const owner = `${repository.owner}/`;
	const full = `${owner}${repository.name}`;
	const needle = query.trim().toLowerCase();
	const from = needle === "" ? -1 : full.toLowerCase().indexOf(needle);
	const to = from < 0 ? -1 : from + needle.length;
	/** One part of the name, starting at `at` in the whole, with what of the match falls in it marked. */
	const part = (text: string, at: number) => {
		const a = Math.max(0, Math.min(text.length, from - at));
		const b = Math.max(0, Math.min(text.length, to - at));
		if (from < 0 || a === b) return text;
		return (
			<>
				{text.slice(0, a)}
				<mark className="ui-mark">{text.slice(a, b)}</mark>
				{text.slice(b)}
			</>
		);
	};
	return (
		<span className="repo-label">
			<span className="repo-label-owner">{part(owner, 0)}</span>
			{part(repository.name, owner.length)}
		</span>
	);
}

/**
 * The menu: `chosen` is checked; choosing a row takes the repository at its default branch, choosing
 * in its submenu at that branch. `footer` holds the actions the composer adds (paste an address, no
 * repository) and its note.
 */
export function repositoryMenu({ search, branches, chosen, accounts, onChoose, header, footer }: { search: ReturnType<typeof useRepositorySearch>; branches: ReturnType<typeof useBranches>; chosen: PickedRepository | null; accounts: GithubAccount[]; onChoose(picked: PickedRepository): void; header?: ReactNode; footer?: ReactNode }): MenuSpec {
	const { found, query } = search;
	const now = Date.now();
	const rows: MenuItem[] = (found.list?.repositories ?? []).map((repository) => {
		const of = branches.of(repository.id);
		const isChosen = chosen?.repository.id === repository.id;
		const branchRows: MenuItem[] =
			of?.list?.branches.map((branch) => ({
				id: branch,
				label: branch,
				icon: <BranchIcon size={13} />,
				trailing: branch === of.list?.defaultBranch ? <span className="ui-tag">default</span> : undefined,
				checked: isChosen && chosen?.branch === branch,
				onSelect: () => onChoose({ repository, branch }),
			})) ?? [];
		const facts = [repository.private ? "private" : null, repository.canPush ? null : "read only", repository.pushedAt !== null ? `pushed ${relativeTime(repository.pushedAt, now)}` : null].filter((fact) => fact !== null);
		return {
			id: String(repository.id),
			value: `${repository.owner}/${repository.name}`,
			textValue: `${repository.owner}/${repository.name}`,
			label: <RepositoryLabel repository={repository} query={query} />,
			description: facts.join(" · ") || undefined,
			icon: repository.private ? <LockIcon size={13} /> : <RepoIcon size={14} />,
			trailing: isChosen ? <span className="repo-branch-tag">{chosen?.branch}</span> : undefined,
			checked: isChosen,
			onSelect: () => onChoose({ repository, branch: isChosen && chosen ? chosen.branch : repository.defaultBranch }),
			onSubmenuOpen: () => branches.want(repository.id),
			submenu: {
				label: `Branch of ${repository.name}`,
				width: 240,
				filter: branchRows.length > 8 ? { placeholder: "Filter branches" } : undefined,
				empty: of?.error ? `The branches could not be read: ${of.error}` : of === null ? "Reading the branches…" : "No branch.",
				groups: [{ id: "branches", label: `${repository.name} · branch`, items: branchRows }],
				header: of?.list?.more ? <p className="ui-menu-note">Only the first branches are listed.</p> : undefined,
			},
		};
	});
	const state = found.error ? (
		<span className="tone-bad">
			{found.error}{" "}
			<button type="button" className="link" onClick={search.reload}>
				Try again
			</button>
		</span>
	) : found.list === null ? (
		"Reading your repositories…"
	) : found.list.incomplete ? (
		"GitHub did not answer in time, so no repository could be listed. Reload to ask again."
	) : found.query === "" ? (
		"The GitHub App can see no repository yet. Choose which ones it may see at GitHub, then reload this list."
	) : (
		`No repository matches “${found.query}”.`
	);
	return {
		label: "Repository",
		width: 340,
		maxHeight: 440,
		submenuWidth: 240,
		hints: { right: "branches" },
		filter: { placeholder: "Filter repositories…", value: query, onChange: search.setQuery, busy: found.loading },
		empty: state,
		header,
		groups: [{ id: "repositories", label: "Your repositories", note: found.list?.more ? "more match: type more of the name" : undefined, items: rows }],
		footer: (
			<>
				{footer}
				<p className="ui-menu-note repo-access">
					{found.list?.incomplete && rows.length > 0 ? "GitHub was slow to answer, so some may be missing. " : null}
					Not listed? Give the app access at GitHub:{" "}
					{accounts.map((account) => (
						<a key={account.installationId} className="link repo-access-link" href={account.manageUrl} target="_blank" rel="noreferrer">
							{account.login}
							<ExternalIcon size={11} />
						</a>
					))}
					<button type="button" className="icon-button icon-button-small repo-reload" onClick={search.reload} disabled={found.loading} aria-label="Reload the list of repositories" title="Reload">
						<RefreshIcon size={13} className={found.loading ? "spin" : undefined} />
					</button>
				</p>
			</>
		),
	};
}
