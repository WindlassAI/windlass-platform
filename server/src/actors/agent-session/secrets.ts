// Opening the session's sealed secrets and the redactor built from them.
import { snapshotsFor, config } from "../../config.js";
import { type OpenedAccountSecret, ACCOUNT_SECRET_PROJECT } from "../../account-secrets.js";
import { type OpenedSecret, openSecret, SecretRedactor, type Redactor } from "../../repo-secrets.js";
import { setupProjectOf } from "../../setup-command.js";
import { serverSealer } from "../../signin/seal.js";
import { secretsActor } from "../internal.js";
import { capabilitiesOf } from "../../sandbox/harness.js";
import { note } from "./timeline.js";
import { orNull, RECALL_WAIT_MS } from "./questions.js";
import type { Ctx, SessionMeta, HeldSecrets } from "./state.js";
import { TurnProblem } from "./common.js";

/** What clients see of the repository: all of it but the installation, which is the platform's own matter. */
// Open sealed values only in this session and keep plaintext out of metadata and timeline items.
export async function readSecrets(c: Ctx, meta: SessionMeta, turn: number | null): Promise<HeldSecrets> {
	const project = setupProjectOf(meta);
	const networkAt = Date.now();
	const sealed = await orNull(
		secretsActor(c, meta.uid, meta.sessionId).internalSessionSecrets(
			meta.sessionId,
			meta.place.kind === "hosted" ? snapshotsFor(meta.place) : config.snapshots && !!config.machines?.identity,
		),
		RECALL_WAIT_MS,
	);
	if (sealed === null) {
		throw new TurnProblem(
			`${project ? `The secrets saved for ${project.label} and for your account` : "The secrets saved for your account"} could not be read. Nothing was started, because without them the platform could not take their values out of what it shows. Try again.`,
		);
	}
	const sealer = serverSealer();
	// What could not be opened, told on the turn's timeline: now, or by the turn that takes these (`HeldSecrets.unopened`).
	const unopened: string[] = [];
	const opened: OpenedSecret[] = [];
	const closed: string[] = [];
	if (project && sealed.project === project.key) {
		for (const secret of sealed.secrets) {
			try {
				opened.push({
					name: secret.name,
					scope: secret.scope,
					value: openSecret(sealer, meta.uid, project.key, secret.name, secret.sealed),
				});
			} catch {
				closed.push(secret.name);
			}
		}
	}
	if (project && closed.length > 0) {
		console.error(
			`[wlp] secret.unreadable uid=${meta.uid} session=${meta.sessionId} project=${project.key} names=${closed.join(",")}: sealed with another key than this server's, or changed in storage`,
		);
		unopened.push(
			`${closed.length === 1 ? `The secret ${closed[0]}` : `The secrets ${closed.join(", ")}`} saved for ${project.label} could not be opened by this server, so ${closed.length === 1 ? "it is" : "they are"} not handed over. Save ${closed.length === 1 ? "it" : "them"} again under Secrets in the session's panel.`,
		);
	}
	const account: OpenedAccountSecret[] = [];
	const shut: string[] = [];
	for (const secret of sealed.account?.secrets ?? []) {
		try {
			account.push({
				name: secret.name,
				scope: secret.scope,
				value: openSecret(sealer, meta.uid, ACCOUNT_SECRET_PROJECT, secret.name, secret.sealed),
			});
		} catch {
			shut.push(secret.name);
		}
	}
	if (shut.length > 0) {
		console.error(
			`[wlp] secret.unreadable uid=${meta.uid} session=${meta.sessionId} project=${ACCOUNT_SECRET_PROJECT} names=${shut.join(",")}: sealed with another key than this server's, or changed in storage`,
		);
		unopened.push(
			`${shut.length === 1 ? `Your account's secret ${shut[0]}` : `Your account's secrets ${shut.join(", ")}`} could not be opened by this server, so ${shut.length === 1 ? "it is" : "they are"} not handed over. Save ${shut.length === 1 ? "it" : "them"} again in your settings.`,
		);
	}
	if (turn !== null) for (const text of unopened) note(c, turn, "warn", text);
	if (
		(meta.readiness || meta.origin?.role === "reviewer") &&
		(closed.length || shut.length || sealed.project !== project?.key)
	)
		throw new TurnProblem("The platform could not read all saved secrets to redact this review.");
	if (capabilitiesOf(meta.harness).events === "acp" && (closed.length || shut.length))
		throw new TurnProblem("The platform could not read all saved values to redact the harness session.");
	// Every value is taken out of what is shown, also one of the account's that a secret of the repository stands in for.
	return {
		unopened: turn === null ? unopened : [],
		requestedNames: sealed.requestedNames,
		snapshotSetup: project && sealed.project === project.key ? sealed.snapshotSetup : undefined,
		environment: project && sealed.project === project.key ? sealed.environment : undefined,
		screenshots: sealed.screenshots === true,
		opened: sealed.redactOnly ? [] : opened,
		account: sealed.redactOnly ? [] : account,
		servers: (sealed.account?.servers ?? []).map(({ name, definition, unasked }) => ({ name, definition, unasked })),
		checks: project && sealed.project === project.key ? (sealed.checks ?? []) : [],
		...(sealed.network !== undefined && {
			network: project && sealed.project === project.key ? sealed.network : [],
			networkAt,
		}),
		redactor: new SecretRedactor([...opened, ...account]),
	};
}

/** What takes the saved values of the repository and of the account out of text now: the running turn's, or one read for this once. */
export async function sessionRedactor(c: Ctx, meta: SessionMeta): Promise<Redactor> {
	const held = c.vars.turn?.secrets ?? (await readSecrets(c, meta, null));
	return held.redactor;
}
