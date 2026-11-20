/**
 * auto-layout → flex 的映射与**自校验**。
 *
 * 为什么需要这一层：auto-layout 在数据里是 `stack*` 一堆字段，而"到底该谁吸收剩余空间、
 * 主轴怎么对齐、要不要换行"决定了 flex 写出来对不对。以前这些字段只被读了一半，
 * 剩下的交给会话 LLM 脑补 —— 于是每一轮评审都在修同一批位移/换行。
 *
 * 这里做两件事：
 *  1. `flexDecls()`：把 DesignLayout 翻成一组确定的 CSS 声明（渲染器共用，保证基准页与骨架同源）；
 *  2. `verifyFlexPlan()`：按同一套规则**推演一遍**每个容器的子项位置，与设计坐标比对，
 *     输出 `abs-vs-flex.json`。差异为 0 才说明"flex 计划能复现设计"，否则是计划本身错了，
 *     而不是实现写错了 —— 这条判据把"翻译阶段的损耗"变成了可断言的产物。
 */
import type { DesignBorder, DesignGridTrack, DesignModel, DesignNode } from './design.js'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface FlexMismatch {
  id: string
  name: string
  containerId: string
  expected: Box
  actual: Box
  delta: [number, number, number, number]
}

const JUSTIFY: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
}

const ALIGN: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  BASELINE: 'baseline',
  STRETCH: 'stretch',
}

export const isHorizontal = (mode?: string): boolean => String(mode ?? '').toUpperCase() === 'HORIZONTAL'
export const isGrid = (mode?: string): boolean => String(mode ?? '').toUpperCase() === 'GRID'

interface Track extends DesignGridTrack { index: number }
function gridTracks(n: DesignNode, axis: 'column' | 'row'): Track[] {
  const g = n.layout?.grid
  const raw = g ? (axis === 'column' ? g.columnSizing : g.rowSizing) : []
  const count = g ? (axis === 'column' ? g.columnIds.length : g.rowIds.length) : 0
  const tracks: Track[] = raw.map((t, index) => ({ ...t, index }))
  while (tracks.length < count) tracks.push({ type: 'FLEX', value: 1, index: tracks.length })
  if (!tracks.length && axis === 'row') tracks.push({ type: 'HUG', value: 1, index: 0 })
  return tracks
}
function trackCss(t: Track): string {
  const type = String(t.type ?? 'FLEX').toUpperCase()
  if (type === 'FLEX') return `minmax(0, ${num(t.value || 1)}fr)`
  if (type === 'HUG' || type === 'AUTO') return 'auto'
  return `${num(t.value)}px`
}
/** CSS 与 verifyFlexPlan 共用同一套轨道归一；未知 sizing 会明确回退为 auto，而不是悄悄按垂直 flex。 */
export function gridStyle(n: DesignNode): { columns: Track[]; rows: Track[]; decls: string[] } {
  const g = n.layout?.grid
  const columns = gridTracks(n, 'column')
  const rows = gridTracks(n, 'row')
  if (!g || !columns.length) return { columns, rows, decls: [] }
  const decls = [
    'display: grid', 'grid-auto-flow: row',
    `grid-template-columns: ${columns.map(trackCss).join(' ')}`,
    `grid-template-rows: ${rows.map(trackCss).join(' ')}`,
    `column-gap: ${num(g.columnGap)}px`, `row-gap: ${num(g.rowGap)}px`,
  ]
  const [pt, pr, pb, pl] = contentInsets(n)
  if (pt || pr || pb || pl) decls.push(`padding: ${num(pt)}px ${num(pr)}px ${num(pb)}px ${num(pl)}px`)
  return { columns, rows, decls }
}

/**
 * auto-layout 流里的**渲染顺序**。
 *
 * 优先用 parentIndex.position（Figma 明确的兄弟语义顺序），不能用坐标排序代替：
 * WRAP 容器的第二行会被按 x 混到第一行中间（Roompedia 110:887 的 Tab 即因此错位）。
 * 旧捕获没有 position 时才按坐标回退；Grid 必须先按行、再按列，而非只看 x。
 */
