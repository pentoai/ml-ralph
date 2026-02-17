# Claude Code Integration Analysis

Based on analysis of the opencode repository and our requirements.

## OpenCode Architecture Summary

OpenCode uses a sophisticated architecture:

- **Vercel AI SDK** for provider-agnostic LLM abstraction
- **Worker-based RPC** separating TUI from computation
- **Solid.js** for reactive TUI rendering
- **Message Parts** system for fine-grained content (text, tools, reasoning)
- **Tool Registry** with permission system

## Our Options for ml-ralph

### Option 1: Vercel AI SDK (Like OpenCode)

**Pros:**

- Provider agnostic (could switch to other models)
- Full control over tool definitions
- Streaming built-in

**Cons:**

- Need to implement all tools ourselves (bash, read, edit, etc.)
- More complex setup
- Lose Claude Code's battle-tested tool implementations

### Option 2: Claude Code CLI (Current Approach) ✓ RECOMMENDED

**Pros:**

- Claude Code already has all tools we need (bash, read, edit, grep, glob, etc.)
- Battle-tested implementations
- Simpler integration - just spawn process and parse output
- Automatic tool approval handling
- Built-in permission system

**Cons:**

- Dependency on Claude Code being installed
- Less control over individual tool execution
- Tied to Claude specifically

### Option 3: Anthropic SDK Directly

**Pros:**

- Direct API access
- Full control

**Cons:**

- Need to implement all tools
- Handle rate limiting, retries, etc.
- More infrastructure work

## Recommended Approach: Claude Code CLI

For ml-ralph, we should use **Claude Code CLI** because:

1. **ML engineering focus** - We need reliable file editing, bash execution for training
2. **Simplicity** - Claude Code handles tool complexity
3. **Alignment** - Claude Code is designed for exactly this use case
4. **Rapid development** - Less code to write and maintain

## Integration Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       ml-ralph TUI                          │
│  ┌─────────────────┐  ┌──────────────────────────────────┐ │
│  │  Planning Mode  │  │         Monitor Mode              │ │
│  │  ├─ Chat Panel  │  │  ├─ Agent Output (streaming)     │ │
│  │  │   └─ sends   │  │  └─ Current Task                 │ │
│  │  │     prompt   │  │                                   │ │
│  │  └─ Knowledge   │  │                                   │ │
│  └────────┬────────┘  └───────────────┬──────────────────┘ │
└───────────┼───────────────────────────┼────────────────────┘
            │                           │
            ▼                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Claude Code Client                         │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  spawn("claude", ["-p", prompt, "--output-format",      ││
│  │         "stream-json", "--system-prompt", instructions]) ││
│  └─────────────────────────────────────────────────────────┘│
│                            │                                 │
│                            ▼                                 │
│  ┌─────────────────────────────────────────────────────────┐│
│  │  Stream Parser                                          ││
│  │  ├─ text events → display in TUI                        ││
│  │  ├─ tool_start → show "Running: <tool>"                 ││
│  │  ├─ tool_end → show result                              ││
│  │  └─ done → complete, extract learnings/research         ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Claude Code Stream Format

When using `--output-format stream-json`, Claude Code outputs:

```json
{"type": "assistant", "message": {"id": "...", "role": "assistant", ...}}
{"type": "content_block_start", "content_block": {"type": "text", ...}}
{"type": "content_block_delta", "delta": {"type": "text_delta", "text": "..."}}
{"type": "content_block_start", "content_block": {"type": "tool_use", "name": "...", ...}}
{"type": "content_block_delta", "delta": {"type": "input_json_delta", "partial_json": "..."}}
{"type": "content_block_stop"}
{"type": "message_stop"}
{"type": "result", "result": "...", "cost_usd": ..., "tokens": {...}}
```

## Key Implementation Tasks

### 1. Stream Parser Enhancement

Current: Basic parsing of stream events
Needed: Full handling of all event types

```typescript
interface StreamEvent {
  type: "text" | "tool_start" | "tool_running" | "tool_end" | "error" | "done";
  // ... type-specific fields
}
```

### 2. Session Management

- Continue conversations with `--continue` flag
- Session IDs stored per chat
- Conversation history in `.ml-ralph/chat/`

### 3. System Prompt Injection

- PRD creation prompt for Planning mode
- Story execution prompt for Monitor mode
- Include learnings/research context

### 4. Output Extraction

Parse Claude Code's output to extract:

- Learnings (structured JSON)
- Research findings (structured JSON)
- Progress updates
- W&B run IDs

### 5. Tool Visibility

Show in TUI when Claude Code is:

- Reading files
- Editing files
- Running bash commands
- Searching code

## Implementation Phases

### Phase 1: Basic Chat Integration

- [ ] Send user message to Claude Code
- [ ] Stream response back to TUI
- [ ] Display streaming text
- [ ] Handle done event

### Phase 2: Tool Visibility

- [ ] Parse tool_start events
- [ ] Show "Reading file: X" / "Running: command"
- [ ] Parse tool_end events
- [ ] Show tool results (abbreviated)

### Phase 3: Session Continuity

- [ ] Use `--continue` for follow-up messages
- [ ] Store session metadata
- [ ] Support starting new sessions

### Phase 4: Structured Output

- [ ] System prompt for structured output
- [ ] Parse learnings from response
- [ ] Parse research from response
- [ ] Auto-save to .ml-ralph/

### Phase 5: Story Execution

- [ ] Build story execution prompt
- [ ] Include PRD context
- [ ] Include learnings context
- [ ] Parse progress updates

## Code Changes Required

### `src/infrastructure/claude/client.ts`

- Already spawns Claude Code CLI ✓
- Needs: Better stream event handling
- Needs: Session continuation support

### `src/infrastructure/claude/stream-parser.ts`

- Already parses basic events ✓
- Needs: Full event type coverage
- Needs: Tool name/input extraction

### `src/ui/widgets/chat-panel.tsx`

- Connect to Claude Code client
- Display streaming response
- Show tool activity indicators

### `src/application/orchestrator/orchestrator.ts`

- Integrate with story execution
- Handle auto-advance between stories
- Extract learnings/research

## Claude Code CLI Flags Reference

```bash
claude [options] [prompt]

Options:
  -p, --prompt <text>         Prompt text (required for non-interactive)
  --output-format <format>    text | json | stream-json
  --system-prompt <text>      Custom system prompt
  --allowedTools <tools>      Comma-separated tool list
  --continue                  Continue previous conversation
  --resume <session>          Resume specific session
  --model <model>             Model to use
  --max-turns <n>             Maximum conversation turns
```

## Next Steps

1. Test Claude Code CLI streaming format with real calls
2. Enhance stream parser for full event coverage
3. Connect chat panel to Claude Code client
4. Add tool activity display
5. Implement session continuity
