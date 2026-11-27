/** Reads the installed Windlass version once per Docker image ID. */
import { IMAGE, docker, helperFlags, runHelper, tmpName } from "./docker.js";
const probed = new Map<string, { imageId: string; version: string }>();

export async function probeImage(image: string = IMAGE): Promise<string | null> {
	const inspected = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
	if (inspected.code !== 0) return null;
	const imageId = inspected.stdout.trim();
	const known = probed.get(image);
	if (known?.imageId === imageId) return known.version;
	const name = tmpName();
	const said = await runHelper(helperFlags(name, "none"), name, ["windlass", "--version"], {
		timeoutMs: 60_000,
		image,
	});
	const version = said.code === 0 ? (/^Windlass\s+(\S+)/.exec(said.stdout.trim())?.[1] ?? null) : null;
	if (version !== null) probed.set(image, { imageId, version });
	return version;
}
