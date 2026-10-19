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
 *    **特别注意**：逐边标记为 true 但四边全 0 时**不能再回落 strokeWeight**（那会凭空长出一条边框，
 *    实测 96 个实例里 87 个被这么画出了设计里不存在的 1px 边框）。只有 `strokeGeometry` 存在时才回落。
 * 4. 圆角可能是**逐角**的：`rectangleCornerRadiiIndependent` + `rectangle*CornerRadius`。
 *    拼接控件组"两端圆角 8、中间直角"就靠它。
 * 5. 实例（INSTANCE）在 ws.json 里**没有 children、没有 fillPaints/strokePaints**：内部结构拿不到。
 *    能拿到的只有 size / cornerRadius / 逐角圆角 / 以及**覆写文案**
 *    `symbolData.symbolOverrides[].textData.characters`（如 "Please Input"）。
 * 6. auto-layout 的 `stack*` 字段都在数据里，绝对定位只是"静态还原"的手段；
 *    落到组件时应转成 flex。**只读 stackMode/spacing/padding 是不够的**——
 *    `stackPrimaryAlignItems / stackCounterAlignItems / stackPrimarySizing / stackCounterSizing /
 *    stackChildPrimaryGrow / stackChildAlignSelf / stackWrap / stackPositioning` 决定
 *    "谁吸收剩余空间、怎么对齐、要不要换行、是不是绝对子项"，缺了这些，flex 只能靠模型脑补。
 *
 * ── 属性来源（provenance）──
 * 每个节点记录每个视觉属性的来源：design（设计数据直读）/ inferred（由数据推断）/ placeholder（数据缺失，占位重建）。
 * 基准页、SPEC、coverage.json 都读它 —— 让"猜出来的部分"从隐性负债变成显性台账，
 * 评审时可以直接说"这处是 placeholder，不是实现做错了"，不必每轮重新争论。
 */
/** 纯色 → CSS 颜色（alpha = paint.opacity × color.a，两者**相乘**，不能取其一） */
function colorCss(c, opacity) {
    const rgb = [c?.r, c?.g, c?.b].map((v) => Math.round((v ?? 0) * 255));
    const a = (typeof opacity === 'number' ? opacity : 1) * (typeof c?.a === 'number' ? c.a : 1);
    return a >= 1 ? rgbToHex(rgb) : `rgba(${rgb.join(',')},${Number(a.toFixed(4))})`;
}
/**
 * fillPaints / strokePaints / 文字色 → CSS 颜色。
 * 多个可见纯色叠加时取**最后一个**（Kiwi 的 paints 按绘制顺序，后者在上层）。
 */
export function paintToCss(list) {
    let out;
    for (const p of list ?? []) {
        if (!p || p.visible === false)
            continue;
        if (p.type === 'SOLID' && p.color)
            out = colorCss(p.color, p.opacity);
    }
    return out;
}
export function rgbToHex(rgb) {
    return `#${rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('')}`;
}
/** 渐变 → CSS 渐变。方向靠 handle 位置粗判（精确角度要带变换，这里记为 inferred） */
function gradientCss(p) {
    const stops = (p.gradientStops ?? []);
    if (!stops.length)
        return undefined;
    const n = Math.max(1, stops.length - 1);
    const parts = stops.map((s, i) => {
        const pos = typeof s.position === 'number' ? s.position : i / n;
        return `${colorCss(s.color)} ${Math.round(Math.max(0, Math.min(1, pos)) * 100)}%`;
    });
    if (parts.length < 2)
        return undefined;
    const t = String(p.type ?? '');
    if (t === 'GRADIENT_LINEAR') {
        const h = p.gradientHandlePositions;
        const vertical = !!h && h.length >= 2 && Math.abs((h[1]?.y ?? 0) - (h[0]?.y ?? 0)) >= Math.abs((h[1]?.x ?? 0) - (h[0]?.x ?? 0));
        return `linear-gradient(${vertical ? '180deg' : '90deg'}, ${parts.join(', ')})`;
    }
    if (t === 'GRADIENT_RADIAL' || t === 'GRADIENT_DIAMOND') {
        return `radial-gradient(circle at 50% 50%, ${parts.join(', ')})`;
    }
    // ANGULAR 等：CSS 里用 conic-gradient 近似
    return `conic-gradient(from 0deg at 50% 50%, ${parts.join(', ')})`;
}
/** 填充 → { css, prov }；IMAGE 拿不到位图资源，画中性底纹并标 placeholder */
export function backgroundOf(n) {
    const paints = (n.fillPaints ?? []).filter((p) => p && p.visible !== false);
    if (!paints.length)
        return {};
    const top = paints[paints.length - 1];
    const t = String(top.type ?? '');
    if (t === 'SOLID')
        return { css: colorCss(top.color, top.opacity), prov: 'design' };
    if (t.startsWith('GRADIENT'))
        return { css: gradientCss(top), prov: 'inferred' };
    if (t === 'IMAGE' || t === 'VIDEO') {
        return { css: 'repeating-linear-gradient(45deg,#ececec 0 6px,#f6f6f6 6px 12px)', prov: 'placeholder' };
    }
    return {};
}
/**
 * 逐边描边。关键：`borderStrokeWeightsIndependent=true` 时四条边独立，
 * 缺省的那几条是 **0**（不是继承 strokeWeight）。
 * 只有存在 `strokeGeometry`（确实画了描边）时才允许回落到 strokeWeight。
 */
