/** Private screenshot copies and single-object transfers. Only a checked 33-byte prefix reaches the server. */
import { randomBytes } from "node:crypto";
import { S3ObjectStore } from "../bucket/s3.js";
import { fakeBucket } from "../bucket/stand-in.js";
import type { ObjectStore } from "../bucket/store.js";
import { backupConfig, config } from "../config.js";
import type { ItemAttachment } from "../contract.js";
import { pngHeader, type ShotRequest } from "../factory/attachments.js";
import { WORKSPACE_HEAD_COMMAND } from "../github/git.js";
import type { SandboxHandle } from "./api.js";

// curl gets 25 seconds inside a 30-second sandbox step.
export const ATTACHMENT_PUT_TTL_MS = 60_000;
const STEP_TIMEOUT_MS = 30_000;

export const ATTACH_PACK = `set -eu
export PATH=/usr/bin:/bin
umask 077
top="$WLP_ATTACH_TOP"
root="$top/.wlp-shots"
n=0
while IFS= read -r name; do
  path="$WLP_ATTACH_COPY-$n.png"
  (
    refuse() { echo "refused $n $1"; exit 0; }
    [ ! -L "$top" ] && [ ! -L "$root" ] || refuse outside
    cd -P -- "$root" 2>/dev/null || refuse missing
    [ "$(pwd -P)" = "$root" ] || refuse outside
    file=\${name#.wlp-shots/}
    case "$file" in */*|"") refuse outside;; esac
    real=$(realpath -e -- "$file" 2>/dev/null) || refuse missing
    case "$real" in "$root"/*) ;; *) refuse outside;; esac
    [ ! -L "$file" ] && [ -f "$file" ] && [ ! -L "$real" ] && [ -f "$real" ] || refuse not_regular
    [ "$(stat -c %s -- "$file")" -le "$WLP_ATTACH_MAX" ] || refuse too_large
    (ulimit -f $(((WLP_ATTACH_MAX + 1023) / 1024)); cp --no-dereference -- "$file" "$path") 2>/dev/null || { rm -f -- "$path"; refuse too_large; }
    [ ! -L "$path" ] && [ -f "$path" ] || { rm -f -- "$path"; refuse not_regular; }
    size=$(stat -c %s -- "$path")
    [ "$size" -le "$WLP_ATTACH_MAX" ] || { rm -f -- "$path"; refuse too_large; }
    echo "file $n $size $(sha256sum < "$path" | cut -d' ' -f1) $path"
  )
  n=$((n+1))
done <<< "$WLP_ATTACH_FILES"`;

export const ATTACH_UPLOAD = `set -u
export PATH=/usr/bin:/bin
trap 'rm -f -- "$WLP_ATTACH_PATH"' EXIT
if [ -L "$WLP_ATTACH_PATH" ] || [ ! -f "$WLP_ATTACH_PATH" ] || [ "$(sha256sum < "$WLP_ATTACH_PATH" | cut -d' ' -f1)" != "$WLP_ATTACH_SHA" ]; then echo changed; exit 0; fi
status=$(curl -q -s -K - -H 'Content-Type: image/png' -T "$WLP_ATTACH_PATH" -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 25 2>/dev/null) || { echo "curl $?"; exit 0; }
echo "http $status"`;

export const ATTACH_CLEAN = "set -e; rm -f -- /tmp/.wlp-attach-*; echo clean";
const refused: Record<string, string> = {
	missing: "The file is missing. Save it with wlp-shot before filing.",
	outside: "The file must be inside the clone’s .wlp-shots directory.",
	not_regular: "Save a regular PNG file there instead of a directory or link.",
	get too_large() {
		return `The file exceeds the ${config.factory.attachments.bytes.toLocaleString("en-US")}-byte screenshot limit. Capture a smaller area.`;
	},
	get item() {
		return `The item has reached its limit of ${config.factory.attachments.perItem} screenshots. File the report without this image.`;
	},
	get account() {
		return `This image would exceed the account’s ${config.factory.attachments.accountBytes.toLocaleString("en-US")}-byte screenshot limit. File the report without it.`;
	},
	item_ended: "The item has ended and cannot take more screenshots.",
};

let configured: ObjectStore | null | undefined;
export function attachmentStore(): ObjectStore | null {
	if (configured !== undefined) return configured;
	if (config.sandbox === "fake") return (configured = fakeBucket());
	try {
		const { bucket } = backupConfig();
		return (configured = bucket && new S3ObjectStore(bucket));
	} catch {
		return (configured = null);
	}
}

type Owner = { by: ItemAttachment["by"]; uid: string; sessionId: string; itemId: string; key: string };
export type Reservation = { sessionId: string; itemId: string; key: string; sha256: string; bytes: number };
export type ReserveResult = { id: string; width: number; height: number; key: string; at: number } | { refused: "item" | "account" | "item_ended" };
export interface AttachmentLedger {
	internalReserveAttachment(input: Reservation): Promise<ReserveResult>;
	internalRecordAttachment(input: { id: string; width: number; height: number }): Promise<void>;
	internalReleaseAttachment(id: string): Promise<void>;
	internalSettleAttachments(input: { sessionId: string; key: string; keep: string[] }): Promise<Array<{ id: string; key: string }>>;
	internalDeleteItemAttachments(itemId: string): Promise<void>;
}

