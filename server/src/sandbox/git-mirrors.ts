// A daemon owns one bounded store. Sessions mount exactly one subdirectory, read-only. The
// allocator reserves a whole slot so concurrent writers cannot race a free-space estimate, and
// only a helper container outside every session writes a slot's mirror (`saveSessionMirror`).
import { spawn } from "node:child_process";
import { docker, LABEL, LABEL_ARG, NO_LOGS, randomId } from "./docker.js";
import { digest } from "./snapshot-key.js";
import { MIRROR_BYTES, MIRROR_CONFIG, MIRROR_ROOT, MIRROR_VOLUME, snapshotLimits } from "./store-limits.js";

export { MIRROR_BYTES, MIRROR_ROOT, MIRROR_VOLUME };
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

// Read-only: nothing in a session, the transport uid included, can change what a later clone reads.
const mountOf = (volume: string, slot: string, uid: string, repo: string) =>
	`type=volume,src=${volume},volume-subpath=${slot},dst=${MIRROR_ROOT}/${mirrorOwner(uid, repo)},volume-nocopy,readonly`;

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

type Mount = { Type?: string; Source?: string; Target?: string; ReadOnly?: boolean; VolumeOptions?: { Subpath?: string } };
const slotOf = (mounts: Mount[] | null | undefined, volume: string) =>
	mounts?.find(m => m.Type === "volume" && m.Source === volume && SLOT.test(m.VolumeOptions?.Subpath ?? ""))?.VolumeOptions?.Subpath;

/**
 * What `docker container inspect --format '{{json .HostConfig.Mounts}}' <ids>` says of the slots
 * those containers name. A container removed since it was listed names none: Docker prints the
 * others and an error for it. Null for any other failure.
 */
export function slotsInInspect(info: { code: number | null; stdout: string; stderr: string }, volume: string): Set<string> | null {
	const gone = info.stderr.split("\n").map(line => line.trim()).filter(Boolean).every(line => /No such container/i.test(line));
	if (info.code !== 0 && !gone) return null;
	const slots = new Set<string>();
	for (const line of info.stdout.split("\n")) {
		if (!line.trim()) continue;
		const slot = slotOf(JSON.parse(line), volume);
		if (slot) slots.add(slot);
	}
	return slots;
}

// The allocator mounts the whole store and names no slot. A save helper names its slot but holds
// the slot's lock while it runs, which eviction skips. Both are `--rm` and carry LABEL too (the
// image has it), so they are told apart by name.
const HELPER = /^wlp-git-(?:allocate|save)-/;

/**
 * Every slot a session container on this daemon names, running or not. Null when that is unknown.
 * Helpers are not inspected, and one exiting meanwhile cannot fail the inspect.
 */
export async function referencedSlots(volume = MIRROR_VOLUME): Promise<Set<string> | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const ids = await docker(["ps", "-a", "--no-trunc", "--filter", "volume=" + volume, "--filter", "label=" + LABEL, "--format", "{{.ID}} {{.Names}}"], { timeoutMs: 10_000 });
		if (ids.code !== 0) return null;
		const list = ids.stdout.split("\n").map(line => line.trim().split(" ")).filter(([id, name]) => id && !HELPER.test(name ?? "")).map(([id]) => id!);
		if (!list.length) return new Set();
		const slots = slotsInInspect(await docker(["container", "inspect", "--format", "{{json .HostConfig.Mounts}}", ...list], { timeoutMs: 10_000 }), volume);
		if (slots) return slots;
	}
	return null;
}