export function borderOf(n) {
    const color = paintToCss(n.strokePaints);
    if (!color)
        return undefined;
    const dash = Array.isArray(n.dashPattern) && n.dashPattern.length ? n.dashPattern.map(Number) : undefined;
    const align = typeof n.strokeAlign === 'string' ? n.strokeAlign : undefined;
    const hasGeometry = Array.isArray(n.strokeGeometry) && n.strokeGeometry.length > 0;
    if (n.borderStrokeWeightsIndependent) {
        const t = Number(n.borderTopWeight || 0);
        const r = Number(n.borderRightWeight || 0);
        const b = Number(n.borderBottomWeight || 0);
        const l = Number(n.borderLeftWeight || 0);
        if (!t && !r && !b && !l) {
            // 逐边全 0：只有拿到"确实画了描边"的证据才回落到统一权重，否则就是没有描边
            const w = hasGeometry ? Number(n.strokeWeight || 0) : 0;
            if (!w)
                return undefined;
            return { color, top: w, right: w, bottom: w, left: w, dash, align };
        }
        return { color, top: t, right: r, bottom: b, left: l, dash, align };
    }
    const w = Number(n.strokeWeight || 0);
    if (!w)
        return undefined;
    return { color, top: w, right: w, bottom: w, left: w, dash, align };
}
/**
 * 逐角圆角 → CSS border-radius 值（TL TR BR BL）。
 * `rectangleCornerRadiiIndependent=true` 时四角就是**显式值**（全 0 也是显式 0），
 * 不能再回落到 cornerRadius —— 否则拼接组中间格会凭空长出圆角。
 */
