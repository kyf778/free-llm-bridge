# 让 Hindsight 零成本运行：部署与配置

这份文档对应两件事：把 `free-llm-bridge` 跑起来，以及把 Hindsight 的 4 个 LLM 环节全部指过去。
跑完之后 Hindsight 每轮对话产生的 LLM 调用费用为 **0**。

## 架构

```text
  飞牛 NAS  192.168.1.20
  ┌──────────┐
  │ hindsight│  :8888
  │  容器    │◄───────────────────────────┐
  └──────────┘                            │
                                retain / reflect / consolidation /
                                mental-model refresh
                                             │  OpenAI 兼容 HTTP
                                             │  ⚠️ 必须用跑桥那台机器的局域网 IP
                                             │     不能用 host.docker.internal
                          ┌──────────────────▼─────────────────────┐
  你的电脑  192.168.1.10  │  free-llm-bridge（单文件 Node 服务）    │
  局域网访问 :18999 ─────►│  会话亲和 · 指纹门 · 多车道故障转移     │
                          └──────────────────┬─────────────────────┘
                                             │  Authorization: Bearer public
                          ┌──────────────────▼─────────────────────┐
                          │  OpenCode Zen 免密车道（零成本）       │
                          │  86 个模型，13 个 `-free`              │
                          │  同一时刻 1 个可直连，其余限流待恢复   │
                          └────────────────────────────────────────┘
```

**关键点：桥和 Hindsight 在不同的机器上。** 所以：

1. 桥要绑 `HOST=0.0.0.0`，容器用**跑桥那台机器的局域网 IP**访问它；
2. 不要把桥装进 Hindsight 容器里——桥需要能独立于 Hindsight 存活；
3. `host.docker.internal` 在这里**无效**（它指向 NAS 自己，不是你的电脑）。

> 这一步实测过：桥绑回环时 `192.168.1.10:18999` 不可达；改成 `0.0.0.0` 后
> 同一个地址返回 `HTTP 200` 且模型正常返回 `LAN_OK`。

## 第一步：把桥跑起来

```bash
git clone https://github.com/<你的用户名>/free-llm-bridge.git
cd free-llm-bridge
node index.js --port 18999
```

验证：

```bash
curl http://127.0.0.1:18999/health
# {"ok":true,"service":"free-llm-bridge","upstream":"https://opencode.ai","models":86,...}

curl http://127.0.0.1:18999/v1/models | jq -r '.data[].id'
# 付费档不会出现；实测不可用的 opencode-only 模型也已排除
```

**上机之前先跑一次真实可用性探测**，别只看清单：

```bash
node scripts/probe-free-models.mjs
```

会逐个打一遍 `-free` 模型并给出 verdict。实测结论：13 个 `-free` 里，
**同一时刻**只有 `space-bunny-free` 能第三方直连调用；其余是
429 限流（约 90 分钟后恢复）/ 403 opencode-only / 403 地区门 / 500。
**如果这个探针的输出和你的情况差很多，请以你的实测为准。**

> `api_key` 随便填一个非空字符串。桥不需要真 key——它用的是上游公开车道的
> `Bearer public`。填 `local` 就行。

### 让 NAS 容器能访问 —— 先看清你的拓扑

**这一步是整套部署里最容易搞错的地方**，因为「桥和 Hindsight 是不是同一台机器」
决定了该用哪种办法。先回答这个问题：

```text
情况 1：Hindsight 容器与桥在同一台机器
        → 用 `host.docker.internal`，桥可以继续只绑回环（更安全）

情况 2：Hindsight 在另一台机器（如 NAS），桥在你的电脑上   ← 大多数人的情况
        → 必须让桥绑到局域网地址，容器用那台机器的 IP 访问
```

⚠️ **`host.docker.internal` 只在「同一台机器」时有效。** 它解析到的是**宿主机**，
而情况 2 里的宿主机是 NAS 自己，不是你跑桥的电脑。实测：桥绑回环时，
NAS 容器用 `host.docker.internal` 会连到 NAS 的 18999（没有东西在听），
而不是你电脑上的桥——**而且它不会报「连不上」，而是连上 NAS 上别的东西或超时**，
很难查。

#### 情况 2：桥在另一台机器（推荐按这个做）

```bash
# Windows PowerShell
$env:HOST = "0.0.0.0"
node index.js --port 18999
```

`HOST=0.0.0.0` 表示监听所有网卡。实测这一步之后，从局域网 IP 访问就通了：

```
192.168.1.10:18999/health -> HTTP 200
模型 space-bunny-free 返回 LAN_OK
```

