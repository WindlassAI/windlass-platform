// A daemon owns one bounded store. Sessions mount exactly one subdirectory. The allocator
// reserves a whole slot so concurrent writers cannot race a free-space estimate.
import { docker, LABEL, LABEL_ARG, randomId } from "./docker.js";
import { digest } from "./snapshot-key.js";

export const MIRROR_VOLUME = "wlp-git-mirrors-v1";
export const MIRROR_ROOT = "/var/cache/windlass-git";
export const MIRROR_BYTES = 512 * 1024 * 1024;
const SLOTS = 16;

export const mirrorOwner = (uid: string, repo: string) => digest([uid, repo]);
export const mirrorSlot = (deployment: string, machine: string, uid: string, repo: string) =>
	digest([deployment, machine, uid, repo]);

// No network, token or workspace. Lock the store for admission, and each victim before
// deleting it. A session using a mirror holds that same directory lock inside its mount.
const allocate = `import fcntl, os, re, shutil, sys
key, slots = sys.argv[1], int(sys.argv[2])
os.chdir("/store")
def lock(path):
    fd = os.open(path, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise
    return fd
store = lock(".")
if not os.path.isdir(key):
    entries = [p for p in os.listdir() if re.fullmatch("[a-f0-9]{64}", p)]
    if len(entries) >= slots:
        for victim in sorted(entries, key=lambda p: (os.stat(p).st_mtime_ns, p)):
            try:
                held = lock(victim)
            except BlockingIOError:
                continue
            shutil.rmtree(victim)
            break
        else:
            sys.exit(1)
    os.mkdir(key, 0o700)
    os.chown(key, 65534, 65534)
os.utime(key)
`;

export async function gitMirrorMount(image: string, deployment: string, machine: string, uid: string, repo: string,
	volume = MIRROR_VOLUME, slots = SLOTS): Promise<string | null> {
	if (!deployment || !/^[1-9]\d{0,19}$/.test(repo)) return null;
	// A pre-existing volume with the same name could belong to another application
	// or bind a host directory. Never run the allocator against such a volume.
	const label = LABEL + ".git-mirrors";
	const created = await docker(["volume", "create", "--driver", "local", "--label", LABEL_ARG, "--label", label + "=1", volume], { timeoutMs: 2000 });
	if (created.code !== 0) return null;
	const info = await docker(["volume", "inspect", volume], { timeoutMs: 2000 });
	if (info.code !== 0) return null;
	const [store] = JSON.parse(info.stdout);
	if (store?.Driver !== "local" || Object.keys(store.Options ?? {}).length || store.Labels?.[label] !== "1" || store.Labels?.[LABEL] !== "1") return null;
	const slot = mirrorSlot(deployment, machine, uid, repo);
	const helper = "wlp-git-allocate-" + randomId(6);
	const result = await docker(["run", "--rm", "--pull", "never", "--name", helper, "--network", "none",
		"--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges",
		"--mount", `type=volume,src=${volume},dst=/store,volume-nocopy`, "--entrypoint", "/usr/bin/python3", image,
		"-I", "-c", allocate, slot, String(slots)], { timeoutMs: 5000 });
	if (result.timedOut) await docker(["rm", "-f", helper], { timeoutMs: 2000 });
	return result.code === 0 ? `type=volume,src=${volume},volume-subpath=${slot},dst=${MIRROR_ROOT}/${mirrorOwner(uid, repo)},volume-nocopy` : null;
}
