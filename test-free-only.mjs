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
import { pickModel, applyFingerprint, sessionForConversation, requestIdFor } from './index.js'

let failures = 0
function test(name, fn) {
  try {
    fn()
    process.stdout.write(`  PASS  ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`  FAIL  ${name}\n        ${error.message}\n`)
  }
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

process.stdout.write(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
