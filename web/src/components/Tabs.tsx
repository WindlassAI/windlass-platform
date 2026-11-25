/**
 * A row of tabs whose each is an address: the views of one page, under its head. Each tab is a link,
 * so that it opens in a new tab on a modified click and the browser's back button goes between them,
 * and it is a tab to a screen reader, with the chosen one said as selected. One tab is in the order
 * of Tab at a time, the chosen one; the arrow keys, Home and End move between them and open the one
 * they reach. The view shown goes in a `TabPanel` with the same `id`.
 */
import type { KeyboardEvent, ReactNode } from "react";
import { linkProps, type Route } from "../lib/router";

export interface TabLink {
	key: string;
	label: ReactNode;
	route: Route;
}

const tabId = (id: string, key: string) => `${id}-tab-${key}`;
const panelId = (id: string) => `${id}-panel`;

export function moveBetweenTabs(event: KeyboardEvent<HTMLDivElement>) {
	const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
	const at = tabs.findIndex(tab => tab.getAttribute("aria-selected") === "true");
	let next: HTMLElement | undefined;
	switch (event.key) {
		case "ArrowRight": next = tabs[(at + 1) % tabs.length]; break;
		case "ArrowLeft": next = tabs[(at - 1 + tabs.length) % tabs.length]; break;
		case "Home": next = tabs[0]; break;
		case "End": next = tabs[tabs.length - 1]; break;
		default: return;
	}
	event.preventDefault();
	next?.focus();
	next?.click();
}

export function Tabs({ id, label, tabs, selected }: { id: string; label: string; tabs: TabLink[]; selected: string }) {
	return (
		<div className="tabs" role="tablist" aria-label={label} onKeyDown={moveBetweenTabs}>
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
