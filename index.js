#!/usr/bin/env node
/**
 * free-llm-bridge — 用一条免密公开车道，把任意 OpenAI 兼容应用接到零成本 LLM 上。
 *
 * 解决的问题很具体：Hindsight 这样的记忆系统有 4 个 LLM 调用环节（提取 / 整理 /
 * 知识页刷新 / 反思），每轮对话后自动跑，商业 API 按 token 计费，两天烧掉八块。
 * 而「Our Free Model」插件已经证明：存在**公开、免密、无需注册**的免费 LLM 车道
 * （OpenCode Zen 网关），任何工具都能直接调。
 *
 * 本项目不重复造轮子，而是把那条车道封装成一个**独立于任何宿主应用运行**的
 * OpenAI 兼容转发服务：NAS 上的 Hindsight、宿主机上的其它工具都能直接用。
 *
 * 为什么不用「Our Free Model」插件自带的转发端口：
 *
 *   1. 那个端口活在 DSH 进程里。DSH 一关，免费额度就没了。
 *   2. 那个端口只在本机回环（127.0.0.1），NAS 上的容器根本够不着。
 *
 * 所以这是一个 **零依赖、单文件、Node.js 内置模块** 的小服务：
 *
 *   - 认证 `Authorization: Bearer public`（这条车道不需要你的任何密钥）
 *   - 按模型分流到 `/chat/completions` 与 `/responses` 两种线协议
 *   - 满足免费车道的「工具指纹门」：声明 bash/glob/grep/read 四件套
 *   - **会话亲和**：同一使用方映射到同一上游 session，让免费额度按会话计而不是按请求计
 *   - 429 限流退避 + 模型自动故障转移（一个模型被限流自动换下一个）
 *   - `GET /v1/models` 返回上游实测可达的模型清单
 *
 * 用法：
 *
 *   node index.js                            # 监听 127.0.0.1:18999
 *   node index.js --port 19000               # 换端口
 *   HOST=0.0.0.0 node index.js               # 让 NAS 上的容器也能用
 *   node index.js --model space-bunny-free   # 指定默认模型
 *
 * 然后在任意 OpenAI 兼容应用的配置里填：
 *
 *   base_url = http://<bridge>:18999/v1
 *   api_key  = 任意非空字符串（本地自用，桥忽略它）
 *   model    = space-bunny-free
 *
 * @module index.js
 */

import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))

const HOST = String(process.env.HOST || args.host || '127.0.0.1').trim() || '127.0.0.1'
const PORT = Number(process.env.PORT || args.port || 18999)

/** 上游车道。默认是 OpenCode Zen —— Our Free Model 插件逆向出来的唯一来源。 */
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || 'https://opencode.ai').replace(/\/+$/, '')

/**
 * 兜底模型顺序：首选被限流时沿这条线往下找。
 *
 * 顺序按 2026-10-05 逐个直连实测排定，见 scripts/probe-free-models.mjs：
 *
 *   space-bunny-free            ✅ 可用，且不带任何指纹头也能用
 *   mimo-v2.6-flash-free        ⚠️ 429 限流——模型本身能用，只是被打满
 *   deepseek-v4-flash-free      ⚠️ 同上
 *   ling-3.0-flash-fin-free     ⚠️ 同上
 *   ling-3.1-flash-free         ⚠️ 同上
 *   mimo-v2.5-free              ⚠️ 同上
 *   jev-1.13-free               ❌ 500
 *
 * 这几个被**排除**在顺序之外，因为它们对第三方调用一律 403
 * `FreeTierError: OpenCode's free tier can only be used from within OpenCode`——
 * 换过去只是把同一个失败换个模型名重演一遍，白等一个 RTT：
 *   longcat-2.5-preview-free, nemotron-3-ultra-free,
 *   nemotron-3.5-lightning-free, fledge-alpha-free
 * 对照实验：space-bunny-free 不带 x-opencode-* 也能成功，所以这不是请求头问题，
 * 是上游对那几个模型按来源做了硬限制。
 */
const FALLBACK_ORDER = [
  'space-bunny-free',
  'mimo-v2.6-flash-free',
  'deepseek-v4-flash-free',
  'ling-3.0-flash-fin-free',
  'ling-3.1-flash-free',
  'mimo-v2.5-free',
]

