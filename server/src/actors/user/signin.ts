// All sessions for one user share this sign-in holder. It persists a refreshed credential before returning a token sealed for the caller.

import { changed as machinesChanged, logoutMachines } from "../user-machines.js";
import { type ItemsCtx, notifyProviderWaits, queueChanged } from "../user-items.js";
import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { clientError, requireService, requireUser } from "../../auth.js";
import type { ChatgptStatus, ModelList } from "../../contract.js";
import { windlassModels } from "../../sandbox/harnesses.js";
import { ModelProblem, standInModels } from "../../account-models.js";
import { providerStatuses } from "../../model-providers.js";
import type { ChatgptAccount } from "../../sandbox/api.js";
import { type SealedTokenAnswer, type SignInAnswer, problemOf, tokenSubject } from "../../signin/directory.js";
import { SignInHolder, type StoredSignIn } from "../../signin/holder.js";
import { getSignIns } from "../../signin/index.js";
import { ownerOfAccount } from "../account-email.js";
import type { UserVars } from "./state.js";

interface SignInCtx {
	client(): unknown;
	vars: UserVars;
	db: RawAccess;
	key: string[];
}

type SignInRow = { sealed: string | null; generation: number; short_noted: number };

// The save must finish before the holder hands out a refreshed token.
function signIn(c: SignInCtx): Promise<SignInHolder> {
	c.vars.signInDb = c.db;
	const vars = c.vars;
	const uid = c.key[0]!;
	const db = () => vars.signInDb as RawAccess;
	vars.signIn ??= getSignIns()
		.then(
			({ commands, sealer, hooks }) =>
				new SignInHolder({
					uid,
					commands,
					sealer,
					revoke: hooks.revoke,
					ownerOf: (account) => ownerOfAccount(c, account),
					store: {
						load: async (): Promise<StoredSignIn | null> => {
							const [row] = await db().execute<SignInRow>("SELECT sealed, generation, short_noted FROM signin WHERE id = 1");
							return row ? { sealed: row.sealed, generation: row.generation, shortNoted: row.short_noted === 1 } : null;
						},
						save: async (row) => {
							await db().execute(
								"INSERT INTO signin (id, sealed, generation, short_noted, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed, generation = excluded.generation, short_noted = excluded.short_noted, updated_at = excluded.updated_at",
								row.sealed,
								row.generation,
								row.shortNoted ? 1 : 0,
								Date.now(),
							);
						},
					},
				}),
		)
		.catch((error: unknown) => {
			vars.signIn = null;
			throw error;
		});
	return vars.signIn;
}

async function answered<T>(c: { log: { error: (entry: unknown) => void } }, step: () => Promise<T>): Promise<SignInAnswer<T>> {
	try {
		return { ok: true, value: await step() };
	} catch (error) {
		const problem = problemOf(error);
		if (problem.kind === "other") c.log.error({ msg: "a step on the user's sign-in failed", error: problem.message });
		return { ok: false, problem };
	}
}

export interface ModelsCtx extends SignInCtx {
	keepAwake<T>(promise: Promise<T>): Promise<T>;
}

// Keep the actor awake until any sign-in refreshed while listing models is saved.
export async function modelsOf(c: ModelsCtx, demo: boolean): Promise<ModelList> {
	if (demo) return standInModels("demo");
	const account = await c.vars.models.current({
		db: c.db,
		generation: async () => {
			const [row] = await c.db.execute<{ generation: number }>("SELECT generation FROM signin WHERE id = 1 AND sealed IS NOT NULL");
			return row?.generation ?? null;
		},
		list: () => c.keepAwake((async () => (await getSignIns()).commands.models(await (await signIn(c)).accessToken()))()),
	});
	return windlassModels(account, await providerStatuses(c.db));
}

export function modelInput<T>(pick: () => T, refusalCode?: "bad_input"): T {
	try {
		return pick();
	} catch (error) {
		if (error instanceof ModelProblem) throw new UserError(error.message, { code: refusalCode ?? error.code });
		throw error;
	}
}

type SignInActionCtx = ModelsCtx & ItemsCtx;

async function forgetSignIn(c: SignInActionCtx, uid: string) {
	await (await signIn(c)).logout();
	await c.vars.models.forget(c.db);
	await logoutMachines(c);
	console.log(`[wlp] sign-in.forgotten uid=${uid}`);
}

export const signinActions = {
	chatgpt: async (c: SignInActionCtx): Promise<ChatgptStatus> => {
		const profile = requireUser(c);
		try {
			const account = profile.demo ? null : await (await signIn(c)).status();
			if (!account) return { connected: false, email: null, accessExpiresAt: null };
			return { connected: true, email: account.email ?? null, accessExpiresAt: account.accessExpiresAt ?? null };
		} catch (error) {
			throw clientError(c.log, error, "The ChatGPT sign-in could not be checked.");
		}
	},
	forgetChatgpt: async (c: SignInActionCtx): Promise<void> => {
		const profile = requireUser(c);
		if (profile.demo) { await logoutMachines(c); return; }
		try {
			await forgetSignIn(c, profile.uid);
		} catch (error) {
			throw clientError(c.log, error, "The ChatGPT sign-in could not be forgotten. Try again.");
		}
	},
	models: async (c: SignInActionCtx): Promise<ModelList> => {
		const profile = requireUser(c);
		try {
			return await modelsOf(c, profile.demo);
		} catch (error) {
			throw clientError(c.log, error, "Your models could not be read. Try again.");
		}
	},
	internalAdoptSignIn: async (c: SignInActionCtx, sealed: string): Promise<SignInAnswer<null>> => {
		requireService(c);
		return answered(c, async () => {
			await (await signIn(c)).adopt(sealed);
			if (c.vars.machines.size) await machinesChanged(c);
			queueChanged(c);
			await notifyProviderWaits(c, c.vars.items.items.values(), "adopted");
			c.vars.reached = true;
			console.log(`[wlp] sign-in.adopted uid=${c.key[0]}`);
			return null;
		});
	},
	internalSignInStatus: async (c: SignInActionCtx): Promise<SignInAnswer<ChatgptAccount | null>> => {
		requireService(c);
		return answered(c, async () => (await signIn(c)).status());
	},
	internalSignOut: async (c: SignInActionCtx): Promise<SignInAnswer<null>> => {
		requireService(c);
		return answered(c, async () => {
			await forgetSignIn(c, c.key[0]!);
			return null;
		});
	},
	// Seal the token for this request's nonce after persisting any refreshed sign-in.
	internalAccessToken: async (c: SignInActionCtx, nonce: string): Promise<SealedTokenAnswer> => {
		requireService(c);
		if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { ok: false, problem: { kind: "other", message: "the request for an access token carries no nonce" } };
		try {
			const holder = await signIn(c);
			const token = await c.keepAwake(holder.accessToken());
			const { sealer } = await getSignIns();
			return { ok: true, sealed: sealer.seal("transit", tokenSubject(c.key[0]!, nonce), JSON.stringify(token)) };
		} catch (error) {
			const problem = problemOf(error);
			if (problem.kind === "other") c.log.error({ msg: "the user's access token could not be had", error: problem.message });
			return { ok: false, problem };
		}
	},
	internalModels: async (c: SignInActionCtx): Promise<ModelList> => {
		requireService(c);
		return modelsOf(c, false);
	},
};
