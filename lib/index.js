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
                return [
                    `🖼️ 已生成静态还原页（设计 ${fileKey} · 节点 ${nodeId}）`,
                    `- 画布 ${model.width}×${model.height} · 渲染节点 ${r.stats.nodes} · 实例重建 ${r.stats.instances} · CSS 规则 ${r.stats.rules}`,
                    `- 页面：${r.htmlPath}`,
                    r.specPath ? `- 规格/映射表：${r.specPath}` : '',
                    '',
                    '请人工确认这一页与设计稿一致（结构/尺寸/逐边描边/逐角圆角/字体）后，再进入 figma_audit_node → figma_gen_component。',
                    '提醒：这一页是**视觉基准**，样式不要直接搬进项目（映射规则见 SPEC.md 第 2 节）。',
                ].filter(Boolean).join('\n');
            },
        })));
        // ── 工具 0b：变更模式（需求是"在现有页面上改几处"时走这条） ──
        disposers.push(ctx.tools.register(defineTool({
            name: 'figma_change_brief',
            description: '变更简报（改现有页面用）：设计新稿 → 生成 1:1 静态基准页 + "旧稿 vs 新稿"逐字段设计差异 + 在目标仓库里 grep 出的代码落点候选 + 逐条变更计划模板（设计→现状→改法→验证）。适用于"在现有页面上改几处"的需求，避免整页重画',
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
                const changed = md.match(/\*\*改动 (\d+) · 新增 (\d+) · 删除 (\d+)\*\*/);
                return [
                    `📝 变更简报已生成（设计 ${fileKey} · 新稿 ${nodeId}${args.old_node_id ? ` · 旧稿 ${args.old_node_id}` : ''}）`,
                    changed ? `- 设计差异：改动 ${changed[1]} · 新增 ${changed[2]} · 删除 ${changed[3]}` : '- 未给旧稿：按新稿全量规格对现有实现逐项核对',
                    codeHits ? `- 代码落点：扫描 ${codeHits.scanned} 文件，命中 ${codeHits.hits.length} 条` : '- 未传 code_dir：跳过代码落点扫描',
                    `- 视觉基准页：${st.htmlPath}`,
                    st.specPath ? `- 规格/映射表：${st.specPath}` : '',
                    `- 变更简报：${changePath}`,
                    '',
                    '按简报 §4 的变更计划逐条填「现状（代码实测）→ 改法（文件:行）」，再动手改；',
                    '改完用 §5 的收尾检查 + 基准页对照验收。',
                ].filter(Boolean).join('\n');
            },
        })));
        // ── 工具 1：设计审计 ──
        disposers.push(ctx.tools.register(defineTool({
            name: 'figma_audit_node',
            description: '设计审计：输出逐节点规格（逐边描边/逐角圆角/字体/auto-layout）+ 实现前核对清单，并把"真歧义（要问设计）"与"数据缺失（按兜底规则做）"分开。歧义判据已修正（不再把 strokeWeight 默认值 1 当隐藏边框）',
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
            description: '设计稿 + 需求 → React/TS/CSS Modules 几何骨架 + Codegen Prompt（几何/字体/逐边描边/逐角圆角来自设计数据；实例渲染为语义占位并带 data-design-name 供替换为项目组件）',
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
                    staticPagePath: args.static_page || join(outDir, 'static', 'index.html'),
                    round,
                    roundFeedback: args.round_feedback || '',
                });
                await writeFile(join(dir, '.codegen-round'), String(round), 'utf8');
                return [
                    `✅ 已生成 React 几何骨架 第 ${round} 轮（设计 ${fileKey} · 节点 ${nodeId}）`,
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
            description: '多轮代码生成迭代：在已有输出目录上追加下一轮指令（基于上一轮 review/截图差异），更新 CODEGEN_PROMPT.md 与 round 记录',
            parameters: {
                output_dir: { type: 'string', description: '已有输出目录（figma_gen_component 的 output_dir）' },
                round_feedback: { type: 'string', description: '本轮 review/差异/截图对照结论（必填）' },
                requirements: { type: 'string', description: '需求（可省略）' },
                conventions: { type: 'string', description: '项目约定（可省略）' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [textBlock(String(value))],
            },
            async execute(args) {
                const dir = resolve(args.output_dir);
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