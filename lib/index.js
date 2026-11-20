import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildDesignModel } from './design.js';
import { generateCode, summarizeAudit } from './codegen.js';
import { auditModel, auditToMarkdown } from './audit.js';
import { renderStatic } from './render-static.js';
import { detectProjectConventions, detectRepeats, detectSections, renderComponentPlan, reuseHints, } from './componentize.js';
import { findCodeHits, keywordsOf, renderChangeMarkdown } from './diff.js';
import { expertImageBrief, exportStaticPagePng, pngPathsFor, pngSummary, renderHtmlToPng } from './screenshot.js';
import { buildAnnotatedHtml, legendHeightFor, renderRejectionMarkdown, verdictOf } from './annotate.js';
import { isSuppressible, matchKnownDiff, normalizeBaselineSeverity, openItems, parseReview, renderReviewRound, summarizeRounds, } from './review.js';
import { visualDiff } from './visual-diff.js';
import { GATE_VERSION } from './flow.js';
import { evaluateCloseGate } from './gate.js';
import { prepareIconifyAssets } from './icons.js';
export const name = '@deepseek-ai/dsh-tool-design-to-code';
export const inject = ['tools'];
export const Config = z.object({
    wsCaptureDir: z.string().default(''),
    outputDir: z.string().default(''),
});
function textBlock(text) {
    return { type: 'text', text };
}
function parseNodeUrl(url) {
    const m = url.match(/figma\.com\/(?:design|file|proto)\/([^/?]+)/);
    const n = url.match(/node-id=([^&]+)/);
    if (!m)
        throw new Error(`无法从 URL 解析 file key：${url}`);
    const fileKey = m[1];
    const nodeId = n ? decodeURIComponent(n[1]).replace(/-(\d+)$/, ':$1') : '';
    if (!/^\d+:\d+$/.test(nodeId))
        throw new Error(`URL 缺少合法的 node-id（应为数字-数字）：${url}；也可直接传 file_key + node_id`);
    return { fileKey, nodeId };
}
function resolveTarget(url, fileKey, nodeId) {
    if (url)
        return parseNodeUrl(url);
    if (fileKey && nodeId)
        return { fileKey, nodeId };
    throw new Error('需要 url，或 file_key + node_id');
}
/** 从捕获目录找最新数据帧（manifest 优先，<1KB 时回退到最大帧）。 */
async function findDataFrame(dir, fileKey) {
    const manifestPath = join(dir, 'last_capture.json');
    if (existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            const capturedKey = /figma\.com\/(?:design|file|proto)\/([^/?&#]+)/.exec(String(manifest.url ?? ''))?.[1];
            if (capturedKey && capturedKey !== fileKey) {
                throw new Error(`当前捕获属于另一个 Figma 文件（${capturedKey}），不能用于 ${fileKey}。请先打开目标链接让浏览器扩展写入新的 last_capture.json；不要拿旧画板猜实现。`);
            }
            if (manifest.dataFile && Number(manifest.dataSize ?? 0) >= 1024) {
                const p = join(dir, manifest.dataFile);
                if (existsSync(p))
                    return { dataPath: p, schemaPath: manifest.schemaFile ? join(dir, manifest.schemaFile) : null, manifest };
            }
        }
        catch {
            // ignore
        }
    }
    const files = (await readdir(dir)).filter((f) => /^frame_0001_recv_\d+b\.bin$/.test(f));
    if (!files.length)
        throw new Error(`目录 ${dir} 没有数据帧（先装扩展并打开 Figma 页面，或传 design_json）`);
    const stats = await Promise.all(files.map(async (f) => ({ f, m: (await stat(join(dir, f))).mtimeMs })));
    stats.sort((a, b) => b.m - a.m);
    return { dataPath: join(dir, stats[0].f), schemaPath: null, manifest: null };
}
async function readFlow(outDir) {
    const p = join(outDir, 'flow.json');
    if (!existsSync(p))
        return null;
    try {
        return JSON.parse(await readFile(p, 'utf8'));
    }
    catch {
        return null;
    }
}
/**
 * 找 flow.json：调用方给的可能不是同一层目录
 * （figma_gen_component 收 outDir，figma_codegen_round 收 outDir/gen），
 * 所以往上找两层。找不到就返回 null（旧产物没有状态文件，不能因此崩）。
 */
async function findFlow(dir) {
    for (const cand of [dir, resolve(dir, '..'), resolve(dir, '..', '..')]) {
        const f = await readFlow(cand);
        if (f)
            return { flow: f, dir: cand };
    }
    return null;
}
async function writeFlow(outDir, patch) {
    await mkdir(outDir, { recursive: true });
    const prev = await readFlow(outDir);
    const next = { ...(prev ?? {}), ...patch, updatedAt: new Date().toISOString() };
    await writeFile(join(outDir, 'flow.json'), JSON.stringify(next, null, 2), 'utf8');
    return next;
}
/**
 * 从静态基准页旁边的 spec.json 里读逐节点坐标，
 * 让审计清单里写的"132:8240"能落到基准图上的框（= 标出有问题的地方）。
 */
function makeBoxResolver(staticDir) {
    const p = join(staticDir, 'spec.json');
    if (!existsSync(p))
        return null;
    try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        const byId = new Map(j.rows.map((r) => [r.id, r]));
        return {
            width: j.width,
            height: j.height,
            resolve: (nodeId) => {
                const r = byId.get(nodeId);
                return r ? [r.x, r.y, r.w, r.h] : null;
            },
        };
    }
    catch {
        return null;
    }
}
/** 轮次游标（.codegen-round）：figma_codegen_round 与 figma_review_to_round 共用 */
/** 轮次游标：没有记录时是**第 0 轮**（下一次 +1 = 第 1 轮）；不要默认成 1，否则第一轮会被叫成"第 2 轮" */
async function readRound(dir) {
    try {
        return Number(await readFile(join(dir, '.codegen-round'), 'utf8')) || 0;
    }
    catch {
        return 0;
    }
}
/**
 * 找"生成目录"（含 CODEGEN_PROMPT.md 的那层）。
 * 只在**本次输出目录内部**找（dir 或 dir/gen）——不要向上找：
 * 实测向上找两层会命中隔壁另一个旧的 gen/ 目录，把评审记录写进无关目录（真跑时踩到）。
 */
