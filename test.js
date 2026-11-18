/**
 * gewu v0.3.0 单测：纯函数 + 假会话端到端 + 按轮切回归
 * 跑法：node test.js
 *
 * v0.3.0 修的是「滑动窗口把缓存前缀每步打断」。
 * 所以除了原有功能，这里专门盯三件事：
 *   1) 当前轮的思考一条都不摘
 *   2) 同一轮内，摘掉的集合不随步数变化（前缀稳定的前提）
 *   3) 跨轮时摘掉的集合只增不减（单调）
 */

import assert from 'node:assert'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.GEWU_DIR = path.join(os.tmpdir(), 'gewu-test-' + Date.now())

const mod = await import('./gewu.js')
const { name, hasReasoning, reasoningSize, stripMessage, pickStrippable, pickStrippableSeqs, patchSession } = mod

let pass = 0
let fail = 0
function ok(label, fn) {
  try { fn(); pass++; console.log('PASS ' + label) }
  catch (e) { fail++; console.log('FAIL ' + label + ' —— ' + (e && e.message)) }
}

const r = (s) => ({ type: 'reasoning', text: s })
const t = (s) => ({ type: 'text', text: s })
const call = (id) => ({ type: 'tool-call', id, name: 'x', arguments: '{}' })

function msg(i, extra = {}) {
  return {
    id: 'm' + i,
    role: 'assistant',
    content: [r('草稿' + i), t('正文' + i), call('c' + i)],
    source: { kind: 'model', provider: 'p', model: 'm', replayState: { blocks: [] } },
    ...extra,
  }
}

/**
 * 造一个假会话。
 * turns: 每轮几步，例如 [2,3] 表示第一轮 2 步、第二轮 3 步。
 * 每个 user 消息插在该轮第一步之前。
 */
function makeSession(turns = [4], provider = 'test-provider') {
  const events = new Map()
  const nodes = []
  let seq = 0
  let mi = 0
  const plan = Array.isArray(turns) ? turns : [turns]

  plan.forEach((steps, ti) => {
    const turnNo = ti + 1
    // 该轮的 user 消息
    seq++
    const um = { id: 'u' + turnNo, role: 'user', content: [t('问' + turnNo)] }
    events.set(seq, { seq, type: 'user/message', data: { message: um } })
    nodes.push(seq)

    for (let s = 0; s < steps; s++) {
      mi++
      const m = msg(mi)
      seq++
      events.set(seq, {
        seq,
        type: 'assistant/message',
        data: { turn: turnNo, step: s + 1, message: m },
      })
      nodes.push(seq)

      // 除最后一步外，跟一个 tool/result
      if (s < steps - 1) {
        seq++
        const tm = { id: 'tr' + mi, role: 'tool', content: [t('结果' + mi)] }
        events.set(seq, { seq, type: 'tool/result', data: { turn: turnNo, step: s + 1, message: tm } })
        nodes.push(seq)
      }
    }
  })

  return {
    id: 'test-session',
    surface: { nodes, contentGeneration: 0 },
    eventAt(s) { return events.get(s) },
    deriveMessages() {
      // 复刻 DSH：逐节点调用 deriveEventMessage，空内容返回 null 时跳过
      const out = []
      for (const s of nodes) {
        const m = this.deriveEventMessage(events.get(s))
        if (m) out.push(m)
      }
      return out
    },
    deriveEventMessage(ev) {
      if (!ev) return null
      const m = ev.data && ev.data.message
      if (!m) return null
      if (Array.isArray(m.content) && m.content.length === 0) return null
      return m
    },
    requestHeader() { return { config: { provider, model: 'm' } } },
  }
}

function cfg(over = {}) { return { enabled: true, keepTurns: 1, dryRun: false, ...over } }
const stats = () => ({ version: 2, updatedAt: '', sessions: {} })

const hasR = (m) => !!(m && Array.isArray(m.content) && m.content.some((b) => b && b.type === 'reasoning'))

// ── 纯函数 ────────────────────────────────────────────
ok('name', () => assert.equal(name, 'gewu'))
ok('hasReasoning: 有', () => assert.equal(hasReasoning(msg(1)), true))
ok('hasReasoning: 无', () => assert.equal(hasReasoning({ content: [t('x')] }), false))
ok('hasReasoning: 非数组', () => assert.equal(hasReasoning({ content: 'x' }), false))

