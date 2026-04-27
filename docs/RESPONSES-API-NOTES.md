# Responses API Notes (extracted from OpenAI codex CLI)

> **Source:** `github.com/openai/codex` (Rust crate `codex-rs/`, snapshot taken
> 2026-04-26). Most of the wire-protocol logic lives in `codex-api/` and
> `codex-rs/core/src/client.rs`. The TypeScript SDK at `sdk/typescript/`
> shells out to the Rust binary, so it is not a useful reference for wire
> shapes.
>
> **Why:** Some Azure AI Foundry deployments (`gpt-5-pro`, `gpt-5.x-codex`,
> etc.) only support `/openai/v1/responses` and reject `/openai/v1/chat/completions`
> with HTTP 400. We need a parallel `executeResponses()` path in
> `@xcreos/azure-foundry-adapter`.

A note before diving in: in the current `main` branch, codex has **removed
the chat-completions wire API entirely**. `WireApi` is a single-variant enum
(`WireApi::Responses`), and the deserializer rejects `wire_api = "chat"` with
the message *"\`wire_api = \"chat\"\` is no longer supported"*
(`codex-rs/model-provider-info/src/lib.rs:40-74`). The capability detection
section below reflects that history; see also
<https://github.com/openai/codex/discussions/7782>.

---

## 1. Capability detection — chat vs responses

In codex the route is decided **per provider**, not per model: a provider is
configured with `wire_api = "responses"` (the only supported value today) and
all models served through that provider go down the Responses path.

`codex-rs/core/src/client.rs:1485-1535`:

```rust
pub async fn stream(
    &mut self,
    prompt: &Prompt,
    model_info: &ModelInfo,
    /* ... */
) -> Result<ResponseStream> {
    let wire_api = self.client.state.provider.info().wire_api;
    match wire_api {
        WireApi::Responses => {
            if self.client.responses_websocket_enabled() {
                // ... try websocket transport; fall through to HTTP on 426.
            }
            self.stream_responses_api(/* ... */).await
        }
    }
}
```

`codex-rs/model-provider-info/src/lib.rs:44-74`:

```rust
#[derive(Default, ...)]
#[serde(rename_all = "lowercase")]
pub enum WireApi {
    /// The Responses API exposed by OpenAI at `/v1/responses`.
    #[default]
    Responses,
}
// `wire_api = "chat"` deserialization returns:
//   "`wire_api = \"chat\"` is no longer supported.
//    How to fix: set `wire_api = \"responses\"` in your provider config."
```

**For our adapter the analogue is the `/openai/v1/models` capabilities
endpoint**: a deployment that returns `chat_completion: false` has to take
the Responses path. Codex doesn't probe that endpoint — it trusts the
config — but our adapter should:

- Cache per-model capabilities from `/openai/v1/models` (`responses: true`,
  `chat_completion: false`).
- Route to `executeResponses()` when `chat_completion === false` *or* when
  a previous `chat/completions` call returned 400 with
  `"operation is unsupported"`.

---

## 2. Request URL + headers

### URL

The HTTP path is just `responses` appended to the provider's `base_url`.
`codex-rs/codex-api/src/endpoint/responses.rs:100-102`:

```rust
fn path() -> &'static str { "responses" }
```

For OpenAI: `POST https://api.openai.com/v1/responses`.

For Azure (from `responses-api-proxy/README.md:82-89`, the only canonical
Azure example shipped in the repo):

```
POST https://YOUR_PROJECT_NAME.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT/responses?api-version=2025-04-01-preview
```

The `api-version` is supplied via `query_params` on the provider config and
appended by `Provider::url_for_path`
(`codex-rs/codex-api/src/provider.rs:53-75`). The Foundry "v1" alias
(`/openai/v1/responses`) used by your existing adapter works the same way —
just point `base_url` at `https://<resource>.cognitiveservices.azure.com/openai/v1`
and skip the deployment in the path.

### Auth

Codex uses **`Authorization: Bearer <token>`** for both OpenAI and Azure.
The `responses-api-proxy` README explicitly notes "ensure your deployment
accepts `Authorization: Bearer <key>`" for the Azure example. There is no
`api-key` header path in the codebase.

`codex-rs/model-provider/src/bearer_auth_provider.rs:31-46`:

```rust
impl AuthProvider for BearerAuthProvider {
    fn add_auth_headers(&self, headers: &mut HeaderMap) {
        if let Some(token) = self.token.as_ref()
            && let Ok(header) = HeaderValue::from_str(&format!("Bearer {token}"))
        {
            let _ = headers.insert(http::header::AUTHORIZATION, header);
        }
        // ChatGPT-Account-ID, X-OpenAI-Fedramp also added when applicable.
    }
}
```

