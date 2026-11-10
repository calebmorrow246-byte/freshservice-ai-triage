# Changelog — AI-Triage

**Mandatory from 2026-08-05 onward** (see `../CLAUDE.md`): every change to the app gets an entry
here, and any `fdk pack` repackage states its target version before running.

Semantic versioning (`MAJOR.MINOR.PATCH`):

- **Patch (`1.0.x`):** maintenance only — FDK/Node toolchain bumps, dependency updates
  (vitest/vite), prompt wording tweaks, bug fixes with no behavior change to install/iparams.
  Republish (repack + re-upload to the Developer Portal) recommended but not strictly required.
- **Minor (`1.x.0`):** new features — new iparams, new gating logic, new KB/taxonomy grounding
  behavior, a new `claude_model` default. **Republish required** since installed iparams schemas
  may need a value added.
- **Major (`2.0.0`):** breaking changes — manifest module/event changes, removed/renamed iparams,
  anything requiring an existing install to be reconfigured or reinstalled.

See `../Maintenance-Schedule.md` for the full republish-trigger checklist.

**Version is also shown on the install page itself** — `config/iparams.json`'s
`freshservice_domain` field description leads with "AI-Triage vX.X.X" (FDK's iparams schema has
no dedicated static-text/read-only field type or top-level title, confirmed against the v3.0
install-page docs, so an existing field's helper text is the only repo-controlled way to surface
it). **Whenever `package.json`'s version bumps, update that description string to match** — it
won't happen automatically.

**This semver is independent of the Developer Portal's own version numbering.** The Portal's
"Code File" screen auto-labels every publish "Live Version 1.0", "Live Version 2.0", etc. — a
sequential publish counter it generates itself, unrelated to the uploaded zip's filename or this
file's version numbers (confirmed 2026-08-05: uploading `AI-Triage-v1.0.0.zip` became "Live
Version 2.0" in the Portal, right after the original `ai-triage.zip` upload, which was "Live
Version 1.0"). Don't expect these two numbering systems to ever match up — this file is the
source of truth for what actually shipped and why; the Portal's numbers are just its own publish
history.

## 1.8.2 (2026-09-03) — Dev toolchain security patch

- **Security:** Upgraded vitest 2.1.9 → 3.2.7, @vitest/coverage-v8 2.1.9 → 3.2.7, and
  vite 5.0.13 → 6.4.3 to resolve 64 Mend-reported CVEs in the dev toolchain (including
  CRITICAL CVE-2026-47429, CVSS 9.8). A second `npm audit fix` pass resolved a remaining
  `brace-expansion` DoS (GHSA-rgw5-rvv9-x895) — result: 0 vulnerabilities.
  All three packages are devDependencies only; no change to the shipped FDK bundle, server
  logic, or install behavior. Republish optional (patch = maintenance/optional per
  Maintenance-Schedule.md). All 133 unit tests pass under vitest 3.x.

  Note: Maintenance-Schedule.md flags these as FDK-scaffolded pins. If `fdk run` or
  `fdk validate` regenerates them back to 2.x in a future session, re-run `npm install`
  with the `^3.2.6` ranges already in package.json to restore.

## 1.8.1 (2026-09-03) — Pricing corrections for Azure GPT-5.6-sol and add GPT-4.1

- **Fix:** `gpt-5.6-sol` pricing updated from $4/$20 to $5/$30 per 1M tokens — Azure charges a premium over OpenAI direct for this model; `gpt-5.6` alias corrected to match.
- **Add:** `gpt-4.1` pricing entry at $2 input / $8 output per 1M tokens (Azure Global Standard, verified 2026-09-03).

No behavior change; cost estimates in the report will now be accurate when the Copilot provider is set to `gpt-5.6-sol` or `gpt-4.1`.

## 1.8.0 (2026-09-02) — Microsoft Copilot (Azure OpenAI) as a third AI provider

Leadership asked for Microsoft Copilot support. It is now a first-class provider option alongside Claude and ChatGPT, selectable from the `ai_provider` install-page dropdown.

**"Microsoft Copilot" in this context means Azure OpenAI Service.** The enterprise developer path to Copilot is Azure — the same GPT-4o/GPT-4 models hosted on Microsoft's infrastructure, billed to an Azure subscription, with Microsoft's compliance and data-residency guarantees. There is no consumer Copilot API; programmatic access goes through Azure OpenAI Service.

**The endpoint differs meaningfully from the OpenAI provider.** Azure OpenAI uses the Chat Completions API (`POST /openai/deployments/{deployment}/chat/completions?api-version=...`) rather than the Responses API (`POST /v1/responses`). This means the **deployment name lives in the URL path, not the request body** — `buildBody` ignores the `model` argument entirely; the `copilotChatCompletions` request template substitutes `iparam.copilot_deployment` into the path. Auth is the `api-key` header rather than `Authorization: Bearer`. Response shape is `choices[0].message.content` with `usage.prompt_tokens` / `usage.completion_tokens`.

**Web search is not supported on this provider.** Azure OpenAI grounding requires a separate Azure Bing Search resource and a different request schema (the `data_sources` field). Enabling `enable_web_search` with the Copilot provider is silently safe — `webSearchTools` returns `undefined` and no tool is attached — but no search will happen. Use the Anthropic or OpenAI provider when web-search grounding is needed.

**A separate `copilot_model` iparam exists only for cost reporting.** Azure deployments are named by the operator (e.g. `gpt-4o-prod`), not the underlying model, so the deployment name alone is not enough to look up pricing. `copilot_model` holds the base model string (e.g. `gpt-4o`, `gpt-4o-mini`) and is used only by `estimateCost` and the log line — it does not affect the API call. Pricing entries for `gpt-4o`, `gpt-4o-2024-11-20`, `gpt-4o-mini`, and `gpt-4-turbo` are now in `MODEL_PRICING_PER_MTOK`.

New iparams: `copilot_api_key` (Azure key, secure), `copilot_endpoint_host` (Azure resource host), `copilot_deployment` (deployment name for the URL), `copilot_api_version` (default `2025-01-01-preview`), `copilot_model` (base model for cost reporting, default `gpt-4o`). The `ai_provider` dropdown gains `copilot` as a third option.

**Note for secrets-hygiene.ps1:** `copilot_api_key` must be added to `Set-FdkIparamKeys` and the `Clear-FdkSecrets` scrub regex, same as `openai_api_key` was in v1.6.0.

## 1.6.0 (2026-08-27) — Provider-swappable: Anthropic Claude or OpenAI ChatGPT

Leadership asked for the app to be swappable to ChatGPT. It now is, as an install-page setting, with **feature parity on both paths** — including web-search grounding and cited sources. Anthropic remains the default, so the existing sandbox install is unaffected by this release.

**The Anthropic coupling was smaller than expected.** KB search, the category taxonomy, recurring-ticket deflection, the sharded storage writer and the whole report page never knew which AI answered. Only five things did — the request template, the request body, the response shape, the web-search tool spec, and the model ID — and all five now live in a `PROVIDERS` registry. Each adapter normalises one API turn into a single neutral shape:

```
{ text, citations, inputTokens, outputTokens, webSearchRequests, paused, truncated, assistantContent }
```

so `callModel()` (formerly `callClaude()`) runs one loop regardless of who is answering. Adding a provider is a registry entry plus a request template — it does not touch the loop.

**OpenAI uses the Responses API (`POST /v1/responses`), not Chat Completions.** That was the deciding factor for parity: the built-in `web_search` tool only exists there, and its `url_citation` annotations map straight onto the existing `addWebCitation()` path, so the "Web sources" footer works identically on both providers. Its `usage.input_tokens` / `usage.output_tokens` happen to match Anthropic's field names exactly; truncation does not, and is read from `incomplete_details.reason === "max_output_tokens"` rather than a stop reason.

**`reasoning: { effort: "none" }` is mandatory on the OpenAI path, not a tuning choice.** GPT-5 models reason by default and reasoning tokens bill against `max_output_tokens`. At the default `output_budget` of 512, leaving it on can consume the entire budget and return an **empty note**. This is the exact counterpart to the `thinking: { type: "disabled" }` decision made for Sonnet 5 in 1.1.0, and it is asserted in the tests so nobody "cleans it up" later.

**Web-search cost accounting has a wrinkle worth recording.** Both providers charge $10 per 1,000 searches, so `WEB_SEARCH_COST_PER_USE` needed no change. But OpenAI emits a `web_search_call` output item per *action*, and only `search` carries the fee — reasoning models also emit free `open_page` and `find_in_page` actions. Counting those would have overstated cost in the report on exactly the tickets that search hardest. `openaiSearchCount()` filters on the action type.

**`claude_model` was deliberately NOT renamed.** A neutral `ai_model` would read better, but renaming an iparam is a breaking change under this file's own semver policy and would force the existing install to be reconfigured. Instead `openai_model` sits alongside it, so one install can hold credentials and a model choice for both providers at once and switch between them without retyping either.

New iparams: `ai_provider` (dropdown, `anthropic` | `openai`, default `anthropic`), `openai_api_key`, `openai_model` (default `gpt-5.6-terra`), `openai_host` (default `api.openai.com`). `anthropic_api_key` is **relaxed to `required: false`** — otherwise an OpenAI-only install could not be completed on the install page.

**That relaxation forced a real guard, and the guard exposed a gap in the tests.** With the key no longer mandatory, a missing one had to be caught deliberately; `callModel()` now throws naming the exact install-page field rather than letting an empty auth header become a confusing 401 three retries deep. Adding it turned 55 of the 80 existing tests red — because no fixture had *ever* carried an API key. They only passed because nothing checked. The fixtures were unfaithful to production, where the field was `required: true` and therefore always present; they now carry one.

**Report entries record `provider` and `model`.** Comparing a Claude run against a ChatGPT one is the entire point of the swap, and without this the report cannot tell them apart. Entries written before 1.6.0 simply lack the fields.

