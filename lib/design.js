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
const guidPathOf = (d) => (d?.guidPath?.guids ?? [])
    .map((g) => `${Number(g.sessionID)}:${Number(g.localID)}`).join('/');
const point = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
/** 文本位置：优先用包围它的 derived 容器；根文本再把 auto-layout 的计算补在后面。 */
export function instanceTextPartsOf(n) {
    const derived = Array.isArray(n?.derivedSymbolData) ? n.derivedSymbolData : [];
    const byPath = new Map(derived.map((d) => [guidPathOf(d), d]));
    const overrides = Array.isArray(n?.symbolData?.symbolOverrides) ? n.symbolData.symbolOverrides : [];
    const parts = [];
    let plainOffset = 0;
    for (const o of overrides) {
        const value = o?.textData?.characters;
        if (!value || !o?.guidPath)
            continue;
        const path = guidPathOf(o);
        const d = byPath.get(path) ?? {};
        const text = d.derivedTextData ?? {};
        const glyphSize = Number(text.glyphs?.[0]?.fontSize ?? 0);
        const meta = text.fontMetaData?.[0] ?? {};
        const font = meta.key ?? {};
        const lhs = text.baselines?.[0]?.lineHeight;
        let x = point(d.transform?.m02);
        let y = point(d.transform?.m12);
        let hasPosition = !!d.transform;
        let containerWidth;
        let containerHeight;
        let containerStroke = false;
        if (!hasPosition && o.guidPath.guids?.length > 1) {
            // 嵌套文本（例如 Tab 的数量徽标）自身 transform 经常缺省，位置在父 derived 节点上。
            const parentPath = o.guidPath.guids.slice(0, -1)
                .map((g) => `${Number(g.sessionID)}:${Number(g.localID)}`).join('/');
            const parent = byPath.get(parentPath) ?? {};
            if (parent.transform) {
                const ts = text.layoutSize ?? {};
                const ps = parent.size ?? {};
                containerWidth = point(ps.x) || (point(ts.x) ? point(ts.x) + 8 : 0);
                containerHeight = point(ps.y) || (point(ts.y) ? Math.max(14, point(ts.y) - 4) : 0);
                // derived 里有 strokeGeometry 说明这个徽标是描边形状；没有它时不要凭空加边框。
                containerStroke = Array.isArray(parent.strokeGeometry) && parent.strokeGeometry.length > 0;
                x = point(parent.transform.m02) + Math.max(0, (containerWidth - point(ts.x)) / 2);
                y = point(parent.transform.m12) + Math.max(0, (containerHeight - point(ts.y)) / 2);
                hasPosition = true;
            }
        }
        if (!hasPosition) {
            // 只有根文本时没有坐标：按实例的 auto-layout 计算主轴起点/交叉轴距中。
            // 第二个根文本紧接前一个；徽标等 nested derived 不计入普通文本流。
            const layout = n;
            const rootTexts = overrides.filter((it) => it?.textData?.characters && it.guidPath?.guids?.length === 1);
            const measure = (it) => {
                const dd = byPath.get(guidPathOf(it)) ?? {};
                const ls = dd.derivedTextData?.layoutSize ?? dd.size ?? {};
                const fs = Number(dd.derivedTextData?.glyphs?.[0]?.fontSize) || 14;
                // 只用于判断主轴方向；缺失尺寸按字符数估宽、按字号估高，不当成精确几何。
                return {
                    w: point(ls.x) || Math.ceil(String(it.textData?.characters ?? '').length * fs * 0.6),
                    h: point(ls.y) || Math.ceil(fs * 1.4),
                };
            };
            const measures = rootTexts.map(measure);
            const contentW = measures.reduce((sum, m) => sum + m.w, 0);
            const contentH = measures.reduce((sum, m) => sum + m.h, 0);
            const spacing = point(layout.stackSpacing);
            const total = contentW + spacing * Math.max(0, rootTexts.length - 1);
            const stackMode = String(layout.stackMode ?? '').toUpperCase();
            // 没有 stackMode 的实例（常见于日期范围选择框）不能默认竖排：
            // 若容器高度装不下两行文字、宽度装得下一行，主轴只能是水平的。
            const horizontal = stackMode === 'HORIZONTAL'
                || (!stackMode && point(n.size?.x) >= total && point(n.size?.y) < contentH);
            const tl = point(text.layoutSize?.x) || point(d.size?.x) ? (text.layoutSize ?? d.size ?? {}) : { x: measure(o).w, y: measure(o).h };
            const centered = String(layout.stackPrimaryAlignItems ?? '').toUpperCase() === 'CENTER';
            const xStart = point(layout.stackHorizontalPadding) + (centered ? Math.max(0, (point(n.size?.x) - point(layout.stackHorizontalPadding) * 2 - total) / 2) : 0);
            const crossPad = point(layout.stackVerticalPadding);
            const crossCenter = String(layout.stackCounterAlignItems ?? '').toUpperCase() === 'CENTER';
            // 有 derived 徽标/图形时，根文本的起点由相邻图形的真实 x 反推；仅用 PRIMARY=CENTER
            // 会把 "All 999" 的文字从 x=12 错放到 x=29（漏算徽标宽度）。
            const anchors = derived.filter((it) => it?.transform && it.guidPath?.guids?.length === 1);
            const firstAnchor = anchors.sort((a, b) => point(a.transform.m02) - point(b.transform.m02))[0];
            y = crossPad + (crossCenter ? Math.max(0, (point(n.size?.y) - crossPad * 2 - point(tl.y)) / 2) : 0);
            if (horizontal && plainOffset === 0 && firstAnchor && point(firstAnchor.transform.m02) >= point(tl.x)) {
                x = point(firstAnchor.transform.m02) - point(layout.stackSpacing) - point(tl.x);
            }
            else if (horizontal) {
                x = xStart + plainOffset;
                y = crossPad + (crossCenter ? Math.max(0, (point(n.size?.y) - crossPad * 2 - point(tl.y)) / 2) : 0);
                plainOffset += point(tl.x) + point(layout.stackSpacing);
            }
            else {
                x = crossPad + (crossCenter ? Math.max(0, (point(n.size?.x) - crossPad * 2 - point(tl.x)) / 2) : 0);
                y = xStart + plainOffset;
                plainOffset += point(tl.y) + point(layout.stackSpacing);
            }
        }
        // 段级真实字号优先（glyphSize），实例级 fontSize 兜底；两者都没有才算缺失。
        const sizeFromData = glyphSize || point(n.fontSize);
        const weightFromData = Number(meta.fontWeight) || 0;
        let size = sizeFromData || 14;
        let family = String(font.family ?? '');
        let weight = weightFromData || 400;
        let lineHeight = Number(lhs) > 0 ? `${Math.round(Number(lhs) * 100) / 100}px` : undefined;
        let fontInferred = false;
        if (!family) {
            // 有的覆写段只有 characters、没有 derived 字体（日期范围第二个值常见）：
            // 同一实例内文字样式相同，沿用上一段并标为推断，不冒充完整数据。
            // 但该段自带的真实 glyphSize / fontWeight 必须保留，不能被上一段覆盖。
            const prev = [...parts].reverse().find((p) => p.family);
            if (prev) {
                family = prev.family;
                if (!weightFromData)
                    weight = prev.weight;
                if (!sizeFromData)
                    size = prev.size;
                lineHeight = lineHeight ?? prev.lineHeight;
                fontInferred = true;
            }
        }
        parts.push({
            path, value: String(value), x, y,
            w: point(text.layoutSize?.x ?? d.size?.x),
            h: point(text.layoutSize?.y ?? d.size?.y),
            size, family, weight, lineHeight,
            hasPosition, containerWidth, containerHeight, containerStroke, fontInferred,
        });
    }
    return parts;
}
function gridIds(entries) {
    return (entries?.entries ?? []).map((e) => `${Number(e?.id?.sessionID)}:${Number(e?.id?.localID)}`);
}
function gridSizing(entries) {
    return (entries?.entries ?? []).map((e) => {
        const t = e?.trackSize?.maxSizing ?? e?.trackSize?.minSizing ?? {};
        return { type: String(t.type ?? 'FLEX'), value: Number(t.value ?? 1) };
    });
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
    if (typeof n.stackCounterSpacing === 'number')
        l.counterSpacing = n.stackCounterSpacing;
    if (String(n.stackMode) === 'GRID') {
        l.grid = {
            columnIds: gridIds(n.gridColumns),
            rowIds: gridIds(n.gridRows),
            columnSizing: gridSizing(n.gridColumnsSizing),
            rowSizing: gridSizing(n.gridRowsSizing),
            columnGap: Number(n.gridColumnGap ?? n.stackSpacing ?? 0),
            rowGap: Number(n.gridRowGap ?? n.stackSpacing ?? 0),
        };
    }
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
        // 实例覆写链里可能有多段文字（如 "Call" + 徽标 "1"），不能只保留第一段。
        node.value = overrideTextOf(root);
        node.instanceTexts = instanceTextPartsOf(root);
        if (node.instanceTexts.length)
            prov.text = 'design';
        if (node.instanceTexts.length > 1) {
            node.value = node.instanceTexts.map((part) => part.value).join(' ');
        }
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
/** CSS 颜色 → {r,g,b,a}（0..1）。支持 #rgb/#rrggbb/#rrggbbaa、rgb()/rgba()；解析失败返回 undefined。 */
function parseCssColor(input) {
    const s = String(input ?? '').trim().toLowerCase();
    if (!s)
        return undefined;
    let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
    if (m) {
        const h = m[1];
        const expand = (x) => x.length === 1 ? x + x : x;
        if (h.length === 3 || h.length === 4) {
            return {
                r: parseInt(expand(h[0]), 16) / 255,
                g: parseInt(expand(h[1]), 16) / 255,
                b: parseInt(expand(h[2]), 16) / 255,
                a: h.length === 4 ? parseInt(expand(h[3]), 16) / 255 : 1,
            };
        }
        return {
            r: parseInt(h.slice(0, 2), 16) / 255,
            g: parseInt(h.slice(2, 4), 16) / 255,
            b: parseInt(h.slice(4, 6), 16) / 255,
            a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
        };
    }
    m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
        const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
            const norm = (v) => v > 1 ? v / 255 : v;
            const a = parts.length >= 4 && Number.isFinite(parts[3]) ? (parts[3] > 1 ? parts[3] / 255 : parts[3]) : 1;
            return { r: norm(parts[0]), g: norm(parts[1]), b: norm(parts[2]), a };
        }
    }
    return undefined;
}
/** RGB → HSL（h 0..360，s/l 0..1） */
function rgbToHsl({ r, g, b }) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d !== 0) {
        if (max === r)
            h = ((g - b) / d) % 6;
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
        h = (h * 60 + 360) % 360;
    }
    return { h, s, l };
}
/**
 * 扩展红域：饱和玫红/正红（#e72847 一类）及其相邻色域——不再硬编码单一色值。
 * hue 320°..30°、s>=0.35、l 0.2..0.8，支持 rgba / #rgb / #rrggbbaa。
 * 低饱和灰字、蓝色强调字、浅红底都不会命中。
 */
