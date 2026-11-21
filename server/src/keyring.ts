/** New material always uses the first entry. Readers select one entry by its public id. */
export interface RootKey { id: string; secret: Buffer }
export type Keyring = readonly [RootKey, ...RootKey[]];

export function configuredKeys(name: string, minimum: number): Keyring | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const keys: RootKey[] = [];
	for (const entry of raw.split(",")) {
		const colon = entry.indexOf(":");
		const id = entry.slice(0, colon);
		const value = entry.slice(colon + 1);
		if (colon < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || value.length < minimum) {
			throw new Error(`${name} requires id:secret entries with unique ids and secrets of at least ${minimum} characters`);
		}
		const secret = Buffer.from(value, "utf8");
		if (keys.some(key => key.id === id || key.secret.equals(secret))) throw new Error(`${name} contains a repeated id or secret`);
		keys.push({ id, secret });
	}
	return [keys[0]!, ...keys.slice(1)];
}
