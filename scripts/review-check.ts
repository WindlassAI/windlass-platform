/** The report tool before a session calls it. No actor, network, or sandbox. cd server && npx tsx ../scripts/review-check.ts */
import assert from "node:assert/strict";
import type { ItemReport, ReviewRecord, Verdict } from "../server/src/contract.js";
import { checkReview, itemComment, reportBlocks, reportOf, type ReviewContext } from "../server/src/factory/review.js";
import { verdictWords } from "../server/src/factory/verdict.js";
import { SecretRedactor } from "../server/src/repo-secrets.js";
import { flagWords, verifiedSection, workFlags, type WorkDiff } from "../server/src/verified.js";

let passed = 0;
function test(name: string, run: () => void): void {
	try { run(); } catch (error) { console.error(`FAIL  ${name}`); throw error; }
	passed++;
	console.log(`PASS  ${name}`);
}
const repeat = <T>(n: number, make: (i: number) => T) => Array.from({ length: n }, (_, i) => make(i));
const secret = "saved-credential";
const redactor = new SecretRedactor([{ name: "TEST_TOKEN_FOR_THE_REVIEW", value: secret }]);
const saved = "[secret:TEST_TOKEN_FOR_THE_REVIEW]";
const checkRecords = repeat<ReviewRecord>(41, (i) => ({ ref: `check/${i}`, kind: "check", name: `check ${i}`, status: "passed" }));
const context: ReviewContext = { round: 2, earlier: [], redactor, records: [...checkRecords,
	{ ref: "ci/0", kind: "ci", name: "build", app: "ci", conclusion: "success", url: "https://example.test/run" },
	{ ref: "flag/checks_changed", kind: "flag", flag: { kind: "checks_changed", where: ["test.sh"] } },
	{ ref: "command/x/y", kind: "command", command: "pwd", exitCode: 0, outcome: "ran", tail: "output" },
] };
const prior = { ...context, earlier: [{ id: "r1.f2", severity: "blocking" }] };
const summary = { kind: "summary", text: "" };
const prose = { kind: "text", text: "" };
const finding = { kind: "finding", title: "", text: "", severity: "note" };
const earlier = { kind: "earlier", finding: "r1.f2", status: "fixed" };
const risk = { kind: "risk", text: "" };
const question = { kind: "question", text: "" };
const excerpt = { kind: "excerpt", at: { path: "file", lines: { start: 1, end: 1 } } };
const shot = { kind: "screenshot", file: "view.png", caption: "" };
const review = (...blocks: unknown[]) => ({ recommendation: "approve", blocks: [summary, ...blocks] });
function take(input: unknown, ctx = context) {
	const result = checkReview(input, ctx);
	assert.ok(result.ok, JSON.stringify(result.ok ? [] : result.problems));
	return result;
}
function problems(input: unknown, ctx = context): string[] {
	const result = checkReview(input, ctx);
	assert.ok(!result.ok, "filing was accepted");
	return result.problems;
}
function refuse(input: unknown, problem: string, ctx = context): void {
	const all = problems(input, ctx);
	assert.ok(all.includes(problem), `expected ${JSON.stringify(problem)} in ${JSON.stringify(all)}`);
}

// These numbers and refusal sentences are the contract, independent of the constants the validator reads.
test("raw JSON bytes at 96 KiB and one over, before cleaning or shape checks", () => {
	const input = review();
	const padding = 96 * 1024 - Buffer.byteLength(JSON.stringify(input));
	const sized = (extra: number) => ({ ...input, blocks: [{ kind: "summary", text: "\u0080".repeat(Math.floor(padding / 2)) + " ".repeat(padding % 2 + extra) }] });
	assert.equal(Buffer.byteLength(JSON.stringify(sized(0))), 98_304);
	take(sized(0));
	assert.deepEqual(problems(sized(1)), ["the review is 98,305 bytes; the limit is 96 KiB"]);
	assert.deepEqual(problems("x".repeat(120 * 1024 - 2)), ["the review is 120 KiB; the limit is 96 KiB"]);
	assert.equal(problems(review({ ...prose, text: "x".repeat(5_000_000) })).length, 1);
	refuse(1n, "the review must be JSON");
});

