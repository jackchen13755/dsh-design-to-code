/**
 * 组件化规划（Componentization Plan）
 *
 * 用户要求：生成代码要**组件化**、**尽量复用现成组件**、没有的**组件化生成**方便后续复用、
 * **组件落点按项目实际**（不是插件拍脑袋的 src/components）。
 *
 * 于是这里做三件事：
 *   1. 从设计数据里**发现重复结构**（同一形状的子树反复出现，如 Form Field / Report Title / Row）
 *      → 这就是"应该抽成可复用组件"的地方，并给出 props 建议（用设计里的文案派生属性名）；
 *   2. 从目标仓库里**探测既有约定**（组件目录在哪、是 X/index.tsx 还是 X.tsx、样式后缀、有没有 barrel）
 *      → 新组件就按这个落点生成，不另起一套；
 *   3. 把"复用清单 / 新建清单 / 落点 / 命名"写成可核对的 plan（人看 + 注入 Codegen Prompt）。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DesignModel, DesignNode } from './design.js'

export interface RepeatGroup {
  /** 结构指纹 */
  signature: string
  /** 设计里的图层名（如 "Form Field"） */
  name: string
  count: number
  /** 子树节点数 */
  nodeCount: number
  /** 建议的组件名（PascalCase） */
  suggestedName: string
  /** 建议的 props（由内部文案派生） */
  props: Array<{ name: string; type: string; sample: string; nodeId: string }>
  /** 代表节点的 id */
  representativeId: string
  w: number
  h: number
  /** 是否值得抽成组件（结构性容器/无语义图层名 → false） */
  reusable: boolean
  /** 不抽的理由（写进方案，便于人核对） */
  skipReason?: string
}

export interface ReuseHint {
  /** 设计里的实例名（Input/Select/Button/Radio/日期选择…） */
  designName: string
  count: number
  /** 建议复用的项目组件（启发式；最终由会话按项目实际确认） */
  suggestion: string
}

export interface ProjectConventions {
  codeDir: string
  /** 组件根目录（相对 codeDir），如 isomorph/components */
  componentsRoot?: string
  /** 组件目录形态 */
  layout: 'dir-index' | 'flat' | 'unknown'
  /** 形态证据（真实路径，供人核对） */
  evidence: string[]
  /** 样式后缀（.less / .css / .module.css） */
  styleExt?: string
  /** 是否有 barrel（index.ts 汇总导出） */
  barrel?: boolean
  /** 现成组件名样例（供复用匹配） */
  sampleNames: string[]
}

const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|out|__snapshots__|\.cache|vendor|assets|locale|images?)(\/|$)/

function flatNodes(node: DesignNode, out: DesignNode[] = []): DesignNode[] {
  if (node.raw.visible === false) return out
  out.push(node)
  for (const c of node.children) flatNodes(c, out)
  return out
}

/**
 * 结构签名：**只在 depth 0 比尺寸**，往下只比"类型+图层名"。
 * 为什么：设计里同一个可复用结构，内部文案长度往往不同（"Last Name" vs "Language" 的
 * 文本宽度不一样）。如果每层都比尺寸，Form Field 这种明明重复十几次的结构会一个都没聚起来
 * （实测踩过：只聚到 Row/Header 这类纯容器）。
 */
function signatureOf(n: DesignNode, depth = 0): string {
  // depth 0 只比**高度**不比宽度：可复用组件的宽度应由父级布局决定
  // （同日设计里同一个 Form Field 在 245/229/237/150 宽的列里出现，宽度算进签名就会被拆成 5 个组件）
  const base = depth === 0 ? `${n.type}|${n.name}|h${n.h}` : `${n.type}|${n.name}`
  if (depth >= 2 || !n.children.length) return base
  return `${base}[${n.children.map((c) => signatureOf(c, depth + 1)).join(',')}]`
}

function pascal(s: string): string {
  const cleaned = String(s).replace(/[^A-Za-z0-9]+/g, ' ').trim()
  if (!cleaned) return 'Item'
  const p = cleaned.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
  return /^\d/.test(p) ? `X${p}` : p
}

function camel(s: string): string {
  const p = pascal(s)
  return p.charAt(0).toLowerCase() + p.slice(1)
}

