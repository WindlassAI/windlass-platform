// Runs directly with Node 22.22+ on the release host.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "https://github.com/WindlassAI/windlass-platform";
const prefix = "ghcr.io/windlassai/";
const refs = {
	runner: prefix + "windlass-runner",
	sandbox: prefix + "windlass-platform-sandbox",
	"sandbox-shots": prefix + "windlass-platform-sandbox-shots",
	claude: prefix + "windlass-platform-claude",
	opencode: prefix + "windlass-platform-opencode",
};
type Role = keyof typeof refs;
const roles = Object.keys(refs) as Role[];
const arches = ["linux/amd64", "linux/arm64"] as const;
type Entry = { ref: string; index: string; platforms: Record<string, string>; adapter?: string; cli?: string; version?: string };
type Release = { version: string; commit: string; windlass: string; signer: string; images: Record<Role, Entry> };
const digest = /^sha256:[0-9a-f]{64}$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?$/;
function assert(test: unknown, message: string): asserts test {
	if (!test) throw new Error(message);
}
function versionTag(version: string) {
	const match = semver.exec(version);
	const leadingZero = match?.[4]?.split(".").some(id => /^0\d+$/.test(id));
	assert(match && !leadingZero && version.length <= 120, "Use a Docker-tag-compatible semantic version (x.y.z, optionally with a prerelease).");
	return "runner-v" + version;
}
const identity = (version: string) => repository + "/.github/workflows/release-images.yml@refs/tags/" + versionTag(version);
const read = (path: string) => readFileSync(path, "utf8");
const output = (program: string, args: string[]) => execFileSync(program, args, { encoding: "utf8" }).trim();
function scan(path: string) {
	const bundle = read(path);
	for (const marker of ["/home/", "@gmail", "-----BEGIN", "WLP_SECRET", "onrivet", "sourceMappingURL="])
		assert(!bundle.includes(marker), `Runner bundle contains ${marker}`);
	assert(!existsSync(path + ".map"), "Runner bundle has a source map");
}
function bundlePins(path: string): Record<Role, string> {
	const pins = JSON.parse(output(process.execPath, [path, "image-pins"]));
	for (const role of Object.keys(pins)) assert(role !== "runner" && Object.hasOwn(refs, role), `Unlisted runner bundle pin: ${role}`);
	for (const role of roles.filter(role => role !== "runner")) {
		const [ref, sum, extra] = (pins[role] ?? "").split("@");
		assert(ref === refs[role] && digest.test(sum) && extra === undefined, `Missing or invalid ${role} registry pin in runner bundle`);
	}
	return pins;
}
function validate(release: Release) {
	assert(release.signer === identity(release.version), "Unexpected release signer");
	assert(/^[a-f0-9]{40}$/.test(release.commit) && /^v\d+\.\d+\.\d+/.test(release.windlass), "Invalid release revision");
	for (const role of roles) {
		const entry = release.images?.[role];
		assert(entry?.ref === refs[role] && digest.test(entry.index), `Missing or invalid ${role} index`);
		for (const platform of arches) assert(digest.test(entry.platforms?.[platform]), `Missing ${role} ${platform} manifest`);
	}
	assert(Object.keys(release.images).length === roles.length, "Unexpected images in release");
	for (const [name, value] of [["Claude adapter", release.images.claude.adapter], ["Claude CLI", release.images.claude.cli], ["OpenCode", release.images.opencode.version]]) {
		assert(typeof value === "string" && semver.test(value), `Missing or invalid ${name} version`);
	}
}
export function verifyRelease(release: Release, bundle: string, verify: (ref: string, signer: string) => void) {
	validate(release);
	const pins = bundlePins(bundle);
	for (const role of roles.filter(role => role !== "runner")) {
		const { ref, index } = release.images[role];
		assert(pins[role] === ref + "@" + index, `${role} bundle pin does not match release.json`);
	}
	for (const role of roles) {
		const pinned = release.images[role].ref + "@" + release.images[role].index;
		try { verify(pinned, release.signer); }
		catch (cause) { throw new Error(`Could not verify ${role} index ${pinned}`, { cause }); }
	}
}
function imagetools(...args: string[]) { return output("docker", ["buildx", "imagetools", ...args]); }
function createIndexes(version: string, dir: string, names: string[]) {
	const tag = versionTag(version);
	const revision = output("git", ["rev-parse", "HEAD"]);
	for (const name of names) {
		const role = name as Role;
		const ref = refs[role];
		assert(ref && role !== "runner", "Unknown sibling image " + role);
		const sources = arches.map(platform => {
			const sum = read(join(dir, role + "-" + platform.split("/")[1])).trim();
			assert(digest.test(sum), `Invalid ${role} ${platform} build digest`);
			return ref + "@" + sum;
		});
		const annotations = { source: repository, licenses: "Apache-2.0", revision, version, description: "Windlass " + role };
		const args = Object.entries(annotations).flatMap(([key, value]) => ["--annotation", `index:org.opencontainers.image.${key}=${value}`]);
		imagetools("create", ...args, "-t", ref + ":" + tag, "-t", ref + ":sha-" + revision.slice(0, 12), ...sources);
		const descriptor = imagetools("inspect", ref + ":" + tag).match(/^Digest:\s+(sha256:[0-9a-f]{64})$/m);
		assert(descriptor, "Could not read pushed index digest for " + role);
		writeFileSync(process.env.GITHUB_OUTPUT!, role + "=" + descriptor[1] + "\n", { flag: "a" });
	}
}
function makeRelease(version: string, sums: Record<Role, string>): Release {
	const images = {} as Record<Role, Entry>;
	for (const role of roles) {
		const ref = refs[role];
		const index = sums[role];
		assert(digest.test(index), "Invalid published digest for " + role);
		const raw = JSON.parse(imagetools("inspect", "--raw", ref + "@" + index));
		const platforms: Record<string, string> = {};
		// BuildKit attestation descriptors are unknown/unknown. Record only runnable manifests.
		for (const platform of arches) {
			const matches = raw.manifests.filter((m: {platform?: {os: string; architecture: string}}) => m.platform?.os + "/" + m.platform?.architecture === platform);
			assert(matches.length === 1 && digest.test(matches[0].digest), `Expected one ${role} manifest for ${platform}`);
			platforms[platform] = matches[0].digest;
		}
		images[role] = { ref, index, platforms };
	}
	const capture = (file: string, pattern: RegExp) => {
		const match = read(file).match(pattern);
		assert(match, "Missing pinned version in " + file);
		return match[1]!;
	};
	images.claude.adapter = JSON.parse(read("sandbox/harness/claude/package.json")).dependencies["@agentclientprotocol/claude-agent-acp"];
	images.claude.cli = capture("sandbox/harness/claude/Dockerfile", /--cli --version\)" = '(\d+\.\d+\.\d+) /);
	images.opencode.version = capture("sandbox/harness/opencode/Dockerfile", /opencode --version\)" = (\d+\.\d+\.\d+)/);
	const windlass = capture("sandbox/fetch-windlass.sh", /^RELEASE=(\S+)$/m);
	const release = { version, commit: output("git", ["rev-parse", "HEAD"]), windlass, signer: identity(version), images };
	validate(release);
	return release;
}
function main([command, arg, ...rest]: string[]) {
	switch (command) {
		case "scan": return scan(arg!);
		case "pins": bundlePins(arg!); return;
		case "tag": console.log(versionTag(arg!)); return;
		case "indexes": return createIndexes(arg!, rest[0]!, rest.slice(1));
		case "manifest": console.log(JSON.stringify(makeRelease(arg!, JSON.parse(process.env.INDEX_DIGESTS!)), null, 2)); return;
		case "validate": return validate(JSON.parse(read(arg!)));
		case "verify": return verifyRelease(JSON.parse(read(arg!)), rest[0]!, (ref, signer) => {
			execFileSync("cosign", ["verify", "--certificate-identity", signer, "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", ref], { stdio: "inherit" });
		});
		default: throw new Error("Expected scan, pins, tag, indexes, manifest, validate or verify");
	}
}
if (resolve(process.argv[1]!) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
