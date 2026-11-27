/**
 * The upgrade page (`/plans`): Free and Pro side by side, monthly or yearly, and the way to the provider's checkout.
 * A deployment without billing has no such page.
 */
import { WarnIcon } from "../components/Icons";
import { HOSTED_SIZES } from "@contract";
import { SIZE_WEIGHT } from "../../../server/src/billing/meter";
import { sizeName } from "../lib/sizes";
import { PlanCompare, useBilling } from "../components/Plan";

export function Plans() {
	const { view, error, reload } = useBilling();
	return (
		<main className="home usage repo plans">
			<header className="home-head">
				<div className="repo-head">
					<p className="eyebrow">account · plans</p>
					<h1 className="display display-small">Plans</h1>
					<p className="home-account">Plans include hosted time. Runs on your machines are free.</p>
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
					<h2>{view.exempt ? "Billing doesn't apply to this account." : "This deployment has no plans"}</h2>
					<p>Its operator sets the limits; the Usage page says what they are.</p>
				</div>
			) : (
				<section className="usage-section">
					<PlanCompare view={view} />
					<table className="usage-table">
						<caption>Hosted time per minute of use</caption>
						<thead>
							<tr>
								<th scope="col">Sandbox size</th>
								<th scope="col">Minutes counted</th>
							</tr>
						</thead>
						<tbody>
							{HOSTED_SIZES.map(size => (
								<tr key={size}>
									<th scope="row">{sizeName(size)}</th>
									<td>{SIZE_WEIGHT[size]}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="usage-note">
						Prices in US dollars, before any tax the payment page adds. You pay on the payment provider's own page; the
						platform never sees your card. Cancel at any time under Manage billing; Pro lasts to the end of the period
						you paid for, and nothing is deleted when an account moves to Free.
					</p>
				</section>
			)}
		</main>
	);
}
