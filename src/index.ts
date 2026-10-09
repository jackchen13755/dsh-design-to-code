import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildDesignModel } from './design.js'
import { generateCode, summarizeAudit } from './codegen.js'
import { auditModel, auditToMarkdown } from './audit.js'
import { renderStatic } from './render-static.js'
import { findCodeHits, keywordsOf, renderChangeMarkdown } from './diff.js'
import { expertImageBrief, exportStaticPagePng, pngPathsFor, pngSummary, renderHtmlToPng } from './screenshot.js'
import { buildAnnotatedHtml, legendHeightFor, renderRejectionMarkdown, verdictOf, type AnnotationInput } from './annotate.js'
import {
  hasExpertReview, openByeSeverity, openItems, parseReview, renderReviewRound, summarizeRounds,
  type ReviewItem, type ReviewItemState, type ReviewRoundState,
} from './review.js'

export const name = '@deepseek-ai/dsh-tool-design-to-code'
export const inject = ['tools']

export interface Config {
  /** figma_ws 捕获目录（浏览器扩展静默生成），默认 ~/Downloads/figma_ws。 */
  wsCaptureDir?: string
  /** 默认导出目录。 */
  outputDir?: string
}

export const Config = z.object({
  wsCaptureDir: z.string().default(''),
  outputDir: z.string().default(''),
})

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}

function parseNodeUrl(url: string): { fileKey: string; nodeId: string } {
  const m = url.match(/figma\.com\/(?:design|file|proto)\/([^/?]+)/)
  const n = url.match(/node-id=([^&]+)/)
  if (!m) throw new Error(`无法从 URL 解析 file key：${url}`)
  const fileKey = m[1]
  const nodeId = n ? decodeURIComponent(n[1]).replace('-', ':') : ''
  return { fileKey, nodeId }
}

function resolveTarget(url?: string, fileKey?: string, nodeId?: string): { fileKey: string; nodeId: string } {
  if (url) return parseNodeUrl(url)
  if (fileKey && nodeId) return { fileKey, nodeId }
  throw new Error('需要 url，或 file_key + node_id')
}

/** 从捕获目录找最新数据帧（manifest 优先，<1KB 时回退到最大帧）。 */
async function findDataFrame(dir: string): Promise<{ dataPath: string; schemaPath: string | null; manifest: unknown }> {
  const manifestPath = join(dir, 'last_capture.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.dataFile && Number(manifest.dataSize ?? 0) >= 1024) {
        const p = join(dir, manifest.dataFile)
        if (existsSync(p)) return { dataPath: p, schemaPath: manifest.schemaFile ? join(dir, manifest.schemaFile) : null, manifest }
      }
    } catch {
      // ignore
    }
  }
  const files = (await readdir(dir)).filter((f) => /^frame_0001_recv_\d+b\.bin$/.test(f))
  if (!files.length) throw new Error(`目录 ${dir} 没有数据帧（先装扩展并打开 Figma 页面，或传 design_json）`)
  const stats = await Promise.all(
    files.map(async (f) => ({ f, m: (await stat(join(dir, f))).mtimeMs })),
  )
  stats.sort((a, b) => b.m - a.m)
  return { dataPath: join(dir, stats[0].f), schemaPath: null, manifest: null }
}

/**
 * 流程状态（flow.json）：把"基准页是否已生成 / 是否已被人工确认"变成**可审计的状态**，
 * 而不是靠提示词自觉。任何 agent（主 agent / 专家 / teammate）都读得到、也绕不过硬门禁。
 */
interface FlowState {
  stage: 'static_rendered' | 'skeleton_generated' | 'change_brief_ready'
  nodeId: string
  fileKey: string
  staticPage?: string
  specPath?: string
  confirmed: boolean
  /** 谁确认的基准页：human（人看基准页）| expert_review（UI 专家审计通过，按流程约定可替代人工确认） */
  confirmedVia?: 'human' | 'expert_review'
  confirmedBy?: string
  confirmedAt?: string
  confirmNote?: string
  /** 涉及 UI 的交付必须走一轮 UI 专家审计（默认 true；figma_codegen_round 会据此卡收尾） */
  expertReviewRequired?: boolean
  /** 专家整改清单的轮次记录（figma_review_to_round 维护） */
  reviews?: ReviewRoundState[]
  updatedAt: string
}

