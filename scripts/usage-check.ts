/**
 * The rules of a user's sandbox time and kept sandboxes (server/src/usage.ts), on their own: no server,
 * no sandbox, no clock but the one given.
 *
 *   cd server && npx tsx ../scripts/usage-check.ts
 *
 * What it holds to: two sessions that ask at once are not both given the last of the day; a hold never
 * reaches past midnight UTC and the next one is the new day's; a hold nobody settles is counted in
 * full when it has run out, once, and a report that comes after that only ever gives back; a report is never counted
 * below nothing or above the time since its hold was taken, and one above the hold's own length says
 * so; a day's total is the sum of its entries; a place among the kept sandboxes is counted and
 * claimed in one step, given back, and held against what the provider lists.
 */

import { CLAIM_SETTLING_MS, DAY_MS, HOLD_GRACE_SECONDS, REPORT_SLACK_SECONDS, UsageBook, type UsageLimits, allowanceRefusal, closingReports, dayOf, holdDeadline, sandboxRefusal, spellSeconds, stoppedBy, stretchSeconds, turnStoppedNote } from "../server/src/usage.js";

let failed = 0;
function expect(what: string, ok: boolean, detail = ""): void {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"}  ${what}${!ok && detail ? `\n      ${detail}` : ""}`);
}

const LIMITS: UsageLimits = { dailySeconds: 3600, maxKept: 2, holdSeconds: 600 };
/** 2026-11-17 09:00:00 UTC. */
const NINE = Date.UTC(2026, 10, 17, 9);
const TODAY = dayOf(NINE);
const at = (seconds: number) => NINE + seconds * 1000;
const granted = (result: ReturnType<UsageBook["reserve"]>) => (result.ok ? result.hold.seconds : 0);

// Reserve, then settle.
{
	const book = new UsageBook(LIMITS);
	const a = book.reserve(at(0), { id: "a1", session: "a", fresh: true });
	expect("a session is given one hold of the day's allowance", a.ok && a.hold.seconds === 600 && a.hold.day === TODAY);
	expect("the hold counts as used for everybody else at once", book.numbers(at(0)).heldSeconds === 600 && book.numbers(at(0)).leftSeconds === 3000);
	const settled = book.settle(at(240), { session: "a", hold: "a1", seconds: 239.2 });
	expect("settling counts what ran, in whole seconds, and frees the rest", settled.known && settled.entry?.seconds === 239 && settled.entry.note === null && book.numbers(at(240)).leftSeconds === 3361);
	expect("the same settle again counts nothing", !book.settle(at(241), { session: "a", hold: "a1", seconds: 239.2 }).known && book.usedOn(TODAY) === 239);
	const again = book.reserve(at(300), { id: "a2", session: "a" });
	const repeat = book.reserve(at(301), { id: "a2", session: "a" });
	expect("the same request again is the same hold, not a second one", again.ok && repeat.ok && repeat.hold === again.hold && book.openHolds().length === 1);
}

// Two at once, with one hold's worth left.
{
	const book = new UsageBook(LIMITS, { entries: [{ day: TODAY, session: "old", hold: "h0", kind: "used", seconds: 3000, at: at(-60), note: null }] });
	const first = book.reserve(at(0), { id: "a1", session: "a", fresh: true });
	const second = book.reserve(at(0), { id: "b1", session: "b", fresh: true });
	expect("of two that ask together with 600 s left, one is given them and the other is refused", granted(first) === 600 && !second.ok && second.reason === "allowance");
	expect("the refusal took nothing", book.openHolds().length === 1 && book.numbers(at(0)).leftSeconds === 0);
	const words = allowanceRefusal(book.numbers(at(0)));
	expect("the refusal says what was used, what is held, the allowance and when it resets", words.includes("Today's 1 h") && words.includes("50 min used") && words.includes("10 min held") && words.includes("00:00 UTC") && words.includes("in 15 h"), words);
	book.settle(at(100), { session: "a", hold: "a1", seconds: 100 });
	expect("what the first did not use is there for the second", granted(book.reserve(at(101), { id: "b2", session: "b", fresh: true })) === 500);
}