ok('reasoningSize', () => {
  assert.deepEqual(reasoningSize({ content: [r('abc'), r('de'), t('xyz')] }), { blocks: 2, chars: 5 })
})

ok('stripMessage: 只删 reasoning', () => {
  const out = stripMessage(msg(1))
  assert.deepEqual(out.content.map((b) => b.type), ['text', 'tool-call'])
  assert.equal(out.content[0].text, '正文1')
  assert.equal(out.content[1].id, 'c1')
  assert.equal(out.id, 'm1')
})

ok('stripMessage: 去掉 replayState', () => {
  const out = stripMessage(msg(1))
  assert.equal('replayState' in out.source, false)
  assert.equal(out.source.provider, 'p')
})

ok('stripMessage: 不动原对象', () => {
  const src = msg(1)
  const before = JSON.stringify(src)
  stripMessage(src)
  assert.equal(JSON.stringify(src), before)
})

ok('stripMessage: 非 assistant 返回 null', () => assert.equal(stripMessage({ ...msg(1), role: 'user' }), null))
ok('stripMessage: 没思考返回 null', () => assert.equal(stripMessage({ ...msg(1), content: [t('x')] }), null))
ok('stripMessage: 摘完为空返回 null', () => assert.equal(stripMessage({ ...msg(1), content: [r('x')] }), null))

// ── 按轮切：pickStrippableSeqs ─────────────────────────
ok('pickStrippableSeqs: 单轮 4 步 → 一条都不摘', () => {
  const s = makeSession([4])
  assert.equal(pickStrippableSeqs(s, 1).size, 0)
})

ok('pickStrippableSeqs: 两轮（3+3）→ 只摘第一轮', () => {
  const s = makeSession([3, 3])
  // 第一轮 m1..m3 应被摘，第二轮 m4..m6 保留
  const dropped = [...pickStrippableSeqs(s, 1)]
  const droppedIds = dropped
    .map((seq) => s.eventAt(seq).data.message.id)
    .sort()
  assert.deepEqual(droppedIds, ['m1', 'm2', 'm3'])
})

ok('pickStrippableSeqs: 三轮（2+2+2）→ 摘前两轮', () => {
  const s = makeSession([2, 2, 2])
  const ids = [...pickStrippableSeqs(s, 1)]
    .map((seq) => s.eventAt(seq).data.message.id).sort()
  assert.deepEqual(ids, ['m1', 'm2', 'm3', 'm4'])
})

ok('pickStrippableSeqs: keepTurns=2 → 三轮只摘第一轮', () => {
  const s = makeSession([2, 2, 2])
  const ids = [...pickStrippableSeqs(s, 2)]
    .map((seq) => s.eventAt(seq).data.message.id).sort()
  assert.deepEqual(ids, ['m1', 'm2'])
})

ok('pickStrippableSeqs: 少数消息缺 turn 也不炸', () => {
  const s = makeSession([2, 2])
  // 抹掉一条的 turn
  const ev = s.eventAt(3)
  if (ev && ev.data) delete ev.data.turn
  const size = pickStrippableSeqs(s, 1).size
  assert.equal(typeof size, 'number')
})

// ── 核心回归：前缀稳定 ────────────────────────────────
ok('回归：同一轮内多步，摘掉的集合完全不变', () => {
  const s = makeSession([6])            // 一轮 6 步
  const sets = []
  for (let step = 1; step <= 6; step++) {
    // 模拟第 step 步时的 surface（只到第 step 个 assistant）
    const cut = s.surface.nodes.findIndex((seq) => {
      const ev = s.eventAt(seq)
      return ev && ev.type === 'assistant/message' && ev.data.step === step
    })
    const partial = {
      id: s.id,
      surface: { nodes: s.surface.nodes.slice(0, cut + 1), contentGeneration: 0 },
      eventAt: (x) => s.eventAt(x),
      requestHeader: s.requestHeader,
    }
    sets.push([...pickStrippableSeqs(partial, 1)].sort((a, b) => a - b))
  }
  // 6 步全部为空（当前轮不摘），所以集合恒等
  for (const st of sets) assert.deepEqual(st, [])
})

