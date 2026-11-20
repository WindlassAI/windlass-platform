import { docker, IMAGE } from "../server/src/sandbox/docker.js";

/** Resolve a tag once so every container in the check runs the same image. */
export async function imageId(reference = IMAGE): Promise<string> {
	return (await docker(["image", "inspect", "--format", "{{.Id}}", reference], { check: true })).stdout.trim();
}
