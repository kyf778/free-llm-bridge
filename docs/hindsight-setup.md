# 让 Hindsight 零成本运行：部署与配置

这份文档对应两件事：把 `free-llm-bridge` 跑起来，以及把 Hindsight 的 4 个 LLM 环节全部指过去。
跑完之后 Hindsight 每轮对话产生的 LLM 调用费用为 **0**。

## 架构（推荐形态：桥容器化进 NAS compose）

```text
  飞牛 NAS  192.168.1.20
  ┌────────────────────────── 一个 docker compose ──────────────────────────┐
  │  hindsight 容器  :8888                                                  │
  │      │  OpenAI 兼容 HTTP（compose 内部服务名，不发布端口）              │
  │      ▼                                                                  │
  │  free-llm-bridge 容器  :18999（restart: unless-stopped → 开机自启）     │
  │      │  Authorization: Bearer public                                    │
  └──────┼──────────────────────────────────────────────────────────────────┘
         ▼
  OpenCode Zen 免密车道（零成本）
  86 个模型，13 个 `-free`；同一时刻 1 个可直连，其余限流待恢复
```

**这样安排的好处（2026-10-05 实测确认）**：

1. 两个容器在同一 compose 网络里用服务名 `http://free-llm-bridge:18999/v1` 直连——
   **桥不发布端口，NAS 主机和局域网都摸不到它**，防火墙都不用配；
2. `restart: unless-stopped` = NAS 开机/崩溃自动拉起，**不需要常驻窗口**；
3. **你的电脑可以关机**——记忆系统完全自治，不再依赖"电脑开着 + 记得启动"。

> 桥也可以跑在自己电脑上（`启动桥.cmd`，保留供本机使用），但那是**备选**：
> 那种形态下必须 `HOST=0.0.0.0`、必须开防火墙、必须留窗口，且电脑一关记忆就停。
> 旧拓扑的教训仍然成立——**跨机器时 `host.docker.internal` 是错的**（它指向
> Hindsight 所在那台机器的宿主机）；详见文末「备选：桥跑在电脑上」。

**Hindsight compose 里的关键几行**（完整见下文"改之后"样例）：

```yaml
      - HINDSIGHT_API_LLM_BASE_URL=http://free-llm-bridge:18999/v1   # 服务名直连
      # ⚠️ 下面两件事必须成对出现，缺一会踩启动死循环（见排错 FAQ 第一条）
      - HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight
      - HINDSIGHT_API_LLM_TIMEOUT=600
    entrypoint: ["/bin/bash", "/app/start-hindsight.sh"]
```

## 第一步：把桥跑起来（容器化形态）

把 `index.js` 传到 NAS 的 compose 目录（作为只读挂载），再在 compose 里
**新增一个 free-llm-bridge 服务**（无 `ports:` 段是故意的）：

```bash
# 在仓库根目录
scp -i <你的NAS密钥> index.js adm@<NAS的IP>:/vol2/1000/Hindsight/bridge-index.js
```

```yaml
services:
  hindsight:
    environment:
      - HINDSIGHT_API_LLM_BASE_URL=http://free-llm-bridge:18999/v1

  free-llm-bridge:
    image: node:22-alpine
    container_name: free-llm-bridge
    command: ["node", "/app/index.js", "--port", "18999"]
    environment:
      - HOST=0.0.0.0          # 容器内绑全网卡，才能被 compose 网络访问
    volumes:
      - ./bridge-index.js:/app/index.js:ro
    restart: unless-stopped
    # 没有 ports: 段是故意的——服务名只在本 compose 网络内可解析
```

> NAS 拉不到 Docker Hub 的话（实测遇到过 `registry-1.docker.io` 超时）：
> `docker pull docker.m.daocloud.io/library/node:22-alpine && docker tag docker.m.daocloud.io/library/node:22-alpine node:22-alpine`

验证（直接看 Hindsight 的反应最实在）：

```bash
docker compose up -d
docker logs free-llm-bridge | head -5     # listening / lane zen / probed N models
docker logs hindsight | grep -i "connection verified"   # ← 链路通的标志
curl -s http://127.0.0.1:8888/health      # healthy JSON
```

**上机之前先跑一次真实可用性探测**，别只看清单（在电脑上跑）：

```bash
node scripts/probe-free-models.mjs
```

会逐个打一遍 `-free` 模型并给出 verdict。实测结论：13 个 `-free` 里，
**同一时刻**只有 `space-bunny-free` 能第三方直连调用；其余是
429 限流（约 90 分钟后恢复）/ 403 opencode-only / 403 地区门 / 500。
**如果这个探针的输出和你的情况差很多，请以你的实测为准。**

