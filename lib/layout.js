const JUSTIFY = {
    MIN: 'flex-start',
    CENTER: 'center',
    MAX: 'flex-end',
    SPACE_BETWEEN: 'space-between',
};
const ALIGN = {
    MIN: 'flex-start',
    CENTER: 'center',
    MAX: 'flex-end',
    BASELINE: 'baseline',
    STRETCH: 'stretch',
};
export const isHorizontal = (mode) => String(mode ?? '').toUpperCase() === 'HORIZONTAL';
/**
 * flex 流里的**渲染顺序**：按设计坐标的主轴位置排，而不是按图层数组顺序。
 * 实测有些容器（如 132:9418）子项数组顺序与 x 顺序相反（z-order 与布局顺序不一致），
 * 按数组渲染会把两个子项左右调换 —— 与设计坐标不符。
 */
export function orderFlow(kids, parent) {
    const row = isHorizontal(parent.layout?.mode);
    return kids
        .map((c, i) => ({ c, i }))
        .sort((a, b) => (row ? a.c.x - b.c.x : a.c.y - b.c.y) || a.i - b.i)
        .map((x) => x.c);
}
/** 子项是否在父容器的 flex 流里（绝对子项 / 父容器不是 auto-layout 时不在） */
export function flowsInParent(child, parent) {
    if (!parent?.layout?.mode)
        return false;
    if (child.layout?.absolute)
        return false;
    return true;
}
/**
 * 容器四边实际从"盒边界"到"内容起点"的距离。
 *
 * Figma 的 `bordersTakeSpace=true` 表示**描边占空间**（内容整体让开 border），
 * 而我们把描边画成 inset shadow（不占布局）——所以必须把 border 宽度折算进 padding，
 * 否则子项会整体偏 border 宽度（实测 132:8223：x/y 各偏 1px、宽偏 0.67px）。
 */
export function contentInsets(n) {
    const l = n.layout;
    const t = Number(l?.paddingTop ?? 0);
    const r = Number(l?.paddingRight ?? 0);
    const b = Number(l?.paddingBottom ?? 0);
    const le = Number(l?.paddingLeft ?? 0);
    const bd = n.border;
    const takes = !!(l?.bordersTakeSpace && bd);
    return [
        t + (takes ? Number(bd.top || 0) : 0),
        r + (takes ? Number(bd.right || 0) : 0),
        b + (takes ? Number(bd.bottom || 0) : 0),
        le + (takes ? Number(bd.left || 0) : 0),
    ];
}
/** 容器自身的 flex 声明（不含定位） */
export function flexDecls(n) {
    const l = n.layout;
    if (!l?.mode)
        return [];
    const row = isHorizontal(l.mode);
    const d = ['display: flex', `flex-direction: ${row ? 'row' : 'column'}`];
    // CSS 的 gap 不接受负值；Figma 里负 spacing 表示"重叠"，用子项负 margin 表达（见 flowChildDecls）
    if (l.spacing && l.spacing > 0)
        d.push(`gap: ${num(l.spacing)}px`);
    const [pt, pr, pb, pl] = contentInsets(n);
    if (pt || pr || pb || pl)
        d.push(`padding: ${num(pt)}px ${num(pr)}px ${num(pb)}px ${num(pl)}px`);
    d.push(`justify-content: ${JUSTIFY[String(l.primaryAlign ?? 'MIN').toUpperCase()] ?? 'flex-start'}`);
    d.push(`align-items: ${ALIGN[String(l.counterAlign ?? 'MIN').toUpperCase()] ?? 'flex-start'}`);
    if (l.wrap && String(l.wrap).toUpperCase() === 'WRAP')
        d.push('flex-wrap: wrap');
    return d;
}
/** 子项在父 flex 流里的声明（不含尺寸/背景） */
export function flowChildDecls(child, parent, index = 0) {
    const d = ['position: relative'];
    const row = isHorizontal(parent.layout?.mode);
    const grow = Number(child.layout?.childGrow ?? 0);
    const basis = row ? child.w : child.h;
    // 关键：**设计尺寸当 flex-basis**，grow 只负责分配剩余空间。
    // 若用 `flex: 1 1 0`，等比子项会被强行拉成等宽，与设计稿的固定宽度对不上（实测差 15–28px）。
    if (grow > 0) {
        // shrink=0：设计宽度就是最终宽度，宁可撑进 padding 也不压缩
        //（实测：容器声明了右 padding 但设计几何并没有留，只要允许收缩就会少 28px）
        d.push(`flex: ${grow} 0 ${num(basis)}px`);
        d.push(row ? 'min-width: 0' : 'min-height: 0');
    }
    else {
        d.push(`flex: 0 0 ${num(basis)}px`);
    }
    const negGap = Number(parent.layout?.spacing ?? 0);
    if (negGap < 0 && index > 0)
        d.push(row ? `margin-left: ${num(negGap)}px` : `margin-top: ${num(negGap)}px`);
    const self = String(child.layout?.childAlignSelf ?? '').toUpperCase();
    if (self === 'STRETCH')
        d.push('align-self: stretch');
    else if (self && self !== 'AUTO')
        d.push(`align-self: ${ALIGN[self] ?? 'auto'}`);
    return d;
}
function num(v) {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0';
}
/**
 * 按 flex 规则推演子项位置，与设计坐标比对。
 * 只检查"在流里"的子项；绝对子项按 left/top 天然一致，不参与。
 */