export function radiusOf(n) {
    if (n.rectangleCornerRadiiIndependent) {
        const tl = Number(n.rectangleTopLeftCornerRadius || 0);
        const tr = Number(n.rectangleTopRightCornerRadius || 0);
        const br = Number(n.rectangleBottomRightCornerRadius || 0);
        const bl = Number(n.rectangleBottomLeftCornerRadius || 0);
        return `${tl}px ${tr}px ${br}px ${bl}px`;
    }
    // 显式 cornerRadius=0 与"字段缺失"不同：只有字段确实是数字才当作显式 0
    if (typeof n.cornerRadius === 'number')
        return n.cornerRadius ? `${n.cornerRadius}px` : '0px';
    return undefined;
}
export function shadowOf(n) {
    const out = [];
    for (const e of n.effects ?? []) {
        if (!e || e.visible === false)
            continue;
        if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
            const c = e.color ?? {};
            const a = (typeof e.opacity === 'number' ? e.opacity : 1) * (typeof c.a === 'number' ? c.a : 1);
            const rgb = [c.r, c.g, c.b].map((v) => Math.round((v ?? 0) * 255));
            out.push(`${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.radius ?? 0}px ${e.spread ?? 0}px rgba(${rgb.join(',')},${Number(a.toFixed(4))})`);
        }
        else if (e.type === 'LAYER_BLUR') {
            out.push(`blur(${e.radius ?? 0}px)`);
        }
        else if (e.type === 'BACKGROUND_BLUR') {
            // 背景模糊在静态页里没有可模糊的背景层，用 backdrop-filter 近似（浏览器支持则生效）
            out.push(`blur(${e.radius ?? 0}px)`);
        }
    }
    return out.length ? out.join(', ') : undefined;
}
export function fontKeyOf(n) {
    const f = n.fontName ?? {};
    return `${f.family ?? ''} ${f.style ?? ''} ${n.fontSize ?? 0}px`.trim();
}
/** 行高：`value=0`（AUTO）与 `units=RAW` 都表示"没有明确行高"，返回 undefined 而不是 0px */
function lineHeightCss(n) {
    const lh = n.lineHeight;
    if (!lh || typeof lh.value !== 'number' || !lh.value)
        return undefined;
    const unit = String(lh.unit ?? lh.units ?? '');
    if (unit === 'RAW')
        return undefined;
    if (unit === 'PERCENT') {
        const size = Number(n.fontSize || 0);
        return size ? `${((lh.value / 100) * size).toFixed(2)}px` : undefined;
    }
    return `${lh.value}px`;
}
function letterSpacingCss(n) {
    const ls = n.letterSpacing;
    if (!ls || typeof ls.value !== 'number' || !ls.value)
        return undefined;
    const unit = String(ls.unit ?? ls.units ?? '');
    if (unit === 'RAW')
        return undefined;
    if (unit === 'PERCENT')
        return `${ls.value / 100}em`;
    return `${ls.value}px`;
}
/** 字重：先归一化空白/下划线（"Semi Bold" 要能命中 semibold），再按长词优先匹配 */
function weightOfStyle(style) {
    const s = String(style || '').toLowerCase().replace(/[\s_-]/g, '');
    if (/black|heavy/.test(s))
        return 900;
    if (/extrabold|ultrabold/.test(s))
        return 800;
    if (/semibold|demibold/.test(s))
        return 600;
    if (/medium/.test(s))
        return 500;
    if (/light/.test(s))
        return 300;
    if (/thin|hairline/.test(s))
        return 100;
    if (/bold/.test(s))
        return 700;
    return 400;
}
function isItalic(style) {
    return /italic|oblique/i.test(String(style || ''));
}
const BUTTON_RE = /button|btn|按钮/i;
const INPUT_RE = /input|select|dropdown|date|picker|textfield|输入|下拉|日期/i;
function classify(n, depth, name) {
    if (depth === 0)
        return 'root';
    const t = String(n.type ?? '');
    if (t === 'TEXT')
        return 'text';
    if (t === 'ELLIPSE')
        return 'ellipse';
    if (BUTTON_RE.test(name))
        return 'button';
    if (t === 'INSTANCE')
        return INPUT_RE.test(name) ? 'input' : 'instance';
    if (t === 'VECTOR' || t === 'BOOLEAN_OPERATION')
        return 'icon';
    if (t === 'FRAME' || t === 'GROUP' || t === 'SECTION' || t === 'ROUNDED_RECTANGLE')
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
    if (n.stackPrimaryAlignItems)
        l.primaryAlign = String(n.stackPrimaryAlignItems);
    if (n.stackCounterAlignItems)
        l.counterAlign = String(n.stackCounterAlignItems);
    if (n.stackPrimarySizing)
        l.primarySizing = String(n.stackPrimarySizing);
    if (n.stackCounterSizing)
        l.counterSizing = String(n.stackCounterSizing);
    if (n.stackWrap)
        l.wrap = String(n.stackWrap);
    if (typeof n.stackChildPrimaryGrow === 'number')
        l.childGrow = n.stackChildPrimaryGrow;
    if (n.stackChildAlignSelf)
        l.childAlignSelf = String(n.stackChildAlignSelf);
    if (String(n.stackPositioning ?? '') === 'ABSOLUTE')
        l.absolute = true;
    if (typeof n.bordersTakeSpace === 'boolean')
        l.bordersTakeSpace = n.bordersTakeSpace;
    return Object.keys(l).length ? l : undefined;
}
/** 容器是否裁剪：clipsContent 优先，Kiwi 用 frameMaskDisabled（true = 不裁）表示 */
function clipsOf(n) {
    if (typeof n.clipsContent === 'boolean')
        return n.clipsContent;
    if (typeof n.frameMaskDisabled === 'boolean')
        return !n.frameMaskDisabled;
    return undefined;
}
/** transform 矩阵里的旋转角（度）。m00/m10 是旋转分量（Kiwi: [m00,m01,m02,m10,m11,m12]） */
function rotationOf(t) {
    const m00 = typeof t?.m00 === 'number' ? t.m00 : 1;
    const m10 = typeof t?.m10 === 'number' ? t.m10 : 0;
    const deg = (Math.atan2(m10, m00) * 180) / Math.PI;
    return Math.abs(deg) > 0.5 ? Number(deg.toFixed(3)) : undefined;
}
function buildTree(root, childrenMap, parentX, parentY, depth) {
    const t = root.transform ?? {};
    const s = root.size ?? {};
    // 坐标**不在这里取整**：每层取整会让误差逐层累积（深层节点漂 1–2px），
    // 只在最终输出（规格表 / CSS 数值）按需格式化。
    const rx = Number(t.m02 ?? 0);
    const ry = Number(t.m12 ?? 0);
    // 坑 1：根节点自身带画布坐标，必须归零；子节点才累加（父相对）
    const x = depth === 0 ? 0 : parentX + rx;
    const y = depth === 0 ? 0 : parentY + ry;
    const w = Number(s.x ?? 0);
    const h = Number(s.y ?? 0);
    const name = String(root.name ?? '');
    const id = `${Number(root.guid?.sessionID ?? 0)}:${Number(root.guid?.localID ?? 0)}`;
    const kids = childrenMap.get(id) ?? [];
    const kind = classify(root, depth, name);
    const bg = backgroundOf(root);
    const border = borderOf(root);
    const radius = radiusOf(root);
    const shadow = shadowOf(root);
    const layout = layoutOf(root);
    const clips = clipsOf(root);
    const rotation = rotationOf(t);
    const prov = {};
    if (bg.prov && kind !== 'text')
        prov.fill = bg.prov;
    if (border)
        prov.stroke = 'design';
    if (radius)
        prov.radius = 'design';
    if (shadow)
        prov.effect = 'design';
    if (layout?.mode)
        prov.layout = 'design';
    if (rotation != null)
        prov.rotation = 'design';
    const node = {
        id,
        type: String(root.type ?? ''),
        name,
        kind,
        rx,
        ry,
        x,
        y,
        w,
        h,
        // TEXT 的 fillPaints 是**字色**：放进 text.color，别当背景（否则文字块会被当成有底色）
        background: kind === 'text' ? undefined : bg.css,
        opacity: typeof root.opacity === 'number' && root.opacity < 1 ? root.opacity : undefined,
        border,
        radius,
        shadow,
        rotation,
        clips,
        text: undefined,
        layout,
        prov,
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
            italic: isItalic(fn.style) || undefined,
            lineHeight: lineHeightCss(root),
            letterSpacing: letterSpacingCss(root),
            align: root.textAlignHorizontal ? String(root.textAlignHorizontal).toLowerCase() : undefined,
            alignVertical: root.textAlignVertical ? String(root.textAlignVertical) : undefined,
            autoResize: root.textAutoResize ? String(root.textAutoResize) : undefined,
            maxLines: typeof root.maxLines === 'number' ? root.maxLines : undefined,
            color: paintToCss(root.fillPaints),
        };
        prov.text = 'design';
    }
    else if (String(root.type) === 'INSTANCE') {
        // 坑 5：实例的可见文案只在覆写链里
        node.value = overrideTextOf(root);
        if (instanceIsOpaque(root, kids.length)) {
            node.instanceInternalMissing = true;
            prov.instance = 'placeholder';
        }
        else if (kids.length) {
            prov.instance = 'design';
        }
    }
    if (kind === 'icon')
        prov.vector = 'placeholder';
    for (const k of kids) {
        node.children.push(buildTree(k, childrenMap, x, y, depth + 1));
    }
    return node;
}
/** 扁平化（不含隐藏节点） */
export function flatten(model) {
    const out = [];
    const walk = (n) => {
        if (n.raw.visible === false)
            return;
        out.push(n);
        for (const c of n.children)
            walk(c);
    };
    walk(model.tree);
    return out;
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
    const entries = [];
    const counts = { design: 0, inferred: 0, placeholder: 0 };
    const fontFamilies = new Set();
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
            fontFamilies.add(n.text.family);
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
        // ── 台账：逐属性记来源 ──
        for (const [property, prov] of Object.entries(n.prov ?? {})) {
            counts[prov] += 1;
            if (prov !== 'design')
                entries.push({ id: n.id, name: n.name, property, prov });
        }
        const edges = n.border
            ? `${n.border.top}/${n.border.right}/${n.border.bottom}/${n.border.left}`
            : undefined;
        const layoutParts = [];
        if (n.layout?.mode)
            layoutParts.push(`mode=${n.layout.mode}`);
        if (n.layout?.spacing != null)
            layoutParts.push(`gap=${n.layout.spacing}`);
        if (n.layout?.paddingTop != null || n.layout?.paddingRight != null || n.layout?.paddingBottom != null || n.layout?.paddingLeft != null) {
            layoutParts.push(`pad=${n.layout.paddingTop ?? 0}/${n.layout.paddingRight ?? 0}/${n.layout.paddingBottom ?? 0}/${n.layout.paddingLeft ?? 0}`);
        }
        if (n.layout?.primaryAlign)
            layoutParts.push(`justify=${n.layout.primaryAlign}`);
        if (n.layout?.counterAlign)
            layoutParts.push(`align=${n.layout.counterAlign}`);
        if (n.layout?.primarySizing)
            layoutParts.push(`primary=${n.layout.primarySizing}`);
        if (n.layout?.counterSizing)
            layoutParts.push(`counter=${n.layout.counterSizing}`);
        if (n.layout?.wrap && n.layout.wrap !== 'NO_WRAP')
            layoutParts.push(`wrap=${n.layout.wrap}`);
        if (n.layout?.childGrow)
            layoutParts.push(`grow=${n.layout.childGrow}`);
        if (n.layout?.childAlignSelf)
            layoutParts.push(`self=${n.layout.childAlignSelf}`);
        if (n.layout?.absolute)
            layoutParts.push('position=ABSOLUTE');
        const provSummary = Object.entries(n.prov ?? {}).map(([k, v]) => `${k}=${v}`).join(',');
        spec.push({
            id: n.id,
            name: n.name,
            type: n.type,
            kind: n.kind,
            // 保留 2 位小数：取整会让"正确实现"也天生带 ±0.5–1px 假差异（实测 25% 节点有小数）
            x: Math.round(n.x * 100) / 100,
            y: Math.round(n.y * 100) / 100,
            w: Math.round(n.w * 100) / 100,
            h: Math.round(n.h * 100) / 100,
            background: n.background,
            color: n.kind === 'text' ? n.text?.color : undefined,
            border: n.border ? `${n.border.color}` : undefined,
            borderEdges: edges,
            radius: n.radius,
            dash: n.border?.dash?.join(','),
            strokeAlign: n.border?.align,
            font: n.text ? `${n.text.family} ${n.text.weight} ${n.text.size}px/${n.text.lineHeight ?? '-'}` : undefined,
            text: n.kind === 'text' ? n.value : n.value ? `（实例文案）${n.value}` : undefined,
            layout: layoutParts.length ? layoutParts.join(' ') : undefined,
            layoutFull: n.layout ? JSON.stringify(n.layout) : undefined,
            shadow: n.shadow,
            clips: n.clips,
            instanceInternalMissing: n.instanceInternalMissing,
            prov: provSummary || undefined,
        });
        for (const c of n.children)
            walk(c);
    };
    walk(tree);
    const size = node.size ?? {};
    const name = String(node.name ?? '设计组件');
    const total = counts.design + counts.inferred + counts.placeholder;
    const coverage = {
        nodes: spec.length,
        counts,
        placeholderRatio: total ? Number((counts.placeholder / total).toFixed(4)) : 0,
        entries,
        fonts: [...fontFamilies].filter(Boolean).sort(),
        summary: `属性项 ${total}：design ${counts.design} · inferred ${counts.inferred} · placeholder ${counts.placeholder}`
            + `（placeholder 占比 ${(total ? (counts.placeholder / total) * 100 : 0).toFixed(1)}%）`,
    };
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
        coverage,
    };
}
//# sourceMappingURL=design.js.map