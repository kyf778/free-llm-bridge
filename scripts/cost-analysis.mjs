#!/usr/bin/env node
/**
 * 成本分析：把 Hindsight 真实的 LLM 调用量换算成钱，并与免费方案对比。
 *
 * 数据来自 Hindsight 自己的 `/llm-requests` 与 `/llm-requests/stats`——这是第一手证据，
 * 不是估算。脚本只读，不改任何东西。
 *
 * 用法：
 *   node scripts/cost-analysis.mjs [hindsightBaseUrl] [bankId]
 */

const HINDSIGHT = process.argv[2] || process.env.HINDSIGHT_URL || 'http://192.168.31.123:8888'
const BANK = process.argv[3] || process.env.HINDSIGHT_BANK || 'coding-agent::default-workspace'
const BANK_PATH = `${HINDSIGHT}/v1/default/banks/${encodeURIComponent(BANK)}`

/**
 * mimo-v2.6-flash 的价格（元 / 百万 token）。
 *
 * 来源见 REPORT.md 第九节与 hindsight 部署档案：输入 ¥1、缓存命中 ¥0.02、
 * 输出与思考输出 ¥2。**接入前请用你自己的账单核对这组数字** —— 它是按量计费，
 * 定价可能变，而下面所有结论都由它推导。
 */
const PRICE = {
  inputPerMTok: 1,
  cachedPerMTok: 0.02,
  outputPerMTok: 2,
}

function yuan(tokens, perMTok) {
  return (tokens / 1e6) * perMTok
}

function money(value) {
  return `¥${value.toFixed(2)}`
}

const stats = await fetch(`${BANK_PATH}/llm-requests/stats?period=7d&trunc=day`).then(r => r.json())

console.log(`bank: ${BANK}`)
console.log(`source: ${BANK_PATH}/llm-requests/stats`)
console.log(`\n=== 每天的真实用量 ===`)

let totalCost = 0
let totalTokens = 0
const rows = []
for (const bucket of stats.buckets) {
  const t = bucket.tokens ?? {}
  const input = t.input ?? 0
  const cached = t.cached ?? 0
  const output = t.output ?? 0
  const thoughts = t.thoughts ?? 0
  // 思考 token 是输出的子集，不要重复计费——它是按输出价收费的。
  const billableOutput = output
  const cost = yuan(input, PRICE.inputPerMTok) +
    yuan(cached, PRICE.cachedPerMTok) +
    yuan(billableOutput + thoughts, PRICE.outputPerMTok)
  totalCost += cost
  totalTokens += bucket.total ?? 0
  rows.push({ day: bucket.time.slice(0, 10), calls: bucket.total, input, cached, output, thoughts, cost })
  console.log(
    `${rows[rows.length - 1].day}  calls=${String(bucket.total).padStart(4)}  ` +
    `input=${(input / 1e6).toFixed(2)}M cached=${(cached / 1e6).toFixed(2)}M ` +
    `output=${((output + thoughts) / 1e6).toFixed(2)}M  => ${money(cost)}`,
  )
}

console.log(`\n=== 汇总 ===`)
console.log(`days        : ${rows.length}`)
console.log(`total calls : ${totalTokens}`)
console.log(`total cost  : ${money(totalCost)}`)
if (rows.length > 0) {
  const perDay = totalCost / rows.length
  console.log(`per day     : ${money(perDay)}`)
  console.log(`per month   : ${money(perDay * 30)}  (30 天)`)
  console.log(`per year    : ${money(perDay * 365)}`)
  console.log(`\n=== 改用免费车道之后 ===`)
  console.log(`per day     : ¥0.00`)
  console.log(`per month   : ¥0.00`)
  console.log(`per year    : ¥0.00`)
  console.log(`saved/year  : ${money(perDay * 365)}`)
}

console.log('\n=== 调用构成（最近 200 次）===')
const recent = await fetch(`${BANK_PATH}/llm-requests?limit=200`).then(r => r.json())
const list = recent.requests ?? recent.items ?? []
const byOp = new Map()
for (const row of list) {
  const key = row.operation ?? 'unknown'
  const acc = byOp.get(key) ?? { calls: 0, total: 0, input: 0, output: 0, thoughts: 0, model: '' }
  acc.calls += 1
  acc.total += row.total_tokens ?? 0
  acc.input += row.input_tokens ?? 0
  acc.output += row.output_tokens ?? 0
  acc.thoughts += row.thoughts_tokens ?? 0
  acc.model = row.model ?? acc.model
  byOp.set(key, acc)
}
console.log(`model: ${list[0]?.model ?? 'unknown'}   provider: ${list[0]?.provider ?? 'unknown'}`)
console.log(`\n${'operation'.padEnd(24)}${'calls'.padStart(6)}${'tokens'.padStart(12)}${'avg/call'.padStart(10)}${'share'.padStart(8)}`)
for (const [op, acc] of [...byOp].sort((a, b) => b[1].calls - a[1].calls)) {
  const share = (acc.calls / list.length) * 100
  const avg = acc.calls === 0 ? 0 : Math.round(acc.total / acc.calls)
  console.log(`${op.padEnd(24)}${String(acc.calls).padStart(6)}${String(acc.total).padStart(12)}${String(avg).padStart(10)}${`${share.toFixed(0)}%`.padStart(8)}`)
}

console.log(`\n注意：思考 token 按输出价计费，所以上面的「token 总量」不是唯一的成本指标——`)
console.log(`一个平均 token 很多但思考占比高的 operation，实际花钱可能不成比例地多。`)