ok('回归：跨轮时摘掉的集合只增不减（单调）', () => {
  const s = makeSession([3, 3, 3])
  const snapshots = []
  for (let i = 0; i < s.surface.nodes.length; i++) {
    const partial = {
      id: s.id,
      surface: { nodes: s.surface.nodes.slice(0, i + 1), contentGeneration: i },
      eventAt: (x) => s.eventAt(x),
      requestHeader: s.requestHeader,
    }
    snapshots.push(pickStrippableSeqs(partial, 1))
  }
  for (let i = 1; i < snapshots.length; i++) {
    for (const seq of snapshots[i - 1]) {
      assert.equal(snapshots[i].has(seq), true,
        'seq ' + seq + ' 在第 ' + (i - 1) + ' 步被摘，第 ' + i + ' 步又留了回来——这正是 v0.2.x 的 bug')
    }
  }
})

ok('回归：当前轮带 tool-call 的消息，思考一定保留', () => {
  const s = makeSession([4, 4])
  patchSession(s, cfg({ keepTurns: 1 }), stats())
  const out = s.deriveMessages()
  // 第二轮的第 1..4 步（末尾 4 条 assistant）
  const tail = out.filter((m) => m.role === 'assistant').slice(-4)
  for (const m of tail) {
    const hasToolCall = m.content.some((b) => b.type === 'tool-call')
    if (hasToolCall) {
      assert.equal(hasR(m), true, '当前轮带 tool-call 的 assistant 被摘了思考：' + m.id)
    }
  }
})

// ── pickStrippable（按位置，保留兼容）──────────────────
ok('pickStrippable: 摘掉前 keepFrom 条里的思考', () => {
  const s = makeSession([4, 4])
  const all = s.deriveMessages()
  // 前 8 条里含 4 条 assistant（其余是 user / tool/result），所以 keepFrom=8 应摘到 4 条
  const drop = pickStrippable(all, 8)
  assert.equal(drop.size, 4)
})

// ── 假会话端到端 ──────────────────────────────────────
ok('patchSession: 成功挂载', () => {
  const s = makeSession([4])
  assert.equal(patchSession(s, cfg(), stats()), true)
})

ok('deriveMessages: 往轮去掉思考，当前轮完整保留', () => {
  const s = makeSession([3, 3])
  patchSession(s, cfg({ keepTurns: 1 }), stats())
  const out = s.deriveMessages()
  const assistants = out.filter((m) => m.role === 'assistant')
  assert.equal(assistants.length, 6)
  // 前 3 条（第一轮）无思考
  for (let i = 0; i < 3; i++) assert.equal(hasR(assistants[i]), false)
  // 后 3 条（第二轮）有思考
  for (let i = 3; i < 6; i++) assert.equal(hasR(assistants[i]), true)
})

ok('deriveMessages: text / tool-call 不丢', () => {
  const s = makeSession([2, 2])
  patchSession(s, cfg({ keepTurns: 1 }), stats())
  const out = s.deriveMessages()
  const first = out.find((m) => m.role === 'assistant')
  assert.deepEqual(first.content.map((b) => b.type), ['text', 'tool-call'])
  assert.equal(first.content[0].text, '正文1')
})

ok('deriveMessages: 同一对象重复派生，副本身份稳定', () => {
  const s = makeSession([2, 2])
  patchSession(s, cfg({ keepTurns: 1 }), stats())
  const a = s.deriveMessages()
  const b = s.deriveMessages()
  const a0 = a.find((m) => m.role === 'assistant')
  const b0 = b.find((m) => m.role === 'assistant')
  assert.equal(a0, b0)
  assert.notEqual(a0, s.eventAt(3).data.message)
})

ok('deriveMessages: 原文未被改', () => {
  const s = makeSession([2, 2])
  patchSession(s, cfg({ keepTurns: 1 }), stats())
  s.deriveMessages()
  // seq 3 是第一轮第一个 assistant（seq 1 是 user，seq 2 是 assistant，seq 3 是 tool/result…）
  const firstAssistantSeq = s.surface.nodes.find((seq) => {
    const ev = s.eventAt(seq)
    return ev && ev.type === 'assistant/message'
  })
  assert.equal(hasR(s.eventAt(firstAssistantSeq).data.message), true)
})