async function readFlow(outDir: string): Promise<FlowState | null> {
  const p = join(outDir, 'flow.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(await readFile(p, 'utf8')) as FlowState } catch { return null }
}

/**
 * 找 flow.json：调用方给的可能不是同一层目录
 * （figma_gen_component 收 outDir，figma_codegen_round 收 outDir/gen），
 * 所以往上找两层。找不到就返回 null（旧产物没有状态文件，不能因此崩）。
 */
async function findFlow(dir: string): Promise<{ flow: FlowState; dir: string } | null> {
  for (const cand of [dir, resolve(dir, '..'), resolve(dir, '..', '..')]) {
    const f = await readFlow(cand)
    if (f) return { flow: f, dir: cand }
  }
  return null
}

async function writeFlow(outDir: string, patch: Partial<FlowState> & Pick<FlowState, 'stage' | 'nodeId' | 'fileKey'>): Promise<FlowState> {
  await mkdir(outDir, { recursive: true })
  const prev = await readFlow(outDir)
  const next: FlowState = { ...(prev ?? {} as FlowState), ...patch, updatedAt: new Date().toISOString() }
  await writeFile(join(outDir, 'flow.json'), JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 从静态基准页旁边的 spec.json 里读逐节点坐标，
 * 让审计清单里写的"132:8240"能落到基准图上的框（= 标出有问题的地方）。
 */
function makeBoxResolver(staticDir: string): { resolve: (nodeId: string) => [number, number, number, number] | null; width: number; height: number } | null {
  const p = join(staticDir, 'spec.json')
  if (!existsSync(p)) return null
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { width: number; height: number; rows: Array<{ id: string; x: number; y: number; w: number; h: number }> }
    const byId = new Map(j.rows.map((r) => [r.id, r]))
    return {
      width: j.width,
      height: j.height,
      resolve: (nodeId: string) => {
        const r = byId.get(nodeId)
        return r ? [r.x, r.y, r.w, r.h] as [number, number, number, number] : null
      },
    }
  } catch {
    return null
  }
}

/** 轮次游标（.codegen-round）：figma_codegen_round 与 figma_review_to_round 共用 */
async function readRound(dir: string): Promise<number> {
  try { return Number(await readFile(join(dir, '.codegen-round'), 'utf8')) || 1 } catch { return 1 }
}

/** 找"生成目录"（含 CODEGEN_PROMPT.md 的那层）：调用方可能给 outDir 或 outDir/gen */
async function findGenDir(dir: string): Promise<string | null> {
  for (const cand of [dir, join(dir, 'gen'), resolve(dir, '..'), join(resolve(dir, '..'), 'gen')]) {
    if (existsSync(join(cand, 'CODEGEN_PROMPT.md'))) return cand
  }
  return null
}

function parseItemsJson(raw?: string): ReviewItem[] | null {
  if (!raw) return null
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return null
    return arr.map((it: any, i: number) => ({
      id: String(it.id ?? `R${i + 1}`),
      severity: (['blocker', 'major', 'minor', 'info'].includes(String(it.severity)) ? String(it.severity) : 'info') as ReviewItem['severity'],
      text: String(it.text ?? it.issue ?? it.description ?? '').slice(0, 400),
      location: it.location ? String(it.location) : undefined,
      expected: it.expected ? String(it.expected) : undefined,
      actual: it.actual ? String(it.actual) : undefined,
      nodeId: it.node_id ? String(it.node_id) : (it.nodeId ? String(it.nodeId) : undefined),
      box: Array.isArray(it.box) && it.box.length === 4 ? (it.box.map(Number) as [number, number, number, number]) : undefined,
    })).filter((it) => it.text)
  } catch {
    return null
  }
}

interface NodeInput {
  url?: string
  file_key?: string
  node_id?: string
  design_json?: string
  output_dir?: string
  ws_capture_dir?: string
}

const NODE_PARAMS = {
  url: { type: 'string' as const, description: 'Figma 设计稿 URL（含 node-id）' },
  file_key: { type: 'string' as const, description: 'Figma file key（传 url 时可不填）' },
  node_id: { type: 'string' as const, description: '节点 ID，如 8049:4704（传 url 时可不填）；**同一文件里同名画板多代共存，必须给准 node-id**' },
  design_json: { type: 'string' as const, description: '已解码节点 JSON 路径（dsh-figma-reader 产物）；缺省读 ~/Downloads/figma_ws 帧自动解码' },
  output_dir: { type: 'string' as const, description: '输出目录，默认 ~/Desktop/design-to-code/<nodeId>' },
  ws_capture_dir: { type: 'string' as const, description: '捕获目录，默认 ~/Downloads/figma_ws' },
}

/** 统一取节点 JSON（design_json 优先，否则 WS 扩展帧自动解码，零 REST）。 */
async function loadNodeJson(args: NodeInput, config: Config): Promise<{ nodeJson: Record<string, any>; fileKey: string; nodeId: string; outDir: string; captureDir: string }> {
  const { fileKey, nodeId } = resolveTarget(args.url, args.file_key, args.node_id)
  const captureDir = resolve(args.ws_capture_dir || config.wsCaptureDir || join(homedir(), 'Downloads', 'figma_ws'))
  const outDir = resolve(args.output_dir || config.outputDir || join(homedir(), 'Desktop', 'design-to-code', nodeId.replace(':', '-')))

  let nodeJson: Record<string, any>
  if (args.design_json) {
    nodeJson = JSON.parse(await readFile(resolve(args.design_json), 'utf8'))
  } else {
    const tmp = join(outDir, '.decode')
    await mkdir(tmp, { recursive: true })
    const { dataPath } = await findDataFrame(captureDir)
    const { decodeFrameAndBuildReport } = await import('@deepseek-ai/dsh-tool-figma-reader/lib/kiwi.js')
    const dec = decodeFrameAndBuildReport(dataPath, fileKey, nodeId, tmp)
    nodeJson = JSON.parse(await readFile(dec.jsonPath, 'utf8'))
  }
  return { nodeJson, fileKey, nodeId, outDir, captureDir }
}

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // ── 工具 0：静态还原页（视觉基准，最先跑） ──
    disposers.push(ctx.tools.register(defineTool({
      name: 'figma_render_static',
      description: '把设计稿节点逐节点渲染成 1:1 静态还原页（index.html）+ 设计规格/映射表（SPEC.md）：坐标已归零、逐边描边、逐角圆角、字体、auto-layout、实例按设计系统重建。这是唯一的"视觉基准"，人工先确认它，再让组件实现去对齐它',
      parameters: {
        ...NODE_PARAMS,
        title: { type: 'string', description: '页面标题（默认取设计稿节点名）' },
        project: { type: 'string', description: '目标项目名（写进 SPEC.md 的映射表）' },
        png: { type: 'boolean', description: '是否同时导出设计基准图 PNG（默认 true；供 UI 专家子 agent 读图审计）' },
        png_scale: { type: 'number', description: 'PNG 设备像素比（默认 2，即 2x 图，1px 描边也能看清）' },
        chrome_bin: { type: 'string', description: '无头浏览器可执行文件路径（缺省自动探测 Chrome/Chromium/Edge/Brave）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [textBlock(String(value))],
      },
      async execute(args: NodeInput & { title?: string; project?: string; png?: boolean; png_scale?: number; chrome_bin?: string }) {
        const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config)
        const model = buildDesignModel(nodeJson)
        const staticDir = join(outDir, 'static')
        const r = renderStatic(model, { outputDir: staticDir, title: args.title, projectName: args.project })

        // 设计基准图：给人和 UI 专家子 agent 直接看图审计（不依赖 Figma 出图权限）
        let pngLines: string[] = ['- （已关闭 png 导出）']
        let pngPaths: string[] = []
        let brief = ''
        if (args.png !== false) {
          const paths = pngPathsFor(r.htmlPath)
          const results = await exportStaticPagePng({
            htmlPath: r.htmlPath,
            outPath: paths.twoX,
            width: model.width,
            height: model.height,
            scale: Math.max(1, Number(args.png_scale ?? 2)),
            chromeBin: args.chrome_bin,
          }, true)
          pngLines = pngSummary(results).split('\n')
          pngPaths = results.filter((x) => x.ok && x.path).map((x) => x.path!)
          if (pngPaths.length) brief = expertImageBrief(pngPaths, r.htmlPath, r.specPath)
        }
        const flow = await writeFlow(outDir, {
          stage: 'static_rendered', nodeId, fileKey,
          staticPage: r.htmlPath, specPath: r.specPath, confirmed: false,
          confirmedBy: undefined, confirmedAt: undefined, confirmNote: undefined,
        })
        void flow
        return [
          `🖼️ 已生成静态还原页（设计 ${fileKey} · 节点 ${nodeId}）`,
          `- 画布 ${model.width}×${model.height} · 渲染节点 ${r.stats.nodes} · 实例重建 ${r.stats.instances} · CSS 规则 ${r.stats.rules}`,
          `- 页面：${r.htmlPath}`,
          r.specPath ? `- 规格/映射表：${r.specPath}` : '',
          ...pngLines,
          '',
          `- 流程状态：${join(outDir, 'flow.json')}（confirmed=false）`,
          '',
          '【必须做·二选一（主流程）】',
          '  方式 A（推荐，UI 相关默认走这条）：把基准图交给 UI 专家做**基准审计**',
          '    summon_expert("UI 视觉验收设计师", 任务) → 任务里带上面两张基准图路径 + 基准页 + SPEC',
          `    → figma_review_to_round(output_dir="${outDir}", review=<专家原文>, scope="baseline", reviewer="UI 视觉验收设计师")`,
          '    → 走完这一步即视为基准已确认（confirmedVia=expert_review），**不需要人工再确认一遍**。',
          '  方式 B（没有专家可用时）：主 agent 用 present/sidebar_open 把基准页呈现给用户，',
          `    用户确认后调用 figma_confirm_static(output_dir="${outDir}")（confirmedVia=human）。`,
          '',
          '提醒：这一页是**视觉基准**，样式不要直接搬进项目（映射规则见 SPEC.md 第 2 节）。',
          brief ? `\n${brief}` : '',
        ].filter(Boolean).join('\n')
      },
    })))

    // ── 工具 0b：变更模式（需求是"在现有页面上改几处"时走这条） ──
    disposers.push(ctx.tools.register(defineTool({
      name: 'figma_change_brief',
      description: '【改现有页面首选】变更简报：设计新稿 → 生成 1:1 静态基准页 + "旧稿 vs 新稿"逐字段设计差异 + 在目标仓库里 grep 出的代码落点候选 + 逐条变更计划模板（设计→现状→改法→验证）。适用于"在现有页面上改几处"的需求，避免整页重画',
      parameters: {
        ...NODE_PARAMS,
        old_node_id: { type: 'string', description: '旧稿节点 ID（同文件；同名画板多代共存，必须给准）。给了才能出逐字段差异' },
        old_design_json: { type: 'string', description: '旧稿已解码 JSON 路径（可选，优先于 old_node_id）' },
        code_dir: { type: 'string', description: '目标项目目录：用于 grep 出既有实现的候选落点（如 /path/to/spms）' },
        project: { type: 'string', description: '目标项目名（写进简报与映射表）' },
        extra_keywords: { type: 'string', description: '额外定位关键字（逗号分隔），如类名前缀/组件名' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [textBlock(String(value))],
      },
      async execute(args: NodeInput & { old_node_id?: string; old_design_json?: string; code_dir?: string; project?: string; extra_keywords?: string }) {
        const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config)
        const newModel = buildDesignModel(nodeJson)

        let oldModel = null
        if (args.old_design_json) {
          oldModel = buildDesignModel(JSON.parse(await readFile(resolve(args.old_design_json), 'utf8')))
        } else if (args.old_node_id) {
          try {
            const old = await loadNodeJson({ file_key: fileKey, node_id: args.old_node_id, ws_capture_dir: args.ws_capture_dir, output_dir: join(outDir, '.old') }, config)
            oldModel = buildDesignModel(old.nodeJson)
          } catch (e) {
            oldModel = null
          }
        }

        // 新稿的视觉基准页 + 规格/映射表
        const staticDir = join(outDir, 'static')
        const st = renderStatic(newModel, { outputDir: staticDir, projectName: args.project })

        const keywords = keywordsOf(newModel)
        const extra = (args.extra_keywords || '').split(',').map((s) => s.trim()).filter(Boolean)
        const codeHits = args.code_dir
          ? findCodeHits(resolve(args.code_dir), keywords, { extra })
          : undefined

        const md = renderChangeMarkdown({
          newModel, oldModel, project: args.project,
          codeDir: args.code_dir ? resolve(args.code_dir) : undefined,
          codeHits, keywords, staticPagePath: st.htmlPath, specPath: st.specPath,
        })
        await mkdir(outDir, { recursive: true })
        const changePath = join(outDir, 'CHANGE.md')
        await writeFile(changePath, md, 'utf8')
        await writeFlow(outDir, {
          stage: 'change_brief_ready', nodeId, fileKey,
          staticPage: st.htmlPath, specPath: st.specPath, confirmed: false,
          confirmedBy: undefined, confirmedAt: undefined, confirmNote: undefined,
        })

        const changed = md.match(/\*\*改动 (\d+) · 新增 (\d+) · 删除 (\d+)\*\*/)
        return [
          `📝 变更简报已生成（设计 ${fileKey} · 新稿 ${nodeId}${args.old_node_id ? ` · 旧稿 ${args.old_node_id}` : ''}）`,
          changed ? `- 设计差异：改动 ${changed[1]} · 新增 ${changed[2]} · 删除 ${changed[3]}` : '- 未给旧稿：按新稿全量规格对现有实现逐项核对',
          codeHits ? `- 代码落点：扫描 ${codeHits.scanned} 文件，命中 ${codeHits.hits.length} 条` : '- 未传 code_dir：跳过代码落点扫描',
          `- 视觉基准页：${st.htmlPath}`,
          st.specPath ? `- 规格/映射表：${st.specPath}` : '',
          `- 变更简报：${changePath}`,
          '',
          '【必须做·交接给用户】把基准页交给用户确认（主 agent 用 present/sidebar_open 呈现）：',
          `  「请打开 ${st.htmlPath} 确认设计基准；并确认 CHANGE.md §1 的设计差异列表」`,
          `确认后调用 figma_confirm_static(output_dir="${outDir}")，再按简报动手改。`,
          '按简报 §4 的变更计划逐条填「现状（代码实测）→ 改法（文件:行）」，再动手改；',
          '改完用 §5 的收尾检查 + 基准页对照验收。',
        ].filter(Boolean).join('\n')
      },
    })))

    // ── 工具 0c：人工确认基准页（把"人工确认"变成可审计状态） ──
    disposers.push(ctx.tools.register(defineTool({
      name: 'figma_confirm_static',
      description: '记录"人工已确认设计基准页"：由用户看过 static/index.html 后调用，写入 flow.json(confirmed=true, by/at/note)。后续 figma_codegen_round 在未确认时会拒绝收尾。reset=true 可撤销确认',
      parameters: {
        output_dir: { type: 'string', description: 'figma_render_static / figma_change_brief 的输出目录（含 flow.json）' },
        by: { type: 'string', description: '确认人（用户名/角色）' },
        via: { type: 'string', description: "确认来源：human（人看过基准页，默认）| expert_review（UI 专家审计通过）" },
        note: { type: 'string', description: '确认说明；有差异就写清"哪些差异已接受"（不要写"看起来没问题"）' },
        diffs: { type: 'string', description: '确认时仍存在的已知差异（逗号分隔），会一并记录' },
        reset: { type: 'boolean', description: 'true = 撤销确认（设计稿改了要重新确认时用）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [textBlock(String(value))],
      },
      async execute(args: { output_dir: string; by?: string; via?: string; note?: string; diffs?: string; reset?: boolean }) {
        const dir = resolve(args.output_dir)
        const prev = await readFlow(dir)
        if (!prev) throw new Error(`找不到 ${join(dir, 'flow.json')}：先跑 figma_render_static（或 figma_change_brief）`)
        if (args.reset) {
          const next = await writeFlow(dir, { stage: prev.stage, nodeId: prev.nodeId, fileKey: prev.fileKey, confirmed: false, confirmedBy: undefined, confirmedAt: undefined, confirmNote: undefined })
          return `♻️ 已撤销基准页确认（${dir}）\n- 当前 confirmed=${next.confirmed}；改完设计稿请重新渲染并再次确认。`
        }
        const note = [args.note, args.diffs ? `已知差异：${args.diffs}` : ''].filter(Boolean).join(' | ')
        const via = args.via === 'expert_review' ? 'expert_review' : 'human'
        const next = await writeFlow(dir, {
          stage: prev.stage, nodeId: prev.nodeId, fileKey: prev.fileKey,
          confirmed: true,
          confirmedVia: via,
          confirmedBy: args.by || (via === 'expert_review' ? 'expert' : 'user'),
          confirmedAt: new Date().toISOString(),
          confirmNote: note || undefined,
        })
        return [
          `✅ 已记录基准页人工确认（设计 ${next.fileKey} · 节点 ${next.nodeId}）`,
          `- 确认来源：${next.confirmedVia ?? 'human'} · 确认人：${next.confirmedBy} · 时间：${next.confirmedAt}`,
          next.confirmNote ? `- 备注：${next.confirmNote}` : '',
          `- 基准页：${next.staticPage ?? ''}`,
          `- 状态文件：${join(dir, 'flow.json')}`,
          '',
          '接下来：figma_audit_node → figma_gen_component（骨架）→ 按 CODEGEN_PROMPT 用项目组件实现 → 组件截图 ↔ 基准页对照 → figma_codegen_round。',
        ].filter(Boolean).join('\n')
      },
    })))

    // ── 工具 0d：专家整改清单 → 下一轮任务（把"人味判断"接进闭环） ──
    disposers.push(ctx.tools.register(defineTool({
      name: 'figma_review_to_round',
      description: '【主流程必需】把 UI 专家/验收专家的整改清单接进迭代闭环（涉及 UI 的交付必须至少跑一轮，否则 figma_codegen_round 拒绝收尾）：解析成结构化条目 → 注入 CODEGEN_PROMPT.md 的下一轮 → 在 flow.json 里逐条记 open/closed。未关闭条目会让 figma_codegen_round 拒绝收尾。action=add 追加评审 / list 查看 / close 关闭条目',
      parameters: {
        output_dir: { type: 'string', description: '输出目录（figma_gen_component 的 output_dir 或其 gen 子目录）' },
        action: { type: 'string', description: 'add（默认，追加评审）/ list（查看当前条目状态）/ close（关闭条目）' },
        review: { type: 'string', description: 'add：专家整改清单原文（markdown/列表/表格都行，启发式解析）' },
        items: { type: 'string', description: 'add：显式结构化条目（JSON 数组，优先于 review 解析），如 [{"severity":"major","text":"锚点项应为只有左边框","location":"less/index.less:48"}]' },
        reviewer: { type: 'string', description: 'add：评审人（如 "UI 视觉验收设计师"）' },
        scope: { type: 'string', description: "add：本轮审计对象：baseline（设计基准图/基准页本身）| implementation（组件实现截图 vs 基准图，默认）" },
        source: { type: 'string', description: 'add：来源（文件路径或说明）' },
        close: { type: 'string', description: 'close：要关闭的条目 id（逗号分隔，如 R1,R3）；也可写 all' },
        closed_by: { type: 'string', description: 'close：关闭人' },
        note: { type: 'string', description: 'close：关闭说明（改在哪个文件哪一行、实测值）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [textBlock(String(value))],
      },
      async execute(args: {
        output_dir: string; action?: string; review?: string; items?: string
        reviewer?: string; source?: string; close?: string; closed_by?: string; note?: string; scope?: string
      }) {
        const start = resolve(args.output_dir)
        const action = args.action || 'add'
        const found = await findFlow(start)
        const genDir = await findGenDir(start)
        const flowDir = found?.dir ?? (genDir ? resolve(genDir, '..') : start)

        // ── list ──
        if (action === 'list') {
          if (!found?.flow.reviews?.length) return `（${flowDir}/flow.json 里还没有专家评审记录）`
          const L = [`📋 专家评审状态（${flowDir}）：${summarizeRounds(found.flow.reviews)}`, '']
          L.push('| id | 轮次 | 级别 | 状态 | 问题 | 位置 |')
          L.push('|---|---|---|---|---|---|')
          for (const r of found.flow.reviews) {
            for (const it of r.items) {
              L.push(`| ${it.id} | ${r.round} | ${it.severity} | ${it.status === 'open' ? '🔴 open' : '✅ closed'} | ${it.text.replace(/\|/g, '\\|').slice(0, 120)} | ${it.location ?? ''} |`)
            }
          }
          const open = openItems(found.flow.reviews)
          L.push('')
          L.push(open.length ? `⚠️ 还有 ${open.length} 条未关闭：${open.map((i) => i.id).join(', ')}` : '✅ 全部已关闭')
          return L.join('\n')
        }

        // ── close ──
        if (action === 'close') {
          if (!found?.flow.reviews?.length) throw new Error('还没有专家评审记录，先 action=add')
          const wanted = String(args.close || '').trim()
          const all = found.flow.reviews.flatMap((r) => r.items)
          const ids = wanted === 'all' ? all.filter((i) => i.status === 'open').map((i) => i.id)
            : wanted.split(',').map((x) => x.trim()).filter(Boolean)
          if (!ids.length) throw new Error('close 需要指定条目 id（逗号分隔）或 all')
          const unknown = ids.filter((id) => !all.some((i) => i.id === id))
          if (unknown.length) throw new Error(`找不到条目：${unknown.join(', ')}（可用 action=list 查看）`)
          const now = new Date().toISOString()
          for (const r of found.flow.reviews) {
            for (const it of r.items) {
              if (ids.includes(it.id) && it.status === 'open') {
                it.status = 'closed'; it.closedBy = args.closed_by || 'agent'; it.closedAt = now
                it.closedNote = args.note || undefined
              }
            }
          }
          await writeFlow(flowDir, { ...found.flow, reviews: found.flow.reviews })
          const rest = openItems(found.flow.reviews)
          return [
            `✅ 已关闭 ${ids.length} 条（${ids.join(', ')}）`,
            rest.length ? `⚠️ 仍有 ${rest.length} 条未关闭：${rest.map((i) => i.id).join(', ')}` : '✅ 全部整改项已关闭',
          ].join('\n')
        }

        // ── add ──
        if (!genDir) throw new Error(`找不到 CODEGEN_PROMPT.md（在 ${start} 及其 gen/ 下都没有）：先跑 figma_gen_component`)
        const explicit = parseItemsJson(args.items)
        const staticDir = join(flowDir, 'static')
        const resolver = makeBoxResolver(staticDir)
        const items: ReviewItem[] = explicit ?? parseReview(String(args.review ?? ''), {
          resolveBox: resolver ? resolver.resolve : undefined,
        })
        // 显式给了 node_id 但没给 box 的，也补上坐标
        for (const it of items) {
          if (!it.box && it.nodeId && resolver) it.box = resolver.resolve(it.nodeId)
        }
        if (!items.length) {
          throw new Error('没能从 review 里解析出任何条目。请把清单写成列表/表格，或用 items 传结构化 JSON（JSON.parse 后的数组）')
        }
        const round = (await readRound(genDir)) + 1
        const at = new Date().toISOString()
        const reviewer = args.reviewer || 'expert'
        // 条目 id 必须**跨轮唯一**：否则第 2 轮的 R1 与第 4 轮的 R1 会互相误关。
        // 统一改成 `<轮次>.<序号>`，并在输出里回显让调用方照抄。
        for (let i = 0; i < items.length; i++) items[i] = { ...items[i], id: `${round}.${i + 1}` }
        const block = renderReviewRound(items, { round, reviewer, at, source: args.source, extra: args.review })
        const promptPath = join(genDir, 'CODEGEN_PROMPT.md')
        await writeFile(promptPath, `${await readFile(promptPath, 'utf8')}\n${block}`, 'utf8')
        await writeFile(join(genDir, '.codegen-round'), String(round), 'utf8')

        const state: ReviewItemState[] = items.map((it) => ({ ...it, status: 'open' }))
        const scope = args.scope === 'baseline' ? 'baseline' : 'implementation'
        const verdict = verdictOf(items)

        // ── 标出有问题的地方：把问题按 id 钉在设计基准图上 ──
        let annotatedImage: string | undefined
        if (resolver) {
          const imgFile = 'index.png'
          const annos: AnnotationInput[] = items.map((it) => ({
            id: it.id, severity: it.severity, text: it.text,
            box: it.box ?? null, location: it.location,
          }))
          const legendH = legendHeightFor(annos.length)
          const annHtml = buildAnnotatedHtml({
            imageFile: imgFile, width: resolver.width, height: resolver.height,
            annotations: annos, title: `第 ${round} 轮审计`, legendHeight: legendH,
          })
          const annHtmlPath = join(staticDir, `annotated-round-${round}.html`)
          await writeFile(annHtmlPath, annHtml, 'utf8')
          const png = await renderHtmlToPng({
            htmlPath: annHtmlPath,
            outPath: join(staticDir, `annotated-round-${round}.png`),
            width: resolver.width, height: resolver.height + legendH, scale: 2,
          })
          if (png.ok) annotatedImage = png.path
        }
        const reviews = [...(found?.flow.reviews ?? []), { round, reviewer, at, source: args.source, scope, verdict, annotatedImage, items: state } as ReviewRoundState]
        await writeFlow(flowDir, {
          stage: found?.flow.stage ?? 'skeleton_generated',
          nodeId: found?.flow.nodeId ?? '',
          fileKey: found?.flow.fileKey ?? '',
          reviews,
          // 流程约定：走完 UI 专家审计，就不再要求人工再确认一遍基准页。
          // 但"谁把的关"必须留痕：confirmedVia 记 expert_review，confirmedBy 记专家名。
          confirmed: found?.flow.confirmed ? true : true,
          confirmedVia: found?.flow.confirmedVia ?? 'expert_review',
          confirmedBy: found?.flow.confirmedBy ?? `expert:${reviewer}`,
          confirmedAt: found?.flow.confirmedAt ?? at,
        })

        // 落一份人可读的评审记录
        await mkdir(join(genDir, 'review'), { recursive: true })
        await writeFile(join(genDir, 'review', `round-${round}.md`), [
          `# 第 ${round} 轮专家整改清单`,
          '',
          `- 评审人：${reviewer} · 时间：${at}${args.source ? ` · 来源：${args.source}` : ''}`,
          '',
          '| id | 级别 | 问题 | 位置 | 期望 | 实际 |',
          '|---|---|---|---|---|---|',
          ...items.map((it) => `| ${it.id} | ${it.severity} | ${it.text.replace(/\|/g, '\\|')} | ${it.location ?? ''} | ${it.expected ?? ''} | ${it.actual ?? ''} |`),
          '',
          '---',
          '',
          '## 评审原文',
          '',
          String(args.review ?? '（未提供原文，来自 items 结构化输入）'),
        ].join('\n'), 'utf8')

        // ── 打回清单：开发照着改，改完必须复审拿 pass ──
        const rejectPath = join(genDir, 'review', `round-${round}-${verdict === 'reject' ? 'REJECT' : 'PASS'}.md`)
        await writeFile(rejectPath, renderRejectionMarkdown({
          round, reviewer, at, verdict,
          items: items.map((it) => ({ id: it.id, severity: it.severity, text: it.text, box: it.box ?? null, location: it.location })),
          annotatedImage,
          staticPng: join(staticDir, 'index.png'),
          rejected: verdict === 'reject',
        }), 'utf8')

        const open = openItems(reviews)
        return [
          `${verdict === 'reject' ? '❌ 审计打回' : '✅ 审计通过'} · 已接进第 ${round} 轮（${genDir}）`,
          `- 评审人：${reviewer} · 条目：${items.length}（阻断 ${items.filter((i) => i.severity === 'blocker').length} / 主要 ${items.filter((i) => i.severity === 'major').length} / 次要 ${items.filter((i) => i.severity === 'minor').length}）`,
          `- 已注入：${promptPath}`,
          `- 评审记录：${join(genDir, 'review', `round-${round}.md`)}`,
          `- ${verdict === 'reject' ? '打回清单' : '通过记录'}：${rejectPath}`,
          annotatedImage ? `- 标注图（问题已按 id 钉在基准图上）：${annotatedImage}` : '- 标注图：未生成（缺少 static/spec.json 或没有可解析的坐标）',
          `- 审计对象：${scope} · 状态：${summarizeRounds(reviews)}`,
          scope === 'baseline'
            ? '✅ 已按流程约定把"设计基准已审计"记入 flow.json（confirmedVia=expert_review），无需人工再确认基准页。'
            : '✅ 已记录实现审计；收尾门禁还要求：无未关闭整改项 + 至少一轮专家审计（本轮已满足）。',
          '',
          '解析结果（请核对，解析错了就用 items 传结构化 JSON 重来）：',
          ...items.slice(0, 20).map((it) => `  - [${it.id}/${it.severity}] ${it.text.slice(0, 90)}${it.location ? `  @${it.location}` : ''}`),
          items.length > 20 ? `  - …共 ${items.length} 条` : '',
          '',
          `改完后关闭条目：figma_review_to_round(output_dir="${flowDir}", action="close", close="${items.slice(0, 3).map((i) => i.id).join(',')}", note="改在 xxx.tsx:123，实测 border-width=0 0 0 1px")`,
          `未关闭的 ${open.length} 条会让 figma_codegen_round 拒绝收尾。`,
          verdict === 'reject'
            ? '⚠️ 本轮判定为**打回**：blocker/major 全部关闭后，**还要再提审一轮**拿到 pass 才能收尾（开发自述改完不算通过）。'
            : '本轮无 blocker/major；关闭剩余 minor 后即可收尾。',
          '代码位置建议由主 agent 用行内标注（diff_approval_annotate）钉到对应行上，直接在代码里对话。',
          '把标注图与打回清单一并交给开发（或直接贴进任务书）。',
        ].filter(Boolean).join('\n')
      },
    })))

    // ── 工具 1：设计审计 ──
    disposers.push(ctx.tools.register(defineTool({
      name: 'figma_audit_node',
      description: '【流程硬约束】任何 agent（主/专家/teammate）在按设计稿实现或修改 UI 前，必须先跑 figma_render_static 得到视觉基准页、并由用户确认（figma_confirm_static）。本工具是第 2 步。设计审计：输出逐节点规格（逐边描边/逐角圆角/字体/auto-layout）+ 实现前核对清单，并把"真歧义（要问设计）"与"数据缺失（按兜底规则做）"分开。歧义判据已修正（不再把 strokeWeight 默认值 1 当隐藏边框）',
      parameters: { ...NODE_PARAMS },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [textBlock(String(value))],
      },
      async execute(args: NodeInput) {
        const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config)
        const model = buildDesignModel(nodeJson)
        const audit = auditModel(model)
        await mkdir(outDir, { recursive: true })
        const jsonPath = join(outDir, `figma_${fileKey}_${nodeId}.audit.json`)
        const mdPath = join(outDir, `figma_${fileKey}_${nodeId}.audit.md`)
        await writeFile(jsonPath, JSON.stringify(audit, null, 2), 'utf8')
        await writeFile(mdPath, auditToMarkdown(audit), 'utf8')
        return [
          `🔍 设计审计完成（${fileKey} · ${nodeId}）`,
          `- ${summarizeAudit(audit)}`,
          `- 清单：${mdPath}`,
          '',
          audit.ambiguous.length
            ? '有真歧义项 → 先问设计；其余按清单逐项实现。'
            : '无真歧义；"数据缺失"按兜底规则（用项目既有组件重建）处理即可。',
          '',
          '下一步：figma_gen_component（可传 audit_path 内联清单）。',
        ].join('\n')
      },
    })))

    // ── 工具 2：代码骨架 ──
    disposers.push(ctx.tools.register(defineTool({
      name: 'figma_gen_component',
      description: '【流程硬约束】调用前必须已存在 figma_render_static 产出的 static/index.html（否则本工具直接报错拒跑）；未记录人工确认时会打 ⚠️ 标记。设计稿 + 需求 → React/TS/CSS Modules 几何骨架 + Codegen Prompt（几何/字体/逐边描边/逐角圆角来自设计数据；实例渲染为语义占位并带 data-design-name 供替换为项目组件）',
      parameters: {
        ...NODE_PARAMS,
        requirements: { type: 'string', description: '需求描述（交互/业务/校验/接口）' },
        conventions: { type: 'string', description: '项目约定（技术栈/目录/命名/测试）' },
        component_name: { type: 'string', description: '组件名（英文）；缺省从设计稿节点名推导' },
        audit_path: { type: 'string', description: 'figma_audit_node 生成的 audit.md；存在则内联进 Prompt' },
        static_page: { type: 'string', description: 'figma_render_static 生成的 index.html（视觉基准，写进 Prompt 要求截图对照）' },
        round: { type: 'number', description: '生成轮次（默认 1）' },
        round_feedback: { type: 'string', description: '上一轮反馈（round>1）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [textBlock(String(value))],
      },
      async execute(args: NodeInput & {
        requirements?: string; conventions?: string; component_name?: string
        audit_path?: string; static_page?: string; round?: number; round_feedback?: string
        skip_static_check?: boolean
      }) {
        const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config)

        // 【硬门禁】没有视觉基准页就不许生成骨架：这是"能不能按 UI 还原"的第一道保证，
        // 与 agent 是否自觉无关（主 agent / 专家子 agent / teammate 一律拦）。
        const staticCandidate = args.static_page || join(outDir, 'static', 'index.html')
        if (!args.skip_static_check && !existsSync(resolve(staticCandidate))) {
          throw new Error([
            `拒绝生成：找不到视觉基准页 ${staticCandidate}`,
            '',
            '按设计稿实现 UI 的标准顺序是：',
            `  1) figma_render_static(node_id="${nodeId}", output_dir="${outDir}")  → 产出 1:1 静态还原页`,
            '  2) 把该页面交给用户确认（主 agent 用 present/sidebar_open 呈现），确认后 figma_confirm_static',
            '  3) figma_audit_node → figma_gen_component（本工具）',
            '',
            '如果你确实要跳过（例如只是想要几何数据），显式传 skip_static_check=true。',
          ].join('\n'))
        }
        const model = buildDesignModel(nodeJson)
        const audit = auditModel(model)
        let auditMd = ''
        if (args.audit_path && existsSync(resolve(args.audit_path))) {
          auditMd = await readFile(resolve(args.audit_path), 'utf8')
        } else {
          auditMd = auditToMarkdown(audit)
        }

        const componentName = args.component_name || model.componentName
        const round = Math.max(1, Number(args.round ?? 1))
        const dir = join(outDir, 'gen')
        const files = generateCode(model, {
          componentName,
          requirements: args.requirements || '（未提供需求，按设计稿默认交互：表单输入 + 按钮动作 + 关闭）',
          conventions: args.conventions || 'React 18 + TypeScript + CSS Modules，零运行时第三方依赖，组件/逻辑拆分，类型安全',
          outputDir: dir,
          auditMd,
          staticPagePath: staticCandidate,
          round,
          roundFeedback: args.round_feedback || '',
        })
        await writeFile(join(dir, '.codegen-round'), String(round), 'utf8')
        const prevFound = await findFlow(outDir)
        const prevFlow = prevFound?.flow
        await writeFlow(outDir, { stage: 'skeleton_generated', nodeId, fileKey })
        const unconfirmed = !prevFlow?.confirmed
        return [
          `✅ 已生成 React 几何骨架 第 ${round} 轮（设计 ${fileKey} · 节点 ${nodeId}）`,
          unconfirmed
            ? '⚠️ **基准页尚未记录人工确认**（flow.json confirmed=false）：本次产物只是骨架，'
              + '请在交付前让用户确认基准页并调用 figma_confirm_static；未确认不得声称"已按 UI 完成"。'
            : `✅ 基准页已由 ${prevFlow?.confirmedBy} 于 ${prevFlow?.confirmedAt} 确认。`,
          `- 组件：${componentName}（${model.width}×${model.height}，${model.texts.length} 段文本）`,
          `- 令牌：${Object.keys(model.tokens.colors).length} 色 / ${Object.keys(model.tokens.fonts).length} 字体`,
          `- 审计：${summarizeAudit(audit)}`,
          `- 输出：${dir}`,
          '',
          '生成文件：',
          ...files.map((f) => `  - ${f}`),
          '',
          `下一步：按 CODEGEN_PROMPT.md 把占位换成**项目既有组件**、绝对定位收敛成 flex、色值映射主题令牌，`,
          `然后渲染组件截图，与 ${args.static_page || join(outDir, 'static', 'index.html')} 基准页对照；`,
          `**涉及 UI 就必须过一轮 UI 专家审计**（否则 figma_codegen_round 会拒绝收尾）：`,
          `  summon_expert("UI 视觉验收设计师", 任务) → figma_review_to_round(output_dir="${outDir}", review=..., reviewer="UI 视觉验收设计师")`,
          `  → 逐条改 → action="close" 关闭 → 再 figma_codegen_round。`,
        ].join('\n')
      },
    })))

    // ── 工具 3：多轮迭代 ──
    disposers.push(ctx.tools.register(defineTool({
      name: 'figma_codegen_round',
      description: '【流程硬约束】收尾迭代：若 flow.json 里 confirmed 不为 true、或还有未关闭的专家整改项，本工具会拒绝（需先 figma_confirm_static，或用 force=true 显式越过）。多轮代码生成迭代：在已有输出目录上追加下一轮指令（基于上一轮 review/截图差异），更新 CODEGEN_PROMPT.md 与 round 记录',
      parameters: {
        output_dir: { type: 'string', description: '已有输出目录（figma_gen_component 的 output_dir）' },
        round_feedback: { type: 'string', description: '本轮 review/差异/截图对照结论（必填）' },
        requirements: { type: 'string', description: '需求（可省略）' },
        conventions: { type: 'string', description: '项目约定（可省略）' },
        force: { type: 'boolean', description: 'true = 跳过"基准页已人工确认"的检查（默认拒绝）' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [textBlock(String(value))],
      },
      async execute(args: { output_dir: string; round_feedback: string; requirements?: string; conventions?: string; force?: boolean }) {
        const dir = resolve(args.output_dir)
        // 【硬门禁】收尾迭代要求基准页已经人工确认过：迭代是"声称做完"的前一步，
        // 没人确认过基准就迭代，等于对着未确认的目标收敛。
        const found = await findFlow(dir)
        if (!args.force && found) {
          // 【主流程】涉及 UI 的交付必须走过一轮 UI 专家审计
          if (found.flow.expertReviewRequired !== false && !hasExpertReview(found.flow.reviews)) {
            throw new Error([
              '拒绝收尾：这个流程要求涉及 UI 的交付先经过一轮 **UI 专家审计**，但 flow.json 里还没有任何评审记录。',
              '',
              '照下面做（主 agent 负责叫专家；专家看不到你的上下文，**必须把路径原样抄进任务书**）：',
              '  1) summon_expert("UI 视觉验收设计师", 任务) —— 任务里带：',
              `     设计基准图 ${join(found.dir, 'static', 'index@2x.png')}（用 read_image 读图）`,
              `     设计规格 ${join(found.dir, 'static', 'SPEC.md')}`,
              '     组件实现截图（同尺寸/缩放）',
              '     "逐条给出 问题/位置/期望/实际/级别(blocker|major|minor)"',
              `  2) figma_review_to_round(output_dir="${found.dir}", review=<专家原文>, reviewer="UI 视觉验收设计师")`,
              '  3) 按条目改 → action="close" 逐条关闭',
              '',
              '专家默认在 Agency 设置里关闭；确实没有专家可用时，可传 force=true 显式越过（会留痕在 flow.json 里）。',
            ].join('\n'))
          }
          const rounds = found.flow.reviews ?? []
          const last = rounds[rounds.length - 1]
          if (last && last.verdict === 'reject') {
            throw new Error([
              `拒绝收尾：第 ${last.round} 轮 UI 专家审计的判定是 **reject（打回）**。`,
              'blocker/major 修复并逐条关闭后，必须**再提审一轮**拿到 pass（复审），才允许收尾 —— 开发自述"改完了"不算通过。',
              `复审：summon_expert("UI 视觉验收设计师", 带新的组件截图 + 基准图) → figma_review_to_round(...)`,
              '确实要越过请显式传 force=true。',
            ].join('\n'))
          }
          const open = openItems(found.flow.reviews)
          if (open.length) {
            const sev = openByeSeverity(found.flow.reviews)
            throw new Error([
              `拒绝收尾：还有 ${open.length} 条专家整改项未关闭（阻断 ${sev.blocker} / 主要 ${sev.major} / 次要 ${sev.minor}）。`,
              `用 figma_review_to_round(output_dir="${found.dir}", action="list") 看清单，`,
              `改完逐条关闭：action="close", close="${open.slice(0, 3).map((i) => i.id).join(',')}"。`,
              '确实要越过请显式传 force=true。',
            ].join('\n'))
          }
        }
        if (!args.force && found && !found.flow.confirmed) {
          throw new Error([
            `拒绝迭代：${join(found.dir, 'flow.json')} 里 confirmed=false（基准页还没有人工确认）。`,
            `请先让用户确认 ${found.flow.staticPage ?? 'static/index.html'}，再调用 figma_confirm_static(output_dir="${found.dir}")；`,
            '确实要越过请显式传 force=true。',
          ].join('\n'))
        }
        const promptPath = join(dir, 'CODEGEN_PROMPT.md')
        if (!existsSync(promptPath)) throw new Error(`找不到 ${promptPath}，先运行 figma_gen_component`)
        const roundPath = join(dir, '.codegen-round')
        let round = 1
        try { round = Number(await readFile(roundPath, 'utf8')) || 1 } catch { /* ignore */ }
        round += 1

        const prompt = await readFile(promptPath, 'utf8')
        const append = [
          '',
          `## 第 ${round} 轮迭代（由 figma_codegen_round 生成）`,
          '',
          '### 本轮反馈 / 差异 / 截图对照',
          args.round_feedback,
          '',
          '### 本轮必做',
          '1. 先判断差异属于哪一类：**设计数据没读对** / **实现写法不对** / **主题令牌映射错** / **就是设计没画清**；',
          '2. 只改差异点，不重构无关代码；',
          '3. 逐边描边、逐角圆角、控件高度、字体大小这几类**用 computed style 实测**核对，别肉眼判断；',
          '4. 涉及项目既有模式的，先 grep 现成实现再动手；',
          '5. 完成后更新 audit.md 对应 checkbox 并说明"改在哪个文件哪一行"。',
        ].join('\n')
        await writeFile(promptPath, `${prompt}\n${append}`, 'utf8')
        await writeFile(roundPath, String(round), 'utf8')

        return [
          `🔄 已追加第 ${round} 轮迭代指令（${dir}）`,
          '',
          '流程：按更新后的 CODEGEN_PROMPT.md 改 → 组件渲染截图 ↔ 静态基准页对照 → 差异清零后结束。',
        ].join('\n')
      },
    })))
    return disposers
  }, '@deepseek-ai/dsh-tool-design-to-code')
}
