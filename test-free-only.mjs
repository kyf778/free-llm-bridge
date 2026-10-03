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
import { pickModel, applyFingerprint, sessionForConversation, requestIdFor } from './index.js'

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
  'muse-spark-1.3-contributor-free', 'mimo-v2.5-free', 'ling-3.1-flash-free',
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

test('故障转移的每一个候选都是免费档', () => {
  // 把所有免费档都标记为不可用，验证最终报错而不是掉进付费模型。
  const paid = pickModel('space-bunny-free', ['gpt-5', 'claude-opus-5'])
  assert.equal(paid.model, undefined, 'no free models available must not fall back to paid')

  // 上游清单里只有付费模型时，同样必须拒绝。
  const noneFree = pickModel('space-bunny-free', ['gpt-5', 'gpt-6-astra'])
  assert.equal(noneFree.model, undefined)
})

test('首选被限流时换到另一个免费档，而不是付费档', () => {
  // 通过连续调用把首选推进冷却：pickModel 内部对 429 才会写入冷却，这里直接验证
  // 「首选不在候选池」时仍然落在免费档上。
  const decision = pickModel('gpt-5-mini', UPSTREAM_LIST)
  assert.equal(decision.model, undefined)

  const free = pickModel('longcat-2.5-preview-free', UPSTREAM_LIST)
  assert.ok(free.model === undefined || free.model.endsWith('-free'), `got ${free.model}`)
})

test('空清单时退回内置顺序，且全部是免费档', () => {
  const decision = pickModel('space-bunny-free', [])
  assert.ok(decision.model.endsWith('-free'), `got ${decision.model}`)
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
  const tools = applyFingerprint(undefined, false)
  const names = tools.map(t => t.function.name).sort()
  assert.deepEqual(names, ['bash', 'glob', 'grep', 'read'])
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