**`secrets-hygiene.ps1` had to be extended, and this was a genuine leak risk rather than housekeeping.** FDK's debug log records full outbound request headers, and `Clear-FdkSecrets` scrubbed only `freshservice|anthropic`. An OpenAI key would have been written into `.fdk/localstore` and never removed. Both `Set-FdkIparamKeys` (new optional `-OpenAIKey`) and the scrub regex now cover it, verified end-to-end against a synthetic localstore: all three keys seed, all three redact, `openai_host` correctly untouched. A note at the top of that file now states the rule — every provider key added to `iparams.json` must be added to both functions.

The demo launchers read the key from Windows Credential Manager target **`ChatGPT Token`** (env fallback `FS_DEMO_OPENAI_KEY`). A missing OpenAI key **warns rather than exits**, so the Anthropic demo path still runs on a machine without OpenAI access.

**Forward compatibility — M365 Copilot.** Named as a future requirement, so two seams exist now that would be expensive to retrofit: an optional `prepare` hook on each adapter (both current providers leave it `null`), and `openai_host` as an iparam. Without `prepare` the registry would silently assume "auth is one static header substituted into a template" — precisely the assumption Copilot breaks, since it needs an Entra OAuth token fetched per request rather than a static key. **Copilot is not a config change and should not be budgeted as one:** its surfaces are Graph-oriented rather than a completions endpoint, much of the API runs in delegated-user context (awkward for an unattended webhook with no signed-in person), and licensing is per-user. Confirm an unattended application-permission path to a completion-like endpoint actually exists before committing it. If it does not, Azure OpenAI on the company tenant is the realistic Microsoft-stack answer and *is* nearly config-only against this seam.

**Validation.** `fdk validate` passes with the same 3 pre-existing warnings as 1.5.0 — confirming three assumptions at once: FDK accepts a `dropdown` iparam with an `options` array, an iparam-substituted `host` works on a non-Freshservice template (previously only proven for `freshservice_domain`), and an unpopulated iparam inside a template header does not fail validation.

**Tests: 96 passing** (80 existing, 16 new). The new block covers provider routing in both directions, the unset-provider default, an unknown provider falling back rather than dropping the ticket, the Responses request shape, model override and default, both missing-key guards, web-search tool attachment and citation dedupe, billable-action counting, OpenAI pricing, `incomplete_details` truncation, non-200 handling, `provider`/`model` in the log entry, empty-output handling, KB grounding on the OpenAI path, and deflection still short-circuiting before any OpenAI call.

**At release time no live OpenAI call had been made** — everything above was unit-tested against mocked responses. That was resolved the same day; see 1.6.1 below for the live results and the defect they exposed.

> ### ⚠️ Last verified-stable version at the time of this release: **1.5.0**
>
> **1.5.0 remains the last build with production-scale evidence behind it** — 1,658 production
> tickets replayed 2026-08-24 with 0 failures and 1,656 report entries, plus three earlier sandbox
> runs totalling 230 tickets with zero loss. **It stays the rollback target**, and its artifact is
> retained at `dist/AI-Triage-v1.5.0.zip`.
>
> The Anthropic path is unchanged in behaviour across 1.5.0 → 1.6.x and its regression tests all
> pass — but roll back to the 1.5.0 zip rather than merely flipping `ai_provider` if the cause of a
> problem is unclear, since 1.6.0 also changed the report page and the log-entry shape.

## 1.7.4 (2026-08-28) — "Wipe today's logs" debug button

Adds a **⨯ Wipe today's logs** button to the report page's admin toolset (visible only when
`localStorage.getItem('lf_admin') === '1'`). Clears only today's shards and removes today
from `triage_days`, leaving all other days intact. Use before a VP demo to remove test-run
entries without disturbing historical data. Two-click confirm pattern matches the full Wipe
button; rate-limit and partial-failure handling follow the same conventions.

## 1.7.3 (2026-08-28) — Apply Sonnet 5 standard pricing ($3/$15 per MTok)

Sonnet 5's introductory rate of $2 in / $10 out per MTok ends 2026-08-31. Collapsed the
dated-tier array in `MODEL_PRICING_PER_MTOK` to a flat `{ input: 3, output: 15 }` entry — the
permanent standard rate. Updated `Cost-Estimate.md` to reflect the new figure. No change to
triage behavior; cost estimates in the completion log and the report page now use the correct
going-forward price.

## 1.7.2 (2026-08-27) — A searching note with no sources is worse than no search

Sandbox **INC-4053** searched the web, and the note said so in substance:

> *"Microsoft's August 11, 2026 KB5121003 release notes list no VPN/network-driver known issue, while Release Health shows only an unrelated RGB/game issue under investigation."*

The report row agreed — `1 search`, **12,598 input tokens** (against 6,590 with no tool attached). But the note contained **no links at all**: no Web sources footer, no `<a href>`, nothing.

**`url_citation` annotations are the model's choice and are not guaranteed.** It searched, used what it found, and attributed none of it. The note then asserts a specific KB number as current fact with nothing to check it against — which is precisely the failure the footer exists to prevent, and it is more dangerous than not searching at all, because the specificity reads as authority.

### Ask for the sources the search actually used

The Responses API returns them on request:

```js
include: ["web_search_call.action.sources"]   // sent only when the tool is attached
```

Verified live: one search returned **15 sources**. These are now a fallback, kept strictly separate from citations because they are a **different and weaker claim**:

| Footer | Means |
|---|---|
| **Web sources** | the model cited these — it relied on them |
| **Sources consulted** | the search looked at these; the model attributed nothing |

The fallback says so explicitly — *"searched, but nothing was explicitly cited — verify before relying on any specific claim above"*. Presenting consulted URLs under the "Web sources" heading would claim a citation that was never made; showing nothing leaves an unverifiable assertion standing. Neither is honest.

**Quality handling, driven by what the live response actually contained:**

- **Capped at 5** (`MAX_CONSULTED_SOURCES`) with a `(+N more consulted)` tail. Fifteen raw links would bury the triage, and weaker evidence earns less of the note.
- **Query strings stripped before de-duplication** — the same Microsoft page came back both plain and with `?utm_source=openai`.
- Sources carry no title, so the URL doubles as the label.

Anthropic is unaffected: it exposes no consulted-sources list separate from citations, and returns `searchedSources: []`.

**Tests: 127 passing** (+4): the fallback fires and is labelled honestly, a real citation still takes precedence, the cap/dedup/remainder-count behave, and `include` is sent only when search is on.

**Caveat worth keeping:** this narrows the gap, it does not close it. A note can still make a claim the consulted sources do not support — the footer shows what was *looked at*, not what was *verified*. The agent still has to check before acting on a specific current claim, which is what the wording now says.

## 1.7.1 (2026-08-27) — Sonnet 5's price change is now dated, not diarised

Sonnet 5's introductory **$2/$10 runs through 2026-08-31** and becomes **$3/$15 on 2026-09-01**. Both this file and `Maintenance-Schedule.md` carried an instruction to hand-edit `MODEL_PRICING_PER_MTOK` on the day.

**Setting it to $3/$15 now would be wrong** — it would overstate every Anthropic ticket for four days. Leaving it means the report silently understates spend by a third the moment the rate changes and nobody remembers. A wrong price is indistinguishable from a right one in the output, so the error would persist until someone reconciled against an invoice.

So the date is encoded instead:

```js
"claude-sonnet-5": [
  { until: "2026-08-31", input: 2, output: 10 },   // introductory
  { input: 3, output: 15 },                        // from 2026-09-01
],
```

`pricingFor(model, atMs)` resolves the tier by the triage date (UTC), first match winning, the undated tail applying from then on. Models with stable pricing keep their flat object and are untouched by the date. **No action is required on 2026-09-01, and hand-editing the table to 3/15 would now double-apply the change.** `Maintenance-Schedule.md` and `Cost-Estimate.md` have been updated to say so, since both previously instructed the opposite.

This is the same failure mode as the version-drift work earlier today, in a different costume: a correctness-critical value that depended on someone remembering a date.

**Tests: 123 passing** (+3), pinning the boundary — 2026-08-31 still bills at $2/$10, 2026-09-01 at $3/$15, and a flat-priced model is unaffected by the clock.

**Historical entries are unaffected.** `cost_usd` is computed and stored at triage time, so the 1,657 existing entries keep the rate they were actually billed at. Only new triage is affected.

## 1.7.0 (2026-08-27) — Filter the report by model or provider

The Model column added in 1.6.0 made it possible to *see* which AI produced a note. This makes it possible to **measure** them against each other.

A new dropdown beside the INC# search narrows the report to one provider or one specific model. Crucially it feeds `updateStats(filtered)` like every other filter, so **the whole stats strip recalculates** — Total Cost, Avg per Ticket, Cost / 1,000 Tickets and the truncation count all reflect the narrowed set. Selecting `anthropic`, noting the average, then selecting `openai` is now the entire cost comparison, on real production traffic, with no spreadsheet.

Options are grouped: a **By provider** roll-up (only shown when the loaded range actually holds more than one vendor) and a **By model** list, each with a live count.

**Design decisions worth recording:**

- **Options are rebuilt from whatever is loaded**, never hardcoded, so the list can never offer a model the current range holds nothing for. A selection that no longer applies resets to "All" rather than persisting — a filter pointing at an absent model renders an empty table, which is indistinguishable from data loss, and this report has already made that mistake twice today.
- **Deflected entries are excluded from any narrowing.** They made no AI call, so they belong to no provider; letting $0 rows fall into a vendor's bucket would understate that vendor's average cost — the one number the feature exists to produce.
- **Pre-1.6.0 entries bucket as `unknown`** rather than disappearing, so a range spanning the upgrade still adds up. Your 1,657 historical entries are all `unknown`.
- The control is styled from a **class, not `[value=""]`**: assigning `select.value` in JS sets the property and leaves the value *attribute* untouched, so an attribute selector would never have matched. An active filter is drawn in the accent colour, because a narrowed total is easy to mistake for the whole picture.

