// Run from the repository root. The public connection and demo sign-in are the same ones the web app uses.
import { loginHttp } from "./login-http.js";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createClient, type Registry } from "../server/src/client.js";
import type { PlatformConnection, TimelineItem } from "../server/src/contract.js";
import { StandInRunner, assert, until } from "./runner-standin.js";

const { values } = parseArgs({ options: {
  origin: { type: "string", default: "http://127.0.0.1:16440" },
  project: { type: "string", default: "wlp-staging" },
  sessions: { type: "string", default: "4" }, minutes: { type: "string", default: "25" },
  interval: { type: "string", default: "10" }, baseline: { type: "string", default: "60" },
  burners: { type: "boolean" }, proof: { type: "string" }, verify: { type: "string" },
} });
function number(raw: string, min: number, max: number) {
  const value = Number(raw);
  assert(Number.isFinite(value) && value >= min && value <= max, "Argument outside its supported range");
  return value;
}
const count = number(values.sessions, 1, 100);
assert(Number.isInteger(count), "Sessions must be an integer");
const duration = number(values.minutes, 0.05, 50) * 60_000;
const interval = number(values.interval, 5, 15) * 1000;
const baseline = number(values.baseline, 5, 600) * 1000;
const origin = new URL(values.origin);
assert(origin.origin === values.origin && origin.hostname === "127.0.0.1", "Use the loopback HTTP origin of the test stack");
const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 45_000 }).trim();
function container(service: string) {
  const id = docker("ps", "-q", "--filter", "label=com.docker.compose.project=" + values.project, "--filter", "label=com.docker.compose.service=" + service);
  assert(/^[a-f0-9]{12}$/.test(id), "Expected one running " + service + " in the selected project");
  return id;
}
async function get(path: string) {
  const res = await fetch(new URL(path, origin), { redirect: "error", signal: AbortSignal.timeout(30_000) });
  assert(res.ok, "HTTP " + res.status);
  return res;
}
const engine = container("engine"), server = container("server");
assert(docker("port", server, "6440/tcp") === origin.host, "Project and HTTP port must match");
const info = await (await get("/platform/info")).json();
assert(info.demoEnabled && info.machines, "Load requires demo sign-in and machines");
const connection = async (): Promise<PlatformConnection> => (await get("/platform/connection")).json();
const discovery = await connection();
assert(discovery.endpoint && new URL(discovery.endpoint).hostname === "127.0.0.1", "Use a loopback gateway");
assert(docker("port", engine, "6420/tcp") === new URL(discovery.endpoint).host, "Project and gateway port must match");
const credentials = { namespace: discovery.namespace, getToken: async () => (await connection()).token?.token ?? "default" };
const client = createClient<Registry>({ endpoint: discovery.endpoint, ...credentials, disableMetadataLookup: true });
const digest = (items: TimelineItem[]) => createHash("sha256").update(JSON.stringify(items)).digest("hex");
if (values.verify) {
  const { uid, token, id, hash, items } = JSON.parse(readFileSync(values.verify, "utf8"));
  const list = await client.user.get([uid], { params: { token } }).listSessions();
  assert(list.some(s => s.id === id), "Session absent from restored user");
  const { timeline } = await client.agentSession.get([uid, id], { params: { token } }).snapshot();
  assert(digest(timeline.slice(0, items)) === hash, "Restored timeline differs");
  console.log("Restored user lists the session; verified timeline items:", items, "sha256:", hash);
  process.exit(0);
}

