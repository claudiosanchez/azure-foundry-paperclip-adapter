# @xcreos/azure-foundry-paperclip-adapter

Paperclip adapter for **Azure AI Foundry** — run Foundry deployments
(Azure-hosted OpenAI/codex/embeddings/audio/image models) as managed
employees in a Paperclip company.

Unlike the bundled `codex_local` / `hermes_local` / etc. adapters, this one
talks directly to Foundry over HTTPS — **no CLI subprocess**, **no OpenAI
SDK**, just `fetch` against the Foundry endpoint.

## Status

**MVP — milestone 1.** Streams chat completions from any Foundry chat-capable
deployment. Tool calls are surfaced as events but **not executed yet**
(milestone 2 — agent loop with sandbox tools).

## Install

```bash
pnpm add @xcreos/azure-foundry-paperclip-adapter
```

Then add it to your Paperclip server's adapter list (same way
`hermes-paperclip-adapter` is registered today).

## Configure

A Paperclip agent record using this adapter has `adapterType: "azure_foundry"`
and an `adapterConfig` shaped like:

```jsonc
{
  "endpoint": "https://foundry-coxshire-eastus2.cognitiveservices.azure.com/",
  "apiKey":   { "type": "plain", "value": "<your-foundry-key>" },
  "deployment": "gpt-5-5",
  "apiVersion": "2024-10-21",
  "reasoningEffort": "medium",
  "instructionsFilePath": "/abs/path/to/AGENTS.md",
  "enableToolLoop": false,
  "timeoutSec": 300
}
```

Or set defaults in env: `AZURE_FOUNDRY_ENDPOINT`, `AZURE_FOUNDRY_API_KEY`,
`AZURE_FOUNDRY_DEPLOYMENT`.

## Stdout protocol

The adapter emits structured events on stdout, prefixed `AF::`, parsed by the
UI helper `parseAzureFoundryStdoutLine`:

```
AF::{"kind":"token","text":"Hello"}
AF::{"kind":"tool_call","id":"call_1","name":"read_file","arguments":"{\"path\":\"/x\"}"}
AF::{"kind":"usage","input":120,"output":85}
AF::{"kind":"finish","reason":"stop"}
```

## Roadmap

- **M1 (this release):** Streaming chat completions; tool calls surfaced as events.
- **M2:** Tool loop — execute tool_calls against Paperclip's adapter-utils
  sandbox (read_file, write_file, run_shell, search_web). Multi-turn until
  finish_reason === "stop".
- **M3:** Sibling adapters: `azure_foundry_embeddings`, `azure_foundry_realtime`,
  `azure_foundry_image`, `azure_foundry_transcribe`.
- **M4:** Live deployment discovery from `/openai/v1/models` rendered as a
  dropdown in the create-agent UI.

## Build

```bash
pnpm install
pnpm build
```

## Local link into Paperclip

```bash
pnpm build
pnpm link --global
cd /path/to/Paperclip/server
pnpm link --global @xcreos/azure-foundry-paperclip-adapter
```

Then register the adapter in the server's adapter registry (see
`server/src/adapters/index.ts` for the existing registration pattern used by
`hermes-paperclip-adapter`).

## License

MIT
