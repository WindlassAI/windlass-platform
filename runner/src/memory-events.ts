import type { Value } from "../../server/src/runner/protocol.js";
import type { TurnSandbox } from "../../server/src/sandbox/provider.js";

// Run inside the session container, including on Docker Desktop. With a private cgroup
// namespace its membership is /; with a host namespace it can be a Docker or systemd path.
const READ_MEMORY = `
while IFS=: read -r hierarchy controllers path; do
	case ",$controllers," in
		,,) mount=$1; events=memory.events; limit=memory.max ;;
		*,memory,*) mount=$1/memory; events=memory.oom_control; limit=memory.limit_in_bytes ;;
		*) continue ;;
	esac
	dir=$mount$path
	if [ ! -r "$dir/$limit" ]; then
		# Docker can also mount just this container's subtree at the controller root.
		grep -qx "$$" "$mount/cgroup.procs" 2>/dev/null || continue
		dir=$mount
	fi
	[ -r "$dir/$limit" ] || continue
	cat "$dir/$limit" || exit 1
	cat "$dir/$events" 2>/dev/null
	if [ "$events" = memory.oom_control ] && [ -r "$dir/memory.failcnt" ]; then
		printf 'failcnt '; cat "$dir/memory.failcnt"
	fi
	exit 0
done < "$2"
exit 1
`;

export async function readMemoryEvents(handle: Pick<TurnSandbox, "ask">): Promise<Value<"memoryEvents">> {
	const result = await handle.ask(["/bin/sh", "-c", READ_MEMORY, "memory-events", "/sys/fs/cgroup", "/proc/self/cgroup"], { timeoutMs: 4_000 });
	if (result?.code !== 0) return null;
	const bytes = Number(/^(\d+)$/m.exec(result.stdout)?.[1]);
	if (!Number.isSafeInteger(bytes) || bytes < 2 ** 20) return null; // Includes unlimited v1 and v2 cgroups.
	const kills = /^oom_kill (\d+)$/m.exec(result.stdout);
	// Older v1 kernels expose only limit hits. Zero rules out a local OOM; a hit does not prove a kill.
	const oomKills = kills ? Number(kills[1]) : /^failcnt 0$/m.test(result.stdout) ? 0 : NaN;
	return Number.isSafeInteger(oomKills) ? { oomKills, totalMiB: Math.round(bytes / 2 ** 20) } : null;
}
