#!/usr/bin/env node
/**
 * 免费模型分诊探针 —— Hindsight 换 LLM 时的第 1 步（见工作区规则「铁律五」）。
 *
 * ## 为什么需要它
 *
 * 免费车道的可用面**每 90 分钟就会变一次**（限流窗口），而且「能不能关思考」
 * 因模型而异。凭记忆改 `FALLBACK_ORDER` 或 `THINKING_OFF_MODELS` 一定会错——
 * 本探针把三件事一次量清楚，输出可直接照抄进 index.js。
 *
 * ## 量的四项
 *
 *   1. **直连命中率** —— `response.model === 请求的 model`。
 *      这是最关键的一项：桥是故障转移的，一个「看起来成功」的响应可能
 *      完全来自另一个模型。单看延迟会被骗（曾把一次 931ms 误判为「快 100 倍」，
 *      随后 20 连发全部被路由走）。
 *   2. **延迟** —— 取多次的 p50。
 *   3. **思考可否关** —— 对照 `reasoning_tokens` 是否归零，并抓 502。
 *   4. **JSON 合规** —— 用 Hindsight 的真实 `json_schema` + `strict` 形状跑一次。
 *
 * ## 用法
 *
 *     node scripts/probe-thinking.mjs                 # 打默认的本地桥
 *     BRIDGE=http://127.0.0.1:18999 node scripts/probe-thinking.mjs
 *     SAMPLES=3 node scripts/probe-thinking.mjs       # 每模型多打几次看稳定性
 *
 * 只读：不修改任何文件，也不改上游状态（除了消耗一点免费额度）。
 */

const BRIDGE = String(process.env.BRIDGE || 'http://127.0.0.1:18999').replace(/\/+$/, '')
const SAMPLES = Number(process.env.SAMPLES || 2)
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 45000)

/** 与 index.js 的 FALLBACK_ORDER 保持同源；新模型加在这里就会被探到。 */
const CANDIDATES = [
  'space-bunny-free',
  'jev-1.13-free',
  'ling-3.1-flash-free',
  'mimo-v2.5-free',
  'mimo-v2.6-flash-free',
  'deepseek-v4-flash-free',
  'ling-3.0-flash-fin-free',
  'longcat-2.5-preview-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'fledge-alpha-free',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'kilo-auto/free',
  'cohere/north-mini-code:free',
  'dots-studio/dots-3-note-preview:free',
  'poolside/laguna-s-2.1:free',
  'glm-4-flash-250414',
]

/** Hindsight retain 用的真实形状：对象根 + strict。 */
const SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  required: ['facts'],
  additionalProperties: false,
}

const PROMPT = 'What is 17*23? Reply with just the number.'
const CONVO = Array.from({ length: 20 }, (_, i) =>
  `User: message ${i} about configuring Hindsight on the NAS.\nAssistant: reply ${i}.`).join('\n')

function post(body, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  return fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local' },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).then(async response => {
    clearTimeout(timer)
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 也算一种结果 */ }
    const usage = json?.usage ?? {}
    const details = usage.completion_tokens_details ?? {}
    const message = json?.choices?.[0]?.message ?? {}
    return {
      status: response.status,
      ms: Date.now() - started,
      servedBy: json?.model ?? null,
      reasoningTokens: details.reasoning_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      finish: json?.choices?.[0]?.finish_reason ?? null,
      content: String(message.content ?? ''),
      error: response.status === 200 ? null : text.slice(0, 120),
    }
  }).catch(error => {
    clearTimeout(timer)
    return { status: 'ERR', ms: Date.now() - started, servedBy: null,
             reasoningTokens: null, completionTokens: null, finish: null,
             content: '', error: error?.name ?? String(error) }
  })
}