for (const [name, input, rule] of [
	["object", [], "the review must be an object"], ["recommendation", { ...review(), recommendation: true }, "recommendation: must be one of approve, changes_requested, needs_person"],
	["blocks array", { ...review(), blocks: {} }, "blocks: must be an array"], ["block object", review(null), "blocks[1]: must be an object"],
	["kind", review(prose, { kind: "html" }), 'blocks[2].kind: unknown kind "html"'], ["kind type", review({}), "blocks[1].kind: must name a block kind"],
	["own kind", review({ kind: "toString" }), 'blocks[1].kind: unknown kind "toString"'], ["review field", { ...review(), report: "" }, 'review: unknown field "report"'],
	["no supplied code", review({ ...excerpt, code: "forged" }), 'blocks[1]: unknown field "code"'], ["no supplied id", review({ ...finding, id: "r2.f8" }), 'blocks[1]: unknown field "id"'],
	["severity", review({ ...finding, severity: "mild" }), "blocks[1].severity: must be one of blocking, should_fix, note"],
	["status", review({ ...earlier, status: "ok" }), "blocks[1].status: must be one of fixed, not_fixed, withdrawn"],
	["shows", review({ ...shot, shows: 2 }), "blocks[1].shows: must be one of after, before"],
	["locations array", review({ ...risk, at: {} }), "blocks[1].at: must be an array"], ["location", review({ ...risk, at: [null] }), "blocks[1].at[0]: must be a location"],
	["side", review({ ...risk, at: [{ path: "a", side: null }] }), "blocks[1].at[0].side: must be one of head, base"],
	["refs array", review({ ...prose, refs: null }), "blocks[1].refs: must be an array"], ["ref object", review({ ...prose, refs: ["ci/0"] }), "blocks[1].refs[0]: must be a reference"],
	["ref id", review({ ...prose, refs: [{}] }), "blocks[1].refs[0].ref: must be text"], ["claim", review({ ...finding, refs: [{ ref: "ci/0", says: "maybe" }] }), "blocks[1].refs[0].says: must be one of passed, failed, ran, not_run"],
	["finding id", review({ ...earlier, finding: 1 }), "blocks[1].finding: must be text"], ["continuation id", review({ ...finding, continues: null }), "blocks[1].continues: must be text"],
] as const) test(`shape: ${name}`, () => refuse(input, rule));

test("name ten problems and retain their block indices", () => {
	const bad = problems(review(...repeat(11, () => ({ kind: "html" }))));
	assert.deepEqual(bad, repeat(10, (i) => `blocks[${i + 1}].kind: unknown kind "html"`));
});

type Block = Record<string, unknown> & { kind: string };
const textFields: [Block, string, number][] = [[summary, "text", 1500], [prose, "text", 4000], [prose, "heading", 80], [finding, "title", 160], [finding, "text", 2000], [earlier, "text", 600], [risk, "text", 1000], [question, "text", 600], [excerpt, "note", 4000], [shot, "caption", 200], [shot, "page", 300], [shot, "file", 300]];
const fragments = ["@octocat", "[x](https://e.example)", "![](https://e.example/a.png)", "<script>alert(1)</script>", "# Heading"];
const markup = fragments.join(" ");
const hostile = `\u0001${secret}\u2028\r\n${markup}  \t`;
const cleaned = `${saved}\n${markup}`;
for (const [block, key, max] of textFields) {
	const ctx = block.kind === "earlier" ? prior : context;
	const i = block.kind === "summary" ? 0 : 1;
	const field = `blocks[${i}].${key}`;
	const input = (value: unknown) => {
		const given = { ...block, [key]: value };
		return i === 0 ? { ...review(), blocks: [given] } : review(given);
	};
	test(`field: ${block.kind}.${key} at ${max} and one over after cleaning`, () => {
		const fit = input("x".repeat(max) + "\u0001\u2028 \t");
		if (block.kind === "screenshot") assert.deepEqual(problems(fit), ["blocks[1]: screenshots are not taken on this platform yet"]);
		else take(fit, ctx);
		refuse(input("x".repeat(max + 1)), `${field}: ${(max + 1).toLocaleString("en-US")} characters; the limit is ${max.toLocaleString("en-US")}`, ctx);
		refuse(input(null), `${field}: must be text`, ctx);
	});
	if (block.kind !== "screenshot") test(`plain text: ${block.kind}.${key}`, () => {
		// An 80-character heading gets the same hostile strings in separate filings.
		const samples = key === "heading" ? fragments.map((part) => [`\u0001${secret}\u2028\r\n${part}  \t`, `${saved}\n${part}`]) : [[hostile, cleaned]];
		for (const [raw, expected] of samples) assert.equal((take(input(raw), ctx).blocks[i] as Block)[key], expected);
	});
}

