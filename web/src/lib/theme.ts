/** Dark first, light on request: the system's preference until the user picks one. */
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const KEY = "wlp.theme";

function stored(): Theme | null {
	try {
		const value = localStorage.getItem(KEY);
		return value === "dark" || value === "light" ? value : null;
	} catch {
		return null;
	}
}

const system = (): Theme =>
	typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

export function useTheme(): [Theme, () => void] {
	const [theme, setTheme] = useState<Theme>(() => stored() ?? system());

	useEffect(() => {
		document.documentElement.dataset.theme = theme;
	}, [theme]);

	// Follow the system while the user has not chosen.
	useEffect(() => {
		const query = matchMedia("(prefers-color-scheme: light)");
		const follow = () => {
			if (stored() === null) setTheme(system());
		};
		query.addEventListener("change", follow);
		return () => query.removeEventListener("change", follow);
	}, []);

	const toggle = useCallback(() => {
		setTheme(current => {
			const next = current === "dark" ? "light" : "dark";
			try {
				localStorage.setItem(KEY, next);
			} catch {
				// Private mode: the choice lasts until the page is closed.
			}
			return next;
		});
	}, []);

	return [theme, toggle];
}
