/**
 * 组件复用契约（reuse-contract）集成回归 —— testing-reality-checker
 *
 * 用法：
 *   node scripts/reuse-regression.mjs <ws.json> <outDir> [--catalog <catalog.json>] [--impl-src <dir>]
 *
 * 设计原则：
 *  - **不依赖 lib/**：直接把 src/*.ts 转译（typescript.transpileModule）到仓内 node_modules 下的
 *    临时目录再 import，跑的是当前源码（其他席位未 rebuild 的 lib/ 不参与）。临时目录放在
 *    node_modules 下是为了让 index.ts 的裸模块（cordis / schemastery / dsh-tools）能被解析。
 *  - **不靠自述**：9 条断言每条都调用真实函数 / 真实 grep / 真实读产物，逐条打印 ✓/✗，
 *    任一失败 exit 1。
 *  - **能红一次**：末尾打印变异提示（本脚本不改 src）。
 *  - 合成夹具固定在 test/_fixtures/reuse/，不碰 src/**，不碰 hs_config 等其他项目。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')                       // 仓根 dsh-design-to-code
const FIX = resolve(ROOT, 'test', '_fixtures', 'reuse')
const SRC = resolve(ROOT, 'src')

// ── CLI ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const [ws, out, ...rest] = argv
  const opts = { catalog: resolve(FIX, 'catalog.json'), implSrc: undefined }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--catalog' && rest[i + 1]) opts.catalog = resolve(rest[++i])
    else if (rest[i] === '--impl-src' && rest[i + 1]) opts.implSrc = resolve(rest[++i])
  }
  return { ws: ws && resolve(ws), out: out && resolve(out), ...opts }
}
const { ws: WS, out: OUT, catalog: CATALOG, implSrc: IMPL_SRC } = parseArgs(process.argv.slice(2))
if (!WS || !existsSync(WS)) {
  console.error('用法: node scripts/reuse-regression.mjs <ws.json> <outDir> [--catalog <catalog.json>] [--impl-src <dir>]')
  console.error('  <ws.json> 不存在: ' + WS)
  process.exit(2)
}
if (!OUT) { console.error('缺少 <outDir>'); process.exit(2) }
mkdirSync(OUT, { recursive: true })
const raw = JSON.parse(readFileSync(WS, 'utf8'))

// ── 转译 src/*.ts → 临时目录（node_modules 下，裸模块可解析）──────────────
const TMP = mkdtempSync(join(ROOT, 'node_modules', '.d2c-reuse-regression-'))
writeFileSync(join(TMP, 'package.json'), '{"type":"module"}\n', 'utf8')
try {
  for (const f of readdirSync(SRC)) {
    if (!f.endsWith('.ts') || f.endsWith('.d.ts')) continue
    const js = ts.transpileModule(readFileSync(join(SRC, f), 'utf8'), {
      fileName: f,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
    writeFileSync(join(TMP, f.replace(/\.ts$/, '.js')), js, 'utf8')
  }
} catch (e) {
  rmSync(TMP, { recursive: true, force: true })
  console.error('转译 src/*.ts 失败: ' + e.message)
  process.exit(2)
}
const modCache = new Map()
function load(name) {
  if (!modCache.has(name)) modCache.set(name, import(pathToFileURL(join(TMP, name + '.js')).href))
  return modCache.get(name)
}
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }))

// ── 断言框架：逐条打印 ✓/✗，任一失败 exit 1 ────────────────────────────────
const results = []
async function check(label, fn) {
  try {
    const detail = await fn()
    results.push({ label, ok: true })
    console.log(`✓ ${label}${detail ? ' — ' + detail : ''}`)
  } catch (e) {
    results.push({ label, ok: false })
    console.log(`✗ ${label} — ${e.message}`)
  }
}
const isConfirmed = (c) => !!c && (c.match?.status === 'confirmed' || c.status === 'confirmed')
function need(mod, label) {
  if (!mod) throw new Error(`前置模块未加载：${label}（见 A0；对应 src 文件可能尚未落地）`)
}
const isShell = (c) => !!c && (c.role === 'shell' || c.level === 'shell')
const isControl = (c) => !!c && (c.level === 'control' || c.role === 'control')
const isContent = (c) => !!c && (c.role === 'content' || c.level === 'content')
const designIdsOf = (c) => c?.slot?.contentDesignNodeIds ?? []
const omitIdsOf = (c) => c?.slot?.omitDesignNodeIds ?? []
function hasId(list, id) {
  return list.includes(id) || list.some((x) => typeof x === 'string' && (x.startsWith(id + ':') || x.startsWith(id + '-')))
}

// A0（前置）：冻结接口导出存在
let design, codegen, reuse, indexMod
await check('A0 冻结接口导出存在（buildDesignModel/generateCode/planComponentReuse/verifyReuseImports）', async () => {
  // 分步加载，错误信息定位到具体模块
  design = await load('design')
  assert.equal(typeof design.buildDesignModel, 'function', 'design.ts 缺 buildDesignModel')
  codegen = await load('codegen')
  assert.equal(typeof codegen.generateCode, 'function', 'codegen.ts 缺 generateCode')
  reuse = await load('reuse-contract')
  for (const fn of ['planComponentReuse', 'writeComponentCatalog', 'readComponentCatalog']) {
    assert.equal(typeof reuse[fn], 'function', `reuse-contract.ts 缺 ${fn}（其他席位可能尚未落地）`)
  }
  indexMod = await load('index')
  assert.equal(typeof indexMod.verifyReuseImports, 'function', 'index.ts 缺 verifyReuseImports(contracts, implSrcDir)')
  return '全部存在'
})

let _model
const model = () => { need(design, 'design'); return _model ??= design.buildDesignModel(JSON.parse(JSON.stringify(raw))) }
/**
 * planComponentReuse 第一参是 DesignNode（= buildDesignModel(raw).tree），非 raw JSON / 非整个 model。
 * 冻结契约写 "root"，真实工具管线 index.ts 亦传 (model as {tree?}).tree ?? model。
 */
