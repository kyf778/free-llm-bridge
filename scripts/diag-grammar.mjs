#!/usr/bin/env node
/**
 * 追问：规整之后模型仍然吐 ```json 围栏、并且用 `text` 而不是 `what`。
 * 为什么语法引擎没有接管？
 *
 * 上一轮 diag 里，2 个字段的简单 schema + strict:true 确实产出了干净 JSON。
 * 但 Hindsight 那套 schema（12 个字段、嵌套数组对象）却没有。变量有两个：
 *   1. schema 复杂度 —— 是不是某个字段让引擎放弃了强制
 *   2. 模型本身   —— space-bunny-free 是不是不配合
 *
 * 这里固定 schema，只换模型；再固定模型，只换 schema，把两个变量分开。
 */

const BRIDGE = process.argv[2] || 'http://127.0.0.1:18999/v1'

const SIMPLE = {
  type: 'object',
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['what', 'fact_type'],
        properties: {
          what: { type: 'string' },
          fact_type: { type: 'string', enum: ['world', 'assistant'] },
        },
      },
    },
  },
}

const FULL = {
  type: 'object',
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['what', 'when', 'where', 'who', 'why', 'fact_type'],
        properties: {
          what: { type: 'string' },
          when: { type: 'string' },
          where: { type: 'string' },
          who: { type: 'string' },
          why: { type: 'string' },
          fact_kind: { type: 'string', enum: ['event', 'conversation'] },
          fact_type: { type: 'string', enum: ['world', 'assistant'] },
          entities: { type: 'array', items: { type: 'string' } },
          causal_relations: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              required: ['target_index', 'relation_type'],
              properties: { target_index: { type: 'integer' }, relation_type: { type: 'string', const: 'caused_by' } },
            },
          },
        },
      },
    },
  },
}

const MSG = [
  { role: 'system', content: 'Return valid json only. Extract durable facts. All values in the input language.' },
  { role: 'user', content: '我叫小 K，不要叫我全名。每天早上七点背单词。' },
]

async function probe(model, schema, label) {
  const began = Date.now()
  try {
    const response = await fetch(`${BRIDGE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local', 'x-session-id': 'probe2' },
      body: JSON.stringify({
        model,
        messages: MSG,
        max_tokens: 2048,
        temperature: 0.1,
        response_format: { type: 'json_schema', json_schema: { name: 'FactExtractionResponse', schema, strict: true } },
      }),
    })
    const json = await response.json().catch(() => null)
    const seconds = ((Date.now() - began) / 1000).toFixed(1)
    if (response.status !== 200) {
      process.stdout.write(`${label.padEnd(34)} HTTP ${response.status}  ${String(json?.error?.message ?? '').slice(0, 60)}\n`)
      return
    }
    const text = json?.choices?.[0]?.message?.content ?? ''
    const fenced = /^\s*```/.test(text)
    let parsed = null
    const m = text.match(/\{[\s\S]*\}/)
    if (m) { try { parsed = JSON.parse(m[0]) } catch { parsed = null } }
    const usedWhat = Array.isArray(parsed?.facts) && parsed.facts.every(f => typeof f?.what === 'string')
    const usedText = Array.isArray(parsed?.facts) && parsed.facts.every(f => typeof f?.text === 'string')
    const tags = [
      fenced ? 'FENCED' : 'bare',
      usedWhat ? 'uses-what' : (usedText ? 'uses-TEXT(renamed)' : 'mixed'),
      `facts=${Array.isArray(parsed?.facts) ? parsed.facts.length : '?'}`,
      `model=${json?.model ?? model}`,
    ]
    process.stdout.write(`${label.padEnd(34)} ${seconds.padStart(6)}s  ${tags.join('  ')}\n`)
  } catch (error) {
    process.stdout.write(`${label.padEnd(34)} THREW  ${error?.message ?? error}\n`)
  }
  await new Promise(r => setTimeout(r, 900))
}

process.stdout.write('\n=== 变量 1：固定 SIMPLE schema，换模型 ===\n')
for (const m of ['space-bunny-free', 'fledge-alpha-free', 'nemotron-3.5-lightning-free', 'longcat-2.5-preview-free']) {
  await probe(m, SIMPLE, `SIMPLE / ${m}`)
}

process.stdout.write('\n=== 变量 2：固定模型，换 schema 复杂度 ===\n')
await probe('space-bunny-free', SIMPLE, 'SIMPLE / space-bunny')
await probe('space-bunny-free', FULL, 'FULL / space-bunny')
