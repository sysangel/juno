# Hermes Agent Architecture: How the "Brain" Works

> Research notes on what's scaffolded around the LLM to make it "Hermes," based on
> reading the actual source at `C:\Users\Core\AppData\Local\hermes\hermes-agent\`
> (Hermes Agent v0.16.0 by Nous Research).

---

## 1. Project Layout (the 10,000ft view)

```
hermes-agent/
├── run_agent.py              # AIAgent class — facade with forwarders
├── model_tools.py            # Tool definitions + handle_function_call dispatcher
├── toolsets.py               # Toolset groupings (web, terminal, file, etc.)
├── tools/                    # One file per tool, self-registering
│   └── registry.py           # Central ToolRegistry singleton
├── agent/                    # 92 files — the actual "brain"
│   ├── conversation_loop.py  # THE loop (~4400 lines)
│   ├── system_prompt.py      # 3-tier system prompt assembly
│   ├── prompt_builder.py     # Skills index, environment hints, identity
│   ├── memory_manager.py     # Persistent memory orchestration
│   ├── context_compressor.py # Context compression (~2400 lines)
├── tool_executor.py          # Sequential + concurrent tool execution
│   ├── credential_pool.py    # Multi-key rotation
│   ├── turn_context.py       # Per-turn setup (prologue)
│   ├── turn_finalizer.py     # Post-loop cleanup
│   ├── iteration_budget.py   # Turns-spent tracking
│   └── ... (80+ more)
├── gateway/                  # Messaging platform adapters
├── cli.py                    # Interactive TUI (prompt_toolkit)
├── hermes_cli/               # CLI subcommands, config
├── cron/                     # Scheduler
└── tests/                    # ~3000 tests
```

**Key insight**: `run_agent.py` is a **facade**. The `AIAgent` class is ~5400 lines,
but almost every method is a thin forwarder: `run_conversation()` →
`agent.conversation_loop.run_conversation()`, `_execute_tool_calls()` →
`agent.tool_executor.execute_tool_calls_*()`, `_build_api_kwargs()` →
`agent.chat_completion_helpers.build_api_kwargs()`. The actual logic lives in the
`agent/` directory.

---

## 2. The Conversation Loop (the "brain")

File: `agent/conversation_loop.py` — function `run_conversation(agent, user_message, ...)`
at line 436.

This is the heart. Here's the flow:

### Phase 1: Per-turn setup (the prologue)

```python
_ctx = build_turn_context(agent, user_message, ...)
```

This function (in `turn_context.py`) handles:
- Stdio guarding (safe writers for Windows)
- User message sanitization (strip surrogates)
- System prompt restore-or-build (cached on `agent._cached_system_prompt`)
- Crash-resilience persistence
- Preflight compression check
- Plugin `pre_llm_call` hook
- External memory prefetch

### Phase 2: The main loop

```python
while (api_call_count < agent.max_iterations
       and agent.iteration_budget.remaining > 0) or agent._budget_grace_call:
```

Each iteration:

1. **Check for interrupt** — `agent._interrupt_requested` (user sent new message)
2. **Consume iteration budget** — `agent.iteration_budget.consume()`
3. **Drain `/steer`** — if the user injected a mid-turn steer, append it to the last
   tool message
4. **Build `api_messages`** — copy from internal `messages`, inject ephemeral context
   (memory prefetch, plugin context) into the user message, strip internal fields
5. **Prepend system prompt** — the cached, byte-stable string
6. **Apply Anthropic prompt caching** — inject `cache_control` breakpoints if using
   Claude
7. **Sanitize** — strip orphaned tool results, drop thinking-only turns, normalize
   JSON whitespace for cache stability
8. **Make the API call** — via `_perform_api_call()` which uses streaming by default
   (even without stream consumers, for health-checking: 90s stale-stream detection,
   60s read timeout)
9. **Validate response** — check for invalid/empty responses, content policy refusals
10. **Retry with backoff** — jittered exponential backoff (5s base, 120s cap), up to
    `max_retries`
11. **Fallback chain** — if all retries fail, switch to a fallback provider/model

### Phase 3: Response dispatch

After a valid response:

```python
if assistant_message.tool_calls:
    # Execute tools, append results, continue loop
    agent._execute_tool_calls(assistant_message, messages, ...)
    # Check compression
    if compressor.should_compress(real_tokens):
        messages = agent._compress_context(...)
    continue