function plan(opts) {
  need(reuse, 'reuse-contract')
  return reuse.planComponentReuse(model().tree, opts)
}
const autoPlain = () => plan({ policy: 'auto' })  // 无 catalog

// A1/A2 锚定真实样本 node 51:1245（任务书逐字要求）；喂其他 ws 会给出误导性红，这里显式挡住。
function needRealFixture() {
  if (String(raw.nodeId) !== '51:1245') {
    throw new Error(`A1/A2 需要真实 node 51:1245 的 ws.json（当前 nodeId=${raw.nodeId}）。请用 .verify-d2c/.../figma_..._51-1245.ws.json；A4 内部已自带 modal/card 合成夹具`)
  }
}

// ── A1 壳层（真实 node 51:1245）────────────────────────────────────────────
await check('A1 壳层：51:1247=shell / 51:1246,51:1248 在 omit / 51:1277 或 51:1249 后代在 content', () => {
  needRealFixture()
  const cs = autoPlain()
  assert(Array.isArray(cs), 'planComponentReuse 应返回契约数组')
  const shell = cs.find((c) => c.designNodeId === '51:1247')
  assert(shell, '缺 51:1247（抽屉 shell）契约')
  assert.equal(shell.role, 'shell', `51:1247 role 应为 shell，实际 ${shell.role}`)
  const omitIds = omitIdsOf(shell)
  assert(hasId(omitIds, '51:1246'), '51:1246（BG 遮罩）应在 omitDesignNodeIds')
  assert(hasId(omitIds, '51:1248'), '51:1248（抽屉标题栏 INSTANCE）应在 omitDesignNodeIds')
  const contentIds = designIdsOf(shell)
  assert(contentIds.length > 0, 'shell 的 contentDesignNodeIds 不应为空')
  // 内容区按叶子/后代锚点列：51:1277(Body) 或 51:1249(日期数据) 的任一后代命中即可，
  // 不强求恰好列出容器 id 51:1249（planner 实测把其内容展开进 content）。
  assert(
    hasId(contentIds, '51:1277') || contentIds.some((x) => typeof x === 'string' && /^51:1249[:.]/.test(x)),
    `content 应含 51:1277 或 51:1249 的后代；实际: ${JSON.stringify(contentIds.slice(0, 8))}`,
  )
  // 标题栏契约存在且 suspected（即使被 shell omit，也单独成契约）
  const header = cs.find((c) => c.designNodeId === '51:1248')
  assert(header, '缺 51:1248（抽屉标题栏 INSTANCE）契约')
  assert.equal(header.match?.status, 'suspected', `51:1248 状态应 suspected，实际 ${header.match?.status}`)
  return `shell=${shell.id ?? shell.designNodeId}, content=${contentIds.length}, omit=${omitIds.length}`
})

