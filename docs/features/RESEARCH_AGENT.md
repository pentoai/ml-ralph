# Feature: Research Agent with AlphaXiv MCP

> **Status**: Design complete, implementation deferred
> **Blocked by**: OAuth authentication - need to either get our own client ID from AlphaXiv or wait for users to manually authenticate via Claude Code's `/mcp` command.

## Overview

A dedicated Research Agent that runs as a background Claude Code instance, using the AlphaXiv MCP to find and analyze relevant academic papers for the current ML project.

## Motivation

Ralph's RESEARCH phase requires finding state-of-the-art approaches, relevant papers, and implementation patterns. By integrating AlphaXiv MCP, we can automate research discovery with a single button click.

---

## AlphaXiv MCP Tools

| Tool | Description | Use in Ralph |
|------|-------------|--------------|
| `answer_research_query` | Survey recent papers for a research question | Broad exploration of approaches |
| `find_papers_feed` | Filter papers by trending metrics, topics, orgs | Find hot/relevant papers |
| `answer_pdf_query` | Answer questions about a specific PDF | Deep-dive into promising papers |
| `search_for_paper_by_title` | Find paper by title | Look up referenced papers |
| `read_files_from_github_repository` | Read files from paper's codebase | Study implementations |
| `find_organizations` | Search for canonical org names | Filter by lab (DeepMind, etc.) |

### Tool Details

**`answer_research_query`** - Best for surveying state-of-the-art
```
Parameters:
  - query: Research question requiring survey of recent papers

Example: "What are common tricks recent papers use to stabilize training?"
```

**`find_papers_feed`** - Best for finding trending papers
```
Parameters:
  - sort: "Hot" | "Comments" | "Views" | "Likes" | "GitHub" | "Twitter (X)" | "Recommended"
  - interval: "3 Days" | "7 Days" | "30 Days" | "90 Days" | "All time"
  - topics (optional): arXiv categories ["cs.AI", "cs.CV"] or AI topics ["transformers"]
  - organizationNames (optional): canonical org names from find_organizations
```

**`answer_pdf_query`** - Best for extracting specific information
```
Parameters:
  - url: PDF URL or abstract page (arXiv, alphaXiv, Semantic Scholar)
  - query: What to find in the paper

Example: "What hyperparameters do they use for training?"
```

**`read_files_from_github_repository`** - Best for studying implementations
```
Parameters:
  - githubUrl: URL of paper's codebase
  - path: "/" for full repo, or specific path
```

---

## Authentication Challenge

### What We Learned

AlphaXiv MCP uses **OAuth 2.0 with PKCE** via Clerk. When Cursor authenticates, it uses:

```
https://clerk.alphaxiv.org/oauth/authorize
  ?response_type=code
  &client_id=PPMVBtu6Lo8w3r29          # Cursor's client ID
  &code_challenge=<PKCE_challenge>
  &code_challenge_method=S256
  &redirect_uri=cursor://anysphere.cursor-mcp/oauth/callback
  &state=<random>
  &resource=https://api.alphaxiv.org/
```

### The Problem

1. **Cursor's client ID** (`PPMVBtu6Lo8w3r29`) only allows `cursor://` redirect URIs
2. When we tried `http://localhost:61234/callback`, we got:
   > "The 'redirect_uri' parameter does not match any of the OAuth 2.0 Client's pre-registered redirect urls"
3. We can't programmatically trigger Claude Code's `/mcp` authentication

### Solutions

**Option A: Get Our Own Client ID** (Recommended)
- Contact AlphaXiv to register `ml-ralph` as an OAuth client
- Allow `http://localhost:PORT/callback` as redirect URI
- Then we can implement full OAuth flow ourselves

**Option B: Delegate to Claude Code** (Workaround)
- User authenticates once via `claude` → `/mcp` → alphaxiv
- ml-ralph spawns Claude Code which inherits the auth
- Downside: Requires manual user action outside ml-ralph

**Option C: Automate Claude Code /mcp** (Fragile)
- Spawn Claude Code in PTY
- Programmatically send `/mcp` commands
- Very fragile due to menu navigation, timing, etc.

### Checking Auth Status via Claude Code

