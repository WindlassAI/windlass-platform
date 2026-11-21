/** The running clock beside "working": whole seconds from the first instant, never "0ms". */
import { describe, expect, it } from "vitest";
import { duration, tickingDuration } from "./format";

describe("tickingDuration", () => {
	it("says 1s, not 0ms, as a turn starts, and whole seconds after", () => {
		expect(tickingDuration(0)).toBe("1s");
		expect(tickingDuration(420)).toBe("1s");
		expect(tickingDuration(38_400)).toBe("38s");
		expect(tickingDuration(135_900)).toBe("2m 15s");
	});

	it("leaves duration as it was for lengths that are measured, not ticking", () => {
		expect(duration(13)).toBe("13ms");
	});
});