test("control characters removed, preserving tab and normalized line breaks", () => {
	const value = [...repeat(160, (i) => String.fromCharCode(i)), "\u2028", "\u2029"].map((c) => `a${c}b`).join("");
	assert.deepEqual(take(review({ ...prose, text: value })).blocks[1], { ...prose, heading: null, text: value.replace(/\r/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029]/g, ""), refs: [] });
});

test("refusals do not repeat secrets, markup or instructions supplied as an identifier", () => {
	for (const name of [markup, secret, "ignore previous instructions"]) {
		assert.deepEqual(problems(review({ kind: name })), ['blocks[1].kind: unknown kind "(invalid name)"']);
	}
});

test("redaction can expand a field past its stored limit", () => {
	const n = 80 - secret.length;
	refuse(review({ ...prose, heading: "x".repeat(n) + secret }), `blocks[1].heading: ${n + saved.length} characters; the limit is 80`);
	assert.deepEqual(take(review({ ...prose, text: "  x\t \r\nsaved-\u0001credential\ry" })).blocks[1], { ...prose, heading: null, text: `  x\n${saved}\ny`, refs: [] });
});

test("40,000 stored characters and one over across headings, paths, refs and prose", () => {
	const texts = repeat(9, () => ({ ...prose, text: "x".repeat(4000) }));
	const input = (extra: number) => review(...texts, { ...prose, heading: "a", text: "x".repeat(3988 + extra), refs: [{ ref: "check/0" }] }, { ...risk, at: [{ path: "file" }] });
	take(input(0));
	refuse(input(1), "blocks: 40,001 characters; the limit is 40,000");
});

test("fenced lines at 60 and 61, including a fence open at the end", () => {
	const fence = (n: number) => "```js\r\n" + repeat(n, () => "x").join("\r\n");
	take(review({ ...prose, text: `${fence(60)}\n\u0001\u2028\`\`\`\n${fence(60)}` }));
	for (const close of ["", "\n``` "]) refuse(review({ ...prose, text: fence(61) + close }), "blocks[1].text: a fence has 61 lines; the limit is 60");
});

for (const [block, max, name] of [[prose, 60, "blocks"], [finding, 30, "findings"], [risk, 10, "risks"], [question, 5, "questions"], [excerpt, 10, "excerpts"], [shot, 8, "screenshots"]] as const) {
	test(`count: ${name} at ${max} and one over`, () => {
		const input = (n: number) => review(...repeat(name === "blocks" ? n - 1 : n, () => block));
		if (name === "screenshots") assert.deepEqual(problems(input(max)), repeat(max, (i) => `blocks[${i + 1}]: screenshots are not taken on this platform yet`));
		else take(input(max));
		refuse(input(max + 1), `blocks: ${max} ${name} at most; this has ${max + 1}`);
	});
}