**Testing it costs nothing:** the seeder writes ~40% of its synthetic entries as `openai`/`gpt-5.6-terra` and the rest as `anthropic`/`claude-sonnet-5` (since 1.6.0), so admin mode → Seed gives a populated dropdown and both providers to compare without a single API call.

**Tests: 120 passing** (+5), covering the predicate being wired into `applyFilters`, stats recomputing from the filtered set, deflected exclusion, stale-selection reset, and the `unknown` bucketing.

## 1.6.4 (2026-08-27) — The "partial results" warning was crying wolf on every load

1.6.3 restored the data: the report showed the full **1,658 entries, $24.4662, $0.01703/ticket** — matching the bulk run exactly. It also showed the 1.6.2 warning banner at the same time, claiming entries were missing while displaying the complete set.

**The banner was wrong, and it would have been wrong on essentially every load from then on.**

The shard walker probes one shard *past* the last populated one to learn a day has ended — that is how it detects the end, and the probe therefore **always fails**. Inspect shows it plainly:

```
FAILED READS: 4
  triage_d_2026-08-24_10    <- the end-of-day probe for a 10-shard day
```

The catch treated any failure at `s > 0` as evidence of a throttle:

```js
if (s > 0 || knownPopulated) incomplete = true;
```

so every healthy multi-shard day marked itself incomplete. The flag had always behaved this way; it was harmless only because nothing read it. 1.6.2 put it on screen, and turned a silent inaccuracy into a permanent false alarm.

**A warning that always fires is worse than no warning** — it trains the reader to ignore the one occasion it is real, which is precisely the failure mode this whole line of work exists to prevent.

### Flag only what can be evidenced

`dbGetRetry`'s own comment states the constraint: *"A throttled read and an absent key are indistinguishable — both surface as a rejected promise (404)."* So the error cannot be interrogated. `incomplete` is now set only on evidence:

- **A read that announced itself as rate limited** — a resolved 429 payload, which `dbGetRetry` rethrows carrying the platform's wording. `looksThrottledError()` detects it, and because throttling is bursty, one confirmed 429 sets a scan-scoped `sawThrottle` that makes every later ambiguous 404 in the same scan suspect.
- **A failed shard 0 on a date `triage_days` promised us** — that date provably has a shard 0, so its absence is a lie rather than an ending.

A bare 404 deeper into a day is now taken at face value: the day ended.

**The trade-off, stated plainly:** a genuine throttle that surfaces as a bare 404 mid-day, with no 429 anywhere else in the scan, will no longer be flagged. That is a real gap. It is the better trade, because the alternative flags *everything* and the signal becomes noise. The `dayIndexReadOk` guard from 1.6.2 still covers the dangerous case — an empty result whose day index could not be read is never presented as "no data".

**Tests: 115 passing** (+1). The guard asserts the bare `s > 0` rule cannot return and that both evidence paths remain wired.

## 1.6.3 (2026-08-27) — Root cause: FDK hands arrays back as objects, and only the client knew

1.6.2 made the symptom visible. `⌕ Inspect storage` then made the cause unmissable:

```
triage_days: 1 dates -> 2026-08-27
POPULATED SHARDS: 11 slots, 1658 entries total
  2026-08-24  shard 0:180 … shard 9:30   (1657 entries)
  2026-08-27  shard 0:1                  (1 entry)
FAILED READS: 4   (all expected end-of-day probes)
```

Every entry present and readable. The **day index had collapsed to a single date.**

### The asymmetry

`app/index.html:585` has carried this comment since the 1.2.x reader rewrite:

> `// FDK converts top-level arrays to {0:v,1:v,...} objects on client.db retrieval.`

The client handles it (`toArr()`). **`server.js` never did.** So `recordLogDate` ran this on every cold container:

```js
Array.isArray({0:"2026-08-24", 1:"2026-08-23"})   // false
  -> days = []
  -> days.unshift(today)
  -> $db.set("triage_days", ["2026-08-27"])       // index destroyed
```

**Deterministic, not a race.** It has truncated the index on every cold start since the index was introduced, and the only reason it was never noticed is that the surviving date was usually the date being looked at. After the 2026-08-24 bulk run the index read `["2026-08-24"]` — and every report of that data worked, by luck. Today's emailed ticket rewrote it to `["2026-08-27"]`, and the 08-24 data became unreachable through any range containing today.

### Why it looked so erratic

`loadData` filtered the scan to the intersection of the requested range and the index, falling back to the full range **only when that intersection was empty**:

| Range | Intersection with `["2026-08-27"]` | Outcome |
|---|---|---|
| 08-21 → **08-27** | `["2026-08-27"]` — non-empty | scans one day → **1 ticket** |
| 08-21 → 08-26 | `[]` — empty | fallback fires → **1,657 appear** |

Hence data that seemed to vanish and return depending on the end date — and a fallback that existed for exactly this failure but could never fire during it.

### Fixes

- **`readDateList()` in `server.js`** understands FDK's `{0:v,1:v,…}` array shape, mirroring the client's `toArr()`. It returns **`null` for "cannot interpret"**, which callers must never treat as "empty" — including the case where a value holds entries but none are dates (an error payload spread into pseudo-entries; the client once scanned a range starting at `"APP"` for this reason).
- **`recordLogDate` extends, never replaces.** On `null` it logs and leaves the index untouched. It can no longer shrink the index under any input.
- **The reader no longer uses the index to narrow a scan at all.** It survives only as a hint to the shard-0 throttle heuristic — its one sound use, since a listed date provably has a shard 0. The cost is one extra read per empty day, which is a poor thing to defend: in production tickets arrive daily, so the index names nearly every date in the range and the filter saved almost nothing while risking silent data hiding always.

**Tests: 114 passing** (+6). The one that matters most feeds `recordLogDate` FDK's real `{0:v,1:v}` shape and asserts every pre-existing date survives. Others cover a scalar, a date-less object, and a regression guard that the reader never reintroduces the intersection filter.

### Note on the existing index

The reader fix makes the truncated index harmless — data loads regardless. `triage_days` still names only `2026-08-27` and will now be **extended** rather than replaced as new days arrive; 2026-08-24 will not re-add itself. That only affects the throttle heuristic, not visibility, and can be repaired from the report console if wanted:

```js
client.db.get('triage_days').then(function (v) {
  var cur = (v && typeof v === 'object') ? Object.keys(v).map(function (k) { return v[k]; }) : [];
  var merged = cur.concat(['2026-08-24']).filter(function (d, i, a) {
    return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && a.indexOf(d) === i;
  }).sort().reverse();
  return client.db.set('triage_days', merged).then(function () { console.log('repaired ->', merged); });
});
```

## 1.6.2 (2026-08-27) — The report claimed the data was gone. It wasn't.

**Incident, same day.** A ticket arrived by email, was triaged correctly, and posted its note — and the report then showed **empty on every date range**, including a custom range covering the 1,658-ticket bulk run. It read exactly like the storage had been wiped.

**Nothing had been lost.** All 1,657 entries were intact the whole time and came back on their own. The store was being **throttled**, and this page could not tell the difference between "there is no data" and "I could not read it."

### Why it presented as data loss

The failure chain, each link individually reasonable:

1. Data Storage allows ~50 reads/minute, and a throttled read **resolves** looking exactly like an empty shard rather than failing.
2. `fetchBuckets` guards against this: a failed shard-0 read is only treated as a throttle when the date appears in `triage_days` — `if (s > 0 || knownPopulated) incomplete = true`.
3. **But when the bridge is throttled, the `triage_days` read is throttled too.** `knownPopulatedDates` comes back empty, so `knownPopulated` is false for every date.
4. Every day's shard-0 failure is therefore read as "this day is empty." `incomplete` stays `false`.
5. The range is stamped `complete: true` and cached.
6. The UI renders **"No triage entries found"** — a flat assertion of absence — over a fully intact dataset.

The guard lost its only source of truth at precisely the moment it was needed, then defaulted to the dangerous interpretation.

**And the page already knew.** `rangeStore[rangeKey].complete` has been recorded since the 1.2.x reader rewrite and **was never read back anywhere**. The information required to say "I'm not sure" was collected and discarded on every load.

### Fixes

- **`dayIndexReadOk`** records whether `triage_days` could be read *at all*, separately from what it contained. A resolved read — even one naming zero dates — proves the store is answering. Assumed false until proven.
- **The empty state now distinguishes the two claims.** When the scan was incomplete *or* the day index was unreadable, it says **"Couldn't finish reading storage — this is NOT 'no data'"**, explains the ~50/min budget, and says to wait a minute and reload. The bare "No triage entries found" is now only shown when the read demonstrably succeeded and genuinely found nothing.
- **Partial results carry a warning row.** More dangerous than an empty table: totals, averages and cost-per-1k are all computed from whatever loaded, so an unflagged partial scan silently *understates spend*. Previously indistinguishable from a complete result.
- Both messages say **do not Consolidate or Wipe** — see the near-miss below.

### The near-miss worth recording

The obvious "recovery" from an apparently-wiped report is **Consolidate**, which does `put('triage_days', [CONSOLIDATE_DATE])` and writes `{entries: []}` over other days' shards. Running it here would have converted a transient throttle into **genuine, permanent loss of the entire bulk run**. The data was one button-click from being destroyed by the attempt to save it.

**The investigation also made the symptom worse.** Every range switch triggers a fresh multi-shard scan, so checking Today, then 7 days, then 30 days, then a custom range spent more of the same 50/min budget that was already exhausted. The more it was examined, the emptier it looked. Diagnosis of this subsystem needs to be *slow*: one query, then wait.

