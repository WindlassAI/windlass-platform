/**
 * The web app's built files, served by the server itself where WLP_WEB_DIR names them: one deploy and
 * one address for the whole platform, and the web app and the server's routes share an origin. Nothing
 * here is per user, so any server answers, and a deployment that hosts the web app elsewhere leaves
 * WLP_WEB_DIR unset.
 *
 * The web app keeps its place in the address (`/agents/<id>`, web/src/lib/router.ts), so an address
 * that names no file and has no extension is a page of the app and gets `index.html`. Vite names the
 * files under `assets/` after their content, so those may be kept for ever; everything else is asked
 * for again each time. Source maps are built but not served: they hold the source.
 */

import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".txt": "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
};

interface Found {
	body: Buffer;
	type: string;
}

/**
 * A handler for the files under `directory`: a response for a GET or HEAD that names one of them or a
 * page of the app, and null for everything else, which the caller answers itself.
 */
export function webFiles(directory: string): (request: Request) => Promise<Response | null> {
	const root = resolve(directory);
	// The files of an image never change while it runs, so each is read once.
	const read = new Map<string, Promise<Found | null>>();

	const file = (path: string): Promise<Found | null> => {
		let found = read.get(path);
		if (found === undefined) {
			found = (async () => {
				try {
					if (!(await stat(path)).isFile()) return null;
					return { body: await readFile(path), type: TYPES[extname(path).toLowerCase()] ?? "application/octet-stream" };
				} catch {
					return null;
				}
			})();
			read.set(path, found);
		}
		return found;
	};

	return async (request) => {
		if (request.method !== "GET" && request.method !== "HEAD") return null;
		let pathname: string;
		try {
			pathname = decodeURIComponent(new URL(request.url).pathname);
		} catch {
			return null;
		}
		if (pathname.includes("\0") || pathname.endsWith(".map")) return null;
		const path = resolve(root, `.${pathname}`);
		// `resolve` has taken the `..` out: what is left must still be inside the directory.
		if (path !== root && !path.startsWith(root + sep)) return null;

		let found = path === root ? null : await file(path);
		let page = false;
		if (found === null && extname(pathname) === "") {
			found = await file(resolve(root, "index.html"));
			page = true;
		}
		if (found === null) return null;

		const immutable = !page && pathname.startsWith("/assets/");
		return new Response(request.method === "HEAD" ? null : new Uint8Array(found.body), {
			status: 200,
			headers: {
				"content-type": found.type,
				"content-length": String(found.body.length),
				"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
			},
		});
	};
}