> `api_key` 随便填一个非空字符串。桥不需要真 key——它用的是上游公开车道的
> `Bearer public`。填 `local` 就行。

### 备选：桥跑在电脑上（旧形态，仅当你不想动 NAS 时）

**推荐形态是上面的容器化**。下面的拓扑方案是桥跑在自己电脑上的情况——
**开窗口、手动启动、电脑关机记忆就停**，这三个毛病就是它固有的；容器化正是为
消灭它们而做的。如果只是想在电脑本机临时用桥（比如给别的工具），双击
`启动桥.cmd` 即可，**不必**给 Hindsight 走这条路。

跨机器时最容易搞错的一点：

⚠️ **`host.docker.internal` 只在「同一台机器」时有效。** 它解析到的是**宿主机**，
而 Hindsight 在 NAS 上时宿主机是 NAS 自己、不是你跑桥的电脑。实测：桥绑回环时，
NAS 容器用 `host.docker.internal` 会连到 NAS 的 18999（那里没有东西在听），
而不是你电脑上的桥——**而且它不报「连不上」，而是连上 NAS 上别的东西或超时**，很难查。

#### 情况 A：桥在另一台机器（旧形态主路径）

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

#### 情况 B：桥与 Hindsight 同一台机器（仅当电脑也跑 Hindsight 容器时）

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
  hindsight:
    # ── ⚠️ 内嵌 postgres 必须有人负责启动：入口包装 + 显式 URL，缺一不可 ──
    # ① 入口包装：启动 postgres、轮询到 running:true，再交给官方入口。
    #    脚本来自本仓库 deploy/start-hindsight.sh。
    entrypoint: ["/bin/bash", "/app/start-hindsight.sh"]
    volumes:
      - hindsight-data:/home/hindsight/.pg0
      - ./start-hindsight.sh:/app/start-hindsight.sh:ro

    environment:
      # ── 4 个环节统一指向桥 ──────────────────────────────────────
      # 桥容器化在同一个 compose 里时用服务名直连；
      # 桥跑在别的机器上时这里要换成那台机器的局域网 IP（见「备选」一节）
      HINDSIGHT_API_LLM_PROVIDER: openai
      HINDSIGHT_API_LLM_BASE_URL: http://free-llm-bridge:18999/v1
      HINDSIGHT_API_LLM_API_KEY: local
      # ⚠️ 推荐填队列哨兵，而不是某个具体模型。
      #    Hindsight 每轮都点名同一个模型，而免费车道的可用面每 90 分钟就变一次——
      #    钉死的那个迟早撞上限流，然后每个请求都要先失败一次才换。
      #    填 free-queue 则由桥按实测队列挑选，直接跳过被限流的，一个 RTT 都不浪费。
      HINDSIGHT_API_LLM_MODEL: free-queue
      # ⚠️ 必须固定 worker_id。默认取 hostname（容器内即容器 ID），重建就变；
      #    而 Hindsight 只回收「自己」的 processing 行，上一个容器留下的会永久卡死。
      #    官方自己的启动日志也会警告这一点。
      HINDSIGHT_API_WORKER_ID: hindsight

      # ② 显式 postgresql://：让 Hindsight 完全不走 pg0 的探测代码路径。
      #    注意：单写这行会跳过 postgres 启动（没人启动它）；单写 pg0://
      #    又会在慢机器上踩返回值 None。两者必须配对，详见排错 FAQ 第一条。
      HINDSIGHT_API_DATABASE_URL: postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight

      # ── 关思考交给桥做，不要在 Hindsight 侧配 ──────────────────
      # 桥会按**本次实际模型**决定是否加 {"reasoning":{"enabled":false}}。
      # ⚠️ 绝不能在这里写思考相关的参数：EXTRA_BODY 会合并进**每一次** LLM 调用，
      #    而它最终打到哪个模型是不确定的。实测 nemotron-3-super 加它能把
      #    reasoning_tokens 压到 0，而 liquid/lfm-2.5-2.6b 加同一个参数直接 502
      #    （上游原文：Reasoning is mandatory for this endpoint and cannot be disabled）。
      #    这里只留 max_tokens 兜输出上限。
      HINDSIGHT_API_LLM_EXTRA_BODY: '{"max_tokens":8192}'

      # ── 超时必须放宽：免费车道思考期可能静默 60-70 秒 ─────────────
      HINDSIGHT_API_LLM_TIMEOUT: 600
      HINDSIGHT_API_LLM_CONNECT_TIMEOUT: 15

      # ── 桥会自己故障转移，所以重试次数不必高 ─────────────────────
      HINDSIGHT_API_LLM_MAX_RETRIES: 2
      HINDSIGHT_API_LLM_INITIAL_BACKOFF: 2.0
      HINDSIGHT_API_LLM_MAX_BACKOFF: 30.0

      # ── 并发压低：免费额度按会话计，并发越高越容易撞限流 ─────────
      HINDSIGHT_API_LLM_MAX_CONCURRENT: 2

      # ── 慢机器：初始化（模型加载 + 内嵌库）可能超过默认 300 秒看门狗 ──
      HINDSIGHT_API_STARTUP_WAIT_SECONDS: 900
      HINDSIGHT_API_MODEL_INIT_TIMEOUT: 900

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
能，而且应该开——思考 token 与正文抢同一份输出预算，对「只要结论」的记忆提取
纯浪费。注意 `thinking` 这类参数是**按上游给的**：米莫认它，免费车道未必认；
不确定就用桥能透传的通用手段（如 `max_tokens` 上限），别把一家的方言塞进
全局 EXTRA_BODY 里。

