#!/usr/bin/env node
/**
 * 诊断：免费车道到底接不接受 `response_format`，接受哪一种形状。
 *
 * 这不是好奇心——Hindsight 的 retain 就是靠 `response_format` 拿结构化 JSON 的。
 * 如果免费车道拒绝它，整套零成本方案在生产里是废的（retain 每轮都会失败）。
 * 所以必须把答案测出来，而不是假设它和 OpenAI 一样。
 */

const BRIDGE = process.argv[2] || 'http://127.0.0.1:18999/v1'

const SCHEMA = {
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

const base = {
  model: 'space-bunny-free',
  messages: [
    { role: 'system', content: 'Return valid json only. Extract facts into {"facts":[{"what":string,"fact_type":"world"|"assistant"}]}.' },
    { role: 'user', content: 'I hate being called by my full name. Call me K instead.' },
  ],
  max_tokens: 1024,
}

const VARIANTS = [
  { name: 'no response_format', patch: {} },
  { name: 'json_object', patch: { response_format: { type: 'json_object' } } },
  {
    name: 'json_schema (no strict)',
    patch: { response_format: { type: 'json_schema', json_schema: { name: 'FactExtractionResponse', schema: SCHEMA } } },
  },
  {
    name: 'json_schema strict:true',
    patch: { response_format: { type: 'json_schema', json_schema: { name: 'FactExtractionResponse', schema: SCHEMA, strict: true } } },
  },
  { name: 'legacy json_object flag', patch: { json_object: true } },
]

for (const variant of VARIANTS) {
  const began = Date.now()
  let verdict = '?'
  let detail = ''
  try {
    const response = await fetch(`${BRIDGE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local', 'x-session-id': 'diag' },
      body: JSON.stringify({ ...base, ...variant.patch }),
    })
    const json = await response.json().catch(() => null)
    const seconds = ((Date.now() - began) / 1000).toFixed(1)
    if (response.status === 200) {
      const text = json?.choices?.[0]?.message?.content ?? ''
      let parsed = null
      try { parsed = JSON.parse(text) } catch { parsed = null }
      verdict = parsed?.facts ? 'OK (valid JSON w/ facts)' : 'OK (200 but not schema JSON)'
      detail = JSON.stringify(text).slice(0, 90)
    } else {
      verdict = `REJECTED ${response.status}`
      detail = String(json?.error?.message ?? '').slice(0, 120)
    }
    process.stdout.write(`${variant.name.padEnd(26)} ${verdict.padEnd(30)} ${seconds}s  ${detail}\n`)
  } catch (error) {
    process.stdout.write(`${variant.name.padEnd(26)} ${'THREW'.padEnd(30)}          ${error?.message ?? error}\n`)
  }
  await new Promise(r => setTimeout(r, 900))
}
