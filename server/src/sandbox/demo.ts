/**
 * Scripted models for demo turns (WINDLASS_ACP_SCRIPT): short scenarios of real tool calls that do
 * something visible in the workspace. No model is called; the tools really run in the sandbox.
 *
 * Every scenario works in a sandbox whose commands have no network (`docker-windlass-sandbox`) and in
 * an unsandboxed container alike, and does not depend on what earlier turns left in the workspace. One
 * of them asks for the network, which is a question to the user where commands are sandboxed.
 *
 * A scripted model cannot read what it is told: it plays its responses in order, one per model call.
 * So every text is worded to be right whatever the user did meanwhile (allowed a call or declined it,
 * stopped a command, sent a message), and every script ends with spare answers: a message steered in
 * while the last planned response plays makes Windlass call the model once more, and a script with no
 * response left for that call fails the turn after half a minute of retries.
 */

import { randomBytes } from "node:crypto";
import type { ScriptedModel } from "./api.js";

type Item = Record<string, unknown>;

interface Builder {
	/** One model call. */
	step(build: (step: Step) => void): void;
}

interface Step {
	think(text: string): void;
	say(text: string): void;
	call(name: string, input: Record<string, unknown>): void;
	pause(ms: number): void;
}

/** How many model calls beyond the planned ones every script has an answer for. */
export const DEMO_SPARE_ANSWERS = 2;

/** What the model says when it is called again after its last planned response: each a single item, so a single paragraph. */
const SPARE_ANSWERS = [
	"I've seen your message. This demo plays a fixed script, so I can't act on it here: everything above ran as planned. With a ChatGPT sign-in the model reads what you send and changes course.",
	"Noted as well. There is nothing more for me to do in this turn.",
];

/** Builds a script whose usage figures grow like a real conversation's, with a warm prompt cache after the first call. */
function script(turn: number, build: (b: Builder) => void): ScriptedModel {
	const responses: Item[][] = [];
	let context = 7400 + Math.min(turn - 1, 20) * 2600;
	let calls = 0;
	const builder: Builder = {
		step(fill) {
			const items: Item[] = [];
			let tools = 0;
			let written = 0;
			fill({
				think(text) {
					// One item per thought and per answer: each scripted item is a part of its own in Windlass's log,
					// so splitting a text over several items would show it as several separate paragraphs.
					items.push({ type: "delay", ms: 350 }, { type: "reasoning", text }, { type: "delay", ms: thinkingTime(text) });
					written += Math.ceil(text.length / 4);
				},
				say(text) {
					items.push({ type: "text", text }, { type: "delay", ms: thinkingTime(text) });
					written += Math.ceil(text.length / 4);
				},
				call(name, input) {
					calls += 1;
					tools += 1;
					items.push({ type: "delay", ms: 300 }, { type: "tool_call", callId: `call_${turn}_${calls}`, name, input });
					written += Math.ceil(JSON.stringify(input).length / 4);
				},
				pause(ms) {
					items.push({ type: "delay", ms });
				},
			});
			const first = responses.length === 0;
			// The first call of a turn reuses the cache of the previous turn (none on turn 1); later calls re-read all but the newest part.
			const cached = first ? (turn === 1 ? 0 : Math.floor((context - 1200) / 128) * 128) : Math.floor((context - 900) / 128) * 128;
			items.push({ type: "usage", inputTokens: context, cachedInputTokens: Math.max(0, cached), outputTokens: written + 18, reasoningTokens: Math.round(written * 0.6) + 32 });
			items.push({ type: "finish", reason: tools > 0 ? "tool_calls" : "stop" });
			context += written + 420 * Math.max(tools, 1);
			responses.push(items);
		},
	};
	build(builder);
	for (const answer of SPARE_ANSWERS.slice(0, DEMO_SPARE_ANSWERS)) builder.step((s) => s.say(answer));
	return { responses };
}