// A sandbox that runs: one hold after the other, and the end of the allowance.
{
	const book = new UsageBook({ ...LIMITS, dailySeconds: 1500 });
	book.reserve(at(0), { id: "a1", session: "a", fresh: true });
	const second = book.reserve(at(600), { id: "a2", session: "a", settle: { hold: "a1", seconds: 600.004 } });
	expect("a running sandbox trades its hold for the next in one step", granted(second) === 600 && book.usedOn(TODAY) === 600 && book.openHolds().length === 1);
	expect("a trade a few milliseconds after the hold's time is no overrun", book.entriesOn(TODAY)[0]?.note === null);
	const third = book.reserve(at(1200), { id: "a3", session: "a", settle: { hold: "a2", seconds: 600 } });
	expect("the last hold of the day is what is left", granted(third) === 300);
	const fourth = book.reserve(at(1500), { id: "a4", session: "a", settle: { hold: "a3", seconds: 300 } });
	expect("when nothing is left the trade is refused, and the hold it named stays open", !fourth.ok && fourth.reason === "allowance" && book.holdOf("a")?.id === "a3" && book.usedOn(TODAY) === 1200);
	// Stopping the turn took four seconds: the sandbox ran that much past its hold.
	const end = book.settle(at(1504), { session: "a", hold: "a3", seconds: 304 });
	expect("a sandbox that ran past its hold is counted for what ran, and the entry says by how much", end.entry?.seconds === 304 && (end.entry.note ?? "").includes("4 s over its hold of 300 s"), end.entry?.note ?? "");
	expect("a turn started then is refused, in words that say the day is used up", !book.reserve(at(1510), { id: "b1", session: "b", fresh: true }).ok && allowanceRefusal(book.numbers(at(1510))).includes("used up"));
	expect("the note of the stopped turn says the allowance and the reset", turnStoppedNote(book.numbers(at(1510))).includes("25 min") && turnStoppedNote(book.numbers(at(1510))).includes("00:00 UTC"));
	expect("a little that is left is not enough to start with, and is enough to go on with", (() => {
		const few = new UsageBook(LIMITS, { entries: [{ day: TODAY, session: "old", hold: "h0", kind: "used", seconds: 3590, at: at(-1), note: null }] });
		const start = few.reserve(at(0), { id: "s1", session: "s", fresh: true });
		const words = allowanceRefusal(few.numbers(at(0)));
		const go = few.reserve(at(0), { id: "s1", session: "s" });
		return !start.ok && words.startsWith("Only 10 s") && granted(go) === 10;
	})());
}

// What a session reports.
{
	const book = new UsageBook(LIMITS);
	book.reserve(at(0), { id: "a1", session: "a" });
	const below = book.settle(at(10), { session: "a", hold: "a1", seconds: -5 });
	expect("a report below nothing is counted as nothing, and says so", below.entry?.seconds === 0 && (below.entry.note ?? "").includes("counted as 0 s"));
	book.reserve(at(20), { id: "a2", session: "a" });
	const beyond = book.settle(at(50), { session: "a", hold: "a2", seconds: 4000 });
	expect("a report of more than the time since the hold was taken is cut to that time, and says so", beyond.entry?.seconds === 30 + REPORT_SLACK_SECONDS && (beyond.entry.note ?? "").includes("4000 s"), beyond.entry?.note ?? "");
	book.reserve(at(60), { id: "a3", session: "a" });
	const none = book.settle(at(70), { session: "a", hold: "a3", seconds: Number.NaN });
	expect("a report that is no number is counted as nothing", none.entry?.seconds === 0 && none.entry.note !== null);
	expect("no entry is below zero, and none is above its hold without a note", book.entriesOn(TODAY).every((entry) => entry.seconds >= 0 && (entry.seconds <= 600 || entry.note !== null)));
	expect("a day's total is the sum of its entries", book.usedOn(TODAY) === book.recount(TODAY) && book.usedOn(TODAY) === 35);
}

