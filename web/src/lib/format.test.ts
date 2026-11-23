/** The running clock beside "working", in the bar's pill and at the end of the line: as a clock reads it, never "0ms". */
import { describe, expect, it } from "vitest";
import { byteSize, clockDuration, duration } from "./format";

describe("clockDuration", () => {
	it("says 0:00, not 0ms, as a turn starts, and whole seconds after, with hours once there are any", () => {
		expect(clockDuration(0)).toBe("0:00");
		expect(clockDuration(420)).toBe("0:00");
		expect(clockDuration(38_400)).toBe("0:38");
		expect(clockDuration(108_000)).toBe("1:48");
		expect(clockDuration(3_729_000)).toBe("1:02:09");
	});

	it("leaves duration as it was for lengths that are measured, not ticking", () => {
		expect(duration(13)).toBe("13ms");
	});
});

describe("byteSize", () => {
	it("says a size in the unit people read it in", () => {
		expect(byteSize(2_097_152)).toBe("2 MB");
		expect(byteSize(1_073_741_824)).toBe("1 GB");
		expect(byteSize(1_610_612_736)).toBe("1.5 GB");
		expect(byteSize(524_288)).toBe("512 KB");
		expect(byteSize(900)).toBe("900 bytes");
	});
});