**Practical note for our adapter:** Azure AI Foundry accepts *both*
`api-key: <key>` and `Authorization: Bearer <key>`. Your existing
chat-completions code likely sends `api-key`; you can keep that for the
Responses path too. If you later switch to Entra ID tokens, both endpoints
accept Bearer.

### Other headers

- `Accept: text/event-stream` (set by the streaming endpoint client,
  `codex-rs/codex-api/src/endpoint/responses.rs:135-138`).
- `Content-Type: application/json` (default for the JSON body).
- `OpenAI-Beta` is **not** sent on the HTTP Responses request. It only
  appears for the experimental WebSocket transport
  (`OpenAI-Beta: responses_websockets=2026-02-06`,
  `client.rs:138`, `client.rs:799-800`). Ignore for HTTP.
- `session_id: <conversation_id>` — application-level header codex sets
  alongside the trace headers (`headers.rs:5-11`). Optional; safe to omit.
- `x-codex-*` headers are codex-specific telemetry and routing tokens
  (`x-codex-installation-id`, `x-codex-turn-state`, `x-codex-window-id`,
  `x-codex-beta-features`). The server tolerates absence; do not send
  them from your adapter.
- For Azure-style endpoints codex additionally injects `id` fields onto
  every input item when `store=true` is set
  (`codex-rs/codex-api/src/requests/responses.rs:11-37`). See § 3 for why.

---

## 3. Request body shape

The canonical struct is `ResponsesApiRequest`
(`codex-rs/codex-api/src/common.rs:165-186`):

```rust
pub struct ResponsesApiRequest {
    pub model: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub instructions: String,
    pub input: Vec<ResponseItem>,           // typed array, not a string
    pub tools: Vec<serde_json::Value>,
    pub tool_choice: String,                // codex always sends "auto"
    pub parallel_tool_calls: bool,
    pub reasoning: Option<Reasoning>,
    pub store: bool,                        // false on OpenAI, true on Azure
    pub stream: bool,                       // codex always sends true
    pub include: Vec<String>,               // e.g. ["reasoning.encrypted_content"]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_tier: Option<String>,       // "priority" | "default" | "flex"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_key: Option<String>,   // conversation id
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<TextControls>,         // verbosity + JSON-schema output
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_metadata: Option<HashMap<String, String>>,
}
```

`build_responses_request` in `core/src/client.rs:829-903` is the assembly
site. Notable choices:

```rust
store: provider.is_azure_responses_endpoint(),  // forced true for Azure
stream: true,
tool_choice: "auto",
include: if reasoning.is_some() {
    vec!["reasoning.encrypted_content".to_string()]
} else { Vec::new() },
prompt_cache_key: Some(self.client.state.conversation_id.to_string()),
service_tier: match service_tier {
    Some(ServiceTier::Fast) => Some("priority".to_string()),
    Some(t) => Some(t.to_string()),                   // "default" | "flex"
    None => None,
},
```

### (a) Simple user prompt

```json
{
  "model": "gpt-5-pro",
  "instructions": "You are a helpful assistant.",
  "input": [
    { "type": "message", "role": "user",
      "content": [{ "type": "input_text", "text": "What's 2+2?" }] }
  ],
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": null,
  "store": false,
  "stream": true,
  "include": [],
  "prompt_cache_key": "conv-abc123"
}
```

### (b) Multi-turn with tool calls + tool results

The Responses API uses a flat array of typed items rather than the
chat-completions `messages` shape. Tool calls and their outputs are
**sibling items**, not nested arrays on the assistant message.

```json
{
  "model": "gpt-5-pro",
  "instructions": "...",
  "input": [
    { "type": "message", "role": "user",
      "content": [{ "type": "input_text", "text": "What's the weather in SF?" }] },

    { "type": "message", "role": "assistant",
      "content": [{ "type": "output_text",
                    "text": "Let me check the weather." }] },

    { "type": "function_call",
      "call_id": "call_abc",
      "name": "get_weather",
      "arguments": "{\"city\":\"SF\"}" },

    { "type": "function_call_output",
      "call_id": "call_abc",
      "output": "{\"temp_f\":62,\"sky\":\"sunny\"}" },

    { "type": "message", "role": "user",
      "content": [{ "type": "input_text", "text": "Thanks!" }] }
  ],
  "tools": [ /* see below */ ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "store": false,
  "stream": true,
  "include": []
}
```

The Rust enum that produces this shape lives at
`codex-rs/protocol/src/models.rs:751-902` (`pub enum ResponseItem`). All
variants are tagged with `#[serde(tag = "type", rename_all = "snake_case")]`,
so the `type` discriminator on the wire matches the variant name in
snake_case (`message`, `reasoning`, `function_call`, `function_call_output`,
`custom_tool_call`, `custom_tool_call_output`, `web_search_call`,
`image_generation_call`, `local_shell_call`, `tool_search_call`,
`tool_search_output`).