async function step(sandbox: SandboxHandle, name: string, script: string, env: Record<string, string>, signal?: AbortSignal, stdin?: string): Promise<string[]> {
	const result = await sandbox.run(script, { cwd: "/", env: { WLP_ATTACH_STEP: name, ...env }, timeoutMs: STEP_TIMEOUT_MS, signal, stdin });
	if (result.timedOut || result.aborted || result.exitCode !== 0) throw new Error("The screenshot step did not finish.");
	const lines = result.stdout.trim().split("\n");
	if (
		(name !== "pack" && lines.length !== 1) ||
		!lines.every((line) =>
			/^(?:clean|changed|http \d{3}|curl \d{1,3}|refused \d+ (?:missing|outside|not_regular|too_large)|file \d+ \d+ [a-f0-9]{64} \/tmp\/\.wlp-attach-[a-f0-9]{24}-\d+\.png)$/.test(
				line,
			),
		)
	)
		throw new Error("The screenshot step gave no usable answer.");
	return lines;
}

export async function uploadShots(
	sandbox: SandboxHandle,
	top: string,
	shots: ShotRequest[],
	owner: Owner,
	ledger: AttachmentLedger,
	store: ObjectStore,
	signal?: AbortSignal,
) {
	const screenshots: ItemAttachment[] = [];
	const problems: string[] = [];
	const files: string[] = [];
	const max = config.factory.attachments.bytes;
	const copy = "/tmp/.wlp-attach-" + randomBytes(12).toString("hex");
	const clean = () => step(sandbox, "clean", ATTACH_CLEAN, {});
	try {
		await clean();
		const headResult = await sandbox.run(WORKSPACE_HEAD_COMMAND, { cwd: top, timeoutMs: STEP_TIMEOUT_MS, signal });
		const head = headResult.stdout.trim();
		if (headResult.exitCode !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error("Cannot read the checkout.");
		const lines = await step(
			sandbox,
			"pack",
			ATTACH_PACK,
			{ WLP_ATTACH_TOP: top, WLP_ATTACH_MAX: String(max), WLP_ATTACH_FILES: shots.map((shot) => shot.file).join("\n"), WLP_ATTACH_COPY: copy },
			signal,
		);
		if (lines.length !== shots.length) throw new Error("Incomplete screenshot list.");
		for (const [i, shot] of shots.entries()) {
			const [kind, index, size, sha256, path] = (lines[i] ?? "").split(" ");
			const problem = (reason: string) => problems.push(`\`${shot.file}\`: ${reason}`);
			if (index === String(i) && kind === "refused") {
				problem(refused[size]);
				continue;
			}
			const bytes = Number(size);
			if (kind !== "file" || index !== String(i) || path !== `${copy}-${i}.png` || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > max) {
				problem("Capture a nonempty PNG within the size limit and file it again.");
				continue;
			}
			let pending: string | null = null;
			try {
				const reservation = await ledger.internalReserveAttachment({ sessionId: owner.sessionId, itemId: owner.itemId, key: owner.key, bytes, sha256 });
				if ("refused" in reservation) {
					problem(refused[reservation.refused]);
					continue;
				}
				const { id } = reservation;
				let { width, height } = reservation;
				if (!width) {
					pending = id;
					const { key, at } = reservation;
					const link = await store.linkToPut(key, { size: bytes, contentType: "image/png", ttlMs: ATTACHMENT_PUT_TTL_MS });
					// A delayed reservation reply must never hand out a link beyond the ledger's cleanup window.
					if (link.expiresAt > at + ATTACHMENT_PUT_TTL_MS + STEP_TIMEOUT_MS) throw new Error("The upload reservation is stale.");
					if (/["\\\s]/.test(link.url)) throw new Error("Unusable link.");
					const [answer] = await step(sandbox, "upload", ATTACH_UPLOAD, { WLP_ATTACH_PATH: path, WLP_ATTACH_SHA: sha256 }, signal, `url = "${link.url}"\n`);
					if (answer !== "http 200") {
						problem(answer === "changed" ? "The packed copy changed. Capture it again." : "Storage did not accept the upload. File it again.");
						continue;
					}
					if ((await store.size(key)) !== bytes) {
						problem("Storage did not confirm the file size. File it again.");
						continue;
					}
					const header = pngHeader(await store.readStart(key, 33));
					if ("problem" in header) {
						problem(`Capture a new PNG. The platform found that ${header.problem}.`);
						continue;
					}
					({ width, height } = header);
					await ledger.internalRecordAttachment({ id, width, height });
					pending = null;
				}
				const previous = screenshots.findIndex(kept => kept.id === id);
				if (previous >= 0) {
					problem(`This is the same image as ${files[previous]}. It was kept once.`);
					continue;
				}
				screenshots.push({
					id,
					by: owner.by,
					sessionId: owner.sessionId,
					head,
					width,
					height,
					bytes,
					sha256,
					caption: shot.caption,
					shows: shot.shows,
					page: shot.page,
					state: "kept",
				});
				files.push(shot.file);
			} catch {
				problem("Storage could not confirm this screenshot. File it again.");
			} finally {
				if (pending) await ledger.internalReleaseAttachment(pending).catch(() => {});
			}
		}
	} catch {
		for (const shot of shots) problems.push(`\`${shot.file}\`: The platform could not read the screenshot from this checkout. Save it and file it again.`);
	} finally {
		await clean().catch(() => {});
	}
	return { screenshots, files, problems };
}
