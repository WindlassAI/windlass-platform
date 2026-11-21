# Windlass event fixtures

Real output of `windlass --json`, one JSON object per line.

- `demo-*.jsonl`: `windlass --demo <name> --demo-speed 0 --json` (scripted engine, no tools run).
- `real-scripted-bwrap.jsonl`: the real engine with a scripted model (`WINDLASS_ACP_SCRIPT`) inside a
  container where Windlass's own sandbox works: the shell call runs sandboxed.
- `real-scripted-hardened.jsonl`: the same in a default-hardened container, where the sandbox cannot
  start: the shell call is refused (`approval.denied`, `tool.settled` with `outcome: "error"`).

Durable events have `v`, `data`, `seq`, `time`. Ephemeral ones (`text.delta`, `reasoning.delta`,
`tool.input.delta`, `tool.progress`, `notice`, `workspace.changes`, `cli.summary`) have their fields at
the top level and no `seq`. The schema is documented in the
[Windlass v0.5.0 event log](https://github.com/parthg1901/windlass/blob/v0.5.0/docs/event-log.md).

- `acp-approval-approved.jsonl`, `acp-approval-denied.jsonl`: the events of one turn driven over the Agent
  Client Protocol (`windlass acp`, events asked for at `initialize`) with a scripted model, in a container where
  Windlass's sandbox works. A `shell` call asks for network access (`approval.requested`); the user allows it once
  (`approval.answered`, the command runs, `taint.noticed`) or declines with a note (`tool.settled` with the
  refusal). A second message is sent while a later command runs (`inbox.enqueued` with `delivery: "steer"`,
  delivered at the next step). These have no `cli.summary`: the command line prints that, not the engine.
  `fixtures/acp-probe/` holds the script and the small client that recorded them.
- `acp-subagents.jsonl`: one turn of Windlass 0.3.0 over ACP with a scripted model, as the platform's sandbox layer
  hands its events to the session's actor (a `docker-hardened` sandbox). The agent starts four subagents with the
  `subagent` tool: one finishes after a `glob` call, one fails (its model call is refused), one is stopped by the user
  (`_windlass/cancel_call` of its call) and one runs in the background, whose answer comes back as an inbox message
  (`origin: "subagent_result"`). Each has `spawn.started`, its own events as `child.event` and `spawn.ended`. The
  children's `baseline.set` (their whole system prompt and tool list) is left out to keep the file small.