ok('keepTurns=0 被抬到 1：当前轮保留', () => {
  const s = makeSession([3, 3])
  patchSession(s, cfg({ keepTurns: 0 }), stats())
  const out = s.deriveMessages()
  const assistants = out.filter((m) => m.role === 'assistant')
  assert.equal(hasR(assistants[5]), true)
  assert.equal(hasR(assistants[0]), false)
})

ok('dryRun: 不改视图，只记账', () => {
  const st = stats()
  const s = makeSession([2, 2])
  patchSession(s, cfg({ keepTurns: 1, dryRun: true }), st)
  const out = s.deriveMessages()
  assert.equal(out.filter((m) => m.role === 'assistant').every((m) => hasR(m)), true)
  assert.equal(st.sessions['test-session'].stripped, 2)
})

ok('deriveEventMessage: 往轮事件去思考，当前轮保留', () => {
  const s = makeSession([2, 2])
  patchSession(s, cfg({ keepTurns: 1 }), stats())
  // seq 3 是第一轮第一个 assistant
  assert.equal(hasR(s.deriveEventMessage(s.eventAt(3))), false)
  // 最后一条 assistant 是当前轮
  const lastSeq = s.surface.nodes[s.surface.nodes.length - 1]
  assert.equal(hasR(s.deriveEventMessage(s.eventAt(lastSeq))), true)
})

ok('deriveEventMessage: 非 assistant 原样返回', () => {
  const s = makeSession([2])
  patchSession(s, cfg(), stats())
  const ev = { seq: 99, type: 'user/message', data: { message: { role: 'user', content: [t('hi')] } } }
  assert.equal(s.deriveEventMessage(ev).role, 'user')
})

ok('重复 patchSession 不叠加', () => {
  const s = makeSession([2])
  const c = cfg()
  patchSession(s, c, stats())
  const wrapped = s.deriveMessages
  patchSession(s, c, stats())
  assert.equal(s.deriveMessages, wrapped)
})

ok('缺方法时返回 false，不抛', () => {
  const s = { id: 'x', surface: { nodes: [] } }
  assert.equal(patchSession(s, cfg(), stats()), false)
})

ok('消息 content 异常不炸', () => {
  const s = makeSession([2])
  s.deriveMessages = () => [{ id: 'bad', role: 'assistant', content: null }]
  patchSession(s, cfg(), stats())
  assert.equal(s.deriveMessages().length, 1)
})

ok('统计文件写入', () => {
  const p = path.join(process.env.GEWU_DIR, 'stats.json')
  const s = makeSession([2, 2])
  patchSession(s, cfg({ keepTurns: 1 }), stats())
  s.deriveMessages()
  assert.equal(fs.existsSync(p), true)
  const o = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.equal(o.version, 2)
  assert.equal(o.sessions['test-session'].stripped, 2)
})

ok('skipProviders: 命中的 provider 不摘', () => {
  const s = makeSession([2, 2], 'gateway-x')
  patchSession(s, cfg({ keepTurns: 1, skipProviders: ['gateway-x'] }), stats())
  const out = s.deriveMessages()
  assert.equal(out.filter((m) => m.role === 'assistant').every((m) => hasR(m)), true)
})

ok('skipProviders: 没命中照常摘', () => {
  const s = makeSession([2, 2], 'official-x')
  patchSession(s, cfg({ keepTurns: 1, skipProviders: ['gateway-x'] }), stats())
  const out = s.deriveMessages()
  const first = out.find((m) => m.role === 'assistant')
  assert.equal(hasR(first), false)
})

ok('兼容: 老配置写了 keepLast 不报错，按 keepTurns 处理', () => {
  const s = makeSession([2, 2])
  // 直接给 patchSession 一个带 keepLast 的配置（模拟老配置）
  const c = { enabled: true, keepLast: 3, keepTurns: 1, dryRun: false }
  assert.equal(patchSession(s, c, stats()), true)
  const out = s.deriveMessages()
  const assistants = out.filter((m) => m.role === 'assistant')
  assert.equal(hasR(assistants[3]), true)
})

console.log('\n' + pass + '/' + (pass + fail) + ' PASS' + (fail ? '，' + fail + ' FAIL' : ''))
process.exit(fail ? 1 : 0)
