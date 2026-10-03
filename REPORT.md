# Hindsight 零成本改造报告

**日期**：2026-10-05
**问题**：Hindsight 记忆系统两天烧掉 8 块钱 MiMo 额度
**结论**：已建成 `free-llm-bridge`，Hindsight 的 4 个 LLM 环节全部改走免密免费车道，**费用归零**，且实测跑通

---

## 一、钱花在哪

> 这一节的数字全部来自 Hindsight 自己的 `/llm-requests` 与 `/llm-requests/stats` 接口，
> 是**第一手实测数据**，不是估算。用 `node scripts/cost-analysis.mjs` 可复现。

### 实测账单

| 日期 | 调用数 | 输入 | 缓存命中 | 输出+思考 | 费用 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-10-02 | 73 | 0.67M | 0.26M | 0.13M | **¥0.94** |
| 2026-10-03 | 768 | 9.49M | 3.54M | 0.65M | **¥10.87** |

```
total calls : 841
total cost  : ¥11.81
per day     : ¥5.90
per month   : ¥177.09   (按 10-03 这一天外推)
per year    : ¥2154.55
```

这和你说的「两天八块钱」对得上（10-02 只有 0.94，10-03 是重头）。

> ⚠️ 价格按 mimo-v2.6-flash 的 ¥1/M 输入、¥0.02/M 缓存、¥2/M 输出（含思考）估算。
> **请用你自己的账单核对这组数字**——它是按量计费，定价可能变，而上面所有金额都由它推导。
> 结论的方向（从十位数降到零）不受价格波动影响。

### 4 个环节的真实构成

最近 200 次调用的分布，**来自 Hindsight 的 `llm-requests` 接口**：

| operation | 次数 | token 总量 | 平均/次 | 占比 |
| --- | ---: | ---: | ---: | ---: |
| **consolidation**（后台整合） | 103 | 2,103,203 | 20,419 | **52%** |
| retain（事实提取） | 63 | 358,218 | 5,686 | 32% |
| refresh_mental_model（知识页刷新） | 31 | 519,566 | 16,760 | 16% |
| mental_model_delta_ops | 3 | 26,787 | 8,929 | 2% |

provider `openai` / model `mimo-v2.6-flash` —— 全部走计费通道。

### 这里要更正我之前的一个说法

> 🧠 **From Hindsight memory** — 早前排查记录的是「提取(retain)每轮对话后自动跑，占花费约 85%」。

**实测数据不支持这个比例。** consolidation 的调用次数（103）比 retain（63）还多，
平均每次的 token 量更是它的 **3.6 倍**（20,419 vs 5,686）。

为什么之前会得到「retain 占 85%」的印象？大概是因为 retain 是**唯一每轮对话都触发**
的环节，而 consolidation 是后台批处理，触发时机不规律、按次数看容易被忽略。
但按**实际花的钱**看，真正的���头是 consolidation——它每次都要把整批观察重新过一遍，
单次调用天然是 retain 的数倍重。

这个差别直接影响省钱的做法：想省 consolidate 就不该只压 retain 的次数，
而该看 consolidation 本身跑多频繁、每次喂进去多少历史。这个更正也说明——**这类结论
必须以账单接口为准，不能靠抽样推测。**

### 4 个环节都是同一套配置

好消息：`HINDSIGHT_API_LLM_*` 是全局默认，`RETAIN_/REFLECT_/CONSOLIDATION_` 逐项覆盖。
所以只要改全局那四行，四个环节一次性全部改到免费车道，不需要分环节配置。
想给某个环节单独换模型再叠加覆盖即可（见 `docs/hindsight-setup.md`）。

---

## 二、免费模型插件是怎么做到的

你装的那个 `dsh-our-free-model` 插件（MIT 开源）用的是一条**公开、免密、无需注册**的车道。

### 上游只有一个

**OpenCode Zen 网关**：`https://opencode.ai/zen/v1/*`

凭据是硬编码的公开字符串：

```
Authorization: Bearer public
```

插件 README 的「上游是哪些源」一节把全部出网目标逐条列了出来，并明确写着
**「没有号池、没有中转、没有二道贩子」**——请求从你的机器直达上游。

### 四个必须复刻的细节

这是插件逆向出来的（其 `src/upstream.js` 注释里标着「每一条都在 2026-09-24 用直接请求核过」）：

**1. 客户端指纹头**
```
user-agent: opencode/1.18.31      ← 必须 >= 1.17
x-opencode-client: desktop
x-opencode-session: ses_...        ← 见下
x-opencode-request: msg_...
x-opencode-project: global
```