test("a bad recommendation reports its own value without guessing a recommendation", () => {
	assert.deepEqual(problems({ ...review({ ...finding, severity: "blocking" }), recommendation: "maybe" }), ["recommendation: must be one of approve, changes_requested, needs_person"]);
});
test("exactly one summary", () => {
	refuse({ ...review(), blocks: [] }, "a review has exactly one summary; this has 0");
	take(review());
	refuse(review(summary), "a review has exactly one summary; this has 2");
});
const blocking = { ...finding, severity: "blocking" };
for (const [recommendation, good, bad, rule] of [
	["approve", [finding], [blocking, blocking], '"approve" with 2 blocking findings'],
	["changes_requested", [blocking], [finding], '"changes_requested" needs a blocking finding'],
	["needs_person", [question], [finding], '"needs_person" needs a question'],
] as const) test(`recommendation: ${recommendation}`, () => {
	assert.equal(take({ ...review(...good), recommendation }).recommendation, recommendation);
	refuse({ ...review(...bad), recommendation }, `recommendation: ${rule}`);
});

const at = (path: unknown, lines?: unknown) => ({ ...risk, at: [{ path, ...(lines === undefined ? {} : { lines }) }] });
for (const [path, rule] of [[null, "must be text"], ["", "must not be empty"], ["a/../b", 'has ".."'], ["/etc/passwd", "must be repository-relative"], ["C:/outside", "must be repository-relative"], ["https://example.test", "must be repository-relative"], ["x\ny", "must not contain a line break or tab"], ["a\0b", "has a NUL"], ["a\\b", "has a backslash"], ["x".repeat(301), "301 characters; the limit is 300"], [secret, "must name the record or path exactly after cleaning"]] as const) {
	test(`location path: ${rule}`, () => refuse(review(at(path)), `blocks[1].at[0].path: ${rule}`));
}
test("repository path at 300 and a literal pair of dots inside a filename", () => {
	take(review(at("x".repeat(300)), at("src/a..b")));
});
for (const [start, end, rule] of [[0, 1, "start: must be an integer of at least 1"], [2, 1, "end: must not be before the start"], [1.5, 5, "start: must be an integer of at least 1"], [1, "2", "end: must be an integer of at least 1"], [1, Number.MAX_SAFE_INTEGER + 1, "end: must be an integer of at least 1"]] as const) {
	test(`location range: ${start} through ${end}`, () => refuse(review(at("x", { start, end })), `blocks[1].at[0].lines.${rule}`));
}
test("one-based location at 200 lines and one over", () => {
	take(review(at("x", { start: 17, end: 216 })));
	refuse(review(at("x", { start: 17, end: 217 })), "blocks[1].at[0].lines: 200 lines at most; this has 201");
});
test("excerpt requires a range, accepts 40 lines, refuses 41, and takes no code from the author", () => {
	refuse(review({ ...excerpt, at: { path: "x" } }), "blocks[1].at.lines: must give a start and end line");
	const input = (end: number) => review({ ...excerpt, at: { path: "x", side: "base", lines: { start: 2, end } } });
	assert.deepEqual(take(input(41)).blocks[1], { kind: "excerpt", at: { path: "x", side: "base", lines: { start: 2, end: 41 } }, code: "", note: null });
	refuse(input(42), "blocks[1].at.lines: 40 lines at most; this has 41");
});

for (const block of [risk, finding]) test(`five locations per ${block.kind} and one over`, () => {
	const input = (n: number) => review({ ...block, at: repeat(n, () => ({ path: "same" })) });
	take(input(5)); refuse(input(6), "blocks[1].at: 5 locations at most; this has 6");
});
test("20 distinct paths across block kinds and one over", () => {
	const groups = repeat(4, (group) => ({ ...finding, at: repeat(5, (i) => ({ path: `path${group * 5 + i}` })) }));
	take(review(...groups, { ...excerpt, at: { ...excerpt.at, path: "path0" } }));
	refuse(review(...groups, excerpt), "blocks: 20 distinct paths at most; this has 21");
});

