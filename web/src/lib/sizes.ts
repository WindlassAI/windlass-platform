/**
 * Hosted sandbox sizes as the screens say them (`PlatformInfo.hostedSizes`): "Standard · 2 vCPU, 4 GiB", and
 * what an hour of one is estimated to cost. The allowance and an item's hosted time stay in seconds whatever
 * the size: only the cost differs.
 */
import { HOSTED_SIZE_SPECS, ITEM_HOSTED_SIZE, SESSION_HOSTED_SIZE, hostedSizeWords, type HostedSize, type HostedSizeOption } from "@contract";

/** "$0.17/h": an estimate at the provider's published prices. */
export function perHour(usdPerHour: number | null | undefined): string | null {
	if (usdPerHour === null || usdPerHour === undefined) return null;
	return `$${usdPerHour.toFixed(usdPerHour < 0.1 ? 3 : 2)}/h`;
}

/** "Standard · 2 vCPU, 4 GiB · $0.17/h". */
export function sizeLabel(option: HostedSizeOption): string {
	const price = perHour(option.usdPerHour);
	return `${hostedSizeWords(option.id)}${price ? ` · ${price}` : ""}`;
}

/** "Standard": the size's name alone. */
export function sizeName(size: HostedSize): string {
	return size[0]!.toUpperCase() + size.slice(1);
}

/** "2 vCPU, 4 GiB". */
export function sizeSpec(size: HostedSize): string {
	const spec = HOSTED_SIZE_SPECS[size];
	return `${spec.cpus} vCPU, ${spec.memoryMiB / 1024} GiB`;
}

/** What a new sandbox is made in where nothing is chosen: the saved size, else the default for agents or work items, clamped to the offered. */
export function startingSize(offered: readonly HostedSizeOption[], saved: HostedSize | null | undefined, item: boolean): HostedSize {
	const wanted = saved ?? (item ? ITEM_HOSTED_SIZE : SESSION_HOSTED_SIZE);
	const order = ["small", "standard", "large"];
	return [...offered].reverse().find((one) => order.indexOf(one.id) <= order.indexOf(wanted))?.id ?? offered[0]?.id ?? "small";
}