Content items inside a `message` come from
`codex-rs/protocol/src/models.rs:707-722`:

```rust
pub enum ContentItem {
    InputText  { text: String },              // type: "input_text"
    InputImage { image_url: String, ... },    // type: "input_image"
    OutputText { text: String },              // type: "output_text"
}
```

`function_call_output.output` is special: on the wire it is **either** a
plain string **or** an array of `{type:"input_text"|"input_image", ...}`
items (codex calls this `FunctionCallOutputPayload`,
`models.rs:814-824`). Most of the time you can send a JSON-encoded string
and be fine.

### (c) With `reasoning_effort`, `service_tier`, and tools

```json
{
  "model": "gpt-5-codex",
  "instructions": "...",
  "input": [ /* ... */ ],
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "Get the weather for a city.",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "city": { "type": "string", "description": "City name" }
        },
        "required": ["city"],
        "additionalProperties": false
      }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true,
  "reasoning": { "effort": "high", "summary": "auto" },
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "service_tier": "priority",
  "text": { "verbosity": "medium" },
  "prompt_cache_key": "conv-abc123"
}
```

Tool definition format comes from
`codex-rs/tools/src/responses_api.rs:25-38` and
`codex-rs/tools/src/tool_spec.rs:21-58`. The shape is **flat** — there is
no `function: { ... }` wrapper as in chat-completions. The discriminator is
the top-level `type: "function" | "custom" | "web_search" | "image_generation" | "local_shell"`.

**Required vs optional fields.** Empirically required by Foundry:
`model`, `input`. Codex always sends `tools`, `tool_choice`,
`parallel_tool_calls`, `store`, `stream`, `include`. Everything else uses
`#[serde(skip_serializing_if = "Option::is_none")]`. `instructions` is
omitted when empty (`#[serde(skip_serializing_if = "String::is_empty")]`).

**Conversation history representation.** Always an array of items, never a
string. Codex re-sends the entire history on every turn for the HTTP path
(see § 7).

**Azure quirk: item ids.** When `store=true` (Azure), codex re-attaches
the `id` field to each input item right before sending — Azure's
server-side store keys items by id and rejects payloads where the ids are
missing. `codex-rs/codex-api/src/endpoint/responses.rs:84-86`:

```rust
if request.store && self.session.provider().is_azure_responses_endpoint() {
    attach_item_ids(&mut body, &request.input);
}
```

Implementation at `requests/responses.rs:11-37`. If you set `store: true`
on Azure, replay the original `id` you got from
`response.output_item.added` / `.done` events on the next turn.

---

## 4. Streaming events (SSE)

### Wire format

Standard SSE: `event: <type>\ndata: <json>\n\n`. The payload's `type`
field always matches the SSE `event:` line, and codex parses *only* the
`data:` JSON — it ignores the SSE event line itself. Idle timeout is
configurable per provider (default ~10 minutes).

### Event types codex handles

From `codex-rs/codex-api/src/sse/responses.rs:285-419`:

| Event `type` | Becomes `ResponseEvent::…` | Notes |
| --- | --- | --- |
| `response.created` | `Created` | `data.response` is present but codex only checks existence. |
| `response.output_item.added` | `OutputItemAdded(item)` | Full `ResponseItem` inside `data.item`. Used to know an item is starting. |
| `response.output_item.done` | `OutputItemDone(item)` | Final, complete `ResponseItem`. Everything you actually need to persist comes from here. |
| `response.output_text.delta` | `OutputTextDelta(delta)` | `data.delta` is a string fragment. |
| `response.function_call_arguments.delta` | `ToolCallInputDelta { item_id, call_id?, delta }` | `data.item_id`, optional `data.call_id`, `data.delta` (string fragment of JSON args). |
| `response.custom_tool_call_input.delta` | `ToolCallInputDelta { ... }` | Same shape — for freeform/custom tools. |
| `response.reasoning_summary_text.delta` | `ReasoningSummaryDelta { delta, summary_index }` | Reasoning summary streaming. |
| `response.reasoning_text.delta` | `ReasoningContentDelta { delta, content_index }` | Raw reasoning streaming (only if subscribed via `include`). |
| `response.reasoning_summary_part.added` | `ReasoningSummaryPartAdded { summary_index }` | Marks the start of a new summary part. |
| `response.completed` | `Completed { response_id, token_usage, end_turn }` | Terminal — see schema below. |
| `response.failed` | maps to a typed `ApiError` | See § 8. |
| `response.incomplete` | `ApiError::Stream("Incomplete response returned, reason: …")` | Codex reads `response.incomplete_details.reason`. |
| `response.metadata` | `ModelVerifications(...)` | When `metadata.openai_verification_recommendation` is present. |

