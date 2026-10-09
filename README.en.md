# free-llm-bridge

**English** | [简体中文](./README.md)

[![CI](https://github.com/kyf778/free-llm-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/kyf778/free-llm-bridge/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**Hook any OpenAI-compatible app onto a keyless, zero-cost, unlimited LLM lane.**

Written for memory systems like [Hindsight](https://github.com/vectorize-io/hindsight) — it
automatically runs 4 LLM stages after every conversation turn (fact extraction / consolidation /
knowledge-page refresh / reflection), which at commercial API rates burns eight yuan in two days.
Those calls now cost **0**.

- Zero dependencies, single file, needs only Node `>= 22.19`
- **No API key, no signup, no top-up required**
- Only serves free-tier models: a paid model that gets named is rejected with a 400, never
  silently rerouted
- **Multiple lanes supported**: when one is throttled or unreachable it swaps to the next,
  extensible
- Session affinity, so free quota is counted per session instead of per request

```bash
node index.js
# [free-llm-bridge] listening on http://127.0.0.1:18999/v1
# [free-llm-bridge] upstream: https://opencode.ai (keyless lane, no API key needed)
# [free-llm-bridge] probed 86 models: ...
```

In your app, fill in:

| Field | Value |
| --- | --- |
| `base_url` | `http://127.0.0.1:18999/v1` |
| `api_key` | `local` (any non-empty string; the bridge does not use it) |
| `model` | **`free-queue`** (recommended), or any model from `/v1/models` |

## Why we recommend `free-queue` (the queue sentinel)

Most callers (Hindsight included) **have only one "model name" config field**, so every turn names
the same model. But the usable surface of the free lane **changes every 90 minutes** (the
throttling window) — the pinned model is bound to hit the limit eventually, and then **every
request has to fail once** before it moves to another.

Naming `free-queue` is the same as telling the bridge "you figure it out":

- The bridge picks the current first model with capacity from the **measured queue**;
- Throttled models are **skipped outright**, not a single RTT wasted;
- The queue is **one single line across lanes**, not a separate queue per lane.

`free-queue` is also listed first in `/v1/models`. Pinning a specific model also works — as long as
it is free tier, the bridge honors your choice.

---

## Multiple lanes: turning a single point of failure into something extensible

**By default there is only one lane (the keyless OpenCode Zen), and as measured only one model on it
actually works — which means out of the box this is a single point of failure.** Once that model is
maxed out, the whole route stops. So a second lane isn't a nice-to-have; it's the availability floor
of this route.

Add lanes with the `LANES` environment variable, no code changes:

```bash
# Zhipu GLM-4-Flash-250414; the official page states outright that it is "Zhipu's first free LLM API"
# https://docs.bigmodel.cn/cn/guide/models/free/glm-4-flash-250414
export LANES='[
  {"name":"glm","baseUrl":"https://open.bigmodel.cn/api/paas/v4",
   "model":"glm-4-flash-250414","apiKey":"your-free-key"},
  {"name":"zen","baseUrl":"https://opencode.ai","model":"space-bunny-free",
   "headers":{"user-agent":"opencode/1.18.31","x-opencode-client":"desktop"},
   "fingerprintTools":true,"sessionScoped":true,"normalizeSchema":true,"strictSchema":true}
]'
node index.js
```

⚠️ **Once `LANES` is set, the built-in keyless lane is no longer added automatically** — you get
exactly what you configure. If you need both, write `zen` in as well (like above).

Fields on each lane:

| Field | Required | Description |
| --- | --- | --- |
| `name` | ✅ | Appears in logs and in `/health` |
| `baseUrl` | ✅ | Prefix up to `/chat/completions` |
| `model` | ✅ | **Must be a tier you have confirmed is free.** Naming a paid model by mistake = silently wiring the bill back onto yourself |
| `apiKey` | | If omitted, uses `Bearer public` (that is the credential for the OpenCode keyless lane) |
| `keyless` | | `true` means **this lane needs no credentials at all** — not even `Bearer public` is sent |
| `headers` | | Extra request headers this provider requires |
| `knownFree` | | Declares that `model` is free tier even if the id does not end in `-free` |
| `knownFreeModels` | | A set of known-free ids, letting a lane declare **multiple** candidates (see the Kilo example below) |
| `sessionScoped` | | Only when true is `x-opencode-session` sent (needed by providers that meter per session) |
| `fingerprintTools` | | Only when true are the four tools `bash/glob/grep/read` padded in |
| `strictSchema` | | Only when true is `response_format` sent (unsupported upstreams return 400) |
| `normalizeSchema` | | Only when true are nullable union types stripped |
| `pathStyle` | | `"openai"` means the standard `/chat/completions`; if omitted, routing is decided per model |

### The second keyless lane: Kilo AI

Besides OpenCode Zen, **Kilo AI is also a completely key-free lane**, with 17 models in its free pool
(`isFree: true`). Its ids look like `org/model:free`, not ending in `-free`, so they must be declared
explicitly with `knownFreeModels`:

```bash
export LANES='[
  {"name":"zen","baseUrl":"https://opencode.ai","model":"space-bunny-free",
   "headers":{"user-agent":"opencode/1.18.31","x-opencode-client":"desktop"},
   "fingerprintTools":true,"sessionScoped":true,"normalizeSchema":true,"strictSchema":true},
  {"name":"kilo","baseUrl":"https://api.kilo.ai/api/gateway",
   "model":"liquid/lfm-2.5-2.6b:free",
   "knownFree":true,"keyless":true,"pathStyle":"openai",
   "knownFreeModels":[
     "liquid/lfm-2.5-2.6b:free",
     "nvidia/nemotron-3-super-120b-a12b:free",
     "kilo-auto/free",
     "cohere/north-mini-code:free",
     "dots-studio/dots-3-note-preview:free",
     "poolside/laguna-s-2.1:free"
   ]}
]'
```

> ⚠️ `keyless` is not optional decoration: **OpenCode uses `Bearer public` to mean "keyless", but
> sending that same header to Kilo gets you `401 INVALID_TOKEN`** — the upstream treats invalid
> credentials as a login failure. If a lane genuinely needs no auth, it must be declared explicitly;
> inferring it from "no apiKey was filled in" is not enough.
>
> The 6 models in the list are ordered by measured median latency (5.5s → 8.8s). Kilo's free pool
> also has `stepfun/step-3.7-flash:free` and others, but on measurement **their output is swallowed
> by chain of thought, or they don't accept json_schema**, which makes them unsuitable for a caller
> like Hindsight that needs structured JSON — hence not listed.


`/health` reports, lane by lane, whether each one still has capacity:

```bash
curl -s localhost:18999/health | jq '.lanes'
```

Failover order: **first swap models within the same lane** (credentials, capabilities, and schema
policy all stay the same), **and only when that is exhausted, swap lanes**. Each `lane:model` is hit
at most once, the total hop count is capped, and it cannot loop forever.

Failure types that trigger a target swap (completed 2026-10-06; before that, missing entries meant
"if one doesn't work, move to the next" **did not take effect** for the most common failure
mode):

| Failure | Swap target? | Notes |
| --- | --- | --- |
| 429 throttled | ✅ | Cooldown length is taken from the upstream `retry-after`, capped at 6 hours |
| Transport-layer failure | ✅ | DNS / connection refused / timeout |
| Invalid credentials 401/403 | ✅ | Only swapping lanes helps here |
| `403 opencode-only` | ✅ | That model is open to OpenCode internally only |
| **Upstream 5xx** | ✅ | **Previously unhandled**: when the upstream returned 500, the bridge simply gave up instead of moving to the next one |
| **Empty completion** | ✅ | **Previously unhandled**: a 200 with an empty body (silent failure) also stopped it without swapping |
| Region gate 403 | ❌ | Swapping targets can't fix it; report it honestly |

The two "previously unhandled" rows above are the same class of bug: they were missing from the
`worthFailoverTo()` list, while the call site `return`ed directly — so the chain would halt on a
target that obviously should have been skipped.


---

## What it is doing

The upstream is a public keyless lane (the OpenCode Zen gateway), with 13 model ids ending in
`-free`.

> ⚠️ **But `-free` does not mean "third parties can use it directly."** After probing them one by one
> (`node scripts/probe-free-models.mjs`), it turned out that of the 13, **only `space-bunny-free` can
> be called directly**. Another 4
> (`fledge-alpha-free`, `nemotron-3-*`, `longcat-2.5-preview-free`) return
> `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`
> — the upstream enforces a hard restriction based on **call origin**; it is not a header problem
> (control experiment: `space-bunny-free` succeeds with no fingerprint headers at all). The rest are
> throttled or region-restricted.
>
> So "11 models, pick any" does not hold up. Please read [Known limitations](#known-limitations) below.
The bridge wraps that lane into a standard OpenAI-compatible service and solves four problems that
make it actually **sustainable** to use.

### 1. Session affinity — the most critical step

Free quota is metered per **session**. If you mint a fresh session id on every request, what the
upstream sees is "the same client just opened hundreds or thousands of new sessions in an instant",
which it judges to be abuse and immediately answers with 429.

As measured: curling the upstream directly the first time, one random session per request, two
requests back to back — and the supposedly usable `mimo-v2.6-flash-free` was already throttled.

The bridge maps "the same downstream consumer" stably onto "the same upstream session":

```js
const digest = sha256(`free-llm-bridge\0${HOST}:${PORT}\0${downstreamKey}`)
// → ses_<12hex><14base62>
```

The upstream therefore sees a normal long-lived session. Retries within the same turn also share a
`request id`, so a retry is not counted as a new turn.

The consumer identity is taken first from the `x-session-id` / `x-conversation-id` headers; if
absent, it falls back to the remote address — the same app over the same link looks like one long
session upstream.

### 2. Tool fingerprint gate

The upstream requires the request to declare the four tool names `bash`, `glob`, `grep`, `read`,
otherwise you get 403 `FreeTierError`. Batch scenarios have no real tools, so the bridge pads in four
**self-disabling decoys** (described as "This tool is currently unavailable and must not be used."),
which the model cannot use even if it tries to call them.

It also normalizes case-duplicated declarations like `Bash`+`bash` into one — the upstream rejects
duplicates outright.

### 3. Free-tier failover

The upstream's `/zen/v1/models` returns **86 models**, the vast majority of which are metered paid
tiers (`gpt-5`, `claude-opus-5`, `mimo-v2.6-flash` non-free, …).

So the candidate pool must be hard-filtered:

```js
function isFreeModel(model) {
  return model.endsWith('-free')
}
```

- A named paid model → **400 rejection**, stating that only free tiers are available. Silently
  rerouting would let the caller believe it was using the model it named, while something entirely
  different was actually running.
- A named free model that is throttled → walk the built-in order to the next free tier that is not in
  cooldown
- All free tiers throttled → 429, with `retry-after` telling the caller the minimum wait

This guarantee is pinned by 5 regression assertions in `test-free-only.mjs`; run it before changing
anything.

### 4. Read the stream, don't trust the header

Under high load the upstream returns a full set of SSE frames with `content-type: application/json`.
Trust the header and you read the entire stream as a string, `JSON.parse` fails, and the whole turn
is wasted. The bridge treats content-type as non-streaming and everything else as streaming
pass-through, appending a `[DONE]` at the end.

---

## Turning off thinking — the single biggest speed waste on this lane

On the free tier, **thinking tokens share the same `max_tokens` budget as the body text**. For light
tasks like "extract facts from a conversation", the model still thinks for thousands of tokens before
producing any text — that is the real reason a single call routinely takes tens or hundreds of
seconds.

The bridge pads in the parameter that disables thinking, but **only for models measured to accept
it**.

### The parameter shape is nested, not flat

```js
{ reasoning: { enabled: false } }     // ✅ correct
```

The flat `reasoning_effort` / `enable_thinking` / `thinking` **have the wrong shape**: some lanes
answer 502 outright, and on others they are silently ignored (`reasoning_tokens` unchanged). This
shape matches the `effortOffPatch` of every model in the Our Free Model plugin catalog.

### ⚠️ It must never be applied globally

The upstream handles the thinking parameter **differently per model**. Same patch:

| Model | With `{"reasoning":{"enabled":false}}` |
| --- | --- |
| `nvidia/nemotron-3-super-120b-a12b:free` | ✅ 200, `reasoning_tokens` 41 → **0** |
| `cohere/north-mini-code:free` | ✅ 200, rt 32 → **0** |
| `nemotron-3.5-lightning-free` | ✅ 200, rt 136 → **0** |
| `kilo-auto/free` | ⚠️ 200 but rt still 54 (doesn't turn off cleanly) |
| **`liquid/lfm-2.5-2.6b:free`** | ❌ **502** |

That last row is where the lesson comes from: the upstream's own words are `Reasoning is mandatory
for this endpoint and cannot be disabled`. The bridge does **cross-lane failover**, so a global
parameter will eventually land on an arbitrary model — which amounts to poisoning one model with
another model's dialect. As measured, after writing the thinking parameter into Hindsight's global
`EXTRA_BODY`, the previously working `liquid` calls started 502ing in droves.

So the bridge maintains a **measured-passing** list, `THINKING_OFF_MODELS`, and applies it according
to **the model actually targeted this time**: after failover swaps the model, it re-decides.

### The payoff (measured 2026-10-06, real Hindsight load)

| Stage | Before | After | Thinking tokens |
| --- | --- | --- | --- |
| `retain_extract_facts` | 431.3 s | **51.1 s** | 3195 → **0** |
| `consolidation` | 199.5 s | **36.3 s** | 3915 → **0** |

`thinkingOffModels` in `/health` reports which models are currently on the list.

To re-verify: `node scripts/probe-thinking.mjs`

---

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness probe, no key needed |
| `GET` | `/v1/models` | Lists free-tier models only |
| `POST` | `/v1/chat/completions` | Streaming and non-streaming |

> `/v1/responses` is **not implemented**. The upstream does have a `/zen/v1/responses` line (the
> `muse-spark-*` series goes through it), but the bridge currently exposes only chat/completions.
> Hindsight uses chat/completions, so this does not affect the project's target scenario. Clients
> that need the Responses shape: please open an issue.

All routes except `/health` accept any non-empty `Authorization` — local self-use has no sessions and
the bridge does not validate it. **If you are going to expose the bridge to your LAN, put an auth
layer in front of it yourself**, or at least restrict the source with a firewall.

### Optional request headers

| Header | Effect |
| --- | --- |
| `x-session-id` | Identifies "the same consumer", affecting upstream session affinity |
| `x-request-id` | Identifies "the same turn"; retries with the same id count as one turn upstream |

---

## Testing

```bash
node test-free-only.mjs   # Zero-cost guarantee + session affinity + fingerprint gate + schema normalization + thinking-off + queue sentinel + doc consistency. No network, seconds
node test-multilane.mjs   # Multi-lane failover. Spins up two local fake upstreams, no network, seconds
node test-degradation.mjs # Degradation behavior when every lane is unavailable. No network, seconds
node smoke.mjs            # End to end. Hits the real upstream, consumes free quota
node soak.mjs             # Sustained load + failover. Hits the real upstream
node scripts/probe-thinking.mjs  # Free-model triage. Hits the real upstream, consumes a little free quota
```

`scripts/probe-thinking.mjs` is **the first step whenever you swap models or retune the queue**: in
one pass it measures direct-hit rate, latency p50, whether thinking can be turned off, and JSON
compliance, and at the end prints **a list you can copy straight into `index.js`** (which ones can
have thinking turned off, which ones 502 when you do, which ones are directly usable this round).

⚠️ It only measures "direct hits", not single-call latency — **single-call latency lies**. One 931ms
sample from some model was once misjudged as "100x faster", after which 20 back-to-back requests were
all routed away (429). Hit rate is the reliable signal.

The first three make no network calls (they all use local mock upstreams), and `npm test` runs them
in order. CI runs this assertion suite on **both Node 22.19 and 24.x** for every push and PR — they
need no secrets at all, because they never touch the real network. The badge above is a live run, not
decoration.

`test-multilane.mjs` deserves a separate mention: **multi-lane logic cannot be verified with the real
upstream alone**, because the real keyless lane has only one usable model — once the primary lane is
throttled there is simply no second real lane to swap to. So it spins up two local fake upstreams
that return 429 / 401 / unreachable on cue, and asserts that what the caller sees is **one success**
rather than one error. It also checks that per-lane flags really take effect per lane — the backup
lane genuinely did not receive `response_format` or the four decoy tools, while the primary lane
genuinely did.

`test-degradation.mjs` watches the **dangerous failure mode** of "zero cost": not failing forever
(that is visible), but **faking success**. As measured, when `json_schema` is sent without `strict`
the upstream returns 200 with an empty content — let that through and Hindsight's retain would
"successfully" extract zero facts: memory looks like it's working, nothing was actually stored, and
nothing anywhere reports an error. The bridge now degrades an empty completion into an explicit
failure, so it either fails over or reports honestly.

One of the assertions is a **documentation-consistency check**: every endpoint listed in the README's
API table must actually have a corresponding route in `index.js`. This one was written for a real
defect — the README once listed `POST /v1/responses` while no such route existed in the
implementation. The docs promised something the code did not do; the assertion was added afterwards
to pin the two together.

### Measure how much money you saved

```bash
node scripts/cost-analysis.mjs [hindsightUrl] [bankId]
```

Reads real usage from Hindsight's own `/llm-requests` endpoint, converts it to money at list prices,
and compares it against the free setup. Read-only, changes nothing. As measured on one real
deployment: ¥10.87/day before (about ¥2154/year), ¥0 after.

---

## Using it with Hindsight

See **[docs/hindsight-setup.md](docs/hindsight-setup.md)**. The recommended shape is **containerizing
the bridge into Hindsight's own compose** (no window, auto-start on boot, port not published, machine
can be shut down), with minimal changes:

```yaml
environment:
  HINDSIGHT_API_LLM_PROVIDER: openai
  # The bridge in the same compose is reached directly by service name; swap in the LAN IP of that
  # machine if the bridge runs elsewhere
  HINDSIGHT_API_LLM_BASE_URL: http://free-llm-bridge:18999/v1
  HINDSIGHT_API_LLM_API_KEY: local
  HINDSIGHT_API_LLM_MODEL: space-bunny-free
  # ⚠️ Must be written explicitly as postgresql://, together with the entrypoint wrapper script
  # below. These two things must appear as a pair; neither alone is enough — see the first FAQ
  # entry in the setup doc's troubleshooting section.
  HINDSIGHT_API_DATABASE_URL: postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight
```

The embedded postgres **must have someone explicitly responsible for starting it**, so the Hindsight
service also needs an entrypoint wrapper:

```yaml
  entrypoint: ["/bin/bash", "/app/start-hindsight.sh"]
  volumes:
    - hindsight-data:/home/hindsight/.pg0
    - ./start-hindsight.sh:/app/start-hindsight.sh:ro   # from this repo's deploy/
```

The script is [`deploy/start-hindsight.sh`](deploy/start-hindsight.sh): it starts postgres, polls
until it is genuinely `running: true`, and only then hands control to the official entrypoint.
**Configuring both** is the stable shape; configuring only `pg0://`, or starting postgres somewhere
else, lands you in a startup death loop after the container is recreated.

The bridge can also run on your own computer (double-click `启动桥.cmd`), but that is the fallback:
it needs a window open, needs firewall configuration, and memory stops when the computer shuts down.
Across machines, `host.docker.internal` is **wrong** — it points at the host of the machine Hindsight
runs on. Measured details are in the setup doc.

Also remember to relax the timeouts. Use `EXTRA_BODY` with `max_tokens` to cap output — **do not put
`thinking` in there**, that is Mimo's dialect parameter and the free lane answers 400 to it on
measurement (and EXTRA_BODY is merged into every LLM call):

```yaml
  HINDSIGHT_API_LLM_EXTRA_BODY: '{"max_tokens":4096}'
  HINDSIGHT_API_LLM_TIMEOUT: 600
```

---

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address. Before changing it to `0.0.0.0`, think hard about who will be using your quota |
| `PORT` | `18999` | Listen port; `--port` also works |
| `UPSTREAM_BASE` | `https://opencode.ai` | Upstream lane |
| `UPSTREAM_TIMEOUT_MS` | `600000` | Cap on a single upstream request. On the free lane the thinking phase can be silent for a long time |
| `MAX_FAILOVER_HOPS` | `16` | Maximum target swaps per request. The second safety net against looping |
| `DEFAULT_THROTTLE_SEC` | `5400` | Conservative backoff when the upstream gives no `retry-after` (the throttling window for these free models measures out at around 90 minutes) |
| `MAX_THROTTLE_SEC` | `21600` | Backoff ceiling. A mistyped `retry-after: 999999` should not make a model vanish forever |

---

## Known limitations

> Please read this section carefully. Every place this project is easiest to misread is in here, and
> **most of these conclusions are things I measured myself, not copied from upstream docs or the
> plugin README** — the two disagree on one key point (see below).

- **⚠️ "Which models are usable" is time-sensitive; don't edit it from memory.** The upstream
  throttling window is about 90 minutes, and the usable surface shifts back and forth. A re-test on
  2026-10-06 overturned two old conclusions:
  - Old conclusion "at any given moment only `space-bunny-free` can be reached directly" → as
    measured, `space-bunny-free` **0/4**, while `nemotron-3.5-lightning-free` was 4/4 and
    `nvidia/nemotron-3-super-120b-a12b:free` was 4/4.
  - Old conclusion "`fledge-alpha-free` / `nemotron-3-ultra-free` / `nemotron-3.5-lightning-free` /
    `longcat-2.5-preview-free` are **permanently** 403 opencode-only" → three of them **have been
    opened up upstream** (3/4, 3/4, 4/4 direct successes). So we **no longer hard-code** "who is
    opencode-only"; the bridge drops one only when it hits a 403 at runtime, and `test-free-only.mjs`
    verifies that mechanism rather than a list.

  **Before reordering the queue or changing the thinking-off list, run
  `node scripts/probe-thinking.mjs`.**
- **⚠️ 429 is not permanent death.** Throttling comes with `retry-after: ~5400s` (on the order of 90
  minutes), and it measurably counts down for real (`5425 → 5416 → 5405`), i.e. **rate limiting that
  recovers automatically when the time is up**. The bridge honors the duration the upstream gives
  rather than blanket 60 seconds — otherwise it would keep hitting the same wall for an hour and a
  half. Reproduce with: `node scripts/probe-throttled-depth.mjs`, `node scripts/probe-retry-after.mjs`.
- **⚠️ Stop looking for other keyless free rides; there really aren't any.** 11 providers measured
  (`node scripts/probe-keyless.mjs`): only OpenCode and Kilo can be called without a key; Zhipu,
  OpenRouter, SiliconFlow, Kimi, Cerebras, Groq, NVIDIA, Cloudflare **all require a key**. It also
  confirmed that the `/zen/go/v1` path returns `401 Missing API key` as well — it is a billing path,
  not a second keyless lane.
  **So the realistic form of "more lanes" is registering for free keys yourself**, see "Multiple
  lanes" above.
- **Failover walks the same queue.** The bridge lines up every free model across every lane into
  **one single line** (`QUEUE_ORDER` / `queueTargets`); "preferred" and "failover" use the same
  order — in the old implementation the two traversed in different orders, so the preferred pass
  picked one, and after a failure it started from the head of a different order, possibly retrying
  the one that had just failed. Each `lane:model` at most once, total hops capped by
  `MAX_FAILOVER_HOPS` (default 16).
- **⚠️ Zhipu (`glm`) is fallback only — don't make it your workhorse.** Its free quota is limited and
  time-boxed, so `QUEUE_ORDER` **deliberately excludes it** — it sits as a standalone lane after all
  free lanes, for the occasion when "every free model has dropped dead".
- **Plugin probe results lie.** The `dsh-our-free-model` settings page shows those models as
  "available", but that is it probing from inside the DSH process — the upstream treats that as
  OpenCode-internal traffic. **Third-party tools that copy this list will come up empty.** To be
  sure, run `node scripts/probe-free-models.mjs` yourself.
- **`/v1/models` lists models that are "free and not excluded by measurement"**, which is not the
  same as "definitely usable right now". Throttling and region gates are runtime conditions that
  cannot be probed.
- **"Free" does not mean "unlimited".** This lane is rate-limited per session; hammering it in a
  short window returns 429.
- **Region gates.** Some models return an outright 403 for egress from certain regions (on
  measurement, `muse-spark-1.3/1.2-contributor-free` were blocked from CN egress). The bridge excludes
  these models from the candidate pool.
- **Structured output needs the bridge to normalize it.** The free lane's grammar engine rejects
  nullable union types (`{"type": ["string", "null"]}`), and Hindsight's `FactExtractionResponse`
  has 4 such fields. The bridge automatically degrades them to the non-null branch and forces
  `strict: true`. **The same applies when you write your own schemas: using `anyOf`, or nullable
  branches, instead of union types avoids this problem.**
- **Grammar enforcement is not 100% reliable.** As measured, the same model with the same schema
  sometimes produces clean output, sometimes output wrapped in a ```json fence. So **callers should
  still be tolerant**: strip the fence, then `JSON.parse`. Hindsight's own parser does this, but yours
  might not.
- **The free tier will change.** The model set and quota policy are decided upstream and can be
  adjusted at any time. The bridge probes once at startup, but models that become available while it
  is running are only discovered after a restart.
- **What if the upstream switches to billing someday?** The bridge logs a WARNING when it sees a
  non-zero `cost` field in a response. This is passive detection, not an active guarantee — **check
  your own bill**.
- **The bridge also refuses "fake success".** When the upstream returns 200 with an empty body, the
  bridge degrades it into an explicit failure instead of passing it through. Otherwise the caller
  would believe it succeeded — and as measured, this is exactly the real behavior when `json_schema`
  is sent without `strict`.
- **The bridge does not retry.** It leaves failover to the caller's judgment (because only the caller
  knows whether a retry is appropriate). On the Hindsight side, `HINDSIGHT_API_LLM_MAX_RETRIES=2` is
  recommended.
- **Exposing it to the LAN = giving your quota away.** The bridge binds to loopback only by default.
  Before changing it to `0.0.0.0`, make sure your network is trustworthy.

---

## This is not a wheel, it's a wrapper

How the keyless free lane exists, and the reverse-engineering behind it, are fully documented by
[dsh-our-free-model](https://github.com/zouyuxuan122/dsh-our-free-model) (MIT) — its README section
"what the upstream sources are" spells out the credentials, fingerprint headers, and per-session
metering. This project does exactly one thing: **decouple that lane from the DSH plugin and turn it
into a service that runs standalone and can be consumed by a container on a NAS**.

The original plugin's forwarding port (`127.0.0.1:18899`) lives inside the DSH process; close DSH and
the quota is gone, and containers on the NAS cannot reach it either. That is the gap this project
fills.

---

## Backup routes (for when this lane stops working)

In priority order:

1. **OpenRouter `:free` models** — works right after signup, OpenAI-compatible, `/api/v1`. There is a
   daily request cap, but it is far more stable than a single lane.
2. **Google Gemini API free tier** — `generativelanguage.googleapis.com`, with a permanent free
   quota.
3. **Local Ollama + a small model** — truly, permanently free. On weak CPUs like a J1800, a 3B–4B
   quantized model is recommended, with `HINDSIGHT_API_LLM_PROVIDER=ollama`. Quality will drop, but
   the bill is forever zero.

See the comparison table in the report for details.

---

## License

MIT
