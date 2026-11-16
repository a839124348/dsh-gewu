# 原理与边界

> README 讲"能做什么"，这里讲"为什么这样做、哪里不能做"。

## 一、问题从哪来

DSH 把每一轮的推理（reasoning）存在 assistant 消息里，而历史以 message 为单位。
于是下一轮请求会把过去所有轮的思考**原样再上传一遍**。

长会话里，这些过去的草稿会：

- 被模型自己模仿 —— "做。做。做。"这类单字步骤戳越滚越牢
- 让"我查过了"这种没发生的事，变成下一轮的前提
- 占掉 20%~45% 的上下文

实测 6 个真实会话（只数长度，不读内容）：

| 会话事件数 | 推理字符 | 其它字符 | 推理占比 |
|--:|--:|--:|--:|
| 202 | 25,264 | 31,478 | **44.5%** |
| 90 | 4,455 | 12,090 | 26.9% |
| 79 | 2,509 | 6,826 | 26.9% |
| 78 | 1,564 | 6,762 | 18.8% |
| 72 | 2,014 | 9,217 | 17.9% |
| 296 | 2,122 | 20,569 | 9.4% |

中位数大概 20~27%。而且这是保守值：工具结果超过 4KB 会被 spill 到磁盘，
真正进上下文的比例只会更高。

## 二、它怎么做的

每一步开始前（`agent/pre-step`），扫 `session.surface`，把**往轮** assistant 消息里的
`reasoning` 块摘掉，用 `surfaceOp: replace` 在 surface 层换一条不含草稿的副本。

原文仍在会话日志里 —— 可审计、可回放，只是模型看不到了。

## 三、为什么改 surface 而不是拦请求

`llm/stream` 看起来是入口，其实改不动：

- 请求里的每条消息都被 `deepFreeze`
- waterfall 的 `next()` 捕获了原对象，传新对象进去不生效（实测两次）

而模型输入是从 `session.surface` 派生的（`buildRequest → session.deriveMessages`），
所以正确的口子是：

```js
sess.append('assistant/message', { ...ev.data, message: 去掉草稿的副本 }, {
  surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
  sourceEventSeqs: [seq],
})
```

DSH 对 `assistant/message` 的替换没有额外限制（只有 `tool/result` 要求"只能改 content"、
`system/message` 要求"只能换第一个节点"），所以这条路是开的。

## 四、边界（写死，别改）

- 只删 `type === 'reasoning'`；text / tool-call 一个字节不动
- 保留最近 `keepLast` 条（默认 3），当前轮的工具循环要接得上
- 单步最多摘 `maxStripsPerStep` 条（默认 12），历史积压分几步清完
- 任何一条失败都跳过，不阻塞对话
- 不碰 `tool/result`、不碰 user / developer / system 消息
- 不删日志、不改存储

## 五、已知限制

- **只处理跨轮接力，不管单轮内的解码卡死。**
  一步之内模型如果已经在"写。做。写。做。"地打转，这个插件救不了 —— 它要等这一步结束。
- **不保证 UI 不显示思考。** `stream` 字段保留，界面上可能还能展开看，但不再进模型输入。
- **个别 provider 不接受无签名历史。** 替换后 `replayState` 会被去掉，遇到 400 就先
  `enabled: false`。
- **不区分模型。** 对所有 provider 一视同仁。

## 六、排查

| 现象 | 可能原因 | 怎么办 |
|:--|:--|:--|
| 启动没有 `[gewu]` 那行 | 路径错 / profile 改错 / 没重启 | 核对 profile 是不是当前在用的那个 |
| DSH 起不来，YAML 报错 | 缩进或引号错 | 用备份还原；`- id:` 前 4 空格，`name:`/`config:` 前 6 空格 |
| 模型报 400 / invalid thinking / signature | 替换后签名被去掉，个别 provider 不接受 | 先 `enabled: false`，重启，反馈 |
| 长任务开始"忘了为什么这么做" | 摘得太狠 | `keepLast` 调到 5~8 |
| 日志文件变大 | 每条替换新增一个事件（原 `stream` 保留） | 正常，可接受 |

## 七、回滚

把 `config.enabled` 改成 `false`，或删掉那段 `insert`，重启。

日志和原文都没动过，回滚是干净的。

## 八、和核星记忆的关系

- 互不影响。可以同时装，先后顺序无所谓。
- 它不注册工具、不写记忆、不读 `data/`，只动当前会话的 surface。
- 核星监听 `agent/pre-step` 和 `llm/stream`，本插件只监听 `agent/pre-step`，不会重复记录 AI 回复。