else:
    # No tool calls = final response
    final_response = assistant_message.content
    break
```

**The loop exits when:**
- Model returns text without tool calls → **done**
- Max iterations (default 90) or iteration budget exhausted
- User interrupt
- Content policy refusal (after trying fallback)
- Empty response after 3 retries + fallback chain exhausted
- Tool guardrail halt

---

## 3. Tool System

### Registry (`tools/registry.py`)

- **Singleton** `ToolRegistry` with a `register()` method
- **Auto-discovery**: any `tools/*.py` file with a top-level `registry.register()`
  call is imported automatically at startup
- Each `ToolEntry` holds: `name`, `toolset`, `schema` (OpenAI function format),
  `handler` (callable), `check_fn` (conditional availability), `requires_env`
- `check_fn` results are **TTL-cached (30s)** so env-var changes take effect quickly

```python
registry.register(
    name="example_tool",
    toolset="example",
    schema={"name": "example_tool", "description": "...", "parameters": {...}},
    handler=lambda args, **kw: example_tool(**args),
    check_fn=check_requirements,
    requires_env=["EXAMPLE_API_KEY"],
)
```

### Tool definitions (`model_tools.py`)

- `get_tool_definitions(enabled_toolsets, disabled_toolsets)` → resolves which tools
  are available, calls `registry.get_definitions()` which filters by `check_fn()`
- Returns OpenAI-format tool schemas (function calling format)
- **Memoized** — results cached until `check_fn` TTL expires or toolset changes

### Tool dispatch (`model_tools.py::handle_function_call`)

```python
def handle_function_call(function_name, function_args, task_id, ...):
    function_args = coerce_tool_args(function_name, function_args)  # "42"→42
    # ... tool search bridge dispatch ...
    entry = registry.get(function_name)
    result = entry.handler(function_args, task_id=task_id, ...)
    # Secret redaction on result
    return result  # JSON string
```

### Tool execution (`agent/tool_executor.py`)

- `_execute_tool_calls()` decides between **sequential** and **concurrent** execution
- `_should_parallelize_tool_batch()` — read-only tools can always parallelize; file
  writes only when paths don't overlap
- Each tool result is appended as
  `{"role": "tool", "tool_call_id": "...", "content": "..."}`

### Toolsets (`toolsets.py`)

- Tools are grouped into named toolsets: `web`, `terminal`, `file`, `vision`,
  `delegation`, `memory`, etc.
- `_HERMES_CORE_TOOLS` is the default bundle
- Enable/disable per-platform via `hermes tools`
- Changes take effect on next session (`/reset`) — **never mid-conversation**
  (preserves prompt cache)

---

## 4. System Prompt (the identity + instructions)

File: `agent/system_prompt.py::build_system_prompt_parts()`

**Built once per session**, cached on `agent._cached_system_prompt`, replayed verbatim
every turn. Three tiers joined with `\n\n`:

| Tier | Contents | Mutability |
|------|----------|------------|
| **stable** | Identity (SOUL.md or DEFAULT_AGENT_IDENTITY), tool guidance, skills index, environment hints, platform hints, per-model operational guidance | Never changes mid-session |
| **context** | Caller-supplied `system_message`, context files (AGENTS.md, .cursorrules, HERMES.md) | Static for session |
| **volatile** | Memory snapshot, USER.md profile, external memory block, timestamp/session/model line | Only changes on compression |

**The sacred invariant**: the system prompt is byte-stable for the life of a
conversation. This keeps upstream prompt caches (Anthropic, OpenRouter, vLLM) warm.
The only exception is context compression, which triggers a full rebuild.

Ephemeral data (memory prefetch, plugin context) is injected into the **user message**
at API-call time, NOT the system prompt — so the cache prefix stays untouched.

---

## 5. Memory System

File: `agent/memory_manager.py`

- `MemoryManager` orchestrates a **builtin provider** + at most **one external
  provider** (Honcho, Mem0, etc.)
- Memory is stored as text files in `~/.hermes/memories/` (builtin) or via provider
  API
- Two stores: `user` (who you are) and `memory` (environment facts, lessons learned)
- Memory is injected into the **system prompt volatile tier** at session start
- At end of turn, `should_review_memory` triggers a background memory review (the
  agent decides if anything is worth remembering)
- `build_memory_context_block()` wraps prefetched external memory into a fenced block
  injected into the user message

---

## 6. Context Compression

Files: `agent/context_compressor.py` (~2400 lines),
`agent/conversation_compression.py`

- **Triggered when**: `compressor.should_compress(real_tokens)` — default threshold is
  50% of context window
- Uses **API-reported `prompt_tokens`** (not estimates) when available
- Compression creates a **new session** — the old messages are summarized and replaced
- The system prompt is rebuilt after compression (the only time it changes
  mid-session)
- Max 3 compression attempts per turn

---

## 7. Provider Abstraction & Credential Pooling

File: `agent/credential_pool.py` (~2200 lines)

- 20+ providers: OpenRouter, Anthropic, OpenAI, DeepSeek, xAI, Google, Z.AI, MiniMax,
  Kimi, etc.
- All go through the **OpenAI SDK** (`client.chat.completions.create()`) — the OpenAI
  chat completions format is the universal interface
- **Transport adapters** normalize different API modes:
  - `chat_completions` (default — OpenAI format)
  - `anthropic_messages` (native Anthropic API)
  - `codex_responses` (OpenAI Responses API)
  - `bedrock_converse` (AWS Bedrock)
- **Credential pools** rotate across multiple API keys automatically
- **Fallback chain** — if a provider fails, switch to the next configured
  provider/model
- **Rate limit tracking** — Nous Portal rate guard, per-provider exhaustion tracking

---

## 8. What Makes It "Hermes" (the scaffolding around the LLM)

Summarizing what wraps around the raw model:

1. **The conversation loop** — iterative tool-calling until text response or budget
   exhausted
2. **System prompt assembly** — 3-tier cached prompt with identity, skills,
   environment, memory
3. **Tool registry + auto-discovery** — self-registering tools with conditional
   availability
4. **Tool dispatch** — sequential/concurrent execution with arg coercion, secret
   redaction, guardrails
5. **Memory system** — persistent cross-session memory injected into prompts
6. **Context compression** — automatic summarization near token limits
7. **Credential pooling + fallback** — multi-key rotation, provider failover
8. **Skills system** — reusable procedural knowledge loaded into context
9. **Session persistence** — SQLite + FTS5 session store for resume/search
10. **Gateway** — multi-platform messaging (Telegram, Discord, Slack, 20+ others)
11. **Plugin system** — hooks like `pre_llm_call`, `pre_api_request`,
    `post_tool_call`
12. **Cron scheduler** — durable scheduled jobs
13. **Delegation** — subagent spawning with isolated context
14. **Security layer** — secret redaction, command approval, PII redaction
15. **Middleware** — LLM request/response middleware chain
16. **Display layer** — prompt_toolkit TUI, streaming, spinners

---

## 9. Key Takeaways for Building Your Own Harness

If you want to extract the "brain" pattern for your own agent harness:

1. **The loop is simple in concept**: `while iterations < max: call LLM → if
   tool_calls: execute → continue; else: break`. The complexity in Hermes comes from
   4400 lines of error recovery, retry, fallback, compression, and edge-case
   handling.

2. **Everything uses OpenAI chat completions format** — tools, messages, responses.
   The OpenAI SDK is the universal client.

3. **The system prompt is built once and cached** — this is critical for prompt
   caching. Inject ephemeral data into the user message, not the system prompt.

4. **Tools self-register** via a registry pattern — each tool file calls
   `registry.register()` at import time.

5. **Memory is just text files** injected into the prompt — no magic, just structured
   text in the volatile tier.

6. **The `AIAgent` class is a facade** — all real logic is delegated to `agent/*.py`
   modules. This is intentional decomposition from what was originally a god-file.
