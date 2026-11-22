import { RETENTION_PATH, retentionRequest, signSnapshot } from "./runner/snapshot-proof.js";
import { randomBytes } from "node:crypto";
import { createClient } from "rivetkit/client";
import { createGrant, isActorGone } from "./actors/internal.js";
import { assertOrigin, serviceParams } from "./auth.js";
import { config, ownEngineEndpoint } from "./config.js";
import { platformConnection } from "./platform-info.js";
import type { Registry } from "./registry.js";
import { codeDigest, digest, machineError, newPairCode, publicSpki } from "./runner-keys.js";
import { AddressBudget, clientAddress, rateLimited } from "./http-limits.js";
import { CLOCK_TOLERANCE_MS, PAIRING_TTL_MS, RUNNER_CONNECTION_PATH, RUNNER_PAIR_PATH, RUNNER_PAIR_POLL_PATH, connectionProof, parseConnectionRequest, parsePairPoll, parsePairRequest } from "./runner/control.js";

const polls = new AddressBudget(config.httpLimits.runnerPoll);
const connections = new AddressBudget(config.httpLimits.runnerConnection);

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** RivetKit has already bounded and buffered the HTTP body. Apply the smaller runner limit before parsing it. */
async function readBody(request: Request): Promise<{ value: unknown } | Response> {
	if (Number(request.headers.get("content-length")) > 4096) return json(413, { code: "body_too_large" });
	const reader = request.body?.getReader();
	if (!reader) return json(400, { code: "bad_input" });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 4096) return json(413, { code: "body_too_large" });
			chunks.push(value);
		}
		try { return { value: JSON.parse(Buffer.concat(chunks).toString()) }; }
		catch { return json(400, { code: "bad_input" }); }
	} finally { reader.releaseLock(); }
}

export async function runnerResponse(request: Request): Promise<Response> {
	if (!config.machines) return json(404, { code: "not_found" });
	try { assertOrigin({ request }); } catch { return json(403, { code: "origin_not_allowed" }); }
	if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
	const { pathname } = new URL(request.url);
	const address = clientAddress(request);
	if (pathname !== RUNNER_PAIR_PATH) {
		const budget = pathname === RUNNER_PAIR_POLL_PATH ? polls : connections;
		const admission = budget.take(address);
		if (admission) return rateLimited(admission, "This address has reached its runner request limit. Try again later.");
	}
	function refusedConnection(response: Response): Response {
		const retry = address === null && pathname === RUNNER_CONNECTION_PATH ? connections.refusal(address) : 0;
		return retry ? rateLimited(retry, "Too many refused runner connections. Try again later.") : response;
	}
	try {
		const body = await readBody(request);
		if (body instanceof Response) return refusedConnection(body);
		const client = createClient<Registry>({ endpoint: ownEngineEndpoint() });
		const params = serviceParams();
		if (pathname === RUNNER_PAIR_PATH) {
			const input = parsePairRequest(body.value);
			const publicKey = input && publicSpki(input.publicKey);
			if (!input || !publicKey) return json(400, { code: "bad_input" });
			const code = newPairCode();
			const pairing = randomBytes(32).toString("base64url");
			const pollSecret = randomBytes(32).toString("base64url");
			const expires = await client.pairingDirectory.getOrCreate(["starts"], { params }).internalStart(codeDigest(code)!, pairing, publicKey);
			if (!expires) return rateLimited(PAIRING_TTL_MS / 1000, "Too many pairings have started. Try again after the pairing codes expire.", "too_many_pairings");
			const { name, os, arch, runnerVersion } = input;
			await client.machinePairing.create([pairing], { params, input: { grant: createGrant("machinePairing", [pairing]), publicKey, details: { name, os, arch, runnerVersion }, pollHash: digest(pollSecret), expires } });
			return json(201, { code, pairing, pollSecret });
		}
		if (pathname === RUNNER_PAIR_POLL_PATH) {
			const input = parsePairPoll(body.value);
			if (!input) return json(400, { code: "bad_input" });
			try {
				const status = await client.machinePairing.get([input.pairing], { params }).internalPoll(digest(input.pollSecret));
				return json(200, status);
			} catch (error) { if (isActorGone(error)) return json(200, { state: "gone" }); throw error; }
		}
		const input = parseConnectionRequest(body.value);
		if (!input) return refusedConnection(json(400, { code: "bad_input" }));
		const now = Date.now();
		if (Math.abs(now - input.time) > CLOCK_TOLERANCE_MS) return json(403, { reason: "clock", serverTime: now });
		const { uid, machineId, signature, time } = input;
		const retention = pathname === RETENTION_PATH;
		const statement = retention ? retentionRequest(uid, machineId, time) : connectionProof(uid, machineId, time);
		const result = await client.machine.get([uid, machineId], { params }).internalConnection(statement, signature, address === null)
			.catch(error => { if (isActorGone(error)) return "unknown" as const; throw error; });
		if (result === "unknown") return refusedConnection(json(403, { reason: "unknown" }));
		if (typeof result === "object" && "retryAfter" in result) return rateLimited(result.retryAfter, "This machine has reached its connection limit. Try again later.");
		if (result !== "active") return json(410, { reason: "removed", removeSandboxes: result.removeSandboxes });
		if (retention) {
			const generations = config.snapshots ? await client.user.get([uid], { params }).internalSnapshotGenerations().catch(error => {
				if (isActorGone(error)) return []; throw error;
			}) : [];
			const proof = signSnapshot({ uid, machineId, sessionId: "maintenance" }, statement, { kind: "retain", generations });
			return proof ? json(200, { generations, proof }) : json(503, { code: "no_snapshot_key" });
		}
		const connection = await platformConnection();
		return json(200, { ...connection, endpoint: connection.endpoint ?? (config.engine.remote ? null : ownEngineEndpoint()) });
	} catch (error) {
		machineError("runner HTTP request", error);
		return json(503, { code: "connection_unavailable" });
	}
}
