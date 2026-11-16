# INSTALL-FOR-AI.md — 给 DSH 模型的安装说明书

> **适用版本：gewu v0.2.0。**
> v0.1.0 的安装步骤一样，但旧版在 DSH 0.1.3+ 上无效 —— 如果发现装的是旧版，直接覆盖升级，不用重装。
>
> **读者：DSH 里的模型，不是用户。**
> 用户可能不懂 YAML、路径、命令。你来装，用户只负责"允许、重启、看结果"。
>
> 目标：把 `gewu` 装进当前 DSH profile，让**往轮的思考不再进入下一轮上下文**。
> 装好的标志：`~/.dsh/gewu/gewu.log` 里出现 `[gewu] 已挂载 session=...`，用几轮后出现 `[gewu] 已摘 N 条`。
>
> **红线：**
> - 不删任何东西；不改 DSH 源码；不动会话日志、不动 `~/.dsh/sessions`。
> - **只追加一段 `- insert:`**，不碰文件里已有的任何条目（尤其别的插件的配置）。
> - 改 `cordis.patch.yml` 前必须备份。
> - 路径必须先验证存在，**不许猜**。
> - **没看到启动日志那行，就不许说"装好了"。** 失败要说失败。

---

## 0. 先确认环境

```powershell
node -v
dsh --version
```

要求：

- Node **>= 18**（推荐 20+）
- DSH **0.2.x**（实测 0.2.2-rc.1）
- 能找到 profile 配置文件

按顺序找，**用第一个存在的**：

```
%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml       ← 一般 `dsh web` 用这个
%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml  ← 无界面模式
```

两个都存在时，问用户一句："你平时是开网页界面（web），还是命令行（headless）？" 别自己猜。

---

## 1. 找到插件文件

### A. 用户给了仓库目录或文件路径

仓库根目录下就是插件：

```
<仓库目录>\gewu.js
```

如果是文件路径，就用用户给的那个路径。

验证（必须做，别跳过）：

```powershell
Test-Path '<插件路径>'
Get-Content '<插件路径>' -TotalCount 3
```

第一段注释里应该有 `gewu`。没有就说明路径错了，停下来问用户。

### B. 用户只发了文件内容

把内容原样保存成一个新文件，**不要放下载目录**（会被清理）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\gewu-plugin" | Out-Null
# 然后把内容写入：
#   %USERPROFILE%\.dsh\gewu-plugin\gewu.js
```

**注意**：同目录下必须有 `package.json`（内容是 `{"type":"module"}`），
否则 Node 会把 `.js` 当 CommonJS，`import` 直接报错。如果用户只给了插件本体，
你替他补一个 `package.json`。

### C. 用户只给了仓库链接

先 clone 或下载到 `%USERPROFILE%\dsh-gewu`，再回到 A。

---

## 2. 备份并追加配置

### 2.1 先读一遍

```powershell
Get-Content '<profile路径>'
```

检查两件事：

1. 里面**已经有** `gewu` → 已装过，跳到第 4 步验证，不要重复插入。
2. 文件末尾有没有换行。没有就先补一个，否则追加后 YAML 会连成一行。

### 2.2 备份

```powershell
$patch = '<profile路径>'
Copy-Item $patch "$patch.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
```

### 2.3 追加（原样，注意缩进）

```yaml
- insert:
    - id: gewu
      name: 'D:/你的路径/gewu.js'
      config:
        keepLast: 3