/** 重复结构 → 该抽成可复用组件的候选 */
export function detectRepeats(model: DesignModel, opts: { minCount?: number; minNodes?: number } = {}): RepeatGroup[] {
  const minCount = opts.minCount ?? 3
  const minNodes = opts.minNodes ?? 2
  const all = flatNodes(model.tree)
  const groups = new Map<string, DesignNode[]>()
  for (const n of all) {
    if (n.kind === 'root' || n.kind === 'text') continue
    if (n.w < 40 || n.h < 16) continue // 图标类不抽组件
    const sig = signatureOf(n)
    if (!groups.has(sig)) groups.set(sig, [])
    groups.get(sig)!.push(n)
  }

  const out: RepeatGroup[] = []
  for (const [signature, nodes] of groups) {
    if (nodes.length < minCount) continue
    const rep = nodes[0]
    const sub = flatNodes(rep)
    if (sub.length < minNodes) continue

    // props 建议：用子树里的文本（label / placeholder）派生属性名
    const props: RepeatGroup['props'] = []
    const used = new Set<string>()
    for (const t of sub) {
      if (t.kind !== 'text' && !(t.type === 'INSTANCE' && t.value)) continue
      const text = String(t.value ?? '').trim()
      if (!text || text.length > 20) continue
      let name = camel(text)
      if (!/^[a-zA-Z]/.test(name)) name = `text${props.length + 1}`
      while (used.has(name)) name = `${name}Alt`
      used.add(name)
      props.push({ name, type: 'string', sample: text, nodeId: t.id })
      if (props.length >= 8) break
    }

    // 该不该抽组件：有 props（承载文案/数据）才叫可复用；
    // 纯结构容器（Row/Header/Frame 1171278644/title…）抽出来没人会复用，反而制造垃圾组件。
    const STRUCTURAL = /^(frame\s*\d+|group\s*\d+|row|header|footer|title|container|body|content|wrapper|内容|吸底|抽屉|drawer|content-wrapper|rect(angle)?\d*)$/i
    const hasProps = props.length > 0
    const meaningful = !STRUCTURAL.test(String(rep.name).trim())
    // 两个条件都要满足：① 图层名有语义（不是 Row/Header/Frame 1171278644 这种结构容器）；
    //                     ② 内部有可参数化的文案/数据（props），或者体量足够大。
    // 只满足其一会抽出"没人复用的垃圾组件"——实测第一版就把 Row/Header/Frame… 抽了出来。
    const reusable = meaningful && (hasProps || nodes.length >= 6)
    const skipReason = reusable
      ? undefined
      : !meaningful
        ? '图层名是结构性容器（Row/Header/Frame N/title…），抽出复用价值低'
        : '内部没有可参数化的文案/数据，抽出来也没法复用'

    out.push({
      signature,
      name: rep.name,
      count: nodes.length,
      nodeCount: sub.length,
      suggestedName: pascal(rep.name) || `Block${out.length + 1}`,
      props,
      representativeId: rep.id,
      w: rep.w,
      h: rep.h,
      reusable,
      skipReason,
    })
  }
  // 同名变体去重：设计里同一个"Form Field"会有 Input/Select/日期选择 等多个变体，
  // 不做区分会导致生成文件互相覆盖（实测踩过）。
  const usedNames = new Map<string, number>()
  for (const g of out) {
    const base = g.suggestedName
    const n = (usedNames.get(base) ?? 0) + 1
    usedNames.set(base, n)
    if (n > 1) {
      const rep = flatNodes(model.tree).find((x) => x.id === g.representativeId)
      const hint = rep
        ? flatNodes(rep).find((x) => x.type === 'INSTANCE' && !/^\*$/.test(x.name) && !/hand|cursor/i.test(x.name))?.name
        : undefined
      const suffix = hint ? pascal(hint) : `Alt${n}`
      g.suggestedName = `${base}${suffix === base ? `Alt${n}` : suffix}`
    }
  }

  // 复用价值排序：可复用的优先 → 带 props 的优先 → 出现次数 × 子树规模
  return out.sort((a, b) => {
    if (a.reusable !== b.reusable) return a.reusable ? -1 : 1
    const ap = a.props.length > 0 ? 1 : 0
    const bp = b.props.length > 0 ? 1 : 0
    if (ap !== bp) return bp - ap
    return b.count * b.nodeCount - a.count * a.nodeCount
  })
}

export interface DesignSection {
  id: string
  name: string
  w: number
  h: number
  /** 该节里的节点数（含自身） */
  nodeCount: number
  suggestedName: string
}

/**
 * 顶层分区：把画布拆成"可以各自成为一个组件/文件"的块。
 * 规则：根的直接子级里，尺寸占主导的容器（内容区/导航/吸底）各自成块；
 * 内容区里再按它的直接子级容器（各业务节）细分。
 */