function isNoteRed(color) {
    const c = parseCssColor(color);
    if (!c || c.a < 0.35)
        return false;
    const { h, s, l } = rgbToHsl(c);
    return (h >= 320 || h <= 30) && s >= 0.35 && l >= 0.2 && l <= 0.8;
}
/**
 * 颜色信号（泛化）：扩展红域命中，或「偏红且相对同层主流文案色有明显色差」。
 * mainstream 为同层 TEXT 中最常见的字色（排除候选自身）；主流色本身偏红时不误报。
 */
function colorAnnotationSignal(color, mainstream) {
    const c = parseCssColor(color);
    if (!c || c.a < 0.35)
        return false;
    // 扩展红域是独立充分条件：即使同层主流色恰好也是红字（如另一条备注），仍算命中。
    if (isNoteRed(color))
        return true;
    // 弱判据：偏红且与同层主流文案色有明显色差。
    const reddish = c.r - c.g >= 0.18 && c.r - c.b >= 0.10;
    if (!reddish)
        return false;
    if (!mainstream)
        return true;
    const mc = parseCssColor(mainstream);
    if (!mc)
        return true;
    const dist = Math.abs(c.r - mc.r) + Math.abs(c.g - mc.g) + Math.abs(c.b - mc.b);
    return dist >= 0.25;
}
// 关键词只是弱证据（+1），绝不作为必要条件；去掉对中文有害的 \b（中文不是 \w，\b 会误判边界）。
const NOTE_KEYWORD = /^(备注|说明|注意|提示|标注|注[:：]|annotation|note)/i;
const NOTE_TEXT_KEYWORD = /^(备注|说明|注意|提示|标注|注[:：])/;
/** 码点长度（JS length 会把代理对算成 2，这里按 Unicode 码点数） */
const cpLen = (s) => [...s].length;
/** 句读标点：中英文逗号/句号/问号/叹号/分号/顿号/引号等 */
const SENTENCE_PUNCT_RE = /[。！？；，、：．!?,;:“”‘’「」『』（）()]/;
/** 行为词（弱证据，多语言）：描述交互/状态约束，而非产品静态标签 */
const BEHAVIOR_RE = /可点击|点击|激活|不可编辑|编辑态|自动|选择|切换|展开|折叠|显示|隐藏|禁用|启用|只读|必填|默认|支持|方可|才会|只有|enable|disable|click|tap|auto|select|toggle|expand|collapse|show|hide|editable|readonly|active/i;
/** 无语义帧名：Page 1 / Frame N / Untitled / 设计组件 / 纯数字 等，不作组件标题 */
const TITLE_FRAME_DENY = /^(page\s*\d+|frame\s*\d+|untitled|设计组件|component\s*\d+|group\s*\d+|section\s*\d+|画布|图层|\d+)$/i;
/** 众数：出现次数最多的值；并列取先出现者，空集返回 undefined */
function modeOf(xs) {
    const counts = new Map();
    for (const x of xs)
        counts.set(x, (counts.get(x) ?? 0) + 1);
    let best;
    let max = 0;
    for (const [x, n] of counts)
        if (n > max) {
            max = n;
            best = x;
        }
    return best;
}
/** 同层 TEXT 兄弟节点的主流字色（出现最多者，排除候选自身） */
function mainstreamTextColor(siblings, excludeId) {
    return modeOf(siblings
        .filter((s) => s.id !== excludeId && s.kind === 'text' && s.text?.color)
        .map((s) => s.text.color));
}
/** 同层 TEXT 兄弟节点的正文字号众数（排除候选自身） */
function bodyFontSizeMode(siblings, excludeId) {
    return modeOf(siblings
        .filter((s) => s.id !== excludeId && s.kind === 'text' && (s.text?.size ?? 0) > 0)
        .map((s) => s.text.size));
}
/** 名字是否≈正文（autoRename 的 Figma 语义）：去空白/标点后比较 */
function nameMatchesText(name, text) {
    const norm = (s) => s.replace(/[\s\u200b]/g, '')
        .replace(/[“”‘’「」『』]/g, '').replace(/[，,。.！!？?；;：:]/g, '');
    const a = norm(name);
    const b = norm(text);
    return a.length > 0 && a === b;
}
export function extractAnnotations(root) {
    const out = [];
    const visit = (parent, depth) => {
        const kids = parent.children;
        const frames = kids.filter((c) => c.kind !== 'text' && c.type !== 'TEXT');
        const nameCount = new Map();
        for (const f of frames)
            nameCount.set(f.name, (nameCount.get(f.name) ?? 0) + 1);
        const groupCount = Math.max(0, ...nameCount.values());
        const hasVariantGroup = groupCount >= 2;
        const kept = [];
        for (const child of kids) {
            // 隐藏层不是设计意图：与 flatten/extractTitles 一致，隐藏节点不参与备注判定。
            // 保留在树里（不渲染），但不摘除、不进 requirements。
            if (child.raw?.visible === false) {
                kept.push(child);
                continue;
            }
            let scored;
            if (child.kind === 'text') {
                const signals = [];
                const reasons = [];
                let score = 0;
                const add = (kind, weight, value, reason) => {
                    signals.push({ kind, weight, ...(value != null ? { value } : {}) });
                    reasons.push(reason);
                    score += weight;
                };
                const text = String(child.value ?? '').trim();
                const textSiblings = kids;
                // 1) 根直连子节点（visit 的 depth 是父节点深度，根为 0）
                if (depth === 0)
                    add('rootDirectChild', 2, undefined, '根直连子节点');
                // 2) 同名变体组
                if (hasVariantGroup)
                    add('variantGroup', 2, `同名帧×${groupCount}`, '同名变体组');
                // 3) 几何位于组件外（与所有兄弟 frame 都不相交）
                const outside = frames.length > 0 && frames.every((f) => f.x + f.w <= child.x || child.x + child.w <= f.x || f.y + f.h <= child.y || child.y + child.h <= f.y);
                if (outside)
                    add('outsideGeometry', 2, undefined, '几何位于组件外的留白区');
                // 4) 颜色：扩展红域 / 相对同层主流文案色的色差
                const mainstream = mainstreamTextColor(textSiblings, child.id);
                const color = child.text?.color;
                if (colorAnnotationSignal(color, mainstream))
                    add('noteColor', 2, color, '备注红/色差');
                // 5) prose 长度≥12 码点且含句读标点
                if (cpLen(text) >= 12 && SENTENCE_PUNCT_RE.test(text))
                    add('prosePunct', 2, `${cpLen(text)}码点`, 'prose≥12且含句读');
                // 6) 行为词（弱，多语言）
                if (BEHAVIOR_RE.test(text) || BEHAVIOR_RE.test(child.name))
                    add('behaviorWord', 1, undefined, '行为词');
                // 7) autoRename 且 name≈正文
                if (child.raw?.autoRename === true && nameMatchesText(child.name, text))
                    add('autoRenameNameEqText', 1, undefined, 'autoRename且名≈正文');
                // 8) 字号/字重异于同层 UI 正文
                const bodySize = bodyFontSizeMode(textSiblings, child.id);
                const sizeDiff = bodySize != null && (child.text?.size ?? 0) > 0 && child.text.size !== bodySize;
                const bodyWeight = modeOf(textSiblings
                    .filter((s) => s.id !== child.id && s.kind === 'text' && (s.text?.weight ?? 0) > 0)
                    .map((s) => s.text.weight));
                const weightDiff = bodyWeight != null && (child.text?.weight ?? 0) > 0 && child.text.weight !== bodyWeight;
                if (sizeDiff || weightDiff)
                    add('fontDiffersFromBody', 1, `size=${child.text?.size}/${bodySize} weight=${child.text?.weight}/${bodyWeight}`, '字号/字重异于正文');
                // 9) 关键词（弱，绝不作为必要条件）
                const keyword = NOTE_KEYWORD.test(child.name) || NOTE_TEXT_KEYWORD.test(text);
                if (keyword)
                    add('keyword', 1, undefined, '名称/正文含备注关键词');
                // 结构信号（根直连/变体组/几何）只提供权重，不能单独把 UI 文案抬成备注：
                // 至少要有「颜色」或「prose」这类内容信号。这是单一弱门槛，不是全信号硬合取。
                const hasContentSignal = signals.some((s) => s.kind === 'noteColor' || s.kind === 'prosePunct');
                if (score >= 4 && hasContentSignal) {
                    const disposition = score >= 7 ? 'auto' : 'candidate';
                    // 归属：优先整组变体；否则取纵向最近的组件；再否则 unassigned
                    let targetId;
                    let targetName;
                    let variantIds = [];
                    let variantNames = [];
                    let scope = 'unassigned';
                    if (hasVariantGroup) {
                        targetId = parent.id;
                        targetName = parent.name;
                        variantIds = frames.map((f) => f.id);
                        variantNames = frames.map((f) => f.name);
                        scope = 'group';
                    }
                    else if (frames.length) {
                        const cy = child.y + child.h / 2;
                        const nearest = [...frames].sort((a, b) => Math.abs(a.y + a.h / 2 - cy) - Math.abs(b.y + b.h / 2 - cy))[0];
                        targetId = nearest.id;
                        targetName = nearest.name;
                        variantIds = [nearest.id];
                        variantNames = [nearest.name];
                        scope = 'single';
                    }
                    scored = {
                        score,
                        auto: disposition === 'auto',
                        annotation: {
                            id: child.id, text, title: text.split('\n')[0].trim(),
                            x: child.x, y: child.y, w: child.w, h: child.h,
                            color: child.text?.color,
                            detectedBy: reasons,
                            targetId, targetName, variantIds, variantNames,
                            signals,
                            confidence: Math.min(1, score / 10),
                            disposition,
                            scope,
                        },
                    };
                }
            }
            // 命中（含 candidate）都要记进 annotations；只有 auto 才从树里摘除。
            if (scored)
                out.push(scored.annotation);
            if (scored && scored.auto)
                continue;
            kept.push(child);
        }
        parent.children = kept;
        for (const child of kept)
            visit(child, depth + 1);
    };
    visit(root, 0);
    return out;
}
/**
 * 推断页面/组件标题。CANVAS 根名永不作标题；无语义帧名被 deny-list 过滤。
 * prominentText 需同时满足：全局最大字号且唯一、>=1.5×正文字号众数、码点<=30、位于画布顶部带。
 * 候选备注（保留在树里的 red prose）第一行作为 annotationTitle。
 */
