/**
 * DesignModel：把 dsh-figma-reader 解码出的 Kiwi 节点 JSON 提炼成
 * 可供「静态还原 / 审计 / 代码生成」共用的结构化设计模型。
 *
 * 输入格式：`{ fileKey, nodeId, node, descendants }`（figma_read_node_ws / CLI 产物）。
 *
 * ── 数据读取的六个坑（都是实测踩出来的，改动前请先读 ADR 段注释） ──
 * 1. transform 是**相对父节点**的；根节点自身还带着画布坐标（如 6119/4653）。
 *    必须"根节点归零 + 逐层累加"，否则生成物整体跑到画布外（历史 bug：组件渲染成空白）。
 * 2. `strokeWeight` 在 Kiwi 里是**带默认值的标量**（364 个节点里 281 个 =1），
 *    不能当"有描边"的证据；要看 `strokePaints`/`strokeGeometry`。
 * 3. 描边可能是**逐边**的：`borderStrokeWeightsIndependent=true` + `borderLeft/Right/Top/BottomWeight`。
 *    设计稿"只有左边框"就是这么表达的，统一按 strokeWeight 读会变成四边框。
 * 4. 圆角可能是**逐角**的：`rectangleCornerRadiiIndependent` + `rectangle*CornerRadius`。
 *    拼接控件组"两端圆角 8、中间直角"就靠它。
 * 5. 实例（INSTANCE）在 ws.json 里**没有 children、没有 fillPaints/strokePaints**：内部结构拿不到。
 *    能拿到的只有 size / cornerRadius / 逐角圆角 / 以及**覆写文案**
 *    `symbolData.symbolOverrides[].textData.characters`（如 "Please Input"）。
 * 6. auto-layout 的 `stackMode/stackSpacing/stackPadding*` 都在数据里，
 *    绝对定位只是"静态还原"的手段；落到组件时应转成 flex（见 render-static / codegen）。
 */
