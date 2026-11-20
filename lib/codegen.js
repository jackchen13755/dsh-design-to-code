/**
 * 代码生成器：DesignModel + 选项 → React/TS/CSS Modules 骨架 + Codegen Prompt。
 *
 * 定位没变：生成"**设计准确的骨架 + 交互挂载点**"，业务交互由 CODEGEN_PROMPT.md 引导会话 LLM 补全。
 *
 * ── 这一版的关键变化：布局从"全绝对定位"改成"按 auto-layout 出 flex" ──
 * 以前骨架一律 `position:absolute`，然后在 Prompt 里要求"绝对定位收敛成 flex"——
 * 这一次翻译发生在**实现阶段**，由会话 LLM 手里只有一张文本表格时完成，于是 gap/对齐/grow 必然丢，
 * 每一轮评审都在修同一批位移。现在：
 *   - 容器按 `layout.mode` 出 `display:flex/flex-direction/gap/padding/justify/align`；
 *   - 子项按 `childGrow/childAlignSelf` 出 `flex/align-self`，`stackPositioning=ABSOLUTE` 才保留绝对定位；
 *   - 与静态基准页共用 `layout.ts` 的**同一套规则**，保证"基准页怎么排、骨架就怎么排"。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inferDesignSystem, specTable } from './render-static.js';
import { borderPaint, flexDecls, flowChildDecls, flowsInParent, orderFlow, radiusDecl, rootCssDecls } from './layout.js';
import { detectRepeats, detectSections, reliableSections, subtreeDesignIds } from './componentize.js';
import { renderRequirementsCrosswalk } from './requirements-crosswalk.js';
import { iconRefOf } from './icons.js';
// ── 壳/组件级复用契约：只读消费的纯函数（无副作用，边界全覆盖）────────────
/** level 排序：shell → control → business；未知等级排最后，保证稳定顺序 */
const REUSE_LEVEL_RANK = { shell: 0, control: 1, business: 2 };
const reuseRank = (c) => REUSE_LEVEL_RANK[String(c.level ?? '')] ?? 9;
/** shell 判定：level 或 role 命中 shell 即算；明确是 content 角色的不冒充壳 */
const isShellContract = (c) => {
    const role = String(c.role ?? '');
    const level = String(c.level ?? '');
    if (role === 'content')
        return false;
    return level === 'shell' || role === 'shell';
};
/** data-reuse-role 取值：优先契约的 role（非 unknown 时），否则按 level 推导 */
const reuseRoleOf = (c) => {
    const role = String(c.role ?? '').trim();
    if (role && role !== 'unknown')
        return role;
    const level = String(c.level ?? '');
    return level === 'shell' ? 'shell' : (level === 'control' || level === 'business') ? 'control' : 'unknown';
};
/** slot 里的 map 字段（extraSlots/valueProps/eventProps）形状未定死，统一兜底格式化 */
const fmtSlotMap = (v) => {
    if (v == null)
        return '';
    if (typeof v === 'string')
        return v;
    if (Array.isArray(v))
        return v.map((x) => String(x)).join(', ');
    if (typeof v === 'object') {
        return Object.entries(v).map(([k, x]) => `${k}:${String(x)}`).join(', ');
    }
    return String(v);
};
/** valueProps/eventProps → [jsx属性名, props字段] 对：兼容 string[]（值为属性名）与 Record（显式映射）两种形状 */
const slotPropPairs = (v) => {
    if (v == null)
        return [];
    if (Array.isArray(v))
        return v.map((x) => [String(x), String(x)]);
    if (typeof v === 'object') {
        return Object.entries(v).map(([k, x]) => [k, String(x)]);
    }
    return [];
};
/** 插入 CODEGEN_PROMPT 的复用契约段：空数组返回 []（整段省略） */
function renderReuseContractsSection(contracts) {
    if (!contracts.length)
        return [];
    const sorted = [...contracts].sort((a, b) => reuseRank(a) - reuseRank(b));
    const out = [
        '',
        '## 壳/组件级复用契约（三层统一：项目既有组件 ↔ 设计节点）',
        '',
        '设计稿是静态的，但项目已有组件库：本表逐条把设计节点绑定到项目既有组件，实现时**只做内容/差异部分**。',
        '层级顺序：shell（Drawer/Modal 等壳）→ control（Input/Select/Tag 等控件）→ business（业务组件），按此序落在表里。',
        '| 契约ID | 层级 | 设计节点 | 图层名 | 项目组件 | import路径 | slot/children契约 | 需实现的内容区(节点ID) | 不重建的外壳节点 | 状态 | 验证方式 |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
    ];
    for (const c of sorted) {
        const m = c.match ?? {};
        const status = String(m.status ?? '—');
        const source = String(m.source ?? '—');
        const confidence = typeof m.confidence === 'number' ? m.confidence.toFixed(2) : '-';
        const importCell = c.importPath && String(c.importPath).trim()
            ? `\`${String(c.importPath)}\``
            : (status === 'suspected' && source !== 'code-dir' ? '去项目 grep 确认' : '—');
        const s = c.slot ?? {};
        const slotParts = [];
        if (s.contentSlot)
            slotParts.push(`content→${s.contentSlot}`);
        if (s.headerSlot)
            slotParts.push(`header→${s.headerSlot}`);
        const extra = fmtSlotMap(s.extraSlots);
        if (extra)
            slotParts.push(`extra:${extra}`);
        const vals = fmtSlotMap(s.valueProps);
        if (vals)
            slotParts.push(`value:${vals}`);
        const evs = fmtSlotMap(s.eventProps);
        if (evs)
            slotParts.push(`event:${evs}`);
        if (c.nested?.length)
            slotParts.push(`nested→${c.nested.join('/')}`);
        const contentIds = (s.contentDesignNodeIds ?? []).map(String).join(', ') || '—';
        const omitIds = (s.omitDesignNodeIds ?? []).map(String).join(', ') || '—';
        const verify = c.verify;
        const verifyCell = [
            verify?.nodeId ? `节点 ${verify.nodeId}` : '',
            verify?.note ? String(verify.note) : '',
            `来源 ${source}/${confidence}`,
        ].filter(Boolean).join('；');
        const cells = [
            String(c.id ?? '—'), String(c.level ?? '—'), String(c.designNodeId ?? '—'), String(c.designName ?? '—'),
            String(c.projectComponent ?? '—'), importCell, slotParts.join('；') || 'children（默认插槽）',
            contentIds, omitIds, status, verifyCell,
        ];
        out.push(`| ${cells.map(cellOf).join(' | ')} |`);
    }
    out.push('', '硬规则（逐条必做；与《组件边界契约》冲突时**以本表为准**）：', '1. shell 级**不重画外壳**，只实现「需实现的内容区(节点ID)」并套入契约的 slot/children；', '2. control/business 级节点复用项目组件，**禁止自绘**控件（Input/Select/Tag/Drawer/Modal…）；', '3. **suspected 先确认**：status=suspected 的条目先确认再落代码，不得静默套用；', '4. 同一节点既在《组件边界契约》又在本表时**以本表为准**（项目组件提供，不再生成单元组件）；', '5. nested 逐层套：按 nested 顺序由外到内嵌套项目组件与其 slot。', '');
    return out;
}
/** 生成套用项目组件的 Shell 骨架源码；无 shell 契约时返回空串（不生成文件） */
function renderShellSkeleton(name, contracts) {
    const sorted = [...contracts].sort((a, b) => reuseRank(a) - reuseRank(b));
    const shells = sorted.filter(isShellContract);
    if (!shells.length)
        return '';
    const byId = new Map(sorted.map((c) => [String(c.id), c]));
    const nestedTargets = new Set();
    for (const c of sorted)
        for (const id of c.nested ?? [])
            nestedTargets.add(String(id));
    const roots = shells.filter((c) => !nestedTargets.has(String(c.id)));
    const top = roots.length ? roots : shells;
    // import：有 importPath 用契约值，否则写占位注释（含所缺组件名，便于 grep 定位）
    const importLines = [];
    const seen = new Set();
    for (const c of sorted) {
        const comp = String(c.projectComponent ?? '').trim();
        if (!comp || seen.has(comp))
            continue;
        seen.add(comp);
        const p = String(c.importPath ?? '').trim().replace(/'/g, "\\'");
        importLines.push(p ? `import { ${comp} } from '${p}';` : `// TODO: 确认 import 路径（契约 ${String(c.id)}：${comp}）`);
    }
    if (!importLines.length)
        importLines.push('// TODO: 确认 import 路径');
    const renderedControls = new Set();
    const renderOne = (c, ind, stack) => {
        const cid = String(c.id);
        if (stack.has(cid))
            return `${ind}{/* nested 循环引用，跳过 ${escText(cid)} */}`;
        const nextStack = new Set(stack);
        nextStack.add(cid);
        const s = c.slot ?? {};
        const comp = String(c.projectComponent ?? '').replace(/[^\w$]/g, '') || 'ReusedComponent';
        const contentIds = (s.contentDesignNodeIds ?? []).map(String);
        const childLines = [];
        const covered = new Set();
        for (const nid of c.nested ?? []) {
            const child = byId.get(String(nid));
            if (!child)
                continue;
            covered.add(String(child.designNodeId ?? ''));
            childLines.push(renderOne(child, `${ind}  `, nextStack));
        }
        let hasGenericContent = false;
        for (const nid of contentIds) {
            if (covered.has(nid))
                continue;
            const ctrl = sorted.find((x) => !isShellContract(x) && String(x.designNodeId) === nid && !renderedControls.has(String(x.id)));
            if (ctrl) {
                renderedControls.add(String(ctrl.id));
                childLines.push(`${ind}  <div data-reuse-role="control" data-reuse-contract="${escAttr(ctrl.id)}" data-design-id="${escAttr(ctrl.designNodeId)}">TODO: 用项目组件 ${escText(ctrl.projectComponent)} 替换（禁止自绘）</div>`);
            }
            else {
                childLines.push(`${ind}  <div data-reuse-role="content" data-reuse-contract="${escAttr(cid)}" data-design-id="${escAttr(nid)}">TODO: 实现内容区</div>`);
                hasGenericContent = true;
            }
        }
        // 边界兜底：即便所有内容节点都被控件契约接管（或没有内容节点），也保证壳里有一个标准 content 挂载点
        if (!hasGenericContent) {
            childLines.push(`${ind}  <div data-reuse-role="content" data-reuse-contract="${escAttr(cid)}">TODO: 实现内容区</div>`);
        }
        const attrs = [];
        const headerSlot = String(s.headerSlot ?? '').trim();
        if (headerSlot)
            attrs.push(`${headerSlot}={<div data-reuse-role="content" data-reuse-contract="${escAttr(cid)}">TODO: 实现头部内容区</div>}`);
        for (const [prop, src] of slotPropPairs(s.valueProps))
            attrs.push(`${prop}={props.${src}}`);
        for (const [prop, src] of slotPropPairs(s.eventProps))
            attrs.push(`${prop}={props.${src}}`);
        const contentSlot = String(s.contentSlot ?? '').trim();
        const childrenJsx = `\n${childLines.join('\n')}\n${ind}`;
        if (contentSlot && contentSlot !== 'children') {
            attrs.push(`${contentSlot}={<>${childrenJsx}</>}`);
            return `${ind}<${comp}${attrs.length ? ` ${attrs.join(' ')}` : ''} />`;
        }
        return `${ind}<${comp}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${childrenJsx}</${comp}>`;
    };
    const body = top.map((c) => renderOne(c, '      ', new Set())).join('\n');
    const leftover = sorted.filter((x) => !isShellContract(x) && !renderedControls.has(String(x.id)));
    const leftoverJsx = leftover.map((x) => `      <div data-reuse-role="control" data-reuse-contract="${escAttr(x.id)}" data-design-id="${escAttr(x.designNodeId)}">TODO: 用项目组件 ${escText(x.projectComponent)} 替换（禁止自绘）</div>`).join('\n');
    const propsUsed = new Set();
    for (const c of sorted) {
        const s = c.slot ?? {};
        for (const [, src] of slotPropPairs(s.valueProps))
            propsUsed.add(src);
        for (const [, src] of slotPropPairs(s.eventProps))
            propsUsed.add(src);
    }
    const propsDecl = [...propsUsed].map((p) => `  /** 由复用契约透传 */\n  ${p}?: unknown;`).join('\n') || '  // 内容区可按需扩展 props';
    const firstNode = sorted[0]?.designNodeId ?? '';
    return [
        `// 由设计稿 ${escText(String(firstNode))} + 复用契约生成的**套用骨架**。`,
        '// 壳/控件复用项目既有组件：只实现 content 标注的内容区，control 标注的节点禁止自绘。',
        '// 这是骨架起点：按 CODEGEN_PROMPT.md《壳/组件级复用契约》逐条落实后删除 TODO。',
        "import type { ReactNode } from 'react';",
        ...importLines,
        '',
        `export interface ${name}ShellProps {`,
        propsDecl,
        '  children?: ReactNode;',
        '}',
        '',
        `export function ${name}Shell(props: ${name}ShellProps) {`,
        '  void props;',
        '  return (',
        '    <>',
        body,
        leftoverJsx,
        '    </>',
        '  );',
        '}',
        '',
        `export default ${name}Shell;`,
        '',
    ].join('\n');
}
function safeName(name) {
    const cleaned = name.replace(/[^A-Za-z0-9_]/g, '').replace(/^(\d)/, '_$1');
    return cleaned || 'DesignComponent';
}
/** 按树序取子树里"会被抽成 props 的值"（TEXT 文案 / 实例覆写文案），顺序与 componentize 派生 props 一致 */
function textValuesOf(root) {
    const out = [];
    const walk = (n) => {
        if (n.raw.visible === false)
            return;
        if (n.kind === 'text' && n.value) {
            out.push(n.value);
            return;
        }
        if (n.type === 'INSTANCE' && n.value)
            out.push(n.value);
        for (const c of n.children)
            walk(c);
    };
    walk(root);
    return out;
}
/** 给顶层分区派生 props：从子树里的文案按渲染顺序取（与组件文件渲染循环的 propIdx 对齐） */
function propsForSubtree(root, max = 8) {
    const out = [];
    const used = new Set();
    for (const t of flat([root])) {
        if (t.id === root.id)
            continue;
        if (t.kind !== 'text' && !(t.type === 'INSTANCE' && t.value))
            continue;
        const text = String(t.value ?? '').trim();
        if (!text || text.length > 20)
            continue;
        let name = text.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/)
            .map((w) => w.charAt(0).toLowerCase() + w.slice(1)).join('') || `text${out.length + 1}`;
        if (!/^[a-zA-Z]/.test(name))
            name = `text${out.length + 1}`;
        while (used.has(name))
            name = `${name}Alt`;
        used.add(name);
        out.push({ name, type: 'string', sample: text, nodeId: t.id });
        if (out.length >= max)
            break;
    }
    return out;
}
function flat(nodes) {
    const out = [];
    const walk = (n) => {
        if (n.raw.visible === false)
            return;
        if (n.kind !== 'root')
            out.push(n);
        for (const c of n.children)
            walk(c);
    };
    for (const n of nodes)
        walk(n);
    return out;
}
const escText = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
/** JSX 里的文案统一用表达式包一层，避免文案里的 `{`/`}` 破坏语法 */
const jsxText = (s) => `{${JSON.stringify(String(s ?? ''))}}`;
const px = (v) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0';
};
/** 设计备注/标题新契约字段的摘要；字段未落地或 undefined 时兜底，不臆造 */
const fmtConf = (v) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '-';
const fmtSignals = (s) => (s ?? []).map((x) => `${x.kind}:${x.weight}${x.value ? `(${x.value})` : ''}`).join('、') || '-';
/** C1 SuspectItem（design.ts 定义，本席位只读消费）；运行时字段可能尚未落地，按空数组兜底。 */
const suspectsOf = (m) => m.suspects ?? [];
const cellOf = (s) => escText(s).replace(/\|/g, '\\|');
/** 细节核对表：从 model.tokens / model.spec 自动填设计 literal（不是近似值）。
 *  prov=placeholder/inferred（data-guessed）或命中 C1 suspects 的行标「存疑·需确认，不得静默套用」。 */
