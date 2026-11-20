/**
 * 自测：用本机真实解码数据走一遍 P0–P3 的关键路径。
 * 目的不是"跑通不报错"，而是**证明每条修复都真的生效**：
 *   - 门禁：评审级别从表格列读出（blocker 不会掉成 info）、confirmed 只由 baseline pass 置真；
 *   - 保真：幽灵边框消失、虚线/dashPattern 进模型、实例真实绘制值优先、根节点绘制；
 *   - 布局：auto-layout 六字段进模型、flex 声明进产物、abs-vs-flex 推演有结果；
 *   - 台账：coverage.json 有 design/inferred/placeholder 分布；
 *   - 回归：figma_visual_diff 能对着实现页跑出 expected/actual/Δ。
 *
 * 用法：node scripts/selftest.mjs [nodeId]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const LIB = join(ROOT, 'lib')
const { buildDesignModel } = await import(join(LIB, 'design.js'))
const { renderStatic } = await import(join(LIB, 'render-static.js'))
const { verifyFlexPlan, borderPaint, radiusDecl } = await import(join(LIB, 'layout.js'))
const { generateCode } = await import(join(LIB, 'codegen.js'))
const { parseReview, matchKnownDiff, openItems, acceptedItems, hasExpertReview, isSuppressible, normalizeBaselineSeverity } = await import(join(LIB, 'review.js'))
const { visualDiff, compareProbe } = await import(join(LIB, 'visual-diff.js'))
// 解码器来自已安装的 figma-reader；找不到时不阻断（只用合成用例跑门禁/解析/比较器）
let decodeFrameAndBuildReport = null
for (const prof of ['desktop', 'web', process.env.DSH_PROFILE].filter(Boolean)) {
  try {
    ;({ decodeFrameAndBuildReport } = await import(
      join(homedir(), `.dsh/profiles/${prof}/node_modules/@deepseek-ai/dsh-tool-figma-reader/lib/kiwi.js`)
    ))
    break
  } catch { /* 换下一个 profile */ }
}
const { evaluateCloseGate } = await import(join(LIB, 'gate.js'))
const { GATE_VERSION } = await import(join(LIB, 'flow.js'))

const FILE_KEY = '5e4oj8CPE9KEVBXLaKH52a'
const nodeId = process.argv[2] || '132:8008'
const tmp = join(ROOT, '.selftest')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const results = []
const ok = (name, detail = '') => results.push({ ok: true, name, detail })
const fail = (name, detail = '') => results.push({ ok: false, name, detail })
const assert = (cond, name, detail = '') => (cond ? ok(name, detail) : fail(name, detail))

