# 原理与边界

> README 讲"能做什么"，这里讲"为什么这样做、哪里不能做"。

## 一、问题从哪来

DSH 把每一轮的推理（reasoning）存在 assistant 消息里，而历史以 message 为单位。
于是下一轮请求会把过去所有轮的思考**原样再上传一遍**。

长会话里，这些过去的草稿会：

- 被模型自己模仿 —— "做。做。做。"这类单字步骤戳越滚越牢
- 让"我查过了"这种没发生的事，变成下一轮的前提
- 占掉 20%~45% 的上下文

实测 6 个真实会话（只数长度，不读内容）：44.5% / 26.9% / 26.9% / 18.8% / 17.9% / 9.4%。

## 二、为什么不能改写 assistant 消息

v0.1.0 走的是 `surfaceOp: replace`。在 DSH 0.1.3+ 上，这条路是死锁：

```js
// dsh-session/lib/index.js · assertSourceEventReferences
if (event.type === "assistant/message" && raw !== void 0)
  throw new Error("assistant/message embeds its source stream and cannot carry sourceEventSeqs");

const missing = shadowedSeqs.filter((seq) => !sources.has(seq));
if (missing.length > 0)
  throw new Error("surface replace: sourceEventSeqs must include every shadowed surface node");
```

- 带 `sourceEventSeqs` → 第一条抛
- 不带 → 第二条抛

**assistant 消息结构上不允许整条替换。** 这是设计决策，不是 bug：
assistant 的 provenance 是它内嵌的 stream，不允许重新归属。

`tool/result` 可以替换（只能改 content），`system/message` 可以替换（只能换 node 0），
唯独 assistant 不行。所以插件不能再往"改记录"这个方向使劲。

## 三、现在的做法：只改视图

模型输入不是从日志直接来的，是从会话派生出来的。挂两个**只读投影**：

```js
session.deriveMessages()      // buildRequest 取模型输入的唯一入口
session.deriveEventMessage()  // compaction 摘要逐条读消息的入口
```

两者都只返回「去掉 reasoning 的副本」：

- 原文不动、surface 不动、日志不写
- 副本按原对象缓存在 WeakMap 里，身份稳定（`buildRequest` 会 deepFreeze 并塞进 `frozenMessages` Set，
  每次新建对象会让这个 Set 一直涨）
- 副本上去掉 `source.replayState`：块数变了，旧签名必然失配，留着只会触发静默降级

## 四、覆盖范围

| 路径 | 经过哪一层 | 覆盖 |
|:--|:--|:--|
| 请求（buildRequest） | `deriveMessages` | ✅ |
| 压缩摘要（compaction-basic） | `deriveEventMessage` | ✅ |
| 图片卸载 / 工具结果裁剪 | `deriveEventMessage` | ✅ |
| 子 agent / fork | 每个 session 各自挂载 | ✅ |
| 重启后恢复的会话 | 首个 pre-step 时挂载 | ✅ |
| 界面展示 / 消息反馈 | 用的是模块级 `deriveEventMessage` | ❌ 不影响（原本就不该动） |
| token-meter 的上下文水位 | 模块级函数 | ⚠️ 可能偏高，真实计费以 provider 回执为准 |

## 五、第三方中转的坑

有些网关没有字段承载上游的思考签名，只能靠「把回放的思考文本取哈希」来重建对话状态。
如果把旧的 reasoning 摘掉，网关重建时会「查无此签名」，重建出的历史和原始记录分叉 ——
表现是偶发故障，很难查。

所以 v0.2.1 加了 `skipProviders`：

```yaml
config:
  skipProviders:
    - 你的provider名
```

命中的 provider 一律不动，日志里会写明「在 skipProviders 里，跳过」。
provider 名从 `request/header` 里读，挂载后的第一次请求就能在 `gewu.log` 里看到。

默认是空列表（所有 provider 都摘）。用官方 API 的不用管；用第三方中转、又遇到偶发
「签名/历史不一致」报错的，把这个 provider 加进去。

## 六、失败与自检

- 挂载失败（方法不存在、实例不可扩展）→ 日志写 `[gewu] 挂载失败：...`，插件不生效，对话照常
- 派生过程中任何异常 → 返回原结果，绝不影响对话
- 桌面版主进程 console 不落盘，所以日志写在 `~/.dsh/gewu/gewu.log`
- 重复挂载有幂等标记，不会叠加包装