/** A pause after a text that grows with its length, as if it had taken that long to write. */
function thinkingTime(text: string): number {
	return Math.min(1400, 250 + text.length * 4);
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

const PRIMES = `#!/usr/bin/env python3
"""Print the prime numbers up to a limit, using a sieve of Eratosthenes."""
import sys


def primes_up_to(limit: int) -> list[int]:
    if limit < 2:
        return []
    sieve = [True] * (limit + 1)
    sieve[0] = sieve[1] = False
    for n in range(2, int(limit ** 0.5) + 1):
        if sieve[n]:
            sieve[n * n :: n] = [False] * len(sieve[n * n :: n])
    return [n for n, is_prime in enumerate(sieve) if is_prime]


if __name__ == "__main__":
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    found = primes_up_to(limit)
    print(f"{len(found)} primes up to {limit}:")
    print(" ".join(str(n) for n in found))
`;

function writeAndRun(turn: number): ScriptedModel {
	return script(turn, (b) => {
		b.step((s) => {
			s.think("The user wants a small program. A prime sieve in Python is short, needs nothing installed, and is easy to check.");
			s.say("I'll write a small Python program that lists prime numbers with a sieve, then run it.");
			s.call("write", { path: "primes.py", content: PRIMES });
		});
		b.step((s) => {
			s.pause(500);
			s.say("Now let me run it for a couple of limits.");
			s.call("shell", { command: "python3 primes.py 30 && python3 primes.py 100 | head -1" });
		});
		b.step((s) => {
			s.think("25 primes below 100 and 10 below 30 are both right.");
			s.say(
				"I wrote `primes.py`, a sieve of Eratosthenes that prints every prime up to a limit (default 50), and ran it: it finds the 10 primes up to 30 (2 through 29) and 25 primes up to 100, which matches the known counts. Run it with `python3 primes.py <limit>`.",
			);
		});
	});
}

const SLUGIFY_BUGGY = `// Turns a title into a URL slug: "Hello, World!" -> "hello-world".
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

module.exports = { slugify };
`;

const SLUGIFY_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { slugify } = require("./slugify.js");

test("lowercases and joins words", () => {
  assert.strictEqual(slugify("Hello World"), "hello-world");
});

test("drops punctuation at the ends", () => {
  assert.strictEqual(slugify("  Hello, World!  "), "hello-world");
});
`;

function fixFailingTest(turn: number): ScriptedModel {
	return script(turn, (b) => {
		b.step((s) => {
			s.think("Set up a tiny module with its tests, so there is something real to run.");
			s.say("I'll start with a small `slugify` module and its tests, then run them.");
			s.call("write", { path: "slugify/slugify.js", content: SLUGIFY_BUGGY });
			s.call("write", { path: "slugify/slugify.test.js", content: SLUGIFY_TEST });
		});
		b.step((s) => {
			// The echo and the pause give the command output that arrives before it ends, as a real test run does:
			// it shows as a live tail in the interface, and a client that connects meanwhile is served it.
			s.call("shell", { command: "cd slugify && echo 'running the tests in slugify/ ...' && sleep 2 && node --test 2>&1 | tail -n 25" });
		});
		b.step((s) => {
			s.think("The second test fails: leading and trailing punctuation turn into dashes at the ends. The replace needs a trim of the dashes afterwards.");
			s.say("One test fails: `\"  Hello, World!  \"` becomes `-hello-world-`. Let me look at the code.");
			s.call("read", { path: "slugify/slugify.js" });
		});
		b.step((s) => {
			s.say("The dashes at both ends need trimming after the replace.");
			s.call("edit", {
				path: "slugify/slugify.js",
				old_string: '    .replace(/[^a-z0-9]+/g, "-");',
				new_string: '    .replace(/[^a-z0-9]+/g, "-")\n    .replace(/^-+|-+$/g, "");',
			});
		});
		b.step((s) => {
			s.call("shell", { command: "cd slugify && node --test 2>&1 | grep -E '^# (tests|pass|fail)'" });
		});
		b.step((s) => {
			s.say(
				"Fixed. The test `drops punctuation at the ends` failed because `slugify` turned leading and trailing punctuation into dashes (`-hello-world-`). I added a second replace that trims dashes at both ends in `slugify/slugify.js`; both tests now pass.",
			);
		});
	});
}

const PRICES = `function formatPrice(cents) {
  return "$" + (cents / 100).toFixed(2);
}

module.exports = { formatPrice };
`;

const CART = `const { formatPrice } = require("./format.js");

const items = [
  { name: "Notebook", cents: 450, qty: 2 },
  { name: "Pen", cents: 120, qty: 5 },
];

for (const item of items) {
  console.log(item.name.padEnd(10) + formatPrice(item.cents * item.qty));
}
const total = items.reduce((sum, item) => sum + item.cents * item.qty, 0);
console.log("Total".padEnd(10) + formatPrice(total));
`;