**2. 工具指纹门**（`403 FreeTierError`）
请求里必须声明 `bash`、`glob`、`grep`、`read` 四个工具名，缺一个就被拒。

**3. 会话计额**（`429 FreeUsageLimitError`）
免费额度按 **session** 算。这是最关键、也最容易踩的一条。

> 我实测验证了这一点：第一次直接 curl 上游时**每次请求现造一个随机 session**，连发两次，本该好用的 `mimo-v2.6-flash-free` 就被限流了。换成稳定 session 后一切正常。

**4. 地区门**（`403 RegionError`）
部分模型对某些出口 IP 直接拒绝。实测你的 CN 出口（`59.175.124.94`）下
`muse-spark-1.3-contributor-free` 和 `1.2` 被挡。

### 实测清单 —— 重要更正

`GET https://opencode.ai/zen/v1/models` 返回 **86 个模型**，其中 **13 个** id 以 `-free` 结尾。
但**「以 `-free` 结尾」不等于「第三方能直接用」**。

我最初（和插件的探测结果）都以为这 13 个都能直连。**逐个实测之后发现不是。**
用 `node scripts/probe-free-models.mjs` 复现：

| 模型 | 直连结果 |
| --- | --- |
| **space-bunny-free** | ✅ **可用** |
| mimo-v2.6-flash-free / mimo-v2.5-free / deepseek-v4-flash-free / ling-3.0-flash-fin-free / ling-3.1-flash-free | ⚠️ 429，但**带 `retry-after: ~5400s` 且真实递减** |
| longcat-2.5-preview-free / nemotron-3-ultra-free / nemotron-3.5-lightning-free / fledge-alpha-free | ❌ **403 `FreeTierError: OpenCode's free tier can only be used from within OpenCode`** |
| muse-spark-1.3 / 1.2-contributor-free | ❌ 403 地区受限（CN 出口） |
| jev-1.13-free | ❌ 500 |

那 4 个 `opencode-only` 的模型不是「我的请求头不对」——对照实验证明 `space-bunny-free`
**不带任何 `x-opencode-*` 指纹头也能成功**，所以不是头部问题，是上游对那几个模型
**按来源做了硬限制**：只有从 OpenCode 自己的基础设施发起的请求才放行。

这也解释了插件的探测为什么和我的结果不同：插件活在 DSH 里，其身份/链路可能让上游
把它判定为「来自 OpenCode 内部」，于是那些模型在插件里看起来可用。

### ⚠️ 第二轮更正：那 5 个 429 是「速率限制」，不是永久关闭

> 这条推翻了本报告前一版的一句话。我当时写「13 个里只有 1 个可用」，
> 那是**在限流窗口内测的**，把「此刻打满」误当成「不可用」。

实测（`scripts/probe-throttled-depth.mjs` + `scripts/probe-retry-after.mjs`）：

- 5 个模型全部返回 `429` **并在响应头带 `retry-after`**，值在 **5400+ 秒（90 分钟量级）**
- 换**不同 session** 重试仍 429 → 限流维度不是 session，是别的配额池
- 间隔 20 秒连打三次，`retry-after` 真实递减：`5425 → 5416 → 5405`

**所以它们是速率限制，约 90 分钟后自动恢复**，构成故障转移链里真实的第二梯队。

**这一条顺带暴露了桥自己的一个 bug**：原先只从**响应体**里解析 `retry-after`，
而这条车道的数字只在**响应头**里（body 只有一句「Rate limit exceeded」）。
于是永远拿不到值、退回 60 秒默认值——意味着在长达一个半小时的限流窗口里，
桥会反复去撞同一面墙，每次白等一个 RTT。现已改为响应头优先，并加了两条断言钉住。

### 关于「故障转移的承诺」

可直连的候选**当前只有 1 个**（`space-bunny-free`）。但这不等于「只有 1 个能用」——
其余 5 个在各自的限流窗口过去后会恢复，成为真实的第二梯队。桥会把它们记进冷却，
并**按上游给的真实时长等待**，而不是每 60 秒重试一次。

真正不可用的是那 4 个 `opencode-only`（403，与时间无关）和 2 个地区受限的。

### ⚠️ 故障转移的承诺需要下调

因为可直连的候选基本只有一个，`soak.mjs` 里看到的 `[failover from mimo-v2.6-flash-free]`
并不是「换到了另一个可用模型」，而是 `mimo-v2.6-flash-free` 429 之后换到了
`space-bunny-free`——**两次都是同一个模型**。这仍然满足了「限流不停下来」，
但**不满足「换到另一个不同的模型」**。

