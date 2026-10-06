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

const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 上游超时。免费车道思考期可能静默很久，这里给足。 */
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 600000)

// ---------------------------------------------------------------------------
// 车道（lane）—— 一条车道 = 一组「能用同一套凭据到达的免费模型」
// ---------------------------------------------------------------------------

/**
 * 为什么有多条车道
 *
 * 2026-10-05 实测：这条免密车道的可用面比看上去窄得多。13 个 `-free` 模型里
 * 只有 `space-bunny-free` 能被第三方直连调用，其余是 429 限流、403 opencode-only、
 * 403 地区门或 500。也就是说**它是单点**——这个模型被打满，整条路线就停，
 * 而在同一车道里换模型名并不能解决问题。
 *
 * 所以第二条车道不是锦上添花，是这条路线能不能长期跑下去的前提。
 * 各车道互不相关（一家的限流不影响另一家），可用性因此是叠加的。
 *
 * ### 怎么加一条车道
 *
 * 填 `name / baseUrl / model / headers`。三点必须确认：
 *
 *   1. `model` 必须是**确认免费**的。这是唯一不可妥协的底线——填错一个付费模型名，
 *      桥就会在无人察觉的情况下把账单接回去。不确定就别加。
 *   2. `headers` 放该家要求的凭据。公开免密车道用 `Bearer public`；
 *      有免费 key 的官方服务填你自己的 key。
 *   3. `normalizeSchema` 标明这家是否需要剥掉 nullable 联合类型、
 *      `strictSchema` 标明是否真正支持 `response_format`。
 *
 * 不想改代码就用环境变量：
 *
 *     LANES='[{"name":"glm","baseUrl":"https://open.bigmodel.cn/api/paas/v4",
 *               "model":"glm-4-flash-250414","apiKey":"你的key"}]'
 */

/** 第一条：OpenCode Zen 公开免密车道。不需要任何 key。 */
const OPENCODE_ZEN = {
  name: 'zen',
  baseUrl: (process.env.UPSTREAM_BASE || 'https://opencode.ai').replace(/\/+$/, ''),
  model: 'space-bunny-free',
  /** 上游按 User-Agent 判版本，必须 >= 1.17。 */
  headers: {
    'user-agent': 'opencode/1.18.31',
    'x-opencode-client': 'desktop',
    'x-opencode-project': 'global',
  },
  /** 这条车道要求声明 bash/glob/grep/read 四件套，否则 403。 */
  fingerprintTools: true,
  /** 额度按 session 计，需要稳定的 session/request id。 */
  sessionScoped: true,
  /** 语法引擎拒绝 nullable 联合类型，且不带 strict 时会回空 content。 */
  normalizeSchema: true,
  strictSchema: true,
}

/**
 * 备用车道模板，默认不启用——按需用 LANES 环境变量注入。
 *
 * 这里只留一份带注释的样例，说明每条车道该确认什么。
 */
const LANE_EXAMPLES = [
  {
    // 智谱 GLM-4-Flash-250414：官方页明写「智谱首个免费的大模型 API」
    // https://docs.bigmodel.cn/cn/guide/models/free/glm-4-flash-250414
    // ⚠️ 启用前请自己核对那条链接里的免费声明仍然有效。
    name: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash-250414',
    // 智谱的 OpenAI 兼容层对 json_schema 的支持未实测，所以 strictSchema: false——
    // 桥不会给它发 response_format，改用提示词约束（发过去可能 400）。
    strictSchema: false,
    sessionScoped: false,
  },
]

/**
 * 生效的车道列表：默认的 Zen，加上 LANES 环境变量注入的。
 *
 * 没有 apiKeyEnv 也没有 apiKey 的车道会被剔除——留着它只会让每次故障转移都去撞
 * 一次 401，把「换车道」变成「换一种方式失败」。
 */
function activeLanes() {
  const lanes = [{ ...OPENCODE_ZEN }]
  const extra = process.env.LANES
  if (typeof extra === 'string' && extra.trim() !== '') {
    try {
      const parsed = JSON.parse(extra)
      if (Array.isArray(parsed)) {
        for (const lane of parsed) {
          if (typeof lane?.name === 'string' && typeof lane?.baseUrl === 'string' && typeof lane?.model === 'string') {
            lanes.push({
              sessionScoped: false,
              strictSchema: false,
              normalizeSchema: false,
              fingerprintTools: false,
              ...lane,
            })
          }
        }
      }
    } catch (error) {
      log(`WARNING: LANES is not valid JSON (${error?.message ?? error}); ignoring it`)
    }
  }
  // 显式配了 LANES 就不再自动带内置免密车道。
  //
  // 原因：LANES 一旦出现，用户就是在**明确指定**用哪些车道——很可能正在做测试、
  // 或者已经知道免密车道不可用。悄悄在前面塞一条没人要的，既让 health 的车道
  // 清单对不上，也让「指定的主车道」永远轮不到第一个被试。
  // 需要两条都用就自己把 zen 一起写进 LANES。
  if (typeof extra === 'string' && extra.trim() !== '') return lanes.slice(1)
  return lanes
}

const LANES = activeLanes()
const PRIMARY_LANE = LANES[0]

/**
 * 兜底模型顺序：首选被限流时沿这条线往下找。
 *
 * ## 排序依据（2026-10-06 全量实测重排）
 *
 * 这份顺序直接决定**每次请求要白等几个 RTT**：桥按顺序试，前面挂了的模型
 * 每个都要打完一次才轮到下一个。实测那一刻 zen 车道 11 个候选里只有 2 个可用，
 * 而旧顺序把 `space-bunny-free`（已限流）放在第一位——于是每个请求都先撞一次墙。
 *
 * ### 本轮实测（`node scripts/probe-thinking.mjs`，2026-10-06）
 *
 * 直连命中 = `response.model === 请求的 model`，**单次延迟不算数**（曾因此误判）。
 *
 *   模型                            直连   延迟      关思考后
 *   nvidia/nemotron-3-super-120b…   ✅    1433ms    ✅ rt=0, 1045ms   ← 最优
 *   nemotron-3.5-lightning-free     ✅    7362ms    ✅ rt=0, 1381ms
 *   nemotron-3-ultra-free           ✅    9624ms    ✅ rt=0
 *   cohere/north-mini-code:free     ✅    7977ms    ✅ rt=0,  919ms
 *   kilo-auto/free                  ✅    2934ms    ⚠️ rt=54（关不干净）
 *   liquid/lfm-2.5-2.6b:free        ✅    2961ms    ❌ 502（**不能加补丁**）
 *   fledge-alpha-free               ✅    1561ms    —
 *   glm-4-flash-250414              ✅     999ms    ✅（兜底车道，永远最后）
 *
 *   以下当时**直连失败**（被限流，桥自动转给了别的模型）——保留在池子里，
 *   限流约 90 分钟后会恢复，届时它们仍应被用到，只是排在后面：
 *   space-bunny-free, jev-1.13-free, ling-3.1-flash-free, mimo-v2.5-free,
 *   mimo-v2.6-flash-free, deepseek-v4-flash-free, ling-3.0-flash-fin-free,
 *   longcat-2.5-preview-free, dots-studio/dots-3-note-preview:free,
 *   poolside/laguna-s-2.1:free
 *
 * ### 历史数据（2026-10-05，20 小时运行时统计的条件成功率）
 *
 *   space-bunny-free       754/991 ≈76%（首选，端到端 86.8% 含兜底）
 *   jev-1.13-free          170/237 ≈72%   ← 探针曾误判为不可用
 *   ling-3.1-flash-free    12/12  =100%（样本小）
 *   mimo-v2.5-free         11/24  ≈46%
 *   mimo-v2.6-flash-free   17/41  ≈41%
 *   deepseek-v4-flash-free 26/67  ≈39%
 *   ling-3.0-flash-fin-free 1/13  ≈8%（最差，垫底）
 *
 * 两组数据不冲突：历史成功率说明**长期**谁稳，本轮直连说明**此刻**谁活着。
 * 所以把本轮实测可用的排前（省 RTT），历史可靠的紧随其后（限流恢复后接上）。
 *
 * ⚠️ **这份名单是时效性的**。上游限流窗口约 90 分钟，可用面会来回变。
 * 重排前请重跑 `node scripts/probe-thinking.mjs`，不要凭记忆改。
 */