**Q: 容器重建后起不来，日志报 `❌ API did not become healthy within 300s`。**
这台机器初始化慢（sentence-transformers 加载 + 内嵌 Postgres 启动可能超过 5 分钟），
而 Hindsight 默认 300 秒看门狗会先放弃，容器被杀后进入重启循环。
日志自己给了改法（已实测确认），在 compose 的 environment 里加两行：

```yaml
      - HINDSIGHT_API_STARTUP_WAIT_SECONDS=900
      - HINDSIGHT_API_MODEL_INIT_TIMEOUT=900
```

改完 `docker compose up -d` 重建，等初始化完成（慢机器上 5-8 分钟是正常的）。
判断就绪：`curl http://127.0.0.1:8888/health` 返回 JSON。

**Q: 容器起来了但 8888 一直不通，日志停在 `Load pretrained SentenceTransformer`。**

**嵌入模型缓存在容器可写层里，不在任何卷上**——每次重建容器都要重新下载
（`paraphrase-multilingual-MiniLM-L12-v2` 约 470 MB）。一旦这次下载卡住
（实测停在 10 MiB 不动，`blobs/*.incomplete` 大小不变），SentenceTransformer 就会
一直等，`Application startup failed. Exiting.`。

解法：把模型**预下载到宿主机一个持久目录**再挂进去，让容器永远不必联网。

```bash
# 宿主机上（能通 hf-mirror 的话）
mkdir -p ./embed-model
BASE=https://hf-mirror.com/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/resolve/main
for f in config.json config_sentence_transformers.json modules.json \
         sentence_bert_config.json model.safetensors tokenizer.json \
         tokenizer_config.json special_tokens_map.json sentencepiece.bpe.model; do
  curl -fsSL -o "./embed-model/$f" "$BASE/$f"
done
mkdir -p ./embed-model/1_Pooling
curl -fsSL -o ./embed-model/1_Pooling/config.json "$BASE/1_Pooling/config.json"
```

```yaml
    volumes:
      - ./embed-model:/models/embed:ro
    environment:
      - HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL=/models/embed
      - HF_ENDPOINT=https://hf-mirror.com
```

⚠️ 校验下载完整性再挂：`model.safetensors` 应约 470 MB 且头部可解析
（`1_Pooling/config.json` 也必须存在，否则报
`Pooling.__init__() missing 1 required positional argument`）。
实测一次「下载中途卡住留下的残缺文件」正是上面那个报错的来源。

**Q: 重建后一部分操作永远停在「处理中」。**

`worker_id` 默认取 hostname（容器内即容器 ID），容器一重建就变。而 Hindsight 的
`_reclaim_own_processing_tasks` **只回收自己 worker_id 的行**，于是上一个容器留下的
`processing` 行没人认领，永久卡死（实测卡过 4~6 个 retain）。

修法：固定 `HINDSIGHT_API_WORKER_ID`（见上文 compose 样例）。
已卡死的行可以这样解冻：

```sql
UPDATE async_operations SET status='pending', worker_id=NULL, claimed_at=NULL
WHERE status='processing' AND (worker_id IS NULL OR worker_id <> '<你固定的那个 id>');
```

**Q: 重建后容器反复重启，日志报 `ValueError: Database URL is required for migrations`。**

**真解（2026-10-06 复测后修订）：两件事必须成对配，缺一不可。**

```yaml
  hindsight:
    # ① 入口包装：负责把 postgres 拉起来并等它就绪
    entrypoint: ["/bin/bash", "/app/start-hindsight.sh"]
    volumes:
      - hindsight-data:/home/hindsight/.pg0
      - ./start-hindsight.sh:/app/start-hindsight.sh:ro    # 见仓库 deploy/
    environment:
      # ② 显式 postgresql://：让 Hindsight 完全不走 pg0 的探测代码路径
      - HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:hindsight@127.0.0.1:5432/hindsight
```