async function runAllocator(image: string, volume: string, args: string[]) {
	const helper = "wlp-git-allocate-" + randomId(6);
	const result = await docker(["run", "--rm", "--pull", "never", "--name", helper, ...NO_LOGS, "--network", "none",
		"--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges",
		"--mount", `type=volume,src=${volume},dst=/store,volume-nocopy`, "--entrypoint", "/usr/bin/python3", image,
		"-I", "-S", "-c", allocate, ...args], { timeoutMs: 15_000 });
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

/** `image` runs the allocator: the pinned base sandbox image. */
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

/**
 * Before starting `container`: put back its slot if it is missing, so the start cannot fail on it.
 * `image` is the pinned base sandbox image, never the container's own (a snapshot is a commit taken
 * after the session's setup ran).
 */
export async function restoreGitMirror(container: string, image: string, { volume = MIRROR_VOLUME, slots = SLOTS, graceSeconds = 120 }: MirrorStore = {}): Promise<boolean> {
	const info = await docker(["container", "inspect", "--format", "{{json .HostConfig.Mounts}}", container], { timeoutMs: 10_000 });
	if (info.code !== 0) return false;
	const slot = slotOf(JSON.parse(info.stdout.trim() || "null"), volume);
	if (!slot) return false;
	if (!await platformStore(volume, false)) return false;
	const referenced = await referencedSlots(volume);
	return runAllocator(image, volume, ["restore", slot, String(slots), "0", String(graceSeconds), referenced ? "1" : "0", ...(referenced ?? [])]);
}

/** Where a clone stages a mirror for the helper: in the session's /tmp, private to the transport uid. */
export function mirrorStage(stage: string): string {
	if (!/^[0-9a-f]{32}$/.test(stage)) throw new Error("Invalid Git mirror stage.");
	return `/tmp/wlp-transport-${stage}.mirror`;
}

// The save helper: uid 65534 (the slot's owner), no capabilities, no network, only its slot
// mounted (at /slot), the stage arriving on stdin as the tar `docker cp` makes of it. Everything in
// the tar is the session's to choose, so only a fixed set of regular files is taken (HEAD,
// packed-refs, packs with their indexes, loose objects, and the clone's `repair` mark), written
// with fresh names and modes, and a full fsck rehashes every object before anything replaces the
// slot's mirror. One save per slot at a time (`.save`, held throughout): a stage whose HEAD and
// packed-refs match the slot's mirror is not installed unless the clone marked it `repair` (the
// mirror failed it). The swap waits for readers (they share the slot lock) and leaves `repo.git`
// in place at every moment but between two renames, which the next save repairs.
const save = `import fcntl, os, re, shutil, subprocess, sys, tarfile, time
partial, floor, limit, config = sys.argv[1] == "1", int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
NAME = r"(?!.*(?:\\.\\.|@\\{|//|/\\.|\\.lock(?:/|$)))[^\\x00-\\x20\\x7f~^:?*\\[\\\\]+(?<![/.])"
HEAD = re.compile(r"ref: refs/heads/" + NAME + r"\\n")
REF = re.compile(r"[0-9a-f]{40} refs/(?:heads|tags)/" + NAME)
here = os.open("/slot", os.O_DIRECTORY | os.O_NOFOLLOW)
os.fchdir(here)
writer = os.open(".save", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(writer, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(3)
# Held throughout: eviction skips a slot whose lock it cannot take.
fcntl.flock(here, fcntl.LOCK_SH)
def clear(name):
    # "incoming" without a suffix is an earlier design's.
    for p in os.listdir("."):
        if p == name or p.startswith(name + "."):
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.unlink(p)
def current(name):
    try:
        with open("repo.git/" + name, "rb") as f:
            return f.read()
    except OSError:
        return None
olds = sorted((p for p in os.listdir(".") if p.startswith("old.")), key=lambda p: os.lstat(p).st_mtime_ns)
if olds and not os.path.lexists("repo.git"):
    os.rename(olds[-1], "repo.git")
clear("old")
clear("incoming")
if partial and os.path.lexists("repo.git"):
    sys.exit(0)
s = os.statvfs(".")
if s.f_bavail * s.f_frsize < floor + limit:
    sys.exit(4)
incoming = "incoming.%d" % os.getpid()
try:
    os.mkdir(incoming, 0o755)
    for d in ("refs", "refs/heads", "refs/tags", "objects", "objects/info", "objects/pack"):
        os.mkdir(incoming + "/" + d, 0o755)
    total = 0
    small = {}
    repair = False
    with tarfile.open(fileobj=sys.stdin.buffer, mode="r|") as tar:
        for m in tar:
            if not m.isreg() or not m.name.startswith("seed/"):
                continue
            rel = m.name[5:]
            loose = re.fullmatch(r"objects/([0-9a-f]{2})/[0-9a-f]{38}", rel)
            if rel == "repair":
                repair = True
                continue
            if rel in ("HEAD", "packed-refs"):
                if m.size > 16 << 20:
                    sys.exit(5)
                small[rel] = tar.extractfile(m).read()
                continue
            if not loose and not re.fullmatch(r"objects/pack/pack-[0-9a-f]{40}\\.(?:pack|idx)", rel):
                continue
            total += m.size
            if total > limit:
                sys.exit(5)
            if loose and not os.path.isdir(incoming + "/objects/" + loose.group(1)):
                os.mkdir(incoming + "/objects/" + loose.group(1), 0o755)
            out = os.open(incoming + "/" + rel, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
            with os.fdopen(out, "wb") as f:
                shutil.copyfileobj(tar.extractfile(m), f, 1 << 20)
    head, refs = small.get("HEAD", b"").decode("utf-8", "strict"), small.get("packed-refs", b"").decode("utf-8", "strict")
    if not HEAD.fullmatch(head) or not refs.endswith("\\n") or not all(REF.fullmatch(line) for line in refs[:-1].split("\\n")):
        sys.exit(5)
    # The clone compared too, but another clone's save may have landed since. Only a save changes
    # repo.git, and this one holds .save until it ends, so the answer holds through the swap.
    if not repair and current("HEAD") == small["HEAD"] and current("packed-refs") == small["packed-refs"]:
        sys.exit(0)
    for name, text in (("HEAD", head), ("packed-refs", refs), ("config", config + "\\n")):
        with open(incoming + "/" + name, "x") as f:
            f.write(text)
    env = {"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "LC_ALL": "C"}
    # Bounded memory for large blobs and deltas: the helper runs under --memory.
    subprocess.run(["git", "-c", "core.bigFileThreshold=64m", "-c", "core.deltaBaseCacheLimit=32m", "--git-dir=" + incoming,
        "fsck", "--full", "--no-dangling", "--no-reflogs", "--no-progress"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, check=True)
    deadline = time.monotonic() + 60
    while True:
        try:
            fcntl.flock(here, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            # A failed conversion drops the shared lock. Take it back while waiting.
            fcntl.flock(here, fcntl.LOCK_SH)
            if time.monotonic() >= deadline:
                sys.exit(6)
            time.sleep(0.1)
    if partial and os.path.lexists("repo.git"):
        sys.exit(0)
    if os.path.lexists("repo.git"):
        os.rename("repo.git", "old.%d" % os.getpid())
    os.rename(incoming, "repo.git")
    fcntl.flock(here, fcntl.LOCK_SH)
    clear("old")
    os.utime(here)
finally:
    shutil.rmtree(incoming, ignore_errors=True)
`;

const SAVE_TIMEOUT_MS = 10 * 60_000;
/**
 * The helper's own deadline, inside its container (coreutils `timeout`, then SIGKILL 10 s later).
 * Below SAVE_TIMEOUT_MS, so a helper whose client died, or that Docker could not be asked to remove,
 * still ends.
 */
const HELPER_SECONDS = SAVE_TIMEOUT_MS / 1000 - 60;
/** The most saves waiting to start. Each is a full fsck on a shared host. */
const MAX_WAITING = 4;

type Target = { volume: string; slot: string };
type Save = Target & { container: string; path: string; partial: boolean; image: string; floor: number; order: number; done?: Promise<boolean> };

// Saves run one at a time per server or runner process. A save waiting to start stands for its
// slot: a later stage for that slot takes its place (its refs are newer) and the older stage is
// removed, so a slow save holds up each slot once, not once per clone.
let queue: Promise<unknown> = Promise.resolve();
const waiting = new Map<string, Save>();
let calls = 0;
const pending = new Set<Promise<boolean>>();

/** Resolves when every save started so far has ended. */
export async function mirrorSavesSettled(): Promise<void> {
	while (pending.size) await Promise.allSettled([...pending]);
}

/**
 * Install the mirror a clone staged in `container`, then remove the stage. Nothing runs in the
 * session container for it: `docker cp` reads the stage and a helper container writes the slot.
 * A sweep of the session's processes cannot interrupt it, and a failed or killed helper leaves
 * the slot's previous mirror in place. `image` runs the helper: the pinned base sandbox image,
 * never the session's own (a snapshot is a commit taken after the session's setup ran). True when
 * the slot holds the stage, or a later one that took its place.
 */
export function saveSessionMirror(container: string, stage: string, partial: boolean, { image, floor = snapshotLimits.free }: { image: string; floor?: number }): Promise<boolean> {
	const path = mirrorStage(stage), order = ++calls;
	const run = (async () => {
		const target = await targetOf(container).catch(() => null);
		if (!target) { await dropStage(container, path); return false; }
		return enqueue({ ...target, container, path, partial, image, floor, order });
	})();
	pending.add(run);
	void run.finally(() => pending.delete(run));
	return run;
}

async function enqueue(next: Save): Promise<boolean> {
	const key = next.volume + "/" + next.slot;
	const queued = waiting.get(key);
	if (queued) {
		// The later clone's stage, by call: the inspects before this can end in any order. A full
		// stage over a single-branch one, whichever came later.
		const wins = next.partial !== queued.partial ? !next.partial : next.order > queued.order;
		const dropped = wins ? { container: queued.container, path: queued.path } : next;
		if (wins) Object.assign(queued, { container: next.container, path: next.path, partial: next.partial, image: next.image, floor: next.floor, order: next.order });
		await dropStage(dropped.container, dropped.path);
		return queued.done!;
	}
	if (waiting.size >= MAX_WAITING) { await dropStage(next.container, next.path); return false; }
	waiting.set(key, next);
	const done = queue.then(async () => {
		waiting.delete(key);
		try { return await installMirror(next); }
		catch { return false; }
		finally { await dropStage(next.container, next.path); }
	});
	next.done = done;
	queue = done;
	return done;
}

async function dropStage(container: string, path: string) {
	await docker(["exec", "--user", "65534:65534", "-w", "/", container, "/bin/rm", "-rf", "--", path], { timeoutMs: 30_000 }).catch(() => undefined);
}

/** The slot `container` mounts read-only, in a store of the platform's. */
async function targetOf(container: string): Promise<Target | null> {
	const info = await docker(["container", "inspect", "--format", "{{json .HostConfig.Mounts}}", container], { timeoutMs: 10_000 });
	if (info.code !== 0) return null;
	const mounts: Mount[] = JSON.parse(info.stdout.trim() || "null") ?? [];
	const mount = mounts.find(m => m.Type === "volume" && m.ReadOnly === true && m.Target?.startsWith(MIRROR_ROOT + "/") && SLOT.test(m.VolumeOptions?.Subpath ?? ""));
	const volume = mount?.Source, slot = mount?.VolumeOptions?.Subpath;
	if (!volume || !slot || !await platformStore(volume, false)) return null;
	return { volume, slot };
}

async function installMirror({ container, path, partial, image, floor, volume, slot }: Save): Promise<boolean> {
	const helper = "wlp-git-save-" + randomId(6);
	const copy = spawn("docker", ["cp", `${container}:${path}/seed`, "-"], { stdio: ["ignore", "pipe", "ignore"] });
	const install = spawn("docker", ["run", "--rm", "-i", "--pull", "never", "--name", helper, ...NO_LOGS, "--network", "none",
		"--user", "65534:65534", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only",
		"--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "64",
		"--mount", `type=volume,src=${volume},volume-subpath=${slot},dst=/slot,volume-nocopy`,
		"--entrypoint", "/usr/bin/timeout", image, "-k", "10s", `${HELPER_SECONDS}s`,
		"/usr/bin/python3", "-I", "-S", "-c", save, partial ? "1" : "0", String(floor), String(MIRROR_BYTES - 65536), MIRROR_CONFIG], { stdio: ["pipe", "ignore", "ignore"] });
	copy.stdout.pipe(install.stdin);
	install.stdin.on("error", () => copy.kill("SIGKILL"));
	const ended = (child: ReturnType<typeof spawn>) => new Promise<number | null>(resolve => {
		child.on("error", () => resolve(null));
		child.on("close", code => resolve(code));
	});
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; copy.kill("SIGKILL"); install.kill("SIGKILL"); }, SAVE_TIMEOUT_MS);
	try {
		const [copied, installed] = await Promise.all([ended(copy), ended(install)]);
		// Killing the client leaves its container running.
		if (timedOut || installed === null) await docker(["rm", "-f", helper], { timeoutMs: 10_000 });
		// A copy cut short ends the tar early. The helper then lacks HEAD, packed-refs or an
		// object its refs reach, and its fsck fails before any swap.
		return !timedOut && copied === 0 && installed === 0;
	} finally {
		clearTimeout(timer);
	}
}
