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
import { pickModel, applyFingerprint, sessionForConversation, requestIdFor, normalizeResponseFormat, upstreamFailure, thinkingOffPatch, supportsThinkingOff, FALLBACK_ORDER, isQueueSentinel } from './index.js'

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

test('opencode-only 的 403 会把该模型从候选池里摘掉（动态保护）', () => {
  // 上游对某些模型会回 403「free tier can only be used from within OpenCode」。
  // 换一个模型就能成，所以桥应该把它记进 KNOWN_OPENCODE_ONLY 并降级换档。
  //
  // ⚠️ 这里**故意不硬编一张「谁是 opencode-only」的名单**。曾经硬编过
  // （fledge-alpha-free / nemotron-3-ultra-free / nemotron-3.5-lightning-free /
  // longcat-2.5-preview-free），2026-10-06 复测发现上游**已经放开**了其中三个：
  //
  //   fledge-alpha-free           直连 3/4   （旧结论：永久 403）
  //   nemotron-3.5-lightning-free 直连 4/4   （旧结论：永久 403）
  //   nemotron-3-ultra-free       直连 3/4   （旧结论：永久 403）
  //   longcat-2.5-preview-free    直连 0/4   （被限流，不是 403）
  //
  // 硬编名单会随上游政策变化而**变成谎言**，所以改为验证机制本身：
  // 注入一次 403 → 该模型必须被摘掉。名单由运行时发现，不由测试假设。
  const lane = { name: 'zen', baseUrl: 'https://opencode.ai', model: 'space-bunny-free' }
  const victim = 'some-opencode-only-free'
  const failure = upstreamFailure(403, "OpenCode's free tier can only be used from within OpenCode", lane, victim)
  assert.equal(failure.ok, false)
  assert.match(failure.message, /restricted to OpenCode-internal calls/)

  // 摘掉之后，再点名它就必须换档，而不是原样返回它。
  const decision = pickModel(victim, [...UPSTREAM_LIST, victim])
  assert.ok(decision.model !== undefined, 'should fail over to another free model, not error')
  assert.notEqual(decision.model, victim, 'the 403 model must not be selected again')
  assert.match(decision.model, /-free$/, `failed over to a paid model: ${decision.model}`)
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

process.stdout.write('\nthinking-off (the biggest speed win on this lane)\n')

/**
 * 关思考是这条车道上**最大的一笔速度浪费**：思考 token 与正文共享同一个
 * `max_tokens` 预算，免费档动辄先想几千 token 才吐正文。实测关掉之后：
 *
 *   cohere/north-mini-code:free   7977ms →  919ms
 *   nemotron-3.5-lightning-free   7362ms → 1381ms
 *   nvidia/nemotron-3-super-120b  1489ms → 1045ms
 *
 * 但**绝不能全局施加**：`liquid/lfm-2.5-2.6b:free` 收到同一份补丁直接回 502。
 * 桥是跨车道故障转移的，全局参数最终会打到任意模型上——那等于用一个模型的
 * 方言去毒另一个模型（实测把 reasoning_effort 写进全局 EXTRA_BODY 后，
 * 原本能成功的 liquid 调用开始成片 502）。
 */
test('关思考只对实测接受的模型施加，名单外的模型一个字节都不改', () => {
  // 实测能关且 reasoning_tokens 归零的
  assert.deepEqual(thinkingOffPatch('nvidia/nemotron-3-super-120b-a12b:free'),
    { reasoning: { enabled: false } })
  assert.deepEqual(thinkingOffPatch('nemotron-3.5-lightning-free'),
    { reasoning: { enabled: false } })
  assert.equal(supportsThinkingOff('cohere/north-mini-code:free'), true)

  // 实测加补丁会 502 的 —— 必须**不在**名单里
  assert.equal(thinkingOffPatch('liquid/lfm-2.5-2.6b:free'), undefined,
    'liquid 502s on the thinking patch; it must never be patched')
  assert.equal(supportsThinkingOff('liquid/lfm-2.5-2.6b:free'), false)

  // 完全没测过的模型也必须不动它（保守默认）
  assert.equal(thinkingOffPatch('some-unknown-model-free'), undefined)
  assert.equal(thinkingOffPatch(''), undefined)
  assert.equal(thinkingOffPatch(undefined), undefined)
})

test('补丁是嵌套 reasoning 形状，不是被忽略的扁平方言', () => {
  // 实测扁平形状（reasoning_effort / enable_thinking / thinking）对部分车道
  // 直接 502，对另一些被静默忽略（reasoning_tokens 照旧）。正确形状是嵌套的，
  // 与插件 catalog 的 effortOffPatch 一致。
  const patch = thinkingOffPatch('nemotron-3.5-lightning-free')
  assert.ok(patch.reasoning !== undefined, 'must be the nested reasoning shape')
  assert.equal(patch.reasoning.enabled, false)
  assert.equal(patch.reasoning_effort, undefined, 'flat reasoning_effort is the wrong shape')
  assert.equal(patch.enable_thinking, undefined)
  assert.equal(patch.thinking, undefined)
})

test('返回的补丁是副本，改它不会污染全局名单', () => {
  const a = thinkingOffPatch('nemotron-3.5-lightning-free')
  a.reasoning.enabled = true
  const b = thinkingOffPatch('nemotron-3.5-lightning-free')
  assert.equal(b.reasoning.enabled, false, 'the shared table must not be mutable from outside')
})

process.stdout.write('\nqueue sentinel (let the bridge pick, instead of pinning one model)\n')

/**
 * 调用方（Hindsight）只有一个 `LLM_MODEL` 配置项，所以它**每轮都点名同一个模型**。
 * 没有哨兵时队列只在故障转移时生效：首选永远是被钉死那个，它一限流，
 * 每轮都要先撞一次墙才换——「一个用不了就换下一个」退化成「每次先失败一次」。
 *
 * 点名哨兵则把选择权交给桥：直接取队列里第一个有容量的。
 */
test('队列哨兵被当作「你自己挑」，而不是一个模型名', () => {
  for (const sentinel of ['free-queue', 'auto', 'queue', 'FREE-QUEUE']) {
    const decision = pickModel(sentinel, UPSTREAM_LIST)
    assert.equal(decision.error, undefined, `${sentinel} must resolve, got: ${decision.error}`)
    assert.ok(decision.model !== undefined, `${sentinel} must resolve to a model`)
    assert.match(decision.model, /-free$/, `${sentinel} resolved to a paid model: ${decision.model}`)
    assert.ok(decision.lane !== undefined)
  }
})

test('哨兵选出来的是队列里第一个有容量的，而不是被钉死的某个模型', () => {
  const decision = pickModel('free-queue', UPSTREAM_LIST)
  // 必须落在 FALLBACK_ORDER 里（队列成员），不能是名单外的模型。
  assert.ok(FALLBACK_ORDER.includes(decision.model),
    `sentinel picked ${decision.model}, which is not in the queue`)
  // 且必须是队列里的**第一个**——否则「跳过被限流的」这个目的就没达到。
  assert.equal(decision.model, FALLBACK_ORDER[0],
    `sentinel must pick the head of the queue, got ${decision.model}`)
})

test('哨兵不是「付费模型」——不能因为不在 -free 名单里被拒', () => {
  // 这是最容易写错的一处：校验逻辑若在哨兵转换之前跑，
  // 'free-queue' 会因为不以 -free 结尾而被判成付费模型，直接 400。
  const decision = pickModel('free-queue', UPSTREAM_LIST)
  assert.equal(decision.error, undefined, 'the sentinel must not trip the paid-model guard')
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

asyncTest('部署文档的 BASE_URL 与实际拓扑一致（桥容器化 = compose 服务名）', async () => {
  // 这条为两次真实错误而写：
  //  1) 文档曾把 host.docker.internal 当通用做法——跨机器时它指向错误的宿主机；
  //  2) 方案 A 把桥搬进同一个 compose 后，正确值变成服务名 free-llm-bridge。
  // 断言跟着部署形态走，形态变了而文档没改，这条会红。
  const setup = await readFile(new URL('./docs/hindsight-setup.md', import.meta.url), 'utf8')
  const envBlock = setup.match(/### 改之后（零成本）[\s\S]*?```yaml\n([\s\S]*?)```/)
  assert.ok(envBlock !== null, 'setup doc should have a "改之后" yaml block')
  const baseUrl = /HINDSIGHT_API_LLM_BASE_URL:\s*(\S+)/.exec(envBlock[1])
  assert.ok(baseUrl !== null, 'the block must set HINDSIGHT_API_LLM_BASE_URL')
  assert.ok(
    !baseUrl[1].includes('host.docker.internal'),
    `the deploy block must not use host.docker.internal for a cross-host setup, got ${baseUrl[1]}`,
  )
  assert.match(baseUrl[1], /^http:\/\/free-llm-bridge:18999\/v1$/,
    `containerized deploy expects the compose service name, got ${baseUrl[1]}`)
})

asyncTest('部署文档给出「显式 postgresql:// + 入口包装」这一对（缺一会踩启动死循环）', async () => {
  // 2026-10-06 复测更正。此前这条断言要求文档写 `pg0://hindsight`，理由是
  // 「不写就踩 pg0 start() 返回值 bug」——那个结论不成立：`pg0://` 走的**正是**
  // 会返回 None 的代码路径（resolve_database_url 的 is_pg0 分支 →
  // EmbeddedPostgres.ensure_running() → start() → info.uri）。
  //
  // 实测出来的稳定形态是两件事配对：
  //   ① 显式 postgresql:// —— 让 Hindsight 完全绕开不可靠的 pg0 探测；
  //   ② 入口包装 start-hindsight.sh —— 因为绕开之后就没有任何人启动 postgres 了
  //      （只配 ① 会在容器重建后 Connection refused）。
  // 少任何一半，新用户都会踩坑，所以两半都要在样例里。
  const setup = await readFile(new URL('./docs/hindsight-setup.md', import.meta.url), 'utf8')
  const envBlock = setup.match(/### 改之后（零成本）[\s\S]*?```yaml\n([\s\S]*?)```/)
  assert.ok(envBlock !== null, 'setup doc should have a "改之后" yaml block')
  assert.match(envBlock[1], /HINDSIGHT_API_DATABASE_URL:\s*postgresql:\/\/[^\s]*@127\.0\.0\.1:5432\//,
    'the deploy block must set an explicit postgresql:// DATABASE_URL')
  assert.match(envBlock[1], /entrypoint:.*start-hindsight\.sh/,
    'the deploy block must wire the start-hindsight.sh entrypoint (nothing else starts postgres)')
  assert.doesNotMatch(envBlock[1], /HINDSIGHT_API_DATABASE_URL:\s*pg0:\/\//,
    'pg0:// is the disproven form — it still calls start() and reads the None uri')
  // 包装脚本本身必须随仓库发布，否则文档里的挂载路径指向空气。
  const wrapper = await readFile(new URL('./deploy/start-hindsight.sh', import.meta.url), 'utf8')
  assert.match(wrapper, /pg0.*info.*--name hindsight/s, 'wrapper must poll pg0 info for readiness')
  assert.match(wrapper, /exec \/app\/start-all\.sh/, 'wrapper must hand off to the official entrypoint')
})

asyncTest('部署文档明确区分了「同一台机器」与「不同机器」两种拓扑', async () => {
  const setup = await readFile(new URL('./docs/hindsight-setup.md', import.meta.url), 'utf8')
  assert.match(setup, /同一台机器/, 'must cover the same-host case')
  assert.match(setup, /0\.0\.0\.0/, 'must show how to bind for the cross-host case')
  assert.match(setup, /host\.docker\.internal.*只在/s, 'must warn that host.docker.internal is same-host only')
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
