#!/usr/bin/env node
/**
 * 集成验证：拿 Hindsight 真实的 retain 提示词与 JSON Schema去打免费车道。
 *
 * 这不是「随便找个提示词测一下」。Hindsight 的事实提取用的是
 * `FactExtractionResponse` schema（六字段：what/when/where/who/why/fact_type
 * + 嵌套的 causal_relations），提示词里还有一整套 classification 规则。
 * 免费档模型能不能扛住这个 schema，是「零成本方案能不能用」的唯一判据——
 * 泛泛地测一句「Say OK」证明不了任何事。
 *
 * schema 与字段说明来自 Hindsight 的 `/llm-requests` 响应（它自己把发出去的请求
 * 记下来了，包括 response_schema），所以这里的 schema 是真形状，不是猜的。
 *
 * 用法：node scripts/hindsight-extract-check.mjs [bridgeUrl]
 */

const BRIDGE = process.argv[2] || process.env.BRIDGE_URL || 'http://127.0.0.1:18999/v1'

/** Hindsight 的 ExtractedFact / FactCausalRelation / FactExtractionResponse。 */
const FACT_SCHEMA = {
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
          fact_kind: { type: 'string', enum: ['event', 'conversation'], default: 'conversation' },
          occurred_start: { type: ['string', 'null'] },
          occurred_end: { type: ['string', 'null'] },
          fact_type: { type: 'string', enum: ['world', 'assistant'] },
          entities: { type: 'array', items: { type: 'string' } },
          causal_relations: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              required: ['target_index', 'relation_type'],
              properties: {
                target_index: { type: 'integer' },
                relation_type: { type: 'string', const: 'caused_by' },
              },
            },
          },
          from_attachments: { type: ['integer', 'null'] },
        },
      },
    },
  },
}

/** Hindsight retain 的规则要点，按其提示词原文改写。 */
const SYSTEM_PROMPT = `Return valid json only.

You extract durable facts from a conversation.

fact_kind:
- "event": Specific datable occurrence (set occurred_start/end)
- "conversation": Ongoing state, preference, trait (no dates)

fact_type:
- "world": Objective/external facts, including the user's preferences, rules,
  corrections, constraints, plans, traits, or context. These stay "world" even when
  the user states them during an assistant interaction.
- "assistant": Actions, experiences, or observations the assistant/agent actually
  performed. Use this for the assistant/agent doing, trying, learning, deciding,
  recommending, or responding - not merely for user facts mentioned in conversation.

TEMPORAL HANDLING
- Convert ALL relative temporal expressions to absolute dates in the fact text itself.
- For events: set occurred_start AND occurred_end (same for point events)

ENTITIES
- ALWAYS return "entities" as an array of plain strings - never objects, never null.
- Include: people names, organizations, places, key objects, abstract concepts.
- Always include "user" when fact is about the user.

QUALITY OVER QUANTITY
Ask: "Would this be useful to recall in 6 months?" If no, skip it.

For non-English input, ALL output values MUST be in the input language.`

/** 一个混合了偏好、约束、事件、助手动作的真实对话——四种 fact_kind/type 都覆盖到。 */
const CASES = [
  {
    name: '用户偏好 + 助手动作 + 因果',
    content: JSON.stringify([
      { role: 'user', content: '我不喜欢被叫全名，以后叫我小 K 就行。' },
      { role: 'assistant', content: '明白，我以后都叫你小 K。' },
      { role: 'user', content: '另外我每天早上七点背单词，然后吃早饭去上课。' },
      { role: 'assistant', content: '好的，我把晨间计划记下来了。' },
      { role: 'user', content: '上周三我在图书馆把高数第三章刷完了，感觉比第二章顺。' },
    ]),
    expect: ['小 K', '背单词'],
  },
  {
    name: '英文对话 + 技术约束',
    content: JSON.stringify([
      { role: 'user', content: 'We must pin the Postgres image to 15.4 and never use the floating tag in CI.' },
      { role: 'user', content: 'The migration script keeps timing out, so we split it into three steps.' },
      { role: 'assistant', content: 'I split the migration and added a retry with backoff.' },
    ]),
    expect: ['15.4'],
  },
]