// ── A2 控件层 ──────────────────────────────────────────────────────────────
await check('A2 控件层：≥2 条 control 级 suspected 契约，designName 命中通用控件角色词', () => {
  needRealFixture()
  const cs = autoPlain()
  const controls = cs.filter(isControl)
  assert(controls.length >= 2, `无 catalog 时应产出 ≥2 条 control 级契约，实际 ${controls.length}`)
  assert(controls.every((c) => c.match?.status === 'suspected'), 'control 契约应全部 suspected')
  // 设计里确有 Tab line / 描边标签 / 日期范围选择框等控件；图层名可能是 tab group / 标签状态 等，
  // 不必写死确切字符串，命中通用控件角色词即可（tab/tag/日期/标签/input/select…）。
  const roleWord = /\b(tab|tag|input|select|button|checkbox|radio|switch|date|picker)\b|标签|日期|范围|选择框|描边/i
  const named = controls.filter((c) => roleWord.test(`${c.designName ?? ''}`))
  assert(named.length >= 2, `≥2 条 control 契约 designName 应命中控件角色词；实际命名: ${controls.map((c) => c.designName).join(' / ').slice(0, 300)}`)
  return `control 契约 ${controls.length} 条（命中角色词 ${named.length}），全部 suspected`
})

// ── A3 保守：无 catalog confirmed=0 ────────────────────────────────────────
await check('A3 保守：无 catalog 时 confirmed 契约数=0', () => {
  const cs = autoPlain()
  const confirmed = cs.filter(isConfirmed)
  assert.equal(confirmed.length, 0, `无 catalog 不应有 confirmed，实际 ${confirmed.length} 条: ${JSON.stringify(confirmed.map((c) => c.designNodeId))}`)
  return `confirmed=0（总契约 ${cs.length}）`
})

// ── A4 泛化：Modal / Card 都产出 shell/content（code-dir, confirmed）────────
await check('A4 泛化：合成 catalog + modal/card.ws.json → Modal/Card 均 shell/content(code-dir,confirmed)', () => {
  need(reuse, 'reuse-contract')
  const catRaw = JSON.parse(readFileSync(CATALOG, 'utf8'))
  const catalog = Array.isArray(catRaw) ? catRaw : (catRaw.components ?? catRaw.reuseContracts ?? [])
  assert.equal(catalog.length, 6, `catalog 应有 6 个组件，实际 ${catalog.length}`)
  assert.deepEqual(catalog.map((c) => c.name).sort(), ['Card', 'Drawer', 'Input', 'Modal', 'Select', 'Tag'])
  for (const f of ['modal.ws.json', 'card.ws.json', 'impl-with.tsx', 'impl-without.tsx']) {
    assert(existsSync(join(FIX, f)), `缺合成夹具 ${f}`)
  }
  function assertGeneralized(name, wsFile) {
    const wsRaw = JSON.parse(readFileSync(join(FIX, wsFile), 'utf8'))
    const m = design.buildDesignModel(wsRaw)
    const cs = reuse.planComponentReuse(m, { catalog, policy: 'auto' })
    const matches = cs.filter((c) => c.projectComponent === name || (c.importPath && c.importPath.includes(name)))
    assert(matches.length > 0, `${wsFile} 未命中组件 ${name}`)
    const shell = matches.find(isShell)
    assert(shell, `${wsFile} 未产出 ${name} 的 shell 契约`)
    assert.equal(shell.match?.source, 'code-dir', `${name} shell source 应 code-dir，实际 ${shell.match?.source}`)
    assert(isConfirmed(shell), `${name} shell 应 confirmed`)
    const content = cs.find(isContent)
    const contentOk = (content && isConfirmed(content) && content.match?.source === 'code-dir') || designIdsOf(shell).length > 0
    assert(contentOk, `${wsFile} 未产出 confirmed 的 content 契约（或 shell 无 contentDesignNodeIds）`)
    return `${name}:shell=${shell.match?.status},contentIds=${designIdsOf(shell).length}`
  }
  const a = assertGeneralized('Modal', 'modal.ws.json')
  const b = assertGeneralized('Card', 'card.ws.json')
  return `${a}; ${b}`
})