/** 已被实测判定在 CN 出口不可用的模型，跳过探测以免每次启动都烧配额。 */
const KNOWN_REGION_BLOCKED = new Set([
  'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free',
])

/**
 * 已实测对第三方调用一律 403 的模型——上游写明「free tier can only be used from
 * within OpenCode」。把它们从候选池里彻底去掉：留着只会让故障转移把同一个失败
 * 换个模型名再演一遍，每换一次白等一个 RTT。
 *
 * 与 `KNOWN_REGION_BLOCKED` 分开记，因为成因不同（地区 vs 调用来源），
 * 万一上游放开限制，只需要动这一个集合。
 */
const KNOWN_OPENCODE_ONLY = new Set([
  'longcat-2.5-preview-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'fledge-alpha-free',
])

/**
 * 是不是免费模型。
 *
 * 上游 `/zen/v1/models` 返回的是**全部** 86 个模型，其中绝大多数是按量计费的付费档
 * （`gpt-5`、`claude-opus-5`、`mimo-v2.6-flash`……）。桥的整个存在意义是「零成本」，
 * 所以候选池必须硬性排除它们——否则一次故障转移就会把账单接回去，而用户根本不会知道
 * 自己为什么突然开始花钱。
 *
 * 判定用后缀 `-free`，与上游自己的命名一致（`space-bunny-free`、`mimo-v2.6-flash-free`
 * ……）。后缀缺失的老模型一律当作付费，不进池子；宁可少一个候选，也不误接一个账单。
 */
function isFreeModel(model) {
  return typeof model === 'string' && model.trim().toLowerCase().endsWith('-free')
}

/** 上游按 User-Agent 判版本，必须 >= 1.17。 */
const CLIENT_UA = 'opencode/1.18.31'

/**
 * 免费车道要求请求里声明这四个工具名，否则 403 FreeTierError。
 * 纯批处理没有真实工具，于是发自禁用的诱饵：模型即使去调，返回也不可用。
 */
const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read']

const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 上游超时。免费车道思考期可能静默很久，这里给足。 */
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 600000)

/** 每个模型的限流退避：被 429 后暂停到这个时刻。 */
const COOLDOWN_UNTIL = new Map()

/** 启动时从上游探测到的可达模型。 */
const availableModels = []

// ---------------------------------------------------------------------------
// 会话亲和 —— 免费额度按会话计，这是能持续白嫖的关键
// ---------------------------------------------------------------------------

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