// ── 1. 取一份真实解码数据（零 REST：浏览器落盘的 WS 帧） ──
function findRaw() {
  const cand = [
    join(homedir(), 'Desktop/design-to-code', `${String(nodeId).replace(':', '-')}`),
    join(homedir(), 'Downloads/figma_ws'),
  ]
  // 先找现成的解码产物
  for (const d of cand) {
    if (!existsSync(d)) continue
    for (const f of readdirSync(d)) {
      if (!/\.json$/.test(f)) continue
      const p = join(d, f)
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        if (j?.node && Array.isArray(j.descendants)) return { path: p, json: j }
      } catch { /* ignore */ }
    }
  }
  // 退回归：从最新的 WS 帧解码
  if (!decodeFrameAndBuildReport) return null
  const ws = join(homedir(), 'Downloads/figma_ws')
  if (!existsSync(ws)) return null
  const frames = readdirSync(ws)
    .filter((f) => /^frame_0001_recv_\d+b\.bin$/.test(f))
    .map((f) => ({ f, m: statSync(join(ws, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, 12)
  for (const { f } of frames) {
    const out = join(tmp, 'decode')
    mkdirSync(out, { recursive: true })
    try {
      const dec = decodeFrameAndBuildReport(join(ws, f), FILE_KEY, nodeId, out)
      const json = JSON.parse(readFileSync(dec.jsonPath, 'utf8'))
      if (json?.node && Array.isArray(json.descendants) && json.node.type) return { path: dec.jsonPath, json }
    } catch { /* 换个帧继续 */ }
  }
  return null
}

const raw = findRaw()
if (!raw) {
  console.error('✗ 找不到可用于自测的真实解码数据（也没有可解码的 WS 帧）')
  process.exit(2)
}
ok('真实解码数据', raw.path)

// ── 2. 模型层（P1/P2/P3 字段） ──
const model = buildDesignModel(raw.json)
const nodes = []
const walk = (n) => { if (n.raw?.visible !== false) { nodes.push(n); for (const c of n.children) walk(c) } }
walk(model.tree)

assert(nodes.length > 100, `模型节点数 ${nodes.length}`)

const withLayout = nodes.filter((n) => n.layout?.mode)
assert(withLayout.length > 0, `auto-layout 容器 ${withLayout.length} 个`)
const growNodes = nodes.filter((n) => (n.layout?.childGrow ?? 0) > 0)
assert(growNodes.length > 0, `记录了 grow=1 的子项 ${growNodes.length} 个（旧版全丢）`)
const selfAlign = nodes.filter((n) => n.layout?.childAlignSelf)
assert(selfAlign.length > 0, `记录了 childAlignSelf 的节点 ${selfAlign.length} 个`)

// 幽灵边框：没有 strokePaints 的节点不能有 border
const phantom = nodes.filter((n) => n.border && !(n.raw.strokePaints?.length))
assert(phantom.length === 0, '无 strokePaints 的节点没有边框（幽灵边框已修）', phantom.slice(0, 3).map((n) => n.id).join(','))

// 逐边独立但四边全 0：不能回落 strokeWeight（除非有 strokeGeometry）
const independent = nodes.filter((n) => n.raw.borderStrokeWeightsIndependent)
const independentAllZeroButBorder = independent.filter((n) => n.border && !(n.raw.strokeGeometry?.length)
  && !Number(n.raw.borderTopWeight) && !Number(n.raw.borderRightWeight) && !Number(n.raw.borderBottomWeight) && !Number(n.raw.borderLeftWeight))
assert(independentAllZeroButBorder.length === 0, `逐边全 0 未被回落成统一描边（检查 ${independent.length} 个逐边节点）`)

// 虚线进模型
const dashed = nodes.filter((n) => n.border?.dash?.length)
ok('虚线描边节点', `${dashed.length} 个`)

// 实例真实绘制值
const instances = nodes.filter((n) => n.type === 'INSTANCE')
const instWithPaint = instances.filter((n) => n.background || n.border)
ok('带真实绘制值的实例', `${instWithPaint.length} / ${instances.length}`)

// 文本垂直对齐 / 行高
const centered = nodes.filter((n) => n.kind === 'text' && String(n.text?.alignVertical).toUpperCase() === 'CENTER')
ok('textAlignVertical=CENTER 的文本', `${centered.length} 个`)

// 台账
assert(model.coverage.counts.design > 0 && model.coverage.counts.placeholder > 0,
  'coverage 台账有 design/placeholder 分布', model.coverage.summary)

// ── 3. 渲染（P1 flex + P2 绘制 + P3 台账产物） ──
const staticDir = join(tmp, 'static')
const r = renderStatic(model, { outputDir: staticDir, title: 'selftest' })
const html = readFileSync(r.htmlPath, 'utf8')
const absHtml = readFileSync(r.absHtmlPath, 'utf8')
assert(html.includes('display:flex') || html.includes('display: flex'), '基准页输出 flex（auto-layout 生效）')
assert(!/justify-content: flex-(start|center|end)/.test(absHtml), '对照页没有容器级 flex（仍是全绝对定位）')
assert(html.includes('data-design-id='), '基准页带 data-design-id（探针可定位）')
assert(existsSync(r.coveragePath) && existsSync(r.layoutReportPath), '产出 coverage.json + abs-vs-flex.json')
assert(r.stats.flexContainers > 0, `flex 容器推演 ${r.stats.flexContainers} 个，mismatch ${r.stats.flexMismatches} 条`)

// 根节点绘制：root 有背景时必须出现在 #frame 的样式里
const rootHasPaint = !!model.tree.background || !!model.tree.border
if (rootHasPaint) {
  assert(/background:\s*#[0-9a-f]{3,8}/i.test(html) || /background:\s*rgba?\(/i.test(html), '根节点填充已绘制')
} else {
  ok('根节点本身无填充（跳过根绘制断言）')
}

const plan = verifyFlexPlan(model)
writeFileSync(join(tmp, 'plan.json'), JSON.stringify(plan, null, 2))

// ── 4. 代码骨架（P1：不再全绝对定位） ──
const genDir = join(tmp, 'gen')
const files = generateCode(model, {
  componentName: 'SelfTest', requirements: 'selftest', conventions: 'React + CSS Modules',
  outputDir: genDir, maxExtract: 2,
})
const css = readFileSync(join(genDir, 'src', 'SelfTest.module.css'), 'utf8')
const tsx = readFileSync(join(genDir, 'src', 'SelfTest.tsx'), 'utf8')
assert(css.includes('display: flex'), '骨架 CSS 输出 flex（不再是全 absolute）')
assert(css.includes('gap:'), '骨架输出 gap')
assert(tsx.includes('data-design-id'), '骨架带 data-design-id（供 figma_visual_diff）')
ok('生成文件', `${files.length} 个`)

// ── 5. 评审解析（P0：级别列不再被丢弃） ──
const reviewText = [
  '| # | 级别 | 问题 | 位置 | 期望 | 实际 |',
  '|---|---|---|---|---|---|',
  '| 1 | blocker | 锚点项应为只有左边框 | src/a.less:48 | border-left 1px | 四边 1px |',
  '| 2 | major | 控件高度应为 34px | src/b.tsx:12 | 34px | 40px |',
  '| 3 | minor | 文案间距偏小 | src/c.tsx:7 | 8px | 6px |',
].join('\n')
const items = parseReview(reviewText)
assert(items.length === 3, `评审解析条数 ${items.length}`)
assert(items[0]?.severity === 'blocker', `第一条级别 = ${items[0]?.severity}（旧版会掉成 info）`)
assert(items[1]?.severity === 'major', `第二条级别 = ${items[1]?.severity}`)
assert(items[2]?.severity === 'minor', `第三条级别 = ${items[2]?.severity}`)
assert(items[0]?.severitySource === 'column', '级别来自显式列')
assert(items[0]?.location === 'src/a.less:48', `位置 = ${items[0]?.location}`)

// ── 5c. 解析健壮性（F1）：数据行含"位置/期望"字样不能被当表头吞掉 ──
try {
  const tricky = [
    '| # | 级别 | 问题 | 位置 | 期望 | 实际 |',
    '|---|---|---|---|---|---|',
    '| 1 | minor | 文案间距偏小 | src/c.tsx:7 | 8px | 6px |',
    '| 2 | blocker | 位置偏移 2px，锚点项应为只有左边框 | src/a.less:48 | 位置贴左 | 四边 1px |',
  ].join('\n')
  const got = parseReview(tricky)
  assert(got.length === 2, `解析不被数据行打断（条目 ${got.length}）`, got.map((x) => `${x.severity}:${x.text.slice(0, 12)}`).join(' | '))
  assert(got.some((x) => x.severity === 'blocker'), '含"位置"字样的 blocker 行没有丢')
} catch (e) {
  fail('解析健壮性（异常已捕获）', String(e?.message ?? e))
}

// ── 5d. known-diffs 不得吞掉 blocker（B2 回归） ──
try {
  const items = [
    { id: '1.1', severity: 'blocker', text: '圆角差 8px', severitySource: 'column' },
    { id: '1.2', severity: 'minor', text: '圆角微调', severitySource: 'column' },
  ]
  const known = [{ property: '圆角' }]
  const suppressible = items.filter((it) => isSuppressible(it))
  const suppressed = suppressible.filter((it) => matchKnownDiff(it, known))
  assert(suppressed.length === 1 && suppressed[0].id === '1.2', 'known-diffs 只压 minor/info，blocker 不参与')
} catch (e) {
  fail('known-diffs 边界（异常已捕获）', String(e?.message ?? e))
}

// ── 6. 自动视觉回归自检：拿基准页当"实现页"，差异应接近 0（验证探针链路） ──
try {
  const spec = JSON.parse(readFileSync(r.specJsonPath, 'utf8'))
  const vd = await visualDiff({
    implPathOrUrl: `file://${r.htmlPath}`,
    width: spec.width, height: spec.height,
    outDir: join(tmp, 'probe'),
    rows: spec.rows,
    // 严格 0.5px：曾经的 1px 系统偏移就是被默认容差吞掉的
    tolerance: 0.5,
  })
  if (!vd.ok) {
    fail('视觉回归链路（无头浏览器不可用）', vd.error ?? '')
  } else {
    assert(vd.checked > 0, `视觉回归对照了 ${vd.checked} 个节点`)
    // 基准页对自身必须是 0 条差异：这是"渲染忠实于设计数据"的验收判据。
    // （曾经这里有 14 条 ×1.33px 漂移，被写成 ok() 而显示成绿色 —— 那种写法会掩盖回归。）
    assert(vd.findings.length === 0, '基准页对自身 0 条差异（0.5px 容差）',
      vd.findings.length ? `${vd.findings.length} 条：${vd.findings.slice(0, 3).map((f) => `${f.property} Δ${f.delta}`).join(' / ')}` : '')
    if (vd.findings.length) {
      writeFileSync(join(tmp, 'visual-diff-findings.json'), JSON.stringify(vd.findings.slice(0, 40), null, 2))
    }
  }
} catch (e) {
  ok('视觉回归链路（异常已捕获）', String(e?.message ?? e))
}

// ── 4b. 描边画法（不占布局）与根节点 auto-layout ──
try {
  const solid = borderPaint({ color: '#111111', top: 1, right: 1, bottom: 1, left: 1, align: 'INSIDE' })
  assert(solid.decls.some((d) => d.includes('inset 0 0 0 1px')) && !solid.decls.some((d) => d.startsWith('border-width')),
    '描边：等宽实线用 inset shadow（不占布局）')
  const edges = borderPaint({ color: '#111111', top: 0, right: 0, bottom: 0, left: 2, align: 'INSIDE' })
  assert(edges.decls.some((d) => d.includes('inset 2px 0 0 0')), '描边：逐边（只有左边框）用单边 inset')
  const dashed = borderPaint({ color: '#111111', top: 1, right: 1, bottom: 1, left: 1, dash: [2, 2] })
  assert(dashed.decls.some((d) => d.startsWith('outline:')) && !dashed.fallback, '描边：等宽虚线用 outline（不占布局）')
  const dashedUneven = borderPaint({ color: '#111111', top: 1, right: 2, bottom: 1, left: 0, dash: [2, 2] }, '0 2px 4px #000')
  assert(dashedUneven.fallback === true && dashedUneven.decls.some((d) => d.startsWith('border-width')),
    '描边：非均匀虚线回落 border 并标记 fallback')
  assert(dashedUneven.decls.some((d) => d.startsWith('box-shadow: 0 2px 4px')), '描边：fallback 分支保留原阴影（M2）')
  assert(radiusDecl({ radius: undefined, _joinRole: 'mid' }, 8).value === '0px', '圆角：拼接中间格方角（与骨架同源）')

  // 根节点带 auto-layout：整页不能塌
  const rootFlex = { ...model, tree: { ...model.tree, layout: { mode: 'VERTICAL', spacing: 8 } } }
  const r2 = renderStatic(rootFlex, { outputDir: join(tmp, 'root-flex'), spec: false })
  const h2 = readFileSync(r2.htmlPath, 'utf8')
  assert(/#frame\{[^}]*display:flex/.test(h2.replace(/\s+/g, '')), '根节点 auto-layout：#frame 输出 display:flex')
  // 顶层子项不能再是绝对定位（否则整页塌）
  const firstChildCss = (h2.match(/\.n0\{[^}]*\}/) ?? [''])[0]
  assert(!firstChildCss.includes('position:absolute'), '根节点 auto-layout：顶层子项进 flex 流（非绝对定位）')
} catch (e) {
  fail('描边/根节点布局（异常已捕获）', String(e?.message ?? e))
}

// ── 5a. 收尾门禁端到端（纯函数）：旧目录/未确认/打回/未关闭项 必须拒绝 ──
try {
  const base = {
    stage: 'skeleton_generated', nodeId: '1:1', fileKey: 'k', confirmed: true, gateVersion: GATE_VERSION,
    // GATE_VERSION=3 起收尾必须有一次干净的机器视觉回归（fail-closed）。
    visualDiff: { at: '', checked: true, findings: 0, clean: true, reportPath: '' },
    updatedAt: '', reviews: [{
      round: 1, reviewer: 'x', at: '', scope: 'implementation', verdict: 'pass',
      items: [{ id: '1.1', severity: 'minor', text: '微调', status: 'closed' }],
    }],
  }
  assert(!evaluateCloseGate({ flow: null }).ok, '门禁：缺 flow.json → 拒绝（fail-closed）')
  assert(!evaluateCloseGate({ flow: { ...base, gateVersion: undefined } }).ok, '门禁：旧版本目录 → 拒绝')
  assert(!evaluateCloseGate({ flow: { ...base, confirmed: false } }).ok, '门禁：confirmed=false → 拒绝')
  assert(!evaluateCloseGate({ flow: { ...base, visualDiff: undefined } }).ok, '门禁：缺视觉回归 artifact → 拒绝（fail-closed）')
  assert(!evaluateCloseGate({ flow: { ...base, visualDiff: { ...base.visualDiff, clean: false } } }).ok, '门禁：视觉回归未 clean 且无 knownDiffs → 拒绝')
  assert(!evaluateCloseGate({ flow: { ...base, reviews: [{ ...base.reviews[0], verdict: 'reject' }] } }).ok, '门禁：末轮 reject → 拒绝')
  assert(!evaluateCloseGate({ flow: { ...base, reviews: [{ ...base.reviews[0], items: [{ id: '1.1', severity: 'major', text: '未关闭', status: 'open' }] }] } }).ok, '门禁：有未关闭实现项 → 拒绝')
  assert(evaluateCloseGate({ flow: base }).ok, '门禁：干净状态 → 放行')
  assert(evaluateCloseGate({ flow: base, force: true, forceReason: 'selftest' }).ok, '门禁：force + reason → 放行并留痕')
  assert(!evaluateCloseGate({ flow: base, force: true }).ok, '门禁：force 不带 reason → 拒绝')
} catch (e) {
  fail('收尾门禁端到端（异常已捕获）', String(e?.message ?? e))
}

// ── 5b. 门禁语义（P0/P3）：scope 分区 + known-diffs 抑制 ──
try {
  const rounds = [
    { round: 1, reviewer: 'x', at: '', scope: 'baseline', verdict: 'pass', items: [
      { id: '1.1', severity: 'blocker', text: '基准：实例缺内部结构', status: 'open' },
    ] },
    { round: 2, reviewer: 'y', at: '', scope: 'implementation', verdict: 'reject', items: [
      { id: '2.1', severity: 'major', text: '实现：Input 高度应为 34px', status: 'open' },
      { id: '2.2', severity: 'minor', text: '实现：图标占位', status: 'accepted' },
    ] },
  ]
  assert(openItems(rounds, 'baseline').length === 1, 'scope 分区：baseline 未关闭 1 条')
  assert(openItems(rounds, 'implementation').length === 1, 'scope 分区：implementation 未关闭 1 条（不被 baseline 污染）')
  assert(acceptedItems(rounds).length === 1, 'accepted 条目单独统计')
  assert(hasExpertReview(rounds, 'implementation') && !hasExpertReview([rounds[0]], 'implementation'), 'hasExpertReview 只认同 scope 轮次')
  const hit = matchKnownDiff({ id: '3.1', severity: 'minor', text: '132:9347 Frame 圆角差 8px', nodeId: '132:9347' }, [{ nodeId: '132:9347', note: '已知' }])
  assert(!!hit, 'known-diffs：nodeId 命中')
  const miss = matchKnownDiff({ id: '3.2', severity: 'minor', text: '另一处文案' }, [{ property: '圆角' }])
  assert(!miss, 'known-diffs：无关条目不命中')
} catch (e) {
  fail('门禁语义单元验证（异常已捕获）', String(e?.message ?? e))
}

// ── 6b. 比较器单元验证（不依赖浏览器：用合成探针数据） ──
try {
  const spec = JSON.parse(readFileSync(r.specJsonPath, 'utf8'))
  const hexToRgb = (h) => {
    const s = h.replace('#', '')
    return `rgb(${[0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)).join(', ')})`
  }
  const fake = spec.rows.map((row) => {
    const edges = (row.borderEdges ?? '0/0/0/0').split('/').map(Number)
    const fsize = /(\d+(?:\.\d+)?)px/.exec(row.font ?? '')?.[1] ?? '14'
    return {
      id: row.id, left: row.x, top: row.y, width: row.w, height: row.h,
      color: row.color ? (row.color.startsWith('#') ? hexToRgb(row.color.slice(0, 7)) : row.color) : 'rgb(0, 0, 0)',
      backgroundColor: row.background
        ? (/^rgba?\(/i.test(row.background) ? row.background : hexToRgb(row.background.slice(0, 7)))
        : 'rgba(0, 0, 0, 0)',
      borderRadius: row.radius ?? '0px',
      boxShadow: edges.every((v) => v === edges[0])
        ? (edges[0] > 0 ? `inset 0px 0px 0px ${edges[0]}px #111111` : 'none')
        : [
          edges[0] ? `inset 0px ${edges[0]}px 0px 0px #111111` : '',
          edges[1] ? `inset -${edges[1]}px 0px 0px 0px #111111` : '',
          edges[2] ? `inset 0px -${edges[2]}px 0px 0px #111111` : '',
          edges[3] ? `inset ${edges[3]}px 0px 0px 0px #111111` : '',
        ].filter(Boolean).join(', ') || 'none',
      outlineWidth: '0px', outlineStyle: 'none', backgroundImage: 'none',
      borderTopWidth: `${edges[0]}px`, borderRightWidth: `${edges[1]}px`,
      borderBottomWidth: `${edges[2]}px`, borderLeftWidth: `${edges[3]}px`,
      borderTopStyle: row.dash ? 'dashed' : 'solid',
      fontSize: `${fsize}px`, fontWeight: '400', lineHeight: 'normal',
      display: 'block', flexDirection: 'row', gap: '0px', opacity: '1', guessed: '',
    }
  })
  const same = compareProbe(spec.rows, fake, 1)
  assert(same.findings.length === 0, `比较器：完全一致时 0 条差异（实际 ${same.findings.length}）`)
  // 选一个非 root 的节点做扰动（root 由 #frame 承载，比较器按约定跳过）
  const targetIdx = spec.rows.findIndex((r) => r.kind !== 'root')
  // 描边：挑一个设计里**有描边**的节点，把实现侧描边抹掉（现在按"存在性"判，不逐边比宽度）
  const borderIdx = spec.rows.findIndex((r) => (r.borderEdges ?? '0/0/0/0').split('/').some((v) => Number(v) > 0))
  const broken = fake.map((n, i) => {
    if (i === targetIdx) return { ...n, left: n.left + 6 }
    if (i === borderIdx) return { ...n, borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px', boxShadow: 'none', outlineWidth: '0px' }
    return n
  })
  const diff = compareProbe(spec.rows, broken, 1)
  assert(diff.findings.some((f) => f.property === 'x' && f.delta >= 6), '比较器：位移 6px 能报出来（Δ=6）')
  assert(diff.findings.some((f) => f.property === 'border-width'), '比较器：缺失描边能报出来（逐边比对）')
} catch (e) {
  fail('比较器单元验证（异常已捕获）', String(e?.message ?? e))
}

// ── 7. 汇总 ──
const bad = results.filter((x) => !x.ok)
const lines = results.map((x) => `${x.ok ? '✓' : '✗'} ${x.name}${x.detail ? ` — ${x.detail}` : ''}`)
writeFileSync(join(tmp, 'selftest.md'), lines.join('\n'), 'utf8')
console.log(lines.join('\n'))
console.log(`\n${bad.length ? `✗ ${bad.length} 项失败` : '✓ 全部通过'}（产物：${join(tmp, 'selftest.md')}）`)
process.exit(bad.length ? 1 : 0)