const FALLBACK_ORDER = [
  // —— 本轮实测直连可用（限流恢复快、延迟低）——
  'nemotron-3.5-lightning-free',
  'nemotron-3-ultra-free',
  'fledge-alpha-free',
  // —— 历史条件成功率最高（限流恢复后应回到最前）——
  'space-bunny-free',
  'jev-1.13-free',
  'ling-3.1-flash-free',
  'mimo-v2.5-free',
  'mimo-v2.6-flash-free',
  'deepseek-v4-flash-free',
  // —— 历史最差，垫底 ——
  'ling-3.0-flash-fin-free',
  'longcat-2.5-preview-free',
]

/**
 * 导出给测试用：多车道测试需要给「主车道的每一个候选」都脚本化 429，
 * 才能验证「主车道穷尽 → 换车道」。硬编名单会在重排后悄悄漏掉新候选，
 * 那个没被脚本化的模型就以默认 200 成功，把剧本打断在半路——
 * 这个 bug 2026-10-05 与 2026-10-06 各踩过一次，所以改成从源头取。
 */
export { FALLBACK_ORDER }

/**
 * 跨车道的**统一队列顺序** —— 用户要的「一个队列，免费模型在前，一个用不了就换下一个」。
 *
 * ## 为什么需要跨车道排（而不是每条车道各排各的）
 *
 * 旧结构里每条非主车道都把 `lane.model` 硬钉在第一位。kilo 车道的 `lane.model`
 * 是 `liquid/lfm-2.5-2.6b:free`，而实测它**思考无法关闭**
 * （上游原文：`Reasoning is mandatory for this endpoint and cannot be disabled`），
 * 加思考补丁直接 502。于是每个请求都先打这个又慢又脆的模型，才轮到真正好的
 * `nemotron-3-super`——白等一个 RTT。
 *
 * 排名的唯一依据是**实测**（`node scripts/probe-thinking.mjs`），不是模型名气。
 *
 * ## 分层
 *
 *   1. 实测直连可用 + 能关思考（最快）
 *   2. 实测直连可用（思考关不掉，但仍快）
 *   3. 历史上稳、本轮被限流（约 90 分钟后恢复）
 *   4. 实测表现最差
 *
 * `glm-4-flash-250414` **故意不在这里** —— 它是「所有免费模型都暴毙」时的兜底，
 * 额度有限且有期限，绝不能当主力。它只作为独立车道排在所有免费车道之后。
 */
const QUEUE_ORDER = [
  // —— 1. 直连可用且能关思考（实测最快）——
  'nvidia/nemotron-3-super-120b-a12b:free',   // 1433ms，关思考 rt=0
  'cohere/north-mini-code:free',              // 7977ms → 关思考 919ms
  'nemotron-3.5-lightning-free',              // 7362ms → 关思考 1381ms
  'nemotron-3-ultra-free',                    // 9624ms，关思考 rt=0
  // —— 2. 直连可用但思考关不干净（仍比限流档快）——
  'kilo-auto/free',                           // 2934ms，rt 关不到 0
  'liquid/lfm-2.5-2.6b:free',                 // ⚠️ 思考强制开启，绝不能加补丁
  'fledge-alpha-free',                        // 1561ms，无 reasoning 字段
  // —— 3. 历史上稳、本轮被限流（约 90 分钟后恢复）——
  'space-bunny-free',
  'jev-1.13-free',
  'ling-3.1-flash-free',
  'mimo-v2.5-free',
  'mimo-v2.6-flash-free',
  'deepseek-v4-flash-free',
  'dots-studio/dots-3-note-preview:free',
  'poolside/laguna-s-2.1:free',
  // —— 4. 实测最差，垫底 ——
  'ling-3.0-flash-fin-free',
  'longcat-2.5-preview-free',
]

export { QUEUE_ORDER }

/**
 * 队列里的名次。不在名单里的模型排在最后（保持稳定，不打乱既有相对顺序）。
 * @param {string} model
 * @returns {number}
 */
function queueRank(model) {
  const index = QUEUE_ORDER.indexOf(model)
  return index < 0 ? QUEUE_ORDER.length : index
}

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
const KNOWN_OPENCODE_ONLY = new Set([])

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

/**
 * 免费车道要求请求里声明这四个工具名，否则 403 FreeTierError。
 * 纯批处理没有真实工具，于是发自禁用的诱饵：模型即使去调，返回也不可用。
 */
const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read']

// ---------------------------------------------------------------------------
// 关闭思考 —— 免费档最大的一笔速度浪费
// ---------------------------------------------------------------------------

/**
 * 「关闭思考」的参数补丁形状。
 *
 * 实测（2026-10-06）这个形状是**嵌套**的 `{"reasoning":{"enabled":false}}`，
 * 与 Our Free Model 插件 catalog 里每个模型的 `effortOffPatch` 完全一致。
 * 扁平的 `reasoning_effort` / `enable_thinking` / `thinking` **形状不对**：
 * 它们对部分车道直接回 502，且对另一些模型被静默忽略（reasoning_tokens 照旧）。
 */
const THINKING_OFF_PATCH = { reasoning: { enabled: false } }

