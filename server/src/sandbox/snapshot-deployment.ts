// Install a deployment identity atomically. Concurrent servers using one state directory share it.
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function snapshotDeployment(directory: string, create = true, name = "snapshot-deployment") {
	const path = join(directory, name);
	const read = () => {
		const id = readFileSync(path, "utf8").trim();
		if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("Invalid snapshot deployment identity");
		return id;
	};
	try {
		return read();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (!create) return;
	mkdirSync(directory, { recursive: true });
	const id = randomBytes(16).toString("hex");
	const temp = path + "." + id;
	writeFileSync(temp, id + "\n", { flag: "wx", mode: 0o600 });
	try {
		linkSync(temp, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		unlinkSync(temp);
	}
	return read();
}

/**
 * Scopes Git mirror slots to the deployment. Its own file: creating the snapshot identity would
 * turn on snapshot sweeps where snapshots were never enabled.
 */
export const mirrorDeployment = (directory: string) => snapshotDeployment(directory, true, "git-mirror-deployment");
