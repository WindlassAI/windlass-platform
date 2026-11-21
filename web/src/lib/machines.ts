/**
 * What a machine is called on the page. Its name is the host name its runner reported when it was
 * paired; a runner in a Docker container reports the container's id ("f892b469d6c5"), which reads as
 * something broke. Such a machine is called by what it is instead, its OS and architecture, with the
 * start of that id so two of them stay apart: "Linux arm64 machine (f892b4)".
 */

interface Described {
	name: string;
	os: string;
	arch: string;
}

/** A container's id as Docker gives it for a host name (12 hex characters, or the whole 64), or no name at all. */
export function isMachineIdName(name: string): boolean {
	const trimmed = name.trim();
	return trimmed === "" || /^[0-9a-f]{12}$/i.test(trimmed) || /^[0-9a-f]{64}$/i.test(trimmed);
}

/** The machine's name for every place the page names it. */
export function machineLabel(machine: Described): string {
	const name = machine.name.trim();
	if (!isMachineIdName(name)) return name;
	const kind = [machine.os.trim(), machine.arch.trim()].filter(Boolean).join(" ");
	const what = kind === "" ? "Machine" : `${kind} machine`;
	return name === "" ? what : `${what} (${name.slice(0, 6).toLowerCase()})`;
}

/** The host name the runner reported, where the label does not show it whole: shown beside the label, for finding the container. */
export function machineHostNote(machine: Described): string | null {
	const name = machine.name.trim();
	return name !== "" && isMachineIdName(name) ? name : null;
}
