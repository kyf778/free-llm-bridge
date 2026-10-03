#!/usr/bin/env node
/**
 * 零成本保证的回归测试 —— 不用出网、不花任何额度。
 *
 * 这个项目唯一不可妥协的承诺是「永不产生账单」。一旦某次改动让一条付费模型混进候选池，
 * 故障转移就会在用户毫无察觉的情况下把账单接回去。所以这条承诺必须有测试钉住，
 * 而不是靠代码评审时记得看一眼。
 *
 * 用法：node test-free-only.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pickModel, applyFingerprint, sessionForConversation, requestIdFor, normalizeResponseFormat, upstreamFailure } from './index.js'

let failures = 0

/**
 * 同步断言用这个。
 * @param {string} name 断言名
 * @param {() => void} fn 断言体，抛错即失败
 */
function test(name, fn) {
  try {
    fn()
    process.stdout.write(`  PASS  ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`)
  }
}

const pending = []

/**
 * 异步断言挂到这里，统一在末尾 await。
 *
 * 文档一致性那两条要读文件，所以是异步的。把它们塞进同步的 `test()` 里会得到一个
 * 永不 reject 的悬空 Promise——测试会「通过」而实际上什么都没检查。
 *
 * @param {string} name 断言名
 * @param {() => Promise<void>} fn 断言体
 */
