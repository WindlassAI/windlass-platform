import { createHash } from "node:crypto";

export const childItemId = (parent: string, version: number, key: string) =>
	"i_" + createHash("sha256").update(JSON.stringify([parent, version, key])).digest("hex").slice(0,16);
export const itemSessionId = (item: string) => "s_" + createHash("sha256").update("item\n" + item).digest("hex").slice(0,16);