function base62(bytes) {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

/**
 * 把一个下游使用方映射到稳定的、符合上游形状的上游 session id。
 *
 * 为什么这一步是整个项目最关键的几行代码：
 *
 * 免费车道按 **session** 计免费额度。如果每次请求都现造一个新 session，上游看到的就是
 * 「同一个客户端一瞬间开了成百上千个新会话」，判定为滥用，立刻回 429
 * FreeUsageLimitError。这正是第一次直接 curl 上游时撞到的：每次请求一个随机 session
 * 连发两次，连本该好用的 `mimo-v2.6-flash-free` 都被限流。
 *
 * 换成「同一使用方长期稳定映射到同一上游 session」之后，上游看到的是一个正常的长会话，
 * 配额自然不会被立刻打爆。
 *
 * @param {string} downstreamKey 标识「同一个使用方」：下游 session/conversation id，
 *   或请求头里的固定标识；缺省时由调用方用远端地址兜底。
 * @returns {string} 符合 `ses_<12hex><14base62>` 形状的 session id
 */
export function sessionForConversation(downstreamKey) {
  const seed = typeof downstreamKey === 'string' && downstreamKey.trim() !== '' ? downstreamKey.trim() : 'global'
  // 种子含 host:port，避免本机桥与其它使用方共用同一上游 session —— 上游 session 是
  // 全局记额的，多个使用方挤在同一个 session 上会互相把对方撞进 429。
  const digest = crypto.createHash('sha256').update(`free-llm-bridge\0${HOST}:${PORT}\0${seed}`).digest()
  return `ses_${digest.subarray(0, 6).toString('hex')}${base62(digest.subarray(6, 20))}`
}

export function ensureSession(seed) {
  const id = sessionForConversation(seed)
  return SESSION_RE.test(id) ? id : `ses_${crypto.randomBytes(14).toString('hex').slice(0, 26)}`
}

/** 同一回合的重试必须共用 request id，否则上游把重试当成新回合再计一次。 */
export function requestIdFor(session, turnSeed) {
  if (typeof turnSeed !== 'string' || turnSeed === '') {
    return `msg_${crypto.randomBytes(14).toString('hex').slice(0, 26)}`
  }
  const digest = crypto.createHash('sha256').update(`free-llm-bridge-req\0${session}\0${turnSeed}`).digest()
  const id = `msg_${digest.subarray(0, 6).toString('hex')}${base62(digest.subarray(6, 20))}`
  return REQUEST_RE.test(id) ? id : `msg_${crypto.randomBytes(14).toString('hex').slice(0, 26)}`
}

// ---------------------------------------------------------------------------
// 上游请求
// ---------------------------------------------------------------------------

function gatewayHeaders({ session, requestId, stream }) {
  return {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'desktop',
    'x-opencode-session': session,
    'x-opencode-request': requestId,
    'x-opencode-project': 'global',
    accept: stream ? 'text/event-stream' : '*/*',
  }
}

function isResponsesModel(model) {
  return /^muse[-_]?spark/i.test(model)
}

function endpointFor(model) {
  return isResponsesModel(model) ? '/zen/v1/responses' : '/zen/v1/chat/completions'
}

/**
 * 满足工具指纹门：把下游真实工具规范化到四个小写名，缺的用自禁诱饵补上。
 *
 * 规范化而不是并列，是因为上游会拒绝 `Bash` + `bash` 这类大小写重复声明。
 *
 * @param {Array} tools 下游声明的工具
 * @param {boolean} style true 为 Responses 的扁平工具形状，false 为 Chat 的 function 包装
 * @returns {Array} 满足指纹门的工具列表
 */
export function applyFingerprint(tools, style) {
  const flat = style === true
  const out = []
  const seen = new Set()

  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool?.function?.name ?? tool?.name
    if (typeof name !== 'string' || name.trim() === '') { out.push(tool); continue }
    const key = FINGERPRINT_TOOLS.includes(name.trim().toLowerCase()) ? name.trim().toLowerCase() : ''
    if (key === '') { out.push(tool); continue }
    if (seen.has(key)) continue
    const fn = tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function) ? tool.function : null
    seen.add(key)
    out.push(fn ? { ...tool, function: { ...fn, name: key } } : { ...tool, name: key })
  }

  // 纯批处理没有真实工具可用，四个槽位全部用自禁诱饵填。
  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue
    out.push(flat
      ? { type: 'function', name, description: 'This tool is currently unavailable and must not be used.', input_schema: { type: 'object', properties: {} } }
      : { type: 'function', function: { name, description: 'This tool is currently unavailable and must not be used.', parameters: { type: 'object', properties: {} } } })
  }
  return out
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { statusCode: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function openAiError(res, status, type, message) {
  json(res, status, { error: { message, type, param: null, code: null } })
}

function log(...parts) {
  process.stderr.write(`[free-llm-bridge] ${parts.join(' ')}\n`)
}

// ---------------------------------------------------------------------------
// 限流状态与故障转移
// ---------------------------------------------------------------------------

export function inCooldown(model) {
  const until = COOLDOWN_UNTIL.get(model)
  return until !== undefined && until > Date.now()
}

function markThrottled(model, retryAfterSec) {
  const backoff = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : 60
  COOLDOWN_UNTIL.set(model, Date.now() + backoff * 1000)
}

function cooldownRemainingSec(model) {
  const until = COOLDOWN_UNTIL.get(model)
  if (until === undefined || until <= Date.now()) return 0
  return Math.ceil((until - Date.now()) / 1000)
}

/**
 * 算出这一次该用哪个模型。
 *
 * 只返回免费档：候选池先按 `-free` 后缀过滤，再去掉地区受限的。首选被限流就沿
 * FALLBACK_ORDER 往下找第一个不在冷却中的；点名的付费模型与地区受限模型都如实拒绝，
 * 绝不静默改投。
 *
 * @param {string} requested 下游点名的模型，空串表示「你自己挑」
 * @param {string[]} available 上游实测可达的模型
 * @returns {{model: string}|{error: string}} 要用的模型，或一条如实说明为什么不能用
 */
export function pickModel(requested, available) {
  // 候选池先按「免费」过滤，再去掉地区受限与 opencode-only 的。这是防止把账单
  // 接回去的最后一道闸：任何非 `-free` 的模型都不得进入候选，哪怕它此刻可用。
  const pool = (available.length > 0 ? available : FALLBACK_ORDER)
    .filter(model => isFreeModel(model) && !KNOWN_REGION_BLOCKED.has(model) && !KNOWN_OPENCODE_ONLY.has(model))

  // 下游点名了付费模型：如实拒绝，并说明只有免费档可用。静默改投别的模型会让调用方
  // 以为自己用的就是它点名的那个模型，而实际跑的完全是另一回事。
  if (requested !== '' && !isFreeModel(requested)) {
    return { error: `model "${requested}" is not a free-lane model; this bridge only serves models whose id ends in "-free"` }
  }
  if (requested !== '' && KNOWN_REGION_BLOCKED.has(requested)) {
    return { error: `model "${requested}" is region-blocked from this network egress` }
  }
  if (requested !== '' && KNOWN_OPENCODE_ONLY.has(requested)) {
    // 这几个模型上游只放行来自 OpenCode 自身的请求，换档有用，所以降级成换模型而不是报错。
    const alternative = pickModel('', pool)
    if (alternative.model !== undefined) {
      log(`routing ${requested} -> ${alternative.model} (upstream restricts ${requested} to OpenCode-internal calls)`)
      return alternative
    }
    return { error: `model "${requested}" is restricted to OpenCode-internal calls, and no alternative free model is available` }
  }
  if (requested !== '' && pool.includes(requested) && !inCooldown(requested)) {
    return { model: requested }
  }

  for (const candidate of FALLBACK_ORDER) {
    if (requested !== '' && candidate === requested) continue
    if (pool.includes(candidate) && !inCooldown(candidate)) return { model: candidate }
  }
  for (const candidate of pool) {
    if (candidate === requested) continue
    if (!inCooldown(candidate)) return { model: candidate }
  }
  return { error: 'all free models are currently rate limited' }
}

function retryAfterOf(text) {
  const match = /"retry[-_]?after"\s*:\s*"?(\d+)/i.exec(String(text ?? ''))
  return match === null ? undefined : Number(match[1])
}

/** 把上游的一次失败翻译成下游能理解的形状，同时更新限流状态。 */
export function upstreamFailure(status, detail, model) {
  const text = String(detail ?? '')
  if (status === 429 || /FreeUsageLimitError/.test(text)) {
    markThrottled(model, retryAfterOf(text))
    return { ok: false, status: 429, type: 'rate_limit_error', message: `upstream rate limit on ${model}` }
  }
  // 「只能从 OpenCode 内部使用」：换模型有用，所以和 429 一样在桥内部换档。
  if (status === 403 && /only be used from within OpenCode/i.test(text)) {
    KNOWN_OPENCODE_ONLY.add(model)
    return { ok: false, status: 403, type: 'invalid_request_error', message: `model ${model} is restricted to OpenCode-internal calls` }
  }
  if (status === 403 && /region/i.test(text)) {
    KNOWN_REGION_BLOCKED.add(model)
    return { ok: false, status: 403, type: 'invalid_request_error', message: `model ${model} is not available in this region` }
  }
  if (status === 404 || /Model is unavailable/i.test(text)) {
    return { ok: false, status: 404, type: 'not_found_error', message: `model ${model} is not routed by the upstream` }
  }
  return { ok: false, status: 502, type: 'server_error', message: `upstream error ${status}: ${text.slice(0, 200)}` }
}

async function safeErrorBody(response) {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 补全
// ---------------------------------------------------------------------------

/**
 * 把下游的 `response_format` 规整成免费车道能接受的形状。
 *
 * ## 为什么需要这一步
 *
 * Hindsight 的 retain 靠 `response_format` 拿结构化 JSON，它的
 * `FactExtractionResponse` schema 里有 4 个 nullable 字段（`occurred_start`、
 * `occurred_end`、`causal_relations`、`from_attachments`），写法是 JSON Schema 的
 * 联合类型 `{"type": ["string", "null"]}`。
 *
 * 实测（2026-10-05，逐项二分定位）：免费车道的语法引擎**拒绝联合类型**，
 * 原样转发会拿到 400 `invalid_request_error`——也就是 retain 每轮都失败。
 * 同一套 schema 里 enum、嵌套对象数组、`const` 都被接受，唯独联合类型不行。
 *
 * 另有一个更隐蔽的坑：**`json_schema` 不带 `strict` 时，车道回 200 但 content 是
 * 空字符串**。这不是报错，是静默失败——retain 会「成功」地抽取出零条事实。
 * 所以这里总是把 `strict` 打开，让语法引擎接管生成。
 *
 * ## 怎么改
 *
 * 联合类型降级成不带 null 的那个非 null 类型。字段在 Hindsight 里本来就有对应的
 * 缺省语义（`occurred_*` 不给就是「无日期」，`causal_relations` 不给就是「无因果」），
 * 少一个键与给一个 null 键在这套 schema 里是等价的。
 *
 * @param {object|undefined} format 下游发来的 response_format
 * @returns {object|undefined} 规整后的 response_format；无可用字段时返回 undefined
 */
export function normalizeResponseFormat(format) {
  if (format === undefined || format === null) return undefined
  if (format.type === 'json_object') return format
  if (format.type !== 'json_schema' || format.json_schema?.schema === undefined) {
    return format
  }
  return {
    type: 'json_schema',
    json_schema: {
      ...format.json_schema,
      schema: stripNullableUnions(format.json_schema.schema),
      // 总是强制 strict：不带它时车道会回空 content，那比 400 更难查。
      strict: true,
    },
  }
}

/**
 * 递归剥掉 schema 里的 nullable 联合类型。
 *
 * 只处理「联合里恰好有一个 null」这一种——那是可空字段的惯用写法。
 * 出现多个非 null 分支（`["string","number"]`）时不做处理，交给上游自己报错：
 * 在那里静默挑一个分支会产出与调用方预期不符的类型，比一次明确的 400 更糟。
 *
 * @param {*} node schema 的任意节点
 * @returns {*} 处理后的节点；不可处理时原样返回
 */
function stripNullableUnions(node) {
  if (Array.isArray(node)) return node.map(stripNullableUnions)
  if (node === null || typeof node !== 'object') return node

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && Array.isArray(value)) {
      const nonNull = value.filter(entry => entry !== 'null')
      if (nonNull.length === 1 && nonNull.length !== value.length) {
        out.type = nonNull[0]
        continue
      }
    }
    out[key] = stripNullableUnions(value)
  }
  // 空 object 节点（如 `properties: {}`）保持原样即可。
  return out
}