We can detect AlphaXiv setup state using Claude Code CLI:

```bash
# Check if installed
claude mcp list | grep -i alphaxiv

# Get detailed status (shows "Needs authentication" if not authed)
claude mcp get alphaxiv
```

Status detection:
- **not_installed**: alphaxiv not in `mcp list`
- **needs_auth**: `mcp get` shows "Needs authentication"
- **ready**: No auth warning in `mcp get`

---

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ml-ralph TUI                                │
├─────────────────────────────────────────────────────────────────────┤
│  Planning Mode                                                      │
│  ┌──────────────────────┐      ┌──────────────────────────────┐    │
│  │   Claude Terminal    │      │      Research Tab             │    │
│  │   (user can /mcp     │      │  [Start Research]             │    │
│  │    here to auth)     │      │                               │    │
│  └──────────────────────┘      │  Status + Results             │    │
│                                └──────────────────────────────┘    │
│                                              │                      │
│                                              │ triggers             │
│                                              ▼                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                      Research Agent                          │  │
│  │  • Background Claude Code subprocess                         │  │
│  │  • AlphaXiv MCP enabled (inherits auth from Claude Code)     │  │
│  │  • Project context as system prompt                          │  │
│  │  • Writes findings to .ml-ralph/research.jsonl               │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Research Agent Pipeline

```
1. BUILD CONTEXT
   ├── Read .ml-ralph/prd.json → goals, scope, domain
   ├── Read .ml-ralph/learnings.jsonl → knowledge gaps
   └── Read .ml-ralph/stories → current focus areas

2. SURVEY FIELD (answer_research_query)
   ├── "What are recent approaches to {main_task}?"
   ├── "What tricks do recent papers use for {challenge}?"
   └── "Best practices for {evaluation_strategy}?"

3. FIND PAPERS (find_papers_feed)
   ├── Hot papers in relevant categories
   ├── Papers with GitHub repos (sort="GitHub")
   └── Filter by relevant organizations if applicable

4. DEEP DIVE (answer_pdf_query)
   ├── Core approach and methodology
   ├── Results on relevant benchmarks
   └── Implementation details and hyperparameters

5. EXPLORE CODE (read_files_from_github_repository)
   ├── Model architecture
   ├── Training configuration
   └── Reusable components

6. OUTPUT FINDINGS
   └── Write to .ml-ralph/research.jsonl
```

---

## Implementation Checklist (For Future)

### Phase 1: Authentication
- [ ] Contact AlphaXiv to register ml-ralph OAuth client
- [ ] Implement PKCE OAuth flow with localhost callback
- [ ] Store tokens in `~/.ml-ralph/credentials/`
- [ ] OR: Use Claude Code's built-in auth (workaround)

### Phase 2: Research Agent
- [ ] Create `src/infrastructure/research-agent/`
- [ ] Build prompt from project context
- [ ] Spawn Claude Code with AlphaXiv MCP
- [ ] Parse streaming output
- [ ] Write findings to `research.jsonl`

### Phase 3: UI Integration
- [ ] Add auth status indicator to Research tab
- [ ] Add "Start Research" button
- [ ] Show progress and stream results
- [ ] Cancel/stop functionality

---

## Files to Create (When Implementing)

```
src/infrastructure/
├── mcp/
│   ├── index.ts              # Exports
│   ├── types.ts              # OAuth, MCP config types
│   ├── oauth.ts              # OAuth 2.0 with PKCE (if we get client ID)
│   ├── token-store.ts        # Secure token storage
│   └── alphaxiv.ts           # AlphaXiv status checking
│
└── research-agent/
    ├── index.ts
    ├── agent.ts              # ResearchAgent class
    ├── prompt-builder.ts     # Build system prompt from context
    └── output-parser.ts      # Parse findings from Claude output
```

---

## Related Documents

- [ARCHITECTURE.md](../ARCHITECTURE.md) - Overall system architecture
- [DATA_MODELS.md](../DATA_MODELS.md) - Research type definition
- [CLAUDE_CODE_INTEGRATION.md](../CLAUDE_CODE_INTEGRATION.md) - Claude Code subprocess handling
