/**
 * 自动视觉回归：把**组件实现**的 DOM 与**设计规格**逐节点对照，产出结构化差异
 * （expected / actual / Δ），直接喂给 figma_review_to_round 的 items。
 *
 * 为什么不用像素 diff：像素差需要 PNG 解码（本插件零外部依赖），而且"哪里错了"仍要靠人看。
 * 用 DOM 探针可以精确回答"哪一个节点、哪一个属性、差多少"，这才是能自动关闭的条目。
 *
 * 做法：生成一个探针页，用 iframe 加载实现页，收集每个 `[data-design-id]` 元素的
 * `getBoundingClientRect()` 与关键 computed style，再与 `static/spec.json` 的行对比。
 * 依赖无头 Chrome（`--dump-dom` + `--allow-file-access-from-files`）。
 *
 * 限制（会在结果里明确说明）：
 * - 实现页必须是**可 file:// 打开的静态页**（本地产物或导出的静态构建）；http(s) 站点因跨域拿不到 computed style。
 * - 只对照"能机器判定"的属性：位置/尺寸/描边四边/圆角/背景色/字号/行高。
 *   视觉层级、信息密度、文案这类仍要靠人/专家。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dumpDom } from './screenshot.js'

export interface VisualDiffOptions {
  /** 实现页（file:// 路径或 http(s) URL；后者仅本地同源可读） */
  implPathOrUrl: string
  /** 设计画布尺寸（用于 iframe 视口） */
  width: number
  height: number
  /** 可接受的偏差（px），默认 1 */
  tolerance?: number
  /** 探针产物目录 */
  outDir: string
  chromeBin?: string
}

export interface SpecRowLite {
  id: string
  name: string
  kind: string
  x: number
  y: number
  w: number
  h: number
  background?: string
  borderEdges?: string
  radius?: string
  font?: string
  color?: string
  dash?: string
}

export interface ProbeNode {
  id: string
  left: number
  top: number
  width: number
  height: number
  color: string
  backgroundColor: string
  borderRadius: string
  borderTopWidth: string
  borderRightWidth: string
  borderBottomWidth: string
  borderLeftWidth: string
  borderTopStyle: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  display: string
  backgroundImage?: string
  boxShadow?: string
  outlineStyle?: string
  outlineWidth?: string
  /** 该元素上标了哪些"推断/占位"属性（data-guessed） */
  guessed?: string
  flexDirection: string
  gap: string
  opacity: string
}

export interface VisualFinding {
  nodeId: string
  name: string
  property: string
  expected: string
  actual: string
  delta?: number
  severity: 'blocker' | 'major' | 'minor'
}

const num = (v: unknown): number => {
  const n = parseFloat(String(v).replace('px', ''))
  return Number.isFinite(n) ? n : 0
}

/** 设计树的最小形状（DesignNode 结构上满足：id + 可选 children/raw.visible） */
export interface TreeLikeNode {
  id: string
  children?: TreeLikeNode[]
  raw?: { visible?: boolean }
}

/**
 * 从完整设计树里取某个节点的后代 data-design-id 集合（含自身）。
 *  - 找不到节点 → 返回 null（调用方必须抛明确错误，绝不静默退化成整页对比）
 *  - 跳过 raw.visible === false 的子树，与骨架/基准页口径一致
 *  - 去重且保持树序
 */
export function descendantDesignIds(tree: TreeLikeNode | undefined, nodeId: string): string[] | null {
  if (!tree) return null
  const find = (n: TreeLikeNode): TreeLikeNode | undefined => {
    if (String(n.id) === nodeId) return n
    for (const c of n.children ?? []) {
      const hit = find(c)
      if (hit) return hit
    }
    return undefined
  }
  const target = find(tree)
  if (!target) return null
  const ids: string[] = []
  const walk = (n: TreeLikeNode): void => {
    if (n.raw?.visible === false) return
    ids.push(String(n.id))
    for (const c of n.children ?? []) walk(c)
  }
  walk(target)
  return [...new Set(ids)]
}