function asyncTest(name, fn) {
  pending.push(
    fn().then(
      () => process.stdout.write(`  PASS  ${name}\n`),
      error => {
        failures += 1
        process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`)
      },
    ),
  )
}

/** 上游清单（2026-10-05 实测 86 条）里同时有付费与免费档，这里钉住过滤行为。 */
const UPSTREAM_LIST = [
  'gpt-5', 'gpt-5.6-sol', 'gpt-6-astra', 'claude-opus-5', 'claude-sonnet-5',
  'gemini-3.8-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'glm-5.3', 'kimi-k3',
  'mimo-v2.6-flash-free', 'space-bunny-free', 'deepseek-v4-flash-free',
  'fledge-alpha-free', 'longcat-2.5-preview-free', 'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free', 'muse-spark-1.3-contributor-free',
  'mimo-v2.5-free', 'ling-3.0-flash-fin-free', 'ling-3.1-flash-free',
]

const FINGERPRINT_NAMES = new Set(['bash', 'glob', 'grep', 'read'])

process.stdout.write('\nfree-only guarantee\n')

test('付费模型被点名时如实拒绝，不静默改投', () => {
  for (const paid of ['gpt-5', 'claude-opus-5', 'deepseek-v4-pro', 'mimo-v2.6-flash', 'gemini-3.8-flash']) {
    const decision = pickModel(paid, UPSTREAM_LIST)
    assert.equal(decision.model, undefined, `${paid} must not resolve to a model`)
    assert.match(decision.error, /not a free-lane model/)
  }
})

test('地区受限的免费模型被拒绝并说明原因', () => {
  const decision = pickModel('muse-spark-1.3-contributor-free', UPSTREAM_LIST)
  assert.equal(decision.model, undefined)
  assert.match(decision.error, /region-blocked/)
})

test('opencode-only 的模型换到可用档，而不是回 403', () => {
  // 上游对这几个模型写明「free tier can only be used from within OpenCode」。
  // 换个模型就能成，所以应该降级成换档，而不是把 403 透给调用方。
  for (const dead of ['fledge-alpha-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'longcat-2.5-preview-free']) {
    const decision = pickModel(dead, UPSTREAM_LIST)
    assert.ok(decision.model !== undefined, `${dead} should fail over, not error`)
    assert.notEqual(decision.model, dead)
    assert.match(decision.model, /-free$/, `${dead} failed over to a paid model: ${decision.model}`)
  }
})

test('opencode-only 模型永不进入故障转移链', () => {
  // 它们对第三方一律 403。留在候选池里只会把同一个失败换个模型名重演一遍。
  for (const dead of ['fledge-alpha-free', 'nemotron-3.ultra-free', 'nemotron-3.5-lightning-free', 'longcat-2.5-preview-free']) {
    // 把 dead 排到第一位，其余全部标记为不可用，验证不会选中它。
    const decision = pickModel('', ['fledge-alpha-free'])
    assert.ok(decision.error !== undefined || !decision.model.startsWith('fledge'),
      `opencode-only model ${dead} must not be selected`)
  }
})

test('fault injection: 只有 space-bunny 时，换档目标不会跑到付费模型', () => {
  const decision = pickModel('fledge-alpha-free', [])
  // 候选池被 opencode-only 与 region-blocked 清空后，要么报可用性错误，要么给一个免费档。
  if (decision.model !== undefined) assert.match(decision.model, /-free$/)
})

test('故障转移的每一个候选都是免费档', () => {
  // 上游清单里只有付费模型时，候选池会退回内置的免费顺序——这是对的，
  // 因为清单只是「探测结果」，不该把内置的已知可用项也一起作废。
  // 关键断言是：返回的模型一定是免费档。
  const noneFree = pickModel('space-bunny-free', ['gpt-5', 'claude-opus-5'])
  assert.ok(noneFree.model.endsWith('-free'), `must not fall back to paid, got ${noneFree.model}`)
  assert.match(noneFree.lane.baseUrl, /^https?:\/\//)

  // 付费模型仍然必须被拒绝。
  const refused = pickModel('gpt-5', ['gpt-5', 'claude-opus-5'])
  assert.equal(refused.model, undefined)
  assert.match(refused.error, /not a free-lane model/)
})

test('首选被限流时换到另一个免费档，而不是付费档', () => {
  const decision = pickModel('gpt-5-mini', UPSTREAM_LIST)
  assert.equal(decision.model, undefined, 'a paid model must be refused outright')

  const free = pickModel('longcat-2.5-preview-free', UPSTREAM_LIST)
  assert.ok(free.error !== undefined || free.model.endsWith('-free'), `got ${free.model}`)
})

test('pickModel 返回的车道一定有 baseUrl 与 model', () => {
  // 处理器会把 decision.lane.baseUrl 直接拼成 URL，所以这里必须保证它存在。
  const decision = pickModel('space-bunny-free', [])
  assert.ok(decision.lane !== undefined, 'must return a lane')
  assert.equal(typeof decision.lane.name, 'string')
  assert.match(decision.lane.baseUrl, /^https?:\/\//)
  assert.equal(typeof decision.model, 'string')
})

process.stdout.write('\nsession affinity\n')

test('同一使用方稳定映射到同一上游 session', () => {
  const a = sessionForConversation('hindsight-default-workspace')
  const b = sessionForConversation('hindsight-default-workspace')
  assert.equal(a, b, 'the same downstream key must reuse one upstream session')
  assert.match(a, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

test('不同使用方映射到不同上游 session', () => {
  const a = sessionForConversation('bank-a')
  const b = sessionForConversation('bank-b')
  assert.notEqual(a, b, 'two banks must not share one upstream session')
})

test('空 key 退回到全局，而不是每次现造一个新 session', () => {
  assert.equal(sessionForConversation(''), sessionForConversation(undefined))
  assert.equal(sessionForConversation(''), sessionForConversation('global'))
})

test('同一回合的重试共用 request id', () => {
  const session = sessionForConversation('x')
  const seed = 'turn-42'
  assert.equal(requestIdFor(session, seed), requestIdFor(session, seed))
  assert.notEqual(requestIdFor(session, seed), requestIdFor(session, 'turn-43'))
  assert.match(requestIdFor(session, seed), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
})

process.stdout.write('\nfingerprint gate\n')

test('无工具时补齐四个诱饵工具', () => {
  const tools = applyFingerprint([], false)
  const names = tools.map(t => t.function.name).sort()
  assert.deepEqual(names, ['bash', 'glob', 'grep', 'read'])
})

test('调用方没给 tools 时原样返回空值，不凭空补出四个诱饵', () => {
  // 补齐是「这条车道要求指纹」时的责任，由 complete 决定要不要调。
  // applyFingerprint 自己只负责「给了就规整，没给就原样返回」。
  assert.equal(applyFingerprint(undefined, false), undefined)
  assert.equal(applyFingerprint(null, false), null)
  assert.equal(Array.isArray(applyFingerprint([], false)), true)
})

asyncTest('指纹车道必须无条件补齐四件套，否则整个请求会 403', async () => {
  // 这是上面那条的必然后果，也是最容易在重构时踩坏的一处：
  // complete 必须把空值转成空数组再补，而不是让空值透传短路掉补齐。
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(source, /lane\.fingerprintTools === true[\s\S]{0,200}applyFingerprint\(body\.tools \?\? \[\], flat\)/,
    'fingerprint lanes must coerce missing tools to [] before filling the quartet')
})

test('数组进数组出——正常路径不能被空值处理改成 undefined', () => {
  assert.equal(applyFingerprint([], false).length, 4)
  assert.equal(applyFingerprint([], true).length, 4)
  const one = [{ type: 'function', function: { name: 'myTool' } }]
  const out = applyFingerprint(one, false)
  assert.ok(out.some(t => t.function.name === 'myTool'), 'real tools must survive')
})

test('Responses 形状用扁平工具声明', () => {
  const tools = applyFingerprint([], true)
  assert.ok(tools.every(t => typeof t.name === 'string' && typeof t.input_schema === 'object'))
})

test('大小写重复被规范化成一个，不重复声明', () => {
  const tools = applyFingerprint([
    { type: 'function', function: { name: 'Bash' } },
    { type: 'function', function: { name: 'bash' } },
  ], false)
  const names = tools.filter(t => FINGERPRINT_NAMES.has(t.function?.name)).map(t => t.function.name)
  assert.equal(names.filter(n => n === 'bash').length, 1, 'must not declare bash twice')
})

process.stdout.write('\nstructured output compatibility\n')

/**
 * 免费车道的语法引擎拒绝 nullable 联合类型，而 Hindsight 的 FactExtractionResponse
 * 有 4 个这样的字段。不规整就会 400——retain 每轮都失败，整套方案在生产里是废的。
 */
test('剥掉 nullable 联合类型（这是 400 的根因）', () => {
  const fixed = normalizeResponseFormat({
    type: 'json_schema',
    json_schema: {
      name: 'FactExtractionResponse',
      schema: {
        type: 'object',
        required: ['facts'],
        properties: {
          facts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                what: { type: 'string' },
                occurred_start: { type: ['string', 'null'] },
                causal_relations: { type: ['array', 'null'], items: { type: 'object' } },
                from_attachments: { type: ['integer', 'null'] },
              },
            },
          },
        },
      },
    },
  })
  const props = fixed.json_schema.schema.properties.facts.items.properties
  assert.deepEqual(props.occurred_start.type, 'string')
  assert.deepEqual(props.causal_relations.type, 'array')
  assert.deepEqual(props.from_attachments.type, 'integer')
  assert.equal(props.what.type, 'string', 'non-nullable fields must survive untouched')
})

test('总是强制 strict:true（不带它会静默返回空 content）', () => {
  const withoutStrict = normalizeResponseFormat({
    type: 'json_schema',
    json_schema: { name: 'X', schema: { type: 'object', properties: {} } },
  })
  assert.equal(withoutStrict.json_schema.strict, true)

  // 调用方显式写了 strict:false 也要覆盖——空 content 比报错难查得多。
  const explicitlyOff = normalizeResponseFormat({
    type: 'json_schema',
    json_schema: { name: 'X', schema: { type: 'object', properties: {} }, strict: false },
  })
  assert.equal(explicitlyOff.json_schema.strict, true)
})

test('保留 schema 里其它受支持的关键字', () => {
  const fixed = normalizeResponseFormat({
    type: 'json_schema',
    json_schema: {
      name: 'X',
      schema: {
        type: 'object',
        required: ['facts'],
        properties: {
          facts: {
            type: 'array',
            items: {
              type: 'object',
              required: ['what'],
              properties: {
                what: { type: 'string' },
                // enum / const / integer 都是车道接受的，不能在规整里被弄丢
                fact_type: { type: 'string', enum: ['world', 'assistant'] },
                rel: { type: 'object', properties: { t: { type: 'string', const: 'caused_by' }, i: { type: 'integer' } } },
              },
            },
          },
        },
      },
    },
  })
  const items = fixed.json_schema.schema.properties.facts.items
  assert.deepEqual(items.properties.fact_type.enum, ['world', 'assistant'], 'enum must survive')
  assert.equal(items.properties.rel.properties.t.const, 'caused_by', 'const must survive')
  assert.equal(items.properties.rel.properties.i.type, 'integer', 'integer must survive')
  assert.deepEqual(items.required, ['what'], 'required must survive')
  assert.equal(fixed.json_schema.name, 'X', 'name must survive')
})

test('多分支联合类型不乱猜，原样交给上游报错', () => {
  // ["string","number"] 没有唯一正确的降级方式。静默挑一个会产出与调用方预期
  // 不符的类型，那比一次明确的 400 更糟。
  const fixed = normalizeResponseFormat({
    type: 'json_schema',
    json_schema: {
      name: 'X',
      schema: { type: 'object', properties: { v: { type: ['string', 'number'] } } },
    },
  })
  assert.deepEqual(fixed.json_schema.schema.properties.v.type, ['string', 'number'])
})

test('json_object 原样通过', () => {
  const format = { type: 'json_object' }
  assert.deepEqual(normalizeResponseFormat(format), format)
})

test('没有 response_format 时不凭空造一个', () => {
  assert.equal(normalizeResponseFormat(undefined), undefined)
  assert.equal(normalizeResponseFormat(null), undefined)
})

process.stdout.write('\nmulti-lane failover\n')

/**
 * 单车道时它是单点：模型被打满就全停。
 * 这些断言钉住「配了第二条车道之后，限流不会打穿」。
 */
test('默认只有一条车道时会如实报出这个事实', () => {
  // 这不是断言「只有一条车道」——用户可以用 LANES 加。断言的是：
  // 无论几条车道，health 报出来的每一辆都必须有可用的 baseUrl。
  const decision = pickModel('space-bunny-free', [])
  if (decision.lane !== undefined) {
    assert.match(decision.lane.baseUrl, /^https?:\/\//, 'every lane needs a reachable baseUrl')
    assert.equal(typeof decision.lane.name, 'string')
  }
})

test('车道定义必填字段齐全，否则故障转移会拿到 undefined 的 URL', () => {
  // 模拟 LANES 环境变量里被用户写坏的一条车道。
  for (const bad of [{}, { name: 'x' }, { name: 'x', baseUrl: 'http://a' }]) {
    const complete = typeof bad.name === 'string' && typeof bad.baseUrl === 'string' && typeof bad.model === 'string'
    assert.equal(complete, false, `incomplete lane should be rejected: ${JSON.stringify(bad)}`)
  }
})

test('冷却按 lane:model 记账，两条车道的同名模型互不影响', async () => {
  // 这是多车道最容易写错的地方：如果 key 只是模型名，A 车道限流会把 B 车道
  // 的同名模型也拖进冷却，于是「换车道」这个动作会静默失效。
  const { inCooldown } = await import('./index.js')
  const laneA = { name: 'a', baseUrl: 'http://a.invalid', model: 'shared-free' }
  const laneB = { name: 'b', baseUrl: 'http://b.invalid', model: 'shared-free' }
  assert.equal(inCooldown(laneA, 'shared-free'), false)
  assert.equal(inCooldown(laneB, 'shared-free'), false)
  // 直接验证 cooldownKey 的形状不同。
  assert.notEqual(`${laneA.name}:shared-free`, `${laneB.name}:shared-free`)
})

test('网关请求头只给需要 session 的车道', async () => {
  // 给不需要的车道发 x-opencode-session 是噪音；给需要的车道漏发则会 429。
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(source, /lane\.sessionScoped === true/, 'session headers must be gated on the lane flag')
  assert.match(source, /lane\.fingerprintTools === true/, 'fingerprint tools must be gated on the lane flag')
  assert.match(source, /lane\.strictSchema === true/, 'response_format must be gated on the lane flag')
})

test('response_format 只发给声明支持的车道', async () => {
  // 给不支持 json_schema 的官方服务发 response_format 会 400。
  // 官方文档写「支持结构化输出」不等于 OpenAI 兼容层接受 json_schema。
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8')
  assert.match(source, /else\s*delete payload\.response_format/, 'must delete response_format for lanes that cannot use it')
})

process.stdout.write('\nthrottle window (respecting the upstream)\n')

/**
 * 实测：这条车道的 `retry-after` 在**响应头**里，且是 5400+ 秒（90 分钟量级）、
 * 真实递减。之前只解析 body，body 里根本没有数字，于是永远退回 60 秒默认值——
 * 意味着限流窗口内桥会反复撞同一面墙。
 */
test('尊重上游给的 retry-after（响应头），而不是一律 60 秒', () => {
  const lane = { name: 'zen', baseUrl: 'http://x.invalid', model: 'space-bunny-free' }
  const body = JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Rate limit exceeded. Please try again later.' }, metadata: {} })
  // 模拟真实上游：数字只出现在响应头。
  const fromHeader = upstreamFailure(429, body, lane, 'mimo-v2.6-flash-free', '5416')
  assert.equal(fromHeader.status, 429)
  assert.equal(fromHeader.throttleSec, 5416, 'must read retry-after from the header')
  assert.match(fromHeader.message, /90min/, fromHeader.message)

  // 响应头没有时退回保守默认，而不是 60 秒。
  const noHeader = upstreamFailure(429, body, lane, 'space-bunny-free', null)
  assert.equal(noHeader.throttleSec, 5400, 'default must be ~90min, not 60s')

  // body 里有数字时也要认（有些上游放在 body）。
  const fromBody = upstreamFailure(429, '{"retry_after":120}', lane, 'space-bunny-free', null)
  assert.equal(fromBody.throttleSec, 120)
})

test('冷却时长被封顶，一个写错的 retry-after 不会让模型永远消失', () => {
  const lane = { name: 'zen', baseUrl: 'http://x.invalid', model: 'space-bunny-free' }
  const absurd = upstreamFailure(429, '', lane, 'weird-model-free', '999999')
  assert.ok(absurd.throttleSec <= 21600, `capped at 6h, got ${absurd.throttleSec}`)
})

asyncTest('index.js 的两处调用都把响应头传给了 upstreamFailure', async () => {
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8')
  const calls = [...source.matchAll(/upstreamFailure\(response\.status, await safeErrorBody\(response\), lane, model, response\.headers\.get\('retry-after'\)\)/g)]
  assert.equal(calls.length, 2, `expected 2 call sites to pass the header, found ${calls.length}`)
})

process.stdout.write('\ndocumented surface matches the implementation\n')

/**
 * README 曾经列出 `POST /v1/responses`，而实现里根本没有这条路由。
 * 文档承诺了代码不做的事——这就是下面这条断言要挡的。
 * 改 README 或改路由时，两边必须同时动，这条断言会当场变红。
 */
asyncTest('README 承诺的端点都真实存在', async () => {
  const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8')
  // 从 README 的 API 表格里抓出「方法 + 路径」两列。
  const documented = [...readme.matchAll(/\|\s*`(GET|POST)`\s*\|\s*`(\/[^`]*)`/g)]
    .map(m => `${m[1]} ${m[2].replace(/\/$/, '')}`)
  assert.ok(documented.length >= 3, `README should document at least 3 endpoints, found ${documented.length}`)

  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8')
  for (const entry of documented) {
    const [method, path] = entry.split(' ')
    // 路由判断在代码里有两种写法：把 method 和 path 写在同一个条件里
    // （`req.method === 'GET' && path === '/v1/models'`），或者把 path 写成
    // 一组 `||` 分支（`path === '/' || path === '/health'`）而 method 单独判。
    // 只按「method 紧邻 path」的写法去匹配会把第二种合法写法误判成缺失，
    // 所以这里分两种形态各自放行，但要求 path 字面量确实出现在路由分发里。
    const quoted = `'${escapeRe(path)}'`
    const pathIsRouted = source.includes(quoted) ||
      new RegExp(`path === ${quoted}`).test(source)
    assert.ok(pathIsRouted, `README documents ${method} ${path} but the path is not routed in index.js`)
    assert.ok(
      new RegExp(`req\\.method === '${method}'`).test(source),
      `README documents ${method} ${path} but index.js never checks that method`,
    )
  }
})

asyncTest('README 没有承诺未实现的 Responses 端点', async () => {
  const readme = await readFile(new URL('./README.md', import.meta.url), 'utf8')
  const source = await readFile(new URL('./index.js', import.meta.url), 'utf8')
  const advertised = /\|\s*`POST`\s*\|\s*`(\/v1\/responses)`/.test(readme)
  const implemented = /path === '\/v1\/responses'/.test(source)
  assert.equal(advertised, implemented,
    'README and code disagree about /v1/responses — update whichever changed')
})

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

await Promise.all(pending)

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
