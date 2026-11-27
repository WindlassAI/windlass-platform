import assert from "node:assert/strict";
import { test } from "node:test";
import { extractToken, plainText, scrub } from "../src/token.ts";

const TOKEN = "sk-ant-oat01-" + "Ab3_x-9".repeat(13) + "QQAA";
const wrap = (text: string, width: number) => text.match(new RegExp(`.{1,${width}}`, "g"))!;

test("reads the token off plain output", () => {
	const output = `Your OAuth token (valid for 1 year):\r\n\r\n${TOKEN}\r\n\r\nStore this token securely.\r\n`;
	assert.equal(extractToken(output), TOKEN);
});

test("reads a token wrapped at the terminal's width, inside a box and between colours", () => {
	const pieces = wrap(TOKEN, 38);
	const box = pieces.map(piece => `\x1b[2m│\x1b[22m \x1b[1m${piece.padEnd(38)}\x1b[22m \x1b[2m│\x1b[22m`);
	const output = [
		"\x1b[?25l\x1b[2K\x1b[1A\x1b[2K\x1b[G╭────────────────────────────────────────╮",
		"│ \x1b[32m✓ Long-lived authentication token created\x1b[39m │",
		...box,
		"│                                        │",
		"│ Store this token securely.             │",
		"╰────────────────────────────────────────╯\x1b[?25h",
	].join("\r\r\n");
	assert.equal(extractToken(output), TOKEN);
});

test("does not run the token into the words after it", () => {
	const pieces = wrap(TOKEN, 40);
	const output = [...pieces, "Store", "this token securely."].join("\n");
	// The last piece is shorter than the width, so the wrap ends there.
	assert.equal(extractToken(output), TOKEN);
	const flush = wrap(TOKEN.slice(0, 120), 40);
	assert.equal(extractToken([...flush, "Use it with CLAUDE_CODE_OAUTH_TOKEN"].join("\n")), TOKEN.slice(0, 120));
});

test("redraws: cursor moves separate frames, and the last full token wins", () => {
	const partial = TOKEN.slice(0, 30);
	const output = `${partial}\x1b[1A\x1b[2K${TOKEN}\x1b[1C\x1b[0m`;
	assert.equal(plainText("a\x1b[1Cb\x1b[2Kc\x1b]8;;https://x\x07link\x1b]8;;\x07"), "a b\nclink");
	assert.equal(extractToken(output), TOKEN);
});

test("finds nothing where there is no token", () => {
	assert.equal(extractToken(""), null);
	assert.equal(extractToken("Error: Authentication cancelled.\r\n"), null);
	assert.equal(extractToken("sk-ant-oat01-short\n"), null);
	assert.equal(extractToken("sk-ant-api03-" + "x".repeat(80)), null);
});

test("scrubs Anthropic secrets out of messages", () => {
	assert.equal(scrub(`refused ${TOKEN} and sk-ant-api03-abc`), "refused sk-ant-… and sk-ant-…");
});