const fake = docker("inspect", "--format", '{{range .Config.Env}}{{if eq . "WLP_SANDBOX=fake"}}yes{{end}}{{end}}', server);
assert(fake === "yes", "The load target must use fake sandboxes");
const image = docker("inspect", "--format", "{{.Image}}", server);
const initialRestarts = [engine, server].map(id => Number(docker("inspect", "--format", "{{.RestartCount}}", id)));
let phase = "setup";
const logCounts: Record<string, number> = {};
const stallMessages = ["UPS buffer is near full", "topology heartbeat renewal is late", "fenced this worker", "panicked", "out of memory"];
const diagnosticMessages = ["could not suspend the idle sandbox", "Envoy connection closed", "failed to parse close reason", "connection already disconnected", "http error response", "action error", "unhandled action promise rejection"];
function follow(id: string, service: string) {
  const child = spawn("docker", ["logs", "--follow", "--since", new Date().toISOString(), id], { stdio: ["ignore", "pipe", "pipe"] });
  for (const pipe of [child.stdout, child.stderr]) createInterface({ input: pipe }).on("line", line => {
    // Keep diagnostic classes only. SDK lines can contain authenticated socket URLs.
    const marker = stallMessages.find(m => line.toLowerCase().includes(m.toLowerCase()));
    const severity = /\blevel[=: ]+"?(error|fatal|warn)\b/i.exec(line)?.[1]?.toLowerCase()
      ?? (/\b(error|exception|unhandled rejection)\b/i.test(line) && !line.includes("level=info") ? "error-like" : undefined);
    if (marker || severity) {
      const diagnostic = diagnosticMessages.find(m => line.includes(m));
      const key = [phase, service, severity, marker ?? diagnostic].filter(Boolean).join("/");
      logCounts[key] = (logCounts[key] ?? 0) + 1;
    }
  });
  return child;
}
const logs = [follow(engine, "engine"), follow(server, "server")];
const scratch = mkdtempSync(".data/selfhost/load-");
const burners: string[] = [];
let stop = false, updates = 0;
const runner = new StandInRunner(values.origin, discovery.endpoint, { claude: true, stateDir: scratch,
  ...credentials, onAcpUpdate: () => updates++ });
