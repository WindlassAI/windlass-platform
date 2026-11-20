/**
 * The screenshots an agent filed with its work, on the item's page (contract.ts, `ItemAttachment`). The
 * images live in the platform's private store and reach the page only through links that work for ten
 * minutes (`UserApi.itemAttachmentLinks`): asked once when the item's view loads, asked again once when
 * an image fails to load (a link that expired, a store that hiccuped), and again before the full-size
 * view when they are about to expire. The links are never kept anywhere but in memory.
 *
 * The caption and the page are the agent's words: React text nodes only, never `InlineMarkdown`, and
 * nothing in them becomes a link.
 */
import type { ItemAttachment } from "@contract";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentLink } from "../api/client";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";

/** A link this close to its expiry is asked for again before it is used for the full-size view. */
const FRESH_MS = 60_000;

export interface ScreenshotLinks {
	/** Where an attachment's image is: undefined while the links are being asked for, null when it has none or could not be loaded. */
	src(id: string): string | null | undefined;
	/** An image did not load: the links are asked for again, once for each attachment; the second time it is given up on. */
	failed(id: string): void;
	/** Asks for the links again when one is about to expire. */
	freshen(): void;
	/** Goes up with every answer, so that an image with the same address is tried again. */
	generation: number;
}

interface LinksState {
	links: Map<string, AttachmentLink>;
	answered: boolean;
	refused: boolean;
	generation: number;
}

const EMPTY: LinksState = { links: new Map(), answered: false, refused: false, generation: 0 };

/**
 * The links of `ids` (the kept attachments, joined with commas), asked of `ask`: once when they change,
 * then as `failed` and `freshen` say. Nothing is asked while `ids` is empty. A new `ask` alone asks
 * nothing: the latest is used for the next question.
 */
export function useAttachmentLinks(ask: () => Promise<AttachmentLink[]>, ids: string, now: () => number = Date.now): ScreenshotLinks {
	const [state, setState] = useState<LinksState>(EMPTY);
	const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
	const retried = useRef(new Set<string>());
	const inFlight = useRef(false);
	const epoch = useRef(0);
	const latest = useRef(state);
	latest.current = state;
	const asker = useRef(ask);
	asker.current = ask;

	const load = useCallback(() => {
		// Two images that fail together share one question.
		if (inFlight.current) return;
		inFlight.current = true;
		const mine = epoch.current;
		asker.current().then(
			(list) => {
				if (mine !== epoch.current) return;
				inFlight.current = false;
				setState((was) => ({ links: new Map(list.map((link) => [link.id, link])), answered: true, refused: false, generation: was.generation + 1 }));
			},
			() => {
				if (mine !== epoch.current) return;
				inFlight.current = false;
				setState((was) => ({ ...was, answered: true, refused: true, generation: was.generation + 1 }));
			},
		);
	}, []);

	useEffect(() => {
		epoch.current += 1;
		inFlight.current = false;
		retried.current = new Set();
		setBroken(new Set());
		setState(EMPTY);
		if (ids !== "") load();
	}, [ids, load]);

	const failed = useCallback(
		(id: string) => {
			if (retried.current.has(id)) {
				setBroken((was) => (was.has(id) ? was : new Set([...was, id])));
				return;
			}
			retried.current.add(id);
			load();
		},
		[load],
	);

	const freshen = useCallback(() => {
		const { links, answered } = latest.current;
		if (answered && [...links.values()].some((link) => link.expiresAt - now() < FRESH_MS)) load();
	}, [load, now]);

	const src = (id: string) => {
		if (broken.has(id)) return null;
		if (!state.answered) return undefined;
		if (state.refused) return null;
		return state.links.get(id)?.url ?? null;
	};
	return { src, failed, freshen, generation: state.generation };
}

/** The links of one item's kept screenshots, asked on the person's own signed-in connection. */
export function useScreenshotLinks(itemId: string, shots: ItemAttachment[]): ScreenshotLinks {
	const { client } = useApp();
	const auth = useAuth();
	const ask = useCallback(() => client.user(auth).itemAttachmentLinks(itemId), [client, auth, itemId]);
	const ids = shots
		.filter((shot) => shot.state === "kept")
		.map((shot) => shot.id)
		.join(",");
	return useAttachmentLinks(ask, ids);
}

export const COULD_NOT_LOAD = "This screenshot could not be loaded.";