/**
 * 实测**接受**关闭思考、且 `reasoning_tokens` 确实归零的模型。
 *
 * ## 为什么必须是逐模型的名单，不能全局配
 *
 * 上游对思考参数的处理**因模型而异**：同一份 `{"reasoning":{"enabled":false}}`，
 * `nvidia/nemotron-3-super-120b-a12b:free` 接受并把 reasoning 压到 0，
 * 而 `liquid/lfm-2.5-2.6b:free` **直接回 502**。
 *
 * 桥是**跨车道故障转移**的（`payload = {...body, model}` 原样透传），所以一个
 * 全局参数最终会打到任意模型上——那等于用一个模型的方言去毒另一个模型。
 * 实测教训：把 `reasoning_effort` 写进 Hindsight 的全局 `EXTRA_BODY` 后，
 * 原本能成功的 liquid 调用开始成片 502。
 *
 * 所以名单**只收实测通过的模型**；不在名单里的一个字节都不加。
 * 这与插件 catalog 的 `canDisableThinking` 一致，但以本桥的实测为准。
 *
 * ## 收益（Hindsight 的轻任务最吃这一口）
 *
 * 免费档的思考 token 与正文**共享同一个 `max_tokens` 预算**，思考几千 token
 * 才吐正文，正是这些调用动辄 7~14 秒的原因。实测关闭后：
 *
 *   nvidia/nemotron-3-super-120b-a12b:free   1489ms → 1045ms（rt 41 → 0）
 *   cohere/north-mini-code:free              7977ms →  919ms（rt 32 → 0）
 *   nemotron-3.5-lightning-free              7362ms → 1381ms（rt 136 → 0）
 *
 * 记忆提取/整合是「照抄事实」的轻任务，不需要思考——省下的正是纯浪费。
 *
 * 重新验证：`node scripts/probe-thinking.mjs`
 */
const THINKING_OFF_MODELS = new Set([
  // —— 实测 reasoning_tokens 归零 ——
  'nvidia/nemotron-3-super-120b-a12b:free',
  'cohere/north-mini-code:free',
  'nemotron-3.5-lightning-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning:free',
  'nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'glm-4-flash-250414',
])

/**
 * 这个模型该不该关思考。
 *
 * 只对**实测接受**的模型返回补丁；其余返回 undefined，请求一个字节都不改。
 * 调用方自己传了 `reasoning` 时不覆盖——显式意图优先于本桥的默认。
 *
 * 返回的是**深拷贝**：调用方（或未来某个 `Object.assign` 的意外）改到内层对象时，
 * 不能污染这张全局名单，否则「哪些模型能关思考」会随运行悄悄漂移。
 *
 * @param {string} model 模型名
 * @returns {object|undefined} 要合并进请求体的补丁
 */
export function thinkingOffPatch(model) {
  if (!THINKING_OFF_MODELS.has(model)) return undefined
  return { reasoning: { ...THINKING_OFF_PATCH.reasoning } }
}

/**
 * 这个模型是否在「关思考」名单里（给 /health 与探针用）。
 * @param {string} model
 * @returns {boolean}
 */
export function supportsThinkingOff(model) {
  return THINKING_OFF_MODELS.has(model)
}

/** 每条车道各自的限流退避：key 为 `lane:model`，被限流后暂停到这个时刻。 */
const COOLDOWN_UNTIL = new Map()

/** 主车道启动时探测到的可达模型。其它车道不做启动探测（省额度）。 */
const availableModels = []

function cooldownKey(lane, model) {
  return `${lane.name}:${model}`
}

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

/**
 * 按车道构造上游请求头。
 *
 * 免密车道用 `Bearer public`——那条车道本来就不需要任何用户密钥。
 * 有 key 的官方服务用自己的凭据。
 *
 * @param {object} lane 车道定义
 * @param {{session: string, requestId: string, stream: boolean}} ids
 * @returns {object} 请求头
 */
function gatewayHeaders(lane, { session, requestId, stream }) {
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : '*/*',
  }
  if (lane.apiKey !== undefined && lane.apiKey !== '') {
    headers.authorization = `Bearer ${lane.apiKey}`
  } else if (lane.keyless !== true) {
    // `Bearer public` 是 zen 车道的免密凭据，不是通用的「无凭据」写法：
    // 给一条根本不需要认证的车道（Kilo AI）发它，上游会答 401 INVALID_TOKEN。
    // 所以「无凭据」必须能显式声明，而不是靠 apiKey 缺失推断。
    headers.authorization = 'Bearer public'
  }
  // session 相关头只有按 session 计额的才需要；给不需要的车道发这些是无意义的噪音。
  if (lane.sessionScoped === true) {
    headers['x-opencode-session'] = session
    headers['x-opencode-request'] = requestId
  }
  return { ...headers, ...(lane.headers ?? {}) }
}

function isResponsesModel(model) {
  return /^muse[-_]?spark/i.test(model)
}

/** 某条车道的补全路径。免密车道里 muse-spark-* 走 /responses，其余走 chat。 */
function endpointFor(lane, model) {
  if (lane.pathStyle === 'openai') return '/chat/completions'
  return isResponsesModel(model) ? '/zen/v1/responses' : '/zen/v1/chat/completions'
}

/**
 * 满足工具指纹门：把下游真实工具规范化到四个小写名，缺的用自禁诱饵补上。
 *
 * 规范化而不是并列，是因为上游会拒绝 `Bash` + `bash` 这类大小写重复声明。
 *
 * @param {Array} tools 下游声明的工具
 * @param {boolean} style true 为 Responses 的扁平工具形状，false 为 Chat 的 function 包装
 * @returns {Array} 满足指纹门的工具列表；调用方没声明工具时原样返回它的空值
 */