### First tests for the report page

`app/index.html` is ~1,900 lines with a 1,400-line inline script, no build step, and — until now — **no test coverage at all**. A stray character takes the page down and the only way anyone finds out is by opening it in Freshservice. `tests/report-page.test.js` adds cheap structural guards: every inline script must parse, header cells / body cells / every `colspan` must agree, the destructive admin buttons must stay behind the admin-mode flag, and the empty-state distinction above must survive future edits.

These are not behavioural tests and are no substitute for looking at the page. They catch the failures that are invisible in a diff.

**Tests: 108 passing** (104 + 4 report-page).

### Also

Pre-1.6.0 entries render their Model column as a grey **`unknown`** badge — expected, not a fault. Provider and model were only recorded from 1.6.0 onward, so the 1,657 historical entries have no such field. It is shown explicitly rather than blank so the boundary between old and new data is legible.

## 1.6.1 (2026-08-27) — A quota 429 is not a rate limit; live OpenAI verification

**Found by the first real API call, which is the entire argument for making one.**

`invokeProviderWithRetry()` retried *any* HTTP 429 with 1s + 2s back-off. But 429 carries two opposite meanings and only the response body separates them:

- a transient **rate limit**, where backing off and retrying is exactly right;
- an exhausted **credit balance**, where retrying can never succeed.

Against an unfunded OpenAI organisation the second case cost **~3 seconds per ticket** — 15% of the 20s execution budget — spent on two doomed retries before failing anyway. Worst of all it strikes precisely when triage is already broken, and it scales with traffic: a credit balance running dry mid-morning would have made every subsequent ticket slower *and* still failed.

`isQuotaExhausted()` now matches either provider's wording (`insufficient_quota`, `credit_balance_exhausted`, `billing_hard_limit`, Anthropic's "credit balance is too low", "exceeded your current quota") and skips the retry. `providerErrorMessage()` names the condition so the log says what to *do* — "credit balance exhausted, add credits (not retried: this is not a transient rate limit)" — rather than a bare `HTTP 429` that reads like ordinary throttling.

Measured live before and after: **716ms to fail, down from ~3,700ms.**

**Tests: 100 passing** (4 new). The pair that matters is the fast-fail *and* its regression guard — a genuine rate-limit 429 with no quota wording must still retry three times, so the fix can't silently disable back-off. Anthropic's credit-exhaustion wording is covered too.

### Live verification of the v1.6.0 OpenAI path

Run against the real API through the actual `onTicketCreateHandler`, with every Freshservice call stubbed (no ticket created, sandbox untouched). Model `gpt-5.6-terra`:

| Scenario | Tokens (in/out) | Cost | Latency |
|---|---|---|---|
| No web search, KB match | 780 / 134 | $0.0031 | 3.4s |
| Web search on, model declined to search | 5,377 / 139 | $0.0124 | 6.3s |
| Web search on, one search executed | 11,447 / 279 | $0.0362 | 7.0s |

Everything the adapter claims now has evidence: the Responses body shape, `output_text` extraction, `url_citation` parsing (a real Fortinet documentation link rendered in the Web sources footer), the billable-search count, cost estimation, category grounding against the taxonomy, and the no-KB-match instruction path. Worst case **7.0s leaves 13s of headroom** under the 20s cap — materially better than the 16–18s Anthropic web-search tickets measured in 1.1.2.

**Two cost findings worth recording:**

1. **Enabling web search costs ~4× more even on tickets that never search** ($0.0124 vs $0.0031) — the tool definition alone adds ~4,600 input tokens. That is a tax on *availability*, not usage, and it applies to every ticket once the iparam is on.
2. The dollar figures above are **not production-representative**: the harness stubs a 3-category taxonomy, so input runs 780 tokens where production sees 4,000–6,000. Scale the costs before quoting them.

**Superseded by a real in-FDK measurement (INC-4031, 2026-08-27, sandbox, emailed ticket, no web search):** **6,590 in / 110 out, $0.0145, 10.1s**. This is the number to quote — it ran through the real request template, the real ~150-subcategory taxonomy and a live KB search, and it closes the "never exercised inside FDK" gap noted below.

- Input is **8.4× the harness figure**, confirming the caveat above; the harness understates cost.
- Latency is **10.1s against the harness's 3.4s** — the ~6.7s delta is FDK overhead plus real grounding. Still inside the 20s cap, but the harness's "13s of headroom" was optimistic. Applying the same overhead to a searching ticket projects **~13–14s**, which is the figure to watch before enabling web search on the OpenAI path.
- **Provider cost comparison on this identical ticket:** `gpt-5.6-terra` $0.0145 · Sonnet 5 at intro rates $0.0143 (parity) · Sonnet 5 from 2026-09-01 at $3/$15 **$0.0214**. From September, OpenAI is ~32% cheaper on real production triage traffic.

**Also confirmed, after two false starts worth recording so nobody repeats them:** the credential originally supplied was a ChatGPT *workspace admin* token from `chatgpt.com/admin/access-tokens` — `at-` prefix, rejected by every inference endpoint with `rejected_by_access_enforcement` / `no_matching_rule`, and by `GET /v1/models` with OpenAI's plain `invalid_api_key`. ChatGPT workspace administration and the `platform.openai.com` inference API are separate products with separate billing; admin credentials "cannot be used for non-administration endpoints" per OpenAI's own docs. AI-Triage requires an `sk-proj-…` platform key. `GET /v1/models` is the fastest way to tell a credential problem from a permission problem, and it is free.

~~**Still outstanding:** the app has not been exercised on the OpenAI path *inside FDK*.~~ **CLOSED same day** — INC-4031 arrived by email in the sandbox, was triaged by `gpt-5.6-terra` through the real FDK request template, and posted its note. The report row carries the `openai` provider badge, confirming the new per-entry provider/model logging works end to end.

### Version drift, fixed at the mechanism rather than the instance

The report page footer read **"AI-Triage report v1.5.0"** on the 1.6.0 and 1.6.1 builds. The `<span id="app-version">` hook was already there; nothing had ever populated it, so it was a hand-maintained string with no check behind it — it was always going to drift, and it did.

Correcting the string alone would have guaranteed a repeat, so the checklist is now machine-enforced:

- **`sync-version.js`** declares every place the version appears (`VERSION_SITES`) and rewrites them from `package.json`. `--check` audits without writing. The CHANGELOG is *verified, never rewritten* — an entry is prose that has to be written by hand, and silently inventing a heading would defeat its purpose.
- **`tests/version.test.js`** enumerates the same list, so drift fails the unit suite with a message naming the fix.
- **`fdk pack` refuses to produce a zip when a test fails** — verified empirically by breaking the footer and confirming no artifact was emitted. A mismatched build therefore cannot be packaged, never mind shipped.
- **CLAUDE.md** now documents four places rather than three, and points at the command instead of asking anyone to remember them.

Adding a new place the version appears means adding one entry to `VERSION_SITES`; the test picks it up automatically.

Kept at **1.6.1 rather than bumping to 1.6.2** — Caleb's call, the change being cosmetic plus tooling. Note the consequence: the already-uploaded 1.6.1 zip carries the wrong footer, so getting this live means re-uploading 1.6.1 over itself. The Developer Portal's own "Live Version N" counter increments independently of our semver (see the header of this file), so it tolerates that — but two distinct zips now share the name 1.6.1, and only the later one has the correct footer.

**Tests: 104 passing** (100 + 4 version-consistency).

## 1.5.0 (2026-08-23) — Atomic appends: one storage op per ticket, no read-modify-write

The 120-ticket gate run on 1.4.0 produced the first trustworthy measurement of the writer:

- 120 tickets created, **120 triage notes posted** (verified against the sandbox API)
- **118 entries in the report** — INC-2027 and INC-2028 missing

Both missing tickets were noted, both completed in 13–15s (well inside the 20s cap), and both sat far from any shard boundary. Two candidates remained: the read-modify-write race, which 1.3.0 never actually removed — it only stopped the *catastrophic* case where a failed read overwrote a populated shard — or rate-limit contention against the shared ~50/min budget.

Rather than pick between them, this replaces the mechanism that makes both possible.

**`writeTriageLog` now uses `$db.update(key, "append", {entries: [entry]})`.**

- **Atomic.** Two concurrent handlers cannot clobber each other, because there is no read-then-write window to lose an entry in. The race is gone by construction, not by guarding.
- **One storage op instead of three.** The cursor is cached per container, so a warm invocation costs a single write. Against a ~50/min budget shared with the report page, that is a threefold increase in headroom — and production sees bursts of 120 tickets/minute (measured: 2026-07-01 13:31).
- **No read on the write path at all**, which removes the entire class of "a throttled or malformed read looked like an empty shard" bugs from the writer.

**Shards are now size-bounded rather than count-bounded.** An atomic append cannot report the resulting length, so there is nothing to count. Instead the platform throws its 40KB size exception, and that throw *is* the signal to advance — `isSizeError()` catches it, moves the cursor, and re-appends to the next shard. Consequences:

- `SHARD_MAX` is no longer a contract shared between `server.js` and `app/index.html`. It survives only as a chunk size for the admin tools' direct writes. That coupling silently truncated days whenever the two files drifted.
- The reader walks until a shard is **absent**, not until one is **short**. A short shard is now completely normal.
- The first entry of a shard still creates the record with `setIf: "not_exist"`, since `append` requires the record to exist and a concurrent handler may be creating the same shard.
- A rate-limited append drops that one entry and logs it. Never corrupts, never overwrites.

**Tests: 80 passing.** The four storage tests were rewritten for the new path — atomic append with no shard read, size-exception rollover with cursor advance, CAS creation of a missing record, and rate limiting both as a rejection *and* as a resolved 429 payload. The suite now reloads `server.js` before each test: the shard cursor and day index are deliberately module-level so they persist across warm invocations, which meant one test's cursor was leaking into the next.

