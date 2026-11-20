/**
 * codegen.ts 的「壳/组件级复用契约」单测（镜像 src/codegen.ts）。
 *
 * 运行：node test/src/codegen.reuse.test.mjs
 * 合成 model + 合成 reuseContracts（直接喂 generateCode，不依赖 reuse-contract.ts / lib/ 构建产物）。
 * 与 codegen.test.mjs 同法：ts.transpileModule 直转 src/*.ts → 临时目录 → data/file URL import。
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

// 运行期依赖闭包；codegen 对 reuse-contract.ts 是 import type（被 transpile 擦除），无需放入列表
const MODULES = ['design', 'layout', 'icons', 'render-static', 'componentize', 'requirements-crosswalk', 'codegen']
const TMP = mkdtempSync(join(tmpdir(), 'd2c-codegen-reuse-'))
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

// ── 合成 ws.json：FRAME 根 + 一个 TEXT 子节点（含一个 FRAME 壳层供 shell 契约引用）──
const ws = {
  fileKey: 'REUSE-TEST',
  nodeId: '51:1',
  node: {
    guid: { sessionID: 51, localID: 1 }, type: 'FRAME', name: 'Root',
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
    size: { x: 400, y: 300 }, visible: true,
    fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }],
  },
  descendants: [
    {
      guid: { sessionID: 51, localID: 2 }, type: 'FRAME', name: 'Drawer',
      transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
      size: { x: 300, y: 300 }, visible: true,
      parentIndex: { guid: { sessionID: 51, localID: 1 } },
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 1, visible: true, blendMode: 'NORMAL' }],
    },
    {
      guid: { sessionID: 51, localID: 3 }, type: 'TEXT', name: 'Label',
      transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 10 },
      size: { x: 120, y: 20 }, visible: true,
      parentIndex: { guid: { sessionID: 51, localID: 1 } },
      characters: '日期范围',
      style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14, lineHeightPx: 20 },
      fillPaints: [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4, a: 1 }, opacity: 1, visible: true }],
    },
  ],
}

function syntheticModel() {
  const m = buildDesignModel(JSON.parse(JSON.stringify(ws)))
  m.suspects = []
  m.colorSources = m.colorSources ?? {}
  return m
}

const OUT_COUNTER = { n: 0 }
function gen(reuseContracts) {
  const out = join(OUT, `run-${OUT_COUNTER.n++}`)
  const files = generateCode(syntheticModel(), {
    componentName: 'ReuseProbe', requirements: '', conventions: '', outputDir: out, reuseContracts,
  })
  const pPath = files.find((f) => f.endsWith('CODEGEN_PROMPT.md'))
  return { out, files, prompt: pPath && existsSync(pPath) ? readFileSync(pPath, 'utf8') : '', pPath }
}

// ── 合成契约（逐字照冻结契约形状）───────────────────────────────────────
const shellContract = {
  id: 'rc-shell', designNodeId: '51:2', designName: 'Drawer',
  level: 'shell', role: 'shell', projectComponent: 'Drawer',
  match: { source: 'code-dir', confidence: 0.95, status: 'confirmed', evidence: 'fixture: @/components/Drawer' },
  importPath: '@/components/Drawer',
  slot: {
    contentSlot: 'children', headerSlot: 'title',
    contentDesignNodeIds: ['51:3'], omitDesignNodeIds: [],
  },
  nested: [],
  verify: { nodeId: '51:2', note: '抽屉壳复用项目组件，只实现内容区' },
  referencePages: ['SettingsPage'],
}
const controlContract = {
  id: 'rc-ctrl', designNodeId: '51:3', designName: 'Label',
  level: 'control', role: 'control', projectComponent: 'Input',
  match: { source: 'name-semantics', confidence: 0.6, status: 'suspected', evidence: 'name≈input' },
  slot: { contentDesignNodeIds: [], omitDesignNodeIds: [] },
  verify: { nodeId: '51:3', note: '疑似输入控件，先确认' },
}
const businessContract = {
  id: 'rc-biz', designNodeId: '51:1', designName: 'Root',
  level: 'business', role: 'control', projectComponent: 'BizCard',
  match: { source: 'structure', confidence: 0.5, status: 'suspected', evidence: 'structure' },
  slot: { contentDesignNodeIds: [], omitDesignNodeIds: [] },
  verify: { nodeId: '51:1', note: '业务组件待确认' },
}

// ── ① Prompt 段 ──────────────────────────────────────────────────────
test('① Prompt 含复用契约段标题/表头/契约行/以本表为准/suspected 先确认；层级按 shell→control→business 排序', () => {
  const { prompt: p } = gen([businessContract, controlContract, shellContract])
  const TITLE = '## 壳/组件级复用契约（三层统一：项目既有组件 ↔ 设计节点）'
  assert.ok(p.includes(TITLE), '缺复用契约段标题（逐字）')
  assert.ok(p.includes('| 契约ID | 层级 | 设计节点 | 图层名 | 项目组件 | import路径 | slot/children契约 | 需实现的内容区(节点ID) | 不重建的外壳节点 | 状态 | 验证方式 |'), '缺 11 列表头（逐字）')
  assert.ok(p.includes('rc-shell') && p.includes('rc-ctrl') && p.includes('rc-biz'), '应逐条渲染契约行')
  assert.ok(p.includes('以本表为准'), '缺「以本表为准」硬规则')
  assert.ok(p.includes('suspected 先确认'), '缺「suspected 先确认」硬规则')
  // 排序：rc-shell 出现在 rc-ctrl 之前，rc-ctrl 在 rc-biz 之前
  const iShell = p.indexOf('rc-shell'), iCtrl = p.indexOf('rc-ctrl'), iBiz = p.indexOf('rc-biz')
  assert.ok(iShell >= 0 && iCtrl > iShell && iBiz > iCtrl, `层级排序应 shell→control→business，实际 ${iShell}/${iCtrl}/${iBiz}`)
})

test('①-b suspected 且无 code-dir 时 importPath 列写「去项目 grep 确认」', () => {
  const suspectedNoDir = { ...controlContract, id: 'rc-suspect', importPath: undefined }
  const { prompt: p } = gen([suspectedNoDir])
  assert.ok(p.includes('去项目 grep 确认'), 'suspected 无 code-dir 时应写「去项目 grep 确认」')
})

// ── ② Shell 骨架 ─────────────────────────────────────────────────────
test('② shell 契约生成 ${name}Shell.tsx：含 import + slot + 内容区 TODO，且在返回文件列表', () => {
  const { out, files } = gen([shellContract, controlContract])
  const shellPath = join(out, 'src', 'ReuseProbeShell.tsx')
  assert.ok(existsSync(shellPath), '应生成 ReuseProbeShell.tsx')
  assert.ok(files.includes(shellPath), 'Shell 文件应在 generateCode 返回列表')
  const code = readFileSync(shellPath, 'utf8')
  assert.ok(/import\s+.*\bfrom\s+['"]/.test(code), 'Shell 应含项目组件 import')
  assert.ok(code.includes("import { Drawer } from '@/components/Drawer'"), 'import 应用契约 importPath')
  assert.ok(code.includes('<Drawer') && code.includes('</Drawer>'), '应按 slot 拼 <ProjectComp>...</ProjectComp>')
  assert.ok(code.includes('title={'), 'header 槽应按契约填（title）')
  assert.ok(code.includes('data-reuse-role="content"') && code.includes('data-reuse-contract="rc-shell"'), '内容区应带 content 标注')
  assert.ok(code.includes('TODO: 实现内容区'), '内容区应有 TODO')
})

test('②-c slot 的 valueProps/eventProps 为 string[] 时按属性名生成 JSX（非索引）', () => {
  const richShell = {
    ...shellContract,
    id: 'rc-rich',
    slot: { ...shellContract.slot, contentSlot: 'content', valueProps: ['value'], eventProps: ['onChange'] },
  }
  const { out } = gen([richShell])
  const code = readFileSync(join(out, 'src', 'ReuseProbeShell.tsx'), 'utf8')
  assert.ok(code.includes('value={props.value}'), 'valueProps string[] 应生成 value={props.value}')
  assert.ok(code.includes('onChange={props.onChange}'), 'eventProps string[] 应生成 onChange={props.onChange}')
  assert.ok(!/\b0=\{props\./.test(code), '不应把 string[] 当 map 生成数字索引属性')
  assert.ok(code.includes('value?: unknown;') && code.includes('onChange?: unknown;'), 'props 接口应含透传字段')
  assert.ok(code.includes('content={<>'), 'contentSlot 非 children 时应用具名 slot 承载内容')
})

test('②-b importPath 缺失时写占位注释（无 shell 契约不生成 Shell 文件）', () => {
  const { out, files } = gen([controlContract]) // 只有 control 契约，无 shell
  assert.ok(!existsSync(join(out, 'src', 'ReuseProbeShell.tsx')), '无 shell 契约时不应生成 Shell 文件')
  assert.ok(!files.some((f) => f.endsWith('Shell.tsx')), '返回列表不应含 Shell 文件')
})

// ── ③ 控件契约节点带 data-reuse-role ──────────────────────────────────
test('③ 控件契约命中的节点带 data-reuse-role="control" 与 data-reuse-contract', () => {
  const { out } = gen([controlContract])
  const tsx = readFileSync(join(out, 'src', 'ReuseProbe.tsx'), 'utf8')
  assert.ok(tsx.includes('data-reuse-role="control"'), '命中控件契约节点应带 control 标注')
  assert.ok(tsx.includes('data-reuse-contract="rc-ctrl"'), '应带对应契约 id')
})

// ── ④ 空契约不生成段 / Shell / 标注 ────────────────────────────────────
test('④ reuseContracts=[] 时：无复用契约段、无 Shell 文件、无 data-reuse 标注', () => {
  const { out, files, prompt: p } = gen([])
  assert.ok(!p.includes('## 壳/组件级复用契约（三层统一：项目既有组件 ↔ 设计节点）'), '空契约不应生成复用契约段')
  assert.ok(!p.includes('以本表为准'), '空契约不应生成复用硬规则')
  assert.ok(!files.some((f) => f.endsWith('Shell.tsx')), '空契约不应生成 Shell 文件')
  const tsx = readFileSync(join(out, 'src', 'ReuseProbe.tsx'), 'utf8')
  assert.ok(!tsx.includes('data-reuse-role'), '空契约不应产生 data-reuse 标注')
})

test.after(() => rmSync(TMP, { recursive: true, force: true }))
