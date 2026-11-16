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

## 五、失败与自检

- 挂载失败（方法不存在、实例不可扩展）→ 日志写 `[gewu] 挂载失败：...`，插件不生效，对话照常
- 派生过程中任何异常 → 返回原结果，绝不影响对话
- 桌面版主进程 console 不落盘，所以日志写在 `~/.dsh/gewu/gewu.log`
- 重复挂载有幂等标记，不会叠加包装

## 六、验证记录

用隔离的 `DSH_HOME` + 本地假 provider 跑的真实链路（DSH 0.2.2-rc.1）：

```
控制组（keepLast=1）  #3 assistant[thinking(sig)+tool_use] | user[tool_result]
实验组（keepLast=0）  #3 assistant[tool_use]              | user[tool_result]
```

两次都正常返回（`done`，exit 0），说明 provider 接受"没有思考的历史"。

单测：27 项，覆盖只删 reasoning、保留 text/tool-call、副本身份稳定、dryRun、幂等、异常不炸。

## 七、已知限制

- **只处理跨轮接力，不管单轮内的解码卡死。**
  一步之内模型如果已经在"写。做。写。做。"地打转，这个插件救不了。
- **依赖 DSH 内部方法名。** 升版改名时补丁挂不上，日志会报，功能退化但不影响对话。
- **token-meter 的水位可能偏高**（它不走这层投影）。
- **不区分模型**，对所有 provider 一视同仁。

## 八、回滚

把 `config.enabled` 改成 `false`，或删掉那段 `insert`，重启。

插件没有写过任何会话内容，回滚是干净的。

## 九、和核星记忆的关系

- 互不影响。可以同时装，先后顺序无所谓。
- 不注册工具、不写记忆、不读 `data/`。
- 核星扫常识层用的是 `surface.deriveEventMessage`（surface 对象上的方法），不走这层补丁。