async function findGenDir(dir) {
    for (const cand of [dir, join(dir, 'gen')]) {
        if (existsSync(join(cand, 'CODEGEN_PROMPT.md')))
            return cand;
    }
    return null;
}
function parseItemsJson(raw) {
    if (!raw)
        return null;
    try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr))
            return null;
        return arr.map((it, i) => {
            const sevOk = ['blocker', 'major', 'minor', 'info'].includes(String(it.severity));
            return {
                id: String(it.id ?? `R${i + 1}`),
                severity: (sevOk ? String(it.severity) : 'info'),
                // 缺级别必须标 default：baseline 的 fail-closed 提升与 known-diffs 抑制都靠它
                severitySource: (sevOk ? 'column' : 'default'),
                text: String(it.text ?? it.issue ?? it.description ?? '').slice(0, 400),
                location: it.location ? String(it.location) : undefined,
                expected: it.expected ? String(it.expected) : undefined,
                actual: it.actual ? String(it.actual) : undefined,
                nodeId: it.node_id ? String(it.node_id) : (it.nodeId ? String(it.nodeId) : undefined),
                box: Array.isArray(it.box) && it.box.length === 4 ? it.box.map(Number) : undefined,
            };
        }).filter((it) => it.text);
    }
    catch {
        return null;
    }
}
const NODE_PARAMS = {
    url: { type: 'string', description: 'Figma 设计稿 URL（含 node-id）' },
    file_key: { type: 'string', description: 'Figma file key（传 url 时可不填）' },
    node_id: { type: 'string', description: '节点 ID，如 8049:4704（传 url 时可不填）；**同一文件里同名画板多代共存，必须给准 node-id**' },
    design_json: { type: 'string', description: '已解码节点 JSON 路径（dsh-figma-reader 产物）；缺省读 ~/Downloads/figma_ws 帧自动解码' },
    output_dir: { type: 'string', description: '输出目录，默认 ~/Desktop/design-to-code/<nodeId>' },
    ws_capture_dir: { type: 'string', description: '捕获目录，默认 ~/Downloads/figma_ws' },
};
/** 统一取节点 JSON（design_json 优先，否则 WS 扩展帧自动解码，零 REST）。 */
async function loadNodeJson(args, config) {
    const { fileKey, nodeId } = resolveTarget(args.url, args.file_key, args.node_id);
    const captureDir = resolve(args.ws_capture_dir || config.wsCaptureDir || join(homedir(), 'Downloads', 'figma_ws'));
    const outDir = resolve(args.output_dir || config.outputDir || join(homedir(), 'Desktop', 'design-to-code', nodeId.replace(':', '-')));
    let nodeJson;
    if (args.design_json) {
        nodeJson = JSON.parse(await readFile(resolve(args.design_json), 'utf8'));
    }
    else {
        const tmp = join(outDir, '.decode');
        await mkdir(tmp, { recursive: true });
        const { dataPath } = await findDataFrame(captureDir, fileKey);
        const { decodeFrameAndBuildReport } = await import('@deepseek-ai/dsh-tool-figma-reader/lib/kiwi.js');
        let dec;
        try {
            dec = decodeFrameAndBuildReport(dataPath, fileKey, nodeId, tmp);
        }
        catch (error) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}\n设计数据未读取成功，已停止生成（不会把读不到的节点猜成设计）。请刷新目标 Figma 页面并选中该节点后重试。`);
        }
        nodeJson = JSON.parse(await readFile(dec.jsonPath, 'utf8'));
    }
    return { nodeJson, fileKey, nodeId, outDir, captureDir };
}
export function apply(ctx, config) {
    ctx.effect(() => {
        const disposers = [];
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
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config);
                const model = buildDesignModel(nodeJson);
                const staticDir = join(outDir, 'static');
                const icons = await prepareIconifyAssets(model, staticDir);
                const r = renderStatic(model, { outputDir: staticDir, title: args.title, projectName: args.project, iconAssets: icons.assets });
                // 设计基准图：给人和 UI 专家子 agent 直接看图审计（不依赖 Figma 出图权限）
                let pngLines = ['- （已关闭 png 导出）'];
                let pngPaths = [];
                let brief = '';
                if (args.png !== false) {
                    const paths = pngPathsFor(r.htmlPath);
                    const results = await exportStaticPagePng({
                        htmlPath: r.htmlPath,
                        outPath: paths.twoX,
                        width: model.width,
                        height: model.height,
                        scale: Math.max(1, Number(args.png_scale ?? 2)),
                        chromeBin: args.chrome_bin,
                    }, true);
                    pngLines = pngSummary(results).split('\n');
                    pngPaths = results.filter((x) => x.ok && x.path).map((x) => x.path);
                    if (pngPaths.length)
                        brief = expertImageBrief(pngPaths, r.htmlPath, r.specPath);
                }
                const prevFlow = await readFlow(outDir);
                const flow = await writeFlow(outDir, {
                    stage: 'static_rendered', nodeId, fileKey,
                    staticPage: r.htmlPath, specPath: r.specPath, confirmed: false,
                    confirmedBy: undefined, confirmedAt: undefined, confirmNote: undefined, confirmedVia: undefined,
                    baselineRenderer: 2,
                    // 基准页重渲染 = 基准变了：旧评审与旧 known-diffs 一律失效，
                    // 否则"改了稿还沿用旧评审"会直接绕过确认门禁（真实踩过）。
                    reviews: [],
                    knownDiffs: [],
                    baselineVersion: (prevFlow?.baselineVersion ?? 0) + 1,
                    gateVersion: GATE_VERSION,
                    coverage: {
                        nodes: model.coverage.nodes,
                        placeholderRatio: model.coverage.placeholderRatio,
                        counts: model.coverage.counts,
                        summary: model.coverage.summary,
                    },
                });
                void flow;
                return [
                    `🖼️ 已生成静态还原页（设计 ${fileKey} · 节点 ${nodeId}）`,
                    `- 画布 ${model.width}×${model.height} · 渲染节点 ${r.stats.nodes} · 实例重建 ${r.stats.instances} · CSS 规则 ${r.stats.rules}`,
                    `- 页面（按 auto-layout 出 flex）：${r.htmlPath}`,
                    `- 绝对定位对照页（归因用）：${r.absHtmlPath}`,
                    r.specPath ? `- 规格/映射表：${r.specPath}` : '',
                    `- 属性来源台账：${r.coveragePath}（${model.coverage.summary}）`,
                    `- 图标库资产：${Object.keys(icons.assets).length} 个已映射到原始 SVG（不自绘）· 台账 ${join(staticDir, 'icons.json')}${icons.failures.length ? `；${icons.failures.length} 个未获取，保留占位` : ''}`,
                    ...icons.failures.map((failure) => `  ⚠️ ${failure}`),
                    `- 布局推演：容器 ${r.stats.flexContainers} 个，与设计坐标不一致的子项 ${r.stats.flexMismatches} 条 → ${r.layoutReportPath}`,
                    r.stats.borderFallbacks
                        ? `  ⚠️ ${r.stats.borderFallbacks} 个节点（非均匀虚线）回落到真 CSS border：这些容器的流内子项会偏 1–2px，已标 data-src="border-fallback" 并记进 coverage.json`
                        : '',
                    r.stats.flexMismatches ? '  ⚠️ 有 mismatch：说明"按 auto-layout 推出来的 flex"无法完全复现设计坐标，先核对 SPEC 的 layout 列，别把它当实现问题。' : '',
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
                ].filter(Boolean).join('\n');
            },
        })));
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
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config);
                const newModel = buildDesignModel(nodeJson);
                let oldModel = null;
                if (args.old_design_json) {
                    oldModel = buildDesignModel(JSON.parse(await readFile(resolve(args.old_design_json), 'utf8')));
                }
                else if (args.old_node_id) {
                    try {
                        const old = await loadNodeJson({ file_key: fileKey, node_id: args.old_node_id, ws_capture_dir: args.ws_capture_dir, output_dir: join(outDir, '.old') }, config);
                        oldModel = buildDesignModel(old.nodeJson);
                    }
                    catch (e) {
                        oldModel = null;
                    }
                }
                // 新稿的视觉基准页 + 规格/映射表
                const staticDir = join(outDir, 'static');
                const icons = await prepareIconifyAssets(newModel, staticDir);
                const st = renderStatic(newModel, { outputDir: staticDir, projectName: args.project, iconAssets: icons.assets });
                const keywords = keywordsOf(newModel);
                const extra = (args.extra_keywords || '').split(',').map((s) => s.trim()).filter(Boolean);
                const codeHits = args.code_dir
                    ? findCodeHits(resolve(args.code_dir), keywords, { extra })
                    : undefined;
                const md = renderChangeMarkdown({
                    newModel, oldModel, project: args.project,
                    codeDir: args.code_dir ? resolve(args.code_dir) : undefined,
                    codeHits, keywords, staticPagePath: st.htmlPath, specPath: st.specPath,
                });
                await mkdir(outDir, { recursive: true });
                const changePath = join(outDir, 'CHANGE.md');
                await writeFile(changePath, md, 'utf8');
                await writeFlow(outDir, {
                    stage: 'change_brief_ready', nodeId, fileKey,
                    staticPage: st.htmlPath, specPath: st.specPath, confirmed: false,
                    confirmedBy: undefined, confirmedAt: undefined, confirmNote: undefined,
                });
                const changed = md.match(/\*\*改动 (\d+) · 新增 (\d+) · 删除 (\d+)\*\*/);
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
                ].filter(Boolean).join('\n');
            },
        })));
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
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const dir = resolve(args.output_dir);
                const prev = await readFlow(dir);
                if (!prev)
                    throw new Error(`找不到 ${join(dir, 'flow.json')}：先跑 figma_render_static（或 figma_change_brief）`);
                if (args.reset) {
                    const next = await writeFlow(dir, { stage: prev.stage, nodeId: prev.nodeId, fileKey: prev.fileKey, confirmed: false, confirmedBy: undefined, confirmedAt: undefined, confirmNote: undefined, knownDiffs: [] });
                    return `♻️ 已撤销基准页确认（${dir}）\n- 当前 confirmed=${next.confirmed}；改完设计稿请重新渲染并再次确认。`;
                }
                if (prev.baselineRenderer !== 2) {
                    throw new Error([
                        `拒绝确认：${join(dir, 'flow.json')} 不是当前渲染器产出的基准页（baselineRenderer=${prev.baselineRenderer ?? '缺失'}）。`,
                        '旧渲染器产出的页面不能靠一次确认解封成权威基准（它可能缺 abs.html / coverage / flex 布局）。',
                        `请重新跑 figma_render_static(output_dir="${dir}")，再看页面确认。`,
                    ].join('\n'));
                }
                const note = [args.note, args.diffs ? `已知差异：${args.diffs}` : ''].filter(Boolean).join(' | ');
                // known-diffs：把"已接受的差异"变成结构化条目 → 后续评审命中即标 accepted（不再重复提出）
                const nowIso = new Date().toISOString();
                const knownDiffs = String(args.diffs ?? '')
                    .split(/[,，;；、]/)
                    .map((x) => x.trim())
                    .filter(Boolean)
                    .map((x) => {
                    const m = /^(\d{1,6}:\d{1,6})\s*(.*)$/.exec(x);
                    return m ? { nodeId: m[1], property: m[2] || undefined, note: x, at: nowIso } : { property: x, note: x, at: nowIso };
                });
                const via = args.via === 'expert_review' ? 'expert_review' : 'human';
                // 人工确认基准 = 接受基准当前形态：把 open 的 baseline 条目一并标 accepted，
                // 否则"确认了但 baselineDebt 未清"会让 figma_gen_component 永久拒绝（死锁）
                const reviews = (prev.reviews ?? []).map((r) => {
                    if ((r.scope ?? 'implementation') !== 'baseline')
                        return r;
                    return {
                        ...r,
                        items: r.items.map((it) => (it.status === 'open'
                            ? { ...it, status: 'accepted', closedBy: args.by || 'user', closedAt: new Date().toISOString(), closedNote: '随基准确认一并接受' }
                            : it)),
                    };
                });
                const next = await writeFlow(dir, {
                    stage: prev.stage, nodeId: prev.nodeId, fileKey: prev.fileKey,
                    gateVersion: GATE_VERSION,
                    reviews,
                    confirmed: true,
                    confirmedVia: via,
                    confirmedBy: args.by || (via === 'expert_review' ? 'expert' : 'user'),
                    confirmedAt: nowIso,
                    confirmNote: note || undefined,
                    knownDiffs,
                });
                return [
                    `✅ 已记录基准页人工确认（设计 ${next.fileKey} · 节点 ${next.nodeId}）`,
                    `- 确认来源：${next.confirmedVia ?? 'human'} · 确认人：${next.confirmedBy} · 时间：${next.confirmedAt}`,
                    next.confirmNote ? `- 备注：${next.confirmNote}` : '',
                    knownDiffs.length ? `- 已登记已知差异 ${knownDiffs.length} 条（后续评审命中即标 accepted，不再重复提出）：${knownDiffs.map((k) => k.note).join('；')}` : '',
                    knownDiffs.length ? '  ⚠️ 只登记"确认要接受的差异"；能修的不要登记成 known-diff，否则等于把它变成永久豁免。' : '',
                    `- 基准页：${next.staticPage ?? ''}`,
                    `- 状态文件：${join(dir, 'flow.json')}`,
                    '',
                    '接下来：figma_audit_node → figma_gen_component（骨架）→ 按 CODEGEN_PROMPT 用项目组件实现 → 组件截图 ↔ 基准页对照 → figma_codegen_round。',
                ].filter(Boolean).join('\n');
            },
        })));
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
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const start = resolve(args.output_dir);
                const action = args.action || 'add';
                const found = await findFlow(start);
                const genDir = await findGenDir(start);
                const flowDir = found?.dir ?? (genDir ? resolve(genDir, '..') : start);
                // ── list ──
                if (action === 'list') {
                    if (!found?.flow.reviews?.length)
                        return `（${flowDir}/flow.json 里还没有专家评审记录）`;
                    const L = [`📋 专家评审状态（${flowDir}）：${summarizeRounds(found.flow.reviews)}`, ''];
                    L.push('| id | 轮次 | 级别 | 状态 | 问题 | 位置 |');
                    L.push('|---|---|---|---|---|---|');
                    for (const r of found.flow.reviews) {
                        for (const it of r.items) {
                            const st = it.status === 'open' ? '🔴 open' : it.status === 'accepted' ? '🟡 accepted（已知差异）' : '✅ closed';
                            L.push(`| ${it.id} | ${r.round} | ${it.severity} | ${st} | ${it.text.replace(/\|/g, '\\|').slice(0, 120)} | ${it.location ?? ''} |`);
                        }
                    }
                    const open = openItems(found.flow.reviews);
                    L.push('');
                    L.push(open.length ? `⚠️ 还有 ${open.length} 条未关闭：${open.map((i) => i.id).join(', ')}` : '✅ 全部已关闭');
                    return L.join('\n');
                }
                // ── close ──
                if (action === 'close') {
                    if (!found?.flow.reviews?.length)
                        throw new Error('还没有专家评审记录，先 action=add');
                    const wanted = String(args.close || '').trim();
                    const all = found.flow.reviews.flatMap((r) => r.items);
                    const ids = wanted === 'all' ? all.filter((i) => i.status === 'open').map((i) => i.id)
                        : wanted.split(',').map((x) => x.trim()).filter(Boolean);
                    if (!ids.length)
                        throw new Error('close 需要指定条目 id（逗号分隔）或 all');
                    const unknown = ids.filter((id) => !all.some((i) => i.id === id));
                    if (unknown.length)
                        throw new Error(`找不到条目：${unknown.join(', ')}（可用 action=list 查看）`);
                    // 关闭 blocker/major 必须有"改在哪 + 实测值"：否则"关闭"这道闸门可以由被审方自己解除
                    const closing = all.filter((i) => ids.includes(i.id) && i.status === 'open');
                    const serious = closing.filter((i) => i.severity === 'blocker' || i.severity === 'major');
                    const noteText = String(args.note ?? '').trim();
                    const noteOk = /[:：]\d+/.test(noteText) || noteText.length >= 12;
                    if (serious.length && !noteOk) {
                        throw new Error([
                            `拒绝关闭：${serious.map((i) => i.id).join(', ')} 是 blocker/major，close 时必须带 note（形如「文件:行 + 实测值」，长度≥12）。`,
                            'note 要写清"改在哪个文件哪一行 + 实测值"，例如：',
                            '  note="改在 src/Foo.tsx:88，实测 border-width=0 0 0 1px / border-radius=8px 0 0 8px"',
                        ].join('\n'));
                    }
                    const now = new Date().toISOString();
                    for (const r of found.flow.reviews) {
                        for (const it of r.items) {
                            if (ids.includes(it.id) && it.status === 'open') {
                                it.status = 'closed';
                                it.closedBy = args.closed_by || 'agent';
                                it.closedAt = now;
                                it.closedNote = args.note || undefined;
                            }
                        }
                    }
                    await writeFlow(flowDir, { ...found.flow, reviews: found.flow.reviews });
                    const rest = openItems(found.flow.reviews);
                    return [
                        `✅ 已关闭 ${ids.length} 条（${ids.join(', ')}）`,
                        rest.length ? `⚠️ 仍有 ${rest.length} 条未关闭：${rest.map((i) => i.id).join(', ')}` : '✅ 全部整改项已关闭',
                    ].join('\n');
                }
                // ── add ──
                // 基准审计（scope=baseline）发生在 figma_gen_component **之前**，那时还没有 CODEGEN_PROMPT.md，
                // 所以不能一律要求 gen 目录存在：基准审计只写评审记录 + 标注图，不往 Prompt 里注入。
                const scopeArg = args.scope === 'baseline' ? 'baseline' : 'implementation';
                // 评审记录目录：有 gen 就放 gen/review，否则放 outDir/review —— md 直接落在这个目录里
                const recordDir = genDir ? join(genDir, 'review') : join(flowDir, 'review');
                if (!genDir && scopeArg !== 'baseline') {
                    throw new Error(`找不到 CODEGEN_PROMPT.md（在 ${start} 及其 gen/ 下都没有）：先跑 figma_gen_component`);
                }
                const explicit = parseItemsJson(args.items);
                const staticDir = join(flowDir, 'static');
                const resolver = makeBoxResolver(staticDir);
                const items = explicit ?? parseReview(String(args.review ?? ''), {
                    resolveBox: resolver ? resolver.resolve : undefined,
                });
                // baseline：无级别条目按 major（fail-closed），必须在抑制/落盘/判定之前
                normalizeBaselineSeverity(items, scopeArg);
                // 显式给了 node_id 但没给 box 的，也补上坐标
                for (const it of items) {
                    if (!it.box && it.nodeId && resolver)
                        it.box = resolver.resolve(it.nodeId);
                }
                // 允许"干净的一轮"：解析出 0 条时落一条 emptyRound 记录（否则"专家认为没问题"既无法登记、又满足不了门禁）
                const emptyRound = items.length === 0;
                if (emptyRound && !String(args.review ?? '').trim()) {
                    throw new Error('没能从 review 里解析出任何条目，且没有原文可判断：请把清单写成列表/表格，或用 items 传结构化 JSON。');
                }
                const round = (await readRound(recordDir)) + 1;
                const at = new Date().toISOString();
                const reviewer = args.reviewer || 'expert';
                // 条目 id 必须**跨轮唯一**：否则第 2 轮的 R1 与第 4 轮的 R1 会互相误关。
                // 统一改成 `<轮次>.<序号>`，并在输出里回显让调用方照抄。
                for (let i = 0; i < items.length; i++)
                    items[i] = { ...items[i], id: `${round}.${i + 1}` };
                // known-diffs 抑制：命中"已确认接受的差异"的条目不进 Prompt、不参与判定，只记录为 accepted
                // known-diffs 抑制的三条硬约束（否则它能把整轮评审吞掉、让 confirmed 再次恒真）：
                //   ① blocker 永不抑制；② known-diff 只能压 minor/info；③ 压制后至少留一条有效条目。
                const knownDiffs = found?.flow.knownDiffs ?? [];
                const suppressible = items.filter((it) => isSuppressible(it));
                const suppressed = new Map();
                for (const it of suppressible) {
                    const k = matchKnownDiff(it, knownDiffs);
                    if (k)
                        suppressed.set(it.id, k);
                }
                const effective = items.filter((it) => !suppressed.has(it.id));
                const block = renderReviewRound(effective, { round, reviewer, at, source: args.source, extra: args.review });
                if (genDir) {
                    const promptPath = join(genDir, 'CODEGEN_PROMPT.md');
                    await writeFile(promptPath, `${await readFile(promptPath, 'utf8')}\n${block}`, 'utf8');
                }
                await mkdir(recordDir, { recursive: true });
                await writeFile(join(recordDir, '.codegen-round'), String(round), 'utf8');
                const state = items.map((it) => ({
                    ...it,
                    status: suppressed.has(it.id) ? 'accepted' : 'open',
                    closedNote: suppressed.has(it.id) ? `命中 known-diff：${suppressed.get(it.id)?.note ?? ''}` : undefined,
                }));
                const scope = scopeArg;
                // 空轮（0 条）不能算 pass 以外的任何判定；有条目但全被 accepted 也不许判 pass
                const verdict = effective.length ? verdictOf(effective) : (emptyRound ? 'pass' : 'reject');
                // ── 标出有问题的地方：把问题按 id 钉在设计基准图上 ──
                let annotatedImage;
                if (resolver) {
                    const imgFile = 'index.png';
                    const annos = effective.map((it) => ({
                        id: it.id, severity: it.severity, text: it.text,
                        box: it.box ?? null, location: it.location,
                    }));
                    const legendH = legendHeightFor(annos.length);
                    const annHtml = buildAnnotatedHtml({
                        imageFile: imgFile, width: resolver.width, height: resolver.height,
                        annotations: annos, title: `第 ${round} 轮审计`, legendHeight: legendH,
                    });
                    const annHtmlPath = join(staticDir, `annotated-round-${round}.html`);
                    await writeFile(annHtmlPath, annHtml, 'utf8');
                    const png = await renderHtmlToPng({
                        htmlPath: annHtmlPath,
                        outPath: join(staticDir, `annotated-round-${round}.png`),
                        width: resolver.width, height: resolver.height + legendH, scale: 2,
                    });
                    if (png.ok)
                        annotatedImage = png.path;
                }
                const reviews = [...(found?.flow.reviews ?? []), { round, reviewer, at, source: args.source, scope, verdict, annotatedImage, items: state, emptyRound }];
                // 门禁修正：只有「基准审计（scope=baseline）判定 pass」才算基准已确认。
                // 旧实现是 `confirmed: found?.flow.confirmed ? true : true`（恒真）——
                // 任何一次评审（含 implementation、含 reject）都会把基准标成"已确认"，门禁形同虚设。
                const confirmedNow = scope === 'baseline' && verdict === 'pass' && effective.length > 0;
                const flowPatch = {
                    stage: found?.flow.stage ?? 'skeleton_generated',
                    nodeId: found?.flow.nodeId ?? '',
                    fileKey: found?.flow.fileKey ?? '',
                    reviews,
                };
                if (confirmedNow) {
                    // 谁把的关必须留痕：confirmedVia=expert_review，confirmedBy=专家名
                    flowPatch.confirmed = true;
                    flowPatch.confirmedVia = 'expert_review';
                    flowPatch.confirmedBy = `expert:${reviewer}`;
                    flowPatch.confirmedAt = at;
                }
                await writeFlow(flowDir, flowPatch);
                // 落一份人可读的评审记录
                await mkdir(recordDir, { recursive: true });
                await writeFile(join(recordDir, `round-${round}.md`), [
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
                ].join('\n'), 'utf8');
                // ── 打回清单：开发照着改，改完必须复审拿 pass ──
                const rejectPath = join(recordDir, `round-${round}-${verdict === 'reject' ? 'REJECT' : 'PASS'}.md`);
                await writeFile(rejectPath, renderRejectionMarkdown({
                    round, reviewer, at, verdict,
                    items: items.map((it) => ({ id: it.id, severity: it.severity, text: it.text, box: it.box ?? null, location: it.location })),
                    annotatedImage,
                    staticPng: join(staticDir, 'index.png'),
                    rejected: verdict === 'reject',
                }), 'utf8');
                const open = openItems(reviews);
                return [
                    `${verdict === 'reject' ? '❌ 审计打回' : '✅ 审计通过'} · 第 ${round} 轮（${recordDir}）`,
                    `- 评审人：${reviewer} · 条目：${items.length}（阻断 ${items.filter((i) => i.severity === 'blocker').length} / 主要 ${items.filter((i) => i.severity === 'major').length} / 次要 ${items.filter((i) => i.severity === 'minor').length}）`,
                    genDir ? `- 已注入：${join(genDir, 'CODEGEN_PROMPT.md')}` : '- 基准审计：未注入 Prompt（发生在生成骨架之前，属预期）',
                    `- 评审记录：${join(recordDir, `round-${round}.md`)}`,
                    `- ${verdict === 'reject' ? '打回清单' : '通过记录'}：${rejectPath}`,
                    annotatedImage ? `- 标注图（问题已按 id 钉在基准图上）：${annotatedImage}` : '- 标注图：未生成（缺少 static/spec.json 或没有可解析的坐标）',
                    `- 审计对象：${scope} · 判定：${verdict} · 状态：${summarizeRounds(reviews)}`,
                    suppressed.size ? `- known-diffs 命中 ${suppressed.size} 条（已标 accepted，不再重复提出；blocker 不参与抑制）：${[...suppressed.keys()].join(', ')}` : '',
                    scope === 'baseline'
                        ? (confirmedNow
                            ? '✅ 基准审计 pass → flow.json 记为已确认（confirmedVia=expert_review），无需人工再确认基准页。'
                            : '❌ 基准审计未 pass → 基准仍为**未确认**（confirmed 保持 false）：按上面条目修基准页后，重新提审一轮拿 pass。')
                        : '✅ 已记录实现审计（不改动基准确认状态）；收尾门禁还要求：实现侧无未关闭项 + 至少一轮实现审计。',
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
                ].filter(Boolean).join('\n');
            },
        })));
        // ── 工具 1：设计审计 ──
        disposers.push(ctx.tools.register(defineTool({
            name: 'figma_audit_node',
            description: '【流程硬约束】任何 agent（主/专家/teammate）在按设计稿实现或修改 UI 前，必须先跑 figma_render_static 得到视觉基准页、并由用户确认（figma_confirm_static）。本工具是第 2 步。设计审计：输出逐节点规格（逐边描边/逐角圆角/字体/auto-layout）+ 实现前核对清单，并把"真歧义（要问设计）"与"数据缺失（按兜底规则做）"分开。歧义判据已修正（不再把 strokeWeight 默认值 1 当隐藏边框）',
            parameters: { ...NODE_PARAMS },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config);
                const model = buildDesignModel(nodeJson);
                const audit = auditModel(model);
                await mkdir(outDir, { recursive: true });
                const jsonPath = join(outDir, `figma_${fileKey}_${nodeId}.audit.json`);
                const mdPath = join(outDir, `figma_${fileKey}_${nodeId}.audit.md`);
                await writeFile(jsonPath, JSON.stringify(audit, null, 2), 'utf8');
                await writeFile(mdPath, auditToMarkdown(audit), 'utf8');
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
                ].join('\n');
            },
        })));
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
                code_dir: { type: 'string', description: '目标项目目录：用于探测项目组件约定（组件放哪、什么形态、样式后缀），新组件按项目实际落点生成' },
                max_extract: { type: 'number', description: '最多抽几个可复用组件（默认 3；从设计里的重复结构统计得出）' },
                skip_static_check: { type: 'boolean', description: 'true = 跳过"必须有视觉基准页"的硬门禁（只想要几何数据时用；会留痕）' },
                round: { type: 'number', description: '生成轮次（默认 1）' },
                round_feedback: { type: 'string', description: '上一轮反馈（round>1）' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config);
                // 【硬门禁】没有视觉基准页就不许生成骨架：这是"能不能按 UI 还原"的第一道保证，
                // 与 agent 是否自觉无关（主 agent / 专家子 agent / teammate 一律拦）。
                const staticCandidate = args.static_page || join(outDir, 'static', 'index.html');
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
                    ].join('\n'));
                }
                // 【基准债务门禁】基准审计里还有未关闭的 blocker/major 时不许生成骨架：
                // 两段式——先把基准修到 pass，再让实现去对齐它；否则实现永远在追一个错的基准。
                const baselineFound = await findFlow(outDir);
                const baselineDebt = openItems(baselineFound?.flow.reviews, 'baseline')
                    .filter((i) => i.severity === 'blocker' || i.severity === 'major');
                if (baselineDebt.length) {
                    throw new Error([
                        `拒绝生成：设计基准还有 ${baselineDebt.length} 条未关闭的 blocker/major（scope=baseline）。`,
                        `  ${baselineDebt.slice(0, 5).map((i) => `[${i.id}/${i.severity}] ${i.text.slice(0, 60)}`).join('\n  ')}`,
                        '',
                        '基准是先修的：按条目修基准页 → 重新渲染基准 → 再提审基准（scope="baseline"）拿 pass，',
                        '然后才做实现。用 figma_review_to_round(action="close", scope="baseline") 关闭已修条目。',
                        `查看：figma_review_to_round(output_dir="${outDir}", action="list")`,
                    ].join('\n'));
                }
                const model = buildDesignModel(nodeJson);
                const audit = auditModel(model);
                let auditMd = '';
                if (args.audit_path && existsSync(resolve(args.audit_path))) {
                    auditMd = await readFile(resolve(args.audit_path), 'utf8');
                }
                else {
                    auditMd = auditToMarkdown(audit);
                }
                const componentName = args.component_name || model.componentName;
                const round = Math.max(1, Number(args.round ?? 1));
                const dir = join(outDir, 'gen');
                // ── 组件化方案：复用清单 + 应抽的重复结构 + 顶层分区 + **按项目实际探测的落点** ──
                const repeats = detectRepeats(model);
                const sections = detectSections(model);
                const reuse = reuseHints(model);
                const conventions = args.code_dir ? detectProjectConventions(resolve(args.code_dir)) : undefined;
                const componentPlanMd = renderComponentPlan({ model, repeats, sections, reuse, conventions, componentName });
                await mkdir(dir, { recursive: true });
                const planPath = join(dir, 'component-plan.md');
                await writeFile(planPath, componentPlanMd, 'utf8');
                const files = generateCode(model, {
                    componentName,
                    requirements: args.requirements || '（未提供需求，按设计稿默认交互：表单输入 + 按钮动作 + 关闭）',
                    conventions: args.conventions || 'React 18 + TypeScript + CSS Modules，零运行时第三方依赖，组件/逻辑拆分，类型安全',
                    outputDir: dir,
                    auditMd,
                    staticPagePath: staticCandidate,
                    componentPlanMd,
                    projectLayout: conventions
                        ? { componentsRoot: conventions.componentsRoot, layout: conventions.layout, styleExt: conventions.styleExt, codeDir: conventions.codeDir }
                        : undefined,
                    maxExtract: args.max_extract,
                    round,
                    roundFeedback: args.round_feedback || '',
                });
                await writeFile(join(dir, '.codegen-round'), String(round), 'utf8');
                const prevFound = await findFlow(outDir);
                const prevFlow = prevFound?.flow;
                await writeFlow(outDir, { stage: 'skeleton_generated', nodeId, fileKey });
                const unconfirmed = !prevFlow?.confirmed;
                return [
                    `✅ 已生成 React 几何骨架 第 ${round} 轮（设计 ${fileKey} · 节点 ${nodeId}）`,
                    unconfirmed
                        ? '⚠️ **基准页尚未记录人工确认**（flow.json confirmed=false）：本次产物只是骨架，'
                            + '请在交付前让用户确认基准页并调用 figma_confirm_static；未确认不得声称"已按 UI 完成"。'
                        : `✅ 基准页已由 ${prevFlow?.confirmedBy} 于 ${prevFlow?.confirmedAt} 确认。`,
                    `- 组件：${componentName}（${model.width}×${model.height}，${model.texts.length} 段文本）`,
                    `- 令牌：${Object.keys(model.tokens.colors).length} 色 / ${Object.keys(model.tokens.fonts).length} 字体`,
                    `- 审计：${summarizeAudit(audit)}`,
                    `- 组件化：应抽可复用组件 ${repeats.filter((r) => r.count >= 3).length} 个`
                        + `（前 ${Math.min(3, Number(args.max_extract ?? 3))} 个已生成骨架文件）· 顶层分区 ${sections.length} 个`,
                    conventions
                        ? `- 项目约定探测：组件根 \`${conventions.componentsRoot ?? '未识别'}\` · 形态 ${conventions.layout} · 样式 ${conventions.styleExt ?? '未识别'}`
                        : '- ⚠️ 未传 code_dir：无法探测项目组件落点（新组件位置只能靠会话自己看项目）',
                    `- 组件化方案：${planPath}`,
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
                    '组件化要求（component-plan.md 已写进 Prompt）：**先复用项目既有组件 → 没有才新建可复用组件 → 页面只做组合**，',
                    '新组件的落点/命名/样式一律按上面探测到的项目约定，不要另起一套目录。',
                ].join('\n');
            },
        })));
        // ── 工具 3：多轮迭代 ──
        disposers.push(ctx.tools.register(defineTool({
            name: 'figma_codegen_round',
            description: '【流程硬约束】收尾迭代：若 flow.json 里 confirmed 不为 true、或还有未关闭的专家整改项，本工具会拒绝（需先 figma_confirm_static，或用 force=true 显式越过）。多轮代码生成迭代：在已有输出目录上追加下一轮指令（基于上一轮 review/截图差异），更新 CODEGEN_PROMPT.md 与 round 记录',
            parameters: {
                output_dir: { type: 'string', description: '已有输出目录（figma_gen_component 的 output_dir）' },
                round_feedback: { type: 'string', description: '本轮 review/差异/截图对照结论（必填）' },
                requirements: { type: 'string', description: '需求（可省略）' },
                conventions: { type: 'string', description: '项目约定（可省略）' },
                force: { type: 'boolean', description: 'true = 显式越过收尾门禁（必须同时给 force_reason；会写入 flow.json 留痕）' },
                force_reason: { type: 'string', description: 'force 的理由（必填，会写进 flow.json 并在输出里回显）' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const dir = resolve(args.output_dir);
                // 【硬门禁】收尾迭代要求基准页已经人工确认过：迭代是"声称做完"的前一步，
                // 没人确认过基准就迭代，等于对着未确认的目标收敛。
                const found = await findFlow(dir);
                // 门禁集中判定（gate.ts，可单测）。fail-closed：旧目录 / 缺 flow.json / 未确认 一律拒绝。
                const staticPageOk = !!found?.flow.staticPage && existsSync(found.flow.staticPage);
                const specOk = existsSync(join(found?.dir ?? dir, 'static', 'spec.json'));
                const gate = evaluateCloseGate({
                    flow: found?.flow ?? null,
                    gateVersion: GATE_VERSION,
                    force: args.force,
                    forceReason: args.force_reason,
                    artifacts: { staticPage: staticPageOk, spec: specOk },
                });
                if (!gate.ok) {
                    const reason = gate.reason ?? '门禁未通过';
                    if (reason.includes('实现审计')) {
                        throw new Error([
                            `拒绝收尾：${reason}`,
                            '',
                            '照下面做（主 agent 负责叫专家；专家看不到你的上下文，**必须把路径原样抄进任务书**）：',
                            '  1) summon_expert("UI 视觉验收设计师", 任务) —— 任务里带：',
                            `     设计基准图 ${join(found?.dir ?? dir, 'static', 'index@2x.png')}（用 read_image 读图）`,
                            `     设计规格 ${join(found?.dir ?? dir, 'static', 'SPEC.md')}`,
                            '     组件实现截图（同尺寸/缩放）',
                            '     "逐条给出 问题/位置/期望/实际/级别(blocker|major|minor)"',
                            '  2) 先跑机器对照（可选但推荐）：figma_visual_diff(output_dir=…, impl=<实现页路径>)',
                            '     → 得到的 items 可直接传给 figma_review_to_round（免自然语言解析）',
                            `  3) figma_review_to_round(output_dir="${found?.dir ?? dir}", review=<专家原文>, reviewer="UI 视觉验收设计师")`,
                            '  4) 按条目改 → action="close" 逐条关闭（blocker/major 必须带 note: 文件:行 + 实测值）',
                            '',
                            '若当前环境没有可用的 UI 专家（Agency 设置里未启用），可传 force=true 显式越过；会留痕，交付时须注明「未经专家审计」。',
                        ].join('\n'));
                    }
                    throw new Error(`拒绝收尾：${reason}\n确需越过请显式传 force=true 且给 force_reason（会写进 flow.json 留痕）。`);
                }
                if (gate.forced) {
                    // force 不是"无痕放行"：写进 flow.json，并在这里回显，交付说明必须带上
                    if (found) {
                        await writeFlow(found.dir, {
                            stage: found.flow.stage, nodeId: found.flow.nodeId, fileKey: found.flow.fileKey,
                            forcedAt: new Date().toISOString(), forcedBy: 'agent', forceReason: String(args.force_reason ?? '').trim(),
                        });
                    }
                }
                const promptPath = join(dir, 'CODEGEN_PROMPT.md');
                if (!existsSync(promptPath))
                    throw new Error(`找不到 ${promptPath}，先运行 figma_gen_component`);
                const roundPath = join(dir, '.codegen-round');
                let round = 1;
                try {
                    round = Number(await readFile(roundPath, 'utf8')) || 1;
                }
                catch { /* ignore */ }
                round += 1;
                const prompt = await readFile(promptPath, 'utf8');
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
                ].join('\n');
                await writeFile(promptPath, `${prompt}\n${append}`, 'utf8');
                await writeFile(roundPath, String(round), 'utf8');
                return [
                    `🔄 已追加第 ${round} 轮迭代指令（${dir}）`,
                    '',
                    '流程：按更新后的 CODEGEN_PROMPT.md 改 → 组件渲染截图 ↔ 静态基准页对照 → 差异清零后结束。',
                ].join('\n');
            },
        })));
        // ── 工具 4：自动视觉回归（把"肉眼找差异"换成可断言的数值差） ──
        disposers.push(ctx.tools.register(defineTool({
            name: 'figma_visual_diff',
            description: '自动视觉回归：用无头 Chrome 打开**组件实现页**，逐节点取 getBoundingClientRect + computed style，与设计规格（static/spec.json）比对，产出 expected/actual/Δ 的结构化差异（可直接作为 figma_review_to_round 的 items）。只对照可机器判定的属性：位置/尺寸/逐边描边/圆角/背景色/字号/行高。实现页需是 file:// 可打开的静态页（http 站点因跨域拿不到 computed style）',
            parameters: {
                output_dir: { type: 'string', description: '输出目录（含 flow.json 与 static/spec.json）' },
                impl: { type: 'string', description: '组件实现页：本地 HTML 路径，或可 file:// 打开的静态页；不要传 dev server 的 http 地址' },
                tolerance: { type: 'number', description: '可接受偏差（px），默认 1' },
                chrome_bin: { type: 'string', description: '无头浏览器路径（缺省自动探测）' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const dir = resolve(args.output_dir);
                const found = await findFlow(dir);
                const flowDir = found?.dir ?? dir;
                const staticDir = join(flowDir, 'static');
                const specPath = join(staticDir, 'spec.json');
                if (!existsSync(specPath)) {
                    throw new Error(`找不到 ${specPath}：先跑 figma_render_static（它会产出 spec.json / coverage.json / abs.html）`);
                }
                const spec = JSON.parse(await readFile(specPath, 'utf8'));
                const implArg = String(args.impl ?? '').trim();
                if (!implArg)
                    throw new Error('需要 impl：组件实现页路径');
                const isHttp = /^https?:\/\//i.test(implArg);
                if (!isHttp && !existsSync(resolve(implArg))) {
                    throw new Error(`实现页不存在：${resolve(implArg)}（需要先构建/导出成静态页；dev server 的 http 地址拿不到 computed style）`);
                }
                const impl = isHttp ? implArg : pathToFileURL(resolve(implArg)).href;
                const rows = spec.rows;
                const res = await visualDiff({
                    implPathOrUrl: impl,
                    width: spec.width,
                    height: spec.height,
                    tolerance: Number.isFinite(Number(args.tolerance)) ? Number(args.tolerance) : 1.5,
                    outDir: staticDir,
                    rows,
                    chromeBin: args.chrome_bin,
                });
                if (!res.ok) {
                    return [
                        `⚠️ 自动视觉回归没能执行：${res.error ?? '未知错误'}`,
                        '',
                        '常见原因：',
                        '  1) 实现页不是 file:// 可打开的静态页（React dev server 的 http 地址拿不到 computed style）；',
                        '  2) 实现页没有给元素打 data-design-id（骨架生成时会带，手写页面需自行加）；',
                        '  3) 本机没有可用的 Chrome/Chromium（可用 chrome_bin 指定）。',
                        '此时请退回"截图 + 人/专家肉眼审计"，并在交付说明里注明"未经机器回归"。',
                    ].join('\n');
                }
                const sev = { blocker: 0, major: 0, minor: 0 };
                for (const f of res.findings)
                    sev[f.severity] = (sev[f.severity] ?? 0) + 1;
                const items = res.findings.map((f) => ({
                    severity: f.severity,
                    text: `[${f.property}] ${f.name}：期望 ${f.expected} · 实际 ${f.actual}${f.delta != null ? ` · Δ${f.delta}` : ''}`,
                    node_id: f.nodeId,
                    expected: f.expected,
                    actual: f.actual,
                }));
                const shown = items.slice(0, 60);
                const itemsJson = JSON.stringify(shown);
                const truncated = items.length > shown.length;
                return [
                    `🔬 自动视觉回归：对照 ${res.checked} 个节点，差异 ${res.findings.length} 条`
                        + `（阻断 ${sev.blocker ?? 0} / 主要 ${sev.major ?? 0} / 次要 ${sev.minor ?? 0}）`
                        + (res.missing.length ? ` · 实现页缺少 ${res.missing.length} 个节点` : ''),
                    `- 报告：${res.reportPath}`,
                    `- 机器可读：${res.jsonPath}`,
                    res.missing.length ? `- 缺失节点示例：${res.missing.slice(0, 5).join('；')}${res.missing.length > 5 ? ' …' : ''}` : '',
                    truncated ? `- ⚠️ 条目过多：只回传前 ${shown.length} 条（共 ${items.length} 条），完整清单见 visual-diff.json` : '',
                    '',
                    res.findings.length
                        ? '把差异接进闭环（免自然语言解析，推荐）：'
                            + `\n  figma_review_to_round(output_dir="${flowDir}", items=${itemsJson}, reviewer="figma_visual_diff", scope="implementation")`
                        : '✅ 可比属性全部在容差内：机器层面没有位移/尺寸/描边/圆角/字号偏差，剩下的交给人与专家的意图判断。',
                    '',
                    '注意：机器只能判"数值差"；视觉层级、信息密度、文案、设计意图仍要靠 UI 专家审计（figma_codegen_round 的门禁不认这一层）。',
                ].filter(Boolean).join('\n');
            },
        })));
        return disposers;
    }, '@deepseek-ai/dsh-tool-design-to-code');
}
//# sourceMappingURL=index.js.map