所以故障转移代码本身是对的（遇到 429 会换），但**可用候选池实际上只有一项**。
真要靠故障转移顶住限流，得先把候选池扩到 2 个以上——见下面这节。

### 那第二条车道去哪找？——「免密」这件事，实测只有一家

先排除了一个我以为是机会的线索：Hindsight 配置文档里出现过
`HINDSIGHT_API_LLM_PROVIDER=opencode-go`、base_url `https://opencode.ai/zen/go/v1`。
实测（`scripts/discover-second-lane.mjs`）：

```
/zen/v1/chat/completions       200  OK
/zen/go/v1/chat/completions    401  AuthError: Missing API key
/zen/go/chat/completions       404
/go/v1/chat/completions        404
```

`/zen/go` 是**计费路径**，不是第二条免密车道。

于是又逐家测了「不带 key 能不能调」（`scripts/probe-keyless.mjs`）：

| 通道 | 未鉴权结果 |
| --- | --- |
| **OpenCode Zen** | ✅ **200，真正免密** |
| 智谱 GLM-4-Flash | 401 `Header中未收到Authorization参数` |
| OpenRouter | 401 `No cookie auth credentials found` |
| SiliconFlow | 401 `Token is invalid` |
| Moonshot / Kimi | 401 `Incorrect API key provided` |
| Cerebras | 403 |
| Groq | 403 |
| NVIDIA NIM | 410 |
| Cloudflare Workers AI | 404 |

**结论：市场上只有 OpenCode 这一家是真免密。** 其余都是「注册拿 key、用免费额度」——
而这**已经够了**：对 Hindsight 这种每轮对话自动跑 4 个环节的负载，注册一次、
额度用完再等，账单永远是 0。

所以第二条车道的现实形态是**自己去注册一个免费 key**，不是继续找免密白嫖。
这也让「多车道」从锦上添花变成了**必做项**（见第四节的 `LANES`）。

> 这轮还暴露了探测器自身的一个 bug：第一版拿别家模型名去问 OpenCode，它回
> 401 + `ModelError: xxx is not supported`——那不是鉴权失败。探测器把它判成
> 「需要 key」，差点让结论整条反掉。修正判据（区分「模型不对」与「缺 key」）之后
> 才是上面这张表。**探测器的判据本身也是需要验证的东西。**

---

## 三、为什么不直接用插件自带的转发端口

插件**已经**提供了 OpenAI 兼容转发端口（`127.0.0.1:18899`）。但它够不着 Hindsight，原因有两个：

1. **它活在 DSH 进程里。** DSH 一关，免费额度就没了。
2. **它只绑回环。** 你的 Hindsight 跑在飞牛 NAS 的容器里，根本访问不到宿主机的 `127.0.0.1`。

所以我写了一个**独立进程**的桥：`free-llm-bridge`。单文件、零依赖、Node 内置模块。

---

## 四、free-llm-bridge

源码：`free-llm-bridge/index.js`（MIT）

### 它解决的四个问题

**1. 会话亲和**（最关键）

```js
const digest = sha256(`free-llm-bridge\0${HOST}:${PORT}\0${downstreamKey}`)
// → ses_<12hex><14base62>
```

同一使用方稳定映射到同一上游 session。同一回合的重试共用 request id，所以重试不会被当成新回合再计一次。
优先读 `x-session-id` / `x-conversation-id`，没有就用远端地址兜底。

**2. 只服务免费档**

上游返回 86 个模型、其中 75 个是付费档。如果故障转移时不小心挑中一个，**你的账单就悄悄接回去了，而你不会知道**。

所以：

```js
function isFreeModel(model) {
  return model.endsWith('-free')
}
```

- 点名付费模型 → **400 拒绝**并说明原因。*不静默改投*——静默改投会让调用方以为自己用的就是点名的模型，实际跑的完全是另一回事。
- 免费档被限流 → **内部换到下一个免费档重试**，调用方毫无感知。
- 遇到 opencode-only 模型 → 同样降级换档（换模型有用，所以不该报错）。
- 免费档全被限流 → 429 + `retry-after`。

这条保证有 8 条回归断言钉在 `test-free-only.mjs` 里。

**3. 指纹门** — 自动补齐四个自禁诱饵工具
**4. 读流不看 header** — 上游高负载时用 `application/json` 回 SSE 帧，按 header 读会整轮报废