/**
 * 跑完一整轮补全。
 *
 * 首选模型被限流时在这里**内部**换到下一个免费档重试，而不是把 429 透给调用方。
 * 这一步是必须的：soak 测试第一轮就是这么暴露问题的——`mimo-v2.6-flash-free` 被限流，
 * 429 直接返回给了调用方，而调用方（Hindsight）会把它当成一次失败并重试整轮，
 * 于是同一个回合又去撞一次限流。桥在这里就换掉，比让调用方失败一轮再回来划算得多。
 *
 * @param {string} model 已由 pickModel 选定的模型
 * @param {object} body 下游的 OpenAI 请求体
 * @param {{session: string, requestId: string}} ids 已铸好的上游身份
 * @returns {Promise<object>} `{ok:true, payload, model}` | `{ok:'stream', response, model}` |
 *   `{ok:false, status, type, message}`
 */
async function complete(model, body, ids) {
  const flat = isResponsesModel(model)
  const responseFormat = normalizeResponseFormat(body.response_format)
  const payload = { ...body, model, tools: applyFingerprint(body.tools, flat) }
  if (responseFormat !== undefined) payload.response_format = responseFormat
  else delete payload.response_format

  if (body.stream === true) {
    const response = await fetchUpstream(model, payload, ids, true)
    if (!response.ok) return upstreamFailure(response.status, await safeErrorBody(response), model)
    // 上游在高负载下会用 application/json 的 content-type 回一整套 SSE 帧。
    // 信 header 会把整条流读成字符串、JSON.parse 失败、整轮报废。读法是按 body 形状分流。
    const contentType = String(response.headers.get('content-type') ?? '')
    if (contentType.includes('application/json')) {
      const parsed = await response.json().catch(() => null)
      if (parsed !== null) return { ok: true, payload: parsed, model }
    }
    return { ok: 'stream', response, model }
  }

  const response = await fetchUpstream(model, payload, ids, false)
  if (response.ok) {
    const parsed = await response.json().catch(() => null)
    if (parsed === null) return { ok: false, status: 502, type: 'server_error', message: 'upstream returned a non-JSON body' }
    // 免费车道的正常收尾会带一个 `cost` 字段（见插件的逐帧抓包记录：`{"choices":[],"cost":"0"}`）。
    // 上游哪天把这个车道改成计费的，这里会第一个看见——如实记下来，而不是静默收下。
    const cost = parsed?.cost
    if (cost !== undefined && cost !== null && String(cost) !== '0') {
      log(`WARNING: upstream reported cost=${cost} on a free-lane model — the lane may no longer be free`)
    }
    return { ok: true, payload: parsed, model }
  }

  const failure = upstreamFailure(response.status, await safeErrorBody(response), model)
  // 限流与 opencode-only 都值得在桥内部换模型重试一次：这两个是「换个模型就能成」，
  // 而地区门与「模型没被路由」换模型也解决不了，重试只是把同一个错误再问一遍。
  const worthFailover = failure.status === 429 ||
    (failure.status === 403 && KNOWN_OPENCODE_ONLY.has(model))
  if (!worthFailover) return failure

  const next = pickModel('', availableModels).model
  if (next === undefined || next === model) return failure
  log(`${model} unusable (${failure.status}); retrying on ${next}`)
  return complete(next, body, ids)
}