Anything else falls through `_ => trace!("unhandled responses event…")` and
is silently dropped (`responses.rs:413-415`). You can safely ignore
`response.in_progress`, `response.content_part.added`, etc.

The `ResponsesStreamEvent` parser only cherry-picks a few fields off the
JSON; the full event type list emitted by the platform is broader (see
<https://platform.openai.com/docs/api-reference/responses-streaming>) but
codex's parser works fine because the unknown fields are just ignored.

### Exact JSON shape codex parses

`codex-rs/codex-api/src/sse/responses.rs:167-180`:

```rust
#[derive(Deserialize, Debug)]
pub struct ResponsesStreamEvent {
    #[serde(rename = "type")]
    pub(crate) kind: String,
    headers: Option<Value>,
    metadata: Option<Value>,
    response: Option<Value>,    // present on response.created/.completed/.failed/.incomplete
    item: Option<Value>,        // present on output_item.added/.done
    item_id: Option<String>,    // present on *.delta
    call_id: Option<String>,    // present on function_call_arguments.delta
    delta: Option<String>,      // present on *.delta
    summary_index: Option<i64>, // reasoning_summary_*
    content_index: Option<i64>, // reasoning_text_*
}
```

### `response.completed` payload

```rust
struct ResponseCompleted {
    id: String,
    usage: Option<ResponseCompletedUsage>,
    end_turn: Option<bool>,
}
struct ResponseCompletedUsage {
    input_tokens: i64,
    input_tokens_details: Option<{ cached_tokens: i64 }>,
    output_tokens: i64,
    output_tokens_details: Option<{ reasoning_tokens: i64 }>,
    total_tokens: i64,
}
```

Mapped to `TokenUsage` at `responses.rs:139-155`.

### Tool-call streaming

Tool calls are streamed three ways and you should accumulate from any of
the three:

1. **`response.output_item.added`** with `item.type == "function_call"` —
   tells you a tool call is starting; `item.call_id`, `item.name` are
   already populated, but `item.arguments` is still a partial string
   (often `""` initially).
2. **`response.function_call_arguments.delta`** with `item_id`, `call_id`,
   `delta` (string fragments of the JSON arguments). Concatenate.
3. **`response.output_item.done`** with the *final* `function_call` item
   — `arguments` is the complete JSON-encoded string.

For the simplest correct implementation, **ignore the deltas and use only
`response.output_item.done`** — it carries the complete, final form of
each item. Codex itself does both because the TUI displays partial args
live, but for an SDK adapter the `done` events are sufficient.

### Reasoning streaming

Reasoning shows up as its own `ResponseItem::Reasoning` variant
(`models.rs:767-777`):

```rust
Reasoning {
    id: String,
    summary: Vec<ReasoningItemReasoningSummary>,
    content: Option<Vec<ReasoningItemContent>>,
    encrypted_content: Option<String>,
}
```

Streamed via `response.reasoning_summary_text.delta` and
`response.reasoning_text.delta`. The full final item arrives in
`response.output_item.done` with `item.type == "reasoning"`. To get
reasoning at all, you must request it via:

- `reasoning: { effort: "low" | "medium" | "high", summary: "auto" | "concise" | "detailed" }`,
- and `include: ["reasoning.encrypted_content"]` to get the encrypted blob
  back so you can replay it on the next turn.

### Usage tokens

Reported only at the end, on `response.completed.response.usage`. There is
no incremental token reporting in this stream (chat-completions also only
reports it at the end).

### Stream loop (verbatim shape)

`responses.rs:421-507`:

```rust
pub async fn process_sse(stream, tx_event, idle_timeout, telemetry) {
    let mut stream = stream.eventsource();
    let mut response_error = None;

    loop {
        let response = timeout(idle_timeout, stream.next()).await;
        let sse = match response {
            Ok(Some(Ok(sse))) => sse,
            Ok(Some(Err(e)))  => { /* stream error */ return; }
            Ok(None)          => { /* stream closed */ return; }
            Err(_)            => { /* idle timeout */ return; }
        };

        let event: ResponsesStreamEvent =
            serde_json::from_str(&sse.data).unwrap_or_continue();

        // ServerModel / ModelVerifications side-channels...

        match process_responses_event(event) {
            Ok(Some(event)) => {
                let is_completed = matches!(event, ResponseEvent::Completed { .. });
                tx_event.send(Ok(event)).await;
                if is_completed { return; }
            }
            Ok(None) => {}
            Err(error) => { response_error = Some(error.into_api_error()); }
        };
    }
}
```

Two important non-obvious behaviors:

1. **`response.failed` does not terminate the stream by itself.** Codex
   stashes the error in `response_error` and waits for the SSE to close
   (`Ok(None)`) before surfacing it. In practice the server will close the
   connection right after, but defensive readers should wait for either
   `response.completed` or socket close.
2. **Termination is `response.completed`**, not the SSE `[DONE]` sentinel.
   If you see `[DONE]` it'll fail JSON parse and be skipped harmlessly.

---

## 5. Tool calling

### Tool definition

Top-level `type` discriminator. For function tools
(`codex-rs/tools/src/responses_api.rs:25-38`):

```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Get the weather for a city.",
  "strict": false,
  "parameters": {
    "type": "object",
    "properties": { "city": { "type": "string" } },
    "required": ["city"],
    "additionalProperties": false
  }
}
```

Differences from chat-completions:

- No `function: { ... }` wrapper. Name/description/parameters are siblings
  of `type`.
- `strict` is a top-level boolean, not nested under `parameters` or
  `function`.

### Model's tool call in the response

A streamed item with `type == "function_call"`:

```json
{
  "type": "function_call",
  "call_id": "call_abc123",
  "name": "get_weather",
  "arguments": "{\"city\":\"SF\"}"
}
```

`arguments` is **always a JSON-encoded string**, not an object — this
matches chat-completions' behavior (codex notes this in
`models.rs:796-799`: *"The Responses API returns the function call
arguments as a string that contains JSON, not as an already-parsed
object."*).

### Tool result fed back

Sibling item, NOT a `tool` role message:

```json
{
  "type": "function_call_output",
  "call_id": "call_abc123",
  "output": "{\"temp_f\":62,\"sky\":\"sunny\"}"
}
```

`output` may be a plain string or a structured array (see § 3b).
`call_id` must match the call_id from the model's call.

There is no `tool_call_id`/`role: "tool"` message variant in the Responses
API.

---

## 6. Reasoning content

- Returned as a top-level item in `output`/`input`, not nested in a
  message.
- `type: "reasoning"`, with `summary` (visible) and optional `content`
  (raw — only when included), plus `encrypted_content` (opaque blob the
  client should send back on the next turn so the server can pick up
  reasoning state without storing it).
- Codex displays the *summary* in the TUI but not the full content. It
  always preserves `encrypted_content` and replays it as input on the next
  turn so the server can resume reasoning without state.
- To get reasoning back you must (1) set `reasoning: { effort, summary }`
  and (2) add `"reasoning.encrypted_content"` to `include`.

`core/src/client.rs:842-858`:

```rust
let reasoning = if model_info.supports_reasoning_summaries {
    Some(Reasoning {
        effort: effort.or(default_reasoning_effort),
        summary: if summary == ReasoningSummaryConfig::None {
            None
        } else { Some(summary) },
    })
} else { None };
let include = if reasoning.is_some() {
    vec!["reasoning.encrypted_content".to_string()]
} else { Vec::new() };
```

---

## 7. Session / state

**Codex re-sends the full conversation each turn over HTTP.** It does
*not* use `previous_response_id` on the HTTP path — the field exists in
`ResponseCreateWsRequest` but is set to `None` in
`From<&ResponsesApiRequest>` (`common.rs:188-209`).

`previous_response_id` is only used on the experimental WebSocket
transport, where codex sends an *incremental delta* (only the new items
since the last response) plus the previous `response_id`.

Implication for our adapter: **don't bother with `previous_response_id`.**
Re-send the full input array. Even if the server stores past state, you
get the same logical result and you avoid coupling your adapter to a
server-side store.

`store: false` (OpenAI default in codex) tells the server not to retain
the response. `store: true` (Azure default in codex) is required because
Azure needs to retain items to satisfy reasoning replay; codex compensates
by attaching `id` fields on every input item (see § 3).

For our adapter: pass `store: false` to mirror the OpenAI semantics, and
re-send the full conversation. If you ever need server-side reasoning
replay against Azure specifically, set `store: true` and propagate
`output_item.*` ids back into the next turn's input.

---

## 8. Error handling

`response.failed` events are mapped onto a typed `ApiError` enum in
`process_responses_event` / helpers (`responses.rs:334-368`,
`responses.rs:535-558`):

| `error.code` | Mapped to | Surfaced as |
| --- | --- | --- |
| `context_length_exceeded` | `ApiError::ContextWindowExceeded` | Fatal — non-retryable. |
| `insufficient_quota` | `ApiError::QuotaExceeded` | Fatal. |
| `usage_not_included` | `ApiError::UsageNotIncluded` | Fatal. |
| `cyber_policy` | `ApiError::CyberPolicy { message }` | Fatal — falls back to *"This request has been flagged for possible cybersecurity risk."* if message empty. |
| `invalid_prompt` | `ApiError::InvalidRequest { message }` | Fatal. |
| `server_is_overloaded` / `slow_down` | `ApiError::ServerOverloaded` | Retryable. |
| `rate_limit_exceeded` | `ApiError::Retryable { message, delay }` | Retryable; `delay` is parsed from message via regex `(?i)try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)` (`responses.rs:509-533`). |
| anything else | `ApiError::Retryable { message, delay: None }` | Default retryable. |

HTTP status handling at the transport layer
(`core/src/client.rs:1232-1252`):

- **401 Unauthorized**: triggers ChatGPT-auth refresh & retry. For our
  api-key adapter, surface as auth error and stop.
- **426 Upgrade Required** (websocket only): fall back to HTTP transport.
- Everything else (including 400 *"operation is unsupported"*) becomes a
  generic `ApiError` and bubbles up.

For our case the most important error to special-case is the **400
"operation is unsupported"** that Foundry returns when a Pro/codex model
is asked to use chat-completions. That's the signal to switch to the
Responses path. Once you're on Responses, the failures above are the ones
you'll actually see.

---

## 9. Differences vs chat-completions

A flat checklist of every gotcha.

- **Endpoint**: `/v1/responses` (or
  `/openai/deployments/<dep>/responses?api-version=…`) instead of
  `/v1/chat/completions`.
- **`messages` → `input`**: an array of typed items, not chat messages.
  No `role: "tool"` message — tool outputs are top-level
  `function_call_output` items.
- **`type` is the discriminator** on every item and content part.
- **Top-level fields renamed**:
  - `system` prompt → `instructions` (string at the top level, not a
    system message).
  - `max_tokens` → `max_output_tokens` (codex doesn't set it, but if you
    do, use the new name).
  - `temperature`/`top_p` accepted on most but not all reasoning models.
- **Streaming framing**: SSE event names like `response.created`,
  `response.output_text.delta`, `response.completed` instead of one
  generic `data:` line per chunk. The terminator is `response.completed`,
  not the `[DONE]` sentinel.
- **Tool call streaming**: arrives as standalone `output_item` events
  (`response.output_item.added` → `response.function_call_arguments.delta` →
  `response.output_item.done`). It is **NOT** a `tool_calls[]` array on a
  delta; tool calls are sibling output items, not properties of a message.
- **Tool definition shape**: flat (`{type:"function", name, description,
  parameters, strict}`), no `function: {…}` wrapper.
- **Tool arguments**: still a JSON-encoded *string*, not an object
  (consistent with chat-completions).
- **Tool output**: returned to the model as a `function_call_output` item
  with `call_id` matching the call. No `tool_call_id` field, no `role:
  "tool"`.
- **Reasoning is a first-class item type** (`type: "reasoning"`) with
  `summary`, `content`, and `encrypted_content`. Must opt in via
  `reasoning: { effort, summary }` + `include: ["reasoning.encrypted_content"]`.
  Replay `encrypted_content` on the next turn to preserve reasoning state.
- **Usage**: only at the end, in `response.completed.response.usage`.
  Field names: `input_tokens` / `output_tokens` / `total_tokens` (NOT
  `prompt_tokens` / `completion_tokens`). Cached tokens are nested:
  `input_tokens_details.cached_tokens`. Reasoning tokens at
  `output_tokens_details.reasoning_tokens`.
- **Multimodal**: `image_url` is `type: "input_image"` with an
  `image_url: "<url|data uri>"` string (and optional `detail`); not the
  chat-completions `{ type: "image_url", image_url: { url: "..." } }`
  shape.
- **`stop`/`stop_sequences`**: not supported (per OpenAI docs).
- **`logprobs`**: not supported.
- **`response_format` → `text.format`**: structured output schemas live
  under the `text` field (`text: { format: { type: "json_schema",
  schema: {...}, strict: true, name: "..." } }`) rather than the
  chat-completions `response_format` field.
- **`store`**: a boolean on the request indicating whether the server
  should retain the response. `false` is fine for OpenAI; **set `true`
  for Azure** and propagate item `id`s on subsequent turns. (Codex
  `is_azure_responses_endpoint()` matchers:
  `openai.azure.`, `cognitiveservices.azure.`, `aoai.azure.`,
  `azure-api.`, `azurefd.`, `windows.net/openai`,
  `provider.rs:116-127`.)
- **`previous_response_id`**: optional. Codex doesn't use it on HTTP and
  re-sends history. You can do the same.
- **`prompt_cache_key`**: stable per-conversation string used for prompt
  caching across turns. Codex sets it to the conversation id.
- **`service_tier`**: `"default"` | `"flex"` | `"priority"`. Codex maps
  its internal `Fast` to `"priority"`.
- **Tool choice**: `tool_choice: "auto" | "required" | "none"` or
  `{type:"function", name:"..."}`. Codex always sends `"auto"`.
- **Stream errors**: typed `code` field on `response.failed.error`
  (e.g. `context_length_exceeded`, `rate_limit_exceeded`, `cyber_policy`,
  `invalid_prompt`, `server_is_overloaded`). Use these for routing.

---

## Minimal `executeResponses()` skeleton

A starting template. Mirrors codex's HTTP path
(`core/src/client.rs:1157-1253` + `codex-api/src/endpoint/responses.rs` +
`codex-api/src/sse/responses.rs`). Drop into your existing adapter
shaped to whatever request/response types Paperclip uses; the wire shapes
are the load-bearing parts.

```typescript
// types.ts ----------------------------------------------------------------

type ResponsesContent =
  | { type: "input_text";  text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto"|"low"|"high" };

type ResponsesItem =
  | { type: "message"; role: "user"|"assistant"|"system"|"developer";
      content: ResponsesContent[]; id?: string }
  | { type: "function_call"; call_id: string; name: string;
      arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string;
      output: string | Array<{ type: "input_text"; text: string }> }
  | { type: "reasoning"; id?: string; summary: any[];
      content?: any[]; encrypted_content?: string };

type ResponsesTool = {
  type: "function";
  name: string;
  description?: string;
  strict?: boolean;
  parameters: object; // JSON schema
};

type ResponsesRequest = {
  model: string;
  instructions?: string;
  input: ResponsesItem[];
  tools?: ResponsesTool[];
  tool_choice?: "auto"|"required"|"none"|{type:"function",name:string};
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: "minimal"|"low"|"medium"|"high";
                summary?: "auto"|"concise"|"detailed" };
  include?: string[];
  store?: boolean;
  stream?: boolean;
  service_tier?: "default"|"flex"|"priority";
  prompt_cache_key?: string;
  text?: { verbosity?: "low"|"medium"|"high";
           format?: { type: "json_schema"; name: string;
                      schema: object; strict?: boolean } };
};

type ResponsesEvent =
  | { kind: "created" }
  | { kind: "output_item_added"; item: ResponsesItem }
  | { kind: "output_item_done";  item: ResponsesItem }
  | { kind: "output_text_delta"; delta: string }
  | { kind: "tool_args_delta";   call_id: string; delta: string }
  | { kind: "reasoning_summary_delta"; delta: string; index: number }
  | { kind: "reasoning_text_delta";    delta: string; index: number }
  | { kind: "completed"; response_id: string;
      usage?: { input_tokens: number; output_tokens: number;
                total_tokens: number; cached_input_tokens?: number;
                reasoning_output_tokens?: number };
      end_turn?: boolean };

// executeResponses.ts -----------------------------------------------------

export async function* executeResponses(
  cfg: { baseUrl: string; apiKey: string; deployment?: string;
         apiVersion?: string },
  req: ResponsesRequest,
  signal?: AbortSignal,
): AsyncGenerator<ResponsesEvent> {
  // 1. Build URL.
  // For Foundry "v1" alias: ${baseUrl}/openai/v1/responses
  // For classic Azure deployments:
  //   ${baseUrl}/openai/deployments/${deployment}/responses?api-version=${apiVersion}
  const url = cfg.deployment
    ? `${cfg.baseUrl.replace(/\/$/,"")}/openai/deployments/${cfg.deployment}` +
      `/responses?api-version=${cfg.apiVersion ?? "2025-04-01-preview"}`
    : `${cfg.baseUrl.replace(/\/$/,"")}/openai/v1/responses`;

  // 2. Headers. Azure accepts both api-key and Authorization: Bearer; pick
  //    whichever the rest of your adapter uses for chat-completions.
  const headers: Record<string,string> = {
    "Content-Type": "application/json",
    "Accept":       "text/event-stream",
    "api-key":      cfg.apiKey,
    // or: "Authorization": `Bearer ${cfg.apiKey}`,
  };

  // 3. Body. Force stream; defaults match codex's build_responses_request.
  const body = JSON.stringify({
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: req.reasoning ? ["reasoning.encrypted_content"] : [],
    ...req,
    stream: true,            // never let caller turn it off
  });

  const res = await fetch(url, { method: "POST", headers, body, signal });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Responses API ${res.status}: ${text}`);
  }

  // 4. SSE loop. Standard `event:`/`data:` framing, terminator is
  //    response.completed (not [DONE]).
  for await (const event of parseSse(res.body, signal)) {
    const out = mapResponsesEvent(event);
    if (out) yield out;
    if (out?.kind === "completed") return;
  }
}