function searchAndEdit(turn: number): ScriptedModel {
	return script(turn, (b) => {
		b.step((s) => {
			s.think("Create a small two-file project that uses a helper, then rename the helper everywhere it is used.");
			s.say("I'll set up a tiny shop module with a price formatter, then rename `formatPrice` to `formatMoney` everywhere.");
			s.call("write", { path: "shop/format.js", content: PRICES });
			s.call("write", { path: "shop/cart.js", content: CART });
		});
		b.step((s) => {
			s.say("First, every place that uses the old name:");
			s.call("grep", { pattern: "formatPrice", path: "shop" });
		});
		b.step((s) => {
			s.say("Five uses in two files. Renaming them:");
			s.call("edit", { path: "shop/format.js", old_string: "formatPrice", new_string: "formatMoney", replace_all: true });
			s.call("edit", { path: "shop/cart.js", old_string: "formatPrice", new_string: "formatMoney", replace_all: true });
		});
		b.step((s) => {
			s.say("Checking nothing still uses the old name, and that the cart still prints:");
			s.call("shell", { command: "grep -rn formatPrice shop || echo 'no uses of formatPrice left'; node shop/cart.js" });
		});
		b.step((s) => {
			s.say(
				"Renamed `formatPrice` to `formatMoney` in `shop/format.js` (definition and export) and `shop/cart.js` (import and two calls). A search finds no use of the old name, and `node shop/cart.js` still prints the cart with a total of $15.00.",
			);
		});
	});
}

const STATS_ESM = `import { argv } from "node:process";

const numbers = argv.slice(2).map(Number);
const sum = numbers.reduce((a, b) => a + b, 0);
const mean = sum / numbers.length;
const sorted = [...numbers].sort((a, b) => a - b);
const mid = Math.floor(sorted.length / 2);
const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
console.log(\`count \${numbers.length}  sum \${sum}  mean \${mean.toFixed(2)}  median \${median}\`);
`;

function failThenCorrect(turn: number): ScriptedModel {
	return script(turn, (b) => {
		b.step((s) => {
			s.think("A small statistics script in Node. I'll write it with an ES module import.");
			s.say("I'll write a small Node script that prints the count, sum, mean and median of its arguments.");
			s.call("write", { path: "stats/stats.js", content: STATS_ESM });
		});
		b.step((s) => {
			s.call("shell", { command: "node stats/stats.js 4 8 15 16 23 42" });
		});
		b.step((s) => {
			s.think("Node treats a .js file without a package.json \"type\" as CommonJS, so the import statement is a syntax error. Renaming to .mjs makes it an ES module without touching anything else.");
			s.say("That failed: Node reads a plain `.js` file as CommonJS, where `import` is not allowed. Renaming the file to `.mjs` makes it an ES module.");
			s.call("shell", { command: "mv stats/stats.js stats/stats.mjs && node stats/stats.mjs 4 8 15 16 23 42" });
		});
		b.step((s) => {
			s.say(
				"Done. The first run failed with `Cannot use import statement outside a module`, because Node treats `.js` files as CommonJS when there is no `package.json` saying otherwise. I renamed the script to `stats/stats.mjs`, and `node stats/stats.mjs 4 8 15 16 23 42` now prints count 6, sum 108, mean 18.00 and median 15.5.",
			);
		});
	});
}

function exploreWorkspace(turn: number): ScriptedModel {
	return script(turn, (b) => {
		b.step((s) => {
			s.think("Look at what is in the workspace and its git state before writing anything.");
			s.say("Let me look around the workspace first.");
			s.call("ls", {});
			s.call("shell", { command: "git status --short | head -20; echo '---'; git log --oneline -5" });
		});
		b.step((s) => {
			s.say("And what tools this sandbox offers:");
			s.call("shell", { command: "echo \"python $(python3 --version 2>&1 | cut -d' ' -f2), node $(node --version), git $(git --version | cut -d' ' -f3), rg $(rg --version | head -1 | cut -d' ' -f2)\"; echo \"files: $(git ls-files --others --exclude-standard | wc -l) untracked, $(git ls-files | wc -l) tracked\"" });
		});
		b.step((s) => {
			s.say("I'll write what I found down in a notes file.");
			s.call("shell", {
				command:
					"{ echo '# Workspace notes'; echo; echo \"Written on $(date -u +%Y-%m-%d) by the demo agent.\"; echo; echo '## Files'; echo; (git ls-files --others --exclude-standard; git ls-files) | grep -v '^NOTES.md$' | sort -u | sed 's/^/- /'; echo; echo '## Tools'; echo; echo \"- python $(python3 --version 2>&1 | cut -d' ' -f2)\"; echo \"- node $(node --version)\"; } > NOTES.md && cat NOTES.md",
			});
		});
		b.step((s) => {
			s.say(
				"I looked through the workspace: its files, the git history and the tools available here (Python, Node, git and ripgrep). I wrote a summary to `NOTES.md` with the list of files and tool versions, so the next step can start from it.",
			);
		});
	});
}

/** The address the question scenario asks about: a site reserved for examples, which answers anyone. */
const EXAMPLE_URL = "https://example.com";

/**
 * A command that needs the network. Where commands are sandboxed (approval `auto`) Windlass asks the
 * user first; where they are not (`full`) it runs at once. Nothing here knows the answer, so the
 * second command finds out from what the first left behind, and the closing text covers both.
 */
