// Set the theme before first paint so there is no flash of the wrong one.
(function () {
	try {
		var saved = localStorage.getItem("wlp.theme");
		var theme = saved === "light" || saved === "dark" ? saved : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
		document.documentElement.dataset.theme = theme;
	} catch (e) {
		document.documentElement.dataset.theme = "dark";
	}
})();