/** `rgb(1, 2, 3)` / `rgba(1,2,3,0.5)` → `#010203`（alpha 单独比） */
function rgbToHexColor(s: string): string | undefined {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(String(s ?? ''))
  if (!m) return undefined
  const hex = [m[1], m[2], m[3]].map((x) => Math.round(Number(x)).toString(16).padStart(2, '0')).join('')
  return `#${hex}`
}

function parseRadius(v: string | undefined): number[] {
  const parts = String(v ?? '').trim().split(/\s+/).map(num)
  if (!parts.length) return [0, 0, 0, 0]
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]]
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]]
  return [parts[0], parts[1], parts[2] ?? parts[0], parts[3] ?? parts[1]]
}

function parseFont(v: string | undefined): { size: number; lineHeight: number } {
  const m = /(\d+(?:\.\d+)?)px(?:\/(\d+(?:\.\d+)?)px)?/.exec(String(v ?? ''))
  return { size: m ? Number(m[1]) : 0, lineHeight: m && m[2] ? Number(m[2]) : 0 }
}

/**
 * 从 computed box-shadow 反解"描边四边"。
 * 我们（基准页/骨架）用非布局画法表达描边：
 *  - 实线：`inset 0 0 0 Npx`（等宽）或 `inset 0 ±Npx 0 0`（逐边）；只认 **blur=0** 的层，
 *    避免把设计里的 INNER_SHADOW（通常 blur>0）误判成描边；
 *  - 虚线：`outline: Npx dashed`（等宽，四边同宽）。
 */
