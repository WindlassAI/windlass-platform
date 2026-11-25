import { describe, expect, it } from "vitest";
import { whoIs } from "./identity";

const profile = { uid: "u_8cd513ca74b280b472b2", email: null, demo: false };

describe("whoIs", () => {
	it("names the GitHub sign-in, with its picture, and never the account id", () => {
		const who = whoIs(profile, [{ provider: "github", display: "parthg", name: "Parth G", avatar: "https://avatars.example/1" }]);
		expect(who).toEqual({ name: "Parth G", detail: "@parthg", avatar: "https://avatars.example/1", initial: "P" });
	});

	it("takes the address from the profile, then Google", () => {
		expect(whoIs({ ...profile, email: "a@x.dev" }, [{ provider: "github", display: "ada", name: null, avatar: null }])).toMatchObject({ name: "ada", detail: "a@x.dev" });
		expect(whoIs(profile, [{ provider: "google", display: "ada@x.dev", name: "Ada", avatar: null }])).toMatchObject({ name: "Ada", detail: "ada@x.dev" });
	});

	it("falls back to the address, then to a neutral name", () => {
		expect(whoIs({ ...profile, email: "a@x.dev" }, null)).toEqual({ name: "a@x.dev", detail: null, avatar: null, initial: "A" });
		const nobody = whoIs(profile, []);
		expect(nobody).toEqual({ name: "Your account", detail: null, avatar: null, initial: null });
		expect(JSON.stringify(nobody)).not.toContain("u_");
	});
});