export function detectSections(model: DesignModel): DesignSection[] {
  const out: DesignSection[] = []
  const root = model.tree
  const mids = flatNodes(root).filter((n) => n.kind === 'frame' && n.w >= 200 && n.h >= 40)
  const seen = new Set<string>()
  const pick = (n: DesignNode): void => {
    if (seen.has(n.id)) return
    seen.add(n.id)
    out.push({
      id: n.id, name: n.name, w: n.w, h: n.h,
      nodeCount: flatNodes(n).length,
      suggestedName: pascal(n.name) || `Section${out.length + 1}`,
    })
  }
  // 先取最大的一层容器，再取它内部的直接子容器（业务节）
  const top = mids.slice().sort((a, b) => b.w * b.h - a.w * a.h).slice(0, 4)
  for (const t of top) {
    for (const c of t.children) {
      if (c.kind !== 'frame' || c.raw.visible === false) continue
      if (c.w < 200 || c.h < 60) continue
      // 业务节：有自己的标题/头部，或包含若干行
      if (flatNodes(c).length >= 4) pick(c)
    }
  }
  // 顶部大块自身也在没有细分时兜底
  if (!out.length) for (const t of top) pick(t)
  return out
}

/** 设计侧实例名 → 建议复用的项目组件（启发式；最终以项目实际为准） */
export function reuseHints(model: DesignModel): ReuseHint[] {
  const tally = new Map<string, number>()
  for (const n of flatNodes(model.tree)) {
    if (n.type !== 'INSTANCE') continue
    tally.set(n.name, (tally.get(n.name) ?? 0) + 1)
  }
  const map: Array<[RegExp, string]> = [
    [/input|输入/i, '项目既有 Input（antd Input / 项目封装）'],
    [/select|下拉|combo/i, '项目既有 Select（antd Select / 项目封装）'],
    [/date|calendar|日期/i, '项目既有 DatePicker（如 ArsDatePicker）'],
    [/button|btn|按钮/i, '项目既有 Button（含 primary/secondary 变体）'],
    [/radio|单选框/i, '项目既有 Radio'],
    [/tag|标签/i, '项目既有 Tag / 彩色标签组件'],
    [/upload|上传/i, '项目既有上传组件'],
    [/delete|trash|删除/i, '项目既有图标按钮（icon + Button）'],
    [/^\*$/, '表单必填标记（Form.Item required 自带）'],
    [/hand|cursor|光标/i, '（标注，不实现）'],
  ]
  const out: ReuseHint[] = []
  for (const [name, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    const hit = map.find(([re]) => re.test(name))
    out.push({ designName: name, count, suggestion: hit ? hit[1] : '项目既有同类组件（按实际查找）' })
  }
  return out
}

const COMPONENT_FILE = /\.(tsx|jsx|vue|svelte)$/

/** 探测目标仓库的组件约定（组件根目录 / 目录形态 / 样式后缀 / barrel / 现成组件名） */
export function detectProjectConventions(codeDir: string, opts: { maxFiles?: number } = {}): ProjectConventions {
  const maxFiles = opts.maxFiles ?? 3000
  const dirIndex = new Map<string, number>() // componentsRoot → 出现次数（X/index.tsx 形态）
  const flatFile = new Map<string, number>() // componentsRoot → 出现次数（X.tsx 形态）
  const styleTally = new Map<string, number>()
  const names = new Set<string>()
  const evidence: string[] = []
  const hasBarrel = new Set<string>()
  let scanned = 0

  const stack: string[] = [codeDir]
  while (stack.length && scanned < maxFiles) {
    const dir = stack.pop()!
    let entries: string[]
    try { entries = readdirSync(dir) } catch { continue }
    const rel = dir.slice(codeDir.length + 1) || '.'
    if (/components?$/i.test(dir.split('/').pop() ?? '')) {
      if (entries.includes('index.ts') || entries.includes('index.tsx')) hasBarrel.add(rel)
    }
    for (const e of entries) {
      const p = join(dir, e)
      if (SKIP_DIR.test(p)) continue
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { stack.push(p); continue }
      if (!COMPONENT_FILE.test(e) || st.size > 400 * 1024) continue
      scanned++
      const compRoot = dir.replace(/\/[^/]+$/, '')
      if (/^index\.(tsx|jsx|vue|svelte)$/.test(e)) {
        dirIndex.set(compRoot, (dirIndex.get(compRoot) ?? 0) + 1)
        names.add(dir.split('/').pop() ?? '')
        if (evidence.length < 8) evidence.push(`${rel}/${e}`)
      } else if (/^[A-Z][A-Za-z0-9]*\.(tsx|jsx|vue|svelte)$/.test(e)) {
        flatFile.set(compRoot, (flatFile.get(compRoot) ?? 0) + 1)
        names.add(e.replace(COMPONENT_FILE, ''))
      }
      // 样式后缀：同目录里的样式文件
      const m = e.match(/\.(module\.(less|css)|less|css|scss)$/)
      if (m) styleTally.set(m[0].startsWith('.module') ? m[0] : `.${m[1]}`, (styleTally.get(m[0].startsWith('.module') ? m[0] : `.${m[1]}`) ?? 0) + 1)
    }
  }

  const best = (m: Map<string, number>): [string, number] | undefined =>
    [...m.entries()].sort((a, b) => b[1] - a[1])[0]

  const di = best(dirIndex)
  const fl = best(flatFile)
  const layout: ProjectConventions['layout'] =
    di && (!fl || di[1] >= fl[1]) ? 'dir-index' : fl ? 'flat' : 'unknown'
  const componentsRoot = layout === 'dir-index' ? di?.[0] : fl?.[0]
  const style = best(styleTally)

  return {
    codeDir,
    componentsRoot: componentsRoot ? componentsRoot.replace(codeDir + '/', '') : undefined,
    layout,
    evidence,
    styleExt: style?.[0],
    barrel: [...hasBarrel].some((b) => componentsRoot?.endsWith(b.split('/').pop() ?? '@@') || b.endsWith(componentsRoot ?? '@@')),
    sampleNames: [...names].filter(Boolean).slice(0, 60),
  }
}

/** 生成组件化方案（人看 + 注入 Prompt） */
export function renderComponentPlan(opts: {
  model: DesignModel
  repeats: RepeatGroup[]
  sections: DesignSection[]
  reuse: ReuseHint[]
  conventions?: ProjectConventions
  componentName: string
}): string {
  const { model, repeats, sections, reuse, conventions, componentName } = opts
  const L: string[] = []
  L.push(`# 组件化方案：${componentName}（设计 ${model.nodeId}）`)
  L.push('')
  L.push('原则：**先复用项目既有组件 → 没有才新建可复用组件 → 页面只负责组合**；')
  L.push('禁止把设计里的重复结构在页面里手写 N 遍（下面的"应抽组件"清单就是这些地方）。')
  L.push('')

  L.push('## 1. 复用清单（设计里的实例 → 项目既有组件）')
  L.push('')
  L.push('| 设计里的实例 | 出现次数 | 建议复用 |')
  L.push('|---|---|---|')
  for (const r of reuse.slice(0, 20)) L.push(`| ${r.designName} | ${r.count} | ${r.suggestion} |`)
  L.push('')

  L.push('## 2. 应抽成可复用组件的重复结构（设计数据里统计出来的）')
  L.push('')
  L.push('> ⚠️ 本工具**只写输出目录**，不会写进你的项目；下面这些组件由你在实现阶段按第 4 节的落点创建。')
  L.push('')
  const useful = repeats.filter((r) => r.reusable !== false)
  if (!useful.length) {
    L.push('（未发现值得抽取的重复结构）')
  } else {
    L.push('| 设计图层 | 出现次数 | 子树节点 | 建议组件名 | 代表节点 | 尺寸 | 建议 props |')
    L.push('|---|---|---|---|---|---|---|')
    for (const r of useful.slice(0, 12)) {
      L.push(`| ${r.name} | ${r.count} | ${r.nodeCount} | **${r.suggestedName}** | ${r.representativeId} | ${r.w}×${r.h} | ${r.props.map((p) => `${p.name}(="${p.sample}")`).join(', ') || '—'} |`)
    }
    L.push('')
    L.push('> 这些组件要有 props（上表已给建议属性名，取自设计里的文案），**不要在页面里复制粘贴**。')
    const byBase = new Map<string, number>()
    for (const r of useful) {
      const base = r.suggestedName.replace(/(Select|Input|Radio|DatePicker|Alt\d+)$/, '')
      byBase.set(base, (byBase.get(base) ?? 0) + 1)
    }
    const merged = [...byBase.entries()].filter(([, c]) => c > 1).map(([b]) => b)
    if (merged.length) {
      L.push('>')
      L.push(`> 注意：${merged.join('、')} 在上表里有多个变体（内部控件不同）。**不要做成 N 个组件** —— 合成一个组件用 props 区分`)
      L.push('> （例如 `FormField` 用 `control`/`required` 等 props 决定渲染 Input / Select / 日期选择）。')
    }
  }
  const skipped = repeats.filter((r) => r.reusable === false)
  if (skipped.length) {
    L.push('')
    L.push('### 不值得抽取的重复结构（列出来是为了防止"什么都被抽成组件"）')
    L.push('')
    L.push('| 设计图层 | 出现次数 | 不抽的理由 |')
    L.push('|---|---|---|')
    for (const r of skipped.slice(0, 8)) L.push(`| ${r.name} | ${r.count} | ${r.skipReason ?? ''} |`)
  }
  L.push('')

  L.push('## 3. 顶层分区（建议的文件/组件划分）')
  L.push('')
  L.push('| 区块 | 设计节点 | 尺寸 | 节点数 | 建议组件名 |')
  L.push('|---|---|---|---|---|')
  for (const s of sections.slice(0, 20)) L.push(`| ${s.name} | ${s.id} | ${s.w}×${s.h} | ${s.nodeCount} | ${s.suggestedName} |`)
  L.push('')

  L.push('## 4. 组件落点（按项目实际探测，不是拍脑袋）')
  L.push('')
  if (!conventions) {
    L.push('（未传 code_dir，没探测到项目约定。**动手前必须先看项目里同类组件放哪、怎么命名、样式怎么写**）')
  } else {
    L.push(`- 组件根目录：\`${conventions.componentsRoot ?? '未识别'}\`（相对 ${conventions.codeDir}）`)
    L.push(`- 目录形态：\`${conventions.layout}\`${conventions.layout === 'dir-index' ? '（每个组件一个目录，入口 index.tsx）' : conventions.layout === 'flat' ? '（组件是单文件 X.tsx）' : ''}`)
    L.push(`- 样式后缀：\`${conventions.styleExt ?? '未识别'}\``)
    L.push(`- barrel：${conventions.barrel ? '有（新组件要挂进 index 汇总导出）' : '未识别'}`)
    if (conventions.evidence.length) {
      L.push(`- 依据（真实文件）：${conventions.evidence.slice(0, 6).join(' · ')}`)
    }
    if (conventions.sampleNames.length) {
      L.push(`- 现成组件名样例（复用匹配用）：${conventions.sampleNames.slice(0, 20).join(', ')}`)
    }
    L.push('')
    const root = conventions.componentsRoot ?? '<components 根目录>'
    if (conventions.layout === 'dir-index') {
      L.push('按上面形态，新组件应落成：')
      L.push('```')
      for (const r of repeats.slice(0, 3)) L.push(`${root}/${r.suggestedName}/index.tsx`)
      for (const s of sections.slice(0, 3)) L.push(`${root}/${s.suggestedName}/index.tsx`)
      L.push(`${root}/${componentName}/index.tsx`)
      L.push('```')
    } else {
      L.push('按上面形态，新组件应落成：')
      L.push('```')
      for (const r of repeats.slice(0, 3)) L.push(`${root}/${r.suggestedName}.tsx`)
      L.push(`${root}/${componentName}.tsx`)
      L.push('```')
    }
  }
  L.push('')
  L.push('## 5. 硬性要求（会话按此实现，不要退化成"一个大文件 + 绝对定位")')
  L.push('')
  L.push('1. **复用优先**：第 1 节的每一项都要落到项目既有组件；找不到就在项目里搜同类实现（grep 组件名/类名前缀），不要自己重画控件；')
  L.push('2. **无则组件化**：第 2 节的重复结构必须抽成独立组件（带 props 与 TS 类型），页面只负责组合；')
  L.push('3. **落点按项目实际**：新组件放第 4 节给出的位置与命名形态，样式用项目既有后缀；')
  L.push('4. **可复用性**：组件不依赖页面级上下文（数据用 props 进、事件用回调出），文案/选项不要写死在组件里；')
  L.push('5. **布局收敛**：骨架里的绝对定位只是视觉基准，落实现时按项目的 flex 约定重写（见 SPEC.md 的 auto-layout 列）；')
  L.push('6. 组件粒度以"能否被第二个页面复用"为准：一次性结构不要硬抽组件，重复 ≥3 次的必须抽。')
  L.push('')
  return L.join('\n')
}