## 七、为什么是「按轮」而不是「保留最近 N 条」（v0.3.0）

v0.2.x 的直觉是「留最近 3 条思考，够当前工具循环接得上就行」。这个直觉对了一半：
够用是真的，但它把缓存打碎了。

`keepLast` 是个滑动窗口：

```
第 k 步：    摘 摘 摘 留 留 留
第 k+1 步：  摘 摘 摘 摘 留 留 留     ← 最左边那条「留」翻成「摘」
```

每来一条新的 assistant 消息，就有一条原本保留的变成摘掉。这一步请求和第上一步请求，
在「那条消息」的位置上分叉了 —— provider 的前缀缓存从那里往后全部算未命中。

关键点：**断点不在末尾，而在很靠前的位置**。所以哪怕只挪动一条几十字的消息，
后面几千字都要按 1.0x 重算。单步看：

```
不摘：长度 13833  命中 11241  命中率 88.4%  成本 2830
滑动：长度 13833  命中 11241  命中率 81.3%  成本 3716   ← 长度一样，多花 31%
```

改成按轮切之后：

```
第 k 步：    摘 … 摘 [本轮全留]
第 k+1 步：  摘 … 摘 [本轮全留]     ← 前缀完全一致，全部命中
轮结束 → 下一轮开始：上一轮整体转「摘」，只断一次
```

摘掉的集合**只增不减**，这是前缀稳定的充要条件。

实测（你机器上 12 个真实会话、236 步、DeepSeek 口径 0.1x/1.0x）：

| 版本 | 输入费用 | 上下文 |
|:--|:--|:--|
| 不装 | ×1.00 | 0% |
| v0.2.x 滑动 keepLast=3 | ×1.52 | −10.9% |
| **v0.3.0 按轮切** | **×1.08** | **−16.4%** |

剩下那 8% 是换轮那一刻的必要开销，消不掉：新轮的思考必须回传，否则工具循环接不上。

## 八、验证记录

用隔离的 `DSH_HOME` + 本地假 provider 跑的真实链路（DSH 0.2.2-rc.1）：

```
控制组（留思考）  #3 assistant[thinking(sig)+tool_use] | user[tool_result]
实验组（摘思考）  #3 assistant[tool_use]              | user[tool_result]
```

两次都正常返回（`done`，exit 0），说明 provider 接受"没有思考的历史"。

单测：36 项。除了原有功能，v0.3.0 专门加了三条守门用例：

- 同一轮内多步，摘掉的集合**完全不变**（前缀稳定）
- 跨轮时摘掉的集合**只增不减**（单调，这正是 v0.2.x 的 bug）
- 当前轮带 `tool_call` 的消息，思考**一定保留**（签名安全）

代理侧另有 17 项，包括 Anthropic 协议里 `tool_result` 也是 `role:'user'` 这个陷阱
（不能用来判轮边界）。

## 九、已知限制

- **只处理跨轮接力，不管单轮内的解码卡死。**
  一步之内模型如果已经在"写。做。写。做。"地打转，这个插件救不了。
- **`keepTurns` 最小是 1。** 同一轮里带 `tool_use` 的那条 assistant 消息，thinking 必须原样回传；
  摘到 0 会把当前工具循环的签名一起摘掉，官方 provider 可能直接 400。所以 0 会按 1 处理。
- **依赖 DSH 内部方法名。** 升版改名时补丁挂不上，日志会报，功能退化但不影响对话。
- **token-meter 的水位可能偏高**（它不走这层投影）。
- **不区分模型**，对所有 provider 一视同仁。
- **它省上下文，不省账单。** 缓存单价 0.1x 时费用基本持平（×1.08）；只有折扣更小的中转才省钱。
  目标是降账单的话，不装最省。
- **换轮时那一次断点是物理下限。** 想把 ×1.08 压到 ×1.00，除非不摘当前轮的思考 ——
  但那样插件就没有意义了。

## 十、回滚

把 `config.enabled` 改成 `false`，或删掉那段 `insert`，重启。

插件没有写过任何会话内容，回滚是干净的。

## 十一、和核星记忆的关系

- 互不影响。可以同时装，先后顺序无所谓。
- 不注册工具、不写记忆、不读 `data/`。
- 核星扫常识层用的是 `surface.deriveEventMessage`（surface 对象上的方法），不走这层补丁。
