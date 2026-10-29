#!/usr/bin/env node
/**
 * codebuddy-bridge —— 把腾讯 CodeBuddy（"WorkBuddy 国内版"）的积分模型
 * 包装成一个标准 OpenAI 兼容端点，供内网/公网的其它服务调用。
 *
 * 为什么要这一层（每条都是实测踩出来的）：
 *
 *   1. **CodeBuddy 强制流式**。实测非流式请求返回
 *      400 {"code":11101,"msg":"Non-stream chat request is currently not supported"}。
 *      而忆时（以及大多数 OpenAI 客户端）默认非流式，所以网关必须代它走流式、
 *      再把 SSE 拼回一次性 JSON。
 *
 *   2. **必须带一串身份头**。少 X-Product / X-Product-Code / X-Conversation-* 里任何一个，
 *      都可能被当成非官方客户端拒掉或风控。这里照抄官方 IDE 的形态。
 *
 *   3. **messages[0] 必须是 system**。源码注释原文：WorkBuddy 网关硬性要求
 *      messages[0] 是 system，否则 400 + 11128 `first message is not system prompt`。
 *      有些客户端不带 system，所以这里缺了就补一条占位。
 *
 *   4. **图片必须和文字在同一条 user 消息里**。图单独一条 user、问题在另一条，
 *      会被回「不支持图片识别」。这里把图片统一归并进它所在的那条 user 消息。
 *
 *   5. **token 会过期**，且有 refresh_token 可静默续期。续期失败要能报出明确原因，
 *      而不是让调用方看到一堆 401。
 *
 * 用法：
 *   node codebuddy-bridge.js --port 19001 \
 *        --credential /path/to/credential.json
 *
 * 环境变量覆盖（容器里用）：
 *   CREDENTIAL_PATH, PORT, HOST, UPSTREAM_TIMEOUT_MS, CREDENTIAL_REFRESH_MS
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

// ─────────────────────────── 参数 ───────────────────────────

const args = process.argv.slice(2)
function flag(name, def) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const PORT = Number(flag('--port', process.env.PORT || '19001'))
const HOST = flag('--host', process.env.HOST || '0.0.0.0')
const CREDENTIAL_PATH = flag('--credential', process.env.CREDENTIAL_PATH || '/app/credential.json')
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 180_000)
const REFRESH_MARGIN_MS = 5 * 60 * 1000        // 到期前 5 分钟开始续期
const MAX_BODY = Number(process.env.MAX_BODY || 16 * 1024 * 1024)

// CodeBuddy 国内版产品配置（实测第 2 个账号 domain 是 www.codebuddy.cn）
const PRODUCT = {
  endpoint: 'https://www.codebuddy.cn',
  apiDomain: 'www.codebuddy.cn',
  productCode: 'codebuddy',              // ← 注意：不是 workbuddy
  ideName: 'CodeBuddy',
  ideVersion: '1.106.1',
  userAgent: 'CodeBuddyIDE/1.106.1',
}

const CHAT_PATH = '/v2/chat/completions'
const REFRESH_PATH = '/v2/plugin/auth/token/refresh'
const CONFIG_PATH = '/v3/config'

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'hy3'

// ─────────────────────────── 凭据与续期 ───────────────────────────

/** 内存中的当前凭据（含 access_token / refresh_token）。 */
let credential = null
let credentialLoadedAt = 0

function loadCredential() {
  const raw = fs.readFileSync(CREDENTIAL_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token === '') {
    throw new Error(`credential file has no access_token: ${CREDENTIAL_PATH}`)
  }
  credential = parsed
  credentialLoadedAt = Date.now()
  log(`credential loaded: user=${parsed.nickname ?? '?'} domain=${parsed.domain ?? '?'} expires_in=${expiresInText(parsed)}`)
}

function saveCredential() {
  try {
    fs.writeFileSync(CREDENTIAL_PATH, JSON.stringify(credential), { mode: 0o600 })
    log('credential persisted after refresh')
  } catch (error) {
    log(`WARN could not persist refreshed credential: ${error?.message ?? error}`)
  }
}

function expiresAtMs(cred) {
  const raw = cred?.expires_at
  if (typeof raw === 'string' && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000
  // 退化：解 JWT 的 exp
  const parts = String(cred?.access_token ?? '').split('.')
  if (parts.length >= 2) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
      if (typeof payload.exp === 'number') return payload.exp * 1000
    } catch { /* ignore */ }
  }
  return undefined
}

function expiresInText(cred) {
  const t = expiresAtMs(cred)
  if (t === undefined) return 'unknown'
  const mins = Math.round((t - Date.now()) / 60000)
  return `${mins} min`
}