export function applyFingerprint(tools, style) {
  // undefined 与 null 都原样返回：调用方没声明工具时不该凭空补出四个诱饵。
  // 「这条车道要求指纹」才补，是 complete 的决定，不是本函数的责任。
  if (tools === undefined || tools === null) return tools
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

/**
 * 某个目标是否在限流冷却中。
 *
 * key 是 `lane:model` 而不是裸模型名——两条车道可能都有叫 `xxx-free` 的模型，
 * 一家的限流不该把另一家的同一个名字也拖进冷却。
 *
 * @param {object} lane 车道定义
 * @param {string} model 模型名
 * @returns {boolean}
 */
export function inCooldown(lane, model) {
  const until = COOLDOWN_UNTIL.get(cooldownKey(lane, model))
  return until !== undefined && until > Date.now()
}

/**
 * 把冷却时长夹到 [下限, 上限]。
 *
 * 上游说「等 90 分钟」是可信的，但一个写错的 `retry-after: 999999` 不该让这个模型
 * 永远消失。封顶 6 小时：足够覆盖任何合理的限流窗口，又保证它一定会回到候选池。
 *
 * @param {number|undefined} seconds 上游给的秒数
 * @returns {number} 实际采用的秒数
 */
function clampThrottle(seconds) {
  const requested = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_THROTTLE_SEC
  return Math.min(requested, MAX_THROTTLE_SEC)
}

const MAX_THROTTLE_SEC = Number(process.env.MAX_THROTTLE_SEC || 21600)

function markThrottled(lane, model, retryAfterSec) {
  const requested = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec : DEFAULT_THROTTLE_SEC
  const capped = clampThrottle(retryAfterSec)
  if (capped !== requested) {
    log(`clamping throttle for ${lane.name}/${model}: upstream asked ${requested}s, using ${capped}s`)
  }
  COOLDOWN_UNTIL.set(cooldownKey(lane, model), Date.now() + capped * 1000)
  return capped
}

function cooldownRemainingSec(lane, model) {
  const until = COOLDOWN_UNTIL.get(cooldownKey(lane, model))
  if (until === undefined || until <= Date.now()) return 0
  return Math.ceil((until - Date.now()) / 1000)
}

/**
 * 这条车道现在有没有可用目标。
 *
 * @param {object} lane 车道定义
 * @returns {boolean}
 */
export function laneHasCapacity(lane) {
  const candidates = candidatesFor(lane)
  return candidates.some(model => !inCooldown(lane, model))
}

/**
 * 一条车道的候选模型，按实测可用性排序。
 *
 * 主车道（免密车道）才做启动探测并使用探测结果——它的候选最多、最需要按实测排。
 * 其它车道（官方免费 key 服务）通常就一个模型，直接用它。
 *
 * @param {object} lane 车道定义
 * @returns {string[]} 候选模型，已排除付费档、地区受限、opencode-only
 */
/**
 * 一条车道的候选模型，按实测可用性排序。
 *
 * 主车道（免密车道）才会带上「实测已知不可用」的模型黑名单，因为那两条都是
 * 针对 OpenCode 那一家的观察（地区门、只能内部调用）。把它们套到别的提供方头上
 * 会误伤——比如某家的模型恰好也叫 `fledge-alpha-free`，它跟 OpenCode 的那个
 * 毫无关系。所以非主车道只做「必须免费」这一条判定。
 *
 * 非主车道的候选**只有它自己那一个模型**。这条很重要：`FALLBACK_ORDER` 是对
 * OpenCode 那一家的实测排序，对别的提供方毫无意义，而把它们混进来会让故障转移
 * 先把一条注定失败的车道从头走到尾（实测：一次请求打 7 次上游才换到备用车道），
 * 白等 6 个 RTT。所以每条车道只试自己配置的那个模型——换车道才是真的换。
 *
 * @param {object} lane 车道定义
 * @returns {string[]} 候选模型，已排除付费档；主车道还额外排除实测不可用的
 */
function candidatesFor(lane) {
  const isPrimary = lane === PRIMARY_LANE
  // lane.knownFree 是车道对「这个模型确实免费」的显式声明：id 不一定以 -free 结尾
  // （智谱 glm-4-flash-250414 就是官方文档写明的免费模型）。它只对车道自己点名的那个
  // 模型生效，所以不会把上游清单里的付费模型放进候选池。
  // lane.knownFree 允许「id 不以 -free 结尾」的模型（智谱 glm-4-flash-250414、
  // Kilo 的 org/model:free 形态）。knownFreeModels 进一步允许一条车道声明**一组**
  // 已知免费 id——Kilo 发布了 17 个 isFree 模型，只认 lane.model 一个会让另外 16 个
  // 永远点不到。两个名单都只对「车道自己声明的」生效，不会把上游清单里的付费模型
  // 放进候选池。
  const declaredFree = lane.knownFree === true
  const declaredList = Array.isArray(lane.knownFreeModels) ? lane.knownFreeModels : []
  const declared = model => (declaredFree && model === lane.model) || declaredList.includes(model)
  const allowed = model => (isFreeModel(model) || declared(model)) &&
    (!isPrimary || (!KNOWN_REGION_BLOCKED.has(model) && !KNOWN_OPENCODE_ONLY.has(model)))

  // 车道自己指定的模型，永远且排在第一。
  if (!allowed(lane.model)) return []

  if (!isPrimary) {
    const pool = [lane.model]
    for (const extra of declaredList) if (allowed(extra) && !pool.includes(extra)) pool.push(extra)
    return pool
  }

  // 主车道有多模型可用，**完全按实测排序**决定顺序。
  //
  // `source` 是上游的完整清单（86 个，绝大多数是付费档），所以每一项都要过
  // `allowed()` 过滤——直接把 source 塞进 ordered 会让 /health 报出 86 个候选，
  // 而实测能直连的只有 1 个。那种数字比没有更糟：它会让人以为有冗余。
  //
  // ⚠️ 这里**不再把 `lane.model` 强制排到第一位**（2026-10-06 改）。
  // 旧写法是 `const ordered = [lane.model]` 再追加排序结果，于是无论实测如何，
  // `space-bunny-free` 永远第一个被试。而实测它当时是 0/4 直连（已限流），
  // 等于**每个请求都先白撞一次墙**再换——这正是「整合处理不动」里被忽略的
  // 那部分延迟。主车道的顺序应当由实测排名说了算，lane.model 只是池子里的一员。
  // （非主车道仍然保持「自己那个模型排第一」，见上面的分支。）
  const rank = model => {
    const i = FALLBACK_ORDER.indexOf(model)
    return i < 0 ? FALLBACK_ORDER.length : i
  }
  const source = availableModels.length > 0 ? availableModels : FALLBACK_ORDER
  const pool = new Set()
  for (const candidate of [lane.model, ...source]) {
    if (allowed(candidate)) pool.add(candidate)
  }
  // 同排名时按名字稳定排序，避免 Set 迭代顺序让每次启动的候选序不同。
  return [...pool].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * 「队列哨兵」模型名 —— 下游点名它，就等于说「你从队列里挑，别问我」。
 *
 * ## 为什么必须有这个
 *
 * Hindsight 这类调用方**每轮都点名同一个模型**（它只有一个 `LLM_MODEL` 配置项）。
 * 没有哨兵时，桥必须「尊重点名」——于是队列只在**故障转移**时才生效：
 * 首选永远是那一个被钉死的模型，它一限流，每轮请求都要先撞它一次才换。
 * 用户要的「一个用不了就换下一个」就退化成了「每次都要先失败一次」。
 *
 * 点名哨兵则把选择权完全交给桥：桥按实测队列取**当前第一个有容量**的，
 * 被限流的自然跳过，不浪费任何 RTT。
 *
 * 用法：`HINDSIGHT_API_LLM_MODEL=free-queue`
 *
 * 保留 `auto` / `queue` 作为别名（都是不会被上游当真实模型名的词）。
 */
const QUEUE_SENTINELS = new Set(['free-queue', 'auto', 'queue'])

/** 对外推荐的那个哨兵名（`/v1/models` 与文档用它）。 */
const QUEUE_SENTINEL = 'free-queue'

/**
 * 下游点名的模型是不是「队列哨兵」。
 * @param {string} requested
 * @returns {boolean}
 */
export function isQueueSentinel(requested) {
  return QUEUE_SENTINELS.has(String(requested ?? '').trim().toLowerCase())
}

/**
 * 算出这一次该用哪条车道的哪个模型。
 *
 * 决策顺序：
 *   1. 点名了付费模型 → 拒绝。这条不变，是整个项目的底线。
 *   2. 点名了队列哨兵（`free-queue`）→ 当作「没点名」，按队列挑第一个有容量的。
 *   3. 点名的模型属于某条车道且那辆车道有容量 → 用它。
 *   4. 点名的模型地区受限 → 如实拒绝。
 *   5. 点名的模型是 opencode-only → 降级换档（换模型有用，不该报错）。
 *   6. 否则沿队列顺序找第一个有容量的。
 *
 * @param {string} requested 下游点名的模型，空串表示「你自己挑」
 * @param {string[]} available 主车道探测到的可达模型
 * @returns {{lane: object, model: string}|{error: string}}
 */
export function pickModel(requested, available) {
  const primary = PRIMARY_LANE
  const pool = candidatesFor(primary)

  // 队列哨兵 = 下游主动放弃点名。当成空串走队列，而不是当成模型名去校验。
  const asked = isQueueSentinel(requested) ? '' : String(requested ?? '').trim()

  // 点名了付费模型：如实拒绝。静默改投会让调用方以为自己用的就是点名的那个模型，
  // 而实际跑的完全是另一回事。
  const declaredFreeModel = LANES.some(lane =>
    (lane.knownFree === true && lane.model === asked) ||
    (Array.isArray(lane.knownFreeModels) && lane.knownFreeModels.includes(asked)))
  if (asked !== '' && !isFreeModel(asked) && !declaredFreeModel) {
    return { error: `model "${asked}" is not a free-lane model; this bridge only serves models whose id ends in "-free"` }
  }
  if (asked !== '' && KNOWN_REGION_BLOCKED.has(asked)) {
    return { error: `model "${asked}" is region-blocked from this network egress` }
  }
  if (asked !== '' && KNOWN_OPENCODE_ONLY.has(asked)) {
    const alternative = firstWithCapacity(LANES, asked)
    if (alternative !== undefined) {
      log(`routing ${asked} -> ${alternative.lane.name}/${alternative.model} (upstream restricts ${asked} to OpenCode-internal calls)`)
      return alternative
    }
    return { error: `model "${asked}" is restricted to OpenCode-internal calls, and no alternative free model is available` }
  }

  // 点名的模型能对上某条车道，且那辆车道还有容量，就用它。
  if (asked !== '') {
    const owning = LANES.find(lane => lane.model === asked || candidatesFor(lane).includes(asked))
    if (owning !== undefined && !inCooldown(owning, asked)) {
      return { lane: owning, model: asked }
    }
  }

  const chosen = firstWithCapacity(LANES, asked)
  if (chosen !== undefined) return chosen
  return { error: 'all free lanes are currently rate limited' }
}

/**
 * 全队列的候选目标，按 `QUEUE_ORDER` 统一排序。
 *
 * 这是「一个队列」的实现：**先把所有车道的所有免费模型排成一条线**，
 * 而不是「每条车道各排各的、车道之间再串起来」。区别很实在——旧结构里
 * kilo 车道会先把它自己那个（思考强制开启、又慢又脆的）`liquid` 打一遍，
 * 才轮到 zen 车道上真正快的 `nemotron-3.5-lightning`。用户要的是
 * 「一个用不了就换下一个」，那就必须是**一条线**。
 *
 * 同一模型出现在多条车道时，按车道定义顺序取先出现的那条（凭据更明确）。
 *
 * @param {object[]} lanes 车道列表
 * @returns {Array<{lane: object, model: string}>} 已按队列顺序排好的目标
 */
function queueTargets(lanes) {
  const seen = new Set()
  const targets = []
  for (const lane of lanes) {
    for (const model of candidatesFor(lane)) {
      const key = `${lane.name}:${model}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({ lane, model })
    }
  }
  // 稳定排序：同名次时保持车道定义顺序，避免每次启动候选序漂移。
  return targets
    .map((target, index) => ({ target, index }))
    .sort((a, b) =>
      queueRank(a.target.model) - queueRank(b.target.model) || a.index - b.index)
    .map(entry => entry.target)
}

/**
 * 按队列顺序找第一个还有容量的目标。
 *
 * @param {object[]} lanes 车道列表
 * @param {string} exclude 要跳过的模型（通常是刚失败的那个）
 * @returns {{lane: object, model: string}|undefined}
 */
function firstWithCapacity(lanes, exclude) {
  for (const { lane, model } of queueTargets(lanes)) {
    if (exclude !== '' && model === exclude) continue
    if (!inCooldown(lane, model)) return { lane, model }
  }
  return undefined
}

/**
 * 全局还有多少目标在冷却里，以及最短要等多久。
 *
 * @returns {{targets: number, soonestSec: number}}
 */
export function cooldownSummary() {
  const waits = []
  for (const [key, until] of COOLDOWN_UNTIL) {
    if (until > Date.now()) waits.push(Math.ceil((until - Date.now()) / 1000))
    else COOLDOWN_UNTIL.delete(key)
  }
  return { targets: waits.length, soonestSec: waits.length > 0 ? Math.min(...waits) : 0 }
}

/**
 * 从 429 里取出上游给的等待时长。
 *
 * 实测（2026-10-05）：免密车道把 `retry-after` 放在**响应头**里，不在 body 里。
 * body 只有 `{"type":"error","error":{"type":"FreeUsageLimitError",
 * "message":"Rate limit exceeded. Please try again later."},"metadata":{}}`——
 * 没有任何数字。所以只解析 body 会永远拿不到值，然后退回 60 秒默认值。
 *
 * 而实测这个值是 5400+ 秒（90 分钟量级）且**真实递减**（连打三次：5425 → 5416 → 5405）。
 * 也就是说：这些模型是**速率限制**，约 90 分钟后自动恢复。退避 60 秒会让桥在
 * 接下来一个半小时里反复撞同一面墙——每次都白等一个 RTT。
 *
 * 所以优先级是：响应头 > body > 保守默认值。
 *
 * @param {string|number|null|undefined} headerValue 响应头的 retry-after
 * @param {string} bodyText 响应体
 * @returns {number|undefined} 秒
 */
function retryAfterOf(headerValue, bodyText) {
  const headerSeconds = Number(headerValue)
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) return headerSeconds

  const match = /"retry[-_]?after"\s*:\s*"?(\d+)/i.exec(String(bodyText ?? ''))
  return match === null ? undefined : Number(match[1])
}

/**
 * 没有上游线索时用多久。
 *
 * 90 分钟量级不是随手取的：实测这批免费模型的限流窗口就在这个尺度。给得太短会反复撞墙，
 * 给得太长会让恢复后仍然闲置。
 */
const DEFAULT_THROTTLE_SEC = Number(process.env.DEFAULT_THROTTLE_SEC || 5400)

/** 把上游的一次失败翻译成下游能理解的形状，同时更新限流状态。 */
export function upstreamFailure(status, detail, lane, model, retryAfterHeader) {
  const text = String(detail ?? '')
  if (status === 429 || /FreeUsageLimitError/.test(text)) {
    // 用**夹顶后**的时长回报给调用方，而不是上游原话。否则一个写错的
    // retry-after: 999999 会让 Hindsight 以为自己要等 11 天。
    const wait = markThrottled(lane, model, retryAfterOf(retryAfterHeader, text))
    return {
      ok: false,
      status: 429,
      type: 'rate_limit_error',
      message: `upstream rate limit on ${lane.name}/${model}; retry in ~${Math.round(wait / 60)}min`,
      throttleSec: wait,
    }
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
  // 凭据问题（401/403 且不是上面两种）通常意味着这条车道的 key 失效或没配。
  // 换模型没用，但换车道有用——所以标记成值得故障转移，让 complete 去试下一条车道。
  if (status === 401 || (status === 403 && /[Aa]uthoriz|[Kk]ey|[Cc]redential|100[0-9]/.test(text))) {
    return { ok: false, status: 403, type: 'invalid_request_error', message: `lane ${lane.name} rejected the request (auth?): ${text.slice(0, 120)}`, authFailure: true }
  }
  if (status === 404 || /Model is unavailable/i.test(text)) {
    return { ok: false, status: 404, type: 'not_found_error', message: `model ${model} is not routed by the upstream` }
  }
  return { ok: false, status: 502, type: 'server_error', transient: status >= 500, message: `upstream error ${status}: ${text.slice(0, 200)}` }
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
 * @param {object} lane 车道定义
 * @param {string} model 已由 pickModel 选定的模型
 * @param {object} body 下游的 OpenAI 请求体
 * @param {{session: string, requestId: string}} ids 已铸好的上游身份
 * @returns {Promise<object>} `{ok:true, payload, lane, model}` | `{ok:'stream', response, lane, model}` |
 *   `{ok:false, status, type, message}`
 */
/**
 * 把上游的 SSE 帧合成一个非流式的 OpenAI 补全体。
 *
 * 为什么需要它：免密车道只有流式请求能过「仅限 OpenCode 内部」那道门——实测
 * `accept: text/event-stream` 才放行，非流式的通配 accept 一律 403。所以即使
 * 调用方要的是非流式，也必须用流式去取上游，再在这里合成回 JSON。
 *
 * @param {string} text 上游的 SSE 正文
 * @returns {object} OpenAI 形状的非流式补全
 */
function aggregateStream(text) {
  const out = {
    id: '', object: 'chat.completion', created: 0, model: '',
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: null }],
  }
  let content = ''
  let reasoning = ''
  let usage
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const raw = trimmed.slice(5).trim()
    if (raw === '' || raw === '[DONE]') continue
    let frame
    try { frame = JSON.parse(raw) } catch { continue }
    if (frame?.id) out.id = frame.id
    if (frame?.model) out.model = frame.model
    if (frame?.created) out.created = frame.created
    if (frame?.usage) usage = frame.usage
    const choice = Array.isArray(frame?.choices) ? frame.choices[0] : undefined
    if (choice === undefined) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string') content += delta.content
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
    if (choice.finish_reason) out.choices[0].finish_reason = choice.finish_reason
  }
  out.choices[0].message.content = content
  if (reasoning !== '') out.choices[0].message.reasoning_content = reasoning
  if (usage !== undefined) out.usage = usage
  return out
}

async function complete(lane, model, body, ids) {
  const flat = isResponsesModel(model)
  const payload = { ...body, model }

  // 关思考 —— 按**本次实际要打的模型**决定，不是按下游点名的那个。
  //
  // 这是本函数被故障转移反复调用的原因所在：`body` 始终是下游的原始请求，
  // 而 `model` 每次都是新目标。所以补丁必须在这里算，才能做到
  // 「nemotron 关思考、liquid 不关」——同一轮请求换目标后自动重新判定。
  //
  // 显式传了 reasoning 的调用方优先：桥只补默认，不覆盖意图。
  if (body.reasoning === undefined) {
    const patch = thinkingOffPatch(model)
    if (patch !== undefined) Object.assign(payload, patch)
  }

  // 只有「要求指纹工具」的车道才需要补那四件套。给不需要的车道发它们，
  // 反而会让它以为调用方真的注册了这些工具。
  //
  // 注意这条车道必须**无条件**补齐：调用方一个工具都没声明时，它仍然需要那四件套，
  // 否则整个请求会 403。所以这里用 `?? []` 把空值转成空数组再补，而不是让
  // applyFingerprint 的空值透传短路掉补齐。
  if (lane.fingerprintTools === true) {
    payload.tools = applyFingerprint(body.tools ?? [], flat)
    if (!payload.tool_choice && body.tools === undefined) payload.tool_choice = flat ? 'auto' : 'none'
  } else if (body.tools !== undefined) {
    payload.tools = body.tools
  } else {
    delete payload.tools
  }

  // response_format 只发给确认支持 schema 的车道：给不支持的发过去会 400。
  // 官方文档写「支持结构化输出」不等于 OpenAI 兼容层就接受 json_schema。
  if (lane.strictSchema === true) {
    const responseFormat = lane.normalizeSchema === true
      ? normalizeResponseFormat(body.response_format)
      : body.response_format
    if (responseFormat !== undefined) payload.response_format = responseFormat
    else delete payload.response_format
  } else {
    delete payload.response_format
  }

  if (body.stream === true) {
    let response
    try {
      response = await fetchUpstream(lane, model, payload, ids, true)
    } catch (error) {
      // 传输层失败（连不上/DNS/超时）也是「换一条车道也许能成」的情况，
      // 归一成一次普通失败，让下面的故障转移逻辑统一处理。
      const transport = transportFailure(lane, model, error)
      if (!worthFailoverTo(transport, model, ids)) return transport
      return failover(lane, model, body, ids, transport)
    }
    if (!response.ok) {
      const failure = upstreamFailure(response.status, await safeErrorBody(response), lane, model, response.headers.get('retry-after'))
      return worthFailoverTo(failure, model, ids) ? failover(lane, model, body, ids, failure) : failure
    }
    // 上游在高负载下会用 application/json 的 content-type 回一整套 SSE 帧。
    // 信 header 会把整条流读成字符串、JSON.parse 失败、整轮报废。读法是按 body 形状分流。
    const contentType = String(response.headers.get('content-type') ?? '')
    if (contentType.includes('application/json')) {
      const parsed = await response.json().catch(() => null)
      if (parsed !== null) return { ok: true, payload: parsed, lane: lane.name, model }
    }
    return { ok: 'stream', response, lane: lane.name, model }
  }

  // 这条车道只对流式放行（accept: text/event-stream 才过那道门），所以非流式
  // 调用也必须用流式去取，再在本地合成回 JSON。
  if (lane.fingerprintTools === true) {
    let streamed
    try {
      streamed = await fetchUpstream(lane, model, { ...payload, stream: true }, ids, true)
    } catch (error) {
      const transport = transportFailure(lane, model, error)
      if (!worthFailoverTo(transport, model, ids)) return transport
      return failover(lane, model, body, ids, transport)
    }
    if (!streamed.ok) {
      const failure = upstreamFailure(streamed.status, await safeErrorBody(streamed), lane, model, streamed.headers.get('retry-after'))
      return worthFailoverTo(failure, model, ids) ? failover(lane, model, body, ids, failure) : failure
    }
    const text = await streamed.text().catch(() => '')
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = null }
    if (parsed === null || typeof parsed !== 'object' || parsed.choices === undefined) parsed = aggregateStream(text)
    if (isEmptyCompletion(parsed)) {
      const emptyFailure = {
        ok: false,
        status: 502,
        type: 'server_error',
        message: `lane ${lane.name}/${model} returned an empty completion (a silent failure, not a real answer)`,
        emptyCompletion: true,
      }
      // worthFailoverTo() 已经把 emptyCompletion 列为「值得换目标」，调用点必须真的换。
      // 直接 return 会让链停在一个只吐思考、没有正文的模型上（实测 nemotron-3-ultra 的
      // Nvidia 后端过载时就返回这种空完成），后面的车道永远轮不到。
      return worthFailoverTo(emptyFailure, model, ids) ? failover(lane, model, body, ids, emptyFailure) : emptyFailure
    }
    return { ok: true, payload: parsed, lane: lane.name, model }
  }

  let response
  try {
    response = await fetchUpstream(lane, model, payload, ids, false)
  } catch (error) {
    const transport = transportFailure(lane, model, error)
    if (!worthFailoverTo(transport, model, ids)) return transport
    return failover(lane, model, body, ids, transport)
  }
  if (response.ok) {
    const parsed = await response.json().catch(() => null)
    if (parsed === null) return { ok: false, status: 502, type: 'server_error', message: 'upstream returned a non-JSON body' }
    // 免费车道的正常收尾会带一个 `cost` 字段（见插件的逐帧抓包记录：`{"choices":[],"cost":"0"}`）。
    // 上游哪天把这个车道改成计费的，这里会第一个看见——如实记下来，而不是静默收下。
    const cost = parsed?.cost
    if (cost !== undefined && cost !== null && String(cost) !== '0') {
      log(`WARNING: upstream reported cost=${cost} on a free-lane model - the lane may no longer be free`)
    }
    // 200 但正文是空的——这不是一次成功，是一次静默失败。
    //
    // 放过它比报错危险得多：调用方（Hindsight 的 retain）会「成功」地抽取出零条事实，
    // 记忆看起来在工作，实际什么都没存，而且没有任何地方会报错。实测这条车道在
    // `json_schema` 不带 strict 时就会这么干（见 normalizeResponseFormat 的注释）。
    //
    // 所以这里把它降级成一次失败，好让它走故障转移或如实报给调用方。
    if (isEmptyCompletion(parsed)) {
      const emptyFailure = {
        ok: false,
        status: 502,
        type: 'server_error',
        message: `lane ${lane.name}/${model} returned an empty completion (a silent failure, not a real answer)`,
        emptyCompletion: true,
      }
      // worthFailoverTo() 已经把 emptyCompletion 列为「值得换目标」，调用点必须真的换。
      // 直接 return 会让链停在一个只吐思考、没有正文的模型上（实测 nemotron-3-ultra 的
      // Nvidia 后端过载时就返回这种空完成），后面的车道永远轮不到。
      return worthFailoverTo(emptyFailure, model, ids) ? failover(lane, model, body, ids, emptyFailure) : emptyFailure
    }
    return { ok: true, payload: parsed, lane: lane.name, model }
  }

  const failure = upstreamFailure(response.status, await safeErrorBody(response), lane, model, response.headers.get('retry-after'))
  return worthFailoverTo(failure, model, ids) ? failover(lane, model, body, ids, failure) : failure
}

/**
 * 一次 200 响应算不算「空完成」。
 *
 * 判据是**没有任何可读内容**：既没有正文，也没有工具调用。usage 之类不算内容。
 * 流式响应不在这里判——那要等帧流完，由 pipeStream 的下游自己看。
 *
 * @param {object} payload 已解析的 OpenAI 兼容响应
 * @returns {boolean}
 */
function isEmptyCompletion(payload) {
  const choices = Array.isArray(payload?.choices) ? payload.choices : []
  if (choices.length === 0) return true
  for (const choice of choices) {
    const message = choice?.message ?? {}
    const content = message.content
    const hasText = typeof content === 'string'
      ? content.trim() !== ''
      : Array.isArray(content) && content.length > 0
    const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    if (hasText || hasToolCalls) return false
  }
  return true
}

/**
 * 把传输层异常归一成一次失败。
 *
 * @param {object} lane 车道定义
 * @param {string} model 模型名
 * @param {Error} error 原始异常
 * @returns {{ok: false, status: number, type: string, message: string, transportFailure: true}}
 */
function transportFailure(lane, model, error) {
  return {
    ok: false,
    status: 502,
    type: 'server_error',
    message: `lane ${lane.name} unreachable for ${model}: ${error?.message ?? error}`,
    transportFailure: true,
  }
}

/**
 * 这次失败值不值得在桥内部换目标重试。
 *
 * 值得：限流、凭据失效、传输层失败、opencode-only——都是「换个模型或换个车道就能成」。
 * 不值得：地区门、模型没被路由、内容非 JSON——换目标也解决不了，重试只是把同一个
 * 错误再问一遍，白等一个 RTT。
 *
 * @param {object} failure upstreamFailure 或 transportFailure 的返回值
 * @param {string} model 模型名
 * @param {object} ids 已铸好的身份，含 tried 集合
 * @returns {boolean}
 */
function worthFailoverTo(failure, model, ids) {
  if ((ids.tried ?? []).length >= MAX_FAILOVER_HOPS) return false
  return failure.status === 429 ||
    failure.authFailure === true ||
    failure.transportFailure === true ||
    // 空完成也值得换：另一个车道/模型多半能正常答，换一个比回空强。
    failure.emptyCompletion === true ||
    failure.transient === true ||
    (failure.status === 403 && KNOWN_OPENCODE_ONLY.has(model))
}

/**
 * 换到下一个没试过的目标重试。
 *
 * `tried` 集合是**必须**的：没有它，一次 429 会把每条车道按顺序试一遍再从头来一遍。
 * 加上之后，每个 `lane:model` 最多被打一次，调用方等的是一次回答而不是一轮探测。
 *
 * @param {object} lane 刚失败的车道
 * @param {string} model 刚失败的模型
 * @param {object} body 下游请求体
 * @param {object} ids 已铸好的身份
 * @param {object} failure 刚拿到的失败对象，用于日志
 * @returns {Promise<object>} 下一个目标的补全结果
 */
function failover(lane, model, body, ids, failure) {
  const visited = new Set((ids.tried ?? []).map(entry => `${entry.lane}:${entry.model}`))
  visited.add(`${lane.name}:${model}`)

  const next = pickUntried(LANES, visited)
  if (next === undefined) return failure
  log(`${lane.name}/${model} unusable (${failure.status}); retrying on ${next.lane.name}/${next.model}`)
  return complete(next.lane, next.model, body, {
    ...ids,
    tried: [...visited].map(parseVisited),
  })
}

/**
 * 把 `lane:model` 拆回结构，好让 complete 继续累加 tried 集合。
 *
 * 模型名本身可以含冒号之外的分隔符，但不含冒号——lane 名是用户给的，也不该含。
 * @param {string} key
 * @returns {{lane: string, model: string}}
 */
function parseVisited(key) {
  const idx = key.indexOf(':')
  return idx === -1 ? { lane: key, model: '' } : { lane: key.slice(0, idx), model: key.slice(idx + 1) }
}

/**
 * 按队列顺序找第一个**还没试过**的目标。
 *
 * 与 `firstWithCapacity` 共用同一条 `queueTargets` 队列，所以「首选」和
 * 「故障转移」看到的是同一个顺序——旧实现里两者用了不同的遍历，于是
 * 首选挑了一个模型、失败后故障转移又从另一个顺序的头上开始，可能把刚失败的
 * 那个再试一遍。统一到一条队列就没有这个缝隙了。
 *
 * @param {object[]} lanes 车道列表
 * @param {Set<string>} visited 已试过的 `lane:model`
 * @returns {{lane: object, model: string}|undefined}
 */
function pickUntried(lanes, visited) {
  for (const { lane, model } of queueTargets(lanes)) {
    if (visited.has(`${lane.name}:${model}`)) continue
    if (inCooldown(lane, model)) continue
    return { lane, model }
  }
  return undefined
}

/**
 * 一次请求最多换几次目标。
 *
 * `tried` 集合负责「不打转」——每个 `lane:model` 最多被打一次。这个上限是第二道
 * 保险，防止「车道 × 候选」乘积很大时（主车道 6 个候选 × 3 条备用车道）走太久。
 * 之前设成 4，结果主车道全挂时走了 5 个候选就被砍掉，根本没轮到备用车道——
 * 上限的作用是「兜底」而不是「限速」，所以要给得比最坏情况更宽。
 *
 * 默认 16：足够走完 6 个主车道候选 + 几条备用车道，同时仍然给调用方一个明确的等待边界。
 */
const MAX_FAILOVER_HOPS = Number(process.env.MAX_FAILOVER_HOPS || 16)

async function fetchUpstream(lane, model, payload, ids, stream) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    return await fetch(`${lane.baseUrl}${endpointFor(lane, model)}`, {
      method: 'POST',
      headers: gatewayHeaders(lane, { ...ids, stream }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch (error) {
    // 网络层失败（DNS/连接被拒/超时）也是一种「换条车道也许能成」的情况。
    // 归一成 502 并标记出来，让 complete 去做故障转移。
    throw Object.assign(new Error(`lane ${lane.name} transport failure: ${error?.message ?? error}`), {
      laneTransportFailure: true,
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
    // 报出每条车道各自还有多少容量。这是多车道唯一有意义的可观测面——
    // 单车道时「available」是一个布尔值，多车道时必须能看出是哪条满了。
    const summary = cooldownSummary()
    json(res, 200, {
      ok: true,
      service: 'free-llm-bridge',
      lanes: LANES.map(lane => ({
        name: lane.name,
        model: lane.model,
        baseUrl: lane.baseUrl,
        available: laneHasCapacity(lane),
        // 报的是**过滤后**的候选数（免费档、且没被实测排除）。报上游原始清单长度
        // 会让人以为有 86 个可用的候选，而实测能直连的只有 1 个。
        candidates: candidatesFor(lane).length,
        strictSchema: lane.strictSchema === true,
        sessionScoped: lane.sessionScoped === true,
      })),
      models: availableModels.length,
      throttled: summary.targets,
      retryInSec: summary.soonestSec,
      uptimeSec: Math.floor(process.uptime()),
      // 哪些模型会被自动关思考。这是「同样一个模型，快 5 倍还是慢 5 倍」的分水岭，
      // 必须能从 health 一眼看出来，否则调优时只能靠翻日志。
      thinkingOffModels: [...THINKING_OFF_MODELS],
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

  // 点名了付费模型、或所有车道都在冷却：如实回错，绝不静默改投付费档。
  if (decision.error !== undefined) {
    if (requested !== '' && !isFreeModel(requested)) {
      openAiError(res, 400, 'invalid_request_error', decision.error)
      return
    }
    const { soonestSec } = cooldownSummary()
    const soonest = soonestSec > 0 ? soonestSec : 60
    res.writeHead(429, { 'retry-after': String(soonest), 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: {
        message: `${decision.error}; retry in ${soonest}s, or add another free lane via the LANES env var`,
        type: 'rate_limit_error',
        param: null,
        code: null,
      },
    }))
    return
  }

  const { lane, model: target } = decision
  if (target !== requested) log(`routing ${requested} -> ${lane.name}/${target} (requested is throttled or unavailable)`)

  // complete 内部会把限流、凭据失效、传输层失败都转成跨车道故障转移，
  // 所以到这里通常已经是最终结果。catch 只是防止意外抛错变成裸 500。
  let outcome
  try {
    outcome = await complete(lane, target, body, { session, requestId })
  } catch (error) {
    openAiError(res, 500, 'server_error', `unexpected bridge failure: ${error?.message ?? error}`)
    return
  }

  if (outcome.ok === true) {
    // 用**实际服务这次请求**的车道与模型回包，而不是最初选中的那个。
    // 故障转移之后这两个可能已经变了——照着最初选中的报，就是在告诉调用方
    // 「你用的是 A」，而实际跑的是 B。这个谎会让人无法排查质量问题，
    // 也让「按模型归因的账单」对不上。
    json(res, 200, {
      ...outcome.payload,
      model: outcome.model ?? target,
      system_fingerprint: `free-llm-bridge/${outcome.lane ?? lane.name}`,
    })
  } else if (outcome.ok === 'stream') {
    await pipeStream(outcome.response, res, target)
  } else {
    const retryAfter = cooldownRemainingSec(lane, target)
    // 上游的失败信息说的是「哪条车道被限流了」，而调用方需要知道的是「你该怎么办」。
    // 全车道不可用时补一句可执行的建议，否则用户只能看着一句 lane/model 干瞪眼。
    const hint = outcome.status === 429 && LANES.length < 2
      ? ' — every free lane is currently rate limited; add a second lane via the LANES env var (see README)'
      : outcome.status === 429 && LANES.length > 1
        ? ' — every configured lane is currently rate limited'
        : ''
    const message = `${outcome.message}${hint}`
    if (retryAfter > 0) {
      res.writeHead(outcome.status, { 'retry-after': String(retryAfter), 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message, type: outcome.type, param: null, code: null } }))
    } else {
      openAiError(res, outcome.status, outcome.type, message)
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
  const ids = new Set()
  // 队列哨兵排第一：它是**推荐**的用法（让桥按实测队列挑，而不是钉死一个模型）。
  // 不列出来，调用方根本不知道有这条路，于是继续钉死单个模型、继续每次先撞限流。
  ids.add(QUEUE_SENTINEL)
  for (const lane of LANES) {
    if (isFreeModel(lane.model) && !KNOWN_REGION_BLOCKED.has(lane.model)) ids.add(lane.model)
    for (const model of candidatesFor(lane)) ids.add(model)
  }
  return [...ids].map(id => ({ id, object: 'model', created: 0, owned_by: 'free-lane' }))
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
  for (const lane of LANES) {
    const key = lane.apiKey === undefined || lane.apiKey === '' ? 'no API key needed' : 'with key'
    log(`lane "${lane.name}": ${lane.model} @ ${lane.baseUrl} (${key})`)
  }
  if (LANES.length === 1) {
    log('only one lane configured - a rate limit here stops the bridge; see README on adding more via LANES')
  }
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

/**
 * 启动时探一次主车道的模型清单。探不到就退回内置顺序，不阻塞服务可用。
 *
 * 只探主车道：备用车道通常就一个已知模型，为它花一次请求不值当。
 */
async function refreshModels() {
  const session = ensureSession('__probe__')
  const requestId = requestIdFor(session, 'probe')
  let rows = []
  try {
    const response = await fetch(`${PRIMARY_LANE.baseUrl}/zen/v1/models`, {
      method: 'GET',
      headers: gatewayHeaders(PRIMARY_LANE, { session, requestId, stream: false }),
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
  if (rows.length > 0) log(`probed ${rows.length} models on lane "${PRIMARY_LANE.name}"`)
  else log('lane probe returned nothing; using the built-in candidate order')
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
