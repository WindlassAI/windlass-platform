#!/usr/bin/env python3
"""A tiny MCP server for the platform's checks: standard input and output, one JSON-RPC message per
line, the handshake of the revisions before 2026 (`initialize`). It needs nothing but Python.

Two tools:

  berth   says which berth is free for a ship: something a model can call and get an answer from
  reach   says what this process can reach from where it runs: the network, Windlass's data directory
          and whether the test's private handoff fixture is readable. It prints no file's content, ever.

`reach` is how scripts/mcp-check.ts shows what the platform tells a user about a project's server:
that it runs in the session's sandbox but outside Windlass's sandbox around commands.
"""

import json
import os
import socket
import sys

DATA_DIR = os.path.expanduser("~/.local/share/windlass")

TOOLS = [
    {
        "name": "berth",
        "description": "Says which berth is free for a ship.",
        "inputSchema": {"type": "object", "properties": {"ship": {"type": "string"}}, "required": ["ship"]},
    },
    {
        "name": "reach",
        "description": "Says what this server's process can reach: the network and Windlass's data directory.",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def network():
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=4).close()
        return "reachable"
    except OSError:
        return "blocked"


def data_directory():
    try:
        os.listdir(DATA_DIR)
    except OSError:
        return "data directory: hidden", "access token file: out of reach"
    token = os.access("/dev/shm/access-token-mcp-check.json", os.R_OK)
    return "data directory: readable", "access token file: " + ("present" if token else "none in this turn")


def call(name, arguments):
    if name == "berth":
        return "Berth 4 is free for %s." % arguments.get("ship", "the ship")
    if name == "reach":
        directory, token = data_directory()
        return "\n".join(["network: " + network(), directory, token, "HARBOR_NOTE: " + os.environ.get("HARBOR_NOTE", "(not given)")])
    raise KeyError(name)


def answer(message):
    method = message.get("method")
    if method == "initialize":
        return {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "harbor", "version": "1"}}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        params = message.get("params") or {}
        try:
            text = call(params.get("name"), params.get("arguments") or {})
        except KeyError:
            return {"content": [{"type": "text", "text": "There is no such tool."}], "isError": True}
        return {"content": [{"type": "text", "text": text}]}
    if method == "ping":
        return {}
    return None


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        message = json.loads(line)
    except ValueError:
        continue
    if "id" not in message or "method" not in message:
        continue
    result = answer(message)
    if result is None:
        reply = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "method not found: %s" % message["method"]}}
    else:
        reply = {"jsonrpc": "2.0", "id": message["id"], "result": result}
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
