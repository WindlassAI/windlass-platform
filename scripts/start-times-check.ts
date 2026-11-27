/**
 * The start clock (server/src/start-times.ts): which parts a record has for a new and a connected sandbox,
 * that the runner's figures and the relay are kept, that a turn without output still keeps what it measured,
 * that the session keeps the last few, and that the log line holds durations and names only.
 *
 *   cd server && npx tsx ../scripts/start-times-check.ts
 */
import assert from "node:assert/strict";
import type { StartTimes } from "../server/src/contract.js";
import { START_TIMES_KEPT, StartClock, keepStartTimes, startTimesLog } from "../server/src/start-times.js";

let now = 1_000;
const tick = (ms: number) => (now += ms);
const clock = (turn: number, place: StartTimes["place"], waited: number | null, out: StartTimes[]) =>
	new StartClock(
		turn,
		"windlass",
		place,
		waited,
		times => out.push(times),
		() => now,
	);

// A new sandbox on a machine: every part, in order.
{
	const done: StartTimes[] = [];
	now = 1_000;
	const c = new StartClock(
		1,
		"claude",
		"machine",
		4_000,
		times => done.push(times),
		() => now,
	);
	tick(2_500);
	c.sandbox(2_500, true, { image: 900, pulled: true, create: 1_200 });
	tick(3_000);
	c.opened();
	tick(400);
	c.mark("relay", 250.4);
	c.mark("process");
	tick(1_300);
	c.mark("initialized");
	tick(1_700);
	c.mark("prompted");
	tick(2_100);
	c.mark("output");
	c.mark("output");
	c.finish();
	assert.equal(done.length, 1, "handed over once");
	const [t] = done;
	assert.equal(t.newSandbox, true);
	assert.deepEqual(
		{
			waited: t.waited,
			image: t.image,
			pulled: t.pulled,
			sandbox: t.sandbox,
			runnerCreate: t.runnerCreate,
			setup: t.setup,
			prepare: t.prepare,
			relay: t.relay,
			agent: t.agent,
			session: t.session,
			firstOutput: t.firstOutput,
		},
		{
			waited: 4_000,
			image: 900,
			pulled: true,
			sandbox: 2_500,
			runnerCreate: 1_200,
			setup: 3_000,
			prepare: 400,
			relay: 250,
			agent: 1_300,
			session: 1_700,
			firstOutput: 2_100,
		},
	);
	const line = startTimesLog("ses_1", t);
	assert.match(
		line,
		/^\[wlp\] session\.start_times session=ses_1 turn=1 harness=claude place=machine new=true pulled=true waited_ms=4000 image_ms=900 sandbox_ms=2500 runnerCreate_ms=1200 setup_ms=3000 prepare_ms=400 relay_ms=250 agent_ms=1300 session_ms=1700 firstOutput_ms=2100 total_ms=\d+$/,
	);
	console.log("ok  a new sandbox's start has every part, once, and its log line names durations only");
}

// A connected sandbox: no image, no runner figures, no short setup, no slot wait under a second.
{
	const done: StartTimes[] = [];
	const c = clock(2, "hosted", 300, done);
	tick(150);
	c.sandbox(150, false, { image: 1, create: 1 });
	tick(20);
	c.opened();
	c.mark("process");
	tick(700);
	c.mark("initialized");
	c.mark("prompted");
	tick(900);
	c.mark("output");
	const [t] = done;
	assert.equal(t.newSandbox, false);
	for (const key of ["waited", "image", "pulled", "runnerCreate", "setup", "relay"] as const)
		assert.equal(t[key], undefined, key);
	assert.equal(t.sandbox, 150);
	assert.equal(t.firstOutput, 900);
	console.log("ok  a connected sandbox's start leaves out what did not happen");
}

// A turn that failed before any output keeps what it measured; one that never reached a sandbox keeps nothing.
{
	const done: StartTimes[] = [];
	const c = clock(3, "e2b", null, done);
	c.sandbox(5_000, true);
	c.opened();
	c.mark("process");
	tick(20_000);
	c.finish();
	assert.equal(done.length, 1);
	assert.equal(done[0].total, undefined);
	assert.equal(done[0].agent, undefined);
	assert.equal(done[0].place, "e2b");
	const none: StartTimes[] = [];
	clock(4, "hosted", null, none).finish();
	assert.equal(none.length, 0);
	console.log("ok  a turn without output keeps what it measured, and one without a sandbox keeps nothing");
}

// The session keeps the last few, oldest first.
{
	let kept: StartTimes[] | undefined;
	for (let turn = 1; turn <= START_TIMES_KEPT + 2; turn++)
		kept = keepStartTimes(kept, { turn, at: turn, harness: "windlass", place: "hosted", newSandbox: turn === 1 });
	assert.deepEqual(
		kept!.map(t => t.turn),
		[3, 4, 5, 6, 7],
	);
	console.log("ok  the session keeps the last five starts");
}
