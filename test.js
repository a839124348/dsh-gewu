/**
 * gewu v0.2.0 单测：纯函数 + 假会话端到端
 * 跑法：node test.js
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

function makeSession(n, provider = 'test-provider') {
  const events = new Map()
  const nodes = []
  for (let i = 1; i <= n; i++) {
    const m = msg(i)
    events.set(i, { seq: i, type: 'assistant/message', data: { message: m } })
    nodes.push(i)
  }
  return {
    id: 'test-session',
    surface: { nodes, contentGeneration: 0 },
    eventAt(s) { return events.get(s) },
    deriveMessages() { return nodes.map((s) => events.get(s).data.message) },
    deriveEventMessage(ev) { return ev && ev.data ? ev.data.message : null },
    requestHeader() { return { config: { provider, model: 'm' } } },
  }
}

function cfg(over = {}) { return { enabled: true, keepLast: 3, dryRun: false, ...over } }
const stats = { version: 2, updatedAt: '', sessions: {} }

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

ok('pickStrippable: 保留最后 3 条', () => {
  const s = makeSession(8)
  const drop = pickStrippable(s.deriveMessages(), 3)
  assert.equal(drop.size, 5)
  assert.deepEqual([...drop].map((m) => m.id), ['m1', 'm2', 'm3', 'm4', 'm5'])
})

ok('pickStrippable: 不够 keepLast 不摘', () => {
  const s = makeSession(2)
  assert.equal(pickStrippable(s.deriveMessages(), 3).size, 0)
})

ok('pickStrippableSeqs: 保留最后 3 条', () => {
  const s = makeSession(6)
  assert.deepEqual([...pickStrippableSeqs(s, 3)], [1, 2, 3])
})

// ── 假会话端到端 ──────────────────────────────────────
ok('patchSession: 成功挂载', () => {
  const s = makeSession(6)
  assert.equal(patchSession(s, cfg(), stats), true)
})

ok('deriveMessages: 老消息去掉思考，最近 3 条保留', () => {
  const s = makeSession(6)
  patchSession(s, cfg({ keepLast: 3 }), stats)
  const out = s.deriveMessages()
  assert.equal(out.length, 6)
  for (let i = 0; i < 3; i++) assert.equal(out[i].content.some((b) => b.type === 'reasoning'), false)
  for (let i = 3; i < 6; i++) assert.equal(out[i].content.some((b) => b.type === 'reasoning'), true)
})

ok('deriveMessages: text / tool-call 不丢', () => {
  const s = makeSession(4)
  patchSession(s, cfg({ keepLast: 1 }), stats)
  const out = s.deriveMessages()
  assert.deepEqual(out[0].content.map((b) => b.type), ['text', 'tool-call'])
  assert.equal(out[0].content[0].text, '正文1')
})

ok('deriveMessages: 同一对象重复派生，副本身份稳定', () => {
  const s = makeSession(5)
  patchSession(s, cfg({ keepLast: 2 }), stats)
  const a = s.deriveMessages()
  const b = s.deriveMessages()
  assert.equal(a[0], b[0])
  assert.equal(a[1], b[1])
  assert.notEqual(a[0], s.eventAt(1).data.message)
})

ok('deriveMessages: 原文未被改', () => {
  const s = makeSession(5)
  patchSession(s, cfg({ keepLast: 2 }), stats)
  s.deriveMessages()
  assert.equal(s.eventAt(1).data.message.content.some((b) => b.type === 'reasoning'), true)
})

ok('keepLast=0 全摘', () => {
  const s = makeSession(4)
  patchSession(s, cfg({ keepLast: 0 }), stats)
  const out = s.deriveMessages()
  assert.equal(out.every((m) => !m.content.some((b) => b.type === 'reasoning')), true)
})

ok('dryRun: 不改视图，只记账', () => {
  const st = { version: 2, updatedAt: '', sessions: {} }
  const s = makeSession(5)
  patchSession(s, cfg({ keepLast: 1, dryRun: true }), st)
  const out = s.deriveMessages()
  assert.equal(out.every((m) => m.content.some((b) => b.type === 'reasoning')), true)
  assert.equal(st.sessions['test-session'].stripped, 4)
})

ok('deriveEventMessage: 老事件去思考，最近保留', () => {
  const s = makeSession(5)
  patchSession(s, cfg({ keepLast: 2 }), stats)
  assert.equal(s.deriveEventMessage(s.eventAt(1)).content.some((b) => b.type === 'reasoning'), false)
  assert.equal(s.deriveEventMessage(s.eventAt(5)).content.some((b) => b.type === 'reasoning'), true)
})

ok('deriveEventMessage: 非 assistant 原样返回', () => {
  const s = makeSession(3)
  patchSession(s, cfg(), stats)
  const ev = { seq: 9, type: 'user/message', data: { message: { role: 'user', content: [t('hi')] } } }
  assert.equal(s.deriveEventMessage(ev).role, 'user')
})

ok('重复 patchSession 不叠加', () => {
  const s = makeSession(4)
  const c = cfg({ keepLast: 1 })
  patchSession(s, c, stats)
  const wrapped = s.deriveMessages
  patchSession(s, c, stats)
  assert.equal(s.deriveMessages, wrapped)
})

ok('缺方法时返回 false，不抛', () => {
  const s = { id: 'x', surface: { nodes: [] } }
  assert.equal(patchSession(s, cfg(), stats), false)
})

ok('消息 content 异常不炸', () => {
  const s = makeSession(3)
  s.deriveMessages = () => [{ id: 'bad', role: 'assistant', content: null }]
  patchSession(s, cfg({ keepLast: 0 }), stats)
  assert.equal(s.deriveMessages().length, 1)
})

ok('统计文件写入', () => {
  const p = path.join(process.env.GEWU_DIR, 'stats.json')
  const s = makeSession(4)
  patchSession(s, cfg({ keepLast: 1 }), stats)
  s.deriveMessages()
  assert.equal(fs.existsSync(p), true)
  const o = JSON.parse(fs.readFileSync(p, 'utf8'))
  assert.equal(o.version, 2)
  assert.equal(o.sessions['test-session'].stripped, 3)
})

ok('skipProviders: 命中的 provider 不摘', () => {
  const s = makeSession(5, 'gateway-x')
  patchSession(s, cfg({ keepLast: 1, skipProviders: ['gateway-x'] }), stats)
  const out = s.deriveMessages()
  assert.equal(out.every((m) => m.content.some((b) => b.type === 'reasoning')), true)
  assert.equal(s.deriveEventMessage(s.eventAt(1)).content.some((b) => b.type === 'reasoning'), true)
})

ok('skipProviders: 没命中照常摘', () => {
  const s = makeSession(5, 'official-x')
  patchSession(s, cfg({ keepLast: 1, skipProviders: ['gateway-x'] }), stats)
  const out = s.deriveMessages()
  assert.equal(out[0].content.some((b) => b.type === 'reasoning'), false)
})

console.log('\n' + pass + '/' + (pass + fail) + ' PASS' + (fail ? '，' + fail + ' FAIL' : ''))
process.exit(fail ? 1 : 0)
