// The public pages' one script, a file because the content security policy allows no inline script.
// A page that is also the app's (the landing, at "/") names the app's entry in <meta name="wlp-app">:
// for someone signed in, this hides the page before first paint and loads the app, which replaces it
// (web/src/main.tsx). For everyone else the page stays as it was built, and this wires its theme button.
(function () {
	var root = document.documentElement;
	var mock = /(?:^|[?&])mock=1(?:&|$)/.test(location.search);

	function signedIn() {
		// As web/src/lib/authStore.ts reads it: a token and a profile with a uid.
		try {
			var value = JSON.parse(localStorage.getItem(mock ? "wlp.auth.mock" : "wlp.auth") || "null");
			return !!value && typeof value.token === "string" && !!value.profile && typeof value.profile.uid === "string";
		} catch (e) {
			return false;
		}
	}

	// "/" (outside a field) or ⌘K / Ctrl K puts you in a static page's search (the docs') while its app is
	// still on its way; once the app has the page, its own handler does this.
	document.addEventListener("keydown", function (event) {
		if (event.defaultPrevented || event.isComposing) return;
		var chord = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "k" || event.key === "K");
		var slash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey;
		if (!chord && !slash) return;
		var target = event.target instanceof Element ? event.target : null;
		if (slash && target && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
		var field = document.querySelector("#root[data-public] input[data-docs-search]");
		if (!field || field.offsetParent === null) return;
		event.preventDefault();
		field.focus();
		field.select();
	});

	var app = document.querySelector('meta[name="wlp-app"]');
	var everyone = !!document.querySelector('meta[name="wlp-app-for"][content="everyone"]');
	if (app && (everyone || signedIn())) {
		// The landing hides itself first for someone signed in (their agents take its place); a page loaded
		// for everyone (the docs) stays visible until the app draws the same page over it.
		if (!everyone) root.setAttribute("data-signed-in", "");
		var script = document.createElement("script");
		script.type = "module";
		script.crossOrigin = "anonymous";
		script.src = app.getAttribute("content");
		document.head.appendChild(script);
		return;
	}

	function stored() {
		try {
			var value = localStorage.getItem("wlp.theme");
			return value === "light" || value === "dark" ? value : null;
		} catch (e) {
			return null;
		}
	}

	document.addEventListener("click", function (event) {
		var button = event.target instanceof Element ? event.target.closest("[data-theme-toggle]") : null;
		if (!button) return;
		var next = root.dataset.theme === "light" ? "dark" : "light";
		root.dataset.theme = next;
		try {
			localStorage.setItem("wlp.theme", next);
		} catch (e) {
			// Private mode: the choice lasts until the page is closed.
		}
	});

	// Follow the system while the visitor has not chosen, as the app does.
	try {
		matchMedia("(prefers-color-scheme: light)").addEventListener("change", function (query) {
			if (stored() === null) root.dataset.theme = query.matches ? "light" : "dark";
		});
	} catch (e) {
		// No matchMedia: the theme stays as theme.js set it.
	}
})();
