/**
 * 审计标注与打回判定。
 *
 * 用户要求：① 审计要**标出有问题的地方**；② 结果是**打回给开发修复**。
 * 所以一轮 UI 审计的产物不能只是文字清单，必须有：
 *   - **标注图**：把每条问题按 id 编号钉在设计基准图上（有坐标的钉框、没坐标的进图例），
 *     开发一眼能看到"哪儿不对"；代码侧位置则交给主 agent 用行内标注（diff_approval_annotate）钉到行上；
 *   - **判定（verdict）**：有 blocker/major 就是 **打回(reject)**，全清或只剩 minor 才算通过(pass)；
 *   - **收尾门禁**：最后一轮必须是 pass，且没有未关闭项 —— blocker/major 关闭后必须**再提审一次**，
 *     由审计方判定通过，而不是开发自己说改完了就算。
 */

export type Verdict = 'pass' | 'reject'

export interface AnnotationInput {
  id: string
  severity: string
  text: string
  /** 设计稿内坐标 [x, y, w, h]（由 node_id 解析或直接给） */
  box?: [number, number, number, number] | null
  /** 代码位置（文件:行）——不进图，进"打回清单"的改法列 */
  location?: string
}

const SEV_COLOR: Record<string, string> = {
  blocker: '#e64545',
  major: '#e8830c',
  minor: '#8a94a6',
  info: '#8a94a6',
}

/** blocker/major 任一存在 → 打回 */
export function legendHeightFor(count: number): number {
  return Math.min(1400, 56 + count * 44)
}

export function verdictOf(items: Array<{ severity: string }>): Verdict {
  return items.some((i) => i.severity === 'blocker' || i.severity === 'major') ? 'reject' : 'pass'
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 生成标注页：基准图铺底，按 id 编号钉出问题框；没有坐标的问题在右侧图例里列出。
 * 页面尺寸 = 设计稿尺寸，方便直接用无头 Chrome 截成同尺寸的标注图。
 */
export function buildAnnotatedHtml(opts: {
  /** 基准图文件名（与标注页同目录，用相对路径） */
  imageFile: string
  width: number
  height: number
  annotations: AnnotationInput[]
  title?: string
  /** 图例区高度（放在设计图下方，避免遮挡设计内容，也能被一起截进图） */
  legendHeight: number
}): string {
  const marks = opts.annotations
    .filter((a) => a.box)
    .map((a) => {
      const [x, y, w, h] = a.box as [number, number, number, number]
      const color = SEV_COLOR[a.severity] ?? SEV_COLOR.info
      return `<div class="bx" style="left:${x}px;top:${y}px;width:${Math.max(w, 8)}px;height:${Math.max(h, 8)}px;border-color:${color}">
        <span class="tag" style="background:${color}">${esc(a.id)}</span>
      </div>`
    })
    .join('\n')

  const legend = opts.annotations
    .map((a) => {
      const color = SEV_COLOR[a.severity] ?? SEV_COLOR.info
      const pos = a.box ? `图上 (${a.box[0]},${a.box[1]})` : a.location ? esc(a.location) : '未给位置'
      return `<li><b style="color:${color}">${esc(a.id)}</b> <span class="sev" style="background:${color}">${esc(a.severity)}</span>
        ${esc(a.text.slice(0, 90))} <span class="pos">${pos}</span></li>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>审计标注 · ${esc(opts.title ?? '')}</title>
<style>
  html,body{margin:0;padding:0;background:#fff;font-family:system-ui,-apple-system,'PingFang SC',sans-serif}
  #stage{position:relative;width:${opts.width}px;height:${opts.height + opts.legendHeight}px}
  #stage img{position:absolute;left:0;top:0;width:${opts.width}px;height:${opts.height}px}
  .bx{position:absolute;box-sizing:border-box;border:2px solid #e64545;background:rgba(230,69,69,.08);border-radius:2px}
  .tag{position:absolute;left:-2px;top:-18px;color:#fff;font:700 11px/16px system-ui;padding:0 5px;border-radius:3px}
  #legend{position:absolute;left:0;top:${opts.height}px;width:${opts.width}px;box-sizing:border-box;
          padding:14px 20px;font:13px/1.7 system-ui;color:#1c2433;border-top:1px solid #dee0ec;background:#fbfbfd}
  #legend h4{margin:0 0 6px;font-size:14px}
  #legend ul{margin:0;padding-left:18px}
  #legend li{margin-bottom:5px}
  .sev{color:#fff;font:700 10px/14px system-ui;padding:0 4px;border-radius:3px;vertical-align:1px}
  .pos{color:#8a94a6}
</style></head>
<body>
<div id="stage">
  <img src="./${esc(opts.imageFile)}" alt="design baseline">
  ${marks}
  <div id="legend">
    <h4>审计标注（${opts.annotations.length} 条）</h4>
    <ul>${legend}</ul>
  </div>
</div>
</body></html>`
}

/** 打回清单（给人/给开发/给下一轮用），与 CODEGEN_PROMPT 里的表互补 */
export function renderRejectionMarkdown(opts: {
  round: number
  reviewer: string
  at: string
  verdict: Verdict
  items: AnnotationInput[]
  annotatedImage?: string
  staticPng?: string
  rejected: boolean
}): string {
  const L: string[] = []
  L.push(`# ${opts.rejected ? '❌ 审计打回' : '✅ 审计通过'}（第 ${opts.round} 轮 · ${opts.reviewer}）`)
  L.push('')
  L.push(`- 判定：**${opts.verdict}**${opts.rejected ? '（存在 blocker/major，打回开发修复）' : '（无 blocker/major）'}`)
  L.push(`- 时间：${opts.at}`)
  if (opts.annotatedImage) L.push(`- 标注图（问题已按 id 钉在基准图上）：${opts.annotatedImage}`)
  if (opts.staticPng) L.push(`- 设计基准图：${opts.staticPng}`)
  L.push('')
  L.push('## 打回清单（开发逐条修复，并写清改了哪个文件哪一行 + 实测值）')
  L.push('')
  L.push('| id | 级别 | 问题 | 位置 | 修法（文件:行） | 实测值 | 状态 |')
  L.push('|---|---|---|---|---|---|---|')
  for (const it of opts.items) {
    const pos = it.box ? `图上 (${it.box[0]},${it.box[1]})` : it.location ?? ''
    L.push(`| ${it.id} | ${it.severity} | ${it.text.replace(/\|/g, '\\|')} | ${pos} | | | open |`)
  }
  L.push('')
  L.push('## 打回后的流程（不可跳过）')
  L.push('')
  L.push('1. 开发按上表逐条修复；每条必须写"改在哪个文件哪一行 + 用什么实测数值验证"；')
  L.push('2. 代码位置建议由主 agent 用行内标注（diff_approval_annotate）钉在对应行上，直接在代码里对话；')
  L.push('3. 修完 `figma_review_to_round(action="close", close="R1,R2", note="…")` 逐条关闭；')
  L.push(opts.rejected
    ? '4. **blocker/major 关闭后必须再提审一轮**（复审）拿到 pass，才允许收尾；开发自述"改完了"不算通过。'
    : '4. 本轮无 blocker/major，关闭 remain 的 minor 后即可收尾。')
  L.push('')
  return L.join('\n')
}
