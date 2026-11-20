// A script yields ACP updates in wire order. Only a delay, permission or steer suspends it.
import { randomUUID } from "node:crypto";

const text = (value) => ({ type: "text", text: value });
const message = (value) => ({ sessionUpdate: "agent_message_chunk", content: text(value) });
const thought = (value) => ({ sessionUpdate: "agent_thought_chunk", content: text(value) });
const output = (value) => [{ type: "content", content: text(value) }];
const call = (kind, title) => ({ toolCallId: randomUUID(), title, kind, status: "pending" });
const progress = (toolCallId, status, content) => ({ sessionUpdate: "tool_call_update", toolCallId, status, content });

const permissionOptions = [
	{ optionId: "allow-once", name: "Yes", kind: "allow_once" },
	{ optionId: "allow-with-updates", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject", name: "No", kind: "reject_once" },
	{ optionId: "reject-always", name: "Always reject", kind: "reject_always" },
];

export const scenarios = {
	*plain() {
		for (const part of ["I'll ", "inspect ", "the files."]) yield thought(part);
		for (const part of ["The ", "files ", "are ", "ready", "."]) yield message(part);
	},
	*tools() {
		const execute = call("execute", "pwd");
		yield { sessionUpdate: "tool_call", ...execute };
		yield progress(execute.toolCallId, "in_progress", output("/workspace"));
		yield progress(execute.toolCallId, "completed");

		const edit = call("edit", "Edit README.md");
		const diff = { type: "diff", path: "/workspace/README.md", oldText: "Draft", newText: "Ready" };
		yield { sessionUpdate: "tool_call", ...edit, content: [diff] };
		yield progress(edit.toolCallId, "failed");
		yield message("The edit failed.");
	},
	*ask() {
		const option = yield { permission: { toolCall: call("execute", "pwd"), options: permissionOptions } };
		if (option.outcome === "cancelled") return "cancelled";
		yield message(`Permission answered: ${option.optionId}.`);
	},
	*plan() {
		const tasks = ["Read the file", "Make the edit", "Check the result"];
		for (let current = 0; current <= tasks.length; current++) {
			const entries = tasks.map((content, index) => ({
				content, priority: "medium", status: index < current ? "completed" : index === current ? "in_progress" : "pending",
			}));
			yield { sessionUpdate: "plan", entries };
		}
	},
	*usage() {
		yield { sessionUpdate: "usage_update", used: 41000, size: 200000, cost: { amount: 0.38, currency: "USD" } };
	},
	*slow() {
		for (const part of ["Starting. ", "Reading. ", "Working. ", "Checking. ", "Finished."]) {
			yield { delay: 300 };
			yield message(part);
		}
	},
	*steer() {
		yield thought("Waiting for a follow-up.");
		const followUp = yield { steer: true };
		yield message(followUp);
	},
	*refuse() { return "refusal"; },
	*maxtokens() { return "max_tokens"; },
	*signedout() { return { error: { code: -32000, message: "Authentication required" } }; },
	*garbage() {
		yield { line: "stray output from the fixture" };
		yield message("Still connected.");
	},
	*secret(value) {
		yield message(value);
		const execute = call("execute", "Print the test value");
		yield { sessionUpdate: "tool_call", ...execute };
		yield progress(execute.toolCallId, "completed", output(value));
	},
};

export function scriptFor(prompt, table) {
	for (const match of prompt.matchAll(/\bsecret:(\S+)|\b([a-z]+)\b/gi)) {
		if (match[1] !== undefined) return table.secret(match[1]);
		const word = match[2].toLowerCase();
		if (word !== "secret" && Object.hasOwn(table, word)) return table[word]();
	}
	return table.plain();
}
