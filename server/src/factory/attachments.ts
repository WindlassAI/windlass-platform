import { crc32 } from "node:zlib";
import { CONTROL } from "../agent-publish.js";
import { checkKey } from "../bucket/store.js";
import type { Redactor } from "../repo-secrets.js";

export const ATTACHMENT_LIMITS = {
	bytes: 2 * 1024 * 1024,
	maxWidth: 3840,
	maxHeight: 8640,
	maxPixels: 16_600_000,
	perReport: 4,
	perReview: 8,
	perItem: 40,
	captionChars: 200,
	pageChars: 300,
} as const;

export function pngHeader(first: Uint8Array | null): { width: number; height: number } | { problem: string } {
	if (!first || first.length < 33) return { problem: "the PNG header is incomplete" };
	const header = Buffer.from(first.buffer, first.byteOffset, 33);
	if (!header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return { problem: "the file has no PNG signature" };
	if (header.readUInt32BE(8) !== 13 || header.toString("latin1", 12, 16) !== "IHDR") return { problem: "the first chunk must be a 13-byte IHDR" };
	const width = header.readUInt32BE(16);
	const height = header.readUInt32BE(20);
	const { maxWidth, maxHeight, maxPixels } = ATTACHMENT_LIMITS;
	if (!width || !height || width > maxWidth || height > maxHeight || width * height > maxPixels)
		return { problem: `the image is ${width}×${height}. Use at most ${maxWidth}×${maxHeight} and ${maxPixels.toLocaleString("en-US")} pixels` };
	const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
	if (!depths[header.readUInt8(25)]?.includes(header.readUInt8(24))) return { problem: "the colour type and bit depth are not a PNG combination" };
	if (header.readUInt8(26) !== 0 || header.readUInt8(27) !== 0 || header.readUInt8(28) > 1) return { problem: "the compression, filter or interlace method is invalid" };
	if (crc32(header.subarray(12, 29)) !== header.readUInt32BE(29)) return { problem: "the PNG header checksum is invalid" };
	return { width, height };
}

export type TextRedactor = Pick<Redactor, "text">;
export function textOf(value: string, redactor: TextRedactor): string {
	const masked = redactor.text(value);
	const cleaned = masked
		.replace(/\r\n?/g, "\n")
		.replace(CONTROL, "")
		.replace(/(?<![ \t])[ \t]+$/gm, "");
	return cleaned === masked ? masked : redactor.text(cleaned);
}

export interface ShotRequest {
	file: string;
	caption: string;
	shows: "before" | "after" | null;
	page: string | null;
}
export function shotRequest(given: unknown, redactor: TextRedactor = { text: (value) => value }): ShotRequest[] | { problems: string[] } {
	if (given === undefined) return [];
	if (!Array.isArray(given)) return { problems: ["screenshots must be an array."] };
	const problems: string[] = [];
	const shots: ShotRequest[] = [];
	const files = new Set<string>();
	if (given.length > ATTACHMENT_LIMITS.perReport) problems.push("File at most four screenshots per report.");
	for (const [index, entry] of given.entries()) {
		const field = `screenshots[${index}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			problems.push(`${field} must be an object.`);
			continue;
		}
		const { file, caption, shows, page } = entry;
		if (Object.keys(entry).some((k) => !["file", "caption", "shows", "page"].includes(k))) problems.push(`${field} has an unknown field.`);
		if (typeof file !== "string" || !/^\.wlp-shots\/[a-z0-9][a-z0-9._-]{0,63}\.png$/.test(file) || redactor.text(file) !== file)
			problems.push(`${field}.file must name a PNG saved by wlp-shot under .wlp-shots/.`);
		else if (files.has(file)) problems.push(`${field}.file was named twice. Name each file once.`);
		files.add(file);
		const label = typeof caption === "string" ? textOf(caption, redactor) : "";
		if (!label.trim() || label.length > ATTACHMENT_LIMITS.captionChars || (typeof caption === "string" && /[\r\n\u0085\u2028\u2029]/.test(caption)) || label.includes("\n"))
			problems.push(`${field}.caption must be one line of 1 to 200 characters.`);
		if (shows !== undefined && shows !== "before" && shows !== "after") problems.push(`${field}.shows must be before or after.`);
		const address = typeof page === "string" ? textOf(page, redactor) : null;
		if (page !== undefined && (address === null || address.length > ATTACHMENT_LIMITS.pageChars)) problems.push(`${field}.page must be text of at most 300 characters.`);
		shots.push({ file, caption: label, shows: shows ?? null, page: address });
	}
	return problems.length ? { problems } : shots;
}

export function attachmentKey(prefix: string, uid: string, item: string, id: string): string {
	for (const part of [uid, item, id]) {
		if (part.includes("/")) throw new Error("Invalid attachment key component.");
		checkKey(part);
	}
	if (prefix && !prefix.endsWith("/")) throw new Error("Invalid attachment prefix.");
	return checkKey(`${prefix}attachments/${uid}/${item}/${id}.png`);
}
