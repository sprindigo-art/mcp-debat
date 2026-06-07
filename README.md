# MCP Debat — Multi-Model AI Debate Server

MCP Debat is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that orchestrates sequential debates between 6 AI models. Models present approaches, challenge each other, and synthesize a final verdict — all through structured phases with anti-sycophancy enforcement and evidence-based validation.

Built for offensive security workflows but usable for any domain requiring multi-perspective AI analysis.

## How It Works

```
You (Host)                    MCP Debat Server                    6 AI Models
    │                              │                                  │
    ├── mcp_debate(topic) ────────>│                                  │
    │<── session_id + briefing ────│                                  │
    │                              │                                  │
    ├── mcp_respond(continue) ────>│── call Model 1 ─────────────────>│
    │<── Model 1 response ─────────│<── response ─────────────────────│
    │                              │                                  │
    ├── mcp_respond(continue) ────>│── call Model 2 (sees Model 1) ──>│
    │<── Model 2 response ─────────│<── response ─────────────────────│
    │         ...                  │         ...                      │
    │                              │                                  │
    ├── mcp_respond(evidence) ────>│── inject into transcript ────────│
    │                              │                                  │
    ├── mcp_respond(synthesize) ──>│── Synthesizer produces verdict ──>│
    │<── verdict + conclusions ────│                                  │
    │                              │                                  │
    ├── mcp_respond(close) ───────>│── save conclusions ──────────────│
```

Each model receives a **rebuilt transcript** of all prior responses (shared canonical transcript replay), so every model sees what came before it. The host (you) can inject evidence, corrections, or decisions between any model's turn.

## Features

- **6 AI Models**: DeepSeek, Gemini, Mistral, Claude, Qwen, GPT — configurable and extensible
- **4-Phase Debate**: Constructive → Challenge → Closing → Synthesis
- **Sequential Model-by-Model**: one model per API call, no timeout issues
- **Host Intervention**: inject info, corrections, evidence, or decisions mid-debate
- **Anti-Sycophancy**: per-response critique enforcement in Challenge phase — models must provide weakness + steel man + counterargument or get re-prompted
- **Evidence Gate**: Synthesis claims tagged `[VERIFIED]` must reference actual evidence or get flagged
- **Command Executor**: AI models can run read-only commands on the server to verify claims
- **Runbook Integration**: auto-load target-specific context into debates (for security workflows)
- **Multi-User**: session ownership, isolation between clients, transfer mechanism
- **Session Persistence**: all sessions saved to disk, resume anytime
- **Cost Tracking**: per-model, per-session, and daily cost tracking
- **Debate Memory**: conclusions from past debates auto-injected into relevant new debates

## Requirements

- **Node.js** >= 18.0.0
- **API Keys** for at least 1 provider (more = better debate quality)
- A server or machine to run on (can be localhost or remote)

## Installation

```bash
# Clone the repository
git clone <your-repo-url> mcp-debat
cd mcp-debat

# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env with your API keys (see Configuration below)

# Start the server
node src/index.js

# Or use PM2 for production (recommended)
pm2 start ecosystem.config.cjs
```

## Configuration

### Environment Variables (.env)

Create a `.env` file in the project root:

```bash
# Required: at least 1 provider API key
DEEPSEEK_API_KEY=sk-your-deepseek-key
GEMINI_API_KEY=AIza-your-gemini-key
MISTRAL_API_KEY=your-mistral-key
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
OPENAI_API_KEY=sk-your-openai-key
QWEN_API_KEY=your-qwen-key

# Server
PORT=3900
AUTH_TOKEN=your-random-secret-token
```

Providers without API keys are skipped at startup — the server works with as few as 1 model.

### Provider Configuration (config.json)

Each provider in `config.json` has:

