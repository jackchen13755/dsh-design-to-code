/**
 * design.ts 核心逻辑单测（镜像 src/design.ts）。
 *
 * 运行（仓库 package.json 的 test 脚本不覆盖 test/，且不改 package.json）：
 *   node test/src/design.test.mjs
 * 可选 E2E 分支（读真实 ws.json）：
 *   node test/src/design.test.mjs /path/to/figma_xxx_51-1128.ws.json
 *
 * 测试直接转译 src/design.ts（typescript 转译 + data: URL 导入），不依赖 lib/ 的构建产物，
 * 这样跑的就是本席位改的源码，而不是另一个席位尚未 rebuild 的 lib/design.js。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')            // 仓根 dsh-design-to-code
const FIXTURES = resolve(ROOT, 'test', '_fixtures', 'src', 'design')

const src = readFileSync(resolve(ROOT, 'src', 'design.ts'), 'utf8')
const js = ts.transpileModule(src, {
  fileName: 'design.ts',
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const design = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { buildDesignModel, extractAnnotations, extractTitles, paintToCss, instanceTextPartsOf } = design

function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(FIXTURES, name + '.ws.json'), 'utf8'))
}
function model(name) { return buildDesignModel(loadFixture(name)) }
function findTextNode(node, id) {
  if (node.id === id) return node
  for (const c of node.children) { const r = findTextNode(c, id); if (r) return r }
  return undefined
}
function idsOfTexts(node, out = []) {
  if (node.kind === 'text') out.push(node.id)
  for (const c of node.children) idsOfTexts(c, out)
  return out
}

// ── R1: 接口契约逐字一致 ───────────────────────────────────────────────
test('接口契约：所有新导出与新字段存在', () => {
  for (const fn of ['buildDesignModel', 'extractAnnotations', 'extractTitles', 'flatten', 'paintToCss']) {
    assert.equal(typeof design[fn], 'function', `缺少导出函数 ${fn}`)
  }
  const m = model('empty')
  assert.ok(Array.isArray(m.annotations), 'annotations 应为数组')
  assert.ok(Array.isArray(m.titles), 'titles 应为数组')
  // 类型层字段在 JS 运行时靠产物形状校验；下方各用例验证值。
})

// ── R2/R3: 无关键词红字备注命中 ────────────────────────────────────────
test('无关键词红字备注命中：auto/group，5 个变体，原文透传', () => {
  const m = model('notes-no-keyword')
  assert.equal(m.annotations.length, 2, `期望 2 条备注，实际 ${m.annotations.length}`)
  const ids = m.annotations.map((a) => a.id).sort()
  assert.deepEqual(ids, ['51:7', '51:8'].sort(), '备注 id 应为 51:7 / 51:8')
  for (const a of m.annotations) {
    assert.equal(a.disposition, 'auto')
    assert.equal(a.scope, 'group')
    assert.equal(a.variantIds.length, 5, 'scope=group 应有 5 个变体')
    assert.ok(a.confidence > 0 && a.confidence <= 1, 'confidence 应在 (0,1]')
    assert.ok(a.signals.length >= 4, `signals 应记录多条，实际 ${a.signals.length}`)
    assert.ok(a.detectedBy.length >= 4, 'detectedBy 应与 signals 对应')
    assert.ok(!a.text.includes('备注'), '原文不应被塞入"备注"二字')
    assert.ok(a.signals.some((s) => s.kind === 'noteColor'), '应含颜色信号')
    assert.ok(a.signals.some((s) => s.kind === 'variantGroup'), '应含变体组信号')
  }
  const joined = m.annotations.map((a) => a.text).join(' ')
  assert.ok(joined.includes('自动激活'), '备注 1 应含"自动激活"')
  assert.ok(joined.includes('不可编辑'), '备注 2 应含"不可编辑"')
  // 从树摘除
  const present = idsOfTexts(m.tree)
  for (const a of m.annotations) assert.ok(!present.includes(a.id), `auto 备注 ${a.id} 应从树摘除`)
})

// ── R4: 红字但短/组件内/无句读 → 保留为 UI ─────────────────────────────
test('红字短 UI 标签不误判：无句读、在组件内 → 普通文案', () => {
  const m = model('red-short-ui')
  assert.equal(m.annotations.length, 0, '短红字不应成为备注')
  assert.ok(findTextNode(m.tree, '51:3'), '短红字应保留在树中（UI 文案不动）')
})

// ── R4: 单个 frame 无变体组仍能命中 ────────────────────────────────────
test('单个 frame 无变体组仍命中：scope=single', () => {
  const m = model('single-frame-note')
  assert.equal(m.annotations.length, 1)
  const a = m.annotations[0]
  assert.equal(a.disposition, 'auto')
  assert.equal(a.scope, 'single')
  assert.equal(a.variantIds.length, 1)
  assert.ok(!a.signals.some((s) => s.kind === 'variantGroup'), '单组件不应有变体组信号')
  assert.ok(a.signals.some((s) => s.kind === 'outsideGeometry'), '仍应有几何 outside 信号')
})

// ── R3: 标题提取取显著文本而过滤 Page 1 ────────────────────────────────
test('标题提取：prominentText 命中且过滤无语义帧名 Page 1', () => {
  const m = model('title-prominent')
  assert.ok(m.titles.length >= 1, '应提取到标题')
  const prom = m.titles.find((t) => t.source === 'prominentText')
  assert.ok(prom, '应有 prominentText 标题')
  assert.equal(prom.text, '房间概览')
  assert.equal(prom.fontSize, 32)
  assert.equal(prom.level, 'page')
  assert.ok(prom.confidence > 0 && prom.confidence <= 1)
  assert.ok(prom.signals.some((s) => s.kind === 'maxFontSizeUnique'))
  assert.ok(!m.titles.some((t) => t.text === 'Page 1'), 'Page 1 应被 deny-list 过滤')
})

// ── R4: candidate 保留在树 ──────────────────────────────────────────────
test('candidate（4<=score<7）保留在树且不摘除', () => {
  const m = model('candidate-note')
  assert.equal(m.annotations.length, 1)
  const a = m.annotations[0]
  assert.equal(a.disposition, 'candidate')
  assert.ok(a.confidence > 0 && a.confidence < 0.7)
  assert.ok(findTextNode(m.tree, a.id), 'candidate 备注应留在树里')
})

// ── R4: 无备注 → [] ─────────────────────────────────────────────────────
test('无备注设计 → annotations=[]', () => {
  const m = model('empty')
  assert.deepEqual(m.annotations, [])
})

// ── R4: 深层嵌套 TEXT 仍参与打分 ────────────────────────────────────────
test('深层嵌套 TEXT 仍参与打分', () => {
  const m = model('deep-note')
  const a = m.annotations.find((x) => x.id === '51:5')
  assert.ok(a, '深层嵌套的备注 TEXT 应被识别')
  assert.ok(['auto', 'candidate'].includes(a.disposition))
  assert.ok(a.signals.some((s) => s.kind === 'noteColor'), '深层节点仍应有颜色信号')
})

// ── R4: 多语言不依赖中英关键词 ──────────────────────────────────────────
test('多语言：纯英文备注不依赖中文关键词也能命中', () => {
  const m = model('multilingual')
  assert.equal(m.annotations.length, 1)
  const a = m.annotations[0]
  assert.equal(a.disposition, 'auto')
  assert.ok(!a.signals.some((s) => s.kind === 'keyword'), '英文正文未必含中文关键词')
  assert.ok(a.signals.some((s) => s.kind === 'behaviorWord'), '应靠行为词弱信号')
})

// ── R2: 关键词只是弱信号，绝不充分 ──────────────────────────────────────
test('关键词单独不足以判为备注（去 \b 后仍是弱信号）', () => {
  const m = model('keyword-only')
  assert.equal(m.annotations.length, 0, '仅含"备注"关键词、灰色短字 → 不是备注')
})

// ── R2: rgba 颜色泛化 ───────────────────────────────────────────────────
test('颜色泛化：rgba 红字（alpha<1）仍命中', () => {
  const m = model('rgba-note')
  assert.equal(m.annotations.length, 1)
  const a = m.annotations[0]
  assert.ok(a.signals.some((s) => s.kind === 'noteColor'))
  assert.ok(String(a.color).startsWith('rgba('), `颜色应保留 rgba，实际 ${a.color}`)
})

// ── 评审 P2 修复回归：隐藏备注不得当需求 ─────────────────────────────────
test('P2 修复：visible:false 的隐藏备注不进 annotations', () => {
  const raw = loadFixture('notes-no-keyword')
  for (const d of raw.descendants) {
    const id = `${d.guid.sessionID}:${d.guid.localID}`
    if (['51:7', '51:8'].includes(id)) d.visible = false
  }
  const m = buildDesignModel(raw)
  assert.equal(m.annotations.length, 0, '隐藏备注不应成为实现需求')
  // 隐藏节点仍留在树里（不渲染），不被摘除
  assert.ok(findTextNode(m.tree, '51:7'), '隐藏节点保留在树里')
})

// ── 评审 P2 修复回归：段级真实 glyphSize 不被上一段覆盖 ──────────────────
test('P2 修复：段级真实 glyphSize 不被上一段字体推断覆盖', () => {
  const n = {
    size: { x: 200, y: 20 },
    derivedSymbolData: [
      { guidPath: { guids: [{ sessionID: 51, localID: 10 }] },
        derivedTextData: { glyphs: [{ fontSize: 16 }], fontMetaData: [{ key: { family: 'FontA' } }], layoutSize: { x: 50, y: 20 } },
        transform: { m02: 0, m12: 0 }, size: { x: 50, y: 20 } },
      { guidPath: { guids: [{ sessionID: 51, localID: 11 }] },
        derivedTextData: { glyphs: [{ fontSize: 12 }], fontMetaData: [{}], layoutSize: { x: 40, y: 16 } },
        transform: { m02: 60, m12: 0 }, size: { x: 40, y: 16 } },
    ],
    symbolData: { symbolOverrides: [
      { guidPath: { guids: [{ sessionID: 51, localID: 10 }] }, textData: { characters: 'abc' } },
      { guidPath: { guids: [{ sessionID: 51, localID: 11 }] }, textData: { characters: 'def' } },
    ] },
  }
  const parts = instanceTextPartsOf(n)
  assert.equal(parts.length, 2)
  assert.equal(parts[0].size, 16)
  assert.equal(parts[1].size, 12, '第二段自带 glyphSize=12 应保留，不能被第一段 16 覆盖')
  assert.equal(parts[1].family, 'FontA', 'family 仍沿用上一段')
  assert.equal(parts[1].fontInferred, true)
})

// ── E2E（可选分支）：argv 传 ws.json 路径时执行 ──────────────────────────
const e2ePath = process.argv[2]
if (e2ePath) {
  test(`E2E: ${e2ePath}`, () => {
    const raw = JSON.parse(readFileSync(e2ePath, 'utf8'))
    const m = buildDesignModel(raw)
    const ids = m.annotations.map((a) => a.id)
    assert.ok(ids.includes('51:1244'), 'annotations 应含 51:1244')
    assert.ok(ids.includes('51:1229'), 'annotations 应含 51:1229')
    const byId = Object.fromEntries(m.annotations.map((a) => [a.id, a]))
    assert.ok(byId['51:1244'].text.includes('自动激活'), '51:1244 应含"自动激活"')
    assert.ok(byId['51:1229'].text.includes('不可编辑'), '51:1229 应含"不可编辑"')
    for (const id of ['51:1244', '51:1229']) {
      assert.ok(!byId[id].text.includes('备注'), `${id} 不应含"备注"二字`)
      assert.equal(byId[id].disposition, 'auto', `${id} disposition 应为 auto`)
      assert.equal(byId[id].scope, 'group', `${id} scope 应为 group`)
      assert.equal(byId[id].variantIds.length, 5, `${id} variantIds 应有 5 个`)
    }
    assert.ok(!m.titles.some((t) => t.text === 'Page 1'), '标题不应误判 Page 1')
    assert.ok(!m.annotations.some((a) => a.text === '其他日期'), '短 UI 标签不应成为备注（结构信号不得单独抬升）')
    assert.equal(m.annotations.length, 2, '真实样本应恰好识别 2 条备注（无 UI 文案误报）')
  })
}
