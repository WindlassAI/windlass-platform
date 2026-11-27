/** A shape that stands in for what is loading, shimmering (still under reduced motion). */
import type { CSSProperties } from "react";

export function Skeleton({
	width,
	height = 12,
	radius,
	className,
	style,
}: {
	width?: number | string;
	height?: number | string;
	radius?: number | string;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<span
			className={`skeleton ui-skeleton${className ? ` ${className}` : ""}`}
			aria-hidden="true"
			style={{ width, height, borderRadius: radius, ...style }}
		/>
	);
}

/** Lines of text that are loading: each a little shorter than the one before. */
export function SkeletonText({ lines = 2, width = 100 }: { lines?: number; width?: number }) {
	return (
		<span className="ui-skeleton-text" aria-hidden="true">
			{Array.from({ length: lines }, (_, line) => (
				<Skeleton key={line} width={`${Math.max(30, width - line * 18)}%`} />
			))}
		</span>
	);
}