// A hold that nobody settles.
{
	const book = new UsageBook(LIMITS);
	book.reserve(at(0), { id: "a1", session: "a", fresh: true });
	const ends = at(600 + HOLD_GRACE_SECONDS);
	expect("a hold is still open a moment before it runs out", book.sweep(ends - 1).entries.length === 0 && book.numbers(ends - 1).heldSeconds === 600);
	const before = book.numbers(ends + 1);
	const swept = book.sweep(ends);
	expect("when it has run out it is counted in full, as unreported, at the time it ran out", swept.entries.length === 1 && swept.entries[0]?.kind === "unreported" && swept.entries[0].seconds === 600 && swept.entries[0].at === ends && swept.closed[0] === "a1");
	expect("what is left is the same before and after it is counted", before.leftSeconds === book.numbers(ends + 1).leftSeconds && book.numbers(ends + 1).heldSeconds === 0 && book.usedOn(TODAY) === 600);
	expect("it is counted once", book.sweep(ends + 60_000).entries.length === 0 && book.usedOn(TODAY) === 600);
	expect("another session's report for it changes nothing", !book.settle(ends + 5_000, { session: "b", hold: "a1", seconds: 20 }).known && book.usedOn(TODAY) === 600);
	const next = book.reserve(ends + 10_000, { id: "a2", session: "a", settle: { hold: "a1", seconds: 900 } });
	expect("its session is given a new hold all the same, and a report in passing counts nothing", granted(next) === 600 && book.usedOn(TODAY) === 600);
	const lost = book.reserve(ends + 20_000, { id: "a3", session: "a" });
	expect("a session that takes another hold without settling its own has the first counted in full", lost.ok && lost.change.entries[0]?.kind === "unreported" && book.usedOn(TODAY) === 1200 && book.openHolds().length === 1);
	expect("today's time by session says how much of it nobody reported", book.today(ends + 20_000)[0]?.unreportedSeconds === 1200 && book.today(ends + 20_000)[0]?.heldSeconds === 600);

	// The session had measured, and could not say so before its server was gone: it says so when it is back.
	const late = book.settle(ends + 30_000, { session: "a", hold: "a1", seconds: 42 });
	expect("a report that comes after the hold was counted in full gives the difference back, in an entry of its own", late.known && late.entry?.kind === "corrected" && late.entry.seconds === 42 - 600 && late.entry.day === TODAY && book.usedOn(TODAY) === 1200 - 558);
	expect("the first entry stays as it was, and the sum is still the entries'", book.entriesOn(TODAY).some((entry) => entry.hold === "a1" && entry.kind === "unreported" && entry.seconds === 600) && book.usedOn(TODAY) === book.recount(TODAY));
	expect("the same late report again gives nothing back", !book.settle(ends + 31_000, { session: "a", hold: "a1", seconds: 0 }).known && book.usedOn(TODAY) === 642);
	expect("a late report never adds to what was counted, and never gives back more than that", (() => {
		const more = book.settle(ends + 32_000, { session: "a", hold: "a2", seconds: 5000 });
		return more.known && more.entry?.seconds === 0 && book.usedOn(TODAY) === 642;
	})());
	expect("what nobody reported is less by the hold that was reported after all", book.today(ends + 40_000)[0]?.unreportedSeconds === 0 && book.today(ends + 40_000)[0]?.seconds === 642);
}

// The day.
{
	const book = new UsageBook(LIMITS, { entries: [{ day: TODAY, session: "old", hold: "h0", kind: "used", seconds: 3600, at: at(0), note: null }] });
	const midnight = (TODAY + 1) * DAY_MS;
	expect("the day's allowance is used up until midnight UTC", !book.reserve(midnight - 3_000, { id: "a0", session: "a", fresh: true }).ok);
	const fresh = book.reserve(midnight, { id: "a1", session: "a", fresh: true });
	expect("at midnight UTC the allowance is whole again", fresh.ok && fresh.hold.day === TODAY + 1 && book.numbers(midnight).leftSeconds === 3000 && book.numbers(midnight).usedSeconds === 0);
	expect("the day before still has what it had", book.days(midnight, 2)[0]?.seconds === 3600 && book.days(midnight, 2)[1]?.seconds === 0);

	const late = new UsageBook(LIMITS);
	const evening = late.reserve(midnight - 100_000, { id: "b1", session: "b", fresh: true });
	expect("a hold does not reach past midnight", evening.ok && evening.hold.seconds === 100 && evening.hold.day === TODAY);
	const over = late.reserve(midnight, { id: "b2", session: "b", settle: { hold: "b1", seconds: 100 } });
	expect("the hold after it is the new day's, and what ran before is the old day's", over.ok && over.hold.day === TODAY + 1 && over.hold.seconds === 600 && late.usedOn(TODAY) === 100 && late.usedOn(TODAY + 1) === 0);
	expect("the numbers name the day and its end", late.numbers(midnight - 1).day === "2026-11-17" && late.numbers(midnight - 1).resetsAt === midnight && late.numbers(midnight).day === "2026-11-18");
	expect("a hold taken in the last moment of a day is the new day's first", (() => {
		const edge = new UsageBook(LIMITS, { entries: [{ day: TODAY, session: "old", hold: "h0", kind: "used", seconds: 3600, at: at(0), note: null }] });
		const taken = edge.reserve(midnight - 500, { id: "c1", session: "c" });
		return taken.ok && taken.hold.day === TODAY + 1;
	})());
	expect("without a limit a hold is always given, and time is still counted", (() => {
		const open = new UsageBook({ dailySeconds: null, maxKept: null, holdSeconds: 600 });
		for (let index = 0; index < 20; index += 1) {
			const taken = open.reserve(at(index * 600), { id: `u${index}`, session: "u", settle: index === 0 ? undefined : { hold: `u${index - 1}`, seconds: 600 } });
			if (!taken.ok) return false;
		}
		return open.usedOn(TODAY) === 19 * 600 && open.numbers(at(12_000)).leftSeconds === null && !open.atCap("another");
	})());
}

