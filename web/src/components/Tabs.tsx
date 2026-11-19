/**
 * A row of tabs whose each is an address: the views of one page, under its head. Each tab is a link,
 * so that it opens in a new tab on a modified click and the browser's back button goes between them,
 * and it is a tab to a screen reader, with the chosen one said as selected. One tab is in the order
 * of Tab at a time, the chosen one; the arrow keys, Home and End move between them and open the one
 * they reach. The view shown goes in a `TabPanel` with the same `id`.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { linkProps, navigate, type Route } from "../lib/router";

export interface TabLink {
	key: string;
	label: ReactNode;
	route: Route;
}

const tabId = (id: string, key: string) => `${id}-tab-${key}`;
const panelId = (id: string) => `${id}-panel`;

/** `label` names the row for a screen reader; `selected` is the key of the tab whose view is shown. */
export function Tabs({ id, label, tabs, selected }: { id: string; label: string; tabs: TabLink[]; selected: string }) {
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const at = tabs.findIndex((tab) => tab.key === selected);
		const to = event.key === "ArrowRight" ? (at + 1) % tabs.length : event.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
		const tab = to === null ? undefined : tabs[to];
		if (!tab) return;
		event.preventDefault();
		document.getElementById(tabId(id, tab.key))?.focus();
		navigate(tab.route);
	};
	return (
		<div className="tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
			{tabs.map((tab) => {
				const chosen = tab.key === selected;
				return (
					<a key={tab.key} id={tabId(id, tab.key)} className="tab" role="tab" aria-selected={chosen} aria-controls={chosen ? panelId(id) : undefined} tabIndex={chosen ? 0 : -1} {...linkProps(tab.route)}>
						{tab.label}
					</a>
				);
			})}
		</div>
	);
}

/** The view of the chosen tab of the `Tabs` with the same `id`. */
export function TabPanel({ id, selected, children }: { id: string; selected: string; children: ReactNode }) {
	return (
		<div id={panelId(id)} role="tabpanel" aria-labelledby={tabId(id, selected)}>
			{children}
		</div>
	);
}
