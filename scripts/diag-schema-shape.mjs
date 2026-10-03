#!/usr/bin/env node
/**
 * 二分定位：Hindsight 那套 schema 里到底哪一部分让免费车道回 400。
 *
 * 已知结论（上一轮实测）：
 *   - 无 response_format                     → 正常返回
 *   - response_format: {type:'json_object'}   → 200，但输出被 ```json 围栏包住
 *   - response_format: json_schema + strict  → 正常，且 JSON 干净
 *   - response_format: json_schema 无 strict  → 200，但 content 是空字符串（静默失败）
 *
 * 这一步要定位的是「完整 Hindsight schema 为什么 400」。候选：enum、const、nullable
 * 联合类型、嵌套数组对象、字段数量。逐个只改一处，看哪一个把 400 变回 200。
 */

const BRIDGE = process.argv[2] || 'http://127.0.0.1:18999/v1'

const str = { type: 'string' }

function schemaWith(props, required) {
  return {
    type: 'object',
    required: ['facts'],
    properties: {
      facts: { type: 'array', items: { type: 'object', required, properties: props } },
    },
  }
}

const FULL = schemaWith(
  {
    what: str, when: str, where: str, who: str, why: str,
    fact_kind: { type: 'string', enum: ['event', 'conversation'] },
    occurred_start: { type: ['string', 'null'] },
    occurred_end: { type: ['string', 'null'] },
    fact_type: { type: 'string', enum: ['world', 'assistant'] },
    entities: { type: 'array', items: str },
    causal_relations: {
      type: ['array', 'null'],
      items: { type: 'object', required: ['target_index', 'relation_type'], properties: { target_index: { type: 'integer' }, relation_type: { type: 'string', const: 'caused_by' } } },
    },
    from_attachments: { type: ['integer', 'null'] },
  },
  ['what', 'when', 'where', 'who', 'why', 'fact_type'],
)

const CASES = [
  ['baseline: 2 plain string fields', schemaWith({ what: str, fact_type: str }, ['what', 'fact_type'])],
  ['6 plain string fields (Hindsight required set)', schemaWith(
    { what: str, when: str, where: str, who: str, why: str, fact_type: str },
    ['what', 'when', 'where', 'who', 'why', 'fact_type'])],
  ['+ enum', schemaWith(
    { what: str, fact_kind: { type: 'string', enum: ['event', 'conversation'] } }, ['what'])],
  ['+ nullable union ["string","null"]', schemaWith({ what: str, occurred_start: { type: ['string', 'null'] } }, ['what'])],
  ['+ array of string', schemaWith({ what: str, entities: { type: 'array', items: str } }, ['what'])],
  ['+ nested array of object with const', schemaWith(
    { what: str, causal_relations: { type: ['array', 'null'], items: { type: 'object', required: ['target_index', 'relation_type'], properties: { target_index: { type: 'integer' }, relation_type: { type: 'string', const: 'caused_by' } } } } },
    ['what'])],
  ['FULL Hindsight schema', FULL],
]

const base = {
  model: 'space-bunny-free',
  messages: [
    { role: 'system', content: 'Return valid json only. Extract facts into {"facts":[...]}. All values in the input language.' },
    { role: 'user', content: '我叫小 K，不要叫我全名。每天早上七点背单词。' },
  ],
  max_tokens: 2048,
}

process.stdout.write(`\n探针：json_schema + strict:true，逐项看谁被拒\n\n`)
for (const [name, schema] of CASES) {
  const began = Date.now()
  try {
    const response = await fetch(`${BRIDGE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local', 'x-session-id': 'schema-probe' },
      body: JSON.stringify({
        ...base,
        response_format: { type: 'json_schema', json_schema: { name: 'FactExtractionResponse', schema, strict: true } },
      }),
    })
    const json = await response.json().catch(() => null)
    const seconds = ((Date.now() - began) / 1000).toFixed(1)
    if (response.status === 200) {
      const text = json?.choices?.[0]?.message?.content ?? ''
      let parsed = null
      try { parsed = JSON.parse(text) } catch { parsed = null }
      process.stdout.write(
        `${name.padEnd(42)} 200  ${seconds.padStart(6)}s  ` +
        `${parsed?.facts ? 'clean JSON, ' + parsed.facts.length + ' fact(s)' : 'unparseable: ' + JSON.stringify(text).slice(0, 50)}\n`,
      )
    } else {
      process.stdout.write(`${name.padEnd(42)} ${response.status}  ${String(json?.error?.message ?? '').slice(0, 70)}\n`)
    }
  } catch (error) {
    process.stdout.write(`${name.padEnd(42)} THREW  ${error?.message ?? error}\n`)
  }
  await new Promise(r => setTimeout(r, 900))
}