function needsRefresh() {
  if (!credential) return true
  const t = expiresAtMs(credential)
  if (t === undefined) return false
  return Date.now() >= t - REFRESH_MARGIN_MS
}

/** 静默续期；失败时抛错并保留旧凭据。 */
async function refreshCredential() {
  const rt = credential?.refresh_token
  if (typeof rt !== 'string' || rt === '') {
    throw new Error('no refresh_token in credential; re-login required')
  }
  const url = `${PRODUCT.endpoint}${REFRESH_PATH}`
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'X-Domain': PRODUCT.apiDomain,
      'User-Agent': PRODUCT.userAgent,
      Authorization: `Bearer ${credential.access_token}`,
      'X-Refresh-Token': rt,
      'X-Auth-Refresh-Source': 'ide-main',
      'Content-Type': 'application/json',
    },
    body: '{}',
  }, 30_000)

  const text = await res.text()
  if (res.status !== 200) {
    throw new Error(`refresh HTTP ${res.status}: ${text.slice(0, 200)}`)
  }
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`refresh returned non-JSON: ${text.slice(0, 200)}`) }
  const data = body?.data
  if (!data || typeof data !== 'object') {
    throw new Error(`refresh response has no data: ${text.slice(0, 200)}`)
  }
  // 服务端字段名是 snake_case（access_token）或 camelCase，两种都兜
  const accessToken = data.access_token ?? data.accessToken
  const refreshToken = data.refresh_token ?? data.refreshToken ?? rt
  const expiresAt = data.expires_at ?? data.expiresAt
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error(`refresh response has no access_token: ${text.slice(0, 200)}`)
  }
  credential = {
    ...credential,
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
  }
  credentialLoadedAt = Date.now()
  saveCredential()
  log(`credential refreshed, expires_in=${expiresInText(credential)}`)
}

/** 保证手上有新鲜凭据。并发调用只会触发一次续期。 */
let refreshInFlight = null
async function ensureCredential() {
  if (!needsRefresh()) return credential
  if (refreshInFlight) { await refreshInFlight; return credential }
  refreshInFlight = refreshCredential().finally(() => { refreshInFlight = null })
  await refreshInFlight
  return credential
}

// ─────────────────────────── 工具 ───────────────────────────

function log(message) {
  console.error(`[codebuddy-bridge ${new Date().toISOString()}] ${message}`)
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...corsHeaders(),
  })
  res.end(text)
}

function openAiError(res, status, message, code = 'invalid_request_error') {
  json(res, status, { error: { message, type: code, code } })
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-api-key',
  }
}

/** 把 OpenAI 的 content 数组里的图片归并进它所在的 user 消息（铁律 4）。 */
function normalizeMessages(messages) {
  const out = []
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const role = typeof raw.role === 'string' ? raw.role : 'user'
    const content = raw.content

    if (role === 'system') {
      out.push({ role, content: toText(content) })
      continue
    }
    if (role === 'assistant' || role === 'tool') {
      out.push({ role, content: toText(content) })
      continue
    }
    // user：文字与图片合并成一条多模态消息
    if (Array.isArray(content)) {
      const parts = []
      for (const p of content) {
        if (!p || typeof p !== 'object') continue
        if (p.type === 'text' && typeof p.text === 'string') {
          parts.push({ type: 'text', text: p.text })
        } else if (p.type === 'image_url' && p.image_url?.url) {
          parts.push({ type: 'image_url', image_url: { url: p.image_url.url } })
        } else if (p.type === 'input_audio') {
          // CodeBuddy 这条产品线不支持音频输入，明确剔除而不是静默丢弃
          log('WARN dropped input_audio part (not supported by this product line)')
        }
      }
      // 只有图没有字时补一句提示，否则上游会回「不支持图片识别」
      if (parts.length > 0 && !parts.some((x) => x.type === 'text')) {
        parts.unshift({ type: 'text', text: '请识别这张图片里的内容。' })
      }
      out.push({ role, content: parts.length > 0 ? parts : '' })
      continue
    }
    out.push({ role, content: toText(content) })
  }
  return out
}

function toText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 铁律 3：messages[0] 必须是 system，否则上游 400 + 11128。 */
function ensureLeadingSystem(messages) {
  if (messages.length === 0) {
    return [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages]
  }
  if (messages[0].role !== 'system') {
    return [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages]
  }
  return messages
}

// ─────────────────────────── 上游调用 ───────────────────────────

