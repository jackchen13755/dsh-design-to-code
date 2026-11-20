/**
 * codegen.ts 的 CODEGEN_PROMPT 单测（镜像 src/codegen.ts）。
 *
 * 运行：node test/src/codegen.test.mjs
 * 合成 model：本测试从一段内联的合成 ws.json 经 buildDesignModel 得到 model，
 * 再注入 annotations/suspects，跑 generateCode 读 CODEGEN_PROMPT.md 断言锚点。
 *
 * 直接转译 src/*.ts（typescript → 临时目录 → data/file URL 导入），不依赖 lib/ 构建产物：
 * 跑的就是本席位改的源码，而不是别的席位尚未 rebuild 的 lib/codegen.js。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..') // 仓根 dsh-design-to-code

// codegen 的运行时依赖闭包：codegen → render-static/layout/componentize/icons → design，
// 以及 codegen → requirements-crosswalk → (仅 design 类型，运行期无依赖)
const MODULES = ['design', 'layout', 'icons', 'render-static', 'componentize', 'requirements-crosswalk', 'codegen']
const TMP = mkdtempSync(join(tmpdir(), 'd2c-codegen-test-'))
for (const m of MODULES) {
  const src = readFileSync(join(ROOT, 'src', m + '.ts'), 'utf8')
  const js = ts.transpileModule(src, {
    fileName: m + '.ts',
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  writeFileSync(join(TMP, m + '.js'), js, 'utf8')
}
const { buildDesignModel } = await import('file://' + join(TMP, 'design.js'))
const { generateCode } = await import('file://' + join(TMP, 'codegen.js'))

const OUT = join(TMP, 'out')

// ── 合成 ws.json：一个 FRAME 根 + 一个 TEXT 子节点 ────────────────────
const ws = {
  fileKey: 'TEST',
  nodeId: '51:1',
  node: {
    guid: { sessionID: 51, localID: 1 },
    type: 'FRAME', name: '时间筛选',
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    size: { x: 300, y: 200 },
    visible: true,
    fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }],
    strokes: [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4, a: 1 }, opacity: 1, visible: true }],
    strokeWeight: 1,
    cornerRadius: 8,
  },
  descendants: [
    {
      guid: { sessionID: 51, localID: 2 },
      type: 'TEXT', name: 'Label',
      transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 10 },
      size: { x: 120, y: 20 },
      visible: true,
      parentIndex: { guid: { sessionID: 51, localID: 1 } },
      characters: '日期范围',
      style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14, lineHeightPx: 20 },
      fillPaints: [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4, a: 1 }, opacity: 1, visible: true }],
    },
  ],
}

function syntheticModel({ suspects = [], withAnnotation = true } = {}) {
  const m = buildDesignModel(JSON.parse(JSON.stringify(ws)))
  // W3 尚未落地 buildDesignModel 的 suspects/colorSources 填充，这里显式补齐为合成值
  m.suspects = suspects
  m.colorSources = m.colorSources ?? {}
  if (withAnnotation) {
    m.annotations = [{
      id: '51:9', text: '前方tab的日期范围 均会显示在日期组件里 / 随时可点击自动激活其他日期',
      title: '日期范围与激活', x: 0, y: 0, w: 10, h: 10,
      detectedBy: ['prose'], variantIds: [], variantNames: [],
      signals: [{ kind: 'prose', weight: 2 }], confidence: 0.9,
      disposition: 'auto', scope: 'group',
    }]
  }
  return m
}

function promptOf(m) {
  // 每次用全新子目录，避免组件 barrel 跨轮污染
  const out = join(OUT, String(Date.now()) + '-' + Math.random().toString(36).slice(2))
  const files = generateCode(m, {
    componentName: 'TimeFilter', requirements: '', conventions: '', outputDir: out,
  })
  const p = files.find((f) => f.endsWith('CODEGEN_PROMPT.md'))
  assert.ok(p && existsSync(p), '应产出 CODEGEN_PROMPT.md')
  return readFileSync(p, 'utf8')
}

// ── R1：4 个锚点逐字出现（C5） ────────────────────────────────────────
test('C5 四锚点逐字出现在 CODEGEN_PROMPT', () => {
  const p = promptOf(syntheticModel())
  for (const a of ['交互控件必须真实功能', '无同名令牌：直接写 literal', '细节核对表', '必须跑 figma_visual_diff']) {
    assert.ok(p.includes(a), `缺少锚点：${a}`)
  }
})

// ── R2：颜色策略删掉「找设计确认」反向指引 ─────────────────────────────
test('颜色策略不再含「找设计确认」，且含同名令牌/literal 策略', () => {
  const p = promptOf(syntheticModel())
  assert.ok(!p.includes('找设计确认'), '颜色策略不应再要求「找设计确认」')
  assert.ok(p.includes('先查项目主题里有没有**同名令牌**'), '应要求先查同名令牌')
  assert.ok(p.includes('不要近似替换、不要从截图取样、不要把不同色硬套同一令牌'), '应有近似/取样/硬套禁令')
})

// ── R3：空 suspects 不生成存疑段 ──────────────────────────────────────
test('空 suspects 不生成「设计数据存疑项」段', () => {
  const p = promptOf(syntheticModel({ suspects: [] }))
  assert.ok(!p.includes('## 设计数据存疑项'), 'suspects 为空时不应生成存疑段（## 设计数据存疑项 N 条…）')
})

// ── R4：非空 suspects 生成存疑段 + 逐条明细 + 存疑标注 ───────────────────
test('非空 suspects 生成「设计数据存疑项 N 条」段与存疑标注', () => {
  const suspects = [
    { nodeId: '51:2', name: 'Label', property: 'text-color', guessedValue: '#222222',
      basis: 'tally-inferred', evidence: '众数推断', action: '向设计确认' },
    { nodeId: '51:1', name: '时间筛选', property: 'fill', guessedValue: '#eeeeee',
      basis: 'no-paint', evidence: '无填充', action: '按设计 literal 写' },
  ]
  const p = promptOf(syntheticModel({ suspects }))
  assert.ok(p.includes('设计数据存疑项 2 条，逐条挂起确认'), '应按条数生成标题')
  assert.ok(p.includes('#222222') && p.includes('tally-inferred'), '应逐条列出推断值与依据')
  assert.ok(p.includes('存疑·需确认，不得静默套用'), '细节核对表应标注存疑')
})

// ── R5：备注映射表加「真实控件/行为」列（保留 b1a6297 的承载列与原文透传） ──
test('备注映射表含「真实控件/行为」列，且保留承载 props/state 与备注原文', () => {
  const p = promptOf(syntheticModel({ withAnnotation: true }))
  assert.ok(p.includes('| 备注 | 承载 props/state | 事件 | 真实控件/行为 | 文件 | 验证 |'), '映射表头应含新列')
  assert.ok(p.includes('设计备注 = 交互说明'), '应保留 b1a6297 的备注段标题')
  assert.ok(p.includes('随时可点击自动激活其他日期'), '备注原文应透传')
})

// ── R6：细节核对表表头与 literal 值 ───────────────────────────────────
test('细节核对表表头正确，设计值取自 tokens/spec 的 literal', () => {
  const p = promptOf(syntheticModel())
  assert.ok(p.includes('| 属性 | 设计值 | 容差 | 实测手段 |'), '表头应为四列')
  const table = p.slice(p.indexOf('## 细节核对表'), p.indexOf('## 必做'))
  assert.ok(/令牌 .+（色值）/.test(table), '应覆盖色值')
  assert.ok(table.includes('字号/行高') || table.includes('（gap）'), '应覆盖字号行高/gap')
  assert.ok(/getComputedStyle/.test(table), '实测手段应为机器可判定手段')
})

// ── R7：crosswalk 集成——需求交互点 ↔ UI 标注对照表进 CODEGEN_PROMPT ────
test('crosswalk 集成：需求交互点与 UI 标注的对照表出现在 CODEGEN_PROMPT', () => {
  const out = join(OUT, 'cw-' + Date.now())
  const files = generateCode(syntheticModel(), {
    componentName: 'TimeFilter',
    requirements: '1. 点击日期筛选弹出选择器\n2. 选择2个日期后收起弹窗',
    conventions: '', outputDir: out,
  })
  const p = readFileSync(files.find((f) => f.endsWith('CODEGEN_PROMPT.md')), 'utf8')
  assert.ok(p.includes('## 需求交互点 ↔ UI 交互标注 对照表'), '应含对照表标题')
  assert.ok(p.includes('点击日期筛选弹出选择器'), '需求交互点原文应出现')
  assert.ok(p.includes('两侧不许静默遗漏'), '对照表指引应出现')
})

// ── 新需求：顶层分区生成组件文件 + 主容器用 <Section/> 占位 + 组件边界契约 ──
const txtN = (sid, lid, pid, chars, y) => ({
  guid: { sessionID: sid, localID: lid }, type: 'TEXT', name: `T${lid}`,
  transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: y },
  size: { x: 300, y: 20 }, visible: true,
  parentIndex: { guid: { sessionID: sid, localID: pid } },
  characters: chars, style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14, lineHeightPx: 20 },
  fillPaints: [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4, a: 1 }, opacity: 1, visible: true }],
})
const frameN = (sid, lid, pid, name, w, h, ty) => ({
  guid: { sessionID: sid, localID: lid }, type: 'FRAME', name,
  transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: ty },
  size: { x: w, y: h }, visible: true,
  parentIndex: { guid: { sessionID: sid, localID: pid } },
  fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true }],
})
function sectionModel() {
  const w = {
    fileKey: 'TEST', nodeId: '1:1',
    node: { ...frameN(1, 1, 0, 'Root', 400, 600, 0), parentIndex: undefined },
    descendants: [
      frameN(1, 10, 1, 'Section Alpha', 350, 150, 0),
      txtN(1, 11, 10, 'Alpha one', 20), txtN(1, 12, 10, 'Alpha two', 50), txtN(1, 13, 10, 'Alpha three', 80),
      frameN(1, 20, 1, 'Section Beta', 350, 150, 200),
      txtN(1, 21, 20, 'Beta one', 220), txtN(1, 22, 20, 'Beta two', 250), txtN(1, 23, 20, 'Beta three', 280),
    ],
  }
  const m = buildDesignModel(w)
  m.suspects = []
  m.colorSources = m.colorSources ?? {}
  return m
}

test('section 生成独立组件文件，主容器用 <SectionXxx/> 占位，且带锚点注释', () => {
  const out = join(OUT, 'sec-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  const files = generateCode(sectionModel(), {
    componentName: 'Page', requirements: '', conventions: '', outputDir: out,
  })
  // 至少两个 section 组件文件（SectionAlpha / SectionBeta）
  const compFiles = files.filter((f) => /src\/components\//.test(f) && /index\.tsx$|\.tsx$/.test(f))
  assert.ok(compFiles.length >= 2, `应生成至少两个 section 组件文件，实际 ${compFiles.length}: ${compFiles}`)
  // 组件文件内容含对比锚点注释（data-design-id）
  const aFile = compFiles.find((f) => /SectionAlpha/.test(f))
  assert.ok(aFile, '应有 SectionAlpha 组件文件')
  const aContent = readFileSync(aFile, 'utf8')
  assert.ok(aContent.includes('对比锚点（data-design-id'), '组件文件头应写对比锚点')
  assert.ok(aContent.includes('1:10'), '锚点应含 section 根 id')
  assert.ok(aContent.includes('1:11') && aContent.includes('1:12'), '锚点应含子树文本 id')
  // 主容器 import + <SectionAlpha/> 占位
  const mainTsx = readFileSync(join(out, 'src', 'Page.tsx'), 'utf8')
  assert.ok(mainTsx.includes("import { SectionAlpha } from './components/SectionAlpha'"), '主容器应 import section 组件')
  assert.ok(mainTsx.includes('<SectionAlpha'), '主容器应渲染 <SectionAlpha/> 占位')
  assert.ok(!mainTsx.includes('>Alpha one<'), 'section 子树不应再在主容器里逐节点手写')
})

test('CODEGEN_PROMPT 含「组件边界契约」段：文件/props/data-design-id 锚点/承载备注', () => {
  const out = join(OUT, 'contract-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  const m = sectionModel()
  m.annotations = [{
    id: 'an-1', text: '点击后展开详情', title: '展开详情',
    targetId: '1:10', variantIds: ['1:10'], detectedBy: ['prose'], variantNames: [],
    signals: [{ kind: 'prose', weight: 2 }], confidence: 0.9, disposition: 'auto', scope: 'group',
  }]
  const files = generateCode(m, { componentName: 'Page', requirements: '', conventions: '', outputDir: out })
  const p = readFileSync(files.find((f) => f.endsWith('CODEGEN_PROMPT.md')), 'utf8')
  assert.ok(p.includes('组件边界契约'), 'CODEGEN_PROMPT 应含组件边界契约段')
  assert.ok(p.includes('| 单元组件 | 文件路径 | props 契约 | 对比锚点（data-design-id） | 承载备注 id |'), '应有契约表头')
  assert.ok(p.includes('SectionAlpha') && p.includes('SectionBeta'), '应列出各单元组件')
  assert.ok(p.includes('1:10') && p.includes('1:11'), '应列 data-design-id 锚点')
  assert.ok(p.includes('an-1'), '应列承载备注 id（targetId 归属）')
  assert.ok(p.includes('figma_visual_diff(node_id='), '应指引逐组件对比')
  assert.ok(p.includes('dash/colon'), '应说明 node_id 两种写法')
})

test('无 section 无 repeat 时：省略「组件边界契约」段（空数据保守）', () => {
  const p = promptOf(syntheticModel())
  assert.ok(!p.includes('组件边界契约'), '空数据时不应生成组件边界契约段')
})

test.after(() => rmSync(TMP, { recursive: true, force: true }))
