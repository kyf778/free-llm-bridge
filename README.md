# free-llm-bridge

[![CI](https://github.com/kyf778/free-llm-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/kyf778/free-llm-bridge/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**把任意 OpenAI 兼容应用接到一条免密、零成本、无限量的 LLM 车道上。**

为 [Hindsight](https://github.com/vectorize-io/hindsight) 这类记忆系统而写——它每轮对话后
自动跑 4 个 LLM 环节（事实提取 / 整合 / 知识页刷新 / 反思），按商业 API 计费两天能烧掉八块钱。
现在这些调用的费用是 **0**。

- 零依赖、单文件，只需要 Node `>= 22.19`
- **不需要 API key、不需要注册、不需要充值**
- 只服务免费档模型：付费模型被点名时直接 400 拒绝，绝不静默改投
- **支持多条车道**：一条限流/连不上自动换下一条，可扩展
- 会话亲和，让免费额度按会话计而不是按请求计

```bash
node index.js
# [free-llm-bridge] listening on http://127.0.0.1:18999/v1
# [free-llm-bridge] upstream: https://opencode.ai (免密车道，无需 API key)
# [free-llm-bridge] probed 86 models: ...
```

在应用里填：

| 字段 | 值 |
| --- | --- |
| `base_url` | `http://127.0.0.1:18999/v1` |
| `api_key` | `local`（任意非空字符串，桥不使用它） |
| `model` | **`free-queue`**（推荐）或 `/v1/models` 里任何一个 |

## 为什么推荐填 `free-queue`（队列哨兵）

多数调用方（Hindsight 就是）**只有一个「模型名」配置项**，于是每轮都点名同一个模型。
而免费车道的可用面**每 90 分钟就变一次**（限流窗口）——被钉死的那个迟早会撞上限流，
然后**每个请求都要先失败一次**才换到别的。

点名 `free-queue` 等于告诉桥「你看着办」：

- 桥按**实测队列**取当前第一个有容量的模型；
- 被限流的**直接跳过**，一个 RTT 都不浪费；
- 队列是**跨车道的一条线**，不是每条车道各排各的。

`free-queue` 也列在 `/v1/models` 的第一位。想钉死某个具体模型也行——
只要它是免费档，桥就尊重你的点名。

---

## 多车道：把单点变成可扩展

**默认只有一条车道（免密的 OpenCode Zen），而它实测只有一个模型能用——也就是说开箱即用是单点。**
这个模型被打满，整条路线就停。所以第二条车道不是锦上添花，是这条路线的可用性下限。

用环境变量 `LANES` 加，不用改代码：

```bash
# 智谱 GLM-4-Flash-250414，官方页明写「智谱首个免费的大模型 API」
# https://docs.bigmodel.cn/cn/guide/models/free/glm-4-flash-250414
export LANES='[
  {"name":"glm","baseUrl":"https://open.bigmodel.cn/api/paas/v4",
   "model":"glm-4-flash-250414","apiKey":"你的免费key"},
  {"name":"zen","baseUrl":"https://opencode.ai","model":"space-bunny-free",
   "headers":{"user-agent":"opencode/1.18.31","x-opencode-client":"desktop"},
   "fingerprintTools":true,"sessionScoped":true,"normalizeSchema":true,"strictSchema":true}
]'
node index.js
```

⚠️ **配了 `LANES` 就不再自动带内置免密车道**——你配什么就是什么。
需要两条都用就把 `zen` 也一起写进去（像上面那样）。

每条车道的字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | ✅ | 出现在日志与 `/health` 里 |
| `baseUrl` | ✅ | 到 `/chat/completions` 的前缀 |
| `model` | ✅ | **必须是确认免费的那一档**。填错付费模型名 = 静默把账单接回去 |
| `apiKey` | | 不填则用 `Bearer public`（那是 OpenCode 免密车道的凭据） |
| `keyless` | | `true` 表示**这条车道不需要任何凭据**，连 `Bearer public` 也不发 |
| `headers` | | 该家要求的额外请求头 |
| `knownFree` | | 声明 `model` 是免费档，即使 id 不以 `-free` 结尾 |
| `knownFreeModels` | | 一组已知免费 id，让车道能声明**多个**候选（见下面的 Kilo 例子） |
| `sessionScoped` | | true 才发 `x-opencode-session`（按 session 计额的才需要） |
| `fingerprintTools` | | true 才补 `bash/glob/grep/read` 四件套 |
| `strictSchema` | | true 才发 `response_format`（不支持的会 400） |
| `normalizeSchema` | | true 才剥掉 nullable 联合类型 |
| `pathStyle` | | `"openai"` 表示标准 `/chat/completions`；省略则按模型分流 |

### 第二条免密车道：Kilo AI

除了 OpenCode Zen，**Kilo AI 也是一条完全不需要 key 的车道**，免费池里有 17 个模型
（`isFree: true`）。它的 id 形如 `org/model:free`，不以 `-free` 结尾，所以要用
`knownFreeModels` 显式声明：

```bash
export LANES='[
  {"name":"zen","baseUrl":"https://opencode.ai","model":"space-bunny-free",
   "headers":{"user-agent":"opencode/1.18.31","x-opencode-client":"desktop"},
   "fingerprintTools":true,"sessionScoped":true,"normalizeSchema":true,"strictSchema":true},
  {"name":"kilo","baseUrl":"https://api.kilo.ai/api/gateway",
   "model":"liquid/lfm-2.5-2.6b:free",
   "knownFree":true,"keyless":true,"pathStyle":"openai",
   "knownFreeModels":[
     "liquid/lfm-2.5-2.6b:free",
     "nvidia/nemotron-3-super-120b-a12b:free",
     "kilo-auto/free",
     "cohere/north-mini-code:free",
     "dots-studio/dots-3-note-preview:free",
     "poolside/laguna-s-2.1:free"
   ]}
]'
```

> ⚠️ `keyless` 不是可选的装饰：**OpenCode 用 `Bearer public` 表示"免密"，
> 但把同一个头发给 Kilo 会得到 `401 INVALID_TOKEN`**——上游把无效凭据当成登录失败。
> 一条车道若真的不需要认证，必须显式声明，光靠"没填 apiKey"推断是不够的。
>
> 名单里那 6 个已按实测中位延迟排序（5.5s → 8.8s）。Kilo 免费池里还有
> `stepfun/step-3.7-flash:free` 等，但实测**输出被思维链占满或不接受 json_schema**，
> 对 Hindsight 这种要结构化 JSON 的调用不合适，故未列入。


`/health` 逐条报出每辆车道还有没有容量：

```bash
curl -s localhost:18999/health | jq '.lanes'
```

故障转移顺序：**先在同一条车道内换模型**（凭据、能力、schema 策略都不变），
**换不动了再换车道**。每个 `lane:model` 最多被打一次，总跳数有上限，不会打转。

触发换目标的失败类型（2026-10-06 补齐，此前有漏项导致"一个不行就换下一个"在最常见的
失败模式下**不生效**）：

| 失败 | 是否换目标 | 说明 |
| --- | --- | --- |
| 429 限流 | ✅ | 冷却时长取上游 `retry-after`，封顶 6 小时 |
| 传输层失败 | ✅ | DNS/连接被拒/超时 |
| 凭据失效 401/403 | ✅ | 换车道才有用 |
| `403 opencode-only` | ✅ | 该模型只对 OpenCode 内部开放 |
| **上游 5xx** | ✅ | **曾漏判**：上游回 500 时桥直接放弃、不换下一个 |
| **空完成** | ✅ | **曾漏判**：200 但正文为空（静默失败）也会停下不换 |
| 地区门 403 | ❌ | 换目标解决不了，如实上报 |

上面两个"曾漏判"是同一类 bug：`worthFailoverTo()` 的清单里没有它们，
而调用点又直接 `return`，于是链会停在一个明显该跳过的目标上。


---

## 它在做什么

上游是一个公开的免密车道（OpenCode Zen 网关），13 个模型的 id 以 `-free` 结尾。

> ⚠️ **但 `-free` 不等于「第三方能直接用」。** 逐个实测（`node scripts/probe-free-models.mjs`）
> 后发现，13 个里**只有 `space-bunny-free` 能直连调用**。另外 4 个
> （`fledge-alpha-free`、`nemotron-3-*`、`longcat-2.5-preview-free`）返回
> `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`
> —— 上游按**调用来源**做了硬限制，不是请求头问题（对照实验：`space-bunny-free`
> 不带任何指纹头也能成功）。其余几个是限流或地区受限。
>
> 所以「11 个模型随便挑」是不成立的，请读 [下面的已知边界](#已知边界)。
桥把那条车道封装成一个标准的 OpenAI 兼容服务，并解决四个让它能真正**持续**使用的问题。

### 1. 会话亲和 —— 最关键的一步

免费额度按 **session** 计。如果你每次请求都现造一个新 session id，上游看到的就是
「同一个客户端一瞬间开了成百上千个新会话」，判定为滥用，立刻回 429。

实测：第一次直接 curl 上游，每次请求一个随机 session，连发两次，本该好用的
`mimo-v2.6-flash-free` 就被限流了。

桥把「同一个下游使用方」稳定映射到「同一个上游 session」：

```js
const digest = sha256(`free-llm-bridge\0${HOST}:${PORT}\0${downstreamKey}`)
// → ses_<12hex><14base62>
```

上游于是看到一个正常的长期会话。同一回合的重试也共用 `request id`，所以重试不会被
当成新回合再计一次。

使用方标识优先取请求头 `x-session-id` / `x-conversation-id`；没有就用远端地址兜底——
同一个应用、同一条链路，在上游看来就是一个长会话。

### 2. 工具指纹门

上游要求请求里声明 `bash`、`glob`、`grep`、`read` 四个工具名，否则 403 `FreeTierError`。
批处理场景没有真实工具，于是桥补齐四个**自禁用诱饵**（描述写明
"This tool is currently unavailable and must not be used."），模型即使去调也不可用。

同时把 `Bash`+`bash` 这类大小写重复声明规范化成一个——上游会直接拒绝重复。

### 3. 免费档故障转移

上游 `/zen/v1/models` 返回 **86 个模型**，其中绝大多数是按量计费的付费档
（`gpt-5`、`claude-opus-5`、`mimo-v2.6-flash` 非 free 档……）。

所以候选池必须硬性过滤：

```js
function isFreeModel(model) {
  return model.endsWith('-free')
}
```

- 点名了付费模型 → **400 拒绝**，并说明只有免费档可用。静默改投会让调用方以为自己
  用的就是它点名的模型，而实际跑的完全是另一回事。
- 点名的免费模型被限流 → 沿内置顺序换到下一个不在冷却中的免费档
- 免费档全被限流 → 429，并带 `retry-after` 告诉调用方最短要等多久

这条保证有 5 条回归断言钉在 `test-free-only.mjs` 里，改动请先跑它。

### 4. 读流不看 header

上游在高负载下会用 `content-type: application/json` 回一整套 SSE 帧。信 header 就会把
整条流读成字符串、`JSON.parse` 失败、整轮报废。桥按 content-type 判断非流式、按其余情况
走流式透传，并在结束时补一个 `[DONE]`。

---

## 关掉思考 —— 这条车道上最大的一笔速度浪费

免费档的**思考 token 与正文共享同一个 `max_tokens` 预算**。像「从一段对话里抽取事实」
这种轻任务，模型却要先想几千 token 才吐正文——这才是单次调用动辄几十上百秒的真正原因。

桥会在请求里补上关闭思考的参数，但**只给实测接受的模型补**。

### 参数形状是嵌套的，不是扁平的

```js
{ reasoning: { enabled: false } }     // ✅ 正确
```

扁平的 `reasoning_effort` / `enable_thinking` / `thinking` **形状不对**：对部分车道直接
502，对另一些被静默忽略（`reasoning_tokens` 照旧）。这个形状与 Our Free Model 插件
catalog 里每个模型的 `effortOffPatch` 一致。

### ⚠️ 绝不能全局施加

上游对思考参数的处理**因模型而异**。同一份补丁：

| 模型 | 加 `{"reasoning":{"enabled":false}}` |
| --- | --- |
| `nvidia/nemotron-3-super-120b-a12b:free` | ✅ 200，`reasoning_tokens` 41 → **0** |
| `cohere/north-mini-code:free` | ✅ 200，rt 32 → **0** |
| `nemotron-3.5-lightning-free` | ✅ 200，rt 136 → **0** |
| `kilo-auto/free` | ⚠️ 200 但 rt 仍 54（关不干净） |
| **`liquid/lfm-2.5-2.6b:free`** | ❌ **502** |

最后一行是教训的来源：上游原文 `Reasoning is mandatory for this endpoint and cannot be
disabled`。桥是**跨车道故障转移**的，一个全局参数最终会打到任意模型上——那等于用
一个模型的方言去毒另一个模型。实测把思考参数写进 Hindsight 的全局 `EXTRA_BODY` 后，
原本能成功的 `liquid` 调用开始成片 502。

所以桥维护一张**实测通过**的名单 `THINKING_OFF_MODELS`，并按**本次实际目标模型**施加：
故障转移换模型后会重新判定。

### 收益（2026-10-06 实测，Hindsight 真实负载）

| 环节 | 改造前 | 改造后 | 思考 token |
| --- | --- | --- | --- |
| `retain_extract_facts` | 431.3 s | **51.1 s** | 3195 → **0** |
| `consolidation` | 199.5 s | **36.3 s** | 3915 → **0** |

`/health` 里的 `thinkingOffModels` 会报出当前哪些模型在名单里。

重新验证：`node scripts/probe-thinking.mjs`

---

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 存活探针，无需 key |
| `GET` | `/v1/models` | 只列免费档模型 |
| `POST` | `/v1/chat/completions` | 流式与非流式 |

> `/v1/responses` **没有实现**。上游确实有 `/zen/v1/responses` 这条线（`muse-spark-*`
> 系列走它），但桥目前只暴露 chat/completions。Hindsight 用的是 chat/completions，
> 所以不影响本项目的目标场景。要用 Responses 形状的客户端请开 issue。

非 `/health` 的路由都接受任意非空 `Authorization`——本地自用没有会话，桥不校验它。
**如果你要把桥暴露到局域网，请自己在前面加一层认证**，或至少用防火墙限制来源。

### 可选请求头

| 头 | 作用 |
| --- | --- |
| `x-session-id` | 标识「同一个使用方」，影响上游 session 亲和 |
| `x-request-id` | 标识「同一个回合」，同 id 的重试在上游算同一回合 |

---

## 测试

```bash
node test-free-only.mjs   # 零成本保证 + 会话亲和 + 指纹门 + schema 规整 + 关思考 + 队列哨兵 + 文档一致性。不出网，秒级
node test-multilane.mjs   # 多车道故障转移。起两个本地假上游，不出网，秒级
node test-degradation.mjs # 全部车道不可用时的降级行为。不出网，秒级
node smoke.mjs            # 端到端。真打上游，会消耗免费额度
node soak.mjs             # 持续性 + 故障转移。真打上游
node scripts/probe-thinking.mjs  # 免费模型分诊。真打上游，会消耗一点免费额度
```

`scripts/probe-thinking.mjs` 是**换模型/调队列时的第一步**：它一次量完直连命中率、
延迟 p50、思考可否关、JSON 合规四项，并在末尾输出**可直接照抄进 `index.js`** 的名单
（哪些能关思考、哪些加了会 502、哪些本轮直连可用）。

⚠️ 它只测「直连命中」而不是单次延迟——**单次延迟会骗人**。曾把某模型的一次 931ms
误判为「快 100 倍」，随后 20 连发全部被路由走（429）。命中率才是可靠的。

前三条都不出网（全部用本地 mock 上游），`npm test` 会依次跑完。
CI 对每个 push 和 PR 都在 **Node 22.19 / 24.x 两个版本**上跑这套断言——
它们不需要任何 secret，因为根本不打真实网络。上方徽章是实跑的，不是摆设。

`test-multilane.mjs` 值得单独说一句：**多车道逻辑没法只靠真实上游验证**，
因为真实免密车道只有一个模型能用，主车道限流之后根本没有第二条真实车道可换。
所以它起两个本地假上游，按剧本返回 429 / 401 / 连不上，断言调用方看到的是**一次成功**
而不是一次错误。同时它检查每条车道的标志真的按车道生效——备用车道确实没收到
`response_format` 与四件套诱饵，主车道确实收到了。

`test-degradation.mjs` 盯的是「零成本」的**危险失败模式**：不是不停地失败（那看得见），
而是**假装成功**。实测发现上游在 `json_schema` 不带 `strict` 时会回 200 但 content 为空——
放过它的话，Hindsight 的 retain 会「成功」地抽出零条事实，记忆看起来在工作，
实际什么都没存，且没有任何地方报错。桥现在把空完成降级成一次明确失败，
让它走故障转移或如实上报。

其中有一条**文档一致性断言**：README 的 API 表格里写的每个端点，必须在 `index.js` 里
真的有对应路由。这条是为一个真实缺陷写的——README 曾经列出 `POST /v1/responses`，
而实现里根本没有这条路由。文档承诺了代码不做的事，后来加了断言把两者钉在一起。

### 量一下你省了多少钱

```bash
node scripts/cost-analysis.mjs [hindsightUrl] [bankId]
```

从 Hindsight 自己的 `/llm-requests` 接口读真实用量，按单价换算成钱，并与免费方案对比。
只读，不改任何东西。某个真实部署的实测：改造前 ¥10.87/天（约 ¥2154/年），改造后 ¥0。

---

## 给 Hindsight 用

见 **[docs/hindsight-setup.md](docs/hindsight-setup.md)**。推荐形态是**把桥容器化进
Hindsight 的同一个 compose**（无窗口、开机自启、端口不发布、电脑可关机），最小改动：

```yaml
environment:
  HINDSIGHT_API_LLM_PROVIDER: openai
  # 同一 compose 里的桥用服务名直连；桥跑在别的机器上时换成那台机器的局域网 IP
  HINDSIGHT_API_LLM_BASE_URL: http://free-llm-bridge:18999/v1
  HINDSIGHT_API_LLM_API_KEY: local
  HINDSIGHT_API_LLM_MODEL: space-bunny-free
  # ⚠️ 必须显式写成 postgresql://，并配下面的 entrypoint 包装脚本。
  # 这两件事必须成对出现，缺一不可——原因见 setup 文档排错 FAQ 第一条。
  HINDSIGHT_API_DATABASE_URL: postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight
```

内嵌 postgres 必须**有人明确负责启动**，所以 Hindsight 服务还要加一个入口包装：

```yaml
  entrypoint: ["/bin/bash", "/app/start-hindsight.sh"]
  volumes:
    - hindsight-data:/home/hindsight/.pg0
    - ./start-hindsight.sh:/app/start-hindsight.sh:ro   # 来自本仓库 deploy/
```

脚本见 [`deploy/start-hindsight.sh`](deploy/start-hindsight.sh)：它启动 postgres、轮询到
真的 `running: true` 再把控制权交给官方入口。**两个都配**才是稳定形态；
只配 `pg0://` 或在别处启动 postgres，都会在容器重建后进入启动死循环。

桥也可以跑在自己电脑上（双击 `启动桥.cmd`），但那是备选：要开窗口、要配防火墙、
电脑关机记忆就停。跨机器时 `host.docker.internal` 是**错的**——它指向 Hindsight
所在那台机器的宿主机。实测细节见 setup 文档。

另外记得放宽超时。`EXTRA_BODY` 用 `max_tokens` 兜输出上限——**别放 `thinking`**，
那是米莫的方言参数，实测免费车道对它回 400（而且 EXTRA_BODY 会合并进每一次 LLM 调用）：

```yaml
  HINDSIGHT_API_LLM_EXTRA_BODY: '{"max_tokens":4096}'
  HINDSIGHT_API_LLM_TIMEOUT: 600
```

---

## 配置项

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址。改成 `0.0.0.0` 前请先想清楚谁会用到你的额度 |
| `PORT` | `18999` | 监听端口，也可用 `--port` |
| `UPSTREAM_BASE` | `https://opencode.ai` | 上游车道 |
| `UPSTREAM_TIMEOUT_MS` | `600000` | 单次上游请求的上限。免费车道思考期可能静默很久 |
| `MAX_FAILOVER_HOPS` | `16` | 一次请求最多换几次目标。防打转的第二道保险 |
| `DEFAULT_THROTTLE_SEC` | `5400` | 上游没给 `retry-after` 时的保守退避（实测这批免费模型的限流窗口就在 90 分钟量级） |
| `MAX_THROTTLE_SEC` | `21600` | 退避上限。一个写错的 `retry-after: 999999` 不该让模型永远消失 |

---

## 已知边界

> 这一节请认真读。这个项目最容易被误解的地方全在这里，而且**大部分结论都是我实测出来的，
> 不是从上游文档或插件 README 抄的**——两者在关键一点上不一致（见下）。

- **⚠️ 「哪些模型可用」是时效性的，别凭记忆改。** 上游限流窗口约 90 分钟，可用面会来回变。
  2026-10-06 复测就推翻了两条旧结论：
  - 旧结论「同一时刻只有 `space-bunny-free` 可直连」→ 实测 `space-bunny-free` **0/4**，
    而 `nemotron-3.5-lightning-free` 4/4、`nvidia/nemotron-3-super-120b-a12b:free` 4/4。
  - 旧结论「`fledge-alpha-free` / `nemotron-3-ultra-free` / `nemotron-3.5-lightning-free` /
    `longcat-2.5-preview-free` **永久** 403 opencode-only」→ 其中三个**上游已放开**
    （3/4、3/4、4/4 直连成功）。所以这里**不再硬编**「谁是 opencode-only」；
    桥在运行时遇到 403 才把它摘掉，`test-free-only.mjs` 验的也是这个机制而非名单。

  **重排队列或改关思考名单之前，先跑 `node scripts/probe-thinking.mjs`。**
- **⚠️ 429 不是永久失效。** 限流带 `retry-after: ~5400s`（90 分钟量级），
  实测真实递减（`5425 → 5416 → 5405`），即**速率限制、到点自动恢复**。
  桥尊重上游给的时长而不是一律 60 秒——否则会在一个半小时的窗口里反复撞同一面墙。
  复现：`node scripts/probe-throttled-depth.mjs`、`node scripts/probe-retry-after.mjs`。
- **⚠️ 别再找别的免密白嫖了，真没有了。** 实测 11 家（`node scripts/probe-keyless.mjs`）：
  只有 OpenCode 与 Kilo 这两家不带 key 也能调；智谱、OpenRouter、SiliconFlow、Kimi、
  Cerebras、Groq、NVIDIA、Cloudflare **全部要 key**。顺带确认 `/zen/go/v1` 这条路径也回
  `401 Missing API key`——它是计费路径，不是第二条免密车道。
  **所以「多几条车道」的现实形态是自己注册免费 key**，见上面「多车道」。
- **故障转移走的是同一条队列。** 桥把所有车道的所有免费模型排成**一条线**
  （`QUEUE_ORDER` / `queueTargets`），「首选」和「故障转移」用的是同一个顺序——
  旧实现里两者遍历顺序不同，于是首选挑了一个、失败后又从另一顺序的头上开始，
  可能把刚失败的再试一遍。每个 `lane:model` 最多一次，总跳数上限
  `MAX_FAILOVER_HOPS`（默认 16）。
- **⚠️ 智谱（`glm`）只做兜底，别当主力。** 它的免费额度有限且有期限，
  所以 `QUEUE_ORDER` 里**故意没有它**——它只作为独立车道排在所有免费车道之后，
  用于「所有免费模型都暴毙」的场合。
- **插件的探测结果会骗人。** `dsh-our-free-model` 的设置页显示那些模型「available」，
  但那是它在 DSH 进程里探测的——上游把它当成 OpenCode 内部流量。**第三方工具照抄这个
  清单会踩空。** 想确认就自己跑 `node scripts/probe-free-models.mjs`。
- **`/v1/models` 列的是「免费且未被实测排除」的模型**，不等于「此刻一定能用」。
  限流与地区门是运行时的，探测不出来。
- **「免费」不等于「无限」。** 这条车道按 session 限速，短时间打满会回 429。
- **地区门。** 部分模型对某些地区的出口直接 403（实测 CN 出口下 `muse-spark-1.3/1.2-contributor-free`
  被挡）。桥把这些模型排除在候选池外。
- **结构化输出需要桥做规整。** 免费车道的语法引擎拒绝 nullable 联合类型
  （`{"type": ["string", "null"]}`），而 Hindsight 的 `FactExtractionResponse` 有 4 个这样的字段。
  桥会自动降级成非 null 分支并强制 `strict: true`。**你自己写 schema 时也要注意：
  用 `anyOf` 或可空分支代替联合类型可以避开这个问题。**
- **语法强制不是 100% 可靠。** 实测同一个模型 + 同一个 schema，输出时而干净、时而带
  ```json 围栏。所以**调用方仍应容错**：剥围栏再 `JSON.parse`。Hindsight 自己的解析器
  会做这件事，但你的代码未必。
- **免费档会变。** 模型集合与额度政策由上游决定，随时可能调整。桥在启动时探测一次，
  但运行中新增的可用模型要重启才被发现。
- **上游哪天改成计费怎么办？** 桥在响应里看到非零 `cost` 字段时会打 WARNING 日志。
  这是被动发现，不是主动保证——**请自己看一眼账单**。
- **桥也会拒绝「假成功」。** 上游回 200 但正文为空时，桥降级成一次明确失败而不是照传。
  否则调用方会以为成功——实测这正是 `json_schema` 不带 `strict` 时的真实行为。
- **桥不做重试。** 它把故障转移交给调用方决定（因为只有调用方知道该不该重试）。
  Hindsight 侧建议 `HINDSIGHT_API_LLM_MAX_RETRIES=2`。
- **局域网暴露 = 把额度送人。** 桥默认只绑回环。改成 `0.0.0.0` 之前请确认你的网络可信。

---

## 这不是轮子，是包装

免密免费车道的存在方式和逆向过程，由 [dsh-our-free-model](https://github.com/zouyuxuan122/dsh-our-free-model)
（MIT）完整公开——它的 README「上游是哪些源」一节把凭据、指纹头、会话计额全部写清楚了。
本项目做的事只有一件：**把那条车道从 DSH 插件里解耦出来，变成一个能独立运行、
能被 NAS 容器使用的服务**。

原插件的转发端口（`127.0.0.1:18899`）活在 DSH 进程里，DSH 一关额度就没了，NAS 上的容器
也够不着。本项目补的就是这一段。

---

## 备用路线（这条车道失效时）

按优先级：

1. **OpenRouter `:free` 模型** —— 注册即用，OpenAI 兼容，`/api/v1`。有每日请求数上限，
   但比单车道稳得多。
2. **Google Gemini API 免费层** —— `generativelanguage.googleapis.com`，有永久免费配额。
3. **本地 Ollama + 小模型** —— 真·永远免费。J1800 这类弱 CPU 上建议 3B–4B 量化模型，
   配 `HINDSIGHT_API_LLM_PROVIDER=ollama`。质量会下降，但账单永远是零。

详见报告里的对照表。

---

## 许可

MIT