// Tool-call accumulation (caller side) -----------------------------------

// Easiest correct strategy: ignore deltas and trust output_item_done.
// If you want live streaming of tool args (TUI use case), accumulate
// tool_args_delta by call_id alongside output_item_added.

export async function runTurn(
  cfg: any, req: ResponsesRequest,
): Promise<{ items: ResponsesItem[]; usage?: any; responseId: string }> {
  const items: ResponsesItem[] = [];
  let usage, responseId = "";
  for await (const ev of executeResponses(cfg, req)) {
    switch (ev.kind) {
      case "output_item_done": items.push(ev.item); break;
      case "completed":
        usage = ev.usage; responseId = ev.response_id; break;
      // output_text_delta / tool_args_delta only matter if you want to
      // surface them to a UI; not needed to reconstruct the final state.
    }
  }
  return { items, usage, responseId };
}

// SSE parser --------------------------------------------------------------

async function* parseSse(
  body: ReadableStream<Uint8Array>, signal?: AbortSignal,
): AsyncGenerator<{ type: string; data: any }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, nl); buf = buf.slice(nl + 2);
      let evType = "", dataStr = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) evType = line.slice(6).trim();
        else if (line.startsWith("data:"))
          dataStr += (dataStr ? "\n" : "") + line.slice(5).trim();
      }
      if (!dataStr) continue;
      try { yield { type: evType, data: JSON.parse(dataStr) }; }
      catch { /* drop malformed; codex does the same */ }
    }
  }
}