Still unresolved: whether the two lost entries were the race or the rate limit. Re-running the same 120-ticket gate is the test — 120/120 means solved; 118/120 again means it is the limit, and the next lever is retrying inside the handler's remaining time budget.

## 1.4.0 (2026-08-22) — Pace every storage request; the wipe was scanning blind

**The bug behind "data comes back after a wipe", proven with numbers.** A 1.3.3 inspection reported:

```
POPULATED SHARDS: 0 slots, 0 entries total
RATE LIMITED READS: 1151 — these resolved with a 429 payload
FAILED READS: 3   triage_d_2026-08-20_6 / _7 / _8
```

1,151 of 1,200 reads were rate limited. **Only ~49 got through — the ~50/min ceiling, exactly.** Meanwhile the report's own tabs showed 134 entries for 7 days and 907 for 30, because the reader issues only a handful of reads and stays under the limit.

So the reader was right all along and the tools were blind:

- Inspect and Wipe each fired ~1,200 reads. ~49 succeeded; the rest returned 429 payloads which, per 1.3.3, *resolve* rather than reject — and were counted as empty slots.
- The wipe therefore found "0 populated", cleared nothing, and **truthfully reported success**: it did clear everything it could see.
- The data was never touched. That is why it came back.

Minor, not patch: request pacing changes how every storage-touching feature behaves and how long the admin tools take.

- **All storage access goes through a paced queue** capped at 40 req/min (headroom under the ~50 ceiling), shared by the reader, the admin tools, and the retry logic. Exceeding the budget does not merely slow things down — it silently corrupts results, so the queue is deliberately conservative.
- **Inspect and Wipe no longer probe a fixed grid.** They scan the dates `triage_days` names plus a recent-days safety net, walking each day's shards until one ends the day: roughly 40–70 reads instead of 1,200. Both print the scope and an ETA before starting.
- **A wipe that hits the rate limit now refuses to claim success.** It reports the count, says plainly that anything it missed is still there, and asks to be re-run.
- **Seed writes are paced and 429-aware**, and it no longer blanket-clears 20 slots per day (570 wasted writes) — it clears two above the last shard written and expects a wiped store.
- **Consolidate stays exhaustive** — not stopping at a short shard is the entire point of a recovery tool — but it is paced and now states its cost up front (~900 reads, ETA in minutes) instead of appearing to hang.

Note for the bulk run: the ~50/min budget is shared with the serverless writer, which issues ~3 storage ops per ticket. At the default 8s stagger that is ~22/min and safe; at a 4s stagger it reaches ~45/min and will start losing entries to the limit. **Do not lower `-SleepSeconds` below 8.**

## 1.3.3 (2026-08-22) — Rate-limited reads RESOLVE with an error payload, not a rejection

**The most consequential finding in this whole investigation, surfaced by the 1.3.1 wipe report.** A live wipe printed:

```
triage_days at start: 429, [object Object], You have exceeded the limit of 50 requests per minute, APP
Scope: 64 dates, 1280 slots (APP .. 2026-08-22)
```

Two facts, both of which invalidate assumptions this codebase was built on:

1. **Data Storage is rate limited** — the platform reports ~50 requests per minute.
2. **A rate-limited read does not reject. It RESOLVES with an error payload** of roughly `{ status: 429, message: "You have exceeded the limit of 50 requests per minute", ... }`.

Every read path here shape-checked its result (`Array.isArray(v.entries)`) and treated anything unexpected as *empty*. So a rate-limited read of a populated shard was indistinguishable from an empty shard. Note the corrupted scope line above: `toArr()` spread the error object's values into the date list, so the wipe scanned a range beginning at `"APP"`.

**This is almost certainly the original data-loss mechanism from the 1,830-ticket bulk run, and it survived every previous fix** — because every previous fix, including 1.3.0's "never write a bucket you failed to read", only guarded against *rejections*. The server does ~4 reads/ticket; at 7.5 tickets/min that is ~30/min against a 50/min ceiling, so it fires precisely under bulk load, and then `writeTriageLog` wrote a single-entry array over a populated shard.

- **`isErrorPayload()` on both sides.** Server and client now detect a resolved 429 and treat it as a failure, with a longer backoff than a normal miss (hammering a 429 spends more of the quota that caused it).
- **A resolved value must match the expected shape to be trusted.** In `appendToShard`, only an explicit null/undefined means "absent"; any other unrecognised value aborts the write instead of collapsing to `{entries: []}`. Same rule in the reader's shard walk.
- **`toDateList()`** validates `triage_days` entries against `YYYY-MM-DD`, so a malformed response can never again be interpreted as dates.
- **Wipe and Inspect count and report rate-limited reads separately** from absent keys, and say plainly that a scan containing them is untrustworthy.

**Wipe no longer uses `client.db.delete`.** Evidence: after two wipes that reported success, `triage_days` still listed 30 dates — the delete resolved without removing the key. Clearing now writes an empty value, which is functionally identical for every reader here (the shard walk stops at a short shard; an empty index is treated as "no hint") and is demonstrably effective.

**The report footer now shows its own version.** Several rounds of this investigation were confused by uncertainty over which build was actually rendering; the page now states it.

## 1.3.2 (2026-08-22) — Remove the localStorage cache: it was showing deleted records

**Root cause of "data comes back after a wipe", found by the 1.3.1 storage inspector rather than by reasoning.** The inspector's report was unambiguous:

```
POPULATED SHARDS: 0 slots, 0 entries total
LOCAL CACHE:
  2026-08-22..2026-08-22 -> 0 entries
  2026-07-24..2026-08-22 -> 907 entries
FAILED READS: 0
```

Data Storage was genuinely empty — the wipe had worked. But the 30-day range's localStorage cache still held 907 entries, and `loadData` painted that cache before fetching. The report was rendering 907 rows that existed nowhere. Today showed 0 only because its cache happened to be empty.

The cache was introduced in 1.2.15 to stop a PJAX-recreated iframe rendering blank while a throttled fetch returned nothing. It cached the fetch *result* and then outlived the data. `FAILED READS: 0` across 1,200 slots shows the problem it was compensating for is now fixed properly, by batched sequential reads with retries.

- **The reader no longer persists or restores results.** `saveCache`/`loadCache` are gone; a range renders from its in-memory slot for the session and is otherwise fetched. A blank moment during a fetch is strictly better than confidently displaying deleted records.
- **Existing stale caches are purged on every load**, not once — a viewer who leaves the page open would otherwise keep seeing pre-wipe data. Anyone who used 1.2.15–1.3.0 has one of these sitting in their browser right now.
- The wipe still removes leftover keys and reports the count, but it is now cleanup rather than a correctness requirement.

Also corrects a detail misstated in earlier entries: the cache write was guarded on `!incomplete`, **not** on `entries.length`, so empty results were cached too — which is why an empty `2026-08-22..2026-08-22` key existed at all.

## 1.3.1 (2026-08-22) — Make the admin tools leave evidence

Diagnostics only. No change to triage behaviour, the storage format, or the report's read path.

After a wipe on 1.3.0, Today read 0 while the 7-day and 30-day tabs still showed entries. Three separate attempts to explain that failed, and the reason they failed is the same each time: **the admin tools left no evidence of what they did.** Their entire report was a button label that reset after a second, so the only available facts were whatever could be read mid-run. That is a design defect, and it was fixed before attempting a fourth diagnosis.

- **Persistent results panel.** Admin actions now write a structured, dismissible report that stays on screen. Wipe records: the deleting mode in use, `triage_days` at start, the scan scope (dates and slot count), and per pass — every populated slot grouped by date with shard numbers and counts, how many cleared, and which ones failed. The final verdict shows the numbers behind it.
- **New read-only Storage Inspector** (`⌕ Inspect storage`). Scans 60 days × 20 shard slots plus the day index and cursors and reports exactly what is there. Issues no write, no delete, and touches no cache. It exists to answer "is the data still in storage?" by observation rather than inference, and it distinguishes the two candidate causes, which have opposite fixes: entries still present means the clear is silently failing; storage empty while tabs show rows means the local cache is stale.
- **Local cache clearing is no longer swallowed.** The wipe cleared `localStorage` inside a bare `try/catch`. If `localStorage` throws in the Freshservice iframe, the caches survive and the reader re-seeds ranges from them on the next load — which presents exactly as "the data came back". The result is now reported, including the failure.
- **Scan retry policy reconciled.** The wipe's scan called `dbGetRetry` while its comment claimed reads were not retried. Across ~1,180 slots an absent key is the normal case, so retrying every miss tripled the work and made the failure count non-zero on every single run — a warning that is always on. The scan no longer retries; throttled reads are caught by the existing repeat-until-clean loop, and the failure count is reported as context rather than used as a verdict.
- The wipe's scan window no longer depends on `triage_days` alone. It unions the index with a fixed 60-day window, because the wipe deletes the index at the end — a scope derived only from it would silently skip everything older on the next run.

## 1.3.0 (2026-08-22) — Stop the storage writer destroying data; harden the reader

Minor, not patch: `poc_group_id` / `poc_workspace_id` change meaning (0 now disables a gate) and `SHARD_MAX` changes on both sides of the storage contract, so an install should be reviewed rather than silently upgraded.

Versions 1.2.9–1.2.15 chased the report's disappearing entries entirely in the **reader**. Two independent audits of both sides found the reader was largely a distraction — the **writer** was actively destroying data, and nothing logged why.

### The actual cause

`writeTriageLog` did `try { bucket = await $db.get(key); } catch { bucket = null; }` and then treated a failed read as an empty shard. A throttled `$db.get` rejects exactly like a missing key — the reader already knew this and wrapped every read in `dbGetRetry`, but the server had **no retry on any read**. So one throttled read caused the next write to replace a shard holding up to 149 real entries with a single-entry array. Not one entry lost — up to 149 destroyed, silently, repeatedly.