```jsonc
{
  "providers": {
    "deepseek": {
      "enabled": true,           // set false to disable
      "name": "DeepSeek V4 Pro", // display name
      "model": "deepseek-v4-pro",// model ID sent to API
      "baseURL": "https://api.deepseek.com",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "sdk": "openai",           // SDK type: openai | google | anthropic | openai-responses | ollama
      "timeout": 120000,         // per-call timeout in ms
      "maxTokens": 2048,         // max output tokens per response
      "costPer1M": { "input": 0.435, "output": 0.87 }
    }
    // ... more providers
  },
  "debate": {
    "defaultRounds": 3,
    "maxRounds": 5,
    "modelResponseCap": 3000     // compact mode truncation limit (chars)
  },
  "executor": {
    "enabled": true,
    "allowedPaths": ["/your/server/path/runbooks", "/your/server/path/src"]
  }
}
```

### Adding a New Provider

1. Create `src/providers/yourprovider.js` extending `BaseProvider`
2. Implement the `chat(messages, opts)` method
3. Register it in `src/providers/index.js`
4. Add config entry in `config.json`

SDK types already supported: `openai` (OpenAI-compatible), `google` (Gemini), `anthropic` (Claude), `openai-responses` (GPT Responses API), `ollama` (local models).

## Connecting to Claude Code

Add to your Claude Code MCP config (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "mcp-debat": {
      "type": "url",
      "url": "https://your-server.com/mcp-debat",
      "headers": {
        "Authorization": "Bearer your-auth-token"
      }
    }
  }
}
```

For local development (no auth):

```json
{
  "mcpServers": {
    "mcp-debat": {
      "type": "url",
      "url": "http://localhost:3900"
    }
  }
}
```

When `AUTH_TOKEN` is not set, the server binds to `127.0.0.1` only (localhost) for safety. With `AUTH_TOKEN` set, it binds to `0.0.0.0` (all interfaces).

## Usage

### 6 MCP Tools

| Tool | Purpose | Blocking? |
|------|---------|-----------|
| `mcp_debate` | Start new debate or resume existing session | Per-model |
| `mcp_respond` | Inject content + control debate flow | Instant or per-model |
| `mcp_quick` | Quick parallel opinions from all models | ~30-60s |
| `mcp_review` | Multi-model code review with verdict | Per-model |
| `mcp_sessions` | List, get, delete, transfer sessions | Instant |
| `mcp_health` | Server + provider status check | Instant |

### Starting a Debate

```javascript
// Start a new debate
mcp_debate({
  topic: "Is this SQL injection exploitable given prepared statements?",
  style: "exploit-review",       // freeform | redteam | socratic | exploit-review
  context: "Target runs PHP 8.2 + MySQL 8.0, PDO with prepared statements",
  history_mode: "full",          // "compact" (3K chars/response) or "full" (32K)
  rounds: 1                      // number of debate rounds (default: 3, max: 5)
})
// Returns: { session_id, phase: "briefing", briefing: {...} }
```

### Advancing the Debate

Each `continue` call makes exactly 1 model respond:

```javascript
// Model 1 speaks
mcp_respond({ session_id: "xxx", action: "continue" })

// Model 2 speaks (sees Model 1's response)
mcp_respond({ session_id: "xxx", action: "continue" })

// ... repeat for all models, then next phase starts
```

### Host Intervention

Inject your own input between any model's turn:

```javascript
// Add evidence
mcp_respond({
  session_id: "xxx",
  type: "evidence",
  response: "I ran the exploit and got: HTTP 500 Internal Server Error",
  action: "continue"
})

// Correct a model's mistake
mcp_respond({
  session_id: "xxx",
  type: "correct",
  response: "That's not Apache, the target runs Nginx 1.25",
  action: "continue"
})

// Make a decision and skip to synthesis
mcp_respond({
  session_id: "xxx",
  type: "decision",
  response: "Use approach B from DeepSeek's analysis",
  action: "synthesize"
})

// Close the debate
mcp_respond({ session_id: "xxx", action: "close" })
```

### Quick Opinions (No Debate)

```javascript
// All models answer in parallel — fast cross-check
mcp_quick({
  question: "Is CVE-2024-1234 applicable to nginx 1.25.3?",
  context: "Target has default config with proxy_pass"
})
```

### Code Review

```javascript
mcp_review({
  code: "function login(user, pass) { ... }",
  focus: ["security", "bypass"],
  language: "javascript"
})
// Returns: per-model findings + synthesized verdict
```

## Debate Phases

```
Phase 0: BRIEFING
  → Host opens with topic + context
  → Server loads target runbook + past conclusions

