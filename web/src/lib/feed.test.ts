/**
 * The Agents home's feed (lib/feed.ts): what needs its person, what is at work and the rest, newest
 * first, the user's agents and their work items together, without work items' sessions or subtasks.
 */
import type { GithubId, ItemSummary, SessionSummary } from "@contract";
import { describe, expect, it } from "vitest";
import { feedKey, feedOf } from "./feed";
import { NO_FILTERS } from "./workspace";

const repo = (id: number, name: string) => ({ provider: "github" as const, id: id as GithubId, owner: "acme", name, branch: "main", private: false, url: `https://github.com/acme/${name}` });

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
	return { id, title: id, mode: "auto", availableModes: [], capabilities: {} as SessionSummary["capabilities"], place: { kind: "hosted" }, profile: "docker-windlass-sandbox", model: "m", repoUrl: null, createdAt: 1, updatedAt: 1, status: "idle", turns: 1, lastOutcome: "succeeded", sandbox: "none", ...over } as SessionSummary;
}

function item(id: string, over: Partial<ItemSummary> = {}): ItemSummary {
	return { id, title: id, repository: repo(1, "harbor"), place: { kind: "hosted" }, source: "web", state: "working", question: null, pullRequest: null, createdAt: 1, updatedAt: 1, sessionId: `s-${id}`, ...over } as ItemSummary;
}

const keys = (entries: ReturnType<typeof feedOf>["needs"]) => entries.map(feedKey);

describe("the feed", () => {
	const sessions = [
		session("waiting-old", { status: "waiting", updatedAt: 10, repository: repo(1, "harbor") }),
		session("waiting-new", { status: "waiting", updatedAt: 30 }),
		session("running", { status: "running", updatedAt: 20, repository: repo(2, "quay") }),
		session("done", { updatedAt: 50, repository: repo(2, "quay") }),
		session("failed", { updatedAt: 5, lastOutcome: "failed" }),
		// A work item's session is part of its item.
		session("of-item", { status: "running", updatedAt: 99, item: { id: "asks" } as SessionSummary["item"] }),
	];
	const items = [
		item("asks", { state: "waiting", question: { text: "Which one?", askedAt: 40 } as ItemSummary["question"], updatedAt: 1 }),
		item("working", { state: "working", updatedAt: 25 }),
		item("queued", { state: "queued", updatedAt: 15 }),
		item("done", { state: "done", updatedAt: 60, pullRequest: { number: 3, url: "u" } }),
		// A feature's subtask is part of its feature.
		item("subtask", { state: "working", updatedAt: 70, parent: { itemId: "working", key: "1", title: "t" } }),
	];

	it("puts what asks first, then what is at work, then the rest, each newest first", () => {
		const feed = feedOf({ sessions, items });
		expect(keys(feed.needs)).toEqual(["i:asks", "a:waiting-new", "a:waiting-old"]);
		expect(keys(feed.working)).toEqual(["i:working", "a:running", "i:queued"]);
		expect(keys(feed.recent)).toEqual(["i:done", "a:done", "a:failed"]);
	});

	it("leaves out work items' sessions and subtasks", () => {
		const feed = feedOf({ sessions, items });
		const all = [...feed.needs, ...feed.working, ...feed.recent].map(feedKey);
		expect(all).not.toContain("a:of-item");
		expect(all).not.toContain("i:subtask");
	});

	it("narrows to the filters, and to the agents on no repository for that scope", () => {
		const needs = feedOf({ sessions, items, filters: { ...NO_FILTERS, status: ["needs"] } });
		expect(needs.working).toEqual([]);
		expect(needs.recent).toEqual([]);
		expect(keys(needs.needs)).toEqual(["i:asks", "a:waiting-new", "a:waiting-old"]);
		const onlyItems = feedOf({ sessions, items, filters: { ...NO_FILTERS, kind: ["item"] } });
		expect([...onlyItems.needs, ...onlyItems.working, ...onlyItems.recent].every((entry) => entry.kind === "item")).toBe(true);
		const none = feedOf({ sessions, items, scope: "none" });
		expect([...none.needs, ...none.working, ...none.recent].map(feedKey).sort()).toEqual(["a:failed", "a:waiting-new"]);
	});

	it("is empty before anything arrives", () => {
		expect(feedOf({ sessions: null, items: null })).toEqual({ needs: [], working: [], recent: [] });
	});
});
