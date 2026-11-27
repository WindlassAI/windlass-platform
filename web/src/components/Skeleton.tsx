/** A list that is loading, drawn as the rows it will show: a heading, then a title, chips and a line of facts per row, and the row's action at its end. */
export function RowsSkeleton({
	label,
	rows = 2,
	chips = 0,
	action = true,
}: {
	label: string;
	rows?: number;
	chips?: number;
	action?: boolean;
}) {
	return (
		<div aria-busy="true" aria-label={label}>
			<span className="skeleton skeleton-heading" />
			<ul className="skeleton-list">
				{Array.from({ length: rows }, (_, row) => (
					<li key={row} className="skeleton-row">
						<div>
							<span className="skeleton skeleton-title" style={{ width: `${24 - row * 5}%` }} />
							{Array.from({ length: chips }, (_, chip) => (
								<span key={chip} className="skeleton skeleton-chip" />
							))}
							<span className="skeleton-break" />
							<span className="skeleton skeleton-meta" style={{ width: `${52 - row * 9}%` }} />
						</div>
						{action ? <span className="skeleton skeleton-pill" /> : null}
					</li>
				))}
			</ul>
		</div>
	);
}
