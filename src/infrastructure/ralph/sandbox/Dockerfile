# ML-Ralph sandbox image: the claude CLI and Python for one agent iteration.
# Built by the runner (or by hand, see docs/ARCHITECTURE.md#docker-sandbox):
#   docker build -t ml-ralph-sandbox:1 src/infrastructure/ralph/sandbox
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-pip python3-venv ca-certificates curl \
 && ln -s /usr/bin/python3 /usr/local/bin/python \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

# `ml-ralph log|eval|job` forward to the host runner; `bunx @pentoai/ml-ralph@x ...` in RALPH_MD lands on the same shim
COPY ml-ralph-forward.py /usr/local/bin/ml-ralph
COPY bunx /usr/local/bin/bunx
RUN chmod 0755 /usr/local/bin/ml-ralph /usr/local/bin/bunx

# The container runs as the host user (--user), with HOME on a tmpfs
ENV HOME=/home/agent
WORKDIR /workspace