脚本就是 [`deploy/start-hindsight.sh`](../deploy/start-hindsight.sh)，核心是
**先 `pg0 start`、再轮询 `pg0 info` 直到 `"running": true`，然后才 exec 官方入口**。

### 根因（实测证据）

- postgres 每轮日志都是 `ready to accept connections`（7 轮全中，无端口冲突、
  无权限、无磁盘、无 OOM——磁盘剩 330G、OOMKilled=false 都实测排除过）
- pg0 的探测在库 ready **之后 6 秒**执行，拿到的仍是 `None`：
  `PostgreSQL started: None → db_url=None → ValueError → API 退出 → 重启循环`
这是 Hindsight 侧 pg0 包装层的**返回值 bug**，不是数据库起不来——postgres 每轮日志
都是 `ready to accept connections`（磁盘剩 330G、`OOMKilled=false` 都排除过）。
问题出在 `hindsight_api/pg0.py`：

```python
info = await loop.run_in_executor(None, pg0.start)   # 子进程返回
uri  = info.uri                                      # 紧接着再查一次 pg0 info
return uri                                           # 不检查 None、不重试
```

`info.uri` 来自 `pg0 info -o json`。慢机器上这次查询可能还没看到 `running:true`，
于是 `uri=None → db_url=None → ValueError → API 退出 → 重启循环`。

### ⚠️ 两处此前的错误结论，已更正

**（一）「显式写 `pg0://hindsight` 就能根治」——不成立。**
`pg0://hindsight` 走的**正是上面那条会返回 `None` 的代码路径**（`resolve_database_url`
的 `is_pg0` 分支 → `EmbeddedPostgres.ensure_running()`）。2026-10-06 复测仍在
`PostgreSQL started: None` 上崩溃：它的 URL 并没有"来自配置"——`ensure_running()`
照样调用 `start()` 并读返回值。

**（二）显式 `postgresql://` 单独用，是另一个坑。**
它能绕过探测 bug，但**同时也跳过了 postgres 的启动**——Hindsight 只去连一个
"应该已经存在"的库。于是**没有任何人负责启动 postgres**：容器重建（或 NAS 重启、
断电）后 postgres 一并消失，报 `Connection refused`，而 pg0 那条路又没走，
死循环照旧。**此前"稳定 25 小时"只是因为期间没重启过容器。**

所以正确形态是**两者配对**：显式 URL 绕开探测 bug，入口包装补上启动责任。

> ⚠️ **以下老办法已被实测证伪，别浪费时间**：
> - `docker restart hindsight` —— 重启多少次都复发；
> - 删 `data/postmaster.pid` 再重启 —— 锁清干净了签名照旧；锁不是根因。
> - 手工 `pg_ctl start` 救活一次 —— 只对当前容器有效，下次重建照旧复发。
>
> 另注：`PostgreSQL started: None` 是**容器重建后发作**、与 LLM 配置正交
> （每轮重启 LLM 验证都先通过再死在库上），所以**回滚 BASE_URL 治不了它**。

### 验证方式

```bash
docker restart hindsight          # 模拟 NAS 重启/断电恢复
# 期望：日志出现 [start-hindsight] postgres ready after Ns
#      约 2 分钟内 /health 返回 {"status":"healthy","database":"connected"}
#      且 docker inspect 的 RestartCount 保持 0（没有进入崩溃循环）
```

**Q: 日志偶发 `OutputTooLongError: LLM output exceeded token limits (scope=consolidation)`。**
非阻塞。免费档的输出上限比 mimo 小，整合环节偶尔一次超限，Hindsight 自己会提示
「Input may need to be split into smaller chunks」，**下一次尝试通常直接成功**
（实测同一分钟内 error 后紧跟 success）。持续出现才需要处理：
把 consolidation 单独配一个更大的 `HINDSIGHT_API_CONSOLIDATION_LLM_EXTRA_BODY`，
或降低触发频率。单次偶发不用管。

**Q: 日志里 LLM 连接验证 400，但不确定 retain 会不会也 400。**
见上一节「假成功」和「400」两条——验证只是启动自检，被 Hindsight 明确降级为
WARNING（「Server will start but LLM-dependent operations may fail」），不阻塞启动。
真正的判据是第一次真实 retain 能不能过，跑完一次 `verify-deployment.ps1` 看第 3 步。

**Q: 会不会哪天这条车道就没了？**
会。它是公开免费额度，上游随时可能改政策。所以：
（1）桥会在上游报出非零 `cost` 时打 WARNING 日志；
（2）README 列了备用路线，建议同时备好一个真 key 作为兜底。
