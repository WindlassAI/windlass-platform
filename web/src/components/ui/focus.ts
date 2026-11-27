/** What can take focus inside a panel: the first one is focused when it opens, and Tab stays among them. */
export const FOCUSABLE =
	'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
