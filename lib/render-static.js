/**
 * 静态还原页（Design Faithfulness Page）
 *
 * 为什么需要它：审计清单是"文字"，代码骨架是"近似"，两者都无法让人一眼判断
 * "到底有没有还原设计稿"。这个工具把设计稿**逐节点**渲染成一张 1:1 的静态页面
 * （结构/坐标/逐边描边/逐角圆角/字体/阴影 全部来自设计数据），
 * 作为唯一的**视觉基准**：人工先确认它，再让组件实现去对齐它。
 *
 * ── 这一版的三个结构性修正 ──
 * 1. **嵌套渲染 + auto-layout 成 flex**：以前全页绝对定位，容器的圆角/裁剪/透明度对子节点无效，
 *    而且"基准是绝对定位、交付是 flex"这次翻译发生在两个轮次、无人验证。
 *    现在按 auto-layout 直接出 flex（`layout.ts` 的同一套规则），并另出一份 `abs.html` 全绝对定位作对照，
 *    两侧都用设计坐标做断言（`abs-vs-flex.json`）。
 * 2. **根节点与容器的绘制不再丢**：根节点自身的填充/描边/圆角/阴影画在 `#frame` 上，
 *    子容器按 `clipsContent` 决定 `overflow`。
 * 3. **实例按真实绘制值优先**：实例自身带 fillPaints/strokePaints 时用真实值，
 *    只有缺失才回落到设计系统常量，并在元素上打 `data-guessed="1"`（台账可见）。
 *
 * 约定：
 * - 生成的样式**不得直接搬进项目**：项目的组件自带样式与主题令牌，映射规则写在 SPEC.md 里。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { flatten } from './design.js';
import { borderPaint, flexDecls, flowChildDecls, flowsInParent, orderFlow, radiusDecl, rootCssDecls, verifyFlexPlan } from './layout.js';
import { iconRefOf } from './icons.js';
const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
/** 数值格式化：去掉浮点尾巴，但保留 0.5 这类真实半像素 */
const px = (v) => {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n))
        return '0';
    return String(Math.round(n * 100) / 100);
};
/** 设计备注/标题新契约字段的摘要；字段未落地或 undefined 时兜底，不臆造 */
const fmtConf = (v) => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '-';
const fmtSignals = (s) => (s ?? []).map((x) => `${x.kind}:${x.weight}${x.value ? `(${x.value})` : ''}`).join('、') || '-';
export function joinRoleOf(n) {
    return n._joinRole;
}
function flat(model) {
    return flatten(model).filter((n) => n.kind !== 'root');
}
const isGray = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m)
        return true;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return Math.max(r, g, b) - Math.min(r, g, b) < 24;
};
/** 徽标底应选择浅色 surface，不能把音频进度条的深主色误当成所有浅色底。 */
const isLightChromatic = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m || isGray(hex))
        return false;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return (r * 0.2126 + g * 0.7152 + b * 0.0722) >= 180;
};
/** 从设计数据里"投票"出设计系统常量，避免把某个项目的色值写死在插件里 */
export function inferDesignSystem(model) {
    const nodes = flat(model);
    const tally = (vals) => {
        const m = new Map();
        for (const v of vals)
            if (v)
                m.set(v, (m.get(v) ?? 0) + 1);
        return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    const borderColors = nodes.map((n) => n.border?.color);
    const textColors = nodes.filter((n) => n.kind === 'text').map((n) => n.text?.color);
    const radii = nodes.map((n) => n.radius).filter((r) => !!r && !r.includes(' '));
    const line = tally(borderColors) ?? '#dee0ec';
    const brand = tally(nodes.map((n) => n.text?.color).filter((c) => c && !isGray(c)))
        ?? tally(borderColors.filter((c) => c && !isGray(c)))
        ?? line;
    const fontFamily = tally(nodes.filter((n) => n.text).map((n) => n.text?.family)) ?? 'system-ui';
    return {
        line,
        // 次级线色必须是**灰色系**：之前只取"第二常见的边框色"，实测取到了 Verified 成功标签的绿色
        lineStrong: tally(nodes.map((n) => n.border?.color).filter((c) => c && c !== line && isGray(c))) ?? line,
        text: tally(textColors) ?? '#1c2433',
        placeholder: tally(textColors.filter((c) => c && c !== (tally(textColors) ?? ''))) ?? '#a7b3c4',
        primary: brand,
        accentSurface: tally(nodes.map((n) => n.background).filter((c) => c && c !== brand && isLightChromatic(c))) ?? '#edf2ff',
        radius: Number((tally(radii) ?? '8px').replace('px', '')) || 8,
        controlH: 34,
        fontFamily,
    };
}
const KIND_OF = [
    [/hand|cursor|光标/i, 'skip'],
    [/^\*$/, 'required'],
    [/radio|单选框/i, 'radio'],
    [/delete|trash|删除/i, 'icon-trash'],
    [/tag|标签/i, 'tag'],
    [/upload|上传/i, 'upload'],
    [/date|calendar|日期/i, 'date'],
    [/select|dropdown|下拉|combo/i, 'select'],
    [/button|btn|按钮/i, 'button'],
    [/input|输入/i, 'input'],
];
function kindOfInstance(n) {
    for (const [re, k] of KIND_OF)
        if (re.test(n.name))
            return k;
    return 'placeholder';
}
/** 描边声明（非布局画法，见 layout.ts 的 borderPaint）；fallback 时由调用方打标记 */
function borderDecl(b, shadow) {
    return borderPaint(b, shadow);
}
function libraryIconHtml(n, ctx) {
    const asset = ctx.iconAssets[n.id];
    const ref = iconRefOf(n);
    if (!asset || !ref)
        return '';
    return `<img src="${esc(asset)}" alt="${esc(ref.name)}" draggable="false" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block" data-icon-library="${esc(ref.name)}" />`;
}
/** 本次渲染里回落到真 CSS border 的节点（会占布局 → 必须告警） */
const fallbackNodes = [];
/**
 * 实例 → 控件占位。
 * 关键：实例**自己的** fillPaints/strokePaints/radius/shadow 是真实设计值，优先使用；
 * 只有缺失时才回落到设计系统常量，并打 `data-guessed`，让台账能区分"设计的"和"猜的"。
 */
function instanceHtml(n, ctx, parent, inFlow, coord = 'relative', index = 0) {
    const { ds, style } = ctx;
    const k = kindOfInstance(n);
    if (k === 'skip')
        return '';
    const decl = ['box-sizing:border-box'];
    if (inFlow && parent)
        decl.push(...flowChildDecls(n, parent, index), `width:${px(n.w)}px`, `height:${px(n.h)}px`);
    else
        decl.push(`position:absolute`, `left:${px(coord === 'root' ? n.x : n.rx)}px`, `top:${px(coord === 'root' ? n.y : n.ry)}px`, `width:${px(n.w)}px`, `height:${px(n.h)}px`);
    const libraryIcon = libraryIconHtml(n, ctx);
    if (libraryIcon) {
        if (n.background)
            decl.push(`background:${n.background}`);
        if (n.opacity != null)
            decl.push(`opacity:${n.opacity}`);
        return `<div class="${style(decl.join(';'))}" data-design-id="${esc(n.id)}" data-design-name="${esc(n.name)}" data-src="icon-library" title="${esc(`${n.id} ${n.name} · ${iconRefOf(n)?.name}`)}">${libraryIcon}</div>`;
    }
    const guessed = [];
    const rad = radiusDecl(n, ds.radius);
    if (n.background)
        decl.push(`background:${n.background}`);
    else if (k === 'input' || k === 'select' || k === 'date' || k === 'button' || k === 'radio') {
        decl.push(`background:#fff`);
        guessed.push('background');
    }
    const bp = borderDecl(n.border, n.shadow);
    decl.push(...bp.decls);
    if (bp.fallback)
        fallbackNodes.push(n.id);
    else if (k === 'input' || k === 'select' || k === 'date') {
        decl.push(`border-style:solid`, `border-color:${ds.line}`, `border-width:1px`);
        guessed.push('border');
    }
    else if (k === 'upload' || k === 'icon-trash') {
        decl.push(`border-style:dashed`, `border-color:${ds.lineStrong}`, `border-width:1px`);
        guessed.push('border');
    }
    if (n.opacity != null)
        decl.push(`opacity:${n.opacity}`);
    if (n.clips)
        decl.push('overflow:hidden');
    if (k === 'radio') {
        decl.push('border-radius:50%');
        guessed.push('radius');
    }
    else {
        decl.push(`border-radius:${rad.value}`);
        if (rad.guessed)
            guessed.push('radius');
    }
    if (n.layout?.mode && coord === 'relative')
        decl.push(...flexDecls(n));
    // derivedSymbolData 直接提供实例文本的字体、尺寸和局部位置；全丢时才退回近似样式。
    const parts = n.instanceTexts ?? [];
    const txt = esc(parts.length ? '' : n.value ?? '');
    const selectedText = k === 'placeholder' && (n.border?.bottom ?? 0) > 2;
    const color = parts.length && selectedText ? n.border?.color ?? ds.primary
        : n.text?.color ?? (k === 'tag' || k === 'placeholder' && parts.length ? ds.text : n.value ? ds.text : ds.placeholder);
    if (k === 'required') {
        decl.push(`color:#e64545`, `font:600 12px/${px(n.h)}px ${ds.fontFamily}`);
        guessed.push('font');
    }
    else if (k === 'tag') {
        decl.push(`color:${color}`, `font:700 12px/${px(n.h)}px ${ds.fontFamily}`, 'text-align:center', 'overflow:hidden');
        guessed.push('font');
    }
    else if (k === 'button') {
        const primary = /save|保存|确定|confirm|ok|submit|提交/i.test(n.value ?? '');
        if (!n.background) {
            decl.push(`background:${primary ? ds.primary : '#fff'}`);
            guessed.push('background');
        }
        if (!n.border) {
            decl.push(`border-style:solid`, `border-color:${primary ? ds.primary : ds.line}`, `border-width:1px`);
            guessed.push('border');
        }
        decl.push(`color:${primary && !n.text?.color ? '#fff' : color}`, `font:700 ${n.h <= 24 ? 12 : 14}px/${px(n.h)}px ${ds.fontFamily}`, 'text-align:center');
        guessed.push('font');
    }
    else {
        const first = parts[0];
        decl.push(`color:${color}`);
        if (first) {
            decl.push(`font-family:'${first.family}',${ds.fontFamily},sans-serif`, `font-size:${first.size}px`, `font-weight:${first.weight}`);
            guessed.push('text-color'); // derived 有度量、没有前景色；不能伪称字体颜色也已完整还原
        }
        else {
            decl.push(`font:400 14px/${px(n.h)}px ${ds.fontFamily}`);
            guessed.push('font');
        }
    }
    const derivedText = parts.length ? parts.map((part) => {
        const badge = part.containerWidth != null;
        const boxW = part.containerWidth ?? Math.max(part.w, Math.ceil(part.value.length * part.size * 0.6));
        const bodyColor = k === 'tag' || selectedText ? ds.primary : color;
        const style = `position:absolute;left:${px(part.x)}px;top:${px(part.y)}px;height:${px(badge ? part.containerHeight : part.h)}px;min-width:${px(boxW)}px;max-width:${px(Math.max(boxW, n.w - part.x))}px;box-sizing:border-box;display:flex;align-items:center;justify-content:${badge ? 'center' : 'flex-start'};color:${bodyColor};font-family:'${part.family}',${ds.fontFamily},sans-serif;font-size:${part.size}px;font-weight:${part.weight};line-height:${part.lineHeight ?? 'normal'};white-space:pre;overflow:hidden;text-overflow:ellipsis${badge ? (part.containerStroke
            // derived 有描边几何 → 徽标是描边胶囊；描边/文字色无 paint 记录，用本页品牌色并标 guessed。
            ? `;background:#fff;border:1px solid ${ds.primary};border-radius:999px;color:${ds.primary}`
            : `;background:${ds.accentSurface};border-radius:3px`) : ''}`;
        return `<span style="${esc(style)}" data-instance-text="${esc(part.value)}">${esc(part.value)}</span>`;
    }).join('') : '';
    const hasDerivedText = parts.length > 0;
    if (hasDerivedText)
        guessed.push('layout-detail'); // 未展开的整棵实例树仍要求项目组件做最终实现
    if (parts.some((p) => p.containerStroke))
        guessed.push('badge-stroke-color'); // 描边几何是设计证据，颜色不是
    if (parts.some((p) => p.fontInferred))
        guessed.push('instance-font'); // 某段 derived 字体缺失，沿用同实例上一段
    const arrow = k === 'select'
        ? `<svg width="10" height="6" viewBox="0 0 10 6" style="position:absolute;right:11px;top:${px(n.h / 2 - 3)}px"><path d="M1 1l4 4 4-4" stroke="${ds.lineStrong}" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`
        : '';
    const inner = hasDerivedText ? derivedText : k === 'input' || k === 'select' || k === 'date'
        ? `<span style="position:absolute;left:12px;right:20px;top:0;height:${px(n.h)}px;line-height:${px(n.h)}px;color:${color};font:400 14px ${ds.fontFamily};white-space:pre;overflow:hidden">${txt}</span>${arrow}`
        : txt;
    const tip = esc(`${n.id} ${n.name} [实例${n.instanceInternalMissing ? '·内部数据缺失' : '·真实绘制值'}${guessed.length ? `·推断:${guessed.join('/')}` : ''}]`);
    return `<div class="${style(decl.join(';'))}" data-design-id="${esc(n.id)}" data-design-name="${esc(n.name)}"${guessed.length ? ` data-guessed="${[...new Set(guessed)].join(',')}"` : ''}${bp.fallback ? ' data-src="border-fallback"' : ''} title="${tip}">${inner}</div>`;
}
/** 单个节点 → 元素（含子节点）。parent/inFlow 决定它是不是在父容器的 flex 流里 */
function renderChild(n, ctx, parent, coord = 'relative', withChildren = true, index = 0) {
    const { ds, style } = ctx;
    const inFlow = coord === 'relative' && flowsInParent(n, parent);
    if (n.type === 'INSTANCE')
        return instanceHtml(n, ctx, parent, inFlow, coord, index);
    if (n.kind === 'text')
        return renderText(n, ctx, parent, coord, index);
    const decl = [];
    if (inFlow && parent) {
        decl.push(...flowChildDecls(n, parent, index), `width:${px(n.w)}px`, `height:${px(n.h)}px`);
    }
    else {
        decl.push(`position:absolute`, `left:${px(coord === 'root' ? n.x : n.rx)}px`, `top:${px(coord === 'root' ? n.y : n.ry)}px`, `width:${px(n.w)}px`, `height:${px(n.h)}px`);
    }
    decl.push('box-sizing:border-box');
    if (n.background)
        decl.push(`background:${n.background}`);
    const bp = borderDecl(n.border, n.shadow);
    decl.push(...bp.decls);
    if (bp.fallback)
        fallbackNodes.push(n.id);
    if (n.kind === 'ellipse')
        decl.push('border-radius:50%');
    else if (n.radius)
        decl.push(`border-radius:${n.radius}`);
    if (n.opacity != null)
        decl.push(`opacity:${n.opacity}`);
    if (n.clips)
        decl.push('overflow:hidden');
    if (n.rotation)
        decl.push(`transform:rotate(${n.rotation}deg)`, 'transform-origin:0 0');
    if (n.layout?.mode && coord === 'relative')
        decl.push(...flexDecls(n));
    const tip = esc(`${n.id} ${n.name} [${n.type}]`);
    if (n.kind === 'icon') {
        const libraryIcon = libraryIconHtml(n, ctx);
        if (libraryIcon)
            return `<div class="${style(decl.join(';'))}" data-design-id="${esc(n.id)}" data-src="icon-library" title="${tip}">${libraryIcon}</div>`;
        // 未识别到图标库资源：保留占位，不能照命令流自行描图。
        // 0 高分割线若用 1px 四边 border 会变成 2px 流内元素，把后面的文本整体推偏 2px。
        if (n.w && n.h)
            decl.push(`border-style:dashed`, `border-color:${ds.lineStrong}`, `border-width:1px`, 'border-radius:2px');
        else
            decl.push(`outline:1px dashed ${ds.lineStrong}`, 'outline-offset:-0.5px');
        return `<div class="${style(decl.join(';'))}" data-design-id="${esc(n.id)}" data-src="placeholder" title="${tip}"></div>`;
    }
    // 有 auto-layout 的容器：按设计主轴位置排序后再渲染（数组顺序未必等于布局顺序）
    const list = n.children.filter((c) => c.raw.visible !== false);
    const ordered = n.layout?.mode ? orderFlow(list, n) : list;
    const kids = withChildren ? ordered.map((c, i) => renderChild(c, ctx, n, 'relative', true, i)).join('\n') : '';
    const src = bp.fallback
        ? ' data-src="border-fallback"'
        : Object.values(n.prov ?? {}).some((v) => v === 'placeholder') ? ' data-src="placeholder"' : '';
    return `<div class="${style(decl.join(';'))}" data-design-id="${esc(n.id)}"${src} title="${tip}">${kids}</div>`;
}
function renderText(n, ctx, parent, coord = 'relative', index = 0) {
    const { ds, style } = ctx;
    const t = n.text;
    const decl = [];
    if (coord === 'relative' && parent && flowsInParent(n, parent)) {
        decl.push(...flowChildDecls(n, parent, index), `width:${px(n.w)}px`, `height:${px(n.h)}px`);
    }
    else {
        decl.push(`position:absolute`, `left:${px(coord === 'root' ? n.x : n.rx)}px`, `top:${px(coord === 'root' ? n.y : n.ry)}px`, `width:${px(n.w)}px`, `height:${px(n.h)}px`);
    }
    decl.push(`box-sizing:border-box`);
    if (t) {
        decl.push(`font-family:'${t.family}',${ds.fontFamily},system-ui,-apple-system,sans-serif`);
        decl.push(`font-size:${t.size}px`, `font-weight:${t.weight}`);
        if (t.italic)
            decl.push('font-style:italic');
        if (t.lineHeight)
            decl.push(`line-height:${t.lineHeight}`);
        if (t.letterSpacing)
            decl.push(`letter-spacing:${t.letterSpacing}`);
        if (t.align)
            decl.push(`text-align:${t.align}`);
        if (t.color)
            decl.push(`color:${t.color}`);
    }
    // 垂直对齐：设计里 CENTER 的文本放在固定高盒子里，贴顶会偏 (h - lineHeight)/2
    const av = String(t?.alignVertical ?? 'TOP').toUpperCase();
    if (av === 'CENTER' || av === 'BOTTOM') {
        decl.push('display:flex', 'flex-direction:column', `justify-content:${av === 'CENTER' ? 'center' : 'flex-end'}`);
    }
    // 换行策略：HEIGHT/NONE 区别在"宽度固定后要不要自动折行"
    if (t?.autoResize === 'HEIGHT')
        decl.push('white-space:pre-wrap', 'word-break:break-word', 'overflow:visible');
    else if (t?.autoResize === 'TRUNCATE')
        decl.push('white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis');
    else
        decl.push('white-space:pre', `overflow:${t?.autoResize === 'NONE' ? 'hidden' : 'visible'}`);
    const tip = esc(`${n.id} ${n.name} [TEXT]`);
    return `<span class="${style(decl.join(';'))}" data-design-id="${esc(n.id)}" title="${tip}">${esc(n.value ?? '')}</span>`;
}
/** 根节点自身也要画：以前 root 直接 return ''，深色面板/卡片会变成透明 */
function rootDecls(model) {
    return rootCssDecls(model);
}
function pageShell(opts) {
    const { model } = opts;
    return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>${esc(opts.title)}</title>
<script>// 出图模式：?png=1 时隐藏调试浮层、去掉灰底，保证截图是"干净的设计图"
if (location.search.indexOf('png=1') >= 0) document.documentElement.className += ' png-mode';</script>
<style>
  html.png-mode #hud{display:none!important}
  html.png-mode body{background:#fff}
  html.png-mode #frame{outline:none}
  html,body{margin:0;padding:0;background:#dedede}
  body{font-family:${opts.fonts.map((f) => `'${f}'`).join(',') || 'system-ui'},system-ui,-apple-system,'PingFang SC',sans-serif}
  #frame{width:${px(model.width)}px;height:${px(model.height)}px;${opts.frameStyle};outline:1px solid #000}
  ${opts.css}
  #hud{position:fixed;left:12px;bottom:12px;z-index:2147483647;background:rgba(0,0,0,.82);color:#eee;
       font:12px/1.7 ui-monospace,Menlo,monospace;padding:8px 10px;border-radius:6px;max-width:460px}
  #hud b{color:#8fd3ff}
</style></head>
<body>
<div id="frame">${opts.body}</div>
<div id="hud">${opts.hud}</div>
<pre id="probe" style="position:fixed;left:-99999px;top:0"></pre>
<script>
window.addEventListener('load', function () {
  var f = document.getElementById('frame').getBoundingClientRect();
  var missingFonts = [];
  try {
    var families = ${JSON.stringify(opts.fonts)};
    for (var i = 0; i < families.length; i++) {
      if (families[i] && document.fonts && document.fonts.check && !document.fonts.check('12px "' + families[i] + '"')) missingFonts.push(families[i]);
    }
  } catch (e) {}
  var out = { frame: [Math.round(f.left), Math.round(f.top)], count: document.querySelectorAll('#frame [data-design-id]').length, missingFonts: missingFonts };
  document.getElementById('probe').textContent = 'PROBE=' + JSON.stringify(out);
});
</script>
</body></html>`;
}
/** 生成 SPEC.md：设计规格 + 到项目 token 的映射表（右列由人/会话填） */
export function renderSpecMarkdown(model, ds, projectName, iconAssets = {}) {
    const L = [];
    const cov = model.coverage;
    L.push(`# 设计规格与映射表：${model.componentName}（${model.fileKey} · ${model.nodeId}）`);
    L.push('');
    L.push(`- 画布：${model.width}×${model.height} · 节点：${model.spec.length}${model.annotations.length ? ` · 设计备注：${model.annotations.length} 条（交互说明，见 0.1）` : ''}${model.titles?.length ? ` · 设计标题：${model.titles.length} 条（见 0.2）` : ''}`);
    L.push(`- 从设计中推断的设计系统常量：行线 \`${ds.line}\`、主色 \`${ds.primary}\`、正文 \`${ds.text}\`、占位 \`${ds.placeholder}\`、圆角 ${ds.radius}px、控件高 ${ds.controlH}px、字体 ${ds.fontFamily}`);
    L.push('');
    L.push('## 0. 属性来源台账（先看这一节）');
    L.push('');
    L.push(`- ${cov.summary}`);
    L.push('- `design` = 设计数据直读；`inferred` = 由数据推断（如渐变方向、拼接组圆角）；`placeholder` = 数据缺失、占位重建（如实例内部、矢量图标、位图）');
    L.push('- **基准页上带 `data-src="placeholder"` / `data-guessed` 的元素就是"猜的"**；评审时这些位置属于"设计数据缺失"，不是实现做错了。');
    if (cov.entries.length) {
        const byProp = new Map();
        for (const e of cov.entries)
            byProp.set(e.property, (byProp.get(e.property) ?? 0) + 1);
        L.push(`- 非 design 项分布：${[...byProp.entries()].map(([k, v]) => `${k}×${v}`).join('、')}`);
    }
    L.push('');
    if (model.annotations.length) {
        L.push('## 0.1 设计备注（交互说明，必须实现）');
        L.push('');
        L.push('画布上的红字备注**不是 UI 元素**，已从基准页移除；它们是交互/状态要求，实现时必须逐条落实，不能只当注释看一眼。');
        L.push('');
        L.push('| # | 备注标题 | 适用组件 | 变体数 | 判定依据 | 置信度 | 处置 | 信号 |');
        L.push('|---|---|---|---|---|---|---|---|');
        model.annotations.forEach((a, i) => {
            const disp = a.disposition === 'candidate' ? '候选·待确认' : '自动';
            L.push(`| ${i + 1} | ${esc(a.title).replace(/\|/g, '\\|')} | ${esc(a.targetName ?? '未归属')}（${a.targetId ?? '-'}） | ${a.variantIds.length} | ${esc(a.detectedBy.join(' + '))} | ${fmtConf(a.confidence)} | ${disp} | ${esc(fmtSignals(a.signals)).replace(/\|/g, '\\|')} |`);
        });
        L.push('');
        model.annotations.forEach((a, i) => {
            L.push(`### 备注 ${i + 1}：${esc(a.title)}`);
            L.push('');
            L.push(`- 节点：\`${a.id}\` @(${a.x},${a.y}) ${a.w}×${a.h} · 颜色 ${a.color ?? '-'}`);
            if (a.targetName)
                L.push(`- 适用：${esc(a.targetName)}（${a.targetId}）${a.variantIds.length > 1 ? ` · 状态变体 ${a.variantIds.join('、')}` : ''}`);
            L.push(`- 置信度：${fmtConf(a.confidence)} · 处置：${a.disposition === 'candidate' ? '候选·待确认（不得静默丢弃，确认后再落实）' : '自动'} · 信号：${esc(fmtSignals(a.signals))}`);
            if (a.scope === 'unassigned' || !a.targetName)
                L.push('- 归属：未归属（scope=unassigned / 无 targetName），需人工确认作用范围');
            L.push('- 原文：');
            for (const line of a.text.split('\n'))
                L.push(`  > ${line || ' '}`);
            L.push('- 落实要求：按原文实现；在交付说明中逐条回答「用哪个 props/state 承载、在哪个文件实现、如何验证」。');
            L.push('');
        });
    }
    if (model.titles?.length) {
        L.push('## 0.2 设计标题（页面/分区标题：命名 + 可访问性依据）');
        L.push('');
        L.push('标题文本是**真实 UI**，已在静态基准页按节点正常渲染（不像备注那样被摘除）。实现时用它们确定组件/分区命名与可访问性标题，不要臆造或改写。');
        L.push('');
        L.push('| # | 标题文本 | 来源 | 级别 | 证据节点 | 几何/字号 | 置信度 | 信号 |');
        L.push('|---|---|---|---|---|---|---|---|');
        model.titles.forEach((t, i) => {
            const ev = t.nodeId ? `节点 ${t.nodeId}` : '-';
            const geo = [
                t.x != null && t.y != null && t.w != null && t.h != null ? `@(${t.x},${t.y}) ${t.w}×${t.h}` : '',
                t.fontSize != null ? `${t.fontSize}px` : '',
                t.weight != null ? `weight=${t.weight}` : '',
            ].filter(Boolean).join(' · ') || '-';
            L.push(`| ${i + 1} | ${esc(t.text).replace(/\|/g, '\\|')} | ${esc(t.source)} | ${esc(t.level)} | ${esc(ev)} | ${geo} | ${fmtConf(t.confidence)} | ${esc(fmtSignals(t.signals)).replace(/\|/g, '\\|')} |`);
        });
        L.push('');
    }
    L.push('## 1. 静态还原页不是"要搬进项目的样式"');
    L.push('');
    L.push('`index.html` 是**视觉基准**：按 auto-layout 出 flex + 设计稿 literal 色值，只回答"设计长什么样"。');
    L.push('`abs.html` 是同一份数据的**全绝对定位**对照页，只用于归因（判断差异是"布局翻译"还是"实现写错"）。');
    L.push('组件实现必须落回项目既有组件与主题令牌；直接用本页样式会与项目/组件库样式打架。');
    L.push('');
    L.push('## 2. 设计 → 项目 token 映射（逐条填右列）');
    L.push('');
    L.push('| 设计规律 | 设计值 | 项目落法（待填） |');
    L.push('|---|---|---|');
    L.push('| auto-layout WRAP | 保持 `parentIndex.position` 为准的兄弟顺序 + `stackCounterSpacing` | 不要按绝对 x/y 去重排设计顺序；跨行间距写 `row-gap/column-gap` |');
    L.push('| Figma Grid | `display:grid` + `gridRows/ColumnsSizing` | 使用 `grid-template-*` 与两轴 gap；不要把 GRID 归类为 VERTICAL |');
    L.push('| INSTANCE 富文本 | `derivedSymbolData` 字体与局部几何 + 全部 text overrides | 至少保留每段文案与字体；实现仍需视图谱检验颜色与图标 |');
    L.push(`| 控件高度 | ${ds.controlH}px | |`);
    L.push(`| 圆角 | ${ds.radius}px | |`);
    L.push(`| 描边 | 1px \`${ds.line}\` | |`);
    L.push(`| 正文/标签色 | \`${ds.text}\` | |`);
    L.push(`| 主色（选中/主按钮） | \`${ds.primary}\` | |`);
    L.push('| **逐边**描边（如只有左边框） | 见第 3 节 border 列 | 用 `border-width` 分边，别用整框再想办法去掉三条边 |');
    L.push('| **虚线**描边（dashPattern） | 见第 3 节 dash 列 | 用 `repeating-linear-gradient` 或 SVG stroke 表达（CSS dashed 的段长不可控） |');
    L.push('| **逐角**圆角（拼接组两端圆角/中间直角） | 见第 3 节 radius 列 | 相邻控件重叠 1px 共用一条边 |');
    L.push('| auto-layout | 见第 3 节 layout 列 | 直接写成 flex（gap/padding/justify/align/grow），不要再用绝对定位 |');
    L.push('| **拼接控件组** | 同行相邻且**间距 ≤1px** 判为拼接 | 共用边强制直角：左端格 `8 0 0 8`、**中间格 `0`**、右端格 `0 8 8 0` |');
    L.push('');
    L.push('## 3. 逐节点规格表');
    L.push('');
    L.push('| id | name | type | x | y | w | h | 背景 | 边框色 | 四边 | 虚线 | 对齐 | 圆角 | 字体 | 文案 | layout | 阴影 | 裁剪 | 来源 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of model.spec) {
        L.push(`| ${r.id} | ${esc(r.name).replace(/\|/g, '\\|')} | ${r.type} | ${r.x} | ${r.y} | ${r.w} | ${r.h} | ${r.background ?? ''} | ${r.border ?? ''} | ${r.borderEdges ?? ''} | ${r.dash ?? ''} | ${r.strokeAlign ?? ''} | ${r.radius ?? ''} | ${r.font ?? ''} | ${esc(r.text ?? '').replace(/\|/g, '\\|')} | ${r.layout ?? ''} | ${r.shadow ?? ''} | ${r.clips ? 'yes' : ''} | ${r.prov ?? ''} |`);
    }
    L.push('');
    const annos = [];
    const walkAnno = (n, parent) => {
        if (n.type === 'INSTANCE' && /hand|cursor|光标/i.test(n.name)) {
            annos.push({ id: n.id, name: n.name, parent: parent?.id ?? '-', parentName: parent?.name ?? '-' });
        }
        for (const c of n.children)
            walkAnno(c, n);
    };
    walkAnno(model.tree, null);
    if (annos.length) {
        L.push('## 4. 标注类实例（**实现不渲染**）');
        L.push('');
        L.push('| 标注节点 | 图层名 | 所在父节点 | 父节点名 | 说明 |');
        L.push('|---|---|---|---|---|');
        for (const a of annos) {
            L.push(`| ${a.id} | ${a.name} | ${a.parent} | ${a.parentName} | 设计稿的交互标注（如手型光标），**不要实现成 UI** |`);
        }
        L.push('');
    }
    L.push('## 5. 已知占位（评审时不计为实现缺陷）');
    L.push('');
    L.push('- 实例（INSTANCE）内部结构在解码数据里缺失时，按 `size + 逐角圆角 + 覆写文案 + 设计系统常量` **重建**，元素带 `data-guessed`；');
    L.push('- 没有图标库标识的矢量节点保留中性虚线占位；位图填充没有资源 → 底纹占位（均带 `data-src="placeholder"`）；');
    L.push('- 实例 `derivedSymbolData` 中的每段文字、字体、字号、行高和局部几何已读入规格；但缺失的前景色仍标 `data-guessed="text-color"`，不是完整实例树。');
    L.push('- 字体只写字体名：若本机没装，度量会有偏差（页面加载时会把缺失字体写进 probe 的 `missingFonts`）。');
    L.push('');
    const icons = [];
    const walkIcons = (n) => {
        if (n.raw.visible === false)
            return;
        const ref = iconRefOf(n);
        if (ref)
            icons.push({ node: n, library: ref.name, asset: iconAssets[n.id] });
        for (const child of n.children)
            walkIcons(child);
    };
    walkIcons(model.tree);
    if (icons.length) {
        L.push('## 6. 图标库资源（原始 SVG，不自绘）');
        L.push('');
        L.push('| 节点 | 图层 | 图标库标识 | 静态基准资产 |');
        L.push('|---|---|---|---|');
        for (const icon of icons)
            L.push(`| ${icon.node.id} | ${esc(icon.node.name)} | \`${icon.library}\` | ${icon.asset ? `${icon.asset} （库原 SVG）` : '未获取，保留占位'} |`);
        L.push('');
        L.push('最终实现用项目图标组件/库中的 SVG；没有明确标识的待映射节点见 audit missing，禁止按名字猜或照路径重画。');
        L.push('');
    }
    if (projectName)
        L.push(`> 目标项目：${projectName}`);
    return L.join('\n');
}
export function renderStatic(model, opts) {
    fallbackNodes.length = 0;
    const ds = inferDesignSystem(model);
    const outDir = resolve(opts.outputDir);
    mkdirSync(outDir, { recursive: true });
    const makeCtx = () => {
        const css = [];
        let uid = 0;
        const style = (d) => {
            const id = `n${uid++}`;
            css.push(`.${id}{${d}}`);
            return id;
        };
        return { ctx: { ds, style, iconAssets: opts.iconAssets ?? {} }, css };
    };
    const nodes = flat(model);
    const instances = nodes.filter((n) => n.type === 'INSTANCE').length;
    // 预标注"拼接组角色"：同一父级下 y 相同、水平相邻且间距 ≤1px 视为拼接
    const markJoinedRoles = (list) => {
        const byRow = new Map();
        for (const c of list) {
            if (c.raw.visible === false)
                continue;
            const y = Math.round(c.y);
            if (!byRow.has(y))
                byRow.set(y, []);
            byRow.get(y).push(c);
        }
        for (const row of byRow.values()) {
            const sorted = row.slice().sort((a, b) => a.x - b.x).filter((c) => c.w > 20);
            for (let i = 0; i < sorted.length; i++) {
                const cur = sorted[i];
                const prev = sorted[i - 1];
                const next = sorted[i + 1];
                const touchL = !!prev && cur.x - (prev.x + prev.w) <= 1;
                const touchR = !!next && next.x - (cur.x + cur.w) <= 1;
                if (!touchL && !touchR)
                    continue;
                const role = touchL && touchR ? 'mid' : touchL ? 'rightEnd' : 'leftEnd';
                const setRole = (x) => {
                    ;
                    x._joinRole = role;
                    for (const c of x.children)
                        if (Math.abs(c.w - x.w) <= 2)
                            setRole(c);
                };
                setRole(cur);
            }
        }
        for (const c of list)
            if (c.children.length)
                markJoinedRoles(c.children);
    };
    markJoinedRoles([model.tree]);
    // ── 页 A：按 auto-layout 出 flex（视觉基准） ──
    const a = makeCtx();
    const topKids = model.tree.layout?.mode ? orderFlow(model.tree.children.filter((c) => c.raw.visible !== false), model.tree) : model.tree.children;
    const bodyFlex = topKids.map((c, i) => renderChild(c, a.ctx, model.tree, 'relative', true, i)).join('\n');
    const frameStyle = rootDecls(model).join(';');
    const title = opts.title ?? model.componentName;
    const fonts = model.coverage.fonts;
    const html = pageShell({
        title: `设计稿静态还原 ${model.nodeId} · ${esc(title)}`,
        model, frameStyle, body: bodyFlex, css: a.css.join('\n'), fonts,
        hud: `<b>设计稿静态还原（视觉基准）</b> · ${esc(title)}（${model.width}×${model.height}）<br>
  逐节点来自设计数据：auto-layout→flex · 逐边描边（含虚线）· 逐角圆角 · 字体 · 容器裁剪 · 根节点绘制<br>
  带 <b>data-guessed</b> 的元素是按设计系统常量推断的；悬停可看<b>节点 ID + 图层名</b>（见 SPEC.md 第 0 节）`,
    });
    // ── 页 B：全绝对定位对照（旧行为，用于归因） ──
    const b = makeCtx();
    const bodyAbs = nodes
        .map((n) => renderChild(n, b.ctx, undefined, 'root', false))
        .join('\n');
    const htmlAbs = pageShell({
        title: `设计稿静态还原（绝对定位对照） · ${esc(title)}`,
        model, frameStyle: `${rootDecls(model).join(';')}`, body: bodyAbs, css: b.css.join('\n'), fonts,
        hud: `<b>绝对定位对照页</b> · ${esc(title)}（与 index.html 同源同数据，只改布局策略）<br>
  用途：判断实现差异是"布局翻译"造成的，还是"设计数据没读对"造成的`,
    });
    const htmlPath = join(outDir, 'index.html');
    const absHtmlPath = join(outDir, 'abs.html');
    writeFileSync(htmlPath, html, 'utf8');
    writeFileSync(absHtmlPath, htmlAbs, 'utf8');
    // ── 机器可读：规格 + 台账 + flex 推演结果 ──
    const plan = verifyFlexPlan(model);
    writeFileSync(join(outDir, 'spec.json'), JSON.stringify({
        nodeId: model.nodeId, fileKey: model.fileKey,
        width: model.width, height: model.height,
        rows: model.spec,
    }, null, 2), 'utf8');
    const coveragePath = join(outDir, 'coverage.json');
    writeFileSync(coveragePath, JSON.stringify({
        fileKey: model.fileKey, nodeId: model.nodeId,
        ...model.coverage,
        /** 回落到真 CSS border（会占布局）的节点：这些位置子项可能偏 border 宽度 */
        borderFallbacks: [...fallbackNodes],
        iconAssets: opts.iconAssets ?? {},
        iconPolicy: 'library-svg-only; unknown mappings remain placeholders and require confirmation',
    }, null, 2), 'utf8');
    const layoutReportPath = join(outDir, 'abs-vs-flex.json');
    writeFileSync(layoutReportPath, JSON.stringify({
        containers: plan.containers,
        flowChildren: plan.flowChildren,
        mismatches: plan.mismatches,
    }, null, 2), 'utf8');
    let specPath;
    if (opts.spec !== false) {
        specPath = join(outDir, 'SPEC.md');
        writeFileSync(specPath, renderSpecMarkdown(model, ds, opts.projectName, opts.iconAssets), 'utf8');
    }
    return {
        htmlPath, absHtmlPath, specPath,
        specJsonPath: join(outDir, 'spec.json'),
        coveragePath, layoutReportPath,
        stats: {
            nodes: nodes.length, rules: a.css.length + b.css.length, instances,
            flexContainers: plan.containers, flexMismatches: plan.mismatches.length,
            borderFallbacks: fallbackNodes.length,
        },
    };
}
/** 供 codegen 复用的摘要行（把规格表塞进 Codegen Prompt） */
export function specTable(model, limit = 400) {
    const rows = model.spec.slice(0, limit);
    return rows
        .map((r) => [r.id, r.name, r.type, r.x, r.y, r.w, r.h, r.background ?? '', r.borderEdges ? `${r.border}(${r.borderEdges})` : '', r.dash ?? '', r.radius ?? '', r.font ?? '', (r.text ?? '').replace(/\n/g, '\\n'), r.layout ?? ''].join(' | '))
        .join('\n');
}
//# sourceMappingURL=render-static.js.map