function buildUpstreamHeaders(model) {
  const cid = crypto.randomUUID().replace(/-/g, '')
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'X-Domain': PRODUCT.apiDomain,
    'X-Product': 'SaaS',
    'X-Product-Code': PRODUCT.productCode,
    'X-Conversation-ID': cid,
    'X-Conversation-Request-ID': cid,
    'X-Conversation-Message-ID': cid,
    'X-IDE-Name': PRODUCT.ideName,
    'X-IDE-Type': PRODUCT.ideName,
    'X-IDE-Version': PRODUCT.ideVersion,
    'X-Agent-Purpose': 'conversation',
    'User-Agent': PRODUCT.userAgent,
  }
}

/**
 * 调一次上游，返回 { text, reasoning, usage, finishReason }。
 * 铁律 1：强制 stream:true；然后把 SSE 拼回完整文本。
 *
 * 第 6 条实测教训：必须把调用方的 reasoning 开关透传给上游。
 * 忆时会发 reasoning:{enabled:false}；桥若把它丢掉，hy3 就在上游全量思考，
 * 实测晚高峰单张图从 ~10s 涨到 ~50s（completion 里一大半是 reasoning_content）。
 */
async function callUpstreamOnce(body, model, cred) {
  const upstreamBody = {
    model,
    messages: ensureLeadingSystem(normalizeMessages(body.messages ?? [])),
    stream: true,                                    // ← 铁律 1
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.1,
  }
  if (typeof body.max_tokens === 'number') upstreamBody.max_tokens = body.max_tokens
  else if (typeof body.max_completion_tokens === 'number') upstreamBody.max_tokens = body.max_completion_tokens
  // 透传思考开关：调用方给了就用它的；没给则默认关闭（忆时的诉求就是别思考）。
  if (body.reasoning && typeof body.reasoning === 'object') {
    upstreamBody.reasoning = body.reasoning
  } else {
    upstreamBody.reasoning = { enabled: false }
  }

  const headers = {
    ...buildUpstreamHeaders(model),
    Authorization: `Bearer ${cred.access_token}`,
  }

  const res = await fetchWithTimeout(
    `${PRODUCT.endpoint}${CHAT_PATH}`,
    { method: 'POST', headers, body: JSON.stringify(upstreamBody) },
    UPSTREAM_TIMEOUT_MS,
  )

  if (res.status !== 200) {
    const text = await res.text()
    let friendly = text.slice(0, 500)
    try {
      const j = JSON.parse(text)
      const code = j?.code ?? j?.error?.data?.code
      const msg = j?.msg ?? j?.error?.data?.msg ?? j?.error?.message
      if (code === 14018) friendly = `积分不足（需在 CodeBuddy 客户端领取或充值）：${msg ?? ''}`
      else if (code === 6004) friendly = `该模型触发频率限制，请换模型或稍后再试：${msg ?? ''}`
      else if (code === 11128) friendly = `请求缺少 system 首条消息（网关未正确补齐）：${msg ?? ''}`
      else if (msg) friendly = `${msg}${code ? ` (code ${code})` : ''}`
    } catch { /* 保留原文 */ }
    const err = new Error(friendly)
    err.status = res.status
    err.upstream = true
    throw err
  }

  // 解析 SSE
  const raw = await res.text()
  const texts = []
  const reasonings = []
  let finishReason = null
  let usage = null

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '[DONE]') break
    let d
    try { d = JSON.parse(payload) } catch { continue }
    if (d.usage) usage = d.usage
    const choice = (d.choices || [])[0]
    if (!choice) continue
    const delta = choice.delta || {}
    if (typeof delta.content === 'string' && delta.content !== '') texts.push(delta.content)
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      reasonings.push(delta.reasoning_content)
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }

  return {
    text: texts.join(''),
    reasoning: reasonings.join(''),
    usage,
    finishReason,
    model,
  }
}

/**
 * 带重试的上游调用。
 * 实测上游会间歇性 404/502（模型路由抖动），一次失败不该让整条识别作废——
 * 否则 free-llm-bridge 会把本车道拉黑、把图片请求转给纯文本模型，产出垃圾结果。
 */
const RETRYABLE_STATUS = new Set([404, 408, 429, 500, 502, 503, 504])
const MAX_ATTEMPTS = Number(process.env.UPSTREAM_RETRIES ?? 2) + 1

