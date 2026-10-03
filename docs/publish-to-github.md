# 发布到 GitHub

这是给第一次发开源项目的人写的照做清单。全程约 10 分钟。

## 现状

仓库已经 `git init` 并提交了 2 个 commit。本地 git 身份是：

- name: `kyf`
- email: `694982318@qq.com`

⚠️ 这两个值**已经进了 commit 历史**，发之前想改还来得及（见下面第 3 步）。

## 1. 注册 / 登录 GitHub

如果你还没有 GitHub 账号：<https://github.com/signup>

## 2. 装 GitHub CLI（推荐，装了最省事）

Windows 上最简单的是 winget：

```powershell
winget install --id GitHub.cli
```

装完**关掉这个终端重开一个**（PATH 不会自动刷新），然后：

```powershell
gh auth login
```

选 `GitHub.com` → `HTTPS` → `Login with a web browser`，复制它给的 8 位码，
浏览器里粘贴授权。

> 如果你不想装 CLI，GitHub 网页上也能建仓库，只是推送那一步要复制粘贴命令。
> 见第 5 步的「不想装 CLI」。

## 3. 检查提交身份

```powershell
cd <这个项目的路径>
git log -1 --format='%an <%ae>'
```

想换成你的 GitHub 昵称和邮箱（比如 `kyf@users.noreply.github.com`，
这是 GitHub 提供的隐私邮箱）：

```powershell
git config user.name "你的昵称"
git config user.email "你的GitHub邮箱"
```

已经提交了还想改历史（**只有还没 push 时才做**）：

```powershell
git commit --amend --reset-author --no-edit   # 只改最后一次
# 或者全部重写（会改掉所有 commit 的 SHA）：
# git rebase --exec 'git commit --amend --reset-author --no-edit' --root
```

## 4. 建仓库并推送

```powershell
gh repo create free-llm-bridge --public --description "把免密免费 LLM 车道接给任意 OpenAI 兼容应用" --source=. --push
```

一条命令建仓库 + 推送。几秒后浏览器打开你的仓库页面。

### 不想装 CLI

在 <https://github.com/new> 建一个仓库：

- 仓库名填 `free-llm-bridge`
- **不要**勾选 Add a README（本地已经有了，勾了会冲突）
- 点 Create repository

然后：

```powershell
git remote add origin https://github.com/<你的用户名>/free-llm-bridge.git
git push -u origin main
```

推送时会要密码 —— GitHub 现在**不接受账户密码**，要用 Personal Access Token：

1. <https://github.com/settings/tokens/new>
2. Note 随便填，Expiration 设 90 天
3. 勾选 `repo`（或 `public_repo` 就够）
4. Generate → 复制那串 `ghp_...`
5. 粘贴到密码提示处

## 5. 发布后建议做的

**加 topics**，让搜索能找到：

```powershell
gh repo edit --add-topic llm --add-topic openai-compatible --add-topic proxy --add-topic free-tier --add-topic hindsight --add-topic self-hosted
```

**加一句免责说明**（你已经在 LICENSE 里写了，仓库简介再提一次更醒目）——
README 顶部已经有一句了，够用。

**写个 issue 模板**（可选，但对第一次发项目很有帮助，别人提 issue 体验好）：

```powershell
New-Item -Path .github -ItemType Directory -Force | Out-Null
```

创建 `.github/ISSUE_TEMPLATE/bug_report.md`：

```markdown
---
name: Bug 报告
about: 桥的行为不符合预期
---

**发生了什么**

**期望发生什么**

**日志输出**
```
[free-llm-bridge] ...
```

**环境**
- free-llm-bridge 版本：
- Node 版本：
- 系统：
```

## 6. 如果有人提 issue

这个项目的核心承诺是「永不产生账单」，所以 issue 里最该被认真对待的是这一类报告：

> 「我看到请求打到了付费模型上」

`test-free-only.mjs` 里有 5 条断言专门钉这条。如果有人报了，先跑那个测试，
再让他贴 `node --version` 和桥的完整 stderr。

---

## 常见卡点

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `gh: command not found` | 装完没重开终端 | 关掉终端重开 |
| `push` 要密码但输账户密码不认 | GitHub 已禁用密码推送 | 用 Personal Access Token |
| `remote origin already exists` | 之前加过 | `git remote -v` 看，`git remote set-url origin <新地址>` |
| `rejected: non-fast-forward` | 远端有你没有的 commit | `git pull --rebase origin main` 再 push |
| 网页建仓库后 push 报 403 | token 权限不够 | 重开 token 时勾 `repo` |
