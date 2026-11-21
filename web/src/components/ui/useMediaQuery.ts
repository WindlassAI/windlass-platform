/**
 * Whether a media query matches, kept up to date; and the surface a picker opens on: a popover
 * anchored to its trigger, or, on a phone, a bottom sheet.
 */
import { useEffect, useState } from "react";

const matches = (query: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

export function useMediaQuery(query: string): boolean {
	const [match, setMatch] = useState(() => matches(query));
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const list = window.matchMedia(query);
		const onChange = () => setMatch(list.matches);
		onChange();
		list.addEventListener("change", onChange);
		return () => list.removeEventListener("change", onChange);
	}, [query]);
	return match;
}

/** A phone's width: pickers become bottom sheets, the composer's controls one summary row. */
export const PHONE_QUERY = "(max-width: 640px)";

export type Surface = "popover" | "sheet";

/** Popover on a wide screen, bottom sheet on a phone. */
export function useSurface(): Surface {
	return useMediaQuery(PHONE_QUERY) ? "sheet" : "popover";
}