Phase 1: CONSTRUCTIVE
  → Each model presents their approach (no critique allowed)
  → Output: approach, reasoning, evidence, confidence

Phase 2: CHALLENGE
  → Models critique each other (reverse order)
  → Steel Man required before any criticism
  → Server enforces: must include weakness + counterargument
  → If missing → auto re-prompt with anti-sycophancy warning

Phase 3: CLOSING
  → Each model: final position + what changed + confidence

Phase 4: SYNTHESIS
  → Rotating synthesizer (different from majority)
  → Evidence gate: [VERIFIED] claims must have references
  → Output: recommendation, dissent, unresolved, action items
  → Host decides: accept → close | reject → retry from Challenge
```

## Debate Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `topic` | string | required | Question or problem to debate |
| `target` | string | null | Target name — auto-loads runbook if available |
| `style` | string | "freeform" | Debate style: freeform, redteam, socratic, exploit-review |
| `rounds` | number | 3 | Max debate rounds (1-5) |
| `history_mode` | string | "compact" | `compact`: 3K chars/response in transcript. `full`: 32K cap |
| `runbook_mode` | string | "summary" | `summary`: 8K briefing. `full`: entire runbook in briefing |
| `require_full_runbook` | boolean | false | Auto-read entire runbook into transcript before debate starts |
| `executor_mode` | string | "safe" | `safe`: AI can run read-only commands. `off`: disabled |
| `models` | array | all 6 | Override which models participate |
| `client_id` | string | null | Your instance ID for multi-user session ownership |

## Command Executor

When `executor_mode: "safe"`, AI models can request commands during debate to verify their claims:

**Available tools for AI:**
- `bash` — read-only shell commands (cat, grep, find, ls, head, tail, diff, wc, sort, uniq, cut, awk, sed -n, jq, file, stat, md5sum, sha256sum, strings, git log/diff/show/status/blame)
- `read_runbook_chunk(offset, limit)` — read target runbook in batches
- `read_runbook_section(section)` — read specific runbook section
- `search_runbook(query)` — search keywords in target runbook

**Security (3-layer):**
1. Path whitelist — only configured directories (default: `runbooks/`, `src/`)
2. Command blacklist — blocks rm, dd, kill, sudo, eval, write operations
3. Command whitelist — allows: cat, grep, find, ls, head, tail, diff, wc, sort, uniq, cut, awk, sed -n, jq, file, stat, md5sum, sha256sum, strings, git (read-only)

Commands are target-locked: AI can only read the runbook belonging to the current session's target.

## Multi-User Support

Sessions have an `owner_client` field. When `client_id` is provided:

- **List**: only shows your sessions
- **Get**: non-owners see summary only (topic, target, status)
- **Respond**: blocked for non-owners
- **Transfer**: owner can transfer session to another client
- **Delete**: owner-only

```javascript
// List only my sessions
mcp_sessions({ action: "list", client_id: "my-instance-123" })

// Transfer a session
mcp_sessions({
  action: "transfer",
  session_id: "xxx",
  to_client: "colleague-456",
  client_id: "my-instance-123"
})
```

## Runbook Integration (Optional)

For security workflows, you can sync target-specific runbooks to the server. Place markdown files in the `runbooks/` directory:

```
runbooks/
  RUNBOOK_target-name.md
  RUNBOOK_example.com.md
```

When you start a debate with `target: "example.com"`, the server loads `RUNBOOK_example.com.md` and injects relevant sections into the debate context.

With `require_full_runbook: true`, the entire runbook is read into the transcript before the debate starts, so all models have complete context.

## Production Deployment

### With PM2

```bash
# Create ecosystem.config.cjs
cat > ecosystem.config.cjs << 'EOF'
const { readFileSync } = require('fs');
const { join } = require('path');

const envPath = join(__dirname, '.env');
const env = {};
try {
  readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) env[key.trim()] = val.join('=').trim();
  });
} catch(e) {}

module.exports = {
  apps: [{
    name: 'mcp-debat',
    script: 'src/index.js',
    cwd: __dirname,
    env: { NODE_ENV: 'production', ...env },
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '500M',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log',
    merge_logs: true
  }]
};
EOF