async function fetchUpstream(model, payload, ids, stream) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    return await fetch(`${UPSTREAM_BASE}${endpointFor(model)}`, {
      method: 'POST',
      headers: gatewayHeaders(ids, stream),
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  void handle(req, res).catch(error => {
    log('request failed:', error?.message ?? error)
    if (!res.headersSent) {
      const status = Number(error?.statusCode)
      const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
      openAiError(res, code, code === 500 ? 'server_error' : 'invalid_request_error', String(error?.message ?? error))
    } else {
      res.end()
    }
  })
})

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-api-key, x-session-id, x-request-id',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
    })
    res.end()
    return
  }

  if (path === '/' || path === '/health') {
    json(res, 200, {
      ok: true,
      service: 'free-llm-bridge',
      upstream: UPSTREAM_BASE,
      models: availableModels.length,
      uptimeSec: Math.floor(process.uptime()),
    })
    return
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    json(res, 200, { object: 'list', data: modelRows() })
    return
  }

  if (!(req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions'))) {
    openAiError(res, 404, 'not_found_error', `no route for ${req.method} ${path}`)
    return
  }

  const body = await readBody(req)
  const requested = String(body.model ?? '').trim()
  if (requested === '') {
    openAiError(res, 400, 'invalid_request_error', '`model` is required')
    return
  }

  const session = ensureSession(downstreamSessionKey(req))
  const requestId = requestIdFor(session, downstreamTurnSeed(req, body))
  const decision = pickModel(requested, availableModels)

  // 点名了付费模型、或全部免费模型都在冷却：如实回错，绝不静默改投付费档。
  if (decision.error !== undefined) {
    if (requested !== '' && !isFreeModel(requested)) {
      openAiError(res, 400, 'invalid_request_error', decision.error)
      return
    }
    const waits = availableModels.filter(isFreeModel).map(cooldownRemainingSec).filter(sec => sec > 0)
    const soonest = waits.length > 0 ? Math.min(...waits) : 60
    res.writeHead(429, { 'retry-after': String(soonest), 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: {
        message: `${decision.error}; retry in ${soonest}s, or point the app at a different free model`,
        type: 'rate_limit_error',
        param: null,
        code: null,
      },
    }))
    return
  }

  const target = decision.model
  if (target !== requested) log(`routing ${requested} -> ${target} (requested is throttled)`)

  const outcome = await complete(target, body, { session, requestId })
  if (outcome.ok === true) {
    json(res, 200, { ...outcome.payload, model: target })
  } else if (outcome.ok === 'stream') {
    await pipeStream(outcome.response, res, target)
  } else {
    const retryAfter = cooldownRemainingSec(target)
    if (retryAfter > 0) {
      res.writeHead(outcome.status, { 'retry-after': String(retryAfter), 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: outcome.message, type: outcome.type, param: null, code: null } }))
    } else {
      openAiError(res, outcome.status, outcome.type, outcome.message)
    }
  }
}

