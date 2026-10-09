/**
 * 评审闭环：把「UI 专家 / 验收专家」的整改清单变成**可追踪的轮次任务**。
 *
 * 为什么需要它：probe 能测出"逐边描边/逐角圆角/高度/字号"这类**可量化**差异，
 * 但测不出"视觉层级、信息密度、文案、一致性"这类**需要人味判断**的问题。
 * 这类问题由专家子 agent 出整改清单，然后必须能：
 *   ① 结构化进 CODEGEN_PROMPT.md（下一轮按条目改，而不是"看着办"）；
 *   ② 逐条记状态（open / closed），**未关闭的项不允许收尾**；
 *   ③ 留下"谁在什么时候提的、什么时候关的"，可审计。
 *
 * 解析是启发式的（专家输出是自然语言 markdown），所以：
 * - 支持列表项、表格行、编号项；
 * - 支持显式结构化输入（items JSON）以绕过解析；
 * - 解析结果会原样回显给人核对，避免"解析错了没人发现"。
 */
const SEVERITY_RULES = [
    [/阻断|严重|致命|blocker|critical|must.?fix|p0/i, 'blocker'],
    [/主要|重要|不满足|不符合|错误|major|should.?fix|p1/i, 'major'],
    [/次要|建议|优化|polish|minor|nice.?to.?have|p2|nit/i, 'minor'],
];
function severityOf(line) {
    for (const [re, sev] of SEVERITY_RULES)
        if (re.test(line))
            return sev;
    return 'info';
}
/** 从一行里抽文件位置：`a/b/c.tsx:12` / `a/b/c.less` / 「文件:行」 */
function locationOf(line) {
    const m = line.match(/([\w@./-]+\.(?:tsx?|jsx?|less|css|scss|vue|svelte|json|html))(?::(\d+))?/);
    if (!m)
        return undefined;
    return m[2] ? `${m[1]}:${m[2]}` : m[1];
}
function cleanCell(s) {
    return s.replace(/\*\*/g, '').replace(/`/g, '').replace(/^\s*[-*+]\s*/, '').trim();
}
function isNoise(s) {
    const t = cleanCell(s);
    if (!t || t.length < 4)
        return true;
    if (/^[-|\s:]+$/.test(t))
        return true;
    if (/^#+\s/.test(t))
        return true; // 标题行
    if (/^(问题|序号|期望|实际|位置|改法|验证|描述|severity|item)\s*$/i.test(t))
        return true;
    if (/^(结论|总结|汇总|说明|备注)[:：]?$/.test(t))
        return true;
    return false;
}
/** 表格行 → 取"像问题描述"的那一列（优先含中英文描述的列，跳过序号/严重级别列） */
function fromTableRow(row) {
    const cells = row.split('|').map(cleanCell).filter(Boolean);
    if (cells.length < 2)
        return undefined;
    const bad = /^(阻断|严重|主要|次要|建议|info|minor|major|blocker|critical|低|中|高|p[0-3])$/i;
    const cand = cells.filter((c) => c.length >= 6 && !bad.test(c) && !/^\d+$/.test(c));
    return cand.sort((a, b) => b.length - a.length)[0];
}
/**
 * 解析专家整改清单。启发式但保守：只收"看起来是一条整改项"的行，
 * 且返回结果会原样回显给调用方核对。
 */
export function parseReview(text, opts = {}) {
    const maxItems = opts.maxItems ?? 80;
    const out = [];
    const seen = new Set();
    const lines = String(text ?? '').split('\n');
    const push = (raw, extra) => {
        const body = cleanCell(raw);
        if (isNoise(body))
            return;
        const key = body.slice(0, 60);
        if (seen.has(key))
            return;
        seen.add(key);
        const sev = severityOf(raw);
        // 正文里出现的 "132:8240" 这种节点 id，自动认领 → 能在基准图上钉框
        const nodeMatch = raw.match(/(\d{1,6}:\d{1,6})/);
        const nodeId = nodeMatch ? nodeMatch[1] : undefined;
        const item = {
            id: '',
            severity: sev,
            text: body.slice(0, 400),
            location: locationOf(raw),
            expected: extra?.expected,
            actual: extra?.actual,
            nodeId,
            box: nodeId && opts.resolveBox ? opts.resolveBox(nodeId) : undefined,
        };
        out.push(item);
    };
    for (const line of lines) {
        if (out.length >= maxItems)
            break;
        const t = line.trim();
        if (!t)
            continue;
        // 表格行：| a | b | c |
        if (t.startsWith('|') && t.endsWith('|')) {
            if (/^\|[\s:|-]+\|$/.test(t))
                continue; // 分隔行
            const cell = fromTableRow(t);
            if (cell)
                push(cell, { actual: undefined });
            continue;
        }
        // 列表项 / 编号项
        if (/^([-*+]|\d+[.)])\s+/.test(t)) {
            // 同一项里的「期望：… 实际：…」拆开
            const exp = t.match(/期望[:：]\s*([^。；;|]+)/);
            const act = t.match(/实际[:：]\s*([^。；;|]+)/);
            push(t, { expected: exp?.[1]?.trim(), actual: act?.[1]?.trim() });
            continue;
        }
        // 纯文本里带"应为/应该是/改成/不对/不一致"的句子也算一条
        if (/应为|应该(是|为)|改成|不一致|不对|不符|差距|偏差|缺少|多了|少了/.test(t)) {
            push(t);
        }
    }
    return out.map((it, i) => ({ ...it, id: `R${i + 1}` }));
}
/** 专家整改清单 → 追加进 CODEGEN_PROMPT.md 的轮次内容 */
export function renderReviewRound(items, meta) {
    const L = [];
    L.push('');
    L.push(`## 第 ${meta.round} 轮迭代 · 专家整改清单（由 figma_review_to_round 注入）`);
    L.push('');
    L.push(`- 评审人：${meta.reviewer} · 时间：${meta.at}${meta.source ? ` · 来源：${meta.source}` : ''}`);
    L.push(`- 条目：${items.length}（阻断 ${items.filter((i) => i.severity === 'blocker').length} · 主要 ${items.filter((i) => i.severity === 'major').length} · 次要 ${items.filter((i) => i.severity === 'minor').length}）`);
    L.push('');
    L.push('> 按 id 逐条处理；每条都要写"改在哪个文件哪一行 + 用什么实测数值验证"。');
    L.push('> **未关闭的条目不允许收尾**（figma_codegen_round 会拒绝）。');
    L.push('');
    L.push('| id | 级别 | 问题 | 位置 | 期望 | 实际 | 处理结果（待填：文件:行 + 实测值） |');
    L.push('|---|---|---|---|---|---|---|');
    for (const it of items) {
        L.push(`| ${it.id} | ${it.severity} | ${it.text.replace(/\|/g, '\\|')} | ${it.location ?? ''} | ${it.expected ?? ''} | ${it.actual ?? ''} | |`);
    }
    if (meta.extra) {
        L.push('');
        L.push('### 评审原文/补充（供上下文，不要逐字照做）');
        L.push('');
        L.push('```');
        L.push(meta.extra.slice(0, 4000));
        L.push('```');
    }
    L.push('');
    return L.join('\n');
}
/** 未关闭条目（收尾门禁用） */
export function openItems(rounds) {
    const out = [];
    for (const r of rounds ?? [])
        for (const it of r.items)
            if (it.status === 'open')
                out.push(it);
    return out;
}
export function summarizeRounds(rounds) {
    if (!rounds?.length)
        return '尚无专家评审';
    const all = rounds.flatMap((r) => r.items);
    const open = all.filter((i) => i.status === 'open');
    return `${rounds.length} 轮评审 / 共 ${all.length} 条 / 未关闭 ${open.length} 条`;
}
/** 是否已经过至少一轮 UI 专家审计（主流程要求项） */
export function hasExpertReview(rounds) {
    return (rounds ?? []).some((r) => r.items.length > 0);
}
export function openByeSeverity(rounds) {
    const open = openItems(rounds);
    return {
        blocker: open.filter((i) => i.severity === 'blocker').length,
        major: open.filter((i) => i.severity === 'major').length,
        minor: open.filter((i) => i.severity === 'minor').length,
    };
}
//# sourceMappingURL=review.js.map