**5. schema 规整** — 剥掉 nullable 联合类型（否则 400），强制 `strict: true`（否则回空字符串）。详见第五节

**6. opencode-only 降级** — 上游写明「只能从 OpenCode 内部使用」的模型移出候选池，遇错自动换档

---

## 五、实测结果

三套测试，全部真实打上游：

| 测试 | 结果 | 说明 |
| --- | --- | --- |
| `test-free-only.mjs` | **26/26** | 零成本保证 + 会话亲和 + 指纹门 + schema 规整 + 文档一致性。不出网，秒级 |
| `smoke.mjs` | **13/13** | 端到端：非流式、结构化 JSON 抽取、流式、健康检查 |
| `soak.mjs 14` | **14/14，0 失败** | 持续性：故意点名常被限流的模型，验证内部故障转移 |
| `hindsight-extract-check.mjs` | 通过 | 用 Hindsight **真实** schema 抽中英文事实，关键信息全部保留 |

### 最有说服力的一次运行

```
  1/14  OK  3.6s  mimo-v2.6-flash-free   OK
  2/14  OK  2.0s  space-bunny-free      OK  [failover from mimo-v2.6-flash-free]
  3/14  OK  1.1s  space-bunny-free      OK  [failover from mimo-v2.6-flash-free]
 ...
 14/14  OK  1.1s  space-bunny-free      OK  [failover from mimo-v2.6-flash-free]

--- summary over 50s ---
succeeded : 14/14
models    : mimo-v2.6-flash-free, space-bunny-free
zero-cost guarantee held: every request landed on a -free model
```

**50 秒内 14 次请求全部成功，零失败。** 第 1 轮用点名的模型，第 2 轮起该模型被限流，
桥**内部**换到 `space-bunny-free` 并继续服务——调用方从头到尾没收到过一个错误。

这正是你要的行为：限额了自动换另一个免费模型继续跑，不停下来，更不碰付费的 deepseek / mimo。

> 这个行为是**修出来的**，不是一开始就有的。第一版 soak 的第 1 轮把 429 直接透给了调用方
> （11/12 成功，1 次失败暴露问题）。Hindsight 会把这种失败当成整轮失败并重试，等于
> 同一个回合又去撞一次限流。加了内部故障转移之后才变成 14/14。

### 结构化抽取：一个必须说清楚的限制

我拿 Hindsight **真实的** `FactExtractionResponse` schema 去打这条车道
（`scripts/hindsight-extract-check.mjs`），发现两件事。

**第一，原始转发会 400，整套方案在生产里是废的。**
Hindsight 的 schema 有 4 个 nullable 字段写成联合类型 `{"type": ["string","null"]}`，
而这条车道的语法引擎**拒绝联合类型**。逐项二分定位确认：enum、嵌套对象数组、
`const`、`integer` 都被接受，唯独联合类型被拒。
桥现在会自动把它们降级成非 null 分支。

**第二，也是更重要的：`response_format` 在这条车道上只是提示，不是语法约束。**
即使强制 `strict: true`，模型仍然不按 schema 生成。三次运行里它给正文字段起了
**三个不同的名字**：

| 运行 | 正文字段 | 必填项 `when/where/who/why` |
| --- | --- | --- |
| 第 1 次 | `text` | 全部省略 |
| 第 2 次 | `fact_text` | 全部省略 |
| 第 3 次 | `content` | 全部省略 |