export function orderFlow(kids: DesignNode[], parent: DesignNode): DesignNode[] {
  const indexed = kids.map((c, i) => ({ c, i }))
  if (indexed.every(({ c }) => typeof c.raw.parentIndex?.position === 'string')) {
    return indexed.sort((a, b) => {
      const ap = String(a.c.raw.parentIndex.position)
      const bp = String(b.c.raw.parentIndex.position)
      return (ap < bp ? -1 : ap > bp ? 1 : 0) || a.i - b.i
    }).map(({ c }) => c)
  }
  const row = isHorizontal(parent.layout?.mode)
  const grid = String(parent.layout?.mode).toUpperCase() === 'GRID'
  return indexed.sort((a, b) => {
    if (grid) return (a.c.y - b.c.y) || (a.c.x - b.c.x) || a.i - b.i
    return (row ? a.c.x - b.c.x : a.c.y - b.c.y) || a.i - b.i
  }).map(({ c }) => c)
}

/** 子项是否在父容器的 flex 流里（绝对子项 / 父容器不是 auto-layout 时不在） */
export function flowsInParent(child: DesignNode, parent?: DesignNode): boolean {
  if (!parent?.layout?.mode) return false
  if (child.layout?.absolute) return false
  return true
}

/**
 * 容器四边实际从"盒边界"到"内容起点"的距离。
 *
 * Figma 的 `bordersTakeSpace=true` 表示**描边占空间**（内容整体让开 border），
 * 而我们把描边画成 inset shadow（不占布局）——所以必须把 border 宽度折算进 padding，
 * 否则子项会整体偏 border 宽度（实测 132:8223：x/y 各偏 1px、宽偏 0.67px）。
 */
export function contentInsets(n: DesignNode): [number, number, number, number] {
  const l = n.layout
  const t = Number(l?.paddingTop ?? 0)
  const r = Number(l?.paddingRight ?? 0)
  const b = Number(l?.paddingBottom ?? 0)
  const le = Number(l?.paddingLeft ?? 0)
  const bd = n.border
  const takes = !!(l?.bordersTakeSpace && bd)
  return [
    t + (takes ? Number(bd!.top || 0) : 0),
    r + (takes ? Number(bd!.right || 0) : 0),
    b + (takes ? Number(bd!.bottom || 0) : 0),
    le + (takes ? Number(bd!.left || 0) : 0),
  ]
}

/** 容器自身的 flex 声明（不含定位） */
export function flexDecls(n: DesignNode): string[] {
  const l = n.layout
  if (!l?.mode) return []
  const row = isHorizontal(l.mode)
  if (isGrid(l.mode)) return gridStyle(n).decls
  const d: string[] = ['display: flex', `flex-direction: ${row ? 'row' : 'column'}`]
  // CSS 的 gap 不接受负值；Figma 里负 spacing 表示"重叠"，用子项负 margin 表达（见 flowChildDecls）
  if (l.spacing && l.spacing > 0) d.push(`gap: ${num(l.spacing)}px`)
  if (l.counterSpacing != null) d.push(`${row ? 'row-gap' : 'column-gap'}: ${num(l.counterSpacing)}px`)
  const [pt, pr, pb, pl] = contentInsets(n)
  if (pt || pr || pb || pl) d.push(`padding: ${num(pt)}px ${num(pr)}px ${num(pb)}px ${num(pl)}px`)
  d.push(`justify-content: ${JUSTIFY[String(l.primaryAlign ?? 'MIN').toUpperCase()] ?? 'flex-start'}`)
  d.push(`align-items: ${ALIGN[String(l.counterAlign ?? 'MIN').toUpperCase()] ?? 'flex-start'}`)
  if (l.wrap && String(l.wrap).toUpperCase() === 'WRAP') d.push('flex-wrap: wrap')
  return d
}

/** 子项在父 flex 流里的声明（不含尺寸/背景） */
export function flowChildDecls(child: DesignNode, parent: DesignNode, index = 0): string[] {
  const d: string[] = ['position: relative']
  if (isGrid(parent.layout?.mode)) return d
  const row = isHorizontal(parent.layout?.mode)
  const grow = Number(child.layout?.childGrow ?? 0)
  const basis = row ? child.w : child.h
  // 关键：**设计尺寸当 flex-basis**，grow 只负责分配剩余空间。
  // 若用 `flex: 1 1 0`，等比子项会被强行拉成等宽，与设计稿的固定宽度对不上（实测差 15–28px）。
  if (grow > 0) {
    // shrink=0：设计宽度就是最终宽度，宁可撑进 padding 也不压缩
    //（实测：容器声明了右 padding 但设计几何并没有留，只要允许收缩就会少 28px）
    d.push(`flex: ${grow} 0 ${num(basis)}px`)
    d.push(row ? 'min-width: 0' : 'min-height: 0')
  } else {
    d.push(`flex: 0 0 ${num(basis)}px`)
  }
  const negGap = Number(parent.layout?.spacing ?? 0)
  if (negGap < 0 && index > 0) d.push(row ? `margin-left: ${num(negGap)}px` : `margin-top: ${num(negGap)}px`)
  const self = String(child.layout?.childAlignSelf ?? '').toUpperCase()
  if (self === 'STRETCH') d.push('align-self: stretch')
  else if (self && self !== 'AUTO') d.push(`align-self: ${ALIGN[self] ?? 'auto'}`)
  return d
}