for (const block of [prose, finding]) test(`eight refs per ${block.kind} and one over`, () => {
	const input = (n: number) => review({ ...block, refs: repeat(n, () => ({ ref: "ci/0" })) });
	take(input(8)); refuse(input(9), "blocks[1].refs: 8 refs at most; this has 9");
});
test("40 distinct refs across blocks and one over", () => {
	const groups = repeat(5, (group) => ({ ...prose, refs: repeat(8, (i) => ({ ref: `check/${group * 8 + i}` })) }));
	assert.equal(take(review(...groups, { ...finding, refs: [{ ref: "check/39" }] })).records.length, 40);
	refuse(review(...groups, { ...finding, refs: [{ ref: "check/40" }] }), "blocks: 40 distinct refs at most; this has 41");
});
for (const ref of ["ci/7", "command/x/y"]) test(`no usable record ${ref}`, () => refuse(review({ ...prose, refs: [{ ref }] }), `blocks[1].refs[0]: no record "${ref}"`));
test("the claim and the record it names remain separate", () => {
	const refs = [{ ref: "ci/0", says: "failed" }, { ref: "flag/checks_changed", says: "ran" }, { ref: "check/0", says: "not_run" }, { ref: "ci/0", says: "passed" }];
	const ctx = { ...context, records: structuredClone(context.records) };
	const result = take(review({ ...prose, refs }), ctx);
	const source = ctx.records[41];
	if (source.kind === "ci") source.name = "changed later";
	assert.deepEqual(result.blocks[1], { ...prose, heading: null, refs });
	assert.deepEqual(result.records, [context.records[41], context.records[42], context.records[0]]);
});
test("unknown earlier finding or continuation, including a continuation that names this round", () => {
	refuse(review({ ...finding, continues: "r1.f9" }), 'blocks[1].continues: no earlier finding "r1.f9"');
	refuse(review({ ...earlier, finding: "r1.f9" }), 'blocks[1].finding: no earlier finding "r1.f9"');
	refuse(review(finding, { ...finding, continues: "r2.f1" }), 'blocks[2].continues: no earlier finding "r2.f1"');
});
test("each earlier blocker has exactly one answer", () => {
	refuse(review({ ...finding, continues: "r1.f2" }), 'blocks: r1.f2 is blocking and has no "earlier" block', prior);
	for (const status of ["fixed", "withdrawn", "not_fixed"]) take(review({ ...earlier, status }), prior);
	refuse(review(earlier, earlier), 'blocks: r1.f2 is blocking and has 2 "earlier" blocks', prior);
	take(review(), { ...prior, earlier: [{ id: "r1.f3", severity: "note" }] });
});
test("round-local ids, continued root, defaults and repeatable storage", () => {
	const ctx = { ...context, round: 3, earlier: [{ id: "r2.f4", severity: "should_fix", root: "r1.f2" }] };
	const input = review(finding, { ...finding, continues: "r2.f4", at: [{ path: "src/a" }] }, { ...earlier, finding: "r2.f4" });
	const result = take(input, ctx);
	assert.deepEqual(result.blocks, [summary, { ...finding, id: "r3.f1", root: "r3.f1", at: [], refs: [] }, { ...finding, id: "r3.f2", root: "r1.f2", at: [{ path: "src/a", side: "head" }], refs: [] }, { ...earlier, finding: "r2.f4", text: null }]);
	assert.deepEqual(result, take(input, ctx));
});