function askForNetwork(turn: number): ScriptedModel {
	// A file name of this run's own: the second command tells from it whether the request ran, which a
	// `headers.txt` left by an earlier turn could not say.
	const file = `headers-${randomBytes(2).toString("hex")}.txt`;
	return script(turn, (b) => {
		b.step((s) => {
			s.think("The response headers of a web page: one HEAD request with curl does it. Commands in a sandbox have no network unless it is asked for, so the call asks.");
			s.say(`I'll request the response headers of ${EXAMPLE_URL}. That needs network access, so I'm asking for it.`);
			// The pipeline ends with head, so a request that fails (no route, no DNS) is reported by curl's own message and not as a failed call.
			s.call("shell", { command: `curl -sS -I --max-time 10 ${EXAMPLE_URL} | tee ${file} | head -n 12`, sandbox: { network: true } });
		});
		b.step((s) => {
			s.pause(400);
			s.say("Checking the result.");
			s.call("shell", {
				command: `if [ -s ${file} ]; then echo "The request ran: $(grep -c ":" ${file}) header lines saved to ${file}."; echo "Status: $(head -n 1 ${file} | tr -d "\\r")"; grep -i -E "^(content-type|server|date):" ${file} | tr -d "\\r"; else echo "The request did not run, or got no answer: no headers were saved."; fi`,
			});
		});
		b.step((s) => {
			s.think("Report the outcome and where the headers are kept.");
			s.say(`Done. The check above shows the outcome, and any headers received are saved in \`${file}\`.`);
		});
	});
}

/**
 * A command that takes about twelve seconds and prints a line a second: time enough to send the agent
 * a message or to stop only that command. The step after it reports from the log the command wrote,
 * so it is right whether the command ran to its end or was stopped.
 */
function longCommand(turn: number): ScriptedModel {
	return script(turn, (b) => {
		b.step((s) => {
			s.think("A build that takes a while and reports as it goes. A loop that sleeps stands in for the compiler; a log keeps what it printed.");
			s.say("I'll run a build that takes about twelve seconds and prints its progress. You can send me a message while it runs, or stop just this command.");
			s.call("shell", {
				command:
					'mkdir -p build && : > build/build.log && for i in $(seq 1 12); do echo "[$i/12] compiling module $i" | tee -a build/build.log; sleep 1; done && echo "build finished: 12 modules" | tee -a build/build.log',
			});
		});
		b.step((s) => {
			s.pause(400);
			s.say("Checking how far it got.");
			s.call("shell", {
				command:
					'n=$(grep -c compiling build/build.log 2>/dev/null || true); if grep -q "build finished" build/build.log 2>/dev/null; then echo "The build completed: all 12 modules."; else echo "The build stopped early: ${n:-0} of 12 modules were compiled."; fi',
			});
		});
		b.step((s) => {
			s.say(
				"Done. The line above shows how far the build got, and its full output is in `build/build.log`.",
			);
		});
	});
}

const SCENARIOS: Array<{ words: RegExp; build: (turn: number) => ScriptedModel }> = [
	// These two first: their words decide even when a later scenario's word is in the prompt too ("build a program").
	{ words: /\b(network|fetch|downloads?|curl|https?|headers?|websites?|urls?)\b/, build: askForNetwork },
	{ words: /\b(long|slow|build|progress|wait)\b/, build: longCommand },
	{ words: /\b(tests?|failing|fix|bug|broken)\b/, build: fixFailingTest },
	{ words: /\b(search|grep|rename|refactor|replace|find)\b/, build: searchAndEdit },
	{ words: /\b(error|fails?|debug|crash|stats?|statistics|median|node)\b/, build: failThenCorrect },
	{ words: /\b(explore|look|explain|summari[sz]e|describe|status|what|notes?|overview)\b/, build: exploreWorkspace },
	{ words: /\b(write|program|script|create|python|primes?)\b/, build: writeAndRun },
];

/** The rotation when the prompt suggests nothing: a varied first impression. The two scenarios that need the user's attention are only ever asked for. */
const ROTATION = [writeAndRun, fixFailingTest, searchAndEdit, failThenCorrect, exploreWorkspace];

export function demoScript(prompt: string, turn: number): ScriptedModel {
	const text = prompt.toLowerCase();
	const n = Math.max(1, Math.floor(turn));
	const matched = SCENARIOS.find((scenario) => scenario.words.test(text));
	return (matched?.build ?? ROTATION[(n - 1) % ROTATION.length]!)(n);
}

/** Every scenario by name, for tests. */
export const DEMO_SCENARIOS = { writeAndRun, fixFailingTest, searchAndEdit, failThenCorrect, exploreWorkspace, askForNetwork, longCommand };