export function edgesFromProbe(n: ProbeNode): [number, number, number, number] {
  const edges: [number, number, number, number] = [0, 0, 0, 0]
  const shadow = String(n.boxShadow ?? '')
  if (shadow && shadow !== 'none') {
    // 逐层拆（颜色里的逗号在括号内，先按顶层逗号切）
    const layers: string[] = []
    let depth = 0
    let cur = ''
    for (const ch of shadow) {
      if (ch === '(') depth++
      if (ch === ')') depth--
      if (ch === ',' && depth === 0) { layers.push(cur); cur = ''; continue }
      cur += ch
    }
    if (cur.trim()) layers.push(cur)
    for (const layer of layers) {
      // Chrome 的 computed box-shadow 把颜色放前面、inset 放后面（如 `rgb(...) 0px -1px 0px 0px inset`），
      // 所以只判"层里有 inset 关键字"，数字用独立正则取。
      if (!/inset/i.test(layer)) continue
      const m = /(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px\s+(-?[\d.]+)px/.exec(layer)
      if (!m) continue
      const [, ox, oy, blur, spread] = m.map(Number)
      if (blur !== 0) continue // 有模糊的是内阴影，不是描边
      if (ox === 0 && oy === 0) {
        // 等宽：`inset 0 0 0 Npx`
        edges[0] = edges[1] = edges[2] = edges[3] = spread
        continue
      }
      if (oy > 0 && ox === 0) edges[0] = Math.abs(oy)
      else if (oy < 0 && ox === 0) edges[2] = Math.abs(oy)
      else if (ox > 0 && oy === 0) edges[3] = Math.abs(ox)
      else if (ox < 0 && oy === 0) edges[1] = Math.abs(ox)
    }
  }
  const ow = num(n.outlineWidth)
  if (ow > 0 && String(n.outlineStyle ?? 'none') !== 'none') {
    if (!edges.some((v) => v > 0)) edges[0] = edges[1] = edges[2] = edges[3] = ow
  }
  return edges
}

function severityOfDelta(delta: number, tol: number): VisualFinding['severity'] | null {
  const d = Math.abs(delta)
  if (d <= tol) return null
  if (d >= 4) return 'blocker'
  if (d >= 1.5) return 'major'
  return 'minor'
}

function probePage(url: string, width: number, height: number): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0}#f{position:absolute;left:0;top:0;border:0;width:${width}px;height:${height}px}</style>
</head><body>
<iframe id="f" src="${url.replace(/"/g, '&quot;')}" width="${width}" height="${height}"></iframe>
<pre id="probe">PENDING</pre>
<script>
(function () {
  function collect() {
    var out = { ok: true, nodes: [], missingFonts: [] };
    try {
      var d = document.getElementById('f').contentDocument;
      if (!d) throw new Error('iframe contentDocument is null (cross-origin?)');
      var els = d.querySelectorAll('[data-design-id]');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var r = el.getBoundingClientRect();
        var cs = window.getComputedStyle(el);
        var rootSel = '[data-design-root], #frame, #root, #app';
        var rootEl = d.querySelector(rootSel) || d.body.firstElementChild;
        if (rootEl) { var rr = rootEl.getBoundingClientRect(); out.root = { left: rr.left, top: rr.top, width: rr.width, height: rr.height }; }
        out.nodes.push({
          id: el.getAttribute('data-design-id'),
          left: r.left, top: r.top, width: r.width, height: r.height,
          color: cs.color, backgroundColor: cs.backgroundColor, borderRadius: cs.borderRadius,
          borderTopWidth: cs.borderTopWidth, borderRightWidth: cs.borderRightWidth,
          borderBottomWidth: cs.borderBottomWidth, borderLeftWidth: cs.borderLeftWidth,
          borderTopStyle: cs.borderTopStyle,
          fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight,
          display: cs.display, flexDirection: cs.flexDirection, gap: cs.gap, opacity: cs.opacity,
          backgroundImage: (cs.backgroundImage || '').slice(0, 400),
          boxShadow: (cs.boxShadow || '').slice(0, 400),
          outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth,
          guessed: el.getAttribute('data-guessed') || ''
        });
      }
      if (d.fonts) out.fontsReady = d.fonts.status;
    } catch (e) {
      out = { ok: false, error: String(e && e.message ? e.message : e), nodes: [] };
    }
    document.getElementById('probe').textContent = 'PROBE_RESULT=' + JSON.stringify(out);
  }
  var f = document.getElementById('f');
  var fired = false;
  function once() { if (fired) return; fired = true; setTimeout(collect, 600); }
  f.addEventListener('load', once);
  setTimeout(function () { if (!fired) { fired = true; collect(); } }, 4000);
})();
</script>
</body></html>`
}

/** 跑探针并取回结构化结果 */
async function runProbe(opts: VisualDiffOptions): Promise<{ ok: boolean; nodes: ProbeNode[]; root?: { left: number; top: number; width: number; height: number }; error?: string }> {
  mkdirSync(opts.outDir, { recursive: true })
  const html = probePage(opts.implPathOrUrl, opts.width, opts.height)
  const htmlPath = join(opts.outDir, 'probe.html')
  writeFileSync(htmlPath, html, 'utf8')
  const dom = await dumpDom({
    htmlPath,
    chromeBin: opts.chromeBin,
    width: opts.width,
    height: opts.height,
    settleMs: 6000,
    allowFileAccess: true,
  })
  if (!dom.ok) return { ok: false, nodes: [], error: dom.error }
  const m = /PROBE_RESULT=([\s\S]*?)<\/pre>/.exec(dom.html ?? '')
  if (!m) {
    return { ok: false, nodes: [], error: '探针没有回传结果（实现页可能没加载出来，或不是可 file:// 打开的静态页）。' }
  }
  const raw = m[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  try {
    const parsed = JSON.parse(raw.trim())
    if (!parsed.ok) return { ok: false, nodes: [], error: String(parsed.error ?? '探针执行失败') }
    return { ok: true, nodes: (parsed.nodes ?? []) as ProbeNode[], root: parsed.root }
  } catch (e) {
    return { ok: false, nodes: [], error: `探针结果解析失败：${(e as Error).message}` }
  }
}

/** 逐节点对照，产出结构化差异 */
export function compareProbe(
  rows: SpecRowLite[],
  nodes: ProbeNode[],
  tolerance = 1,
  root?: { left: number; top: number; width: number; height: number },
  canvas?: { width: number; height: number },
): {
  findings: VisualFinding[]
  checked: number
  missing: string[]
  scale?: number
} {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const findings: VisualFinding[] = []
  const missing: string[] = []
  let checked = 0

  // 锚点校准：实现页外层的 body padding / 包裹容器 / 缩放会把**所有**节点整体推移，
  // 那不是节点的问题。用根元素 rect 做原点，并检查页面尺寸与画布是否一致。
  const ox = root?.left ?? 0
  const oy = root?.top ?? 0
  let scale = 1
  if (root && canvas && canvas.width > 0 && root.width > 0) {
    scale = root.width / canvas.width
    if (Math.abs(scale - 1) > 0.02) {
      findings.push({
        nodeId: 'root', name: '页面根元素', property: 'page-scale',
        expected: `画布 ${canvas.width}×${canvas.height}`,
        actual: `根元素 ${Math.round(root.width)}×${Math.round(root.height)}（缩放 ${Math.round(scale * 1000) / 1000}）`,
        delta: Math.round((scale - 1) * 1000) / 1000, severity: 'blocker',
      })
      return { findings, checked: 0, missing, scale }
    }
  }

  for (const row of rows) {
    // 根节点由 #frame 承载、标注类实例（手型光标）按设计意图不渲染 —— 都不算"缺失"
    if (row.kind === 'root' || /hand|cursor|光标/i.test(row.name)) continue
    const n = byId.get(row.id)
    if (!n) {
      missing.push(`${row.id} ${row.name}`)
      // 缺失节点是 major：否则"实现页漏渲染 50 个节点"也会被当成通过
      findings.push({
        nodeId: row.id, name: row.name, property: 'missing',
        expected: '存在', actual: '实现页找不到该 data-design-id', severity: 'major',
      })
      continue
    }
    checked += 1
    const guessed = new Set(String(n.guessed ?? '').split(',').map((x) => x.trim()).filter(Boolean))
    const push = (property: string, expected: string, actual: string, delta: number | undefined, sev: VisualFinding['severity'] | null): void => {
      if (!sev) return
      findings.push({ nodeId: row.id, name: row.name, property, expected, actual, delta, severity: sev })
    }

    const left = n.left - ox
    const top = n.top - oy
    push('x', String(row.x), String(Math.round(left * 100) / 100), left - row.x, severityOfDelta(left - row.x, tolerance))
    push('y', String(row.y), String(Math.round(top * 100) / 100), top - row.y, severityOfDelta(top - row.y, tolerance))
    push('width', String(row.w), String(Math.round(n.width * 100) / 100), n.width - row.w, severityOfDelta(n.width - row.w, tolerance))
    push('height', String(row.h), String(Math.round(n.height * 100) / 100), n.height - row.h, severityOfDelta(n.height - row.h, tolerance))

    // 描边：逐边比对（从非布局画法反解四边，见 edgesFromProbe）
    if (!guessed.has('border')) {
      const want = (row.borderEdges ?? '0/0/0/0').split('/').map(num)
      const got = edgesFromProbe(n)
      const d = got.map((v, i) => Math.round((v - (want[i] ?? 0)) * 100) / 100)
      if (d.some((v) => Math.abs(v) > 0.5)) {
        push('border-width', want.join(' '), got.join(' '), Math.max(...d.map(Math.abs)), 'major')
      }
    }
    // 虚线：CSS dashed / outline dashed / 背景 gradient 都算到位
    if (row.dash && !guessed.has('border') && !/gradient/.test(String(n.backgroundImage ?? ''))
      && n.borderTopStyle !== 'dashed' && String(n.outlineStyle ?? '') !== 'dashed') {
      push('border-style', 'dashed', `${n.borderTopStyle}/${n.outlineStyle}`, undefined, 'minor')
    }

    // 圆角（逐角；guessed 的圆角是拼接组推断值，不参与比对）
    // 百分比圆角 / 椭圆写法（50%、8px / 8px）无法逐角比较 → 跳过
    const radiusComparable = !/[/%]/.test(String(n.borderRadius ?? '')) && !/%/.test(String(row.radius ?? ''))
    const wantR = guessed.has('radius') || !radiusComparable ? [] : parseRadius(row.radius ?? '0')
    const gotR = parseRadius(n.borderRadius)
    const rDelta = wantR.map((v, i) => Math.round(((gotR[i] ?? 0) - v) * 100) / 100)
    if (wantR.length && rDelta.some((v) => Math.abs(v) > 0.5)) {
      push('border-radius', wantR.join(' '), gotR.join(' '), Math.max(...rDelta.map(Math.abs)), 'major')
    }

    // 背景色（只比纯色；渐变/占位底纹不参与；标注为 guessed 的不比）
    if (row.background && !guessed.has('background') && !/gradient|repeating/i.test(row.background)) {
      const wantHex = row.background.startsWith('#') ? row.background.slice(0, 7) : rgbToHexColor(row.background)
      const gotHex = rgbToHexColor(n.backgroundColor)
      if (wantHex && gotHex && wantHex.toLowerCase() !== gotHex.toLowerCase()) {
        push('background', wantHex.toLowerCase(), gotHex.toLowerCase(), undefined, 'major')
      }
    }

    // 文本字色
    if (row.kind === 'text' && row.color) {
      const wantHex = row.color.startsWith('#') ? row.color.slice(0, 7) : rgbToHexColor(row.color)
      const gotHex = rgbToHexColor(n.color)
      if (wantHex && gotHex && wantHex.toLowerCase() !== gotHex.toLowerCase()) {
        push('color', wantHex.toLowerCase(), gotHex.toLowerCase(), undefined, 'major')
      }
    }

    // 字体只在文本节点上比
    if (row.kind === 'text' && row.font) {
      const want = parseFont(row.font)
      if (want.size && Math.abs(num(n.fontSize) - want.size) > 0.5) {
        push('font-size', `${want.size}px`, `${num(n.fontSize)}px`, num(n.fontSize) - want.size, 'major')
      }
      if (want.lineHeight && n.lineHeight !== 'normal' && Math.abs(num(n.lineHeight) - want.lineHeight) > 1) {
        push('line-height', `${want.lineHeight}px`, `${num(n.lineHeight)}px`, num(n.lineHeight) - want.lineHeight, 'major')
      }
    }
  }

  return { findings, checked, missing }
}

export interface VisualDiffResult {
  ok: boolean
  findings: VisualFinding[]
  checked: number
  missing: string[]
  /** findings=0 且没有实现页缺失节点（= 没有未接受的差异）；收尾门禁据此放行 */
  clean: boolean
  reportPath?: string
  jsonPath?: string
  error?: string
}

/** 一站式：跑探针 → 对照 → 落盘报告 */
export async function visualDiff(opts: VisualDiffOptions & { rows: SpecRowLite[] }): Promise<VisualDiffResult> {
  const probe = await runProbe(opts)
  if (!probe.ok) return { ok: false, findings: [], checked: 0, missing: [], clean: false, error: probe.error }
  const { findings, checked, missing } = compareProbe(
    opts.rows, probe.nodes, opts.tolerance ?? 1.5,
    probe.root, { width: opts.width, height: opts.height },
  )
  // 干净 = 没有任何差异、也没有缺失节点（缺失节点本身也会进 findings，这里再显式卡一道）。
  const clean = findings.length === 0 && missing.length === 0
  mkdirSync(opts.outDir, { recursive: true })
  const jsonPath = join(opts.outDir, 'visual-diff.json')
  writeFileSync(jsonPath, JSON.stringify({ checked, findings, missing, clean }, null, 2), 'utf8')
  const md: string[] = []
  md.push('# 自动视觉回归（实现 vs 设计规格）', '')
  md.push(`- 对照节点：${checked} · 差异：${findings.length} · 实现页缺失节点：${missing.length}`)
  md.push('')
  if (findings.length) {
    md.push('| 节点 | 属性 | 期望 | 实际 | Δ | 级别 |')
    md.push('|---|---|---|---|---|---|')
    for (const f of findings) {
      md.push(`| ${f.nodeId} ${f.name.replace(/\|/g, '\\|')} | ${f.property} | ${f.expected} | ${f.actual} | ${f.delta ?? ''} | ${f.severity} |`)
    }
  } else {
    md.push('✅ 所有可比属性都在容差内。')
  }
  if (missing.length) {
    md.push('', '## 实现页里找不到的节点（可能没实现/没打 data-design-id）', '')
    for (const m of missing.slice(0, 50)) md.push(`- ${m}`)
    if (missing.length > 50) md.push(`- …共 ${missing.length} 个`)
  }
  const reportPath = join(opts.outDir, 'visual-diff.md')
  writeFileSync(reportPath, md.join('\n'), 'utf8')
  return { ok: true, findings, checked, missing, clean, reportPath, jsonPath }
}
