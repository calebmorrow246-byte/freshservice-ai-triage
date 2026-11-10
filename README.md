# AI-Triage — AI first-pass triage for Freshservice tickets

A serverless [Freshworks FDK](https://developers.freshworks.com/) app that reads every new IT ticket the moment it is created and posts a **private, technician-only note** with a suggested summary, impact/urgency/priority, category, and next steps. The requester never sees it.

**Status:** in production (v1.8.2). **Tests:** 133 passing, 99.5% statement coverage (`npx vitest run --coverage`).

> This repository has been scrubbed of identifying information (company, host names, requester data). Test fixtures are synthetic.

---

## Why this exists

New tickets sat untriaged until a technician read each one, guessed a category and priority, and went hunting through the knowledge base. That first pass is repetitive, inconsistent between people, and slow at exactly the moment a ticket is freshest. The goal was a consistent first pass on every ticket, with **zero change visible to end users** and a human still making every actual decision (the app only *suggests* values; technicians set the real fields).

## Why it was built this way

**A purpose-built platform app, not a reuse of an existing integration.** I already had a broad Freshservice MCP server that covered most of the API calls needed. Two architectures were weighed before writing code:

| | Purpose-built FDK app (chosen) | Reuse existing integration |
|---|---|---|
| Capability surface | Read ticket, read KB, find similar tickets, write one private note | Inherits full read/write/delete across tickets, changes, agents, requesters |
| Hosting | None — runs on the platform | A service to host, patch and secure |
| Secrets | In the platform's encrypted install settings, never in code | Held by the hosted service |

An AI that fires on every ticket should have the smallest possible blast radius, so least privilege won over code reuse.

**Spend tokens only where they change the outcome.**

- **Deflection:** five recurring, templated ticket types (e.g. admin-consent requests, quarantine releases, scheduled-maintenance tickets) get a prewritten internal note and **never reach the model** — cost ≈ $0.
- **Taxonomy grounding only when needed:** if a ticket already has a portal-set category, the model never sees the taxonomy; the category is rendered into the note deterministically. Only uncategorized tickets get the full "pick strictly from the real category list" treatment. Large sub-category lists are keyword-prefiltered before they hit the prompt.
- **Prompt blocks are assembled per ticket** — instructions that can't apply (e.g. "no KB match" guidance when a match exists) are omitted.
- **KB retrieval is deterministic:** search the live KB (matching a ticket's literal product name first, then stopword-stripped text) and send the single best match. No vector database to run.

**Provider-swappable.** An install-page setting selects Anthropic Claude (default), OpenAI ChatGPT, or Microsoft Copilot (Azure OpenAI), with feature parity (including web-search grounding with cited sources). Each provider has its own key and model setting, so one install can hold all three and switch without retyping anything.

**Cost is measured, not guessed.** Each ticket's completion log carries a `$` figure computed from the provider's own reported token usage (plus search fees).

## What it improves

- Every new ticket gets a structured, consistent first pass: one-line summary, suggested impact / urgency / priority with reasoning, category, at most two concrete next steps, and KB links.
- Latency was measured at about **3.8–6.2 s per ticket** in live runs (Claude Haiku, no web search), against a platform execution cap of 20 s default / 40 s max. Re-measure if you enable web search or switch to a larger model.
- Approximate cost per ticket (Claude Sonnet 5): **deflected ≈ $0**, triage without search ≈ **$0.01–0.02** depending on pricing tier, roughly +$0.01 per web search. A cost-optimization pass earlier in the project cut per-ticket spend by trimming prompt blocks, prefiltering taxonomy and skipping already-categorized tickets. These are estimates from the project's cost log; your numbers will depend on provider, model and ticket mix.
- A built-in admin report page (filterable by provider and model) shows volumes, latency and cost. The `CHANGELOG.md` records the hard-won lessons of building it on the platform's key-value storage (rate limits, atomic appends, sharded reads).

## How it works

```
onTicketCreate
  → PoC gate (optional: limit to a group/workspace)
  → recurring-ticket deflection  ──► prewritten note, no AI call
  → KB search  +  category taxonomy (only if uncategorized)
  → AI provider (Claude / ChatGPT / Azure OpenAI), optional web search
  → PRIVATE note on the ticket (summary · priority · category · next steps · KB + web sources)
```

```
.
├── manifest.json          # platform 3.0, ticket-created event, request whitelist
├── config/
│   ├── iparams.json       # install-page settings: provider, keys (secure), models, gates
│   └── requests.json      # outbound request templates (Anthropic, OpenAI, Azure, Freshservice)
├── server/
│   ├── server.js          # onTicketCreate handler, provider registry, prompts, cost logging
│   └── test_data/         # synthetic payloads for local runs
├── app/                   # admin report page
├── tests/                 # 133 vitest unit tests
├── CHANGELOG.md           # full release history and the reasoning behind each change
└── sync-version.js        # keeps package.json / iparams / changelog versions aligned
```

## Stack

JavaScript (Node, Freshworks FDK serverless), Vitest, Anthropic Claude API, OpenAI API, Azure OpenAI, Freshservice REST API.

## Run and test

```bash
npm install
npx vitest run --coverage     # 133 tests
```

To run the app itself you need the Freshworks FDK (`fdk validate`, `fdk run`, `fdk pack`) and a Freshservice account. Store provider keys in the app's secure install parameters, never in the repository. The shipped test data is synthetic; do not commit real keys or ticket data.

## License

MIT — see `LICENSE`.