function num(v: unknown): string {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0'
}

function justifyOffset(justify: string, leftover: number, hasGrow: boolean): number {
  if (hasGrow) return 0
  if (justify === 'CENTER') return leftover / 2
  if (justify === 'MAX') return leftover
  return 0
}
function justifyDistribute(line: DesignNode[], innerMain: number, allMain: number, gap: number, justify: string): number {
  if (justify !== 'SPACE_BETWEEN' || line.length < 2 || line.some((c) => Number(c.layout?.childGrow ?? 0) > 0)) return 0
  return (innerMain - allMain - gap * (line.length - 1)) / (line.length - 1)
}
function mainSizeForGrid(child: DesignNode, track: number | undefined): number {
  void child
  return Math.max(0, Number(track ?? 0))
}

/**
 * 按 flex 规则推演子项位置，与设计坐标比对。
 * 只检查"在流里"的子项；绝对子项按 left/top 天然一致，不参与。
 */
export function verifyFlexPlan(model: DesignModel, tol = 1): {
  containers: number
  flowChildren: number
  mismatches: FlexMismatch[]
} {
  const mismatches: FlexMismatch[] = []
  let containers = 0
  let flowChildren = 0

  const walk = (n: DesignNode): void => {
    if (n.raw.visible === false) return
    if (n.layout?.mode && n.children.length) {
      containers += 1
      const gridMode = isGrid(n.layout.mode)
      const row = isHorizontal(n.layout.mode)
      const [padT, padR, padB, padL] = contentInsets(n)
      const innerMain = row ? n.w - padL - padR : n.h - padT - padB
      const gap = Number(n.layout.spacing ?? 0)
      const flow = orderFlow(n.children.filter((c) => c.raw.visible !== false && flowsInParent(c, n)), n)
      flowChildren += flow.length
      const plans: Array<{ child: DesignNode; actual: Box }> = []
      if (gridMode) {
        // Figma Grid 的语义是显式轨道，不是 VERTICAL。按轨道 sizing 推演，而不是拿 t.m02 回抄答案。
        const { columns, rows } = gridStyle(n)
        const g = n.layout.grid!
        const resolveTracks = (tracks: Track[], available: number, main: boolean): { values: number[]; offsets: number[] } => {
          const values = tracks.map((t) => {
            const type = String(t.type).toUpperCase()
            if (type !== 'FLEX' && type !== 'HUG' && type !== 'AUTO') return t.value
            const inLine = main ? flow.filter((_, i) => i % Math.max(1, columns.length) === t.index) : flow.filter((_, i) => Math.floor(i / Math.max(1, columns.length)) === t.index)
            return type === 'FLEX' ? 0 : Math.max(0, ...inLine.map((c) => main ? c.w : c.h))
          })
          const flexWeight = tracks.reduce((s, t) => s + (String(t.type).toUpperCase() === 'FLEX' ? t.value || 1 : 0), 0)
          const left = available - values.reduce((s, v) => s + v, 0)
          tracks.forEach((t, i) => { if (String(t.type).toUpperCase() === 'FLEX') values[i] = flexWeight ? left * (t.value || 1) / flexWeight : 0 })
          const offsets: number[] = []
          values.forEach((v, i) => { offsets[i] = (offsets[i - 1] ?? 0) + (i ? values[i - 1] + (main ? g.columnGap : g.rowGap) : 0) })
          return { values, offsets }
        }
        const cPlan = resolveTracks(columns, n.w - padL - padR - g.columnGap * Math.max(0, columns.length - 1), true)
        const rPlan = resolveTracks(rows, n.h - padT - padB - g.rowGap * Math.max(0, rows.length - 1), false)
        flow.forEach((child, i) => {
          const c = i % Math.max(1, columns.length)
          const r = Math.floor(i / Math.max(1, columns.length))
          plans.push({ child, actual: {
            x: n.x + padL + (cPlan.offsets[c] ?? 0), y: n.y + padT + (rPlan.offsets[r] ?? 0),
            w: mainSizeForGrid(child, cPlan.values[c]), h: mainSizeForGrid(child, rPlan.values[r]),
          } })
        })
      } else {
        // WRAP：先按真实容器宽度分行，再分别做主轴对齐；不能把所有子项当作一根永不换行的轴。
        const wrap = String(n.layout.wrap ?? 'NO_WRAP').toUpperCase() === 'WRAP'
        const lines: DesignNode[][] = [[]]
        if (wrap) {
          for (const c of flow) {
            let line = lines[lines.length - 1]
            const used = line.reduce((s, x) => s + (row ? x.w : x.h), 0) + gap * Math.max(0, line.length - 1)
            if (line.length && used + gap + (row ? c.w : c.h) > innerMain + 0.01) { line = []; lines.push(line) }
            line.push(c)
          }
        } else lines[0] = flow
        let lineCross = row ? padT : padL
        for (const line of lines) {
          const growers = line.filter((c) => Number(c.layout?.childGrow ?? 0) > 0)
          const allMain = line.reduce((s, c) => s + (row ? c.w : c.h), 0)
          const growWeight = growers.reduce((s, c) => s + Number(c.layout?.childGrow ?? 0), 0)
          const free = Math.max(0, innerMain - allMain - gap * Math.max(0, line.length - 1))
          const justify = String(n.layout.primaryAlign ?? 'MIN').toUpperCase()
          const distribute = justifyDistribute(line, innerMain, allMain, gap, justify)
          let cursor = row ? padL : padT
          cursor += justifyOffset(justify, innerMain - allMain - gap * Math.max(0, line.length - 1) - distribute * Math.max(0, line.length - 1), growers.length > 0)
          const lineHeight = Math.max(0, ...line.map((c) => row ? c.h : c.w))
          for (let i = 0; i < line.length; i++) {
            const c = line[i]
            const grow = Number(c.layout?.childGrow ?? 0) > 0 && growWeight ? free * Number(c.layout?.childGrow ?? 0) / growWeight : 0
            const mainSize = (row ? c.w : c.h) + grow
            const crossSize = row ? c.h : c.w
            const crossAvail = row ? n.h - padT - padB : n.w - padL - padR
            const self = String(c.layout?.childAlignSelf ?? '').toUpperCase()
            const align = self && self !== 'AUTO' && self !== 'STRETCH' ? self : String(n.layout.counterAlign ?? 'MIN').toUpperCase()
            const crossAvailable = wrap ? Math.max(crossSize, lineHeight) : crossAvail
            const offset = align === 'CENTER' ? (crossAvailable - crossSize) / 2 : align === 'MAX' ? crossAvailable - crossSize : 0
            const crossStart = wrap && row ? lineCross : wrap ? lineCross : row ? padT : padL
            plans.push({ child: c, actual: row
              ? { x: n.x + cursor, y: n.y + crossStart + offset, w: mainSize, h: crossSize }
              : { x: n.x + crossStart + offset, y: n.y + cursor, w: crossSize, h: mainSize } })
            cursor += mainSize + gap + distribute
          }
          lineCross += lineHeight + Number(n.layout.counterSpacing ?? 0)
        }
      }
      for (const { child: c, actual } of plans) {
        const expected: Box = { x: c.x, y: c.y, w: c.w, h: c.h }
        const delta: [number, number, number, number] = [
          actual.x - expected.x, actual.y - expected.y, actual.w - expected.w, actual.h - expected.h,
        ].map((v) => Math.round(v * 100) / 100) as [number, number, number, number]
        if (delta.some((v) => Math.abs(v) > tol)) mismatches.push({ id: c.id, name: c.name, containerId: n.id, expected, actual, delta })
      }
    }
    for (const c of n.children) walk(c)
  }
  walk(model.tree)
  return { containers, flowChildren, mismatches }
}