async function callUpstream(body) {
  const cred = await ensureCredential()
  const model = typeof body.model === 'string' && body.model !== '' ? body.model : DEFAULT_MODEL
  const imgCount = (body.messages ?? []).flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
    .filter((p) => p?.type === 'image_url').length
  const t0 = Date.now()

  let lastErr = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const out = await callUpstreamOnce(body, model, cred)
      log(`req model=${model} imgs=${imgCount} attempt=${attempt} status=200 ` +
          `${Date.now() - t0}ms prompt=${out.usage?.prompt_tokens ?? '?'} completion=${out.usage?.completion_tokens ?? '?'}`)
      return out
    } catch (error) {
      lastErr = error
      const status = error?.status
      const retryable = RETRYABLE_STATUS.has(status)
      log(`req model=${model} imgs=${imgCount} attempt=${attempt}/${MAX_ATTEMPTS} ` +
          `status=${status ?? 'net'} ${Date.now() - t0}ms retryable=${retryable} err=${String(error?.message).slice(0, 160)}`)
      if (!retryable || attempt >= MAX_ATTEMPTS) break
      // 稍等一下再试，给上游路由一点恢复时间
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }
  throw lastErr
}

async function fetchModelList() {
  const cred = await ensureCredential()
  const res = await fetchWithTimeout(
    `${PRODUCT.endpoint}${CONFIG_PATH}`,
    {
      headers: {
        Authorization: `Bearer ${cred.access_token}`,
        'X-Domain': PRODUCT.apiDomain,
        'X-Product': 'SaaS',
        'X-Product-Code': PRODUCT.productCode,
        'User-Agent': PRODUCT.userAgent,
      },
    },
    30_000,
  )
  if (res.status !== 200) throw new Error(`/v3/config HTTP ${res.status}`)
  const j = await res.json()
  const models = j?.data?.models
  if (!Array.isArray(models)) throw new Error('/v3/config has no data.models')
  return models
}

// ─────────────────────────── HTTP 服务 ───────────────────────────

const server = http.createServer((req, res) => {
  void handle(req, res).catch((error) => {
    log(`request failed: ${error?.message ?? error}`)
    if (!res.headersSent) {
      openAiError(res, error?.status && error.status >= 400 && error.status < 600 ? error.status : 502,
        String(error?.message ?? error), 'server_error')
    } else {
      res.end()
    }
  })
})

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const routePath = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  if (routePath === '/' || routePath === '/health') {
    json(res, 200, {
      ok: true,
      service: 'codebuddy-bridge',
      product: PRODUCT.endpoint,
      credentialLoaded: credential !== null,
      expiresIn: credential ? expiresInText(credential) : null,
      uptimeSec: Math.round(process.uptime()),
    })
    return
  }

  if (req.method === 'GET' && (routePath === '/v1/models' || routePath === '/models')) {
    const models = await fetchModelList()
    json(res, 200, {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: 'codebuddy',
        // 额外带上倍率与能力，方便调用方挑模型
        credits: m.credits ?? null,
        supports_images: m.supportsImages === true,
        max_input_tokens: m.maxInputTokens ?? null,
      })),
    })
    return
  }

  if (req.method === 'POST' && (routePath === '/v1/chat/completions' || routePath === '/chat/completions')) {
    const raw = await readBody(req)
    let body
    try { body = JSON.parse(raw.toString('utf8') || '{}') } catch {
      openAiError(res, 400, 'request body is not valid JSON'); return
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      openAiError(res, 400, 'messages must be a non-empty array'); return
    }

    const result = await callUpstream(body)
    const created = Math.floor(Date.now() / 1000)
    const promptTokens = result.usage?.prompt_tokens ?? null
    const completionTokens = result.usage?.completion_tokens ?? null

    // 调用方要流式就回 SSE，否则回一次性 JSON（上游永远是流式，这里只是重新打包）
    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...corsHeaders(),
      })
      const chunk = {
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: 'chat.completion.chunk',
        created,
        model: result.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: result.text }, finish_reason: null }],
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: result.finishReason ?? 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    json(res, 200, {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: 'chat.completion',
      created,
      model: result.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: result.finishReason ?? 'stop',
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
      },
    })
    return
  }

  openAiError(res, 404, `no route for ${req.method} ${routePath}`, 'not_found_error')
}

// ─────────────────────────── 启动 ───────────────────────────

function main() {
  try {
    loadCredential()
  } catch (error) {
    log(`FATAL ${error?.message ?? error}`)
    process.exit(2)
  }
  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT}`)
    log(`  upstream : ${PRODUCT.endpoint} (product=${PRODUCT.productCode})`)
    log(`  default model: ${DEFAULT_MODEL}`)
    log(`  routes   : /v1/models, /v1/chat/completions, /health`)
  })
}

process.on('SIGTERM', () => { log('SIGTERM, shutting down'); server.close(() => process.exit(0)) })
process.on('SIGINT', () => { log('SIGINT, shutting down'); server.close(() => process.exit(0)) })

main()