/** 剥 ```json 围栏再解析 —— 免费档的输出时干净时带围栏。 */
function parseFacts(content) {
  let text = String(content ?? '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fenced !== null) text = fenced[1]
  try {
    const parsed = JSON.parse(text)
    return { ok: Array.isArray(parsed?.facts), count: (parsed?.facts ?? []).length }
  } catch {
    return { ok: false, count: 0 }
  }
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const rows = []
process.stdout.write(`探针目标：${BRIDGE}\n每模型采样 ${SAMPLES} 次\n\n`)

for (const model of CANDIDATES) {
  // --- 1/2. 直连命中率与延迟 ---
  const samples = []
  for (let i = 0; i < SAMPLES; i += 1) {
    samples.push(await post({ model,
      messages: [{ role: 'user', content: PROMPT }], max_tokens: 128 }))
  }
  const ok = samples.filter(s => s.status === 200)
  const direct = ok.filter(s => s.servedBy === model)
  const latencies = ok.map(s => s.ms)

  // --- 3. 思考可否关（只对直连成功的模型有意义）---
  let off = null
  if (direct.length > 0) {
    off = await post({ model,
      messages: [{ role: 'user', content: PROMPT }], max_tokens: 128,
      reasoning: { enabled: false } })
  }

  // --- 4. JSON 合规 ---
  let json = null
  if (direct.length > 0) {
    const raw = await post({ model,
      messages: [{ role: 'system', content: 'Extract facts. Reply with JSON only.' },
                 { role: 'user', content: CONVO }],
      max_tokens: 1200,
      response_format: { type: 'json_schema', json_schema: { name: 'out', strict: true, schema: SCHEMA } },
      reasoning: { enabled: false } })
    json = { ...raw, parsed: parseFacts(raw.content) }
  }

  const row = { model, direct: direct.length, sampled: samples.length,
                medianMs: median(latencies), off, json }
  rows.push(row)

  const directLabel = `${direct.length}/${samples.length}`
  const offLabel = off === null
    ? '—'
    : (off.status === 200
        ? `OK rt=${off.reasoningTokens} ${off.ms}ms`
        : `${off.status} ${off.error ?? ''}`.slice(0, 40))
  const jsonLabel = json === null ? '—'
    : (json.parsed.ok ? `OK n=${json.parsed.count}` : `FAIL ${json.status}`)
  process.stdout.write(
    `${model.padEnd(46)} 直连 ${directLabel.padEnd(5)} ` +
    `p50 ${String(row.medianMs ?? '—').padStart(6)}ms  ` +
    `关思考 ${offLabel.padEnd(26)} JSON ${jsonLabel}\n`)
}

// --- 可照抄的结论 ---------------------------------------------------------
process.stdout.write('\n=== 可照抄进 index.js 的名单 ===\n')

const thinkingOff = rows
  .filter(r => r.off !== null && r.off.status === 200 && r.off.reasoningTokens === 0)
  .map(r => r.model)
process.stdout.write(`\n// 实测能关思考且 reasoning_tokens 归零：\n`)
for (const m of thinkingOff) process.stdout.write(`  '${m}',\n`)

const broken = rows.filter(r => r.off !== null && r.off.status !== 200).map(r => r.model)
if (broken.length > 0) {
  process.stdout.write(`\n// ⚠️ 加思考补丁会失败——绝不能进上面的名单：\n`)
  for (const m of broken) process.stdout.write(`  '${m}',\n`)
}

const usable = rows.filter(r => r.direct > 0).sort((a, b) => (a.medianMs ?? 1e9) - (b.medianMs ?? 1e9))
process.stdout.write(`\n// 实测直连可用（按延迟升序）——FALLBACK_ORDER 候选：\n`)
for (const r of usable) {
  const offNote = thinkingOff.includes(r.model) ? ' [可关思考]' : ''
  process.stdout.write(`  '${r.model}',  // ${r.medianMs}ms${offNote}\n`)
}

const unusable = rows.filter(r => r.direct === 0).map(r => r.model)
if (unusable.length > 0) {
  process.stdout.write(`\n// 本轮直连失败（多被限流，约 90 分钟后恢复；排在后面但别删）：\n`)
  for (const m of unusable) process.stdout.write(`  '${m}',\n`)
}
process.stdout.write('\n')