/**
 * 描边的**非布局**画法（关键修复）。
 *
 * 为什么不能用 CSS `border`：CSS 的 border 会占布局空间，流内子项从 border 之后起算；
 * 而 Figma 的子节点坐标**不含 stroke**（`stackPadding` 已含在内）。直接写 border 会让
 * 每个带边框的自动布局容器里的子项整体偏移 = borderLeft/borderTop（实测 1–2px，
 * 涉及 22 个容器 / 207 个子项），而且这种偏移"照基准页改"也修不掉。
 *
 * 画法：
 * - 实线 → 用 inset `box-shadow`（逐边等宽可合成一条），完全不参与布局；
 * - 虚线（uniform 四边等宽）→ 用 `outline` + 负 `outline-offset`（同样不参与布局）；
 * - 虚线但四边不等宽 → 退回 `border`（CSS 无法表达非均匀 outline），并从返回值里标记 fallback。
 */
export function borderPaint(b: DesignBorder | undefined, baseShadow?: string): { decls: string[]; fallback: boolean } {
  if (!b) return { decls: baseShadow ? [`box-shadow: ${baseShadow}`] : [], fallback: false }
  const sides = [b.top, b.right, b.bottom, b.left]
  const uniform = sides.every((v) => v === sides[0]) && sides[0] > 0
  const align = String(b.align ?? 'INSIDE').toUpperCase()

  if (b.dash?.length) {
    if (!uniform) {
      const d = [
        `border-style: dashed`, `border-color: ${b.color}`,
        `border-width: ${sides[0]}px ${sides[1]}px ${sides[2]}px ${sides[3]}px`,
      ]
      if (baseShadow) d.push(`box-shadow: ${baseShadow}`)
      return { decls: d, fallback: true }
    }
    const w = sides[0]
    return { decls: [`outline: ${w}px dashed ${b.color}`, `outline-offset: ${-w}px`], fallback: false }
  }

  const parts: string[] = []
  if (uniform) {
    // INSIDE/OUTSIDE 靠正负 spread 区分；CENTER 取一半内一半外
    const w = sides[0]
    if (align === 'OUTSIDE') parts.push(`0 0 0 ${w}px ${b.color}`)
    else if (align === 'CENTER') parts.push(`0 0 0 ${w / 2}px ${b.color}`, `inset 0 0 0 ${w / 2}px ${b.color}`)
    else parts.push(`inset 0 0 0 ${w}px ${b.color}`)
  } else {
    // 逐边：用单边 inset 阴影拼（INSIDE 语义）
    if (b.top) parts.push(`inset 0 ${b.top}px 0 0 ${b.color}`)
    if (b.right) parts.push(`inset -${b.right}px 0 0 0 ${b.color}`)
    if (b.bottom) parts.push(`inset 0 -${b.bottom}px 0 0 ${b.color}`)
    if (b.left) parts.push(`inset ${b.left}px 0 0 0 ${b.color}`)
  }
  if (baseShadow) parts.push(baseShadow)
  return { decls: parts.length ? [`box-shadow: ${parts.join(', ')}`] : [], fallback: false }
}

