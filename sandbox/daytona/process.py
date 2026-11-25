"""Carry child pipes over a Daytona PTY. The launcher has already dropped uid and groups."""
import base64
import json
import os
import select
import signal
import subprocess
import sys
import threading
import tty


def emit(kind, value):
    print(json.dumps([kind, value], separators=(",", ":")), flush=True)


def main():
    tty.setraw(0)
    print("\nwlp-ready", flush=True)
    wire = sys.stdin.buffer
    request = json.loads(wire.readline())
    env = {**os.environ, "NO_COLOR": "1", **request["env"]}
    child = subprocess.Popen(["/bin/sh", "-c", "exec " + request["command"]],
                             cwd=request["cwd"], env=env, stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)

    def inputs():
        for line in wire:
            data = json.loads(line)
            if data is None:
                child.stdin.close()
            elif data == "kill":
                os.killpg(child.pid, signal.SIGKILL)
            else:
                child.stdin.write(base64.b64decode(data[0], validate=True))
                child.stdin.flush()

    threading.Thread(target=inputs, daemon=True).start()
    streams = {child.stdout: "out", child.stderr: "err"}
    while streams:
        readable, _, _ = select.select(list(streams), [], [])
        for stream in readable:
            data = os.read(stream.fileno(), 32 * 1024)
            if data:
                emit(streams[stream], base64.b64encode(data).decode("ascii"))
            else:
                del streams[stream]
    emit("exit", child.wait())


try:
    main()
except Exception as error:
    emit("error", type(error).__name__)
# The input thread may still be waiting for another frame on the PTY.
os._exit(0)