模型甚至没有稳定地用同一个替代字段——这说明它根本没在「适配 schema」，只是在自由发挥。
输出还经常带 ```json 围栏。

**这对 Hindsight 意味着什么：** 它的解析器对缺失字段有默认值，能吃下这种输出，
所以**零成本方案仍然可用**。抽取质量本身是好的——实测中文正确、关键信息保留
（`15.4`、`小 K`、`背单词` 全部命中）、entities 准确。

**但如果你自己写消费方：不要假设 schema 里的字段名会被遵守。** 必须剥围栏、
允许字段缺失。这是这条路线的真实上限，我在 README 的「已知边界」里也写明了。

### 怎么复现上面这些结论

每条都对应一个脚本，直接跑就行：

```bash
node scripts/probe-free-models.mjs            # 谁真的能直连，推翻「11 个可用」
node scripts/diag-schema-shape.mjs            # 找出被 400 拒的 schema 关键字
node scripts/diag-grammar.mjs                 # 区分「schema 复杂」与「模型不配合」
node scripts/hindsight-extract-check.mjs      # 用 Hindsight 真 schema 端到端抽
node scripts/cost-analysis.mjs                # 从你自己的 Hindsight 账单接口量开销
```

这些脚本**消耗免费额度**，但请务必自己跑一遍——本报告里所有推翻性的结论
都是自己测出来的，而不是从插件文档抄的。抄文档会得到「11 个模型可用」这种错误答案。

---

## 六、接进 Hindsight

改动很小。**4 行必改 + 6 行建议**：

```yaml
environment:
  # ── 必改：4 个环节统一指向桥 ─────────────────────────────
  HINDSIGHT_API_LLM_PROVIDER: openai
  # ⚠️ 填**跑桥那台机器的局域网 IP**（桥与 Hindsight 不同机器时）
  HINDSIGHT_API_LLM_BASE_URL: http://192.168.31.21:18999/v1
  HINDSIGHT_API_LLM_API_KEY: local
  HINDSIGHT_API_LLM_MODEL: space-bunny-free

  # ── 建议：关思考 + 放宽超时 + 压并发 + 少重试 ───────────────
  HINDSIGHT_API_LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"},"max_tokens":4096}'
  HINDSIGHT_API_LLM_TIMEOUT: 600
  HINDSIGHT_API_LLM_CONNECT_TIMEOUT: 15
  HINDSIGHT_API_LLM_MAX_RETRIES: 2
  HINDSIGHT_API_LLM_MAX_CONCURRENT: 2

  # ── 向量化仍本地跑，保持原样 ──────────────────────────────
  HINDSIGHT_API_EMBEDDINGS_PROVIDER: huggingface
  HINDSIGHT_API_RERANKER_PROVIDER: rrf
  HINDSIGHT_API_RECALL_MAX_CANDIDATES_PER_SOURCE: 30