export function extractTitles(root) {
    const out = [];
    const seenTextIds = new Set();
    const seenFrameNames = new Set();
    const all = [];
    const walk = (n) => {
        if (n.raw?.visible === false)
            return;
        all.push(n);
        for (const c of n.children)
            walk(c);
    };
    walk(root);
    const texts = all.filter((n) => n.kind === 'text' && n.value && n.text && (n.text.size ?? 0) > 0);
    const sizes = texts.map((n) => n.text.size);
    const bodyMode = modeOf(sizes);
    const maxSize = sizes.length ? Math.max(...sizes) : 0;
    const maxCount = sizes.filter((s) => s === maxSize).length;
    // 1) prominentText：全局最大字号且唯一 + >=1.5×正文众数 + 码点<=30 + 顶部带
    if (texts.length && bodyMode != null && maxCount === 1 && maxSize >= bodyMode * 1.5) {
        const cand = texts.find((n) => n.text.size === maxSize);
        const cp = cpLen(cand.value);
        const topBand = root.h > 0 ? cand.y <= Math.max(root.h * 0.25, 80) : true;
        if (cp <= 30 && topBand) {
            out.push({
                text: cand.value.trim(),
                source: 'prominentText',
                nodeId: cand.id,
                x: cand.x, y: cand.y, w: cand.w, h: cand.h,
                fontSize: maxSize, weight: cand.text.weight,
                level: 'page',
                confidence: Math.min(1, Number((0.7 + 0.1 * (maxSize / bodyMode)).toFixed(3))),
                signals: [
                    { kind: 'maxFontSizeUnique', weight: 2, value: `${maxSize}px` },
                    { kind: 'sizeVsBodyMode', weight: 2, value: `${(maxSize / bodyMode).toFixed(2)}x` },
                    { kind: 'codepoints<=30', weight: 1, value: `${cp}` },
                    { kind: 'topBand', weight: 1, value: `y=${Math.round(cand.y)}` },
                ],
            });
            seenTextIds.add(cand.id);
        }
    }
    // 2) frameName：语义帧名，CANVAS 根名跳过、deny-list 过滤、按名字去重
    const frames = all.filter((n) => (n.type === 'FRAME' || n.type === 'GROUP' || n.type === 'SECTION' || n.kind === 'frame') && n.name && n.name.trim());
    for (const f of frames) {
        if (f === root && f.type === 'CANVAS')
            continue;
        const name = f.name.trim();
        if (TITLE_FRAME_DENY.test(name) || seenFrameNames.has(name))
            continue;
        seenFrameNames.add(name);
        out.push({
            text: name,
            source: 'frameName',
            nodeId: f.id,
            x: f.x, y: f.y, w: f.w, h: f.h,
            level: f === root ? 'page' : 'section',
            confidence: f === root ? 0.8 : 0.65,
            signals: [
                { kind: 'semanticFrameName', weight: 2, value: name },
                ...(f === root ? [{ kind: 'rootFrame', weight: 1 }] : []),
            ],
        });
    }
    // 3) annotationTitle：留在树里的候选备注（红字 prose）第一行当标题
    for (const n of texts) {
        if (seenTextIds.has(n.id))
            continue;
        if (isNoteRed(n.text.color) && cpLen(n.value) >= 12) {
            out.push({
                text: n.value.split('\n')[0].trim(),
                source: 'annotationTitle',
                nodeId: n.id,
                x: n.x, y: n.y, w: n.w, h: n.h,
                fontSize: n.text.size, weight: n.text.weight,
                level: 'section',
                confidence: 0.6,
                signals: [
                    { kind: 'annotationLikeText', weight: 2 },
                    { kind: 'noteColor', weight: 2, value: n.text.color },
                ],
            });
        }
    }
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
    // 备注是交互说明：从 UI 树里摘掉（不能画进基准页），但必须进 SPEC/Prompt。
    // 先摘备注再提标题：auto 备注已不在树里，不会污染 prominentText/frameName。
    const annotations = extractAnnotations(tree);
    const titles = extractTitles(tree);
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
        if (n.layout?.counterSpacing != null)
            layoutParts.push(`crossGap=${n.layout.counterSpacing}`);
        if (n.layout?.grid)
            layoutParts.push(`grid=${n.layout.grid.columnIds.length}列×${n.layout.grid.rowIds.length || 1}行 gap=${n.layout.grid.columnGap}/${n.layout.grid.rowGap}`);
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
            font: n.text ? `${n.text.family} ${n.text.weight} ${n.text.size}px/${n.text.lineHeight ?? '-'}` : n.instanceTexts?.map((p) => `${p.value}: ${p.family} ${p.weight} ${p.size}px/${p.lineHeight ?? '-'}`).join('；'),
            instanceFonts: n.instanceTexts?.map((p) => `${p.value}: ${p.family} ${p.weight} ${p.size}px/${p.lineHeight ?? '-'} @(${p.x},${p.y}) ${p.w}×${p.h}`).join('；'),
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
        annotations,
        titles,
    };
}
//# sourceMappingURL=design.js.map