/**
 * Where a floating panel goes beside its anchor: on the side asked for, flipped to the other side
 * when that has more room and the panel would not fit, shifted along the edge to stay on screen, and
 * no taller than the room it has. Pure, so that it is tested without a browser.
 */
export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "end";

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PlaceOptions {
	side: Side;
	align: Align;
	/** The gap between anchor and panel. */
	offset: number;
	/** The room kept free at the viewport's edges. */
	padding: number;
	/** The tallest the panel may be, before the room it has. */
	maxHeight?: number;
}

export interface Placement {
	x: number;
	y: number;
	side: Side;
	/** The height it may take: its own cap, or the room on its side, whichever is less. */
	maxHeight: number;
	/** The corner it grows from, for its opening motion. */
	origin: string;
}

const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));

export function place(anchor: Box, panel: { width: number; height: number }, viewport: { width: number; height: number }, options: PlaceOptions): Placement {
	const { offset, padding } = options;
	const cap = options.maxHeight ?? Number.POSITIVE_INFINITY;
	const room: Record<Side, number> = {
		bottom: viewport.height - (anchor.y + anchor.height + offset) - padding,
		top: anchor.y - offset - padding,
		right: viewport.width - (anchor.x + anchor.width + offset) - padding,
		left: anchor.x - offset - padding,
	};
	const vertical = options.side === "top" || options.side === "bottom";
	const need = vertical ? Math.min(panel.height, cap) : panel.width;
	let side = options.side;
	if (need > room[side] && room[opposite[side]] > room[side]) side = opposite[side];

	if (vertical) {
		const maxHeight = Math.max(0, Math.min(cap, room[side]));
		const height = Math.min(panel.height, maxHeight);
		const y = side === "bottom" ? anchor.y + anchor.height + offset : anchor.y - offset - height;
		const wanted = options.align === "start" ? anchor.x : anchor.x + anchor.width - panel.width;
		const x = clamp(wanted, padding, viewport.width - panel.width - padding);
		const originX = options.align === "start" ? "left" : "right";
		return { x, y, side, maxHeight, origin: `${side === "bottom" ? "top" : "bottom"} ${originX}` };
	}
	const maxHeight = Math.max(0, Math.min(cap, viewport.height - padding * 2));
	const height = Math.min(panel.height, maxHeight);
	const x = side === "right" ? anchor.x + anchor.width + offset : anchor.x - offset - panel.width;
	const wanted = options.align === "start" ? anchor.y : anchor.y + anchor.height - height;
	const y = clamp(wanted, padding, viewport.height - height - padding);
	return { x: clamp(x, padding, viewport.width - panel.width - padding), y, side, maxHeight, origin: `top ${side === "right" ? "left" : "right"}` };
}
