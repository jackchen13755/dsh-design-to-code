/**
 * 静态还原页（Design Faithfulness Page）
 *
 * 为什么需要它：审计清单是"文字"，代码骨架是"近似"，两者都无法让人一眼判断
 * "到底有没有还原设计稿"。这个工具把设计稿**逐节点**渲染成一张 1:1 的静态页面
 * （结构/坐标/逐边描边/逐角圆角/字体/阴影 全部来自设计数据），
 * 作为唯一的**视觉基准**：人工先确认它，再让组件实现去对齐它。
 *
 * 约定：
 * - 只做**绝对定位**的静态还原（这是"照抄设计"最不容易出错的方式），不承担"可维护布局"的责任；
 * - 实例（INSTANCE）内部结构在 ws.json 中缺失，按 size + 逐角圆角 + 覆写文案 + 设计系统常量**重建**，
 *   并在 SPEC 里明确标注"占位/需用项目组件替换"；
 * - 生成的样式**不得直接搬进项目**：项目的组件自带样式与主题令牌，映射规则写在 SPEC.md 里。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
function flat(model) {
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
const isGray = (hex) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m)
        return true;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return Math.max(r, g, b) - Math.min(r, g, b) < 24;
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
        lineStrong: tally(nodes.map((n) => n.border?.color).filter((c) => c && c !== line)) ?? line,
        text: tally(textColors) ?? '#1c2433',
        placeholder: tally(textColors.filter((c) => c && c !== (tally(textColors) ?? ''))) ?? '#a7b3c4',
        primary: brand,
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
/** 实例 → 控件占位（ws.json 没有实例内部数据，只能用 size/圆角/文案/设计系统常量重建） */
function instanceHtml(n, ds, style) {
    const k = kindOfInstance(n);
    if (k === 'skip')
        return '';
    const rad = n.radius ?? `${ds.radius}px`;
    const base = `position:absolute;left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px;box-sizing:border-box`;
    const tip = esc(`${n.id} ${n.name} [实例·内部数据缺失，按设计系统重建]`);
    const txt = esc(n.value ?? '');
    switch (k) {
        case 'required':
            return `<div class="${style(`${base};color:#e64545;font:600 12px/${n.h}px ${ds.fontFamily}`)}" title="${tip}">*</div>`;
        case 'radio':
            return `<div class="${style(`${base};border:1px solid ${ds.line};border-radius:50%;background:#fff`)}" title="${tip}"></div>`;
        case 'icon-trash':
            return `<div class="${style(`${base};border:1px dashed ${ds.lineStrong};border-radius:2px`)}" title="${tip}"></div>`;
        case 'tag':
            return `<div class="${style(`${base};border:1px solid ${ds.primary};border-radius:4px;color:${ds.primary};font:700 12px/${n.h}px ${ds.fontFamily};text-align:center;overflow:hidden`)}" title="${tip}">${txt}</div>`;
        case 'upload':
            return `<div class="${style(`${base};border:1px dashed ${ds.lineStrong};border-radius:${rad};color:${ds.placeholder};font:400 14px/${n.h}px ${ds.fontFamily};text-align:center`)}" title="${tip}">${txt}</div>`;
        case 'date':
        case 'select':
        case 'input': {
            const arrow = k === 'select'
                ? `<svg width="10" height="6" viewBox="0 0 10 6" style="position:absolute;right:11px;top:${Math.round(n.h / 2) - 3}px"><path d="M1 1l4 4 4-4" stroke="${ds.lineStrong}" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>`
                : '';
            const color = n.value ? ds.text : ds.placeholder;
            return `<div class="${style(`${base};border:1px solid ${ds.line};border-radius:${rad};background:#fff`)}" title="${tip}">`
                + `<span style="position:absolute;left:12px;right:20px;top:0;height:${n.h}px;line-height:${n.h}px;color:${color};font:400 14px ${ds.fontFamily};white-space:pre;overflow:hidden">${txt}</span>${arrow}</div>`;
        }
        case 'button': {
            const primary = /save|保存|确定|confirm|ok|submit|提交/i.test(n.value ?? '');
            const decl = primary
                ? `${base};border:1px solid ${ds.primary};border-radius:${rad};background:${ds.primary};color:#fff`
                : `${base};border:1px solid ${ds.line};border-radius:${rad};background:#fff;color:${ds.text}`;
            return `<div class="${style(`${decl};font:700 ${n.h <= 24 ? 12 : 14}px/${n.h}px ${ds.fontFamily};text-align:center`)}" title="${tip}">${txt || esc(n.name)}</div>`;
        }
        default:
            return `<div class="${style(`${base};border:1px dashed ${ds.lineStrong};border-radius:${rad};color:${ds.placeholder};font:400 12px/${n.h}px ${ds.fontFamily};text-align:center;background:rgba(167,179,196,.06)`)}" title="${tip}">${esc(n.name)}</div>`;
    }
}
function nodeHtml(n, ds, style) {
    const tip = esc(`${n.id} ${n.name} [${n.type}]`);
    if (n.kind === 'root')
        return '';
    if (n.type === 'INSTANCE')
        return instanceHtml(n, ds, style);
    const decl = [`position:absolute`, `left:${n.x}px`, `top:${n.y}px`, `width:${n.w}px`, `height:${n.h}px`, `box-sizing:border-box`];
    if (n.background && n.kind !== 'text')
        decl.push(`background:${n.background}`);
    if (n.border) {
        // 逐边描边：设计稿"只有左边框"必须这么表达，不能用 border:1px solid 再补三条 0
        const { top, right, bottom, left, color } = n.border;
        if (top || right || bottom || left) {
            decl.push(`border-style:solid`, `border-color:${color}`, `border-width:${top}px ${right}px ${bottom}px ${left}px`);
        }
    }
    if (n.radius)
        decl.push(`border-radius:${n.radius}`);
    if (n.shadow)
        decl.push(`box-shadow:${n.shadow}`);
    if (n.opacity != null)
        decl.push(`opacity:${n.opacity}`);
    if (n.kind === 'text') {
        const t = n.text;
        if (t) {
            decl.push(`font-family:'${t.family}',${ds.fontFamily},system-ui,-apple-system,sans-serif`);
            decl.push(`font-size:${t.size}px`, `font-weight:${t.weight}`);
            if (t.lineHeight)
                decl.push(`line-height:${t.lineHeight}`);
            if (t.letterSpacing)
                decl.push(`letter-spacing:${t.letterSpacing}`);
            if (t.align)
                decl.push(`text-align:${t.align}`);
            if (t.color)
                decl.push(`color:${t.color}`);
        }
        // 不自动换行：设计稿已定宽，硬换行保留在字符里；自动换行会因字体回退造成假换行与重叠
        decl.push(`white-space:pre`, `overflow:visible`);
        return `<span class="${style(decl.join(';'))}" title="${tip}">${esc(n.value ?? '')}</span>`;
    }
    if (n.kind === 'icon') {
        // 矢量图标拿不到路径数据，画一个中性占位，让人知道"这里是图标"
        decl.push(`border:1px dashed ${ds.lineStrong}`, `border-radius:2px`);
        return `<div class="${style(decl.join(';'))}" title="${tip}"></div>`;
    }
    return `<div class="${style(decl.join(';'))}" title="${tip}"></div>`;
}
/** 生成 SPEC.md：设计规格 + 到项目 token 的映射表（右列由人/会话填） */
export function renderSpecMarkdown(model, ds, projectName) {
    const L = [];
    L.push(`# 设计规格与映射表：${model.componentName}（${model.fileKey} · ${model.nodeId}）`);
    L.push('');
    L.push(`- 画布：${model.width}×${model.height} · 节点：${model.spec.length}`);
    L.push(`- 从设计中推断的设计系统常量：行线 \`${ds.line}\`、主色 \`${ds.primary}\`、正文 \`${ds.text}\`、占位 \`${ds.placeholder}\`、圆角 ${ds.radius}px、控件高 ${ds.controlH}px、字体 ${ds.fontFamily}`);
    L.push('');
    L.push('## 1. 静态还原页不是"要搬进项目的样式"');
    L.push('');
    L.push('`index.html` 是**视觉基准**：绝对定位 + 内联样式 + 设计稿 literal 色值，只回答"设计长什么样"。');
    L.push('组件实现必须落回项目既有组件与主题令牌；直接用本页样式会与项目/组件库样式打架（重复定义、优先级、主题失效、失去自适应）。');
    L.push('');
    L.push('## 2. 设计 → 项目 token 映射（逐条填右列）');
    L.push('');
    L.push('| 设计规律 | 设计值 | 项目落法（待填） |');
    L.push('|---|---|---|');
    L.push(`| 控件高度 | ${ds.controlH}px | |`);
    L.push(`| 圆角 | ${ds.radius}px | |`);
    L.push(`| 描边 | 1px \`${ds.line}\` | |`);
    L.push(`| 正文/标签色 | \`${ds.text}\` | |`);
    L.push(`| 主色（选中/主按钮） | \`${ds.primary}\` | |`);
    L.push('| **逐边**描边（如只有左边框） | 见第 3 节 border 列 | 用 `border-width` 分边，别用整框再想办法去掉三条边 |');
    L.push('| **逐角**圆角（拼接组两端圆角/中间直角） | 见第 3 节 radius 列 | 相邻控件重叠 1px 共用一条边 |');
    L.push('| auto-layout | 见第 3 节 layout 列 | 转成 flex，而不是绝对定位 |');
    L.push('');
    L.push('## 3. 逐节点规格表');
    L.push('');
    L.push('| id | name | type | x | y | w | h | 背景 | 边框色 | 边框四边 T/R/B/L | 圆角 | 字体 | 文案 | layout | 阴影 | 实例内部数据 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of model.spec) {
        L.push(`| ${r.id} | ${esc(r.name).replace(/\|/g, '\\|')} | ${r.type} | ${r.x} | ${r.y} | ${r.w} | ${r.h} | ${r.background ?? ''} | ${r.border ?? ''} | ${r.borderEdges ?? ''} | ${r.radius ?? ''} | ${r.font ?? ''} | ${esc(r.text ?? '').replace(/\|/g, '\\|')} | ${r.layout ?? ''} | ${r.shadow ?? ''} | ${r.instanceInternalMissing ? '⚠️缺失（用项目组件重建）' : ''} |`);
    }
    L.push('');
    L.push('## 4. 已知占位');
    L.push('');
    L.push('- 实例（INSTANCE）在解码数据里没有内部结构/填充/描边，本页按 `size + 逐角圆角 + 覆写文案 + 设计系统常量` **重建**；');
    L.push('  文案来自 `symbolData.symbolOverrides[].textData.characters`。图标（下拉箭头/日历/删除/单选）为近似占位。');
    L.push('- 字体只写字体名，未内联字体文件；若本机没装该字体，度量会有偏差 —— 对照时以"结构/尺寸/描边/圆角"为准。');
    L.push('- 标注类实例（手型光标）按设计意图不渲染。');
    L.push('');
    if (projectName)
        L.push(`> 目标项目：${projectName}`);
    return L.join('\n');
}
export function renderStatic(model, opts) {
    const ds = inferDesignSystem(model);
    const outDir = resolve(opts.outputDir);
    mkdirSync(outDir, { recursive: true });
    const css = [];
    let uid = 0;
    const style = (d) => {
        const id = `n${uid++}`;
        css.push(`.${id}{${d}}`);
        return id;
    };
    const nodes = flat(model).filter((n) => n.kind !== 'root');
    const body = nodes.map((n) => nodeHtml(n, ds, style)).join('\n');
    const instances = nodes.filter((n) => n.type === 'INSTANCE').length;
    const title = opts.title ?? model.componentName;
    const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>设计稿静态还原 ${model.nodeId} · ${esc(title)}</title>
<style>
  html,body{margin:0;padding:0;background:#dedede}
  body{font-family:'${ds.fontFamily}',system-ui,-apple-system,'PingFang SC',sans-serif}
  #frame{width:${model.width}px;height:${model.height}px;position:relative;overflow:hidden;margin:0;background:#fff;outline:1px solid #000}
  ${css.join('\n')}
  #hud{position:fixed;left:12px;bottom:12px;z-index:2147483647;background:rgba(0,0,0,.82);color:#eee;
       font:12px/1.7 ui-monospace,Menlo,monospace;padding:8px 10px;border-radius:6px;max-width:460px}
  #hud b{color:#8fd3ff}
</style></head>
<body>
<div id="frame">${body}</div>
<div id="hud">
  <b>设计稿静态还原（视觉基准）</b> · ${esc(title)}（${model.width}×${model.height}）<br>
  逐节点来自设计数据：坐标已归零 · 逐边描边 · 逐角圆角 · 字体 · 实例按设计系统重建<br>
  悬停任意元素可看<b>节点 ID + 图层名</b>；本页样式<b>不要</b>搬进项目（见 SPEC.md）
</div>
<pre id="probe" style="position:fixed;left:-99999px;top:0"></pre>
<script>
window.addEventListener('load', function () {
  var f = document.getElementById('frame').getBoundingClientRect();
  var out = { frame: [Math.round(f.left), Math.round(f.top)], count: document.querySelectorAll('#frame > *').length };
  document.getElementById('probe').textContent = 'PROBE=' + JSON.stringify(out);
});
</script>
</body></html>`;
    const htmlPath = join(outDir, 'index.html');
    writeFileSync(htmlPath, html, 'utf8');
    let specPath;
    if (opts.spec !== false) {
        specPath = join(outDir, 'SPEC.md');
        writeFileSync(specPath, renderSpecMarkdown(model, ds, opts.projectName), 'utf8');
    }
    return { htmlPath, specPath, stats: { nodes: nodes.length, rules: css.length, instances } };
}
/** 供 codegen 复用的摘要行（把规格表塞进 Codegen Prompt） */
export function specTable(model, limit = 400) {
    const rows = model.spec.slice(0, limit);
    return rows
        .map((r) => [r.id, r.name, r.type, r.x, r.y, r.w, r.h, r.background ?? '', r.borderEdges ? `${r.border}(${r.borderEdges})` : '', r.radius ?? '', r.font ?? '', (r.text ?? '').replace(/\n/g, '\\n'), r.layout ?? ''].join(' | '))
        .join('\n');
}
//# sourceMappingURL=render-static.js.map