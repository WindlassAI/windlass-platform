/**
 * The layout of the pages that keep settings (an account's, a repository's): the settings in a few
 * groups named for what one does there, each one raised card with its parts divided by hairlines,
 * and on a wide screen a list of the groups beside them that follows the scroll. A part keeps its
 * own section and heading (an h3 under the group's h2); the card only takes away the box each part
 * used to draw for itself.
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

export interface SettingsGroupLink {
	id: string;
	title: string;
	/** A short count or state beside the title in the list, in mono; nothing when it has none. */
	meta?: ReactNode;
}

/** The groups beside the page on a wide screen, and as a row of links above it on a narrow one. The one in view is marked. */
export function SettingsNav({ groups, label }: { groups: SettingsGroupLink[]; label: string }) {
	const [current, setCurrent] = useState(groups[0]?.id ?? "");
	const key = groups.map((group) => group.id).join(" ");
	useEffect(() => {
		if (typeof IntersectionObserver === "undefined") return;
		const shown = new Map<string, boolean>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) shown.set(entry.target.id, entry.isIntersecting);
				const first = groups.find((group) => shown.get(group.id));
				if (first) setCurrent(first.id);
			},
			// A group is the current one while it crosses a band a little below the top of the screen.
			{ rootMargin: "-20% 0px -60% 0px" },
		);
		for (const group of groups) {
			const node = document.getElementById(group.id);
			if (node) observer.observe(node);
		}
		return () => observer.disconnect();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);

	const go = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
		const node = document.getElementById(id);
		if (!node || event.metaKey || event.ctrlKey || event.shiftKey) return;
		event.preventDefault();
		const still = matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		node.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
		history.replaceState(history.state, "", `#${id}`);
		setCurrent(id);
	};

	return (
		<nav className="settings-nav" aria-label={label}>
			{groups.map((group) => (
				<a key={group.id} href={`#${group.id}`} className="settings-nav-link" aria-current={current === group.id ? "true" : undefined} onClick={(event) => go(event, group.id)}>
					<span>{group.title}</span>
					{group.meta ? <span className="settings-nav-meta">{group.meta}</span> : null}
				</a>
			))}
		</nav>
	);
}

/** One group: its title and a one-line lede over the card its parts share. */
export function SettingsGroup({ id, title, lede, children }: { id: string; title: string; lede?: ReactNode; children: ReactNode }) {
	return (
		<section className="settings-group" id={id} aria-labelledby={`${id}-title`}>
			<h2 className="settings-group-title" id={`${id}-title`}>
				{title}
			</h2>
			{lede ? <p className="settings-group-lede">{lede}</p> : null}
			<div className="settings-card">{children}</div>
		</section>
	);
}

/** The nav and the groups side by side. */
export function SettingsLayout({ nav, children }: { nav: ReactNode; children: ReactNode }) {
	return (
		<div className="settings-frame">
			<div className="settings-layout">
				{nav}
				<div className="settings-groups">{children}</div>
			</div>
		</div>
	);
}
