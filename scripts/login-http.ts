import { randomBytes, randomUUID } from "node:crypto";
import type { AuthResult, LoginProvider, LoginStart } from "../server/src/contract.js";

export function loginHttp(api: string, origin = "http://localhost:5173", id: string = randomUUID()) {
	const secret = randomBytes(32).toString("base64url");
	async function post<T>(step: string, data: object, auth?: AuthResult): Promise<T> {
		const response = await fetch(api + "/platform/login/" + step, {
			method: "POST",
			headers: {
				...(step !== "demo" && { origin }),
				"content-type": "application/json",
				...(auth && { authorization: "Bearer " + auth.token }),
			},
			body: JSON.stringify({ id, secret, ...data }),
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw Object.assign(new Error(error.message ?? "Login HTTP " + response.status), {
				code: error.code,
				status: response.status,
			});
		}
		return response.json();
	}
	return {
		start: (provider: LoginProvider, auth?: AuthResult) => post<LoginStart>("start", { provider }, auth),
		finish: (callback: string, auth?: AuthResult, browserSecret = secret) =>
			post<AuthResult>("finish", { callback, secret: browserSecret }, auth),
		demo: () => post<AuthResult>("demo", {}),
	};
}