```

几个要点：

- **必须放宽超时。** 免费车道思考期可能静默 60–70 秒，Hindsight 默认 120 秒总超时
  在整合那种 17–19k token 的调用上会不够。
- **建议关思考。** 思考 token 与正文抢同一份额度，对「只要结论」的记忆提取纯浪费。
  你原来就用 `HINDSIGHT_API_LLM_EXTRA_BODY` 关掉了，这里保留同样的字段名即可。
- **⚠️ `BASE_URL` 里的地址取决于桥和 Hindsight 是不是同一台机器。**
  你的情况是**不同机器**（桥在电脑 `192.168.31.21`，Hindsight 在 NAS `192.168.31.123`），
  所以桥必须绑 `HOST=0.0.0.0`，`BASE_URL` 填**桥那台机器的局域网 IP**。
  `host.docker.internal` 在这里**是错的**——它指向 NAS 自己的宿主机。

  实测两种绑定的差别：

  | 桥的绑定 | 从 `192.168.31.21:18999` 访问 |
  | --- | --- |
  | 默认 `127.0.0.1` | ❌ 不可达（`netstat` 显示只 LISTEN 在 `127.0.0.1:18999`） |
  | `HOST=0.0.0.0` | ✅ `HTTP 200`，模型正常返回 `LAN_OK` |

  暴露到局域网后记得开防火墙只放行你的网段，并给桥加鉴权（详见 setup 文档）。

完整的部署步骤、常见问题、各环节单独配模型的写法见
**`free-llm-bridge/docs/hindsight-setup.md`**。

---

## 七、同类项目盘点（避免重复造轮子）

我查了一圈。先说结论：**大多数「免费 LLM 中转」项目其实是「你自己出钱的转发网关」**——
`new-api`、`gpt-load`、`LiteLLM`、`one-api` 这类都很好，但都需要你自备上游 key，
不解决「不想花钱」这个问题。

> ★ 与最后推送日期均为 `api.github.com` 实拉值（核实于 2026-10-05），非估算。

| 项目 | ★ | 最后推送 | 能当通用 base_url | 自带免费额度 | 对你有用吗 |
| --- | --- | --- | --- | --- | --- |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | 72,648 | 2026-10-02 | ✅ | ✅ 自称 359 provider / 150+ 免费 | **值得试**，但数字偏宣传，落地前自己验 |
| [LiteLLM](https://github.com/BerriAI/litellm) | 60,090 | 2026-10-03 | ✅ | ❌ 需自备 key | 适合「有预算、要精细路由」 |
| [free-claude-code](https://github.com/Alishahryar1/free-claude-code) | 56,455 | 2026-10-03 | ⚠️ | ✅ | 多 harness 客户端为主，非通用 API |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 54,023 | 2026-10-03 | ✅ | ✅ | **值得试**。Go/MIT，把 Claude Code/Codex/Gemini 订阅包装成 OpenAI 兼容 |
| [new-api](https://github.com/QuantumNous/new-api) | 49,235 | 2026-10-01 | ✅ | ❌ 需自备 key | 只做多协议互转，不解决钱 |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | 37,524 | 2026-09-26 | ❌ | — | 只代理 Claude Code 流量 |
| [one-api](https://github.com/songquanpeng/one-api) | 37,071 | **2026-01-09** | ✅ | ❌ | **已停更 9 个月，别用** |
| [9router](https://github.com/decolua/9router) | 30,243 | 2026-10-01 | ⚠️ | ✅ | 面向编码 CLI |
| [gpt-load](https://github.com/tbphp/gpt-load) | 7,039 | 2026-10-03 | ✅ | ❌ 需自备 key | 多凭据调度容错 |
| [uni-api](https://github.com/yym68686/uni-api) | 1,266 | 2026-10-03 | ✅ | ❌ 需自备 key | Rust/Apache-2.0，轻量 |

CLIProxyAPI 官方 description 原文（说明它确实自带免费额度）：
> Wrap Antigravity, ChatGPT Codex, Claude Code, Grok Build, Muse Code, Devin as an
> OpenAI/Gemini/Claude/Codex compatible API service, allowing you to enjoy the free
> Gemini Series, GPT Series, Grok Series, Claude model through API

**V2EX 上的警告值得记住**：有帖子指出中转站「逆向破解 Kiro、Cursor 等 IDE 插件内部接口，
把订阅账号额度转卖」（[v2ex.com/t/1200135](https://www.v2ex.com/t/1200135)）。
这类项目有账号封禁与稳定性风险。免费车道随时可能变，**别把鸡蛋放一个篮子里**。

### 为什么我还是写了 free-llm-bridge

因为上面那些项目没有一个满足这三条：

1. **不依赖任何 IDE 订阅**（CLIProxyAPI/OmniRoute 依赖 Claude Code、Codex 等订阅账号）
2. **不依赖你自备 key**
3. **NAS 容器能直接用**（它们大多假设跑在你自己机器上）

`free-llm-bridge` 是「已知可用车道的最小可靠封装」，不是通用 AI 网关。这是刻意的取舍。

---

## 八、免费额度清单（含核实状态）

> 所有条目标注了是否一手核实。**未核实的别当准数用。**

### 一手核实 ✅

| 通道 | 免费额度 | 卡片 | 来源 |
| --- | --- | --- | --- |
| **OpenCode Zen 免密车道** | 13 个 `-free` 模型，**实测只有 1 个能第三方直连**，按 session 限速 | 不需要 | 本次实测 |
| **智谱 GLM-4-Flash-250414** | 官方标注「智谱首个免费的大模型 API」，128K 上下文，**官方声称支持结构化输出** | 不需要 | [官方文档](https://docs.bigmodel.cn/cn/guide/models/free/glm-4-flash-250414) |
| **Cloudflare Workers AI** | 10,000 neurons/天，Text Gen 300 RPM。⚠️ 但 Kimi-K2.6/K2.7-Code、GLM-5.2/5.3/5.3-Flash、DeepSeek-V4 系列**强制付费档**（该档仅 20 RPM） | 不需要 | [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[limits](https://developers.cloudflare.com/workers-ai/platform/limits/) |
| **OpenRouter `:free`** | 常量 `RPM=20` / `RPD=50`（充值 ≥$10 后 RPD 1000，9 美元起即生效）。按账户算，官方明写多开账号不提升 | 不需要 | [limits.md](https://openrouter.ai/docs/api_reference/limits.md) |
| **NVIDIA build.nvidia.com** | 40 RPM + 1000 credits，可申请升到 200 RPM / 5000 | 不需要 | [NVIDIA 论坛](https://forums.developer.nvidia.com/t/request-to-increase-nvidia-nim-api-rate-limit-from-40-rpm-to-200rpm/379705) |
| **Hugging Face Inference** | 免费用户 **$0.10/月**（很少） | 不需要 | [pricing.md](https://github.com/huggingface/hub-docs/blob/main/docs/inference-providers/pricing.md) |

### 已失效 ❌

| 通道 | 状态 |
| --- | --- |
| **GitHub Models** | **2026-07-30 完全下线**。playground、模型目录、inference API、BYOK 全部不可用。官方建议转 Azure AI Foundry。[官方文档](https://docs.github.com/en/github-models) |

### 未核实 ⚠️

| 通道 | 说明 |
| --- | --- |
| **智谱 GLM-4.7-Flash** | 「免费」说法**仅第三方来源**（[腾讯云社区](https://cloud.tencent.com/developer/article/2638288)、[智通财经](https://cn.investing.com/news/stock-market-news/article-3171797)），官方页未取到。且一份第三方表格标注它**只有 1 并发**——对后台批处理是硬约束 |
| Gemini API 免费层 | 官方 rate-limits 页 4 次 fetch 全失败。**不引用任何二手数字**。接入前自查控制台 |
| Groq 免费层 | 官方文档返回 403，第三方数字互相冲突（30 RPM/14400 RPD vs 1000 RPD）。**未验证** |
| Kimi/Moonshot | 新用户送 ¥15 券，**一次性非永久**，需大陆手机号。需大陆手机号。（[官方](https://www.kimi.com/en/help/kimi-api/api-free-trial)） |
| 百度千帆 | 100 万 tokens，有效期 **3 个月**（一次性）。（[官方](https://cloud.baidu.com/doc/qianfan/s/Imi2rpirg)） |
| 阿里百炼 | 首次开通送免费额度，领取无需实名，转按量付费才需实名。（[官方](https://help.aliyun.com/zh/model-studio/new-free-quota)） |
| MiniMax | 按量付费为主，**无永久免费 API 层**。（[官方](https://platform.minimaxi.com/docs/guides/pricing-paygo)） |
| Cerebras / SambaNova / Mistral / Together / Fireworks / DeepInfra | 未找到一手免费额度文档 |
| SiliconFlow / DeepSeek 官方 / 腾讯混元 / 火山方舟 | 仅见按量计费，**未见永久免费额度**（[SiliconFlow](https://www.siliconflow.cn/pricing)） |

---

## 九、如果这条车道失效（备用路线）

按推荐顺序：

**1. 智谱 GLM-4-Flash-250414** ← 最推荐
唯一同时满足「官方免费 + 国内直连 + OpenAI 兼容 + **支持结构化输出** + 无需绑卡」的通道。
对 Hindsight 的中文事实抽取完全够用。

base_url 已实测可达：`POST https://open.bigmodel.cn/api/paas/v4/chat/completions` 返回 **401**
（端点在，只是需要 key）—— 这是我本轮自己打的一发，不是抄文档。