# Create directories
mkdir -p logs sessions memory runbooks

# Start
pm2 start ecosystem.config.cjs
pm2 save
```

### With Nginx (HTTPS reverse proxy)

```nginx
server {
    listen 443 ssl;
    server_name your-server.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location /mcp-debat {
        rewrite ^/mcp-debat(.*) $1 break;
        proxy_pass http://127.0.0.1:3900;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

Set `proxy_read_timeout` to at least 120s — model responses can take up to 60s.

### Health Check

```bash
curl https://your-server.com/mcp-debat/health
# {"status":"ok","uptime":12345,"version":"1.0.0"}
```

Or via MCP tool:
```javascript
mcp_health({ deep: true })
// Returns: provider status, session count, memory usage, daily cost
```

## Project Structure

```
mcp-debat/
├── config.json              # Provider configs, debate settings, executor paths
├── package.json
├── ecosystem.config.cjs     # PM2 production config
├── .env                     # API keys (not in repo)
├── src/
│   ├── index.js             # Entry point
│   ├── server.js            # HTTP server, JSON-RPC handler, auth
│   ├── engine/
│   │   ├── debate.js        # Core debate engine (phase logic, model calling, transcript)
│   │   ├── sessions.js      # Session CRUD, disk persistence
│   │   ├── executor.js      # Command executor, runbook helpers, security
│   │   ├── styles.js        # System prompts, phase prompts, role assignments
│   │   ├── collapse.js      # Sycophancy detection, collapse warning
│   │   ├── notebook.js      # Runbook loading, summarization, conclusions
│   │   └── cost.js          # Cost tracking per model/session/day
│   ├── providers/
│   │   ├── base.js          # BaseProvider class (refusal detection, truncation)
│   │   ├── deepseek.js      # DeepSeek (OpenAI-compatible SDK)
│   │   ├── gemini.js        # Gemini (Google AI SDK)
│   │   ├── mistral.js       # Mistral (OpenAI-compatible SDK)
│   │   ├── anthropic.js     # Claude (Anthropic SDK)
│   │   ├── qwen.js          # Qwen (Ollama API)
│   │   ├── openai.js        # GPT (OpenAI Responses API)
│   │   └── index.js         # Provider registry, init, health test
│   └── tools/
│       ├── index.js          # Tool registry
│       ├── debate.js         # mcp_debate tool
│       ├── respond.js        # mcp_respond tool
│       ├── quick.js          # mcp_quick tool
│       ├── review.js         # mcp_review tool
│       ├── sessions.js       # mcp_sessions tool
│       └── health.js         # mcp_health tool
├── scripts/
│   ├── sync-runbook.sh       # Sync single runbook to server (for remote setups)
│   └── hook_sync_debat.js    # PostToolUse hook for auto-sync
├── sessions/                 # Session JSON files (auto-created)
├── memory/                   # Conclusions + cost tracking (auto-created)
├── runbooks/                 # Target runbooks (optional)
└── logs/                     # PM2 logs (production)
```

## Known Limitations

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| MCP client timeout ~60s | Long model responses may timeout on client side | Response is saved server-side — retry `continue` |
| Compact mode truncates at 3K chars | Later models see truncated earlier responses | Use `history_mode: "full"` for important debates |
| Full history 32K cap | Extremely long responses still truncated | By design — prevents context overflow |
| Confidence scores unreliable | Model self-reported confidence has near-zero correlation with accuracy (r=0.024) | Don't use confidence for automated decisions |
| Gemini health check flaky | Returns "Empty response" on ping but works in debates | Known issue, no impact on functionality |

## Cost Estimates

Typical cost per full debate (6 models, 1 round, all 4 phases):

| Mode | Approximate Cost |
|------|-----------------|
| Compact history | $0.50 - $1.50 |
| Full history | $1.00 - $3.00 |
| Quick opinions | $0.10 - $0.30 |
| Code review | $0.30 - $0.80 |

Cost varies by topic complexity and response length. Anthropic (Claude) is typically the most expensive provider.

## License

Private project. Not open-sourced.