And it was invisible: every error log used `JSON.stringify(err)`, which returns `{}` for a real `Error` because `message` and `stack` are non-enumerable. An entire 1,830-ticket run produced no usable diagnostics.

### Writer (`server/server.js`)

- **Never write a bucket we failed to read.** All server-side reads go through `dbGetRetry`; an unreadable shard aborts the entry rather than overwriting it. Losing one entry beats destroying a hundred.
- **New shards are created compare-and-swap** (`$db.set(key, val, {setIf: 'not_exist'})`). A handler that stalled across a shard boundary can no longer overwrite a shard that filled while it was working, and the shard cursor only ever moves forward. An unreadable shard is probed with CAS first: if the create succeeds the shard really was absent; if it fails the read was a throttle and the write is abandoned.
- **`SHARD_MAX` 150 → 100.** Measured with FDK's own `objsize` against its 40 KB cap: 150 deflected entries = 41,447 B, over the limit. Because the shard only advanced at `length >= SHARD_MAX`, a size rejection meant the day never advanced and **every later entry that day was lost**. A rejected write now advances the shard instead of retrying the same oversized payload forever. Must stay in sync with `SHARD_MAX` in `app/index.html`.
- **`errText()`** replaces `JSON.stringify(err)` at all four sites.
- **Day index cached per container** so `triage_days` is not read on every single ticket — latency that came straight off the 20s execution cap. A failed read of it no longer truncates the index to a single day.
- **Unknown model pricing now logs loudly** instead of silently storing `cost_usd: null`, and `claude-haiku-4-5` (undated) was added — a pricing-key miss would have made a paid cost-measurement run report no cost at all.
- **PoC gates accept 0 as "disabled".** The install page's number field will not take a blank value, and FDK can deliver number iparams as strings where `"0"` is truthy — entering 0 would have gated out every ticket and left the report empty, looking exactly like a storage failure. `gateValue()` normalises `""`, `0` and `"0"` to "off". `iparams.json` documents it and defaults both to 0.

### Reader (`app/index.html`)

- **A throttled shard-0 read is no longer cached as "this range is empty."** It was stamped `complete: true` and written to localStorage, poisoning every later cold load; the `worseThanHeld` guard could not catch it because it was gated on `incomplete`, which the shard-0 path never set. Dates listed in `triage_days` are known to have a shard 0, so a failure there is now provably a throttle.
- **Days are fetched in batches of 4**, not all at once. Reading 30 days concurrently put 30 chains on the bridge and defeated the entire point of stepping shards sequentially — it was the main trigger for the throttling above.
- **Redistribute deleted.** It was the only utility that destroyed data and the only one never hardened: ~630 eager unbatched unretried writes, an unretried `triage_cur_` read that made it collect only shard 0 and then blank the shards it never read, and a `✓ Done` that fired even when it did nothing. It is what stranded the orphaned shards Consolidate had to recover. Seed and Wipe cover the testing need.
- **Wipe no longer claims success on a throttled scan** — it scans with `dbGetRetry`, limits itself to dates that actually hold data (rather than 1,260 mostly-absent slots), and reports unreadable slots instead of counting them as clean.
- **Seed clears slots above what it writes**, so seeding over existing data no longer strands shards behind a short final shard — the same bug Redistribute had.
- **Consolidate targets today** rather than a hardcoded `2026-08-21` that would eventually gather everything onto a day the report cannot reach.
- **Cost average divides by entries that actually carried a cost.** Null-cost entries inflated the denominator while contributing nothing, understating both headline numbers; any are now called out in the stat caption.
- **All times render in UTC** (`Date / Time (UTC)`), matching how entries are bucketed. Local rendering made a 21:13 EDT ticket display as 08/21 while living in the 08-22 bucket, which is why evening runs looked wrong across every range tab.
- Custom tab now actually loads (setting `.value` from JS fires no `change`); inverted ranges are swapped and explained rather than showing a silent empty result; search is debounced; the error banner clears; the date inputs are locked with the range tabs.

### Tests

77 passing. Added coverage for the two mechanisms that caused the data loss: a full shard must advance with `setIf: 'not_exist'`, and a failed bucket read must abort rather than write. Retry backoff is overridable via `LF_DB_RETRY_MS` (set to 0 in `vitest.config.js`) — without it the mocked rejections made the suite sleep for 99 seconds.

### Known follow-up

`$db.update(key, 'append', ...)` is atomic and would remove the read-modify-write round trip entirely. Not adopted here because `append` returns no length, so advancing the shard would still need a read or a separate atomic counter — a larger redesign than this pre-run window should absorb.

## 1.2.15 (2026-08-22) — Fix report zeroes at the source: serialise, retry, and cache reads

The in-memory resilience guards from 1.2.12–1.2.14 could not fix this, because the failure isn't a guard being bypassed — it's a **fresh JS context**. Freshservice PJAX navigation tears down and recreates the app iframe, so `allEntries` is back to `[]` with no prior data to protect. A throttled first fetch in that new context renders 0 legitimately, by its own logic.

Verified by reading the render path: `applyFilters` does no date filtering, and the only assignment to `allEntries` is already guarded — so a populated view could not be emptied in place. The zero had to be a cold start.

Rapid tab swapping turned out to be a cause, not just the way the bug was observed. Reads already issued to the FDK bridge cannot be cancelled, so starting a second range while the first is in flight puts both sets on the bridge at once. Click through three tabs quickly and the newest generation — the one whose result actually gets applied — is competing with the previous generations' stragglers, making it the *most* likely to be throttled into an empty result.

Five changes:

1. **Each range owns its own result — no shared state.** Every earlier attempt kept one `allEntries` that all four ranges wrote into, which made cross-range interference possible in several ways at once: a guard comparing Today's 890 against the 30-day view's 1794 classified the narrower result as degraded and refused it, pinning every tab to the widest range's number. Ranges now have separate slots (`rangeStore[rangeKey]`), `allEntries` is only a mirror of the active slot for the render path, and the localStorage cache is keyed per range. A result can only ever be compared against, or replace, a previous result *for the same range* — cross-range interaction is impossible by construction rather than by guard. Two supporting fixes: every `loadData()` path now ends at a single `done()`, since the old generation-check early returns skipped `setLoading(false)` and left `isLoading` stuck true, making all subsequent tab clicks no-ops until the 30s watchdog fired; and the generation counter is gone, made redundant by single-flight loading plus per-range slots. The redistribute utility clears all cached ranges since it rewrites the buckets.

2. **Stop consulting `triage_cur_{date}`.** The shard count came from a single unretried read, so a throttled or stale response silently truncated the day to a prefix of its shards (6 of 12 ≈ 890 of 1794 entries, matching the observed shortfall). The shard set is self-describing instead: the server fills a shard to exactly 150 before advancing, so the walk continues while a shard comes back full and stops when one comes back short. A shard that fails every retry *after* a full predecessor marks the result `incomplete`, and an incomplete result is never cached and never replaces a larger set held for the same range. A day whose entry count is an exact multiple of 150 probes one shard past the end and flags itself incomplete — harmless, it only skips that load's cache write.

3. **Lock the range tabs during a fetch.** Tabs are `disabled` while a load is in flight (`.is-busy`: dimmed, `cursor: progress`), so only one range loads at a time and read sets can't stack. `loadData()` also returns early if a load is already running, since the custom-range date inputs reach it by another path. A 30s watchdog force-clears the loading state so a fetch that neither resolves nor rejects can't leave the controls locked.

4. **Retry on throttle.** `dbGetRetry` retries a rejected `client.db.get` with a 120ms gap — 3 attempts for `triage_days`, 4 for shard reads. Applied only where the key is known to exist, so a genuine miss still costs one read while a throttle gets another chance.

5. **Sequential shard reads.** Shards within a day are read one at a time rather than concurrently; days still run in parallel since they're independent.

Also adds a **Consolidate to one day** admin button (shown alongside Redistribute under `lf_admin`), which collapses every stored entry back onto a single date — the inverse of Redistribute.

**Orphaned-shard bug in Redistribute, and the recovery for it.** Redistribute rewrote each day starting at shard 0 but only ever cleared shard 0 of days that ended up empty. A day that previously held 12 full shards and received ~33 entries got a *short* shard 0 written over it, leaving shards 1..11 populated but unreachable — the report's "walk until a shard comes back short" stops at shard 0. The entries were never deleted, just hidden, which is why the visible total fell well short of the smoke test's real count.

- Redistribute now clears every slot above the last one it writes (and every slot of a day that ends up empty), so it cannot strand entries this way again.
- Consolidate deliberately does **not** use the short-shard walk, since that is exactly what hides the orphans. It scans all 20 shard slots for each of the last 45 days regardless of what it finds, in batches of 4 days to keep bridge pressure low, then de-duplicates by `ticket_id` because orphaned shards can hold copies of the same entry. Its writes are deferred thunks flushed 8 at a time — an array of `client.db.set(...)` results would have fired every call immediately, defeating the batching.

Caveat: Redistribute overwrites each entry's `ts` in place, so original per-ticket times are not recoverable — Consolidate restamps entries one minute apart from 08:00 on the target day, preserving order but not the original clock times.

Adds a third admin button, **Wipe all log data**, which clears every shard slot across the last 60 days plus `triage_days` and the localStorage caches, leaving storage as a fresh install would find it. It requires two clicks to commit (the first arms it for 5 seconds) and does not touch tickets in Freshservice — only this report's stored data.

The wipe took three attempts to get right, and the first two failed for compounding reasons:

