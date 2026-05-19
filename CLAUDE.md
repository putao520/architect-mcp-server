# architect-mcp-server

MCP Server that spawns child Claude Code instances as architectural consultants.

## Architecture

Single-file MCP server (`src/index.mjs`) that:
1. Receives MCP tool calls from the parent CC
2. Optionally parses target files into structured representations
3. Constructs task-specific prompts with LSP/DAP usage guidance
4. Calls `query()` from `@anthropic-ai/claude-agent-sdk` to spawn a child CC
5. Returns the child CC's analysis to the parent CC

## Dependencies

- `@anthropic-ai/claude-agent-sdk` — spawns child CC instances (v0.3.144)
- `@modelcontextprotocol/sdk` — MCP server framework
- `web-tree-sitter` — structured AST parsing for SPEC/MD files
- `zod` — parameter schema validation

## Environment

Configurable via environment variables or shell script:

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_BASE_URL` | from `~/kocode.sh` | API endpoint |
| `ANTHROPIC_AUTH_TOKEN` | from `~/kocode.sh` | Auth token |
| `ARCHITECT_ENV_SCRIPT` | `~/kocode.sh` | Shell script to source env vars |
| `ARCHITECT_MAX_TURNS` | `3000` | Global default max turns |

Priority: direct env vars > ARCHITECT_ENV_SCRIPT > ~/kocode.sh

## Tools

- `architect_consult` — deep architectural question answering
- `architect_audit` — SPEC file auditing (multi-dimension)
- `architect_review` — code architecture review
- `architect_analyze` — subsystem analysis (data flow, call chains, state)

## Conventions

- Tool descriptions in Chinese (following LSP/DAP convention)
- Read-only child CC analysis (no code modifications)
- Child CC inherits project CWD and CLAUDE.md via `settingSources: ['project']`