然后 **Hindsight 的 `BASE_URL` 填跑桥那台机器的局域网 IP**：

```yaml
HINDSIGHT_API_LLM_BASE_URL: http://192.168.1.10:18999/v1
```

**必须做的两件安全收尾**（暴露到局域网不是小事）：

1. **开防火墙，只放行你的网段**——不要对整个互联网开放：

   ```powershell
   New-NetFirewallRule -DisplayName "free-llm-bridge" -Direction Inbound `
     -Protocol TCP -LocalPort 18999 -RemoteAddress 192.168.1.0/24 -Action Allow
   ```

2. **给桥加一个自己的 key。** 桥默认接受任意非空 `Authorization`（面向本机自用）。
   暴露到局域网后，同网段任何设备都能花掉你的免费额度。改 `index.js` 里的
   `authorizeRequest`，或直接套一层 nginx / Caddy 做 basic auth。

> 桥的鉴权是**请求级**的，不是会话级——所以一旦开了局域网，
> 「本地自用」这个前提就不成立了。

#### 情况 1：同一台机器

在 Hindsight 的 compose 里加：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

`BASE_URL` 用 `http://host.docker.internal:18999/v1`，桥**仍然只监听 127.0.0.1**，
不需要把门开到局域网。这个更安全。

## 第二步：改 Hindsight 的环境变量

在 NAS 上编辑 Hindsight 的 compose 文件，替换 LLM 相关的变量。

### 改之前（花钱的版本）

```yaml
environment:
  HINDSIGHT_API_LLM_PROVIDER: openai
  HINDSIGHT_API_LLM_BASE_URL: https://api.xiaomimimo.com/v1
  HINDSIGHT_API_LLM_MODEL: mimo-v2.6-flash
  HINDSIGHT_API_LLM_API_KEY: sk-xxxxxxxx
  HINDSIGHT_API_LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"}}'
```

### 改之后（零成本）

```yaml
environment:
  # ── 4 个环节统一指向桥 ──────────────────────────────────────
  # ⚠️ BASE_URL 填**跑桥那台机器的局域网 IP**，不是 host.docker.internal
  HINDSIGHT_API_LLM_PROVIDER: openai
  HINDSIGHT_API_LLM_BASE_URL: http://192.168.1.10:18999/v1
  HINDSIGHT_API_LLM_API_KEY: local
  HINDSIGHT_API_LLM_MODEL: space-bunny-free

  # ── 思考关掉：思考与正文抢同一份额度，且是纯浪费 ─────────────
  HINDSIGHT_API_LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"},"max_tokens":4096}'

  # ── 超时必须放宽：免费车道思考期可能静默 60-70 秒 ─────────────
  HINDSIGHT_API_LLM_TIMEOUT: 600
  HINDSIGHT_API_LLM_CONNECT_TIMEOUT: 15

  # ── 桥会自己故障转移，所以重试次数不必高 ─────────────────────
  HINDSIGHT_API_LLM_MAX_RETRIES: 2
  HINDSIGHT_API_LLM_INITIAL_BACKOFF: 2.0
  HINDSIGHT_API_LLM_MAX_BACKOFF: 30.0

  # ── 并发压低：免费额度按会话计，并发越高越容易撞限流 ─────────
  HINDSIGHT_API_LLM_MAX_CONCURRENT: 2

  # ── 向量化仍然本地跑，不花钱，保持原样 ─────────────────────
  HINDSIGHT_API_EMBEDDINGS_PROVIDER: huggingface
  HINDSIGHT_API_RERANKER_PROVIDER: rrf
  HINDSIGHT_API_RECALL_MAX_CANDIDATES_PER_SOURCE: 30
```

改完重启容器：

```bash
docker compose up -d
docker logs -f hindsight 2>&1 | grep -i -E "llm|connect|provider"
```

启动日志里应该看到连接检查通过，且不再有任何 `api.xiaomimimo.com` 的出网。

## 第三步：确认真的零成本

```bash
# 1. 桥的日志里出现调用记录，但没有任何付费模型
docker logs -f free-llm-bridge

# 2. 观察实际模型——出现 mimo-v2.6-flash-free / space-bunny-free 等带 -free 的名字
#    出现不带 -free 的名字说明配置错了，立刻停
```

在 Hindsight 里跑一次 retain，然后看桥的 stderr：

```text
[free-llm-bridge] routing mimo-v2.6-flash-free -> space-bunny-free (requested is throttled)
```

出现 `routing` 行说明**故障转移正常工作**：首选被限流，桥自动换了另一个免费档，
没有停下来，也没有去碰付费模型。