const dispose: Array<() => Promise<unknown>> = [];
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stop = true; process.exitCode = 1; });
type Stat = { ms: number[]; errors: number };
const samples: Record<string, Record<string, Stat>> = {};
async function deadline<T>(action: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([action, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("Request timed out")), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function measure(group: string, name: string, read: () => Promise<unknown>) {
  const stat = (samples[group] ??= {})[name] ??= { ms: [], errors: 0 };
  const start = performance.now();
  try {
    await deadline(read(), 30_000);
    stat.ms.push(Math.round(performance.now() - start));
  } catch { stat.errors++; }
}
function summary() {
  for (const [group, reads] of Object.entries(samples)) {
    const all = Object.values(reads);
    const combined = { ms: all.flatMap(read => read.ms), errors: all.reduce((n, read) => n + read.errors, 0) };
    for (const [probe, { ms, errors }] of Object.entries({ ...reads, combined })) {
      ms.sort((a, b) => a - b);
      const pct = (p: number) => ms[Math.ceil(ms.length * p) - 1] ?? null;
      console.log(JSON.stringify({ phase: group, probe, ok: ms.length, errors, p50: pct(.5), p95: pct(.95), max: pct(1) }));
    }
  }
}
try {
  const { profile: { uid }, token } = await loginHttp(values.origin).demo();
  const user = client.user.get([uid], { params: { token } });
  await runner.pair(user);
  await runner.connectControl();
  const place = { kind: "machine" as const, machineId: runner.id.machineId };
  await until("machine report", async () => (await user.machines()).find(m => m.machineId === place.machineId && m.commandSandbox));
  async function createSession() {
    const { id } = await user.createSession({ harness: "claude", profile: "docker-hardened", place });
    const handle = client.agentSession.get([uid, id], { params: { token } });
    const conn = handle.connect();
    dispose.push(() => conn.dispose());
    let deltas = 0;
    conn.on("delta", () => deltas++);
    let ended: Extract<TimelineItem, { kind: "turn.ended" }> | undefined;
    conn.on("item", raw => {
      const item = raw as TimelineItem;
      if (item.kind === "turn.ended") ended = item;
    });
    await deadline(conn.snapshot(), 30_000);
    return { id, handle, conn, turns: 0, failures: 0, deltas: () => deltas, ended: () => ended };
  }
  const sessions: Awaited<ReturnType<typeof createSession>>[] = [];
  for (let i = 0; i < count; i++) sessions.push(await createSession());
  let index = 0;
  const pending = new Set<Promise<void>>();
  function probe(group: string) {
    const session = sessions[index++ % sessions.length]!;
    const p = Promise.all([
      measure(group, "page", async () => assert((await (await get("/")).text()).toLowerCase().includes("<!doctype html>"), "Expected HTML")),
      measure(group, "listSessions", () => user.listSessions()),
      measure(group, "models", () => user.models()),
      measure(group, "snapshot", () => session.handle.snapshot()),
    ]).then(() => {});
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  async function sampleFor(ms: number, group: (elapsed: number) => string) {
    const start = performance.now();
    for (let next = 0; next < ms && !stop; next += interval) {
      phase = group(performance.now() - start);
      probe(phase);
      if (next % 60_000 === 0) console.log(new Date().toISOString(), phase, "ACP updates", updates);
      await sleep(Math.max(0, Math.min(next + interval, ms) - (performance.now() - start)));
    }
  }
  await sampleFor(baseline, () => "idle");
  for (let i = 0; values.burners && i < count && !stop; i++) {
    const id = docker("create", "--label", "com.docker.compose.project=", "--label", "com.docker.compose.service=", "--network", "none", "--name", "wlp-load-" + randomUUID(), "--cpus", "1.5", "--cpu-shares", "256", "--memory", "1536m", image, "sh", "-c", "while :; do :; done");
    burners.push(id);
    docker("start", id);
  }
  const start = Date.now(), end = start + duration;
  console.log("Load started", new Date(start).toISOString(), "sessions", count, "burners", burners.length);
  const workers = sessions.map(async session => {
    while (!stop && Date.now() < end) {
      try {
        const { turn } = await deadline(session.conn.prompt({ text: "stream" }), 30_000);
        const ended = await until("turn completion", () => session.ended()?.turn === turn && session.ended(), 45_000);
        assert(ended.outcome === "succeeded", ended.message ?? ended.outcome);
        session.turns++;
      } catch (error) {
        if (!session.failures) console.error("Turn failed:", (error as Error).message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 180));
        session.failures++;
        await sleep(1000);
      }
    }
  });
  await sampleFor(duration, elapsed => elapsed < 900_000 ? "load-first-15m" : "load-after-15m");
  await Promise.all(workers);
  while (burners.length) {
    docker("rm", "-f", burners[burners.length - 1]!);
    burners.pop();
  }
  console.log("Load ended", new Date().toISOString(), JSON.stringify({ updates, sessions: sessions.map(({ turns, failures, deltas }) => ({ turns, failures, deltas: deltas() })) }));
  await sampleFor(baseline, () => "recovery");
  await Promise.all(pending);
  phase = "teardown";
  for (const { id } of sessions) await deadline(user.freeSandbox(id), 30_000);
  await user.removeMachine({ machineId: place.machineId, removeSandboxes: true });
  if (values.proof) {
    const { id, handle } = sessions[0]!;
    const { timeline } = await handle.snapshot();
    assert(timeline.some(i => i.kind === "acp") && timeline.some(i => i.kind === "turn.ended" && i.outcome === "succeeded"), "No durable streamed turn");
    writeFileSync(values.proof, JSON.stringify({ uid, token, id, hash: digest(timeline), items: timeline.length }), { mode: 0o600, flag: "wx" });
    console.log("Durable timeline", timeline.length, "items; sha256", digest(timeline));
  }
  if (sessions.some(s => !s.turns || !s.deltas() || s.failures) || Object.values(samples).some(g => Object.values(g).some(s => s.errors))) process.exitCode = 1;
} finally {
  summary();
  console.log("Log counts", JSON.stringify(logCounts), "engine/server restart deltas", [engine, server].map((id, i) => Number(docker("inspect", "--format", "{{.RestartCount}}", id)) - initialRestarts[i]!));
  for (const id of burners) docker("rm", "-f", id);
  for (const child of logs) child.kill();
  await Promise.allSettled(dispose.map(fn => fn()));
  await runner.setOffline(true);
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