let failures = 0
function check(name, ok, detail) {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
  if (!ok) failures += 1
}

process.stdout.write(`\nbridge: ${BRIDGE}\n`)

for (const testCase of CASES) {
  process.stdout.write(`\n[${testCase.name}]\n`)
  const began = Date.now()
  let payload
  let model = ''
  try {
    const response = await fetch(`${BRIDGE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer local',
        // 模拟 Hindsight 的 retain 是一条固定调用链
        'x-session-id': 'hindsight-retain',
      },
      body: JSON.stringify({
        model: 'space-bunny-free',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Extract facts from the following chunk.\n\nContent:\n${testCase.content}` },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'FactExtractionResponse', schema: FACT_SCHEMA, strict: false } },
        temperature: 0.1,
        max_tokens: 4096,
      }),
    })
    const json = await response.json().catch(() => null)
    model = String(json?.model ?? '')
    check('HTTP 200', response.status === 200, `got ${response.status} ${json?.error?.message ?? ''}`)
    if (response.status !== 200) continue

    const text = json?.choices?.[0]?.message?.content ?? ''
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    let parsed = null
    if (start !== -1 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { parsed = null }
    }
    check('schema-valid JSON parses', parsed !== null, text.slice(0, 140))
    if (parsed === null) continue

    const facts = parsed.facts
    check('has a facts array', Array.isArray(facts) && facts.length > 0, `got ${Array.isArray(facts) ? facts.length : typeof facts}`)

    const required = ['what', 'when', 'where', 'who', 'why', 'fact_type']
    const allFields = Array.isArray(facts) && facts.every(f => required.every(k => typeof f?.[k] === 'string'))
    check('every fact carries all 6 required fields', allFields,
      Array.isArray(facts) && facts[0] ? `first fact keys: ${Object.keys(facts[0]).join(',')}` : 'n/a')

    const enumsOk = Array.isArray(facts) && facts.every(f =>
      (f.fact_type === 'world' || f.fact_type === 'assistant') &&
      (f.fact_kind === undefined || f.fact_kind === 'event' || f.fact_kind === 'conversation'))
    check('fact_type / fact_kind within enum', enumsOk)

    const entitiesOk = Array.isArray(facts) && facts.every(f =>
      f.entities === undefined || (Array.isArray(f.entities) && f.entities.every(e => typeof e === 'string')))
    check('entities are plain strings', entitiesOk,
      Array.isArray(facts) && Array.isArray(facts[0]?.entities) ? JSON.stringify(facts[0].entities.slice(0, 5)) : 'n/a')

    const causalOk = Array.isArray(facts) && facts.every((f, i) => {
      if (f.causal_relations === null || f.causal_relations === undefined) return true
      if (!Array.isArray(f.causal_relations)) return false
      return f.causal_relations.every(r => Number.isInteger(r?.target_index) && r.target_index < i && r.relation_type === 'caused_by')
    })
    check('causal target_index precedes its own fact', causalOk)

    const blob = JSON.stringify(facts)
    const hit = testCase.expect.filter(token => blob.includes(token))
    check('key terms survived extraction', hit.length === testCase.expect.length,
      `found ${hit.length}/${testCase.expect.length}: ${hit.join(', ') || 'none'}`)

    process.stdout.write(`        model=${model}  facts=${Array.isArray(facts) ? facts.length : '?'}  ${((Date.now() - began) / 1000).toFixed(1)}s\n`)
    process.stdout.write(`        sample: ${Array.isArray(facts) && facts[0] ? JSON.stringify(facts[0]).slice(0, 180) : 'n/a'}\n`)
  } catch (error) {
    check('request completed', false, error?.message ?? String(error))
  }
}

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
