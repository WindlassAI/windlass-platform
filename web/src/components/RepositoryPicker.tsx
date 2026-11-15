/**
 * Choosing a repository of the user's GitHub connection, in the launch form: a search field whose
 * list narrows as you type, then the branch to start from, with the repository's default chosen.
 *
 * The list is a combobox in the ARIA sense: the field keeps the focus, the arrow keys move through
 * the options, Enter takes one, Escape closes the list (and only the list: the dialog stays). It
 * floats over the form, so opening it moves nothing.
 */
import type { GithubAccount, GithubBranchList, GithubRepository, GithubRepositoryList } from "@contract";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { relativeTime } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { BranchIcon, CrossIcon, ExternalIcon, LockIcon, RefreshIcon, SearchIcon, WarnIcon } from "./Icons";

export interface PickedRepository {
	repository: GithubRepository;
	branch: string;
}

/** How long the field waits after a keystroke before it asks. */
const SEARCH_DELAY_MS = 220;

function RepositoryName({ repository }: { repository: Pick<GithubRepository, "owner" | "name"> }) {
	return (
		<span className="gh-name">
			<span className="gh-owner">{repository.owner}/</span>
			<span className="gh-repo">{repository.name}</span>
		</span>
	);
}

function Visibility({ repository }: { repository: Pick<GithubRepository, "private"> }) {
	return (
		<span className="gh-visibility" title={repository.private ? "private" : "public"}>
			{repository.private ? <LockIcon size={13} /> : null}
			<span className="visually-hidden">{repository.private ? "private" : "public"}</span>
		</span>
	);
}

interface ListState {
	query: string;
	list: GithubRepositoryList | null;
	error: string | null;
	loading: boolean;
}

