# free-llm-bridge

**把任意 OpenAI 兼容应用接到一条免密、零成本、无限量的 LLM 车道上。**

为 [Hindsight](https://github.com/vectorize-io/hindsight) 这类记忆系统而写——它每轮对话后
自动跑 4 个 LLM 环节（事实提取 / 整合 / 知识页刷新 / 反思），按商业 API 计费两天能烧掉八块钱。
现在这些调用的费用是 **0**。

- 零依赖、单文件，只需要 Node `>= 22.19`
- **不需要 API key、不需要注册、不需要充值**
- 只服务免费档模型：付费模型被点名时直接 400 拒绝，绝不静默改投
- 一个模型被限流，自动换到下一个免费档继续跑
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
| `model` | `space-bunny-free`（或 `/v1/models` 里任何一个） |

---

## 它在做什么

上游是一个公开的免密车道（OpenCode Zen 网关），11 个模型的 id 以 `-free` 结尾。
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
node test-free-only.mjs   # 零成本保证 + 会话亲和 + 指纹门 + 文档一致性。不出网，秒级
node smoke.mjs            # 端到端。真打上游，会消耗免费额度
node soak.mjs             # 持续性 + 故障转移。真打上游
```

`test-free-only.mjs` 不出网，可以在 CI 里跑。`smoke.mjs` 会真实调用上游，包括一个
结构化 JSON 抽取用例——那正是 Hindsight retain 做的事。

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

见 **[docs/hindsight-setup.md](docs/hindsight-setup.md)**。最小改动是这四行：

```yaml
environment:
  HINDSIGHT_API_LLM_PROVIDER: openai
  HINDSIGHT_API_LLM_BASE_URL: http://host.docker.internal:18999/v1
  HINDSIGHT_API_LLM_API_KEY: local
  HINDSIGHT_API_LLM_MODEL: space-bunny-free
```

另外记得关掉思考并放宽超时——思考 token 与正文抢同一份额度，而记忆提取只要结论：

```yaml
  HINDSIGHT_API_LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"},"max_tokens":4096}'
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

---

## 已知边界

- **「免费」不等于「无限」。** 这条车道按 session 限速，短时间打满会回 429。桥会退避
  并换模型，但所有免费档同时被打满时只能等。
- **地区门。** 部分模型对某些地区的出口直接 403（实测 CN 出口下 `muse-spark-1.3-contributor-free`
  被挡）。桥把这些模型排除在候选池外。
- **免费档会变。** 模型集合与额度政策由上游决定，随时可能调整。桥在启动时探测一次，
  但运行中新增的免费模型要重启才被发现。
- **上游哪天改成计费怎么办？** 桥在响应里看到非零 `cost` 字段时会打 WARNING 日志。
  这是被动发现，不是主动保证——**请自己看一眼账单**。
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
