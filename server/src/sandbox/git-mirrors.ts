// A daemon owns one bounded store. Sessions mount exactly one subdirectory. The allocator
// reserves a whole slot so concurrent writers cannot race a free-space estimate.
import { docker, LABEL, LABEL_ARG, randomId } from "./docker.js";
import { digest } from "./snapshot-key.js";
import { snapshotLimits } from "./snapshots.js";

export const MIRROR_VOLUME = "wlp-git-mirrors-v1";
export const MIRROR_ROOT = "/var/cache/windlass-git";
export const MIRROR_BYTES = 512 * 1024 * 1024;
const SLOTS = 16;
const SLOT = /^[a-f0-9]{64}$/;

export const mirrorOwner = (uid: string, repo: string) => digest([uid, repo]);
export const mirrorSlot = (deployment: string, machine: string, uid: string, repo: string) =>
	digest([deployment, machine, uid, repo]);

// No network, token or workspace. Lock the store for admission, and each victim before
// deleting it. A session using a mirror holds that same directory lock inside its mount.
// Docker resolves volume-subpath again on every start, so a slot named by any container,
// running or stopped, is never a victim. Neither is one admitted moments ago, whose
// container may not exist yet. "restore" puts back a missing slot so a start succeeds.
const allocate = `import fcntl, os, re, shutil, sys, time
mode, key, slots, floor, grace, known = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6] == "1"
referenced = set(sys.argv[7:])
os.chdir("/store")
def lock(path, wait=0.0):
    fd = os.open(path, os.O_DIRECTORY | os.O_NOFOLLOW)
    deadline = time.monotonic() + wait
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return fd
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(fd)
                raise
            time.sleep(0.05)
try:
    store = lock(".", 3.0)
except BlockingIOError:
    sys.exit(1)
def entries():
    return [p for p in os.listdir() if re.fullmatch("[a-f0-9]{64}", p)]
def free():
    s = os.statvfs(".")
    return s.f_bavail * s.f_frsize
def evict():
    if not known:
        return False
    recent = time.time_ns() - grace * 10**9
    for victim in sorted((p for p in entries() if p != key and p not in referenced), key=lambda p: (os.lstat(p).st_mtime_ns, p)):
        if os.lstat(victim).st_mtime_ns > recent:
            break
        try:
            held = lock(victim)
        except (BlockingIOError, OSError):
            continue
        shutil.rmtree(victim)
        os.close(held)
        return True
    return False
def create():
    os.mkdir(key, 0o700)
    os.chmod(key, 0o700)
    os.chown(key, 65534, 65534)
if mode == "restore":
    if not os.path.isdir(key):
        create()
        if len(entries()) > slots:
            evict()
    sys.exit(0)
while free() < floor and evict():
    pass
if not os.path.isdir(key):
    if free() < floor:
        sys.exit(1)
    count = len(entries())
    while count >= slots:
        if not evict():
            sys.exit(1)
        count -= 1
    create()
os.utime(key)
`;

const mountOf = (volume: string, slot: string, uid: string, repo: string) =>
	`type=volume,src=${volume},volume-subpath=${slot},dst=${MIRROR_ROOT}/${mirrorOwner(uid, repo)},volume-nocopy`;

// A pre-existing volume with the same name could belong to another application or bind
// a host directory. Never run the allocator against such a volume.
async function platformStore(volume: string, create: boolean): Promise<boolean> {
	const label = LABEL + ".git-mirrors";
	if (create) {
		const created = await docker(["volume", "create", "--driver", "local", "--label", LABEL_ARG, "--label", label + "=1", volume], { timeoutMs: 5000 });
		if (created.code !== 0) return false;
	}
	const info = await docker(["volume", "inspect", volume], { timeoutMs: 5000 });
	if (info.code !== 0) return false;
	const [store] = JSON.parse(info.stdout);
	return store?.Driver === "local" && !Object.keys(store.Options ?? {}).length && store.Labels?.[label] === "1" && store.Labels?.[LABEL] === "1";
}

