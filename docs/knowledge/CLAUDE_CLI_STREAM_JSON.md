# Claude CLI Stream-JSON Protocol

> Research documentation for programmatic integration with Claude Code CLI.
> Last updated: 2025-01-28

## Overview

Claude Code CLI supports a programmatic interface via the `stream-json` format, enabling:
- Real-time streaming responses
- Multi-turn conversations
- Tool execution (Read, Edit, Bash, etc.)
- Session persistence

This is the recommended approach for embedding Claude Code functionality in custom applications.

## Command Line Interface

### Basic Command

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --dangerously-skip-permissions \
  --append-system-prompt "Your context here"
```

### Key Flags

| Flag | Description |
|------|-------------|
| `-p, --print` | **Required.** Non-interactive mode for programmatic use |
| `--input-format stream-json` | Accept JSON messages on stdin |
| `--output-format stream-json` | Output newline-delimited JSON |
| `--include-partial-messages` | Enable token-by-token streaming |
| `--dangerously-skip-permissions` | Bypass tool permission prompts |
| `--append-system-prompt <text>` | Add context to system prompt |
| `--session-id <uuid>` | Use specific session ID |
| `-c, --continue` | Continue most recent conversation |
| `-r, --resume <id>` | Resume specific session |

### Other Useful Flags

| Flag | Description |
|------|-------------|
| `--model <model>` | Specify model (sonnet, opus, haiku) |
| `--tools <tools>` | Limit available tools |
| `--allowedTools <tools>` | Whitelist specific tools |
| `--disallowedTools <tools>` | Blacklist specific tools |
| `--max-budget-usd <amount>` | Set spending limit |

## Input Format

Messages are sent as JSON objects on stdin, one per line:

```json
{"type":"user","message":{"role":"user","content":"Your message here"}}
```

### Input Message Schema

```typescript
interface InputMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
}
```

## Output Format

Output is newline-delimited JSON (NDJSON). Each line is a complete JSON object.

### Message Types

#### 1. System Init

First message on session start. Contains session metadata.

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "uuid",
  "cwd": "/path/to/directory",
  "tools": ["Bash", "Read", "Edit", ...],
  "model": "claude-opus-4-5-20251101",
  "permissionMode": "bypassPermissions",
  "mcp_servers": [],
  "agents": ["Bash", "Explore", "Plan", ...],
  "skills": ["commit", "review", ...],
  "claude_code_version": "2.1.22"
}
```

#### 2. Stream Events

Real-time streaming events for text and tool calls.

**Message Start:**
```json
{
  "type": "stream_event",
  "event": {
    "type": "message_start",
    "message": {
      "model": "claude-opus-4-5-20251101",
      "id": "msg_xxx",
      "role": "assistant",
      "content": [],
      "usage": { ... }
    }
  },
  "session_id": "uuid"
}
```

**Content Block Start (Text):**
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 0,
    "content_block": {
      "type": "text",
      "text": ""
    }
  },
  "session_id": "uuid"
}
```

**Content Block Start (Tool Use):**
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_start",
    "index": 0,
    "content_block": {
      "type": "tool_use",
      "id": "toolu_xxx",
      "name": "Read",
      "input": {}
    }
  },
  "session_id": "uuid"
}
```

**Content Block Delta (Text):**
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "text_delta",
      "text": "streamed text chunk"
    }
  },
  "session_id": "uuid"
}
```

**Content Block Delta (Tool Input):**
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "{\"file_path\":"
    }
  },
  "session_id": "uuid"
}
```

**Content Block Stop:**
```json
{
  "type": "stream_event",
  "event": { "type": "content_block_stop", "index": 0 },
  "session_id": "uuid"
}
```

**Message Delta:**
```json
{
  "type": "stream_event",
  "event": {
    "type": "message_delta",
    "delta": {
      "stop_reason": "end_turn",
      "stop_sequence": null
    },
    "usage": { ... }
  },
  "session_id": "uuid"
}
```

**Message Stop:**
```json
{
  "type": "stream_event",
  "event": { "type": "message_stop" },
  "session_id": "uuid"
}
```

#### 3. Assistant Message

