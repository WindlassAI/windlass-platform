import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, appendFileSync } from "node:fs";
const [container, out, answer = "once"] = process.argv.slice(2);
writeFileSync(out, "");
const child = spawn("docker", ["exec", "-i", "-e", "WINDLASS_ACP_SCRIPT=/tmp/script.json", "-w", "/workspace", container, "windlass", "acp"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));
let nextId = 1; const waiting = new Map();
const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject, method }); send({ jsonrpc: "2.0", id, method, params }); });
const t0 = Date.now(); const at = () => `${String(Date.now() - t0).padStart(5)}ms`;
let steered = false; let sessionId;
createInterface({ input: child.stdout }).on("line", (line) => {
	let msg; try { msg = JSON.parse(line); } catch { console.log("non-json:", line.slice(0, 200)); return; }
	if (msg.id !== undefined && msg.method === undefined) {
		const w = waiting.get(msg.id); waiting.delete(msg.id);
		if (msg.error) { console.log(`${at()} <- error for ${w?.method}: ${JSON.stringify(msg.error).slice(0, 400)}`); w?.reject(new Error(msg.error.message)); }
		else { console.log(`${at()} <- result of ${w?.method}: ${JSON.stringify(msg.result).slice(0, 700)}`); w?.resolve(msg.result); }
	} else if (msg.method === "_windlass/event") {
		const e = msg.params.event; appendFileSync(out, JSON.stringify(e) + "\n");
		if (!["text.delta", "reasoning.delta", "tool.input.delta"].includes(e.type)) console.log(`${at()}    event ${e.type}${e.seq ? ` #${e.seq}` : ""}${e.type === "tool.progress" ? ` ${JSON.stringify(e.text)}` : ""}`);
		if (e.type === "tool.started" && e.data?.callId === "c2" && !steered) { steered = true; console.log(`${at()} -> steer (second session/prompt)`); request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Also, keep it short." }] }).catch(() => {}); }
	} else if (msg.method === "session/request_permission") {
		console.log(`${at()} <- REQUEST session/request_permission id=${msg.id}\n${JSON.stringify(msg.params, null, 1).slice(0, 2600)}`);
		setTimeout(() => { console.log(`${at()} -> answer ${answer}`); send({ jsonrpc: "2.0", id: msg.id, result: answer === "cancel" ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: answer }, _meta: { windlass: { note: answer === "deny" ? "not now" : undefined } } } }); }, 1200);
	} else if (msg.method) console.log(`${at()} <- ${msg.id !== undefined ? "REQUEST" : "notification"} ${msg.method} ${JSON.stringify(msg.params).slice(0, 260)}`);
});
const init = await request("initialize", { protocolVersion: 1, clientInfo: { name: "wlp-probe", version: "0" }, clientCapabilities: { _meta: { windlass: { events: true, updates: false } } } });
const made = await request("session/new", { cwd: "/workspace", mcpServers: [], _meta: { windlass: { approval: "auto", attended: true } } });
sessionId = made.sessionId;
const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Fetch the response headers of example.com" }] });
await request("session/close", { sessionId }).catch((e) => console.log("close failed:", e.message));
child.stdin.end();
child.on("exit", (code, signal) => { console.log(`${at()} windlass acp exited code=${code} signal=${signal}`); process.exit(0); });
setTimeout(() => { console.log("timeout"); child.kill("SIGKILL"); process.exit(1); }, 60000);