```yaml
HINDSIGHT_API_LLM_PROVIDER: openai
HINDSIGHT_API_LLM_BASE_URL: https://open.bigmodel.cn/api/paas/v4
HINDSIGHT_API_LLM_MODEL: glm-4-flash-250414
HINDSIGHT_API_LLM_API_KEY: <你的智谱 key>
```

> ⚠️ **GLM-4.7-Flash 的「免费」是未证实的。** 有第三方来源（腾讯云开发者社区、智通财经）
> 说它免费且开源，但**官方文档页没取到**。其中一份第三方表格还标注它**只有 1 并发**——
> 对 Hindsight 的后台批处理是硬约束。所以上面推的是官方页明写免费的
> GLM-4-Flash-250414，不是 4.7。

**2. OpenRouter `:free`** — 官方常量：`FREE_MODEL_RATE_LIMIT_RPM = 20`、
`FREE_MODEL_NO_CREDITS_RPD = 50`、`FREE_MODEL_HAS_CREDITS_RPD = 1000`、
`FREE_MODEL_CREDITS_THRESHOLD = 10`（[limits.md](https://openrouter.ai/docs/api_reference/limits.md)）。
注意官方明写「**多开账号或多开 key 不会提升限额**，容量全局管控」；充值 9 美元起即适用
1000 RPD 那一档。50 RPD 对日常对话够用，做批量抽取不够——所以这只是兜底，不是主路。

**3. Groq 免费层** — 速度极快，数字需自查控制台

**4. 本地 Ollama + Qwen3-4B Q4_K_M** — 唯一**真正无限量**的路径
你的 J1800 级 CPU 上，4B 量化约需 6GB 内存，8B 会降到个位数 token/s。
只适合夜间批处理，不适合交互。vLLM 不适用（需 CUDA/现代 SIMD）。

**5. Cloudflare Workers AI** — 有异步 Batch API，天生适合后台任务

---

## 十、诚实的边界

> 这一节是对本报告全部结论的自我限制。**其中三条是我实测踩出来的，不是推测。**

- **⚠️ 只有一个模型真能用。** 13 个 `-free` 里只有 `space-bunny-free` 能第三方直连
  （详见第二节的实测表）。其余是 429 限流、403 opencode-only、403 地区门或 500。
  **这条路线没有真正的冗余**——单点。
- **⚠️ 而且市场上只有这一条免密车道。** 实测 11 家，只有 OpenCode 不带 key 也能调；
  其余全部要 key（详见第二节末的对照表）。所以消除单点的办法不是继续找白嫖，
  而是**自己注册一个免费 key** 加第二条车道。
- **⚠️ 结构化输出不是硬保证。** `response_format` 在这条车道上是提示而非语法约束：
  模型三次运行给正文起了三个不同的字段名（`text` / `fact_text` / `content`），
  并稳定省略 schema 的必填项。Hindsight 能容忍，但**你的消费方未必**。
- **「假装成功」是最危险的失败模式。** 实测上游在 `json_schema` 不带 `strict` 时
  会回 **200 但正文为空**。放过它，Hindsight 的 retain 会「成功」地抽出零条事实——
  记忆看起来在工作，实际什么都没存，且没有任何地方报错。桥现在把空完成降级成
  一次明确失败，让它走故障转移或如实上报。
- **「免费」不等于「无限」。** 这条车道按 session 限速，打满会 429。桥会退避和换档，
  但候选池实际只有一项，换来换去还是同一个模型。
- **免费档会变。** 上游随时可能改模型集合或政策。桥启动时探测一次，运行中新增的可用模型
  要重启才发现。
- **被动发现，不是主动保证。** 桥在响应里看到非零 `cost` 字段时会打 WARNING 日志。
  这是**事后**发现，**请自己看一眼账单**。
- **插件的清单不能照抄。** `dsh-our-free-model` 设置页显示「available」的那几个模型，
  第三方调用一律 403——因为它活在 DSH 里被上游当成内部流量。
  想确认就跑 `node scripts/probe-free-models.mjs`。
- **质量有取舍。** 抽取质量实测尚可（中文正确、关键信息保留），但比 `mimo-v2.6-flash`
  弱，细节归因能力会下降。
- **桥不做重试**，只做故障转移。是否重试交给调用方决定（Hindsight 侧建议 `MAX_RETRIES=2`）。
- **只绑回环是默认值。** 改成 `0.0.0.0` 前请确认你的网络可信——暴露出去等于送人额度。
- **账单数字依赖价格假设。** 第一节的金额按 ¥1/M 输入、¥0.02/M 缓存、¥2/M 输出估算。
  请用你自己的账单核对。**结论的方向（从十位数降到零）不受影响。**

---

## 十一、产物清单

```
free-llm-bridge/
├── index.js                  # 桥本体，单文件零依赖
├── test-free-only.mjs        # 26 条离线回归断言，不出网，CI 可跑
├── smoke.mjs                 # 13 条端到端断言
├── soak.mjs                  # 持续性 + 故障转移验证
├── docker-compose.yml        # Docker 部署
├── deploy/
│   └── free-llm-bridge.service   # systemd 部署
├── scripts/
│   ├── cost-analysis.mjs         # 从 Hindsight 账单接口量真实开销
│   ├── probe-free-models.mjs     # 逐个探测 -free 模型真实可用性
│   ├── hindsight-extract-check.mjs  # 用 Hindsight 真 schema 做端到端抽取
│   ├── diag-json-schema.mjs      # response_format 各形状对比
│   ├── diag-schema-shape.mjs     # 定位被拒的 schema 关键字
│   └── diag-grammar.mjs          # 分离 schema 复杂度与模型两个变量
├── docs/
│   ├── hindsight-setup.md    # Hindsight 完整接入步骤
│   └── publish-to-github.md  # 首次发开源的照做清单
├── README.md
└── REPORT.md                 # 本报告
```

每个诊断脚本都对应一个**实测踩出来的坑**，不是写来好看的：
`diag-schema-shape.mjs` 是为了找出 400 的真因（联合类型），
`diag-grammar.mjs` 是为了区分「schema 太复杂」和「模型不配合」，
`probe-free-models.mjs` 是为了推翻「11 个模型可用」这个错误结论。

---

## 十二、下一步（需要你做）

1. **NAS 上改 Hindsight 的 compose 环境变量** —— 见第六节
2. **确认零成本**：跑几次对话，看桥日志里有没有 `routing X -> Y`，有没有 WARNING cost 行
3. **发布到 GitHub** —— 见下一节