const filedBuilder = { title: "Builder-only title", description: "Builder-only description", look_at: "Builder-only location", concerns: "Builder-only concern" };
for (const [key, max] of [["title", 120], ["description", 4000], ["look_at", 1000], ["concerns", 4000]] as const) test(`builder: ${key} at ${max} and one over`, () => {
	const parse = (value: unknown) => reportOf({ ...filedBuilder, [key]: value }, redactor);
	const accepted = parse("x".repeat(max) + "\u2028\u0001 \t");
	assert.ok(accepted.ok);
	assert.equal(accepted.report[key === "look_at" ? "lookAt" : key], "x".repeat(max));
	assert.deepEqual(parse("x".repeat(max + 1)), { ok: false, problems: [`${key}: ${(max + 1).toLocaleString("en-US")} characters; the limit is ${max.toLocaleString("en-US")}`] });
	assert.ok(!parse(null).ok);
	const samples = key === "title" ? fragments.map((part) => [`\u0001${secret}\u2028 ${part}`, `${saved} ${part}`]) : [[hostile, cleaned]];
	for (const [raw, expected] of samples) {
		const checked = parse(raw);
		assert.ok(checked.ok);
		assert.equal(checked.report[key === "look_at" ? "lookAt" : key], expected);
	}
});
test("builder title required on one line", () => {
	for (const title of [" \u2028", "two\r\nlines"]) assert.ok(!reportOf({ title }, redactor).ok);
	assert.ok(!reportOf({}, redactor).ok);
});
const builder = reportOf(filedBuilder, redactor);
assert.ok(builder.ok);
const itemReport: ItemReport = { by: "builder", run: 1, head: null, key: "i_test:1:2:0", sessionId: "s_test", at: 1, title: builder.report.title, blocks: reportBlocks(builder.report), records: [] };
test("builder blocks, in order, omit absent parts and never add a summary", () => {
	assert.deepEqual(itemReport.blocks, [{ kind: "text", heading: "What it did", text: filedBuilder.description, refs: [] }, { kind: "text", heading: "Where to look", text: filedBuilder.look_at, refs: [] }, { kind: "risk", text: filedBuilder.concerns, at: [] }]);
	assert.deepEqual(reportBlocks({ title: "Title alone", concerns: "", description: "", lookAt: "" }), []);
});

const verdict: Verdict = { id: "v1", item: "i_test", run: 1, head: "abc123456789", at: 0, place: "hosted", attestedBy: "platform", result: "pass", gate: { state: null, required: [] }, ci: { state: "none", runs: [], said: null }, flags: [], acceptance: ["a criterion"], moved: null, mergeable: true, said: { ci: "", flags: [] } };
for (const recommendation of ["approve", "changes_requested", "needs_person"] as const) test(`comment for ${recommendation} keeps the platform verdict`, () => {
	const checked = take({ ...review(...(recommendation === "changes_requested" ? [blocking] : recommendation === "needs_person" ? [question] : [])), recommendation });
	assert.equal(checked.recommendation, recommendation);
	assert.equal(itemComment(verdict, "Ready for review. CI passed.", null), "<!-- windlass-item:i_test -->\n\n**Windlass at abc1234: Ready for review**\n\nReady for review\\. CI passed\\.\n\nAcceptance criteria left to you:\n\n- a criterion");
});
for (const [result, head] of [["pass", "Ready for review"], ["fail", "Failing"], ["incomplete", "Incomplete: the last turn did not finish"], ["unverified", "Not verified"]] as const) test(`comment headline from ${result}`, () => {
	const body = itemComment({ ...verdict, result, acceptance: [] }, "untrusted headline. more words", null);
	assert.equal(body.split("\n")[2], `**Windlass at abc1234: ${head}**`);
	assert.ok(!body.includes("Acceptance criteria"));
});
test("comment headline follows a moved pull request", () => {
	const moved = { ...verdict, result: "unverified" as const, moved: "def98765" };
	assert.equal(itemComment(moved, verdictWords(moved, null), itemReport).split("\n")[2], "**Windlass at abc1234: Not verified: the pull request has a newer commit**");
});
test("comment escapes mentions, links, images, HTML and headings in words and criteria", () => {
	const body = itemComment({ ...verdict, acceptance: [markup] }, `\u0001${markup}\r\nend`, itemReport);
	const escaped = "\\@octocat \\[x\\]\\(https\\://e\\.example\\) \\!\\[\\]\\(https\\://e\\.example/a\\.png\\) \\<script\\>alert\\(1\\)\\</script\\> \\# Heading";
	assert.equal(body.split(escaped).length, 3);
	assert.ok(!body.includes("](") && !body.includes("\u0001"));
	assert.ok(!/(?<!\\)</.test(body.split("\n").slice(1).join("\n")));
	assert.throws(() => itemComment({ ...verdict, item: "id -->\nspoof" }, "", null), /item id/);
});
test("comment with 70,000 punctuation characters and twenty 1,000-character criteria", () => {
	const body = itemComment({ ...verdict, acceptance: repeat(20, () => "#".repeat(1000)) }, "@".repeat(70_000), itemReport);
	assert.ok(body.length < 60_000);
	assert.equal(body.split("\n")[0], "<!-- windlass-item:i_test -->");
	assert.equal(body.split("\\@").length - 1, 2000);
	assert.equal(body.split("\\#").length - 1, 20_000);
});