function detailChecklist(model) {
    const suspects = suspectsOf(model);
    const suspectIds = new Set(suspects.map((s) => String(s.nodeId ?? '')).filter(Boolean));
    const suspectProps = new Set(suspects.map((s) => `${String(s.nodeId ?? '')}|${String(s.property ?? '')}`));
    const flagged = (row, prop) => suspectIds.has(row.id) ||
        suspectProps.has(`${row.id}|${prop}`) ||
        /placeholder|inferred|guessed/.test(String(row.prov ?? ''));
    const out = [];
    const row = (attr, value, tol, how, sr, prop) => {
        const v = sr && prop && flagged(sr, prop) ? `存疑·需确认，不得静默套用（原值 ${value}）` : value;
        out.push(`| ${cellOf(attr)} | ${cellOf(v)} | ${cellOf(tol)} | ${cellOf(how)} |`);
    };
    const tokens = model.tokens ?? { colors: {}, fonts: {}, spacing: [], shadows: [] };
    for (const [k, v] of Object.entries(tokens.colors)) {
        row(`令牌 ${k}（色值）`, v, '0（逐字相等）', 'getComputedStyle(el).color / backgroundColor / borderColor 与该 literal 逐字对比');
    }
    for (const [k, v] of Object.entries(tokens.fonts)) {
        row(`令牌 ${k}（字号/行高）`, `${v.size}px / ${v.lineHeight ?? '-'}`, '±0.5px', 'getComputedStyle(el).fontSize / lineHeight');
    }
    tokens.spacing.forEach((v, i) => {
        row(`令牌 spacing[${i}]（gap）`, `${v}px`, '±1px', 'getComputedStyle(el).gap / columnGap / rowGap');
    });
    const HOW = {
        bg: 'getComputedStyle(el).backgroundColor',
        color: 'getComputedStyle(el).color',
        font: 'getComputedStyle(el).fontSize / lineHeight',
        dash: 'getComputedStyle(el).background-image（repeating-linear-gradient）或 SVG stroke-dasharray',
        border: 'getComputedStyle(el).borderTopWidth / RightWidth / BottomWidth / LeftWidth + borderStyle',
        radius: 'getComputedStyle(el).borderTopLeftRadius / TopRightRadius / BottomRightRadius / BottomLeftRadius',
        text: 'el.textContent 与设计原文逐字对比',
    };
    for (const s of model.spec ?? []) {
        if (s.background)
            row(`${s.id} ${s.name} 背景色`, s.background, '0（逐字相等）', HOW.bg, s, 'fill');
        if (s.color)
            row(`${s.id} ${s.name} 文字色`, s.color, '0（逐字相等）', HOW.color, s, 'text');
        if (s.font)
            row(`${s.id} ${s.name} 字号/行高`, s.font, '±0.5px', HOW.font, s, 'font');
        if (s.dash)
            row(`${s.id} ${s.name} 虚线`, `dashPattern=${s.dash}`, '段长逐字相等', HOW.dash, s, 'stroke');
        if (s.border || s.borderEdges)
            row(`${s.id} ${s.name} 逐边描边`, `${s.borderEdges ?? ''} ${s.border ?? ''}`.trim(), '±0.5px', HOW.border, s, 'stroke');
        if (s.radius)
            row(`${s.id} ${s.name} 逐角圆角`, s.radius, '±1px', HOW.radius, s, 'radius');
        if (s.text)
            row(`${s.id} ${s.name} 文案`, s.text, '0（逐字相等）', HOW.text, s, 'text');
    }
    return out;
}
const INSTANCE_RULES = [
    { re: /hand|cursor|光标/i, tag: 'skip' },
    { re: /^\*$/, tag: 'required' },
    { re: /radio|单选框/i, tag: 'radio' },
    { re: /delete|trash|删除/i, tag: 'icon' },
    { re: /tag|标签/i, tag: 'tag' },
    { re: /upload|上传/i, tag: 'upload' },
    { re: /date|calendar|日期/i, tag: 'date' },
    { re: /select|dropdown|下拉|combo/i, tag: 'select' },
    { re: /button|btn|按钮/i, tag: 'button' },
    { re: /input|输入/i, tag: 'input' },
];
function instanceTag(n) {
    for (const r of INSTANCE_RULES)
        if (r.re.test(n.name))
            return r.tag;
    return 'placeholder';
}
/** 描边声明（非布局画法，见 layout.ts 的 borderPaint） */
function borderDecl(n) {
    return borderPaint(n.border, n.shadow).decls;
}
/** 一个节点的定位/尺寸声明：在父 flex 流里 vs 绝对定位 */
function boxDecls(n, parent, inFlow, index = 0) {
    if (inFlow && parent) {
        return [...flowChildDecls(n, parent, index), `width: ${px(n.w)}px`, `height: ${px(n.h)}px`];
    }
    return [
        'position: absolute',
        `left: ${px(n.rx)}px`,
        `top: ${px(n.ry)}px`,
        `width: ${px(n.w)}px`,
        `height: ${px(n.h)}px`,
    ];
}
/** 节点 → JSX（递归；父容器是 auto-layout 时子项进 flex 流） */
function emitNode(n, parent, indent, ctx, index = 0) {
    const inFlow = flowsInParent(n, parent);
    const boundary = ctx.boundaryFor(n);
    // 复用契约命中：只往已生成的标签上挂 data-reuse-role/data-reuse-contract，绝不改定位/尺寸/布局
    const reuseHit = ctx.reuseFor(n);
    const reuseAttr = reuseHit
        ? ` data-reuse-role="${escAttr(reuseRoleOf(reuseHit))}" data-reuse-contract="${escAttr(reuseHit.id)}"`
        : '';
    if (boundary) {
        const decl = [...boxDecls(n, parent, inFlow), 'box-sizing: border-box'];
        const c = ctx.cls(decl.join(';\n  '));
        const vals = textValuesOf(n);
        const props = boundary.props
            .map((pr, idx) => `${pr.name}=${JSON.stringify(vals[idx] ?? pr.sample)}`)
            .join(' ');
        // section 的根节点是对比锚点，wrapper 上保留 data-design-id；repeat 维持现状（不带）
        const anchorAttr = boundary.kind === 'section' ? ` data-design-id="${escAttr(n.id)}"` : '';
        ctx.jsx.push(`${indent}<div className={styles.${c}}${anchorAttr}${reuseAttr}><${boundary.name}${props ? ` ${props}` : ''} /></div>`);
        return;
    }
    const d = [...boxDecls(n, parent, inFlow, index), 'box-sizing: border-box'];
    if (n.kind === 'text') {
        const t = n.text;
        if (t) {
            d.push(`font-family: '${t.family}', system-ui, sans-serif`);
            d.push(`font-size: ${t.size}px`, `font-weight: ${t.weight}`);
            if (t.italic)
                d.push('font-style: italic');
            if (t.lineHeight)
                d.push(`line-height: ${t.lineHeight}`);
            if (t.letterSpacing)
                d.push(`letter-spacing: ${t.letterSpacing}`);
            if (t.align)
                d.push(`text-align: ${t.align}`);
            if (t.color)
                d.push(`color: ${t.color}`);
        }
        const av = String(t?.alignVertical ?? 'TOP').toUpperCase();
        if (av === 'CENTER' || av === 'BOTTOM') {
            d.push('display: flex', 'flex-direction: column', `justify-content: ${av === 'CENTER' ? 'center' : 'flex-end'}`);
        }
        if (t?.autoResize === 'HEIGHT')
            d.push('white-space: pre-wrap', 'word-break: break-word');
        else if (t?.autoResize === 'TRUNCATE')
            d.push('white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis');
        else
            d.push('white-space: pre', 'overflow: visible');
        const c = ctx.cls(d.join(';\n  '));
        ctx.jsx.push(`${indent}<span className={styles.${c}} data-design-id="${escAttr(n.id)}"${reuseAttr}>${jsxText(n.value ?? '')}</span>`);
        return;
    }
    if (n.background)
        d.push(`background: ${n.background}`);
    d.push(...borderDecl(n));
    if (n.kind === 'ellipse')
        d.push('border-radius: 50%');
    else if (n.radius)
        d.push(`border-radius: ${n.radius}`);
    if (n.opacity != null)
        d.push(`opacity: ${n.opacity}`);
    if (n.clips)
        d.push('overflow: hidden');
    if (n.rotation)
        d.push(`transform: rotate(${n.rotation}deg)`, 'transform-origin: 0 0');
    if (n.layout?.mode)
        d.push(...flexDecls(n));
    // 实例：语义占位（内部结构拿不到，交给项目组件替换）；真实绘制值优先，缺失才用设计系统常量
    if (n.type === 'INSTANCE') {
        const tag = instanceTag(n);
        if (tag === 'skip')
            return;
        const designName = escAttr(`${n.name} ${px(n.w)}x${px(n.h)}`);
        const inst = ctx.uid();
        ctx.instanceTodo.push(`- ${n.id} \`${n.name}\` ${px(n.w)}×${px(n.h)} @(${Math.round(n.x)},${Math.round(n.y)})${n.value ? ` 文案「${n.value}」` : ''}${n.instanceTexts?.length ? `；derived 字体 ${n.instanceTexts.map((p) => `${p.value}=${p.family}/${p.weight}/${p.size}px`).join('、')}` : ''}${iconRefOf(n) ? `；图标库 ${iconRefOf(n).name}（用库中的 SVG，勿自绘）` : ''}`);
        if (tag === 'input' || tag === 'select' || tag === 'date') {
            const rad = radiusDecl(n, ctx.ds.radius);
            if (!n.background)
                d.push('background: #fff');
            if (!n.border)
                d.push('border-style: solid', `border-color: ${ctx.ds.line}`, 'border-width: 1px');
            d.push(`border-radius: ${rad.value}`);
            const c = ctx.cls(d.join(';\n  '));
            ctx.jsx.push(`${indent}<div className={styles.${c}} data-design-id="${escAttr(n.id)}" data-design-name="${designName}"${reuseAttr}>`
                + `<input className={styles.instInput} defaultValue=${jsxText(n.value ?? '')} aria-label="${escAttr(n.name)}" /></div>`);
            return;
        }
        if (tag === 'button') {
            if (!n.background)
                d.push(`background: ${/save|保存|确定|confirm|ok|submit|提交/i.test(n.value ?? '') ? ctx.ds.primary : '#fff'}`);
            if (!n.border)
                d.push('border-style: solid', `border-color: ${ctx.ds.line}`, 'border-width: 1px');
            d.push('display: flex', 'align-items: center', 'justify-content: center');
            d.push(`border-radius: ${radiusDecl(n, ctx.ds.radius).value}`);
            const c = ctx.cls(d.join(';\n  '));
            ctx.jsx.push(`${indent}<button type="button" className={styles.${c}} data-design-id="${escAttr(n.id)}" data-design-name="${designName}"${reuseAttr}`
                + ` onClick={() => onAction?.(${JSON.stringify(n.value ?? n.name)}, data)}>${jsxText(n.value ?? n.name)}</button>`);
            return;
        }
        if (tag === 'radio') {
            if (!n.border)
                d.push('border-style: solid', `border-color: ${ctx.ds.line}`, 'border-width: 1px');
            d.push('border-radius: 50%');
            const c = ctx.cls(d.join(';\n  '));
            ctx.jsx.push(`${indent}<input type="radio" className={styles.${c}} data-design-name="${designName}" name="design-radio-${inst}"${reuseAttr} />`);
            return;
        }
        if (tag === 'required') {
            d.push('color: #e64545', 'display: flex', 'align-items: center');
            const c = ctx.cls(d.join(';\n  '));
            ctx.jsx.push(`${indent}<span className={styles.${c}} data-design-name="${designName}" aria-hidden="true"${reuseAttr}>*</span>`);
            return;
        }
        d.push(`border-radius: ${radiusDecl(n, ctx.ds.radius).value}`);
        const c = ctx.cls(d.join(';\n  '));
        const iconRef = iconRefOf(n);
        ctx.jsx.push(`${indent}<span className={styles.${c}} data-design-id="${escAttr(n.id)}" data-design-name="${designName}"${iconRef ? ` data-icon-library="${escAttr(iconRef.name)}"` : ''}${reuseAttr}>${jsxText(n.value ?? (iconRef ? '' : n.name))}</span>`);
        return;
    }
    if (n.kind === 'icon') {
        const iconRef = iconRefOf(n);
        if (iconRef)
            ctx.instanceTodo.push(`- ${n.id} \`${n.name}\`：图标库 ${iconRef.name}；用项目图标组件/库中原 SVG，不要自绘路径`);
        else
            ctx.instanceTodo.push(`- ${n.id} \`${n.name}\`：没有图标库标识，先在项目图标库中确认映射，不要按名字猜或按路径临摹`);
        d.push('border-style: dashed', `border-color: ${ctx.ds.lineStrong}`, 'border-width: 1px', 'border-radius: 2px');
        const c = ctx.cls(d.join(';\n  '));
        ctx.jsx.push(`${indent}{/* 图标占位：使用项目图标库的 SVG，不要从 Figma 路径自绘 */}\n${indent}<div className={styles.${c}} data-design-id="${escAttr(n.id)}"${iconRef ? ` data-icon-library="${escAttr(iconRef.name)}"` : ''}${reuseAttr} aria-hidden="true" />`);
        return;
    }
    const c = ctx.cls(d.join(';\n  '));
    const visibleKids = n.children.filter((x) => x.raw.visible !== false);
    const kids = n.layout?.mode ? orderFlow(visibleKids, n) : visibleKids;
    if (!kids.length) {
        ctx.jsx.push(`${indent}<div className={styles.${c}} data-design-id="${escAttr(n.id)}"${reuseAttr} />`);
        return;
    }
    ctx.jsx.push(`${indent}<div className={styles.${c}} data-design-id="${escAttr(n.id)}"${reuseAttr}>`);
    for (let i = 0; i < kids.length; i++)
        emitNode(kids[i], n, `${indent}  `, ctx, i);
    ctx.jsx.push(`${indent}</div>`);
}
export function generateCode(model, opts) {
    const name = safeName(opts.componentName);
    const ds = inferDesignSystem(model);
    const outDir = resolve(opts.outputDir);
    mkdirSync(join(outDir, 'src'), { recursive: true });
    // ── 复用契约（席位A 冻结契约，只读消费）：设计节点 → 契约；空数组时全部行为退化为无复用 ──
    const reuseContracts = opts.reuseContracts ?? [];
    const reuseByNodeId = new Map();
    for (const c of reuseContracts) {
        if (c.designNodeId)
            reuseByNodeId.set(String(c.designNodeId), c);
    }
    const reuseFor = (n) => reuseByNodeId.get(n.id);
    // ── 组件化：顶层分区（section，页面骨架）+ 重复结构（repeat，可复用零件）= 单元组件，页面只负责组合 ──
    const maxExtract = Math.max(0, Number(opts.maxExtract ?? 3));
    const candidateRepeats = detectRepeats(model).filter((r) => r.count >= 3 && r.reusable !== false);
    const sections = reliableSections(model, detectSections(model));
    const allNodes = flat([model.tree]);
    // 锚点归属：section 先认领（顶层分区是主拆分），repeat 后认领；同一 id 只归一个组件，杜绝跨组件重复归属。
    const claimedIds = new Set();
    const claim = (ids) => {
        const mine = [];
        for (const id of ids) {
            if (claimedIds.has(id))
                continue;
            claimedIds.add(id);
            mine.push(id);
        }
        return mine;
    };
    const usedCompNames = new Set();
    const uniqueName = (base) => {
        let n = base;
        let i = 2;
        while (usedCompNames.has(n)) {
            n = `${base}V${i++}`;
        }
        usedCompNames.add(n);
        return n;
    };
    // 备注归属：annotation.targetId（或 variantIds）落在组件子树内 → 该组件承载
    const annotationIdsFor = (ids) => {
        const idSet = new Set(ids);
        return (model.annotations ?? [])
            .filter((a) => (a.targetId ? idSet.has(a.targetId) : false)
            || (a.variantIds ?? []).some((v) => idSet.has(v)))
            .map((a) => String(a.id ?? a.targetId ?? ''))
            .filter(Boolean);
    };
    const signatureCache = new Map();
    const sigOf = (n) => {
        const hit = signatureCache.get(n.id);
        if (hit)
            return hit;
        const build = (x, d) => {
            const base = d === 0 ? `${x.type}|${x.name}|h${x.h}` : `${x.type}|${x.name}`;
            if (d >= 2 || !x.children.length)
                return base;
            return `${base}[${x.children.map((c) => build(c, d + 1)).join(',')}]`;
        };
        const v = build(n, 0);
        signatureCache.set(n.id, v);
        return v;
    };
    const units = [];
    // ① 顶层分区作为单元组件（容器拼单元）；section 不可靠时这里为空 → 退回仅 repeat
    for (const s of sections) {
        const rep = allNodes.find((n) => n.id === s.id);
        if (!rep)
            continue;
        const ids = claim(subtreeDesignIds(model, s.id));
        if (!ids.length)
            continue;
        units.push({
            name: uniqueName(s.suggestedName || 'Section'),
            kind: 'section', rootId: s.id, designIds: ids,
            props: propsForSubtree(rep), label: s.name,
            count: 1, nodeCount: s.nodeCount, rep,
            annotationIds: annotationIdsFor(ids),
        });
    }
    // ② 重复结构（count≥3、maxExtract 上限）——可复用价值排序，signature 去重
    const pickedRepeats = [];
    const pickedSigs = new Set();
    for (const c of candidateRepeats) {
        if (pickedRepeats.length >= maxExtract)
            break;
        if (pickedSigs.has(c.signature))
            continue;
        pickedSigs.add(c.signature);
        pickedRepeats.push(c);
    }
    for (const g of pickedRepeats) {
        const rep = allNodes.find((n) => n.id === g.representativeId);
        if (!rep)
            continue;
        const ids = claim(subtreeDesignIds(model, g.representativeId));
        units.push({
            name: uniqueName(g.suggestedName),
            kind: 'repeat', rootId: g.representativeId, designIds: ids,
            props: g.props, label: g.name, count: g.count, nodeCount: g.nodeCount, rep,
            annotationIds: annotationIdsFor(ids),
        });
    }
    // 边界解析器：section 子树优先整体替换成 <Section/>，其次 repeat 子树替换成 <Repeat/>
    const sectionByRoot = new Map();
    const repeatBySig = new Map();
    for (const u of units) {
        if (u.kind === 'section')
            sectionByRoot.set(u.rootId, u);
        else
            repeatBySig.set(sigOf(u.rep), u);
    }
    const boundaryFor = (n) => sectionByRoot.get(n.id) ?? repeatBySig.get(sigOf(n));
    // ── tokens.ts ──
    const colors = Object.entries(model.tokens.colors).map(([k, v]) => `  '${k}': '${v}',`).join('\n');
    const fonts = Object.entries(model.tokens.fonts)
        .map(([k, v]) => `  '${k}': { family: '${v.family}', weight: '${v.weight}', size: ${v.size}${v.lineHeight ? `, lineHeight: '${v.lineHeight}'` : ''}${v.letterSpacing ? `, letterSpacing: '${v.letterSpacing}'` : ''} },`)
        .join('\n');
    writeFileSync(join(outDir, 'src', 'tokens.ts'), `// 由设计稿自动生成的设计令牌（dsh-design-to-code）\n// 注意：这里的色值是**设计稿 literal 值**，落项目时要映射到项目主题令牌（见 SPEC.md 第 2 节）。\n\nexport const designTokens = {\n  colors: {\n${colors}\n  },\n  fonts: {\n${fonts}\n  },\n  spacing: [${model.tokens.spacing.join(', ')}],\n  shadows: [${model.tokens.shadows.map((s) => `'${s}'`).join(', ')}],\n  /** 从设计数据投票得出的设计系统常量（用于重建实例占位） */\n  inferred: {\n    line: '${ds.line}',\n    text: '${ds.text}',\n    placeholder: '${ds.placeholder}',\n    primary: '${ds.primary}',\n    radius: ${ds.radius},\n    controlHeight: ${ds.controlH},\n  },\n};\n`, 'utf8');
    // ── types.ts ──
    writeFileSync(join(outDir, 'src', 'types.ts'), `// 组件契约（骨架版）：业务语义由需求 → CODEGEN_PROMPT.md 补全\n\nexport interface ${name}Props {\n  /** 初始表单值，key 用 data-design-name（设计稿控件名） */\n  initialData?: Record<string, string>;\n  onAction?: (action: string, data: Record<string, string>) => void;\n  onClose?: () => void;\n}\n`, 'utf8');
    // ── 组件 + CSS（递归渲染：auto-layout 直接出 flex） ──
    const cssRules = [`.root {\n  ${rootCssDecls(model).join(';\n  ')}\n}`];
    const jsx = [];
    const instanceTodo = [];
    let uid = 0;
    const ctx = {
        ds,
        css: cssRules,
        jsx,
        instanceTodo,
        cls: (decl) => {
            const id = `n${uid++}`;
            cssRules.push(`.${id} {\n  ${decl}\n}`);
            return id;
        },
        boundaryFor,
        reuseFor,
        uid: () => uid++,
    };
    const topKids = model.tree.children.filter((c) => c.raw.visible !== false);
    const orderedTop = model.tree.layout?.mode ? orderFlow(topKids, model.tree) : topKids;
    for (let i = 0; i < orderedTop.length; i++)
        emitNode(orderedTop[i], model.tree, '      ', ctx, i);
    cssRules.push(`.instInput {\n  width: 100%;\n  height: 100%;\n  box-sizing: border-box;\n  border: 0;\n  outline: 0;\n  padding: 0 12px;\n  background: transparent;\n  font: inherit;\n  color: inherit;\n}`);
    writeFileSync(join(outDir, 'src', `${name}.tsx`), `import { useState } from 'react';
import type { ${name}Props } from './types.js';
import styles from './${name}.module.css';
${units.map((u) => `import { ${u.name} } from './components/${u.name}';`).join('\n')}

/**
 * 由设计稿 ${model.nodeId} 生成的**几何骨架**。
 * 布局已按设计稿 auto-layout 输出 flex（gap/padding/justify/align/grow），
 * 只有 stackPositioning=ABSOLUTE 的子项才保留绝对定位。
 * 这是"设计准确"的起点，不是最终实现 —— 请按 CODEGEN_PROMPT.md
 * 把实例占位换成项目既有组件、色值映射主题令牌、补交互。
 */
export function ${name}({ initialData = {}, onAction, onClose }: ${name}Props) {
  const [data, setData] = useState<Record<string, string>>(initialData);
  void setData; void onClose;

  return (
    <div className={styles.root} style={{ width: ${model.width}, height: ${model.height} }}>
${jsx.join('\n')}
    </div>
  );
}

export default ${name};
`, 'utf8');
    writeFileSync(join(outDir, 'src', `${name}.module.css`), `${cssRules.join('\n\n')}\n`, 'utf8');
    // ── 套用骨架：有 shell 级复用契约时生成 src/${name}Shell.tsx；无 shell 契约时不生成（向后兼容）──
    let shellFile;
    const shellSrc = renderShellSkeleton(name, reuseContracts);
    if (shellSrc) {
        shellFile = join(outDir, 'src', `${name}Shell.tsx`);
        writeFileSync(shellFile, shellSrc, 'utf8');
    }
    // ── 单元组件文件：顶层分区（section）+ 重复结构（repeat）各出一个文件，带 props/锚点注释 ──
    const relComponents = [];
    const compRoot = join(outDir, 'src', 'components');
    const dirIndex = opts.projectLayout?.layout !== 'flat';
    const unitAnchors = new Map();
    for (const u of units) {
        const rep = u.rep;
        const styles = [];
        let cuid = 0;
        const cls = (decl) => { const id = `c${cuid++}`; styles.push(`.${id} { ${decl} }`); return id; };
        const lines = [];
        let propIdx = 0;
        const inner = flat([rep]).filter((x) => x.id !== rep.id);
        for (const x of inner) {
            const rel = `position: absolute; left: ${px(x.x - rep.x)}px; top: ${px(x.y - rep.y)}px; width: ${px(x.w)}px; height: ${px(x.h)}px; box-sizing: border-box;`;
            const isProp = (x.kind === 'text' && !!x.value) || (x.type === 'INSTANCE' && !!x.value);
            const propName = isProp && propIdx < u.props.length ? u.props[propIdx].name : undefined;
            if (isProp)
                propIdx++;
            if (x.kind === 'text') {
                const t = x.text;
                const st = `${rel} font-family: '${t.family}', system-ui, sans-serif; font-size: ${t.size}px; font-weight: ${t.weight};${t.italic ? ' font-style: italic;' : ''}${t.lineHeight ? ` line-height: ${t.lineHeight};` : ''}${t.color ? ` color: ${t.color};` : ''} white-space: pre; overflow: visible;`;
                const c = cls(st);
                lines.push(`      <span className={styles.${c}} data-design-id="${escAttr(x.id)}">${propName ? `{${propName}}` : jsxText(x.value ?? '')}</span>`);
                continue;
            }
            if (x.type === 'INSTANCE') {
                const c = cls(`${rel} ${x.border ? `border-style: ${x.border.dash?.length ? 'dashed' : 'solid'}; border-color: ${x.border.color}; border-width: ${px(x.border.top)}px ${px(x.border.right)}px ${px(x.border.bottom)}px ${px(x.border.left)}px;` : `border: 1px solid ${ds.line};`} border-radius: ${x.radius ?? `${ds.radius}px`}; background: ${x.background ?? '#fff'};`);
                const val = propName ? `{${propName}}` : jsxText(x.value ?? '');
                lines.push(`      <div className={styles.${c}} data-design-id="${escAttr(x.id)}"><input className={styles.instInput} defaultValue=${val} aria-label="${escAttr(x.name)}" /></div>`);
                continue;
            }
            const c = cls(rel + (x.background ? ` background: ${x.background};` : '') + (x.kind === 'ellipse' ? ' border-radius: 50%;' : x.radius ? ` border-radius: ${x.radius};` : ''));
            lines.push(`      <div className={styles.${c}} data-design-id="${escAttr(x.id)}" />`);
        }
        const propsDecl = u.props.length
            ? u.props.map((pr) => `  /** 设计文案默认值：${pr.sample} */\n  ${pr.name}?: string;`).join('\n')
            : '  // 该单元组件无文案入参（静态几何，文案内联；按对比锚点核对）';
        const defaults = u.props.map((pr) => `  ${pr.name} = ${JSON.stringify(pr.sample)},`).join('\n');
        unitAnchors.set(u.name, u.designIds);
        const anchorLines = u.designIds.length
            ? ` * 对比锚点（data-design-id，逐组件跑 figma_visual_diff(node_id=...) 时按此集合过滤）：\n *   ${u.designIds.join(', ')}`
            : ' * 对比锚点：无（该结构的锚点由所属顶层分区组件覆盖）';
        const kindLabel = u.kind === 'section' ? '顶层分区' : `重复结构，共出现 ${u.count} 次，子树 ${u.nodeCount} 节点`;
        const tsx = `import type { FC } from 'react';
import styles from './${u.name}.module.css';

/**
 * 由设计稿${kindLabel}抽取的**单元组件**（设计图层「${u.label}」）。
${anchorLines}
 * 这段几何来自设计数据；保持组件边界（不要拆散回页面），落实现时把内部控件换成项目既有组件
 * （见 component-plan.md 的复用清单），数据/文案从 props 进、事件用回调出。
 */
export interface ${u.name}Props {
${propsDecl}
}

export const ${u.name}: FC<${u.name}Props> = ({
${defaults}
}) => (
  <div className={styles.root}>
${lines.join('\n') || '      {/* 该结构无可渲染子节点 */}'}
  </div>
);

export default ${u.name};
`;
        const cssOut = `.root { position: relative; width: 100%; height: ${px(rep.h)}px; overflow: hidden; }
.instInput { width: 100%; height: 100%; box-sizing: border-box; border: 0; outline: 0; padding: 0 12px; background: transparent; font: inherit; color: inherit; }
${styles.join('\n')}
`;
        const dir = dirIndex ? join(compRoot, u.name) : compRoot;
        mkdirSync(dir, { recursive: true });
        const tsxPath = dirIndex ? join(dir, 'index.tsx') : join(dir, `${u.name}.tsx`);
        writeFileSync(tsxPath, tsx, 'utf8');
        writeFileSync(join(dir, `${u.name}.module.css`), cssOut, 'utf8');
        relComponents.push(tsxPath);
    }
    if (relComponents.length) {
        const barrel = join(compRoot, 'index.ts');
        if (existsSync(barrel)) {
            const cur = readFileSync(barrel, 'utf8');
            const add = units
                .filter((u) => !cur.includes(`/${u.name}'`) && !cur.includes(`./${u.name}`))
                .map((u) => `export { ${u.name} } from './${u.name}';`)
                .join('\n');
            if (add)
                writeFileSync(barrel, `${cur}\n${add}\n`, 'utf8');
        }
    }
    writeFileSync(join(outDir, 'src', 'index.ts'), `export { ${name} } from './${name}.js';\nexport type { ${name}Props } from './types.js';\n`, 'utf8');
    writeFileSync(join(outDir, 'design-spec.json'), JSON.stringify(model, null, 2), 'utf8');
    // ── CODEGEN_PROMPT.md ──
    const round = Math.max(1, opts.round ?? 1);
    const P = [];
    P.push(`# Codegen Prompt（需求 → 最终代码）· 第 ${round} 轮`, '');
    P.push(`设计稿已提取为 \`design-spec.json\`（含逐节点规格表与属性来源台账），骨架见 \`src/${name}.tsx\`。`);
    if (opts.staticPagePath) {
        P.push('', `**视觉基准**：\`${opts.staticPagePath}\`（由设计数据逐节点生成的 1:1 静态还原页，已按 auto-layout 出 flex）。`);
        P.push(`同一目录下还有 **绝对定位对照页** \`abs.html\` 与 \`abs-vs-flex.json\`（布局推演差异）：`);
        P.push('如果实现与基准对不上，先看差异是否只在 abs.html 成立 —— 那是"布局翻译"问题，不是设计数据问题。');
    }
    P.push('', '## 需求', opts.requirements);
    P.push('', '## 项目约定', opts.conventions);
    if (opts.componentPlanMd) {
        P.push('', '## 组件化方案（复用优先 / 无则组件化 / 落点按项目实际）', '', opts.componentPlanMd.trim(), '');
    }
    // 组件边界契约：每个单元组件的 文件 / props 契约 / data-design-id 锚点 / 承载备注 id。
    // 空数据（无 section、无 repeat）时省略整段，不制造空契约。
    if (units.length) {
        P.push('', '## 组件边界契约（保持单元组件边界，逐组件跑 figma_visual_diff(node_id=...) 对比）', '');
        P.push('主容器 `src/${name}.tsx` 只负责组合：顶层分区/重复结构已生成独立单元组件文件，主容器用 `<组件名/>` 占位。');
        P.push('实现时**必须保持这些组件边界**（不要把某个单元组件拆散回页面里手写）；每个组件按自己的锚点逐个对比：', '');
        P.push('| 单元组件 | 文件路径 | props 契约 | 对比锚点（data-design-id） | 承载备注 id |');
        P.push('|---|---|---|---|---|');
        for (const u of units) {
            const file = `src/components/${u.name}${dirIndex ? '/index.tsx' : '.tsx'}`;
            const props = u.props.length ? u.props.map((p) => `${p.name}?: string`).join(', ') : '无（静态几何单元）';
            const ids = u.designIds.join(', ') || '—';
            const anns = u.annotationIds.join(', ') || '—';
            P.push(`| ${u.name} | \`${file}\` | ${props.replace(/\|/g, '\\|')} | ${ids} | ${anns} |`);
        }
        P.push('');
        P.push('逐组件对比：`figma_visual_diff(output_dir=…, impl=<你的实现页>, node_id=<该组件根 data-design-id>)`，');
        P.push('工具会据完整设计树算出该节点的后代锚点集合，只把 spec.rows 的这一子集拿去比对——细节偏差不再淹没在整页里。');
        P.push('node_id 支持 dash/colon 两种写法（如 `110-854` / `110:854`）；对所有单元组件逐个跑完才算完成机器回归。', '');
    }
    // 壳/组件级复用契约段：与《组件边界契约》同源同序，空数组时整段省略
    if (reuseContracts.length)
        P.push(...renderReuseContractsSection(reuseContracts));
    if (opts.auditMd) {
        P.push('', '## 设计审计核对清单（逐项勾选；"真歧义"才需要问人，"数据缺失"按兜底规则做）', '', '```markdown', opts.auditMd.trim(), '```', '');
    }
    if (model.annotations.length) {
        P.push('', '## 设计备注 = 交互说明（必须按原文实现，不是视觉元素）', '');
        P.push('画布红字备注已从基准页移除；下面每一条都是**行为要求**。必须按下表逐条落实，单元格留空即未完成：', '');
        P.push('| 备注 | 承载 props/state | 事件 | 真实控件/行为 | 文件 | 验证 |');
        P.push('|---|---|---|---|---|---|');
        for (const [i, a] of model.annotations.entries()) {
            const disp = a.disposition === 'candidate' ? '候选·待确认' : '自动';
            const cell = `备注${i + 1}「${a.title}」：${a.text.replace(/\n+/g, ' / ')}（置信度 ${fmtConf(a.confidence)} · ${disp} · 信号 ${fmtSignals(a.signals)}）`;
            P.push(`| ${cell.replace(/\|/g, '\\|')} |  |  |  |  |  |`);
        }
        P.push('');
        P.push('把原文语义翻译成具体代码的示例（照着做，不是抄成注释）：');
        P.push('- 「自动激活其他日期」→ 激活态 state（如 activeDate）+ 各日期单元格的 onClick，点选后同步高亮；');
        P.push('- 「仅点击后才可编辑」→ editable 布尔 state + 点击守卫：未进入编辑态渲染只读，点击后才切换为 input；');
        P.push('- 「日期范围显示在组件里」→ 把范围值作为 props 传入并绑定到展示节点，不在组件内硬编码。');
        P.push('处置为「候选·待确认」的备注先标记待确认、不得静默丢弃，确认后再补齐上表；scope=unassigned 或无适用组件的先找人确认作用范围。');
        P.push('');
    }
    // 需求文档里的交互点 ↔ UI 设计上的交互标注：三方对照，逐条落实，两侧都不许静默遗漏。
    // 由独立纯函数生成，空内容时返回空串，此处跳过。
    const crosswalk = renderRequirementsCrosswalk(opts.requirements, model.annotations);
    if (crosswalk)
        P.push('', crosswalk);
    if (model.titles?.length) {
        P.push('', '## 设计标题（用于组件命名 + 可访问性标题）', '');
        P.push('下列标题来自设计数据（text/source/level/证据节点），文本是真实 UI、基准页已正常渲染。逐条对照：');
        P.push('1. 作为组件/分区命名依据（source=prominentText 优先，其次 frameName / annotationTitle）；');
        P.push('2. 作为可访问性标题：level=page 用 `<h1>`/页面标题，level=section 用 `<h2>`/分区标题，并写进 aria-label；');
        P.push('3. 按证据节点核对文案、字号与位置，不要臆造或改写标题文本。', '');
        P.push('| # | 标题文本 | 来源 | 级别 | 证据节点 | 置信度 | 信号 |');
        P.push('|---|---|---|---|---|---|---|');
        model.titles.forEach((t, i) => {
            const ev = [
                t.nodeId ? `节点 ${t.nodeId}` : '',
                t.x != null && t.y != null && t.w != null && t.h != null ? `@(${t.x},${t.y}) ${t.w}×${t.h}` : '',
                t.fontSize != null ? `${t.fontSize}px` : '',
            ].filter(Boolean).join(' ') || '-';
            P.push(`| ${i + 1} | ${String(t.text).replace(/\|/g, '\\|')} | ${escText(t.source)} | ${escText(t.level)} | ${ev} | ${fmtConf(t.confidence)} | ${fmtSignals(t.signals).replace(/\|/g, '\\|')} |`);
        });
        P.push('');
    }
    P.push('', '## 逐节点规格表（id | name | type | x | y | w | h | 背景 | 描边(四边) | 虚线 | 圆角 | 字体 | 文案 | layout）', '', '```', specTable(model, 500), '```', '');
    // 细节核对表：设计 literal 自动填表，data-guessed / suspects 标存疑
    const suspects = suspectsOf(model);
    P.push('', '## 细节核对表（机器可判定项：实测值填进「实测手段」列，超容差即返工）', '');
    P.push('「设计值」列是 design-spec.json 的 literal（来自 model.spec / tokens），不是近似值；禁止靠肉眼或从截图取样。');
    P.push('标「存疑·需确认，不得静默套用」的行来自 data-guessed（prov=placeholder/inferred）或设计数据存疑项，须先确认再落代码。');
    P.push('| 属性 | 设计值 | 容差 | 实测手段 |');
    P.push('|---|---|---|---|');
    P.push(...detailChecklist(model));
    P.push('');
    if (suspects.length) {
        P.push('', `## 设计数据存疑项 ${suspects.length} 条，逐条挂起确认`, '');
        P.push('下列值来自推断/缺失兜底，**不得静默套用**；每条先向设计/需求确认，确认后再落代码。');
        P.push('| 节点 | 属性 | 推断值 | 依据 | 建议动作 |');
        P.push('|---|---|---|---|---|');
        for (const s of suspects.slice(0, 120)) {
            P.push(`| ${cellOf(s.nodeId ?? s.name ?? '-')} | ${cellOf(s.property ?? '-')} | ${cellOf(s.guessedValue ?? '-')} | ${cellOf(s.basis ?? '-')} | ${cellOf(s.action ?? '-')} |`);
        }
        P.push('', `（共 ${suspects.length} 条；同步见「细节核对表」中被标注的行。）`, '');
    }
    if (instanceTodo.length) {
        P.push('', '## 实例与图标清单（恢复 derived 数据后仍要用项目组件/图标库替换）', '', ...instanceTodo.slice(0, 120));
    }
    P.push('', '## 必做', '1. **先看基准页**：`index.html`/`SPEC.md` 是视觉与规格基准，逐条对齐；', '2. **占位换组件**：把 `data-design-name` 标记的占位换成项目既有组件（Input/Select/DatePicker/Button…），', '   不要自己重画控件；设计给的尺寸/逐角圆角/文案要保留；', '3. **保持 auto-layout 结构**：骨架已按设计稿输出 `display:flex` 或 Grid 的 `display:grid`，含两轴 gap/padding/justify/align/grow；', '   不要改回绝对定位，也不要把 Grid 改成 flex；只有 `stackPositioning=ABSOLUTE` 的子项才是绝对定位；', '4. **色值策略：先查同名令牌，无同名令牌：直接写 literal**：`tokens.ts` 里是设计稿 literal 值；', '   先查项目主题里有没有**同名令牌**，有就映射到该令牌；', '   **无同名令牌：直接写 literal**——把设计 literal 色值原样写进样式，并加注释标注来源（如 `/* design: #666 (node 51:xx) */`）；', '   不要近似替换、不要从截图取样、不要把不同色硬套同一令牌；', '5. **逐边描边/逐角圆角/虚线**：`border-width` 分边写；dashPattern 用 `repeating-linear-gradient` 或 SVG stroke（CSS dashed 段长不可控）；', '6. **图标必须使用项目/图标库的 SVG**：带 `data-icon-library` 的节点按标识精确匹配；没有标识的先确认映射。', '   不许按 Figma 路径自绘，也不许凭图层名猜一个相似图标；', '7. **交互控件必须真实功能**（禁止静态假控件；逐条按 `SPEC.md` 0.1 备注映射表 / 下文 `## 设计备注 = 交互说明` 落实交互说明）：', '   - 日期/时间选择器：可点击，点选后更新激活态 state（如 activeDate/selectedRange），并把选中范围绑定到组件展示；', '   - 播放器：必须真实播放（`<audio>`/`<video>` 或媒体库实例），带可拖动进度条（seek），不是画一个播放三角；', '   - 进度条：绑定真实进度值（state/props），随媒体 currentTime 或业务数据更新，不许写死宽度；', '   受控表单、校验、按钮动作、关闭（Esc/遮罩）、可访问性照做；输出 `src/${name}.tsx`、`src/types.ts`、逻辑 hooks、必要测试；', '8. 类型安全、不引入第三方运行时依赖；', '9. **设计备注逐条落实**：`## 设计备注 = 交互说明` 的强制映射表每行都要填满「承载 props/state | 事件 | 真实控件/行为 | 文件 | 验证」，空着即未完成；候选备注先标待确认、不得静默丢弃；', '   交付说明逐条回答承载字段、实现文件、验证方式。只抄成注释或静默忽略都算未完成。', '10. **设计标题逐条对照**：`## 设计标题` 每条用于组件/分区命名与可访问性标题（page→h1、section→h2），按证据节点核对文案与字号，不臆造、不改写、不遗漏。', ...(reuseContracts.length ? [
        '11. **壳/组件级复用（三层统一）**：命中《壳/组件级复用契约》的节点按契约复用项目既有组件——',
        '    ① shell 级**不重画外壳**，只实现「需实现的内容区(节点ID)」并套入契约的 slot/children；',
        '    ② control/business 级节点复用项目组件，**禁止自绘**控件（Input/Select/Tag/Drawer/Modal…）；',
        '    ③ **suspected 先确认**：suspected 条目先确认再落代码，不得静默套用；',
        '    ④ 同一节点既在《组件边界契约》又在本表时**以本表为准**（项目组件提供，不再生成单元组件）；',
        '    ⑤ nested 逐层套：按 nested 顺序由外到内嵌套项目组件与其 slot。',
        '    骨架见 `src/${name}Shell.tsx`（有 shell 契约时生成），data-reuse-role/content/control 标注即实现落点。',
    ] : []), '', '## 已知占位（不是实现缺陷，不要"修"它）', '- 带 `data-src="placeholder"` / `data-guessed` 的元素是设计数据缺失处（实例内部、矢量图标、位图）；', '- 替换成项目组件即可；**不要为了"对齐截图"去编造颜色/图标/内部结构**。', '', '## 验证闭环（不做完不算完成）', '1. 按审计清单逐项勾选，**每项写清"在哪个文件哪一行实现的"**；', '2. 组件渲染截图 ↔ 基准图（static/index@2x.png）并排对照，差异逐条列出并修掉；', '3. 逐边描边、逐角圆角、控件高度这几类**必须用实测数值核对**（computed style），不要靠肉眼；', '   **必须跑 figma_visual_diff**（逐节点 expected/actual/Δ 的机器对照），存证对照结果后再交人看；', '   对已生成的单元组件（顶层分区/重复结构），要**逐个跑** `figma_visual_diff(node_id=<该组件根 data-design-id>)`，', '   只比对该组件子树，避免细节偏差淹没在整页里；全部单元组件跑完才算完成机器回归；', '4. **细节核对表逐项实测**：填完上文「细节核对表」实测列，色值/字号行高/gap/逐边描边/逐角圆角/文案偏差超容差即返工；', '5. **必须过一轮 UI 专家审计**（涉及 UI 的交付一律如此）：', '   `summon_expert("UI 视觉验收设计师", 任务)` —— 任务里带设计基准图 static/index@2x.png、', '   设计规格 static/SPEC.md、以及你的组件截图（同尺寸/缩放），要求"逐条给出 问题/位置/期望/实际/级别"；', '   然后 `figma_review_to_round(output_dir, review=<专家原文>, reviewer="UI 视觉验收设计师")`；', '6. 专家会产出**标注图**（问题按 id 钉在基准图上）与**打回清单**；判定为 reject 时：', '   逐条修复 → `action="close"` 关闭 → **再提审一轮拿 pass**（开发自述"改完了"不算通过）；', '7. 把查到的项目既有模式沉淀成可复用事实；', '8. 设计备注 + 设计标题逐条对照：备注按强制映射表填满「承载 props/state | 事件 | 真实控件/行为 | 文件 | 验证」，候选（待确认）先标记再落实、不得静默丢弃；标题逐条核对命名与可访问性标题（page→h1、section→h2）及证据节点；确实无法实现的要显式说明原因，不能静默跳过。', ...(reuseContracts.length ? [
        '9. **复用契约逐条核验**：按《壳/组件级复用契约》表逐条核对——',
        '    ① shell 外壳未重画、内容区已套入 slot/children；② control/business 节点复用项目组件、无自绘控件；',
        '    ③ suspected 条目已确认（未确认即未完成）；④ 与《组件边界契约》重叠处按本表实现、未生成重复单元组件；',
        '    ⑤ nested 层级与契约一致；并在 `src/${name}Shell.tsx` 与节点的 data-reuse-contract 标注处核对实现落点。',
    ] : []));
    writeFileSync(join(outDir, 'CODEGEN_PROMPT.md'), P.join('\n'), 'utf8');
    writeFileSync(join(outDir, 'README.md'), `# ${name}

由 dsh-design-to-code 从设计稿节点 \`${model.nodeId}\` 生成（零 REST API）。

- 视觉基准：\`SPEC.md\`（规格 + 台账 + 映射表）与静态还原页（由 \`figma_render_static\` 产出）
- 布局：按设计稿 auto-layout 生成 flex；\`abs.html\` 为绝对定位对照
- 设计令牌：\`src/tokens.ts\`（设计 literal 值，落项目要映射主题令牌）
- 几何骨架：\`src/${name}.tsx\` + \`src/${name}.module.css\`（主容器只负责组合单元组件）
- 单元组件：\`src/components/\`（顶层分区 + 重复结构各出一个文件；文件头注释写了各自的 data-design-id 对比锚点）
- 逐组件对比：对每个单元组件跑 \`figma_visual_diff(output_dir=…, impl=<实现页>, node_id=<该组件根 data-design-id>)\`，只比对该组件子树，避免细节偏差淹没在整页里；node_id 支持 dash/colon 两种写法
- 补全指引：\`CODEGEN_PROMPT.md\`（见「组件边界契约」段）
`, 'utf8');
    return [
        ...relComponents,
        join(outDir, 'design-spec.json'),
        join(outDir, 'src', 'tokens.ts'),
        join(outDir, 'src', 'types.ts'),
        join(outDir, 'src', `${name}.tsx`),
        join(outDir, 'src', `${name}.module.css`),
        ...(shellFile ? [shellFile] : []),
        join(outDir, 'src', 'index.ts'),
        join(outDir, 'CODEGEN_PROMPT.md'),
        join(outDir, 'README.md'),
    ];
}
export function summarizeAudit(a) {
    return `节点 ${a.nodeCount}（实例 ${a.instanceCount}）· 核对项 ${a.checklist.length} · 真歧义 ${a.ambiguous.length} · 数据缺失 ${a.missing.length}`;
}
//# sourceMappingURL=codegen.js.map