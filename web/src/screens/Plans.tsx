/**
 * The upgrade page (`/plans`): Free and Pro side by side, monthly or yearly, and the way to the provider's checkout.
 * A deployment without billing has no such page.
 */
import { ArrowLeftIcon, WarnIcon } from "../components/Icons";
import { PlanCompare, useBilling } from "../components/Plan";
import { linkProps } from "../lib/router";

export function PlansCrumb() {
	return (
		<nav className="crumb" aria-label="Where you are">
			<a className="crumb-back" {...linkProps({ name: "settings" })}>
				<ArrowLeftIcon size={14} />
				<span>Settings</span>
			</a>
			<span className="crumb-sep" aria-hidden="true">
				/
			</span>
			<span className="crumb-title" aria-current="page">
				Plans
			</span>
		</nav>
	);
}

export function Plans() {
	const { view, error, reload } = useBilling();
	return (
		<main className="home usage repo plans">
			<header className="home-head">
				<div className="repo-head">
					<p className="eyebrow">account · plans</p>
					<h1 className="display display-small">Plans</h1>
					<p className="home-account">Your own machines are never metered on any plan. A plan sets what runs on the platform's hosted sandboxes, counted in hosted minutes: one minute of a standard sandbox (2 vCPU, 4 GiB), with small counting half and large twice.</p>
				</div>
			</header>
			{view === null ? (
				error ? (
					<div className="state state-error" role="alert">
						<WarnIcon size={22} />
						<h2>The plans could not be loaded</h2>
						<p>{error}</p>
						<button type="button" className="button button-outline" onClick={reload}>
							Try again
						</button>
					</div>
				) : (
					<div className="usage-loading" aria-busy="true" aria-label="Loading the plans">
						<span className="skeleton skeleton-title" style={{ width: "34%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "100%" }} />
					</div>
				)
			) : !view.enabled ? (
				<div className="state" role="status">
					<h2>This deployment has no plans</h2>
					<p>Its operator sets the limits; the Usage page says what they are.</p>
				</div>
			) : (
				<section className="usage-section">
					<PlanCompare view={view} />
					<p className="usage-note">Prices in US dollars, before any tax the payment page adds. You pay on the payment provider's own page; the platform never sees your card. Cancel at any time under Manage billing; Pro lasts to the end of the period you paid for, and nothing is deleted when an account moves to Free.</p>
				</section>
			)}
		</main>
	);
}