/**
 * 圆角声明（基准页与骨架共用的唯一实现）。
 * 设计有值就用；没有才按拼接角色推：中间格方角 / 两端格只留外侧圆角 / 其余回落设计系统圆角。
 * 以前只有基准页跑这段，骨架 `if (n.radius)` → 32 个实例出现"基准 8px、骨架直角"。
 */
export function radiusDecl(n: DesignNode, dsRadius: number): { value: string; guessed: boolean } {
  if (n.radius) return { value: n.radius, guessed: false }
  const role = (n as DesignNode & { _joinRole?: string })._joinRole
  if (role === 'mid') return { value: '0px', guessed: true }
  if (role === 'leftEnd') return { value: `${dsRadius}px 0px 0px ${dsRadius}px`, guessed: true }
  if (role === 'rightEnd') return { value: `0px ${dsRadius}px ${dsRadius}px 0px`, guessed: true }
  return { value: `${dsRadius}px`, guessed: true }
}

/** 根节点（#frame / .root）的声明：根自己也可能有 auto-layout，必须有 display:flex */
export function rootCssDecls(model: DesignModel): string[] {
  const r = model.tree
  const d: string[] = ['position: relative', 'margin: 0']
  d.push(...borderPaint(r.border, r.shadow).decls)
  if (r.background) d.push(`background: ${r.background}`)
  if (r.radius) d.push(`border-radius: ${r.radius}`)
  if (r.opacity != null) d.push(`opacity: ${r.opacity}`)
  d.push(r.clips === false ? 'overflow: visible' : 'overflow: hidden')
  if (r.layout?.mode) d.push(...flexDecls(r))
  return d
}