// Event mapping (mirrors process_responses_event in sse/responses.rs) ----

function mapResponsesEvent(ev: { type: string; data: any }): ResponsesEvent | null {
  const d = ev.data;
  // Prefer `data.type` if present; both should agree.
  const k = d?.type ?? ev.type;
  switch (k) {
    case "response.created":           return { kind: "created" };
    case "response.output_item.added": return { kind: "output_item_added", item: d.item };
    case "response.output_item.done":  return { kind: "output_item_done",  item: d.item };
    case "response.output_text.delta": return { kind: "output_text_delta", delta: d.delta ?? "" };

    case "response.function_call_arguments.delta":
    case "response.custom_tool_call_input.delta":
      return { kind: "tool_args_delta",
               call_id: d.call_id ?? d.item_id, delta: d.delta ?? "" };

    case "response.reasoning_summary_text.delta":
      return { kind: "reasoning_summary_delta",
               delta: d.delta ?? "", index: d.summary_index ?? 0 };
    case "response.reasoning_text.delta":
      return { kind: "reasoning_text_delta",
               delta: d.delta ?? "", index: d.content_index ?? 0 };

    case "response.completed": {
      const u = d.response?.usage;
      return {
        kind: "completed",
        response_id: d.response?.id,
        end_turn:    d.response?.end_turn,
        usage: u && {
          input_tokens:           u.input_tokens,
          output_tokens:          u.output_tokens,
          total_tokens:           u.total_tokens,
          cached_input_tokens:    u.input_tokens_details?.cached_tokens,
          reasoning_output_tokens:u.output_tokens_details?.reasoning_tokens,
        },
      };
    }

    case "response.failed": {
      const e = d.response?.error ?? {};
      const msg = e.message ?? "response.failed";
      switch (e.code) {
        case "context_length_exceeded": throw new ContextWindowExceeded(msg);
        case "insufficient_quota":      throw new QuotaExceeded(msg);
        case "rate_limit_exceeded":     throw new RateLimited(msg, parseRetry(msg));
        case "server_is_overloaded":
        case "slow_down":               throw new ServerOverloaded(msg);
        case "invalid_prompt":          throw new InvalidRequest(msg);
        default:                        throw new Error(msg);
      }
    }
    case "response.incomplete":
      throw new Error(`Incomplete response, reason: ${d.response?.incomplete_details?.reason ?? "unknown"}`);

    default:
      // response.in_progress, content_part.added, response.metadata, etc.
      return null;
  }
}

function parseRetry(msg: string): number | undefined {
  const m = /try again in\s*(\d+(?:\.\d+)?)\s*(s|ms|seconds?)/i.exec(msg);
  if (!m) return;
  const v = parseFloat(m[1]); const u = m[2].toLowerCase();
  return u === "ms" ? v : v * 1000;
}

class ContextWindowExceeded extends Error {}
class QuotaExceeded         extends Error {}
class InvalidRequest        extends Error {}
class ServerOverloaded      extends Error {}
class RateLimited           extends Error { constructor(m:string, public retryMs?:number){super(m);} }
```

That's the whole adapter surface. The four pieces a chat-completions
implementation has to add are: (1) URL routing per
`responses: true` capability, (2) the typed `input[]` shape for
conversation history, (3) the SSE event taxonomy with
`response.output_item.done` as the source of truth for tool calls, and
(4) usage extraction at `response.completed`. Everything else is the same
HTTP plumbing.