```

规则：

- `name` 用**绝对路径**，`/` 或 `\\` 都行，**必须用单引号包起来**（路径里有中文、空格也不会坏）
- 缩进：`- insert:` 顶格；`- id:` 前 4 个空格；`name:` / `config:` 前 6 个空格
- 不要写 `transport`、不要写 `provider`，这个插件不需要
- 不要动文件里已有的缩进风格

---

## 3. 重启 DSH

让用户自己重启（关掉再开，或按他平时的方式）。**不要自己去 kill 进程。**

重启是必须的：DSH 只在启动时读 profile，热改不生效。

---

## 4. 验证（四条，缺一条都不算成功）

### 4.1 启动日志

**不要看终端** —— 桌面版主进程的 console 不落盘。看文件：

```powershell
Get-Content "$env:USERPROFILE\.dsh\gewu\gewu.log" -Tail 20
```

应该出现两行：

```
[gewu] 启动：keepLast=3
[gewu] 已挂载 session=session-xxxx keepLast=3
```

只有第一行、没有第二行 → 说明还没走到 pre-step（正常，聊一句就会挂上）。
出现 `[gewu] 挂载失败：...` → DSH 版本对不上，看第 6 节。

如果文件根本不存在 → 看第 6 节排查。

### 4.2 跑几轮再看日志

在一个**已经有十几轮的老会话**里正常聊两三轮，`gewu.log` 里应该出现：

```
[gewu] 已摘 198 条 / 160955 字（保留最近 3 条）
```

数字会在几轮之内涨上来，然后稳定在「当前水位」（不是累计值，重启不会翻倍）。

### 4.3 统计文件

```powershell
Get-Content "$env:USERPROFILE\.dsh\gewu\stats.json"
```

里面有每个会话的 `stripped / chars`（当前被摘掉多少，不是累计）。

### 4.4 行为验证

让用户在同一会话里发这句话：

> 你前面几轮思考里都写了什么？

**装之前**能复述较早的思考；**装之后**应该只剩最近 3 条，更早的说"看不到了"。

---

## 5. 汇报格式（照这个说，别加戏）

```
gewu 安装结果
- 插件文件：<绝对路径>
- profile：<绝对路径>
- keepLast：3
- gewu.log：已挂载 / 挂载失败 / 没有文件
- 已摘统计：<stats.json 里的数字>
- 异常：无 / <具体报错>
```

不许写"应该没问题"、"理论上可用"。没看到日志就写没看到。

---

## 6. 排查

| 现象 | 原因 | 处理 |
|:--|:--|:--|
| `gewu.log` 不存在 | 路径错 / profile 改错文件 / 没重启 | 核对 2.1 的文件是不是当前在用的；确认重启 |
| 日志里是 `[gewu] 挂载失败：deriveMessages=...` | DSH 版本对不上（内部方法名变了） | 如实汇报版本号；先 `enabled: false` |
| 日志里只有「启动」没有「已挂载」 | 还没聊过天，pre-step 没触发 | 发一句话再看 |
| DSH 起不来，YAML 报错 | 缩进或引号错 | 用备份还原，重做 2.3，注意 4/6 空格 |
| `Cannot use import statement outside a module` | 插件目录缺 `package.json` 或没写 `"type":"module"` | 补上，再重启 |
| 模型报 400 / invalid thinking / signature | 个别 provider 不接受无签名历史 | 把 `enabled: false` 加上，重启，如实汇报 |
| 长任务开始"忘了为什么这么做" | 摘得太狠 | `keepLast` 改 5，重启 |
| QQ 或其他插件异常 | 极小概率事件，需定位 | 先 `enabled: false` 确认是否本插件导致，再汇报 |

**排查时不要做的事：**

- 不要手改会话日志去"验证"
- 不要在真实会话上跑插件的内部函数做实验
- 不要为了让它跑起来去改 DSH 源码
- 不要顺手升级/降级其他插件

---

## 7. 回滚

两种都行，做完重启：

1. 把 `config` 里加一行 `enabled: false`
2. 或者删掉整个 `- insert:` 段，用备份还原

回滚是干净的：插件从没改过日志、没改过记忆、没删过任何内容。

---

## 8. 它和核星记忆的关系

- **互不影响**。可以同时装，先后顺序无所谓。
- 它不注册工具、不写记忆、不读 `data/`，只动当前会话的 surface。
- 核星监听的是 `agent/pre-step` 和 `llm/stream`，本插件只监听 `agent/pre-step`，
  不会重复记录 AI 回复。