type Mount = { Type?: string; Source?: string; VolumeOptions?: { Subpath?: string } };
const slotOf = (mounts: Mount[] | null | undefined, volume: string) =>
	mounts?.find(m => m.Type === "volume" && m.Source === volume && SLOT.test(m.VolumeOptions?.Subpath ?? ""))?.VolumeOptions?.Subpath;

/** Every slot a container on this daemon names, running or not. Null when that is unknown. */
export async function referencedSlots(volume = MIRROR_VOLUME): Promise<Set<string> | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const ids = await docker(["ps", "-a", "-q", "--no-trunc", "--filter", "volume=" + volume], { timeoutMs: 10_000 });
		if (ids.code !== 0) return null;
		const list = ids.stdout.split("\n").map(line => line.trim()).filter(Boolean);
		if (!list.length) return new Set();
		// A container removed between the two calls fails the inspect. List again.
		const info = await docker(["container", "inspect", "--format", "{{json .HostConfig.Mounts}}", ...list], { timeoutMs: 10_000 });
		if (info.code !== 0) continue;
		const slots = new Set<string>();
		for (const line of info.stdout.split("\n")) {
			if (!line.trim()) continue;
			const slot = slotOf(JSON.parse(line), volume);
			if (slot) slots.add(slot);
		}
		return slots;
	}
	return null;
}

async function runAllocator(image: string, volume: string, args: string[]) {
	const helper = "wlp-git-allocate-" + randomId(6);
	const result = await docker(["run", "--rm", "--pull", "never", "--name", helper, "--network", "none",
		"--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges",
		"--mount", `type=volume,src=${volume},dst=/store,volume-nocopy`, "--entrypoint", "/usr/bin/python3", image,
		"-I", "-c", allocate, ...args], { timeoutMs: 15_000 });
	if (result.timedOut) await docker(["rm", "-f", helper], { timeoutMs: 5000 });
	return result.code === 0;
}

export interface MirrorStore {
	volume?: string;
	slots?: number;
	/** Free bytes below which no slot is admitted and unused ones are evicted. */
	floor?: number;
	/** A slot admitted this recently is not evicted: its container may be starting. */
	graceSeconds?: number;
}

export async function gitMirrorMount(image: string, deployment: string, machine: string, uid: string, repo: string,
	{ volume = MIRROR_VOLUME, slots = SLOTS, floor = snapshotLimits.free, graceSeconds = 120 }: MirrorStore = {}): Promise<string | null> {
	if (!deployment || !/^[1-9]\d{0,19}$/.test(repo)) return null;
	if (!await platformStore(volume, true)) return null;
	const slot = mirrorSlot(deployment, machine, uid, repo);
	const referenced = await referencedSlots(volume);
	// A named slot cannot be evicted, so it exists. The clone refreshes its recency.
	if (referenced?.has(slot)) return mountOf(volume, slot, uid, repo);
	const admitted = await runAllocator(image, volume, ["admit", slot, String(slots), String(floor), String(graceSeconds), referenced ? "1" : "0", ...(referenced ?? [])]);
	return admitted ? mountOf(volume, slot, uid, repo) : null;
}

/** Before starting `container`: put back its slot if it is missing, so the start cannot fail on it. */
export async function restoreGitMirror(container: string, { volume = MIRROR_VOLUME, slots = SLOTS, graceSeconds = 120 }: MirrorStore = {}): Promise<boolean> {
	const info = await docker(["container", "inspect", "--format", "{{.Image}}|{{json .HostConfig.Mounts}}", container], { timeoutMs: 10_000 });
	if (info.code !== 0) return false;
	const [image = "", ...json] = info.stdout.trim().split("|");
	const slot = slotOf(JSON.parse(json.join("|") || "null"), volume);
	if (!slot) return false;
	if (!await platformStore(volume, false)) return false;
	const referenced = await referencedSlots(volume);
	return runAllocator(image, volume, ["restore", slot, String(slots), "0", String(graceSeconds), referenced ? "1" : "0", ...(referenced ?? [])]);
}
