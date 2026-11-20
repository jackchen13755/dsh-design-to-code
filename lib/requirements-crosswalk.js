/**
 * 「需求交互点 ↔ UI 交互标注」三方对照表。
 *
 * 纯函数：输入需求自由字符串 + 设计备注数组，输出一段可直接插进
 * CODEGEN_PROMPT 的 Markdown。不修改任何入参，不依赖 design.ts 的运行期实现
 * （DesignAnnotation 仅作类型约束，编译后此 import 被擦除）。
 *
 * 设计意图（接口即契约）：
 *  - 需求侧与 UI 侧都必须"逐条登记"，任一侧不得静默遗漏；
 *  - 粗匹配只作为提示，宁可标"未覆盖"也不做无证据的错配；
 *  - 标题/表头/指引为固定字面量，供 lead 单点集成与机器断言。
 */
/** 固定标题：首行、逐字一致 */
export const CROSSWALK_TITLE = '## 需求交互点 ↔ UI 交互标注 对照表（逐条落实）';
/** 固定表头：8 列，逐字一致 */
export const CROSSWALK_HEADER = '| 需求交互点 | UI标注(备注N) | 对照状态 | 承载 props/state | 事件 | 真实控件/行为 | 文件 | 验证 |';
/** 段末逐字指引（机器断言用，勿改一字；「」不是本串的一部分） */
export const CROSSWALK_GUIDANCE = "每一条需求交互点与每一条 UI 标注都必须登记；两侧不许静默遗漏。对照状态为'未覆盖'的也要按对应来源实现并在验证列说明。";
/** 行为动词：命中即视为"动作句" */
const ACTION_VERBS = [
    '点击', '选择', '弹出', '收起', '激活', '切换',
    '输入', '勾选', '拖动', '显示', '隐藏', '禁用', '跳转',
];
/** 序号 / 项目符号列表行（要求符号后有空白或内容，避免把 `---` 当列表） */
const LIST_LINE_RE = /^\s*(?:[-*•·]\s+\S|\d+[.、)）]\s*\S|[（(]\d+[）)]\s*\S)/;
/** Markdown 标题行不是交互点 */
const HEADING_RE = /^#{1,6}\s/;
/** 对照状态字面量 */
const STATUS_MATCHED = '已对应';
const STATUS_REQ_ONLY = 'UI未覆盖→按需求实现';
const STATUS_ANN_ONLY = '需求未提及→按设计实现';
/**
 * 这些 2 字片段只是动作/语气词，单独共享不构成"内容关键词"。
 * 作用是让"两句都含点击/显示"不会被误判为已对应（保守匹配）。
 */
const STOP_BIGRAMS = new Set([
    ...ACTION_VERBS,
    '自动', '可以', '需要', '之后', '然后', '当前', '进行', '使用',
    // 通用 UI 名词/泛词：两个毫不相干的交互都含"按钮/页面"并不构成对应证据，
    // 否则会把"点击提交按钮跳转成功页"错配到"长按删除按钮确认移除"。
    // 注意：只列与业务域无关的纯 UI 骨架词；"日期/时间/语言"等是领域内容词，
    // 保留为合法匹配信号（去掉会让"日期筛选↔日期范围"这类真对应漏判）。
    '按钮', '页面', '用户', '列表', '输入框', '弹窗', '菜单', '图标',
]);
/** 抽取需求侧交互点：含行为动词的行或列表行；保留原文（仅 trim）不改写语义 */
function extractRequirementPoints(requirements) {
    if (typeof requirements !== 'string' || !requirements.trim())
        return [];
    const out = [];
    for (const raw of requirements.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || HEADING_RE.test(line))
            continue;
        const hasVerb = ACTION_VERBS.some((v) => line.includes(v));
        if (hasVerb || LIST_LINE_RE.test(line))
            out.push(line);
    }
    return out;
}
/** 取连续的中文片段（≥2 字）；英文/数字 token 另算 */
function cjkRuns(text) {
    return text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
}
/**
 * 关键词集合：中文片段的 2 字滑动窗口（去掉停用片）+ 长度≥2 的字母数字 token。
 * 用 2 字窗口而非整词，避免中文无分词器时漏掉"日期"这类真实共享词。
 */
function keywordSet(text) {
    const normalized = String(text ?? '').toLowerCase();
    const set = new Set();
    for (const run of cjkRuns(normalized)) {
        for (let i = 0; i + 2 <= run.length; i++) {
            const bi = run.slice(i, i + 2);
            if (!STOP_BIGRAMS.has(bi))
                set.add(bi);
        }
    }
    for (const tok of normalized.match(/[a-z0-9]{2,}/g) ?? [])
        set.add(tok);
    return set;
}
/** 保守粗匹配：至少共享一个非停用关键词才算"已对应" */
function sharesKeyword(a, b) {
    const sa = keywordSet(a);
    const sb = keywordSet(b);
    for (const k of sa)
        if (sb.has(k))
            return true;
    return false;
}
/** UI 标注单元格：备注N「title」：text（换行压成 ' / '，与 codegen 的备注表一致） */
function annotationCell(index, a) {
    const title = String(a?.title ?? '').replace(/\s+/g, ' ').trim();
    const text = String(a?.text ?? '').replace(/\s*\n+\s*/g, ' / ').trim();
    return `备注${index + 1}「${title}」：${text}`;
}
/** 贪心一对一匹配：已匹配的备注不复用；两侧剩余各自成行 */
function buildRows(points, annotations) {
    const rows = [];
    const used = new Set();
    for (const p of points) {
        let hit = -1;
        for (let i = 0; i < annotations.length; i++) {
            if (used.has(i))
                continue;
            const a = annotations[i];
            if (sharesKeyword(p, `${a?.title ?? ''} ${a?.text ?? ''}`)) {
                hit = i;
                break;
            }
        }
        if (hit >= 0) {
            used.add(hit);
            rows.push({ req: p, ui: annotationCell(hit, annotations[hit]), status: STATUS_MATCHED });
        }
        else {
            rows.push({ req: p, ui: 'UI未覆盖', status: STATUS_REQ_ONLY });
        }
    }
    for (let i = 0; i < annotations.length; i++) {
        if (used.has(i))
            continue;
        rows.push({ req: '需求未提及', ui: annotationCell(i, annotations[i]), status: STATUS_ANN_ONLY });
    }
    return rows;
}
/** Markdown 单元格转义：竖线不能撑破表格 */
function cell(s) {
    return String(s ?? '').replace(/\|/g, '\\|');
}
/**
 * 渲染对照表段落。两侧都无内容时返回空字符串（不生成空表）。
 */
export function renderRequirementsCrosswalk(requirements, annotations) {
    const points = extractRequirementPoints(requirements);
    const anns = Array.isArray(annotations) ? annotations : [];
    const rows = buildRows(points, anns);
    if (rows.length === 0)
        return '';
    const lines = [];
    lines.push(CROSSWALK_TITLE, '');
    lines.push(CROSSWALK_HEADER);
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
        lines.push(`| ${cell(r.req)} | ${cell(r.ui)} | ${cell(r.status)} |  |  |  |  |  |`);
    }
    lines.push('', CROSSWALK_GUIDANCE, '');
    return lines.join('\n');
}
//# sourceMappingURL=requirements-crosswalk.js.map