import { defineTool } from '@deepseek-ai/dsh-tools';
import z from 'schemastery';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildDesignModel } from './design.js';
import { generateCode, summarizeAudit } from './codegen.js';
import { auditModel, auditToMarkdown } from './audit.js';
import { renderStatic } from './render-static.js';
import { findCodeHits, keywordsOf, renderChangeMarkdown } from './diff.js';
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
    const nodeId = n ? decodeURIComponent(n[1]).replace('-', ':') : '';
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
async function findDataFrame(dir) {
    const manifestPath = join(dir, 'last_capture.json');
    if (existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
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
        const { dataPath } = await findDataFrame(captureDir);
        const { decodeFrameAndBuildReport } = await import('@deepseek-ai/dsh-tool-figma-reader/lib/kiwi.js');
        const dec = decodeFrameAndBuildReport(dataPath, fileKey, nodeId, tmp);
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
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const { nodeJson, fileKey, nodeId, outDir } = await loadNodeJson(args, config);
                const model = buildDesignModel(nodeJson);
                const staticDir = join(outDir, 'static');
                const r = renderStatic(model, { outputDir: staticDir, title: args.title, projectName: args.project });
                const flow = await writeFlow(outDir, {
                    stage: 'static_rendered', nodeId, fileKey,
                    staticPage: r.htmlPath, specPath: r.specPath, confirmed: false,
                    confirmedBy: undefined, confirmedAt: undefined, confirmNote: undefined,
                });
                void flow;
                return [
                    `🖼️ 已生成静态还原页（设计 ${fileKey} · 节点 ${nodeId}）`,
                    `- 画布 ${model.width}×${model.height} · 渲染节点 ${r.stats.nodes} · 实例重建 ${r.stats.instances} · CSS 规则 ${r.stats.rules}`,
                    `- 页面：${r.htmlPath}`,
                    r.specPath ? `- 规格/映射表：${r.specPath}` : '',
                    '',
                    `- 流程状态：${join(outDir, 'flow.json')}（confirmed=false）`,
                    '',
                    '【必须做·交接给用户】把下面这句话连同路径原样交给用户，等他确认：',
                    `  「请打开 ${r.htmlPath} 对照设计稿确认（结构/尺寸/逐边描边/逐角圆角/字体）；确认后我再实现组件」`,
                    '主 agent 请用 present/sidebar_open 把基准页直接呈现给用户，不要只在回复里贴路径。',
                    `确认通过后调用 figma_confirm_static(output_dir="${outDir}") 记录确认，再进入 figma_gen_component。`,
                    '',
                    '提醒：这一页是**视觉基准**，样式不要直接搬进项目（映射规则见 SPEC.md 第 2 节）。',
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
                const st = renderStatic(newModel, { outputDir: staticDir, projectName: args.project });
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
                    const next = await writeFlow(dir, { stage: prev.stage, nodeId: prev.nodeId, fileKey: prev.fileKey, confirmed: false, confirmedBy: undefined, confirmedAt: undefined, confirmNote: undefined });
                    return `♻️ 已撤销基准页确认（${dir}）\n- 当前 confirmed=${next.confirmed}；改完设计稿请重新渲染并再次确认。`;
                }
                const note = [args.note, args.diffs ? `已知差异：${args.diffs}` : ''].filter(Boolean).join(' | ');
                const next = await writeFlow(dir, {
                    stage: prev.stage, nodeId: prev.nodeId, fileKey: prev.fileKey,
                    confirmed: true,
                    confirmedBy: args.by || 'user',
                    confirmedAt: new Date().toISOString(),
                    confirmNote: note || undefined,
                });
                return [
                    `✅ 已记录基准页人工确认（设计 ${next.fileKey} · 节点 ${next.nodeId}）`,
                    `- 确认人：${next.confirmedBy} · 时间：${next.confirmedAt}`,
                    next.confirmNote ? `- 备注：${next.confirmNote}` : '',
                    `- 基准页：${next.staticPage ?? ''}`,
                    `- 状态文件：${join(dir, 'flow.json')}`,
                    '',
                    '接下来：figma_audit_node → figma_gen_component（骨架）→ 按 CODEGEN_PROMPT 用项目组件实现 → 组件截图 ↔ 基准页对照 → figma_codegen_round。',
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
                const files = generateCode(model, {
                    componentName,
                    requirements: args.requirements || '（未提供需求，按设计稿默认交互：表单输入 + 按钮动作 + 关闭）',
                    conventions: args.conventions || 'React 18 + TypeScript + CSS Modules，零运行时第三方依赖，组件/逻辑拆分，类型安全',
                    outputDir: dir,
                    auditMd,
                    staticPagePath: staticCandidate,
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
                    `- 输出：${dir}`,
                    '',
                    '生成文件：',
                    ...files.map((f) => `  - ${f}`),
                    '',
                    `下一步：按 CODEGEN_PROMPT.md 把占位换成**项目既有组件**、绝对定位收敛成 flex、色值映射主题令牌，`,
                    `然后做"组件渲染截图 ↔ ${args.static_page || join(outDir, 'static', 'index.html')} 基准页"对照；`,
                    `差异未清零前用 figma_codegen_round 继续迭代。`,
                ].join('\n');
            },
        })));
        // ── 工具 3：多轮迭代 ──
        disposers.push(ctx.tools.register(defineTool({
            name: 'figma_codegen_round',
            description: '【流程硬约束】收尾迭代：若 flow.json 里 confirmed 不为 true，本工具会拒绝（需先 figma_confirm_static，或用 force=true 显式越过）。多轮代码生成迭代：在已有输出目录上追加下一轮指令（基于上一轮 review/截图差异），更新 CODEGEN_PROMPT.md 与 round 记录',
            parameters: {
                output_dir: { type: 'string', description: '已有输出目录（figma_gen_component 的 output_dir）' },
                round_feedback: { type: 'string', description: '本轮 review/差异/截图对照结论（必填）' },
                requirements: { type: 'string', description: '需求（可省略）' },
                conventions: { type: 'string', description: '项目约定（可省略）' },
                force: { type: 'boolean', description: 'true = 跳过"基准页已人工确认"的检查（默认拒绝）' },
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
                if (!args.force && found && !found.flow.confirmed) {
                    throw new Error([
                        `拒绝迭代：${join(found.dir, 'flow.json')} 里 confirmed=false（基准页还没有人工确认）。`,
                        `请先让用户确认 ${found.flow.staticPage ?? 'static/index.html'}，再调用 figma_confirm_static(output_dir="${found.dir}")；`,
                        '确实要越过请显式传 force=true。',
                    ].join('\n'));
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
        return disposers;
    }, '@deepseek-ai/dsh-tool-design-to-code');
}
//# sourceMappingURL=index.js.map