/** fillPaints / strokePaints / 文字色 → CSS 颜色（只取第一个可见 SOLID） */
export function paintToCss(list) {
    for (const p of list ?? []) {
        if (!p || p.visible === false)
            continue;
        if (p.type === 'SOLID' && p.color) {
            const c = p.color;
            const a = p.opacity ?? c.a ?? 1;
            const rgb = [c.r, c.g, c.b].map((v) => Math.round((v ?? 0) * 255));
            return a >= 1 ? rgbToHex(rgb) : `rgba(${rgb.join(',')},${Number(a.toFixed(4))})`;
        }
    }
    return undefined;
}
export function rgbToHex(rgb) {
    return `#${rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
}
/**
 * 逐边描边。关键：`borderStrokeWeightsIndependent=true` 时四条边独立，
 * 缺省的那几条是 **0**（不是继承 strokeWeight）。
 */
export function borderOf(n) {
    const color = paintToCss(n.strokePaints);
    if (!color)
        return undefined;
    let t, r, b, l;
    if (n.borderStrokeWeightsIndependent) {
        t = Number(n.borderTopWeight || 0);
        r = Number(n.borderRightWeight || 0);
        b = Number(n.borderBottomWeight || 0);
        l = Number(n.borderLeftWeight || 0);
        if (!t && !r && !b && !l) {
            const w = Number(n.strokeWeight || 0);
            t = r = b = l = w;
        }
    }
    else {
        const w = Number(n.strokeWeight || 0);
        if (!w)
            return undefined;
        t = r = b = l = w;
    }
    if (!t && !r && !b && !l)
        return undefined;
    return { color, top: t, right: r, bottom: b, left: l };
}
/** 逐角圆角 → CSS border-radius 值（TL TR BR BL），无圆角返回 undefined */
export function radiusOf(n) {
    if (n.rectangleCornerRadiiIndependent) {
        const tl = Number(n.rectangleTopLeftCornerRadius || 0);
        const tr = Number(n.rectangleTopRightCornerRadius || 0);
        const br = Number(n.rectangleBottomRightCornerRadius || 0);
        const bl = Number(n.rectangleBottomLeftCornerRadius || 0);
        if (tl || tr || br || bl)
            return `${tl}px ${tr}px ${br}px ${bl}px`;
    }
    const r = Number(n.cornerRadius || 0);
    return r ? `${r}px` : undefined;
}
export function shadowOf(n) {
    const out = [];
    for (const e of n.effects ?? []) {
        if (!e || e.visible === false)
            continue;
        if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
            const c = e.color ?? {};
            const a = e.opacity ?? c.a ?? 1;
            const rgb = [c.r, c.g, c.b].map((v) => Math.round((v ?? 0) * 255));
            out.push(`${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.radius ?? 0}px ${e.spread ?? 0}px rgba(${rgb.join(',')},${Number(a.toFixed(4))})`);
        }
        else if (e.type === 'LAYER_BLUR') {
            out.push(`blur(${e.radius ?? 0}px)`);
        }
    }
    return out.length ? out.join(', ') : undefined;
}
export function fontKeyOf(n) {
    const f = n.fontName ?? {};
    return `${f.family ?? ''} ${f.style ?? ''} ${n.fontSize ?? 0}px`.trim();
}
function lineHeightCss(n) {
    const lh = n.lineHeight;
    if (!lh || typeof lh.value !== 'number')
        return undefined;
    // PERCENT 是相对字号；PIXELS 直接用
    if (lh.unit === 'PERCENT' || lh.units === 'PERCENT') {
        const size = Number(n.fontSize || 0);
        return size ? `${((lh.value / 100) * size).toFixed(2)}px` : undefined;
    }
    return `${lh.value}px`;
}
function letterSpacingCss(n) {
    const ls = n.letterSpacing;
    if (!ls || typeof ls.value !== 'number' || !ls.value)
        return undefined;
    if (ls.unit === 'PERCENT' || ls.units === 'PERCENT')
        return `${ls.value / 100}em`;
    return `${ls.value}px`;
}
function weightOfStyle(style) {
    const s = String(style || '').toLowerCase();
    if (s.includes('black') || s.includes('heavy'))
        return 900;
    if (s.includes('extrabold') || s.includes('ultra'))
        return 800;
    if (s.includes('semibold') || s.includes('demibold'))
        return 600;
    if (s.includes('medium'))
        return 500;
    if (s.includes('light'))
        return 300;
    if (s.includes('thin'))
        return 200;
    if (s.includes('bold'))
        return 700;
    return 400;
}
const BUTTON_RE = /button|btn|按钮/i;
const INPUT_RE = /input|select|dropdown|date|picker|textfield|输入|下拉|日期/i;
function classify(n, depth, name) {
    if (depth === 0)
        return 'root';
    const t = String(n.type ?? '');
    if (t === 'TEXT')
        return 'text';
    if (BUTTON_RE.test(name))
        return 'button';
    if (t === 'INSTANCE')
        return INPUT_RE.test(name) ? 'input' : 'instance';
    if (t === 'VECTOR' || t === 'BOOLEAN_OPERATION')
        return 'icon';
    if (t === 'FRAME' || t === 'GROUP' || t === 'SECTION')
        return 'frame';
    return 'other';
}
/** 实例内部结构在 ws.json 中是否缺失（实测：96 个实例全部 0 children） */
export function instanceIsOpaque(n, childCount) {
    if (String(n.type) !== 'INSTANCE')
        return false;
    const noFills = !Array.isArray(n.fillPaints) || n.fillPaints.length === 0;
    const noStrokes = !Array.isArray(n.strokePaints) || n.strokePaints.length === 0;
    return childCount === 0 && noFills && noStrokes;
}
/** 实例里真正显示的文字藏在覆写链里（普通 TEXT 节点的 textData 拿不到） */
export function overrideTextOf(n) {
    const overrides = n?.symbolData?.symbolOverrides;
    if (!Array.isArray(overrides))
        return undefined;
    for (const o of overrides) {
        const chars = o?.textData?.characters;
        if (chars)
            return String(chars);
    }
    return undefined;
}
function layoutOf(n) {
    const l = {};
    if (n.stackMode)
        l.mode = String(n.stackMode);
    if (typeof n.stackSpacing === 'number')
        l.spacing = n.stackSpacing;
    if (typeof n.stackHorizontalPadding === 'number')
        l.paddingLeft = l.paddingRight = n.stackHorizontalPadding;
    if (typeof n.stackVerticalPadding === 'number')
        l.paddingTop = l.paddingBottom = n.stackVerticalPadding;
    if (typeof n.paddingLeft === 'number')
        l.paddingLeft = n.paddingLeft;
    if (typeof n.paddingRight === 'number')
        l.paddingRight = n.paddingRight;
    if (typeof n.paddingTop === 'number')
        l.paddingTop = n.paddingTop;
    if (typeof n.paddingBottom === 'number')
        l.paddingBottom = n.paddingBottom;
    if (typeof n.stackPaddingRight === 'number')
        l.paddingRight = n.stackPaddingRight;
    if (typeof n.stackPaddingBottom === 'number')
        l.paddingBottom = n.stackPaddingBottom;
    if (n.stackCounterAlignItems)
        l.counterAlign = String(n.stackCounterAlignItems);
    return Object.keys(l).length ? l : undefined;
}
function buildTree(root, childrenMap, parentX, parentY, depth) {
    const t = root.transform ?? {};
    const s = root.size ?? {};
    const rx = Number(t.m02 ?? 0);
    const ry = Number(t.m12 ?? 0);
    // 坑 1：根节点自身带画布坐标，必须归零；子节点才累加（父相对）
    const x = depth === 0 ? 0 : Math.round(parentX + rx);
    const y = depth === 0 ? 0 : Math.round(parentY + ry);
    const w = Math.round(Number(s.x ?? 0));
    const h = Math.round(Number(s.y ?? 0));
    const name = String(root.name ?? '');
    const id = `${Number(root.guid?.sessionID ?? 0)}:${Number(root.guid?.localID ?? 0)}`;
    const kids = childrenMap.get(id) ?? [];
    const kind = classify(root, depth, name);
    const node = {
        id,
        type: String(root.type ?? ''),
        name,
        kind,
        rx: Math.round(rx),
        ry: Math.round(ry),
        x,
        y,
        w,
        h,
        background: paintToCss(root.fillPaints),
        opacity: typeof root.opacity === 'number' && root.opacity < 1 ? root.opacity : undefined,
        border: borderOf(root),
        radius: radiusOf(root),
        shadow: shadowOf(root),
        text: undefined,
        layout: layoutOf(root),
        children: [],
        raw: root,
    };
    if (kind === 'text') {
        const fn = root.fontName ?? {};
        node.value = String(root.textData?.characters ?? '');
        node.text = {
            family: String(fn.family ?? ''),
            size: Number(root.fontSize ?? 0),
            weight: weightOfStyle(fn.style),
            lineHeight: lineHeightCss(root),
            letterSpacing: letterSpacingCss(root),
            align: root.textAlignHorizontal ? String(root.textAlignHorizontal).toLowerCase() : undefined,
            color: paintToCss(root.fillPaints),
        };
    }
    else if (String(root.type) === 'INSTANCE') {
        // 坑 5：实例的可见文案只在覆写链里
        node.value = overrideTextOf(root);
        if (instanceIsOpaque(root, kids.length))
            node.instanceInternalMissing = true;
    }
    for (const k of kids) {
        node.children.push(buildTree(k, childrenMap, x, y, depth + 1));
    }
    return node;
}
export function buildDesignModel(nodeJson) {
    const node = nodeJson.node;
    const descendants = (nodeJson.descendants ?? []);
    const childrenMap = new Map();
    for (const n of descendants) {
        const p = n?.parentIndex?.guid;
        if (!p)
            continue;
        const pk = `${Number(p.sessionID)}:${Number(p.localID)}`;
        if (!childrenMap.has(pk))
            childrenMap.set(pk, []);
        childrenMap.get(pk).push(n);
    }
    const tree = buildTree(node, childrenMap, 0, 0, 0);
    const colors = new Map();
    const fonts = new Map();
    const spacing = new Set();
    const shadows = new Set();
    const texts = [];
    const spec = [];
    const walk = (n) => {
        if (n.raw.visible === false)
            return; // 隐藏节点不属于设计意图
        for (const c of [n.background, n.border?.color, n.text?.color]) {
            if (c)
                colors.set(c, c);
        }
        if (n.shadow)
            shadows.add(n.shadow);
        if (n.layout) {
            for (const v of [n.layout.spacing, n.layout.paddingTop, n.layout.paddingLeft]) {
                if (typeof v === 'number')
                    spacing.add(v);
            }
        }
        if (n.text) {
            const key = `${n.text.family} ${n.text.weight} ${n.text.size}px`;
            fonts.set(key, {
                family: n.text.family,
                weight: String(n.text.weight),
                size: n.text.size,
                lineHeight: n.text.lineHeight,
                letterSpacing: n.text.letterSpacing,
            });
        }
        if (n.kind === 'text' && n.value) {
            texts.push({ text: n.value, font: fontKeyOf(n.raw), color: n.text?.color ?? '', x: n.x, y: n.y, w: n.w, h: n.h });
        }
        const edges = n.border
            ? `${n.border.top}/${n.border.right}/${n.border.bottom}/${n.border.left}`
            : undefined;
        spec.push({
            id: n.id,
            name: n.name,
            type: n.type,
            kind: n.kind,
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
            background: n.background,
            border: n.border ? `${n.border.color}` : undefined,
            borderEdges: edges,
            radius: n.radius,
            font: n.text ? `${n.text.family} ${n.text.weight} ${n.text.size}px/${n.text.lineHeight ?? '-'}` : undefined,
            text: n.kind === 'text' ? n.value : n.value ? `（实例文案）${n.value}` : undefined,
            layout: n.layout
                ? `${n.layout.mode ?? '-'} spacing=${n.layout.spacing ?? '-'} pad=${n.layout.paddingTop ?? '-'}/${n.layout.paddingRight ?? '-'}/${n.layout.paddingBottom ?? '-'}/${n.layout.paddingLeft ?? '-'}`
                : undefined,
            shadow: n.shadow,
            instanceInternalMissing: n.instanceInternalMissing,
        });
        for (const c of n.children)
            walk(c);
    };
    walk(tree);
    const size = node.size ?? {};
    const name = String(node.name ?? '设计组件');
    return {
        fileKey: String(nodeJson.fileKey ?? ''),
        nodeId: String(nodeJson.nodeId ?? ''),
        componentName: name,
        width: Math.round(Number(size.x ?? 0)),
        height: Math.round(Number(size.y ?? 0)),
        tokens: {
            colors: Object.fromEntries(colors),
            fonts: Object.fromEntries(fonts),
            spacing: [...spacing].sort((a, b) => a - b),
            shadows: [...shadows],
        },
        texts,
        tree,
        spec,
    };
}
//# sourceMappingURL=design.js.map