- It swallowed every write rejection (`client.db.set(...).catch(function () {})`) and reported success unconditionally. Writes are rate-limited by the same bridge that throttles reads, so most silently failed while the button still showed `✓ Wiped` — which is why wiped data kept reappearing.
- Adding retries and a read-back verification exposed the real scale of it: 1,200 of 1,260 writes were still failing. The volume was the problem. Blanket-writing an empty bucket to all 60 days × 20 shard slots meant ~1,200 writes aimed at keys that held nothing at all, and that flood is what the bridge rejected.

Adds a fourth admin button, **Seed 2,000 test entries**, which writes synthetic log entries directly to Data Storage — no tickets created, no AI calls, no cost. The report only ever reads storage, so it does not care whether entries came from real triage; validating the report at full scale never needed a paid ticket run. The seed shapes data like a real run (30 days, ~600 entries concentrated on one day so the multi-shard path is genuinely exercised, plus a realistic mix of deflected, truncated and web-searching entries) and uses a fixed pseudo-random seed so repeat runs produce identical counts — which makes "did the number change?" a meaningful question. Real ticket runs remain necessary only for validating triage behaviour and per-ticket cost.

The working wipe scans first and clears only what is actually occupied — typically a dozen or two shards rather than 1,260 — using `client.db.delete` where available (falling back to writing an empty bucket), serialised one key at a time with 5 retries each. It then re-scans and repeats until a pass finds nothing, gives up after 5 passes or a pass that clears nothing, and reports the remaining entry and shard counts rather than claiming success.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.14 (2026-08-22) — Close the last unguarded wipe path (triage_days index)

v1.2.13's sequential reads fixed the shrinking count, but the view could still snap from a full dataset straight to 0. Cause: the resilience guard added in v1.2.12 only covered the shard-read completion path. The `triage_days` index read had two unguarded failure modes feeding `fetchBuckets(gen, [])`, which then set `allEntries = []` unconditionally:

- The index read succeeded but returned an empty or partial list (a throttled read can resolve empty rather than reject), so the date intersection came back empty.
- Any empty intersection was treated as proof the range holds no data.

Both now fall back to scanning the full requested range and letting the shard reads decide, and the `dates.length === 0` branch no longer clears a populated view. `triage_days` is treated strictly as a read-skipping optimisation, never as authority on what exists.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.13 (2026-08-22) — Sequential shard reads (real fix for the shrinking record count)

**Confirmed the data was never being cleared** — sandbox Data Storage persists across app updates. The report's disappearing records were entirely a read-path problem.

Root cause: even after v1.2.10 reduced the read count, a single day holding a bulk-test dataset spans 13 shards, all read concurrently. The FDK platform bridge throttles concurrent `client.db.get` calls and silently returns 404 for the ones it drops. Each load assembled a different partial subset, so repeated tab switches showed a record count that walked downward — 1,007 → 890 → … → 0 — with occasional recoveries when more reads happened to land.

Fix: shards within a date are now read strictly sequentially (`readDateSequential`), each `client.db.get` awaiting the previous one. Dates still run in parallel since they're independent. Slightly slower for large ranges, but the result is correct and repeatable rather than randomly truncated.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.12 (2026-08-22) — Fix flash-to-0: init debounce + resilience guard

Two targeted fixes for the report flashing to 0 on tab switches:

1. **Init debounce** — Freshservice PJAX navigation triggers `app.initialized()` twice in rapid succession on some page transitions. The second init call incremented `loadGen` and fired a fresh fetch whose reads would fail (FDK session mid-reset), overwriting the good results from the first call with 0. Fixed with a 150ms debounce on `loadData()` at init time — rapid re-inits coalesce into a single fetch.

2. **Resilience guard** — If a completed fetch returns 0 entries but `allEntries` already has data, the result is discarded rather than applied. This handles FDK platform read failures (throttle, session reset, PJAX mid-transition) that return empty even when data exists in storage. Legitimate empty ranges (switching to a range with no tickets) still work because the guard only triggers when entries=0 AND allEntries is non-empty.

Also strips the temporary `[lft]` diagnostic `console.log` lines added in v1.2.11.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.11 (2026-08-22) — Add diagnostic console logging to trace flash-to-0 root cause

Adds `[lft]` prefixed `console.log` lines to `loadData()` and `fetchBuckets()` to capture: gen counter, range mode, raw `triage_days` response, `toFetch` size, and final entry count applied. Temporary — will be stripped in the next patch once the root cause is confirmed.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.10 (2026-08-22) — Fix report flash-to-0 and cut concurrent fetch reads

Two report-page fixes:

1. **Flash-to-0 eliminated** — `allEntries = []` was called at the top of every `loadData()` call before the async fetch completed. Any range tab switch wiped the visible data instantly. Fixed by removing the early clear — `allEntries` is now only replaced inside the gen-guarded completion paths in `fetchBuckets`, so existing data stays visible while the new fetch is in progress.

2. **Two-phase bucket fetch** — The previous approach fired up to 140 concurrent `client.db.get` calls (20 speculative shards × 7 days) regardless of how many shards a day actually used. The FDK client throttles concurrent reads and the excess silently returned `[]`, causing the report to show 0. Fixed with a two-phase approach: (1) read `triage_cur_{date}` per day to learn the actual shard count, then (2) read only those shards. A typical 7-day window now issues ~14 reads instead of 140.

3. **Sandbox utility: Redistribute dates** — Adds a hidden "⟳ Redistribute dates" button visible when `?admin=1` is appended to the page URL. Spreads all stored entries evenly across the last 30 days so the report can be tested with realistic multi-day data rather than everything crammed into one day from a bulk smoke test.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.9 (2026-08-22) — Fix report race condition (stale fetch overwrites fresh results)

Multiple overlapping `loadData()` calls (initial page load + range tab switches) each spawned a `Promise.all` chain. Whichever resolved last won, so a fast "Today" fetch (few shards) could overwrite a slower "7 days" fetch (many shards) with an empty result — causing the report to flash data and then drop to 0. Fixed with a generation counter (`loadGen`): each `loadData()` increments the counter, and `fetchBuckets` discards its result if a newer call has superseded it.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.8 (2026-08-21) — Raise report page shard fetch limit to 3,000/day

`MAX_SHARDS` in the report page increased from 6 → 20 (6 × 150 = 900 cap → 20 × 150 = 3,000 cap). The 900-entry limit was hit during the 1,820-ticket bulk smoke test, leaving the last ~920 entries invisible. The server-side shard writer has no cap so all data is in storage — this is a read-side fix only.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.7 (2026-08-21) — Deflection entries in cost report

Auto-deflected tickets (admin consent, quarantine, SQM, Box/OneDrive links, termination) now appear in the cost report with a blue **DEFLECTED** badge in the Tokens column, `$0` cost, and `—` for searches and cost/1k. A **Hide deflected** toggle in the controls bar filters them out when you only want to see AI triage costs.

Cost stats now exclude deflected rows from totals and averages automatically — the Total Cost and Avg per Ticket reflect AI-only spend regardless of the filter state; the stat subline shows how many deflected tickets were excluded.

**Server:** extracted the db write into a shared `writeTriageLog(ticket, entry)` helper called by both the normal AI path and the deflection path. Deflection entries carry `deflected: true` and `deflect_type` (the template id, e.g. `admin_consent`). Storage failure is caught inside the helper and never aborts the triage note.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.6 (2026-08-21) — Fix sticky header: inner-scroll-container approach

`position: sticky; top: 103px` on `th` elements does not work inside a Freshservice `full_page_app` iframe because the outer Freshservice page drives the scroll, not the iframe itself — sticky positioning never activated at the right time, causing tbody rows to appear above the column header row.