// ── A5 无硬编码：grep 抽屉|drawer 应为空 ───────────────────────────────────
await check('A5 无硬编码：grep -E 抽屉|drawer 两个文件 0 命中', () => {
  const files = [join(SRC, 'reuse-contract.ts'), join(SRC, 'componentize.ts')]
  for (const f of files) assert(existsSync(f), `文件不存在: ${f}`)
  const hits = []
  for (const f of files) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/抽屉|drawer/i.test(line)) hits.push(`${basename(f)}:${i + 1}`)
    })
  }
  assert.equal(hits.length, 0, `命中（等价于 grep -E '抽屉|drawer' 非空）: ${hits.join(', ')}`)
  return '0 命中'
})

// ── A6 Prompt 段 ───────────────────────────────────────────────────────────
const TITLE = '## 壳/组件级复用契约（三层统一：项目既有组件 ↔ 设计节点）'
await check('A6 Prompt 段：有 reuseContracts 含标题/表格/以本表为准/suspected 先确认；空则不出现', () => {
  need(codegen, 'codegen'); need(reuse, 'reuse-contract')
  const contracts = autoPlain()
  const outWith = join(OUT, 'prompt-with')
  const outEmpty = join(OUT, 'prompt-empty')
  const baseOpts = { componentName: 'ReuseProbe', requirements: '回归夹具', conventions: 'React/TS', maxExtract: 0 }
  codegen.generateCode(model(), { ...baseOpts, outputDir: outWith, reuseContracts: contracts })
  codegen.generateCode(model(), { ...baseOpts, outputDir: outEmpty, reuseContracts: [] })
  const pWith = readFileSync(join(outWith, 'CODEGEN_PROMPT.md'), 'utf8')
  const pEmpty = readFileSync(join(outEmpty, 'CODEGEN_PROMPT.md'), 'utf8')
  assert(pWith.includes(TITLE), 'CODEGEN_PROMPT 缺复用契约段标题')
  assert(pWith.includes('以本表为准'), '缺「以本表为准」')
  assert(pWith.includes('suspected 先确认'), '缺「suspected 先确认」')
  const sec = pWith.slice(pWith.indexOf(TITLE))
  assert(/\|[^\n]+\|[^\n]*\n\|[\s\-:|]+\|/.test(sec), '复用契约段内缺 markdown 表格（表头+分隔行）')
  assert(/设计节点|项目组件|设计.*组件|组件.*设计/.test(sec), '表格表头缺「设计节点/项目组件」关键词')
  assert(!pEmpty.includes(TITLE), 'reuseContracts=[] 时不应出现复用契约段')
  return `段存在，长度 ${sec.length}`
})