// Kept sandboxes.
{
	const book = new UsageBook(LIMITS);
	const one = book.reserve(at(0), { id: "a1", session: "a", keep: true, fresh: true });
	const two = book.reserve(at(0), { id: "b1", session: "b", keep: true, fresh: true });
	const three = book.reserve(at(0), { id: "c1", session: "c", keep: true, fresh: true });
	expect("a place is counted and claimed with the hold: of three that ask with a cap of two, the third is refused", one.ok && two.ok && !three.ok && three.reason === "sandboxes" && book.kept().length === 2);
	expect("the refusal took no hold either", book.holdOf("c") === null && book.numbers(at(0)).heldSeconds === 1200);
	expect("the refusal says what to do", sandboxRefusal(book.numbers(at(0))).includes("You keep 2 sandboxes") && sandboxRefusal(book.numbers(at(0))).includes("Usage page"));
	expect("a session that has its place is not counted twice", book.reserve(at(10), { id: "a2", session: "a", keep: true, settle: { hold: "a1", seconds: 10 } }).ok && book.kept().length === 2);
	expect("a session that needs no place is not held to the cap", book.reserve(at(10), { id: "d1", session: "d", fresh: true }).ok);
	book.release("a");
	expect("a place that is given back is there for the next", book.reserve(at(20), { id: "c2", session: "c", keep: true, fresh: true }).ok && book.keeps("c") && !book.keeps("a"));
	expect("giving back a place twice is giving it back once", book.release("a").released.length === 0);

	const used = new UsageBook(LIMITS, { entries: [{ day: TODAY, session: "old", hold: "h0", kind: "used", seconds: 3600, at: at(0), note: null }], kept: [{ session: "x", since: 0 }, { session: "y", since: 0 }] });
	const both = used.reserve(at(0), { id: "z1", session: "z", keep: true, fresh: true });
	expect("with the day used up and the cap reached, the day is what is said: freeing a sandbox would not help", !both.ok && both.reason === "allowance");
}

// The count against what exists.
{
	const book = new UsageBook(LIMITS, { kept: [{ session: "gone", since: at(-3600) }, { session: "here", since: at(-3600) }, { session: "making", since: at(-10) }] });
	expect("a count made wrong keeps a user out", book.atCap("new"));
	const done = book.reconcile(at(0), ["here", "unknown-1", "unknown-2"]);
	expect("a claim with no sandbox behind it is dropped", done.dropped.join() === "gone" && !book.keeps("gone"));
	expect("a claim made a moment ago is kept: its sandbox is still being made", book.keeps("making") && CLAIM_SETTLING_MS > 10_000);
	expect("a sandbox nobody claimed is counted, also past the cap", done.added.join() === "unknown-1,unknown-2" && book.kept().length === 4 && book.atCap("new"));
	const later = book.reconcile(at(CLAIM_SETTLING_MS / 1000), ["here"]);
	expect("when those are gone and the unmade one never came, there is room again", later.dropped.length === 3 && book.kept().length === 1 && !book.atCap("new"));
	expect("holding the count against the same list again changes nothing", book.reconcile(at(CLAIM_SETTLING_MS / 1000 + 1), ["here"]).change.kept.length === 0 && book.kept().length === 1);
}

// Until when a sandbox that is found stopped can have run, and how lengths of time are said.
{
	const stretch = { hold: "h", since: at(0), seconds: 300 };
	expect("where the provider stops an unused sandbox, it ran until that long after its last use", stoppedBy(stretch, at(100), 120_000, at(600)) === at(220));
	expect("never later than now", stoppedBy(stretch, at(100), 120_000, at(150)) === at(150));
	expect("and not before it was last seen running", stoppedBy({ ...stretch, seen: at(400) }, at(100), 120_000, at(600)) === at(400));
	expect("where nothing stops it by itself, nothing is known but now", stoppedBy(stretch, at(100), null, at(600)) === at(600));
	expect("lengths of time are said in the two largest units that matter", [7200, 6600, 725, 245, 60, 45, 0].map(spellSeconds).join("|") === "2 h|1 h 50 min|12 min|4 min 5 s|1 min|45 s|0 s", [7200, 6600, 725, 245, 60, 45, 0].map(spellSeconds).join("|"));
}