export function verifyFlexPlan(model, tol = 1) {
    const mismatches = [];
    let containers = 0;
    let flowChildren = 0;
    const walk = (n) => {
        if (n.raw.visible === false)
            return;
        if (n.layout?.mode && n.children.length) {
            containers += 1;
            const row = isHorizontal(n.layout.mode);
            const [padT, padR, padB, padL] = contentInsets(n);
            const innerMain = row ? n.w - padL - padR : n.h - padT - padB;
            const gap = Number(n.layout.spacing ?? 0);
            const flow = orderFlow(n.children.filter((c) => c.raw.visible !== false && flowsInParent(c, n)), n);
            flowChildren += flow.length;
            const growers = flow.filter((c) => Number(c.layout?.childGrow ?? 0) > 0);
            const allMain = flow.reduce((s, c) => s + (row ? c.w : c.h), 0);
            const free = Math.max(0, innerMain - allMain - gap * Math.max(0, flow.length - 1));
            const growEach = growers.length ? free / growers.length : 0;
            const justify = String(n.layout.primaryAlign ?? 'MIN').toUpperCase();
            const usedMain = allMain + gap * Math.max(0, flow.length - 1);
            const leftover = Math.max(0, innerMain - usedMain);
            let cursor = row ? padL : padT;
            if (!growers.length) {
                if (justify === 'CENTER')
                    cursor += leftover / 2;
                else if (justify === 'MAX')
                    cursor += leftover;
                else if (justify === 'SPACE_BETWEEN' && flow.length > 1)
                    cursor += 0; // gap 已近似
            }
            for (const c of flow) {
                const base = row ? c.w : c.h;
                const mainSize = Number(c.layout?.childGrow ?? 0) > 0 ? base + growEach : base;
                const crossStart = row ? padT : padL;
                const crossAvail = row ? n.h - padT - padB : n.w - padL - padR;
                const crossSize = row ? c.h : c.w;
                const align = String(n.layout.counterAlign ?? 'MIN').toUpperCase();
                const rawOffset = align === 'CENTER' ? (crossAvail - crossSize) / 2 : align === 'MAX' ? crossAvail - crossSize : 0;
                const crossOffset = Math.max(0, rawOffset);
                const actual = row
                    ? { x: n.x + cursor, y: n.y + crossStart + crossOffset, w: mainSize, h: crossSize }
                    : { x: n.x + crossStart + crossOffset, y: n.y + cursor, w: crossSize, h: mainSize };
                const expected = { x: c.x, y: c.y, w: c.w, h: c.h };
                const delta = [
                    Math.round(actual.x - expected.x),
                    Math.round(actual.y - expected.y),
                    Math.round(actual.w - expected.w),
                    Math.round(actual.h - expected.h),
                ];
                if (delta.some((v) => Math.abs(v) > tol)) {
                    mismatches.push({ id: c.id, name: c.name, containerId: n.id, expected, actual, delta });
                }
                cursor += mainSize + gap;
            }
        }
        for (const c of n.children)
            walk(c);
    };
    walk(model.tree);
    return { containers, flowChildren, mismatches };
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
export function borderPaint(b, baseShadow) {
    if (!b)
        return { decls: baseShadow ? [`box-shadow: ${baseShadow}`] : [], fallback: false };
    const sides = [b.top, b.right, b.bottom, b.left];
    const uniform = sides.every((v) => v === sides[0]) && sides[0] > 0;
    const align = String(b.align ?? 'INSIDE').toUpperCase();
    if (b.dash?.length) {
        if (!uniform) {
            const d = [
                `border-style: dashed`, `border-color: ${b.color}`,
                `border-width: ${sides[0]}px ${sides[1]}px ${sides[2]}px ${sides[3]}px`,
            ];
            if (baseShadow)
                d.push(`box-shadow: ${baseShadow}`);
            return { decls: d, fallback: true };
        }
        const w = sides[0];
        return { decls: [`outline: ${w}px dashed ${b.color}`, `outline-offset: ${-w}px`], fallback: false };
    }
    const parts = [];
    if (uniform) {
        // INSIDE/OUTSIDE 靠正负 spread 区分；CENTER 取一半内一半外
        const w = sides[0];
        if (align === 'OUTSIDE')
            parts.push(`0 0 0 ${w}px ${b.color}`);
        else if (align === 'CENTER')
            parts.push(`0 0 0 ${w / 2}px ${b.color}`, `inset 0 0 0 ${w / 2}px ${b.color}`);
        else
            parts.push(`inset 0 0 0 ${w}px ${b.color}`);
    }
    else {
        // 逐边：用单边 inset 阴影拼（INSIDE 语义）
        if (b.top)
            parts.push(`inset 0 ${b.top}px 0 0 ${b.color}`);
        if (b.right)
            parts.push(`inset -${b.right}px 0 0 0 ${b.color}`);
        if (b.bottom)
            parts.push(`inset 0 -${b.bottom}px 0 0 ${b.color}`);
        if (b.left)
            parts.push(`inset ${b.left}px 0 0 0 ${b.color}`);
    }
    if (baseShadow)
        parts.push(baseShadow);
    return { decls: parts.length ? [`box-shadow: ${parts.join(', ')}`] : [], fallback: false };
}
/**
 * 圆角声明（基准页与骨架共用的唯一实现）。
 * 设计有值就用；没有才按拼接角色推：中间格方角 / 两端格只留外侧圆角 / 其余回落设计系统圆角。
 * 以前只有基准页跑这段，骨架 `if (n.radius)` → 32 个实例出现"基准 8px、骨架直角"。
 */
export function radiusDecl(n, dsRadius) {
    if (n.radius)
        return { value: n.radius, guessed: false };
    const role = n._joinRole;
    if (role === 'mid')
        return { value: '0px', guessed: true };
    if (role === 'leftEnd')
        return { value: `${dsRadius}px 0px 0px ${dsRadius}px`, guessed: true };
    if (role === 'rightEnd')
        return { value: `0px ${dsRadius}px ${dsRadius}px 0px`, guessed: true };
    return { value: `${dsRadius}px`, guessed: true };
}
/** 根节点（#frame / .root）的声明：根自己也可能有 auto-layout，必须有 display:flex */
export function rootCssDecls(model) {
    const r = model.tree;
    const d = ['position: relative', 'margin: 0'];
    d.push(...borderPaint(r.border, r.shadow).decls);
    if (r.background)
        d.push(`background: ${r.background}`);
    if (r.radius)
        d.push(`border-radius: ${r.radius}`);
    if (r.opacity != null)
        d.push(`opacity: ${r.opacity}`);
    d.push(r.clips === false ? 'overflow: visible' : 'overflow: hidden');
    if (r.layout?.mode)
        d.push(...flexDecls(r));
    return d;
}
//# sourceMappingURL=layout.js.map