// ── A7 套用代码：${name}Shell.tsx ───────────────────────────────────────────
await check('A7 套用代码：有 shell 契约生成 Shell.tsx（import+slot+data-reuse-role TODO），无则不生成', () => {
  const withPath = join(OUT, 'prompt-with', 'src', 'ReuseProbeShell.tsx')
  assert(existsSync(join(OUT, 'prompt-with', 'CODEGEN_PROMPT.md')), 'A6 未成功生成产物（见 A6），无法验证 A7')
  const withFile = withPath
  const emptyFile = join(OUT, 'prompt-empty', 'src', 'ReuseProbeShell.tsx')
  assert(existsSync(withFile), `有 shell 契约时应生成 ${withFile}`)
  const code = readFileSync(withFile, 'utf8')
  assert(/\bimport\b[\s\S]*?\bfrom\s+['"]/.test(code), 'Shell.tsx 应含项目组件 import')
  assert(/data-reuse-role="content"/.test(code), 'Shell.tsx 应含 data-reuse-role="content"')
  assert(/\bTODO\b/i.test(code), 'Shell.tsx 的 content 挂载点应带 TODO')
  assert(/\{children\}|slot|Slot|children/.test(code), 'Shell.tsx 应含 slot 挂载点')
  assert(!existsSync(emptyFile), 'reuseContracts=[] 时不应生成 Shell.tsx')
  return `${basename(withFile)} 存在且含 import/slot/TODO`
})

// ── A8 verify 门禁逻辑（verifyReuseImports 纯函数）─────────────────────────
await check('A8 verify 门禁：confirmed 组件未出现判 missing(clean=false)；出现则 clean=true', () => {
  need(indexMod, 'index（verifyReuseImports 可能尚未导出）')
  // verifyReuseImports 是组件维度：missingImports = confirmed 契约里未在任何源码命中的 projectComponent 名。
  // 用两个 confirmed 契约（Modal/Card）：夹具只 import Modal → Card 应 missing；补 Card import → 全 clean。
  const mk = (id, name) => ({
    id, designNodeId: `1:${id}`, designName: name, level: 'shell', role: 'shell',
    projectComponent: name, importPath: `@/components/${name}`,
    match: { source: 'code-dir', confidence: 0.95, status: 'confirmed', evidence: 'fixture' },
    slot: { contentDesignNodeIds: [], omitDesignNodeIds: [] },
    verify: { nodeId: `1:${id}`, note: '集成回归合成契约' },
  })
  const contracts = [mk(3, 'Modal'), mk(4, 'Card')]
  const implDir = IMPL_SRC ?? join(OUT, 'impl-probe')
  mkdirSync(implDir, { recursive: true })
  const withFile = join(implDir, 'WithImport.tsx')
  const withoutFile = join(implDir, 'WithoutImport.tsx')
  // 合成夹具：WithImport import Modal；WithoutImport 无任何契约组件 import → Card 未被命中
  writeFileSync(withFile, readFileSync(join(FIX, 'impl-with.tsx'), 'utf8'), 'utf8')
  writeFileSync(withoutFile, readFileSync(join(FIX, 'impl-without.tsx'), 'utf8'), 'utf8')
  const r1 = indexMod.verifyReuseImports(contracts, implDir)
  assert.equal(r1.clean, false, 'Card 未被任何源码 import 时 clean 应为 false')
  assert((r1.missingImports ?? []).includes('Card'), `missingImports 应含组件名 Card，实际 ${JSON.stringify(r1.missingImports)}`)
  assert((r1.hits ?? []).includes('Modal'), `hits 应含 Modal，实际 ${JSON.stringify(r1.hits)}`)
  // 补上 Card import → 两个 confirmed 组件都被命中 → clean 翻转
  writeFileSync(withoutFile, "import { Card } from '@/components/Card';\nexport const B = <Card />;\n", 'utf8')
  const r2 = indexMod.verifyReuseImports(contracts, implDir)
  assert.equal(r2.clean, true, `全部 import 后 clean 应为 true，实际 ${JSON.stringify(r2)}`)
  assert.equal((r2.missingImports ?? []).length, 0, 'clean 时 missingImports 应为空')
  return `r1.missing=${JSON.stringify(r1.missingImports)}, r2.hits=${JSON.stringify(r2.hits)}`
})

// ── A9 能红一次：只打印变异提示，不改 src ──────────────────────────────────
await check('A9 能红一次提示（不改 src，仅打印变异指引）', () => {
  console.log('  变异：把 planComponentReuse 恒返回 [] 应使断言1/4/6 失败')
  return '已打印，未改 src'
})

// ── 汇总 ───────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\n结果：${passed}/${results.length} 通过，${failed} 失败`)
if (failed) process.exit(1)