⚠️ 但注意一个现实：**同一时刻** 13 个 `-free` 里通常只有 `space-bunny-free` 可直连，
所以上面这种 `routing X -> space-bunny-free` 往往是在收敛到同一个模型。这仍然满足
「限流不停下来」，但**没有即时备份**——被限流的那几个要等约 90 分钟才恢复。

想要即时的备份，只能自己加一条独立车道（README 的「多车道」一节）。

## 各环节可以配不同模型

Hindsight 支持按环节分别配置。**但在本方案下意义有限**——可直连的免费模型只有一个，
分环节配也换不出花来。写在这里是为了将来上游放开更多模型时你不用再查文档：

```yaml
environment:
  # 三个都省略时全部回落到全局 HINDSIGHT_API_LLM_MODEL，行为与不配一致
  HINDSIGHT_API_RETAIN_LLM_MODEL: space-bunny-free
  HINDSIGHT_API_REFLECT_LLM_MODEL: space-bunny-free
  HINDSIGHT_API_CONSOLIDATION_LLM_MODEL: space-bunny-free
```

> ⚠️ 别照抄旧版本文档里 `fledge-alpha-free` / `nemotron-3.5-lightning-free` 这类写法——
> 实测它们对第三方调用一律 403 `OpenCode's free tier can only be used from within OpenCode`。

## 排错要点

各环节的开销占比差异很大。实测最近 200 次调用：

| operation | 次数 | 平均 token/次 | 占比 |
| --- | ---: | ---: | ---: |
| consolidation | 103 | 20,419 | 52% |
| retain | 63 | 5,686 | 32% |
| refresh_mental_model | 31 | 16,760 | 16% |

**consolidation 是大头**，比 retain 还贵 3.6 倍。如果将来免费额度不够用，
优先看 consolidation 跑了多频繁，而不是先去压 retain。

用 `node scripts/cost-analysis.mjs` 量你自己的真实账单。

## 常见问题

**Q: 报 429 `Rate limit exceeded`。**
上游会带一个 `retry-after`（实测约 5400 秒 / 90 分钟量级，且真实递减）。
桥会**按这个时长**把该模型记进冷却，而不是每 60 秒重试一次——否则会在一个半小时的
窗口里反复撞同一面墙。冷却期间请求会自动落到别的可用模型上。

想看当前冷却情况：

```bash
curl -s http://127.0.0.1:18999/health | jq '{throttled, retryInSec, lanes: [.lanes[].available]}'
```

若 `lanes` 全部 `false`，说明这一刻确实没有可用目标，此时才会真的回 429。
此时请转备用路线（README 的「多车道」一节：自己注册一条免费 key 车道）。

**Q: 报 403 `FreeTierError`。**
两种可能，桥都能自动处理，但值得知道原因：

1. `OpenCode's free tier can only be used from within OpenCode` —— 你点了名一个上游
   限制为「仅 OpenCode 内部可用」的模型（`fledge-alpha-free`、`nemotron-3-*`、
   `longcat-2.5-preview-free`）。桥会自动换到 `space-bunny-free`。
2. 缺少 `bash/glob/grep/read` 工具声明 —— 桥会自动补齐诱饵工具，所以不该出现。
   真出现了说明桥的版本不对，确认用的是本仓库的 `index.js`。

**Q: 报 400 `invalid_request_error`。**
多半是 `response_format` 里用了 nullable 联合类型 `{"type": ["string", "null"]}`——
免费车道的语法引擎拒绝它。桥会自动降级，但如果是你自己的 schema 直接打到上游，
请改成 `anyOf` 或去掉可空分支。

**Q: retain 抽出零条事实，但请求显示 200 成功。**
这是 `json_schema` 不带 `strict` 时车道的静默失败（回空字符串）。桥已强制
`strict: true`。另外实测语法强制不是 100% 可靠，输出可能带 ```json 围栏——
解析前先剥围栏。

**Q: 记忆提取出来的东西质量下降。**
这是预期内的取舍：免费档模型比 `mimo-v2.6-flash` 弱。换 `mimo-v2.6-flash-free`
通常比默认档好；实在不满意再考虑 README 里的本地模型路线。

**Q: 能不能不开思考？**
能，而且应该开。见上面 `HINDSIGHT_API_LLM_EXTRA_BODY` 里的 `thinking` 字段。
思考 token 与正文抢同一份输出预算，对记忆提取这种「只要结论」的任务纯浪费。

**Q: 会不会哪天这条车道就没了？**
会。它是公开免费额度，上游随时可能改政策。所以：
（1）桥会在上游报出非零 `cost` 时打 WARNING 日志；
（2）README 列了备用路线，建议同时备好一个真 key 作为兜底。