Fixed with the inner-scroll-container pattern: `.page` is now `height: 100vh; overflow: hidden` (a fixed-height flex column), `.main` and `.table-wrap` fill the remaining space via `flex: 1; min-height: 0; overflow-y: auto`. All scrolling happens inside `.table-wrap`, so `th { position: sticky; top: 0 }` sticks to the top of that container correctly, independent of the iframe context. Removed now-unnecessary `position: sticky` from `.topbar` and `.controls` (they're always visible; the page body never scrolls). Also added back `border-bottom: 1px solid var(--border)` to `td` (lost in v1.2.5 when `tbody tr` border was removed).

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.5 (2026-08-21) — Fix table rows bleeding above sticky column headers

`border-collapse: collapse` on the table combined with `position: sticky` on `thead` causes a well-known browser z-index bug where tbody rows render on top of the sticky header row. Fixed by moving `position: sticky; top: 103px; z-index: 5; background: var(--surface-alt)` from `thead` to individual `th` elements — per-cell stickiness is not affected by border-collapse and correctly maintains the stacking order.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.4 (2026-08-21) — Fix sticky header gap + remove diagnostic panel

- **Sticky header gap**: `.controls` bar was not sticky, so it scrolled away leaving a 51px gap between the topbar and the sticky `thead`. Tbody rows filled that gap, appearing visually above the column headers. Fixed by adding `position: sticky; top: 52px; z-index: 9` to `.controls` so it sticks directly below the topbar.
- Removed the v1.2.3-diag diagnostic panel from the page.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.3 (2026-08-21) — Fix report page: FDK array serialisation + bucket read regression

Two bugs confirmed via storage diagnostic (v1.2.2-diag):

1. **FDK top-level array → object conversion**: `client.db.get('triage_days')` returns `{"0":"2026-08-21"}` (object with numeric string keys) instead of `["2026-08-21"]` when the value was stored server-side via `$db.set`. `Array.isArray()` returned false, `activeDates` was empty, and the date intersection produced an empty `toFetch` list. Fixed with a `toArr()` helper that normalises both forms to a plain array.

2. **Bucket read regression from v1.2.2**: the unwrap "fix" broke bucket reads — `client.db.get` returns values directly (not wrapped), so `resp[key]` was `undefined`. Reverted to `resp.entries` directly.

The diagnostic also confirmed data IS in storage: `triage_d_2026-08-21_0` contains real entries.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.2 (2026-08-21) — Fix report page reading FDK storage

`client.db.get(key)` in the Freshworks app client SDK resolves as `{ [key]: value }`, not the value directly. The report page was treating the response as the value itself, so `Array.isArray(days)` always failed (returning an object, not an array) and all bucket reads resolved to empty. Result: the table always showed zero rows even with data present.

Fixed by unwrapping both the `triage_days` index response and each shard bucket response before use.

Also fixed a minor XSS: `incNum` (ticket display_id from storage) was interpolated into innerHTML without sanitization — coerced to integer string instead.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.1 (2026-08-21) — Sharded daily storage (no entry cap)

Fixed the report page losing log entries on high-volume days. The previous design silently dropped tickets after 200 entries/day; days with 300+ automated tickets would have gaps in the report.

**What changed:**
- Daily log buckets are now sharded: `triage_d_{date}_0`, `_1`, `_2`… Each shard holds 150 entries (~40KB FDK limit). When a shard fills, the handler advances to the next shard and writes there — no entries are ever dropped.
- Current shard tracked in `triage_cur_{date}` key. On normal days (< 150 tickets) this key is never written; behavior is identical to before.
- Report page fetches up to 6 shards per date in parallel (covers up to 900 entries/day).
- `triage_days` index format unchanged — backward compatible with any data written by v1.2.0.

**Version bump touches:** `package.json`, `config/iparams.json`, this file.

## 1.2.0 (2026-08-21) — Cost & Activity Report page

New FDK `full_page_app` custom page that surfaces per-ticket triage history, cost data, and token-limit flags.

**What's new:**

- **Report page** (`app/index.html`): Freshservice admin custom page showing every ticket the app triaged — INC#, subject, date/time, token counts, web search count, per-ticket cost, cost/1k-ticket projection. Columns are sortable; rows are filterable by INC# and by "truncated only" (see below). Time range selector: Today / 7 days / 30 days / Custom — no 48-hour cap.
- **FDK Data Storage persistence**: after each successful triage note post, `server.js` now writes a log entry to `triage_d_{YYYY-MM-DD}` (daily bucket, max 200 entries per day ≈ 40KB FDK limit). A `triage_days` key tracks which dates have data so the report page can enumerate buckets efficiently. Storage failures are caught and logged — they never abort the triage note.
- **Token-limit flag**: `callClaude` now captures the final Anthropic `stop_reason`. When it's `"max_tokens"` (the output was cut off at the token cap), `tokenLimitHit: true` is set on the result and stored in the log entry. The report page surfaces this as a yellow ⚠ TRUNC badge in the Tokens column so truncated notes are immediately visible; a "Truncated only" filter toggle isolates them.
- **Console log enhancement**: the `[triage]` log line now appends `, OUTPUT TRUNCATED` when the token limit was hit.

**Manifest change**: added `"full_page_app"` location to the `common` module — this introduces a UI placement for the first time. Requires `app/index.html` and `app/icon.svg` to be present at pack time.

**Version bump touches**: `package.json`, `config/iparams.json`, this file.

## 1.1.2 (2026-08-11) — Make web search actually fire, and stay under the execution cap

Sandbox testing of v1.1.1 (web search confirmed enabled) showed the tool was attached but never
used, and a searching request could drop the note entirely. Two fixes:

- **System prompt now sanctions and scopes web search** (`WEB_SEARCH_INSTRUCTIONS`, added by
  `buildSystemPrompt` only when the tool is attached). Before this, the tool was dormant — the
  prompt never told the model it existed or when to use it, so Sonnet 5 (conservative about tools)
  didn't search, and a ticket that *asked* for current info was read as a **prompt-injection attempt
  and refused** (observed on a live sandbox ticket). The block frames search as a sanctioned part of
  triage, tells the model the ticket text is context (not instructions), scopes *when* to search
  (specific product/error/version, current info would help, no KB covers it), and requires citing
  the source and never fabricating "current" guidance.
- **Web search switched to `allowed_callers: ["direct"]`.** The `_20260318` default runs dynamic
  filtering *through code execution*, whose extra server-side round trips pushed a searching request
  past the 20s FDK execution cap in sandbox — the ticket got **no note at all**. Direct search is
  faster and reliably posts under the cap; it trades dynamic filtering's token savings (full results
  now reach context) for reliability, which is the right call for a serverless webhook. Revisit if
  the handler ever gets the 40s ceiling.
- Tests: 74 tests, 100% coverage — added system-prompt-on/off and the updated tool-shape assertion.

## 1.1.1 (2026-08-11) — Deflection matcher + checkbox-parsing fixes (from sandbox smoke test)

Two bug fixes surfaced by the first v1.1.0 sandbox smoke test:

- **SQM matcher was start-anchored** (`/^\s*(\[ext\]\s*)?sqm\s*[-–]/i`) — a leading subject prefix
  defeated it, so the smoke test's `[SMOKE TEST] SQM - <host>` ticket (and any real forwarded
  `Fw: SQM - …`) fell through to AI triage instead of deflecting. Changed to a word-boundary match
  `/\bSQM\s*[-–]/i` (still avoids mid-word false positives like `MYSQM-1`). All other matchers were
  already substring-based and unaffected.
- **Checkbox iparams parsed too strictly.** `enable_web_search` used `=== true` and
  `enable_deflection` used `=== false`; FDK can deliver checkbox values as the strings
  `"true"`/`"false"`, which would silently disable web search even with the box checked. Added
  `iparamBool()` normalizing boolean and string forms; `enable_web_search` and `enable_deflection`
  now honor both. (Suspected cause of "web search enabled but no Web sources in the note.")
- Tests: 71 tests, 100% coverage — added prefixed-SQM (incl. the `MYSQM-1` non-match), and
  string-valued `enable_web_search`/`enable_deflection` cases.

## 1.1.0 (2026-08-11) — Web search grounding + recurring-ticket deflection

Two new features (MINOR — new iparams, new default model, new grounding/deflection behavior;
republish required).

**Sonnet 5 + web search grounding**
- Default `claude_model` changed `claude-haiku-4-5-20251001` → **`claude-sonnet-5`** (supports
  dynamic-filtering web search; Haiku still selectable for the cheapest/fastest no-search path).
- `callClaude()`: every request now sends `thinking: {type:"disabled"}` — Sonnet 5 runs adaptive
  thinking by default when omitted, which would consume the output budget (truncating the note)
  and add latency. Harmless on the Haiku fallback.
- New iparam **`enable_web_search`** (checkbox, default **off** — opt-in with a cost warning on the
  install page). When on, `callClaude()` adds the `web_search_20260318` tool (dynamic filtering +
  `response_inclusion:"excluded"`), capped by new iparam **`web_search_max_uses`** (default 3).
- `callClaude()`: bounded `pause_turn` continuation loop (≤ `MAX_SEARCH_CONTINUATIONS`+1 = 3
  requests) to resume server-side search turns; text and token/usage totals accumulate across
  rounds. (The plan's extra wall-clock guard was dropped for a clean count-only bound — the FDK
  cap terminates any pathological run regardless.)
- Notes now render a **"Web sources"** footer listing cited source URLs (`web_search_result_location`
  citations, deduped). Cost logging captures `usage.server_tool_use.web_search_requests`;
  `estimateCost()` adds the **$0.01/search** fee and the completion log shows the search count.
  `MODEL_PRICING_PER_MTOK` gains `claude-sonnet-5: {input:2, output:10}` — these are the
  **introductory** rates through 2026-08-31; bump to 3/15 on 2026-09-01.

**Recurring-ticket deflection (skip AI)**
- New iparam **`enable_deflection`** (checkbox, default **on**). Before any grounding/AI call,
  `onTicketCreateHandler` short-circuits five known automated/templated ticket types and posts a
  prewritten internal note (KB link to follow + canned-response reference), skipping Claude
  entirely: **admin consent, quarantine release, quarterly maintenance (SQM), Box/OneDrive shared
  links, employee termination**. Match rules are subject-anchored (quarantine also matches on
  `sub_category`), derived from real prod tickets #73369/#69313/#71751/#74220/#74291. The PoC gate
  still takes precedence. Deflection data is inlined in `server.js` (not a separate module) to keep
  the vm-based test loader simple.

**Tests:** `tests/server.test.js` grew to **67 tests, 100% coverage** — `baseTicket` changed to a
neutral non-matching incident (it was an SQM ticket that now deflects); added web-search tool,
citation, `pause_turn`, Sonnet-5/unknown-model cost, and all five deflection matchers (incl. the
two "termination" subjects not colliding, and deflection-disabled falling through to AI).

## 1.0.1 (2026-08-10) — Retry logic and status-check fix

- `callClaude()`: check `resp.status` before parsing — non-200 responses now throw a
  meaningful error (previously crashed silently inside `JSON.parse` with no log).
- `callClaude()`: retry on HTTP 429 up to 3 attempts with 1s/2s exponential back-off
  (defensive — rate limits are not currently a concern at the account's tier, but the
  guard is cheap and correct).
- Tests: `mockRequest()` now sets `status: 200` on Anthropic mock responses; added
  `claudeStatus` / `claudeResponses` options; added three new tests covering 429-retry,
  429-exhausted, and non-200 error paths (47 tests, 100% coverage maintained).

## 1.0.0 (2026-08-05) — Initial release (test)

- Ticket triage note generation via Anthropic Claude on `onTicketCreate`: one-line summary,
  Impact/Urgency/Priority with reasoning, up to two next steps.
- Knowledge Base grounding — cites a relevant Solutions article when one's found.
- Category/Sub-Category grounding against Freshservice's real taxonomy for uncategorized tickets.
- PoC safety gates: `poc_group_id` and `poc_workspace_id` (independent, both act as AND-filters
  when set) to limit blast radius during rollout.
- Installed and verified working end-to-end in the sandbox
  (`example-sandbox.freshservice.com`).