test("a maximum-size report shares the comment budget without changing one verdict line", () => {
	const large = reportOf({ title: "*".repeat(120), description: "#".repeat(4000), look_at: "@".repeat(1000), concerns: "!".repeat(4000) }, redactor);
	assert.ok(large.ok);
	const withCriteria = { ...verdict, acceptance: repeat(20, () => "#".repeat(1000)) };
	const words = "@".repeat(2000);
	const body = itemComment(withCriteria, words, { ...itemReport, title: large.report.title, blocks: reportBlocks(large.report) });
	assert.ok(body.startsWith(itemComment(withCriteria, words, null) + "\n\n"));
	assert.ok(body.includes("What the builder is unsure of: ") && body.length <= 60_000 && body.endsWith("…"));
});

const diff: WorkDiff = { files: [], patch: "", config: { before: null, after: null }, packageJson: { before: null, after: null } };
const flagKind = "agent_instructions_changed";
const words = "Instructions for agents were changed in this work";
test("instruction files added, changed, deleted or renamed are listed in the existing flag budget", () => {
	const paths = ["AGENTS.md", "docs/CLAUDE.md", ".claude/settings.json", ".windlass/agents/y.md", ".github/copilot-instructions.md"];
	const files = paths.map((path, i) => ({ status: ["A", "M", "D"][i % 3], path }));
	assert.deepEqual(workFlags({ ...diff, files }, []), [{ kind: flagKind, where: paths }]);
	const renamed = [{ status: "R100", path: ".agents/one", to: ".cursor/rules/two" }];
	assert.deepEqual(workFlags({ ...diff, files: renamed }, []), [{ kind: flagKind, where: [".agents/one", ".cursor/rules/two"] }]);
	assert.deepEqual(workFlags({ ...diff, files: [...files, ...renamed] }, []), [{ kind: flagKind, where: [...paths, "and 2 more"] }]);
});
test("only the checks flag for a change to checks in .windlass/config.json", () => {
	assert.deepEqual(workFlags({ ...diff, files: [{ status: "M", path: ".windlass/config.json" }], config: { before: "{}", after: '{"checks":[{"name":"test","command":"test"}]}' } }, []), [{ kind: "checks_changed", where: [".windlass/config.json"] }]);
	assert.deepEqual(workFlags({ ...diff, files: ["MYAGENTS.md", "CLAUDE.mdx", ".cursor/ruleset/file", ".agents-backup/file", "copilot-instructions.md"].map((path) => ({ status: "M", path })) }, []), []);
});
test("the flag appears in a person's verified section and turns a pass into Needs a look", () => {
	const flags = workFlags({ ...diff, files: [{ status: "A", path: "AGENTS.md" }] }, []);
	assert.equal(flagWords(flagKind), words);
	assert.ok(verifiedSection({ verified: null, flags, during: null, login: "person" }).includes(words));
	const flagged = { ...verdict, flags };
	assert.ok(verdictWords(flagged, null).startsWith("Needs a look."));
	assert.equal(itemComment(flagged, verdictWords(flagged, null), itemReport).split("\n")[2], "**Windlass at abc1234: Needs a look**");
});
console.log(`\n${passed} passed`);
