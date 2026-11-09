#!/usr/bin/env python3
"""ml-ralph inside the Docker sandbox: forwards `log`, `eval` and `job` to the host runner.

The request is a file under $ML_RALPH_SANDBOX_DIR/requests; the host runner
executes it and writes $ML_RALPH_SANDBOX_DIR/responses/<id>.json. Nothing runs here.
"""
import json
import os
import sys
import time
import uuid

COMMANDS = ("log", "eval", "job")


def main(argv):
    if not argv or argv[0] not in COMMANDS:
        sys.stderr.write("Usage: ml-ralph <log|eval|job> ...  (run on the host by the ml-ralph runner)\n")
        return 2
    base = os.environ.get("ML_RALPH_SANDBOX_DIR")
    if not base:
        sys.stderr.write("ML_RALPH_SANDBOX_DIR is not set: this shim only works in an ml-ralph sandbox\n")
        return 2
    req_id = uuid.uuid4().hex
    stdin = None if sys.stdin.isatty() or "-" not in argv else sys.stdin.read()
    os.makedirs(os.path.join(base, "requests"), exist_ok=True)
    request = {"argv": argv, "cwd": os.getcwd(), "stdin": stdin}
    tmp = os.path.join(base, "requests", req_id + ".tmp")
    with open(tmp, "w") as f:
        json.dump(request, f)
    os.rename(tmp, os.path.join(base, "requests", req_id + ".json"))

    response = os.path.join(base, "responses", req_id + ".json")
    while not os.path.exists(response):
        time.sleep(0.1)
    with open(response) as f:
        result = json.load(f)
    os.remove(response)
    sys.stdout.write(result.get("stdout", ""))
    sys.stdout.flush()
    sys.stderr.write(result.get("stderr", ""))
    return int(result.get("code", 1))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