export function RepositoryPicker({
	value,
	onChange,
	accounts,
	disabled = false,
	inputId,
	labelledBy,
	describedBy,
}: {
	value: PickedRepository | null;
	onChange(value: PickedRepository | null): void;
	accounts: GithubAccount[];
	disabled?: boolean;
	/** The search field's id, so the form's label can name it. */
	inputId: string;
	labelledBy: string;
	describedBy?: string;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const ids = { input: inputId, list: useId(), branch: useId() };
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const [found, setFound] = useState<ListState>({ query: "", list: null, error: null, loading: false });
	const [branches, setBranches] = useState<{ list: GithubBranchList | null; error: string | null }>({ list: null, error: null });
	const root = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const listbox = useRef<HTMLUListElement>(null);
	const pop = useRef<HTMLDivElement>(null);
	const branch = useRef<HTMLSelectElement>(null);
	const asked = useRef(0);

	const search = useCallback(
		(text: string, fresh = false) => {
			const mine = ++asked.current;
			setFound((current) => ({ ...current, query: text, loading: true, error: null }));
			client
				.user(auth)
				.githubRepositories(text, fresh)
				.then(
					(list) => {
						if (mine !== asked.current) return;
						setFound({ query: text, list, error: null, loading: false });
						setActive(0);
					},
					(error: unknown) => mine === asked.current && setFound({ query: text, list: null, error: explain(error), loading: false }),
				);
		},
		[client, auth, explain],
	);

	// Asked when the list opens, and again a moment after each keystroke.
	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => search(query.trim()), found.list === null && found.error === null ? 0 : SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
		// `found` is left out on purpose: a result must not ask again.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, query, search]);

	// A click anywhere else closes the list.
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		return () => document.removeEventListener("pointerdown", onPointer);
	}, [open]);

	// Escape closes the list and leaves the dialog the form is in open. A dialog hears of Escape through its
	// own `cancel` event, not through the key: so that is where the list takes it, before the dialog does.
	useEffect(() => {
		const dialog = open ? root.current?.closest("dialog") : null;
		if (!dialog) return;
		const onCancel = (event: Event) => {
			event.preventDefault();
			event.stopImmediatePropagation();
			setOpen(false);
		};
		dialog.addEventListener("cancel", onCancel, { capture: true });
		return () => dialog.removeEventListener("cancel", onCancel, { capture: true });
	}, [open]);

	// The list opens inside a form that scrolls: all of it is brought into view.
	useEffect(() => {
		if (open) pop.current?.scrollIntoView({ block: "nearest" });
	}, [open, found.list === null]);

	// The option the keys are on stays in view.
	useEffect(() => {
		if (open) listbox.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [open, active, found.list]);

	// The branches of the repository that was chosen.
	const chosenId = value?.repository.id ?? null;
	useEffect(() => {
		if (chosenId === null) return;
		let current = true;
		setBranches({ list: null, error: null });
		client
			.user(auth)
			.githubBranches(chosenId)
			.then(
				(list) => current && setBranches({ list, error: null }),
				(error: unknown) => current && setBranches({ list: null, error: explain(error) }),
			);
		return () => {
			current = false;
		};
	}, [client, auth, chosenId, explain]);

	const options = found.list?.repositories ?? [];
	const choose = (repository: GithubRepository) => {
		onChange({ repository, branch: repository.defaultBranch });
		setOpen(false);
		setQuery("");
		// The search field is gone with the choice: the focus goes on to what comes next, the branch.
		requestAnimationFrame(() => branch.current?.focus());
	};
	const clear = () => {
		onChange(null);
		// The field appears where the chosen repository was: the focus goes there.
		requestAnimationFrame(() => input.current?.focus());
	};

	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!open) {
				setOpen(true);
				return;
			}
			if (options.length > 0) setActive((current) => (current + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
		} else if (event.key === "Enter") {
			// Never the form's submit: Enter in a search field means "this one".
			event.preventDefault();
			const option = open ? options[active] : undefined;
			if (option) choose(option);
		} else if (event.key === "Escape" && open && !root.current?.closest("dialog")) {
			// Outside a dialog the key itself closes the list; inside one, the dialog's `cancel` does (above).
			event.preventDefault();
			setOpen(false);
		}
	};

	const stale = found.loading && found.list !== null;
	const optionId = (index: number) => `${ids.list}-${index}`;

	return (
		<div className="gh-pick">
			<div className="gh-combo" ref={root}>
				{value ? (
					<div className="gh-chosen">
						<Visibility repository={value.repository} />
						<RepositoryName repository={value.repository} />
						{value.repository.canPush ? null : <span className="chip">read only</span>}
						<button type="button" className="icon-button icon-button-small gh-clear" onClick={clear} disabled={disabled} aria-label={`Choose another repository than ${value.repository.owner}/${value.repository.name}`} title="Choose another">
							<CrossIcon size={13} />
						</button>
					</div>
				) : (
					<>
						<span className="gh-search-icon" aria-hidden="true">
							{found.loading && open ? <span className="gh-spinner" /> : <SearchIcon size={14} />}
						</span>
						<input
							ref={input}
							id={ids.input}
							className="input gh-search"
							type="text"
							role="combobox"
							aria-labelledby={labelledBy}
							aria-describedby={describedBy}
							aria-expanded={open}
							aria-controls={ids.list}
							aria-autocomplete="list"
							aria-activedescendant={open && options[active] ? optionId(active) : undefined}
							autoComplete="off"
							spellCheck={false}
							placeholder="Search your repositories"
							value={query}
							disabled={disabled}
							onChange={(event) => {
								setQuery(event.target.value);
								setOpen(true);
							}}
							onFocus={() => setOpen(true)}
							onClick={() => setOpen(true)}
							onKeyDown={onKeyDown}
						/>
						{open ? (
							<div className="gh-pop" ref={pop}>
								<ul className={`gh-options${stale ? " gh-options-stale" : ""}`} id={ids.list} role="listbox" aria-labelledby={labelledBy} ref={listbox} aria-busy={found.loading}>
									{found.error ? (
										<li className="gh-pop-state tone-bad" role="alert">
											<WarnIcon size={14} />
											<span>{found.error}</span>
											<button type="button" className="link" onClick={() => search(query.trim(), true)}>
												Try again
											</button>
										</li>
									) : found.list === null ? (
										[68, 52, 60, 44].map((width) => (
											<li key={width} className="gh-option gh-option-skeleton" aria-hidden="true">
												<span className="skeleton skeleton-meta" style={{ width: `${width}%` }} />
											</li>
										))
									) : options.length === 0 ? (
										<li className="gh-pop-state">{found.query === "" ? "The GitHub App can see no repository yet. Choose which ones it may see at GitHub, then reload this list." : `No repository matches “${found.query}”.`}</li>
									) : (
										options.map((repository, index) => (
											<li
												key={repository.id}
												id={optionId(index)}
												className="gh-option"
												role="option"
												aria-selected={index === active}
												// The field keeps the focus: a press on an option must not take it.
												onPointerDown={(event) => event.preventDefault()}
												onPointerMove={() => setActive(index)}
												onClick={() => choose(repository)}
											>
												<Visibility repository={repository} />
												<RepositoryName repository={repository} />
												{repository.canPush ? null : <span className="chip">read only</span>}
												{repository.pushedAt !== null ? <span className="gh-pushed">{relativeTime(repository.pushedAt, Date.now())}</span> : null}
											</li>
										))
									)}
								</ul>
								<div className="gh-pop-foot">
									<p className="gh-pop-foot-text">
										{found.list?.more ? "More match. Type more of the name. " : null}
										Not listed? Give the app access at GitHub:{" "}
										{accounts.map((account) => (
											<a key={account.installationId} className="gh-pop-link" href={account.manageUrl} target="_blank" rel="noreferrer">
												{account.login}
												<ExternalIcon size={11} />
											</a>
										))}
									</p>
									<button type="button" className="icon-button icon-button-small gh-reload" onClick={() => search(query.trim(), true)} disabled={found.loading} aria-label="Reload the list of repositories" title="Reload">
										<RefreshIcon size={13} className={found.loading ? "spin" : undefined} />
									</button>
								</div>
							</div>
						) : null}
					</>
				)}
			</div>
			<div className="gh-branch">
				<label className="visually-hidden" htmlFor={ids.branch}>
					Branch to start from
				</label>
				<span className="gh-branch-icon" aria-hidden="true">
					<BranchIcon size={14} />
				</span>
				<select
					ref={branch}
					id={ids.branch}
					className="select gh-branch-select"
					value={value?.branch ?? ""}
					disabled={disabled || value === null}
					aria-busy={value !== null && branches.list === null && branches.error === null}
					onChange={(event) => value && onChange({ ...value, branch: event.target.value })}
					title={branches.error ?? (branches.list?.more ? "Only the first branches are listed" : undefined)}
				>
					{value === null ? (
						<option value="">branch</option>
					) : branches.list === null ? (
						// Until the list is here, the default branch is shown, and is what would be used.
						<option value={value.branch}>{value.branch}</option>
					) : (
						branches.list.branches.map((branch) => (
							<option key={branch} value={branch}>
								{branch}
								{branch === branches.list?.defaultBranch ? " (default)" : ""}
							</option>
						))
					)}
				</select>
			</div>
		</div>
	);
}
