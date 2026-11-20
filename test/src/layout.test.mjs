/**
 * layout.ts 单测（镜像 src/layout.ts）。
 *
 * 运行（不依赖 lib/ 构建产物，直接转译本席位的源码）：
 *   node test/src/layout.test.mjs
 *
 * 覆盖：verifyFlexPlan 返回的 mismatches 是渲染层强制归位的数据源——
 *       expected=设计坐标、actual=flex 推断值、delta 正确；无 mismatch/隐藏/绝对子项等边界。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = resolve(ROOT, 'src')

const require = createRequire(import.meta.url)
let ts
try {
  ts = require('typescript')
} catch {
  const cands = [resolve(ROOT, '..', 'dsh-figma-reader', 'node_modules', 'typescript'), process.env.TS_LIB].filter(Boolean)
  for (const c of cands) { try { ts = require(c); break } catch { /* next */ } }
  if (!ts) throw new Error('typescript 不可用：请 npm install 或设置 TS_LIB')
}

const TMP = mkdtempSync(join(tmpdir(), 'dsh-d2c-layout-'))
for (const name of ['design.ts', 'layout.ts']) {
  const src = readFileSync(resolve(SRC, name), 'utf8')
  const js = ts.transpileModule(src, {
    fileName: name,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  writeFileSync(join(TMP, name.replace(/\.ts$/, '.js')), js, 'utf8')
}
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* noop */ } })

const { verifyFlexPlan } = await import(pathToFileURL(join(TMP, 'layout.js')).href)

function mkNode(id, x, y, w, h, extra = {}) {
  return { id, type: 'FRAME', name: id, kind: 'frame', rx: x, ry: y, x, y, w, h, children: [], raw: {}, ...extra }
}
function modelWith(child) {
  const container = mkNode('C:1', 10, 10, 300, 100, {
    layout: { mode: 'HORIZONTAL', paddingLeft: 10, paddingTop: 10, spacing: 0, primaryAlign: 'MIN', counterAlign: 'MIN' },
    children: [child],
  })
  const root = mkNode('root', 0, 0, 400, 300, { kind: 'root', type: 'ROOT', children: [container] })
  return { tree: root }
}

// ── verifyFlexPlan 返回形状（供渲染层直接消费） ─────────────────────────
test('verifyFlexPlan 返回 containers/flowChildren/mismatches 三个字段', () => {
  const plan = verifyFlexPlan(modelWith(mkNode('CH:1', 35, 25, 50, 20)))
  assert.deepEqual(Object.keys(plan).sort(), ['containers', 'flowChildren', 'mismatches'])
  assert.equal(plan.containers, 1)
  assert.equal(plan.flowChildren, 1)
})

test('mismatch.expected = 设计坐标，mismatch.actual = flex 推断值，delta 正确', () => {
  const plan = verifyFlexPlan(modelWith(mkNode('CH:1', 35, 25, 50, 20)))
  assert.equal(plan.mismatches.length, 1)
  const m = plan.mismatches[0]
  assert.equal(m.id, 'CH:1')
  assert.equal(m.containerId, 'C:1')
  assert.deepEqual(m.expected, { x: 35, y: 25, w: 50, h: 20 }, 'expected 必须是设计坐标（基准页强制归位的目标）')
  assert.deepEqual(m.actual, { x: 20, y: 20, w: 50, h: 20 }, 'actual 是 flex 按 padding 推出来的位置')
  assert.deepEqual(m.delta, [-15, -5, 0, 0], 'delta = actual - expected')
})

test('设计坐标与 flex 推断一致时 mismatches 为空', () => {
  const plan = verifyFlexPlan(modelWith(mkNode('CH:1', 20, 20, 50, 20)))
  assert.equal(plan.mismatches.length, 0, '无偏差时不应报 mismatch')
})

// ── 边界输入 ────────────────────────────────────────────────────────────
test('边界：容差 tol 内的偏差不算 mismatch', () => {
  // 设计 x=21、flex 推断 x=20，偏差 1px；tol=1 时不算，tol=0.5 时算。
  const m = modelWith(mkNode('CH:1', 21, 20, 50, 20))
  assert.equal(verifyFlexPlan(m, 1).mismatches.length, 0, 'tol=1 时 1px 偏差在容差内')
  assert.equal(verifyFlexPlan(m, 0.5).mismatches.length, 1, 'tol=0.5 时 1px 偏差应报 mismatch')
})

test('边界：隐藏节点与绝对定位子项不参与 mismatch 检测', () => {
  const hidden = mkNode('H:1', 35, 25, 50, 20, { raw: { visible: false } })
  const absolute = mkNode('A:1', 35, 25, 50, 20, { layout: { absolute: true } })
  const container = mkNode('C:1', 10, 10, 300, 100, {
    layout: { mode: 'HORIZONTAL', paddingLeft: 10, paddingTop: 10, spacing: 0 },
    children: [hidden, absolute],
  })
  const root = mkNode('root', 0, 0, 400, 300, { kind: 'root', type: 'ROOT', children: [container] })
  const plan = verifyFlexPlan({ tree: root })
  assert.equal(plan.flowChildren, 0, '隐藏节点和绝对子项都不在 flex 流里')
  assert.equal(plan.mismatches.length, 0, '不在流里的子项天然一致，不报 mismatch')
})

test('边界：空容器（无子项）不产生 mismatch', () => {
  const container = mkNode('C:1', 10, 10, 300, 100, { layout: { mode: 'HORIZONTAL' }, children: [] })
  const root = mkNode('root', 0, 0, 400, 300, { kind: 'root', type: 'ROOT', children: [container] })
  assert.equal(verifyFlexPlan({ tree: root }).mismatches.length, 0)
})