Full assistant message (appears during streaming, contains complete content).

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-5-20251101",
    "id": "msg_xxx",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Full response text" }
    ],
    "stop_reason": null,
    "usage": { ... }
  },
  "session_id": "uuid"
}
```

For tool use:
```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_xxx",
        "name": "Read",
        "input": {
          "file_path": "/path/to/file",
          "limit": 10
        }
      }
    ]
  },
  "session_id": "uuid"
}
```

#### 4. User (Tool Result)

Tool execution results are returned as user messages.

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "tool_use_id": "toolu_xxx",
        "type": "tool_result",
        "content": "Tool output here...",
        "is_error": false
      }
    ]
  },
  "session_id": "uuid",
  "tool_use_result": {
    "stdout": "...",
    "stderr": "...",
    "interrupted": false,
    "isImage": false
  }
}
```

#### 5. Result

Final result message with cost and usage information.

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 5857,
  "duration_api_ms": 5800,
  "num_turns": 2,
  "result": "Final text response",
  "session_id": "uuid",
  "total_cost_usd": 0.0534,
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50,
    "cache_creation_input_tokens": 1000,
    "cache_read_input_tokens": 5000
  },
  "modelUsage": {
    "claude-opus-4-5-20251101": {
      "inputTokens": 100,
      "outputTokens": 50,
      "costUSD": 0.05
    }
  }
}
```

## Message Flow

### Simple Text Response

```
stdin:  {"type":"user","message":{"role":"user","content":"hello"}}

stdout: {"type":"system","subtype":"init",...}
stdout: {"type":"stream_event","event":{"type":"message_start",...}}
stdout: {"type":"stream_event","event":{"type":"content_block_start",...}}
stdout: {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Hi"}}}
stdout: {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"!"}}}
stdout: {"type":"assistant","message":{...}}
stdout: {"type":"stream_event","event":{"type":"content_block_stop",...}}
stdout: {"type":"stream_event","event":{"type":"message_delta",...}}
stdout: {"type":"stream_event","event":{"type":"message_stop"}}
stdout: {"type":"result","subtype":"success",...}
```

### With Tool Use

```
stdin:  {"type":"user","message":{"role":"user","content":"list files"}}

stdout: {"type":"system","subtype":"init",...}
stdout: {"type":"stream_event","event":{"type":"message_start",...}}
stdout: {"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Bash"}}}
stdout: {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}}
stdout: {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"\"ls\"}"}}}
stdout: {"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}
stdout: {"type":"stream_event","event":{"type":"content_block_stop",...}}
stdout: {"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"}}}
stdout: {"type":"stream_event","event":{"type":"message_stop"}}
stdout: {"type":"user","message":{"content":[{"type":"tool_result","content":"file1\nfile2"}]}}
stdout: {"type":"stream_event","event":{"type":"message_start",...}}
stdout: {"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text"}}}
stdout: {"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Here are the files:"}}}
... more text deltas ...
stdout: {"type":"assistant","message":{...}}
stdout: {"type":"stream_event","event":{"type":"content_block_stop",...}}
stdout: {"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}
stdout: {"type":"stream_event","event":{"type":"message_stop"}}
stdout: {"type":"result","subtype":"success",...}
```

### Multi-Turn Conversation

Keep stdin open and send multiple messages:

```
stdin:  {"type":"user","message":{"role":"user","content":"remember: x=42"}}
stdout: ... streaming response ...
stdout: {"type":"result",...}

stdin:  {"type":"user","message":{"role":"user","content":"what is x?"}}
stdout: ... streaming response mentioning 42 ...
stdout: {"type":"result",...}
```

## Available Tools

The following tools are available by default:

| Tool | Description |
|------|-------------|
| `Task` | Launch subagents for complex tasks |
| `TaskOutput` | Get output from background tasks |
| `Bash` | Execute shell commands |
| `Glob` | Find files by pattern |
| `Grep` | Search file contents |
| `Read` | Read file contents |
| `Edit` | Edit files with string replacement |
| `Write` | Write new files |
| `NotebookEdit` | Edit Jupyter notebooks |
| `WebFetch` | Fetch and analyze web pages |
| `WebSearch` | Search the web |
| `TodoWrite` | Manage todo lists |
| `TaskStop` | Stop background tasks |
| `AskUserQuestion` | Ask user for input |
| `Skill` | Execute skills/slash commands |
| `EnterPlanMode` | Enter planning mode |
| `ExitPlanMode` | Exit planning mode |
| `ToolSearch` | Search for MCP tools |

## TypeScript Types

```typescript
// Output message types
type OutputMessage =
  | SystemInitMessage
  | StreamEventMessage
  | AssistantMessage
  | UserMessage
  | ResultMessage;

interface SystemInitMessage {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd: string;
  tools: string[];
  model: string;
  permissionMode: string;
  mcp_servers: string[];
  agents: string[];
  skills: string[];
  claude_code_version: string;
}

interface StreamEventMessage {
  type: "stream_event";
  event: StreamEvent;
  session_id: string;
  parent_tool_use_id: string | null;
}

type StreamEvent =
  | { type: "message_start"; message: Message }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | { type: "content_block_delta"; index: number; delta: Delta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string }; usage: Usage }
  | { type: "message_stop" };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: object };