/**
 * 标识「同一个使用方」。
 *
 * 优先用下游显式的会话标识；没有就用远端地址兜底 —— 同一个应用、同一条链路，
 * 上游看到的是一个长会话，而不是成千上万次「新建会话」。
 */
function downstreamSessionKey(req) {
  const explicit = req.headers['x-session-id'] ?? req.headers['x-conversation-id']
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  return `ip:${req.socket.remoteAddress ?? 'local'}`
}

/**
 * 标识「同一个回合」。
 *
 * 没有显式 request id 时用最后一条消息的内容指纹当判据：同一次重试的内容逐字节相同，
 * 指纹相同、request id 也相同，上游不会把重试当成新回合再计一次额度。
 */
function downstreamTurnSeed(req, body) {
  const explicit = req.headers['x-request-id']
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const messages = Array.isArray(body.messages) ? body.messages : []
  return crypto.createHash('sha256').update(JSON.stringify(messages[messages.length - 1] ?? {})).digest('hex')
}

/**
 * `/v1/models` 只列免费档。
 *
 * 有不少客户端（和某些 UI）会拿这个清单做模型下拉框。把付费模型混进来，等于在界面上
 * 引导用户点进一个要计费的档位——即使点了会被桥拒，那也已经是一次误导。
 */
function modelRows() {
  return (availableModels.length > 0 ? availableModels : FALLBACK_ORDER)
    .filter(model => isFreeModel(model) && !KNOWN_REGION_BLOCKED.has(model))
    .map(id => ({ id, object: 'model', created: 0, owned_by: 'free-lane' }))
}