/** Said when retention removed every screenshot of the item; `days` when the deployment's retention is known. */
export function removedLine(days?: number): string {
	return days === undefined ? "The screenshots of this item were removed after it ended." : `The screenshots of this item were removed ${days} days after it ended.`;
}

function whoLine(by: ItemAttachment["by"], head: string): string {
	const at = head.slice(0, 7);
	return by === "builder" ? `Taken by the agent that made the change, in its own sandbox, at ${at}.` : `Taken by the second reviewer in its own checkout of ${at}.`;
}

/** The quiet words under a caption: "after · 1280 × 800", then the page it shows on a line of its own. */
function Meta({ shot }: { shot: ItemAttachment }) {
	return (
		<>
			<span className="item-shot-meta">
				{shot.shows ? <span className="item-shot-shows">{shot.shows}</span> : null}
				<span>
					{shot.width} × {shot.height}
				</span>
			</span>
			{shot.page ? <span className="item-shot-page">{shot.page}</span> : null}
		</>
	);
}

function Picture({ shot, links, src }: { shot: ItemAttachment; links: ScreenshotLinks; src: string }) {
	return (
		<img
			key={`${shot.id}:${links.generation}`}
			src={src}
			width={shot.width}
			height={shot.height}
			loading="lazy"
			decoding="async"
			referrerPolicy="no-referrer"
			alt={shot.caption}
			onError={() => links.failed(shot.id)}
		/>
	);
}

function Shot({ shot, links, onOpen }: { shot: ItemAttachment; links: ScreenshotLinks; onOpen(shot: ItemAttachment): void }) {
	const src = shot.state === "removed" ? null : links.src(shot.id);
	const frame = { aspectRatio: `${shot.width} / ${shot.height}` };
	return (
		<li className="item-shot">
			<figure>
				{shot.state === "removed" ? (
					<p className="item-shot-missing">This screenshot was removed.</p>
				) : src === null ? (
					<p className="item-shot-missing">{COULD_NOT_LOAD}</p>
				) : src === undefined ? (
					<span className="item-shot-frame item-shot-waiting" style={frame} aria-busy="true" aria-label="Loading the screenshot" />
				) : (
					<button type="button" className="item-shot-frame item-shot-open" onClick={() => onOpen(shot)} aria-label={`Open full size: ${shot.caption}`}>
						<Picture shot={shot} links={links} src={src} />
					</button>
				)}
				<figcaption>
					<span className="item-shot-caption">{shot.caption}</span>
					<Meta shot={shot} />
				</figcaption>
			</figure>
		</li>
	);
}

/** The full-size view: the image at its own pixel size, scrolling inside the dialog. */
function FullSize({ shot, links, onClose }: { shot: ItemAttachment; links: ScreenshotLinks; onClose(): void }) {
	const { freshen } = links;
	useEffect(freshen, [freshen]);
	const src = links.src(shot.id);
	return (
		<Dialog
			title="Screenshot"
			size="full"
			onClose={onClose}
			lede={
				<>
					<span className="item-shot-caption">{shot.caption}</span>
					<Meta shot={shot} />
				</>
			}
		>
			<div className="item-shot-full">{src ? <Picture shot={shot} links={links} src={src} /> : <p className="item-shot-missing">{src === null ? COULD_NOT_LOAD : "Loading…"}</p>}</div>
		</Dialog>
	);
}

/**
 * One author's screenshots, in the order filed, under its report. `by` and `head` say who took them and
 * at which commit. Nothing is shown when none were filed; one line when retention removed them all.
 */
export function Screenshots({ by, head, shots, links, days }: { by: ItemAttachment["by"]; head: string; shots: ItemAttachment[]; links: ScreenshotLinks; days?: number }) {
	const [open, setOpen] = useState<ItemAttachment | null>(null);
	if (shots.length === 0) return null;
	const kept = shots.some((shot) => shot.state === "kept");
	return (
		<section className="item-shots" aria-label={by === "builder" ? "Screenshots by the agent that made the change" : "Screenshots by the second reviewer"}>
			<p className="machine-label item-shots-label">Screenshots</p>
			{kept ? (
				<>
					<p className="usage-gloss">{whoLine(by, head)}</p>
					<ul className="item-shots-list">
						{shots.map((shot) => (
							<Shot key={shot.id} shot={shot} links={links} onOpen={setOpen} />
						))}
					</ul>
				</>
			) : (
				<p className="usage-gloss item-shots-removed">{removedLine(days)}</p>
			)}
			{open ? <FullSize shot={open} links={links} onClose={() => setOpen(null)} /> : null}
		</section>
	);
}