// A request whose answer was lost, and a hold that could not be renewed (agent-session.ts, `takeHold`, `meterTick`).
{
	// A renewal reaches the book and its answer is lost; the session asks again 25 s later, under the same id and from the first moment.
	const book = new UsageBook(LIMITS);
	book.reserve(at(0), { id: "a1", session: "a", fresh: true });
	const first = { hold: "a1", since: at(0), seconds: 600 };
	book.reserve(at(600), { id: "a2", session: "a", settle: { hold: "a1", seconds: stretchSeconds(first, at(600)) } });
	const retry = book.reserve(at(625), { id: "a2", session: "a", settle: { hold: "a1", seconds: stretchSeconds(first, at(600)) } });
	const second = { hold: "a2", since: at(600), seconds: 600 };
	book.reserve(at(1200), { id: "a3", session: "a", settle: { hold: "a2", seconds: stretchSeconds(second, at(1200)) } });
	book.settle(at(1300), { session: "a", hold: "a3", seconds: 100 });
	expect("a renewal asked again under its id, from when it was first asked, counts every second once", retry.ok && retry.hold.id === "a2" && book.usedOn(TODAY) === 1300, `${book.usedOn(TODAY)} s counted for 1300 s`);
	expect("from the retry's own moment, the 25 s between the two are in no hold", stretchSeconds({ ...second, since: at(625) }, at(1200)) === 575);

	// The stretch ends with that renewal unanswered: both halves are reported, whichever of them the book has.
	const asked = { id: "b2", at: at(600) };
	const reports = closingReports({ hold: "b1", since: at(0), seconds: 600 }, asked, at(700));
	for (const reached of [false, true]) {
		const other = new UsageBook(LIMITS);
		other.reserve(at(0), { id: "b1", session: "b", fresh: true });
		if (reached) other.reserve(at(600), { id: "b2", session: "b", settle: { hold: "b1", seconds: 600 } });
		for (const report of reports) other.settle(at(700), { session: "b", ...report });
		expect(`a stretch that ends with its renewal unanswered counts what ran, once, when the renewal ${reached ? "had" : "had not"} reached the book`, other.usedOn(TODAY) === 700 && other.openHolds().length === 0, `${other.usedOn(TODAY)} s, ${other.openHolds().length} open`);
	}

	// A prompt's hold whose answer was lost, and the prompt refused: reported at 0 s before the next hold is taken.
	for (const late of [false, true]) {
		const orphan = new UsageBook(LIMITS, { entries: [{ day: TODAY, session: "o", hold: "o0", kind: "used", seconds: 100, at: at(-60), note: null }] });
		orphan.reserve(at(0), { id: "o1", session: "o", keep: true, fresh: true });
		const when = late ? at(600 + HOLD_GRACE_SECONDS + 1) : at(30);
		const settled = orphan.settle(when, { session: "o", hold: "o1", seconds: 0 });
		const next = orphan.reserve(when, { id: "o2", session: "o", fresh: true });
		expect(`an orphan hold settled at 0 s ${late ? "after it was counted in full" : "while it is open"} leaves the day as it was`, settled.known && next.ok && orphan.usedOn(TODAY) === 100, `${orphan.usedOn(TODAY)} s`);
	}

	// When a hold that cannot be renewed stops the sandbox.
	const hold = new UsageBook(LIMITS).reserve(at(2), { id: "d1", session: "d", fresh: true });
	expect("a hold that is not renewed stops its sandbox 30 s before the book stops counting it", holdDeadline(at(0), 600) === at(600 + HOLD_GRACE_SECONDS - 30) && hold.ok && holdDeadline(at(0), hold.hold.seconds) < hold.hold.expiresAt);
	expect("not at the end of the hold: the book still counts what runs past it until then", holdDeadline(at(0), 600) > at(600) + 60_000);
	expect("a lease without grace stops the same margin before it runs out", holdDeadline(at(0), 180, 0) === at(150));
}

console.log(failed === 0 ? "\nAll checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
