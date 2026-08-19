/**
 * DesignModel：把 dsh-figma-reader 解码出的 Kiwi 节点 JSON 提炼成
 * 可供代码生成器使用的结构化设计模型（令牌 + 组件树 + 文本）。
 *
 * 输入格式：`{ fileKey, nodeId, node, descendants }`（figma_read_node_ws / CLI 产物）。
 */
function rgbaToCss(paints, key) {
    const list = paints ?? [];
    for (const p of list) {
        if (p.type === 'SOLID' && p.visible !== false && p.color) {
            const c = p.color;
            const a = p.opacity ?? c.a ?? 1;
            return `rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${a})`;
        }
    }
    return undefined;
}
function effectsToCss(effects) {
    const out = [];
    for (const e of effects ?? []) {
        if (!e || e.visible === false)
            continue;
        if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
            const inset = e.type === 'INNER_SHADOW' ? ' inset' : '';
            const c = e.color ?? {};
            const spread = e.spread ?? 0;
            const blur = e.radius ?? 0;
            const offX = e.offset?.x ?? 0;
            const offY = e.offset?.y ?? 0;
            const a = e.opacity ?? c.a ?? 1;
            out.push(`${inset} ${offX}px ${offY}px ${blur}px ${spread}px rgba(${Math.round((c.r ?? 0) * 255)},${Math.round((c.g ?? 0) * 255)},${Math.round((c.b ?? 0) * 255)},${a})`.trim());
        }
        else if (e.type === 'LAYER_BLUR') {
            out.push(`blur(${e.radius ?? 0}px)`);
        }
    }
    return out;
}
function fontKey(n) {
    const f = n.fontName ?? {};
    return `${f.family ?? ''} ${f.style ?? ''} ${n.fontSize ?? 0}px`;
}
function hex(rgba) {
    const m = rgba.match(/^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/);
    if (!m || Number(m[4]) !== 1)
        return rgba;
    const to = (n) => n.toString(16).padStart(2, '0');
    return `#${to(Number(m[1]))}${to(Number(m[2]))}${to(Number(m[3]))}`;
}
const BUTTON_RE = /button|取消|复制|制新卡|确定|保存|提交|关闭/i;
const INPUT_RE = /input|输入|文本框/i;
function classify(n, depth, name) {
    if (depth === 0)
        return 'root';
    const t = String(n.type ?? '');
    if (t === 'TEXT')
        return 'text';
    if (t === 'VECTOR' && INPUT_RE.test(name))
        return 'input';
    if (BUTTON_RE.test(name))
        return 'button';
    if (t === 'INSTANCE' && /close|关闭/i.test(name))
        return 'icon-close';
    if (t === 'INSTANCE')
        return 'instance';
    if (t === 'FRAME' || t === 'GROUP' || t === 'SECTION')
        return 'frame';
    return 'other';
}
function buildTree(root, byId, childrenMap, absX = 0, absY = 0, depth = 0) {
    const t = root.transform ?? {};
    const s = root.size ?? {};
    const x = absX + Number(t.m02 ?? 0);
    const y = absY + Number(t.m12 ?? 0);
    const w = Number(s.x ?? 0);
    const h = Number(s.y ?? 0);
    const name = String(root.name ?? '');
    const kind = classify(root, depth, name);
    const node = {
        id: `${Number(root.guid?.sessionID ?? 0)}:${Number(root.guid?.localID ?? 0)}`,
        type: String(root.type ?? ''),
        name,
        kind,
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h),
        background: rgbaToCss(root.fillPaints, 'fillPaints'),
        color: rgbaToCss(root.fillPaints, 'fillPaints'),
        font: fontKey(root),
        children: [],
        raw: root,
    };
    if (kind === 'text') {
        node.value = String(root.textData?.characters ?? '');
        node.color = rgbaToCss(root.fillPaints, 'fillPaints');
    }
    const kids = childrenMap.get(node.id) ?? [];
    for (const k of kids) {
        node.children.push(buildTree(k, byId, childrenMap, x, y, depth + 1));
    }
    return node;
}
export function buildDesignModel(nodeJson) {
    const node = nodeJson.node;
    const descendants = (nodeJson.descendants ?? []);
    const byId = new Map();
    for (const n of [node, ...descendants]) {
        if (n?.guid)
            byId.set(`${Number(n.guid.sessionID)}:${Number(n.guid.localID)}`, n);
    }
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
    const tree = buildTree(node, byId, childrenMap);
    // ── 令牌收集 ──
    const colors = new Map();
    const fonts = new Map();
    const spacing = new Set();
    const shadows = new Set();
    const texts = [];
    const walk = (n) => {
        if (n.background)
            colors.set(n.background, hex(n.background));
        if (n.color)
            colors.set(n.color, hex(n.color));
        const r = n.raw;
        const fill = rgbaToCss(r.fillPaints, 'fillPaints');
        if (fill)
            colors.set(fill, hex(fill));
        const stroke = rgbaToCss(r.strokePaints, 'strokePaints');
        if (stroke)
            colors.set(stroke, hex(stroke));
        for (const sh of effectsToCss(r.effects))
            shadows.add(sh);
        if (typeof r.stackSpacing === 'number')
            spacing.add(r.stackSpacing);
        if (typeof r.stackHorizontalPadding === 'number')
            spacing.add(r.stackHorizontalPadding);
        if (typeof r.stackVerticalPadding === 'number')
            spacing.add(r.stackVerticalPadding);
        if (n.kind === 'text') {
            const fn = n.raw.fontName ?? {};
            const key = fontKey(n.raw);
            fonts.set(key, {
                family: String(fn.family ?? ''),
                weight: String(fn.style ?? ''),
                size: Number(n.raw.fontSize ?? 0),
                lineHeight: n.raw.lineHeight?.value != null ? `${n.raw.lineHeight.value}px` : undefined,
                letterSpacing: n.raw.letterSpacing?.value != null ? `${n.raw.letterSpacing.value}px` : undefined,
            });
            texts.push({ text: n.value ?? '', font: key, color: n.color ?? '', x: n.x, y: n.y, w: n.w, h: n.h });
        }
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
    };
}
//# sourceMappingURL=design.js.map