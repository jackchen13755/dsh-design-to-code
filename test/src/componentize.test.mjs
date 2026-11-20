/**
 * componentize.ts 新增能力单测（镜像 src/componentize.ts）：
 *  - subtreeDesignIds：子树锚点集合（含自身/跳过不可见/未找到返回空）
 *  - reliableSections：detectSections 可靠性闸门（空/只有根 → 退回现状）
 *
 * 运行：node test/src/componentize.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const MODULES = ['design', 'layout', 'icons', 'render-static', 'componentize']
const TMP = mkdtempSync(join(tmpdir(), 'd2c-componentize-test-'))
for (const m of MODULES) {
  const js = ts.transpileModule(readFileSync(join(ROOT, 'src', m + '.ts'), 'utf8'), {
    fileName: m + '.ts',
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  writeFileSync(join(TMP, m + '.js'), js, 'utf8')
}
const { buildDesignModel } = await import('file://' + join(TMP, 'design.js'))
const { detectSections, subtreeDesignIds, reliableSections } = await import('file://' + join(TMP, 'componentize.js'))

// 合成 ws：根 FRAME 400x600 + 两个子 FRAME（各含 3 个 TEXT，flatNodes>=4）
const txt = (sid, lid, pid, chars, y) => ({
  guid: { sessionID: sid, localID: lid }, type: 'TEXT', name: `T${lid}`,
  transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: y },
  size: { x: 300, y: 20 }, visible: true,
  parentIndex: { guid: { sessionID: sid, localID: pid } },
  characters: chars, style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14, lineHeightPx: 20 },
  fillPaints: [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4, a: 1 }, opacity: 1, visible: true }],
})
const frame = (sid, lid, pid, name, w, h, ty) => ({
  guid: { sessionID: sid, localID: lid }, type: 'FRAME', name,
  transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: ty },
  size: { x: w, y: h }, visible: true,
  parentIndex: { guid: { sessionID: sid, localID: pid } },
  fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }],
})
const ws = {
  fileKey: 'TEST', nodeId: '1:1',
  node: { ...frame(1, 1, 0, 'Root', 400, 600, 0), parentIndex: undefined },
  descendants: [
    frame(1, 10, 1, 'Section Alpha', 350, 150, 0),
    txt(1, 11, 10, 'Alpha one', 20), txt(1, 12, 10, 'Alpha two', 50), txt(1, 13, 10, 'Alpha three', 80),
    frame(1, 20, 1, 'Section Beta', 350, 150, 200),
    txt(1, 21, 20, 'Beta one', 220), txt(1, 22, 20, 'Beta two', 250), txt(1, 23, 20, 'Beta three', 280),
  ],
}
function model() { return buildDesignModel(JSON.parse(JSON.stringify(ws))) }

test('subtreeDesignIds：返回该节点子树全部 id（含自身）', () => {
  const m = model()
  const ids = subtreeDesignIds(m, '1:10')
  assert.ok(ids.includes('1:10'), '含子 FRAME 自身')
  assert.ok(ids.includes('1:11') && ids.includes('1:12') && ids.includes('1:13'), '含 3 个文本子节点')
  assert.ok(!ids.includes('1:20'), '不含兄弟分区')
  assert.ok(!ids.includes('1:1'), '不含根')
})

test('subtreeDesignIds：根节点返回整棵树；未找到返回空数组', () => {
  const m = model()
  const all = subtreeDesignIds(m, '1:1')
  assert.ok(all.includes('1:1') && all.includes('1:10') && all.includes('1:20'))
  assert.deepEqual(subtreeDesignIds(m, '999:999'), [])
})

test('detectSections + reliableSections：识别出两个顶层分区，且通过可靠性闸门', () => {
  const m = model()
  const sections = detectSections(m)
  assert.ok(sections.length >= 2, `应识别出至少两个分区，实际 ${sections.length}`)
  const ids = sections.map((s) => s.id)
  assert.ok(ids.includes('1:10') && ids.includes('1:20'), `应含两个子 FRAME，实际 ${ids}`)
  const reliable = reliableSections(m, sections)
  assert.deepEqual(reliable.map((s) => s.id).sort(), ['1:10', '1:20'])
})

test('reliableSections：空数组 / 只有根 → 返回空（退回仅重复组件现状）', () => {
  const m = model()
  assert.deepEqual(reliableSections(m, []), [])
  const rootOnly = [{ id: m.tree.id, name: m.tree.name, w: m.tree.w, h: m.tree.h, nodeCount: 99, suggestedName: 'Root' }]
  assert.deepEqual(reliableSections(m, rootOnly), [])
})

test.after(() => rmSync(TMP, { recursive: true, force: true }))