type Delta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string };

interface AssistantMessage {
  type: "assistant";
  message: Message;
  session_id: string;
  parent_tool_use_id: string | null;
}

interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: ToolResultContent[];
  };
  session_id: string;
  tool_use_result?: {
    stdout: string;
    stderr: string;
    interrupted: boolean;
    isImage: boolean;
  };
}

interface ToolResultContent {
  tool_use_id: string;
  type: "tool_result";
  content: string;
  is_error: boolean;
}

interface ResultMessage {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage: Usage;
  modelUsage: Record<string, ModelUsage>;
}

// Input message type
interface InputMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
}
```

## Implementation Example

```typescript
import { spawn, type ChildProcess } from "node:child_process";

interface ClaudeClientOptions {
  cwd: string;
  systemPrompt?: string;
  onText?: (text: string) => void;
  onToolStart?: (name: string, id: string) => void;
  onToolEnd?: (id: string, result: string) => void;
  onComplete?: (result: string, cost: number) => void;
  onError?: (error: Error) => void;
}

class ClaudeClient {
  private proc: ChildProcess | null = null;
  private sessionId: string | null = null;

  constructor(private options: ClaudeClientOptions) {}

  start(): void {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];

    if (this.options.systemPrompt) {
      args.push("--append-system-prompt", this.options.systemPrompt);
    }

    this.proc = spawn("claude", args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (data) => {
      this.handleOutput(data.toString());
    });

    this.proc.stderr?.on("data", (data) => {
      this.options.onError?.(new Error(data.toString()));
    });
  }

  private handleOutput(data: string): void {
    const lines = data.split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Ignore parse errors for partial lines
      }
    }
  }

  private handleMessage(msg: OutputMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.sessionId = msg.session_id;
        }
        break;

      case "stream_event":
        if (msg.event.type === "content_block_start") {
          if (msg.event.content_block.type === "tool_use") {
            this.options.onToolStart?.(
              msg.event.content_block.name,
              msg.event.content_block.id
            );
          }
        } else if (msg.event.type === "content_block_delta") {
          if (msg.event.delta.type === "text_delta") {
            this.options.onText?.(msg.event.delta.text);
          }
        }
        break;

      case "user":
        if (msg.message.content[0]?.type === "tool_result") {
          this.options.onToolEnd?.(
            msg.message.content[0].tool_use_id,
            msg.message.content[0].content
          );
        }
        break;

      case "result":
        this.options.onComplete?.(msg.result, msg.total_cost_usd);
        break;
    }
  }

  send(message: string): void {
    if (!this.proc?.stdin) return;

    const input = JSON.stringify({
      type: "user",
      message: { role: "user", content: message }
    });

    this.proc.stdin.write(input + "\n");
  }

  stop(): void {
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.proc = null;
  }
}
```

## Best Practices

1. **Always use `--include-partial-messages`** for real-time streaming UX
2. **Keep stdin open** for multi-turn conversations
3. **Parse NDJSON line by line** - each line is a complete JSON object
4. **Handle tool_use stop_reason** - indicates tool is about to execute
5. **Track session_id** for conversation continuity
6. **Use `--append-system-prompt`** for context injection (PRD, learnings, etc.)
7. **Monitor `total_cost_usd`** in result messages for cost tracking

## Error Handling

Errors appear as:
- `result` message with `subtype: "error"` and `is_error: true`
- stderr output for process-level errors

```json
{
  "type": "result",
  "subtype": "error",
  "is_error": true,
  "error": "Error message here",
  "session_id": "uuid"
}
```

## Session Management

### Continue Most Recent Session
```bash
claude -p -c --output-format stream-json ...
```

### Resume Specific Session
```bash
claude -p --resume "session-uuid" --output-format stream-json ...
```

### Force New Session
Don't use `-c` or `--resume` flags.

## References

- Claude Code CLI: `claude --help`
- Version tested: 2.1.22