/**
 * 把上游的 SSE 原样中继给下游，最后补一个 `[DONE]`。
 *
 * 原样转发而不是重新编码，是因为上游的帧形状（`finish_reason`、`usage`、终止帧）
 * 已经是 OpenAI 兼容的；任何重新编码都只会把它改坏。
 */
async function pipeStream(upstream, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const reader = upstream.body.getReader()
  let sawDone = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      if (chunk.includes('[DONE]')) sawDone = true
      res.write(chunk)
    }
  } catch (error) {
    log('stream cut:', error?.message ?? error)
  } finally {
    if (!sawDone) res.write('data: [DONE]\n\n')
    res.end()
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') out.port = argv[++i]
    else if (arg === '--model') out.model = argv[++i]
    else if (arg === '--host') out.host = argv[++i]
  }
  return out
}

async function main() {
  const port = await listen()
  log(`listening on http://${HOST}:${port}/v1`)
  log(`upstream: ${UPSTREAM_BASE} (免密车道，无需 API key)`)
  void refreshModels()
}

function listen() {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, HOST, () => {
      server.off('error', reject)
      // 长思考回合能静默数分钟：默认的 keep-alive 超时会把还在生成的回答切断。
      server.keepAliveTimeout = 0
      server.requestTimeout = 0
      server.headersTimeout = 0
      resolve(server.address()?.port ?? PORT)
    })
  })
}

/** 启动时探一次上游清单。探不到就退回内置顺序，不阻塞服务可用。 */
async function refreshModels() {
  const session = ensureSession('__probe__')
  const requestId = requestIdFor(session, 'probe')
  let rows = []
  try {
    const response = await fetch(`${UPSTREAM_BASE}/zen/v1/models`, {
      method: 'GET',
      headers: gatewayHeaders({ session, requestId, stream: false }),
      signal: AbortSignal.timeout(20000),
    })
    if (response.ok) {
      const payload = await response.json().catch(() => null)
      rows = Array.isArray(payload?.data) ? payload.data.map(row => row.id).filter(Boolean) : []
    }
  } catch {
    rows = []
  }
  availableModels.length = 0
  availableModels.push(...rows)
  if (rows.length > 0) log(`probed ${rows.length} models: ${rows.join(', ')}`)
  else log('upstream /models returned nothing; using the built-in fallback order')
}

/**
 * 只有直接运行时才起服务。
 *
 * 测试要 `import` 本模块来验证纯函数（候选池、session 亲和、指纹门）。若无条件 `main()`，
 * 一次 import 就会占住端口、把一个后台服务留在测试进程里，然后在测试结束时莫名其妙地
 * 继续跑。比较入口文件名是这类「脚本兼模块」文件的标准做法。
 */
const isDirectRun = process.argv[1] !== undefined &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('free-llm-bridge'))

if (isDirectRun) {
  main().catch(error => {
    log('fatal:', error?.message ?? error)
    process.exit(1)
  })
}
