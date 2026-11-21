/** A machine whose runner reported a container's id for its host name is called by what it is. */
import { describe, expect, it } from "vitest";
import { isMachineIdName, machineHostNote, machineLabel, workspaceNetwork } from "./machines";

describe("machineLabel", () => {
	it("keeps a name a person gave the host", () => {
		expect(machineLabel({ name: "nas", os: "Linux", arch: "arm64" })).toBe("nas");
		expect(machineLabel({ name: "  build-box ", os: "Linux", arch: "x64" })).toBe("build-box");
		expect(machineHostNote({ name: "nas", os: "Linux", arch: "arm64" })).toBeNull();
	});

	it("calls a container's id by the OS and architecture, with the start of the id", () => {
		const machine = { name: "f892b469d6c5", os: "Linux", arch: "arm64" };
		expect(machineLabel(machine)).toBe("Linux arm64 machine (f892b4)");
		expect(machineHostNote(machine)).toBe("f892b469d6c5");
		expect(machineLabel({ name: "a".repeat(64), os: "Linux", arch: "x64" })).toBe("Linux x64 machine (aaaaaa)");
	});

	it("says something for a machine that reported no name", () => {
		expect(machineLabel({ name: "", os: "Linux", arch: "x64" })).toBe("Linux x64 machine");
		expect(machineLabel({ name: "", os: "", arch: "" })).toBe("Machine");
		expect(machineHostNote({ name: "", os: "Linux", arch: "x64" })).toBeNull();
	});

	it("does not take a word of hex letters, or a short one, for an id", () => {
		expect(isMachineIdName("deadbeef")).toBe(false);
		expect(isMachineIdName("cafe-box")).toBe(false);
		expect(isMachineIdName("F892B469D6C5")).toBe(true);
	});
});

describe("machineLabel's OS words", () => {
	it("names the OS as people do, whatever case the runner reported it in", () => {
		expect(machineLabel({ name: "d5eb81162177", os: "linux", arch: "arm64" })).toBe("Linux arm64 machine (d5eb81)");
		expect(machineLabel({ name: "d5eb81162177", os: "darwin", arch: "arm64" })).toBe("macOS arm64 machine (d5eb81)");
		expect(machineLabel({ name: "d5eb81162177", os: "FreeBSD", arch: "x64" })).toBe("FreeBSD x64 machine (d5eb81)");
	});
});

it("describes the actual workspace egress for commands outside the command sandbox", () => {
	expect(workspaceNetwork("open")).toContain("local network");
	expect(workspaceNetwork("restricted")).toContain("through the web proxy");
	expect(workspaceNetwork("none")).toContain("no direct outbound network access");
	expect(workspaceNetwork()).toContain("workspace’s network policy");
});
