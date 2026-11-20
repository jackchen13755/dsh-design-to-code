/**
 * review.ts 评审解析单测（镜像 src/review.ts）。
 * 运行：node test/src/review.test.mjs
 *
 * review.ts 无运行时依赖，直接 transpile + data: URL 加载源码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const js = ts.transpileModule(
  readFileSync(resolve(ROOT, 'src', 'review.ts'), 'utf8'),
  { fileName: 'review.ts', compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText
const { parseReview } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

test('专家表格 级别=major → severity=major（非 info，severitySource=column）', () => {
  const md = [
    '| 级别 | 问题 | 位置 | 期望 | 实际 |',
    '|---|---|---|---|---|',
    '| major | 锚点项边框不对 | less/index.less:48 | 只有左边框 | 四边都有 |',
  ].join('\n')
  const items = parseReview(md)
  assert.equal(items.length, 1, JSON.stringify(items))
  assert.equal(items[0].severity, 'major')
  assert.equal(items[0].severitySource, 'column')
  assert.equal(items[0].location, 'less/index.less:48')
})

test('级别=主要（中文列值）仍识别为 major（b1a6297 表格列识别不变）', () => {
  const md = [
    '| 级别 | 描述 | 位置 |',
    '|---|---|---|',
    '| 主要 | 控件高度不符 | a/b.tsx:12 |',
  ].join('\n')
  const items = parseReview(md)
  assert.equal(items.length, 1)
  assert.equal(items[0].severity, 'major')
  assert.equal(items[0].severitySource, 'column')
})

test('列表项 🔴 前缀 → blocker', () => {
  const items = parseReview('- 🔴 锚点项应为只有左边框（less/index.less:48）')
  assert.equal(items.length, 1)
  assert.equal(items[0].severity, 'blocker')
  assert.equal(items[0].severitySource, 'text')
})

test('列表项 [major] 前缀 → major', () => {
  const items = parseReview('- [major] 锚点项应为只有左边框（less/index.less:48）')
  assert.equal(items.length, 1)
  assert.equal(items[0].severity, 'major')
  assert.equal(items[0].severitySource, 'text')
})

test('纯文本 级别:major 前缀 → major（非 info）', () => {
  const items = parseReview('级别:major 锚点项应为只有左边框（less/index.less:48）')
  assert.equal(items.length, 1)
  assert.equal(items[0].severity, 'major')
  assert.equal(items[0].severitySource, 'text')
})

test('🟠 → major / 🟡 → minor', () => {
  assert.equal(parseReview('- 🟠 锚点项应为只有左边框')[0]?.severity, 'major')
  assert.equal(parseReview('- 🟡 建议优化间距')[0]?.severity, 'minor')
})

test('表格 级别列 emoji 🔴 → blocker', () => {
  const md = [
    '| 级别 | 问题 | 位置 |',
    '|---|---|---|',
    '| 🔴 | 锚点项应为只有左边框 | less/index.less:48 |',
  ].join('\n')
  const items = parseReview(md)
  assert.equal(items.length, 1)
  assert.equal(items[0].severity, 'blocker')
})

test('列表项 + 纯文本规则指向同一条（location+nodeId+text前60 相同）→ 去重为 1 条', () => {
  // 第 1 行走"列表项"分支，第 2 行走"纯文本"分支；两者 location / nodeId / 正文相同 → 应去重
  const md = [
    '- 锚点项应为只有左边框（less/index.less:48）',
    '锚点项应为只有左边框（less/index.less:48）',
  ].join('\n')
  const items = parseReview(md)
  assert.equal(items.length, 1, JSON.stringify(items))
})

test('去重键含 location：正文相同但位置不同 → 保留 2 条（fail-closed，不误合并）', () => {
  const md = [
    '- 锚点项应为只有左边框（less/index.less:48）',
    '- 锚点项应为只有左边框（less/app.less:12）',
  ].join('\n')
  const items = parseReview(md)
  assert.equal(items.length, 2, JSON.stringify(items))
  assert.deepEqual(new Set(items.map((i) => i.location)), new Set(['less/index.less:48', 'less/app.less:12']))
})

test('去重键含 nodeId：正文与位置相同但节点不同 → 保留 2 条', () => {
  const md = [
    '- 边框不对 132:8240（less/index.less:48）',
    '- 边框不对 132:8241（less/index.less:48）',
  ].join('\n')
  const items = parseReview(md)
  assert.equal(items.length, 2, JSON.stringify(items))
  assert.deepEqual(new Set(items.map((i) => i.nodeId)), new Set(['132:8240', '132:8241']))
})

test('无级别关键词的普通条目仍为 info（不误升级）', () => {
  const items = parseReview('- 这是一条纯描述，没有任何级别词')
  // 列表项必出条目，但没有任何级别词 → info（不应被 emoji/前缀规则误升级）
  assert.equal(items.length, 1)
  assert.equal(items[0].severity, 'info')
  assert.equal(items[0].severitySource, 'default')
})
