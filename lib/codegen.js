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
import { detectRepeats } from './componentize.js';
import { iconRefOf } from './icons.js';
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
    const asGroup = ctx.groupFor(n);
    if (asGroup) {
        const decl = [...boxDecls(n, parent, inFlow), 'box-sizing: border-box'];
        const c = ctx.cls(decl.join(';\n  '));
        const vals = textValuesOf(n);
        const props = asGroup.props
            .map((pr, idx) => `${pr.name}=${JSON.stringify(vals[idx] ?? pr.sample)}`)
            .join(' ');
        ctx.jsx.push(`${indent}<div className={styles.${c}}><${asGroup.suggestedName}${props ? ` ${props}` : ''} /></div>`);
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
        ctx.jsx.push(`${indent}<span className={styles.${c}} data-design-id="${escAttr(n.id)}">${jsxText(n.value ?? '')}</span>`);
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
            ctx.jsx.push(`${indent}<div className={styles.${c}} data-design-id="${escAttr(n.id)}" data-design-name="${designName}">`
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
            ctx.jsx.push(`${indent}<button type="button" className={styles.${c}} data-design-id="${escAttr(n.id)}" data-design-name="${designName}"`
                + ` onClick={() => onAction?.(${JSON.stringify(n.value ?? n.name)}, data)}>${jsxText(n.value ?? n.name)}</button>`);
            return;
        }
        if (tag === 'radio') {
            if (!n.border)
                d.push('border-style: solid', `border-color: ${ctx.ds.line}`, 'border-width: 1px');
            d.push('border-radius: 50%');
            const c = ctx.cls(d.join(';\n  '));
            ctx.jsx.push(`${indent}<input type="radio" className={styles.${c}} data-design-name="${designName}" name="design-radio-${inst}" />`);
            return;
        }
        if (tag === 'required') {
            d.push('color: #e64545', 'display: flex', 'align-items: center');
            const c = ctx.cls(d.join(';\n  '));
            ctx.jsx.push(`${indent}<span className={styles.${c}} data-design-name="${designName}" aria-hidden="true">*</span>`);
            return;
        }
        d.push(`border-radius: ${radiusDecl(n, ctx.ds.radius).value}`);
        const c = ctx.cls(d.join(';\n  '));
        const iconRef = iconRefOf(n);
        ctx.jsx.push(`${indent}<span className={styles.${c}} data-design-id="${escAttr(n.id)}" data-design-name="${designName}"${iconRef ? ` data-icon-library="${escAttr(iconRef.name)}"` : ''}>${jsxText(n.value ?? (iconRef ? '' : n.name))}</span>`);
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
        ctx.jsx.push(`${indent}{/* 图标占位：使用项目图标库的 SVG，不要从 Figma 路径自绘 */}\n${indent}<div className={styles.${c}} data-design-id="${escAttr(n.id)}"${iconRef ? ` data-icon-library="${escAttr(iconRef.name)}"` : ''} aria-hidden="true" />`);
        return;
    }
    const c = ctx.cls(d.join(';\n  '));
    const visibleKids = n.children.filter((x) => x.raw.visible !== false);
    const kids = n.layout?.mode ? orderFlow(visibleKids, n) : visibleKids;
    if (!kids.length) {
        ctx.jsx.push(`${indent}<div className={styles.${c}} data-design-id="${escAttr(n.id)}" />`);
        return;
    }
    ctx.jsx.push(`${indent}<div className={styles.${c}} data-design-id="${escAttr(n.id)}">`);
    for (let i = 0; i < kids.length; i++)
        emitNode(kids[i], n, `${indent}  `, ctx, i);
    ctx.jsx.push(`${indent}</div>`);
}
export function generateCode(model, opts) {
    const name = safeName(opts.componentName);
    const ds = inferDesignSystem(model);
    const outDir = resolve(opts.outputDir);
    mkdirSync(join(outDir, 'src'), { recursive: true });
    // ── 组件化：把"重复出现的结构"抽成可复用组件，页面只负责组合 ──
    const maxExtract = Math.max(0, Number(opts.maxExtract ?? 3));
    const candidates = detectRepeats(model).filter((r) => r.count >= 3 && r.reusable !== false);
    const picked = [];
    const pickedSigs = new Set();
    for (const c of candidates) {
        if (picked.length >= maxExtract)
            break;
        if (pickedSigs.has(c.signature))
            continue;
        pickedSigs.add(c.signature);
        picked.push(c);
    }
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
    for (const g of picked)
        g.suggestedName = uniqueName(g.suggestedName);
    const groupBySignature = new Map();
    for (const g of picked)
        groupBySignature.set(g.signature, g);
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
    const groupFor = (n) => groupBySignature.get(sigOf(n));
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
        groupFor,
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
${picked.map((g) => `import { ${g.suggestedName} } from './components/${g.suggestedName}';`).join('\n')}

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
    // ── 可复用组件文件：重复结构抽出来的"零件"，带 props 与类型 ──
    const relComponents = [];
    const allNodes = flat([model.tree]);
    const compRoot = join(outDir, 'src', 'components');
    const dirIndex = opts.projectLayout?.layout !== 'flat';
    for (const g of picked) {
        const rep = allNodes.find((n) => n.id === g.representativeId);
        if (!rep)
            continue;
        const styles = [];
        let cuid = 0;
        const cls = (decl) => { const id = `c${cuid++}`; styles.push(`.${id} { ${decl} }`); return id; };
        const lines = [];
        let propIdx = 0;
        const inner = flat([rep]).filter((x) => x.id !== rep.id);
        for (const x of inner) {
            const rel = `position: absolute; left: ${px(x.x - rep.x)}px; top: ${px(x.y - rep.y)}px; width: ${px(x.w)}px; height: ${px(x.h)}px; box-sizing: border-box;`;
            const isProp = (x.kind === 'text' && !!x.value) || (x.type === 'INSTANCE' && !!x.value);
            const propName = isProp && propIdx < g.props.length ? g.props[propIdx].name : undefined;
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
        const propsDecl = g.props.length
            ? g.props.map((pr) => `  /** 设计文案默认值：${pr.sample} */\n  ${pr.name}?: string;`).join('\n')
            : '  // 该组件无文案入参';
        const defaults = g.props.map((pr) => `  ${pr.name} = ${JSON.stringify(pr.sample)},`).join('\n');
        const tsx = `import type { FC } from 'react';
import styles from './${g.suggestedName}.module.css';

/**
 * 由设计稿重复结构抽取的**可复用组件**（设计图层「${g.name}」，共出现 ${g.count} 次，子树 ${g.nodeCount} 节点）。
 * 这段几何来自设计数据；落实现时请把内部控件换成项目既有组件（见 component-plan.md 的复用清单），
 * 并保持 props 边界（数据/文案从 props 进，事件用回调出）。
 */
export interface ${g.suggestedName}Props {
${propsDecl}
}

export const ${g.suggestedName}: FC<${g.suggestedName}Props> = ({
${defaults}
}) => (
  <div className={styles.root}>
${lines.join('\n') || '      {/* 该结构无可渲染子节点 */}'}
  </div>
);

export default ${g.suggestedName};
`;
        const cssOut = `.root { position: relative; width: 100%; height: ${px(rep.h)}px; overflow: hidden; }
.instInput { width: 100%; height: 100%; box-sizing: border-box; border: 0; outline: 0; padding: 0 12px; background: transparent; font: inherit; color: inherit; }
${styles.join('\n')}
`;
        const dir = dirIndex ? join(compRoot, g.suggestedName) : compRoot;
        mkdirSync(dir, { recursive: true });
        const tsxPath = dirIndex ? join(dir, 'index.tsx') : join(dir, `${g.suggestedName}.tsx`);
        writeFileSync(tsxPath, tsx, 'utf8');
        writeFileSync(join(dir, `${g.suggestedName}.module.css`), cssOut, 'utf8');
        relComponents.push(tsxPath);
    }
    if (relComponents.length) {
        const barrel = join(compRoot, 'index.ts');
        if (existsSync(barrel)) {
            const cur = readFileSync(barrel, 'utf8');
            const add = picked
                .filter((g) => !cur.includes(`/${g.suggestedName}'`) && !cur.includes(`./${g.suggestedName}`))
                .map((g) => `export { ${g.suggestedName} } from './${g.suggestedName}';`)
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
    if (opts.auditMd) {
        P.push('', '## 设计审计核对清单（逐项勾选；"真歧义"才需要问人，"数据缺失"按兜底规则做）', '', '```markdown', opts.auditMd.trim(), '```', '');
    }
    P.push('', '## 逐节点规格表（id | name | type | x | y | w | h | 背景 | 描边(四边) | 虚线 | 圆角 | 字体 | 文案 | layout）', '', '```', specTable(model, 500), '```', '');
    if (instanceTodo.length) {
        P.push('', '## 实例与图标清单（恢复 derived 数据后仍要用项目组件/图标库替换）', '', ...instanceTodo.slice(0, 120));
    }
    P.push('', '## 必做', '1. **先看基准页**：`index.html`/`SPEC.md` 是视觉与规格基准，逐条对齐；', '2. **占位换组件**：把 `data-design-name` 标记的占位换成项目既有组件（Input/Select/DatePicker/Button…），', '   不要自己重画控件；设计给的尺寸/逐角圆角/文案要保留；', '3. **保持 auto-layout 结构**：骨架已按设计稿输出 `display:flex` 或 Grid 的 `display:grid`，含两轴 gap/padding/justify/align/grow；', '   不要改回绝对定位，也不要把 Grid 改成 flex；只有 `stackPositioning=ABSOLUTE` 的子项才是绝对定位；', '4. **色值走主题令牌**：`tokens.ts` 里是设计稿 literal 值，落项目时映射到项目主题变量；', '   映射不上的列出来找设计确认（不要静默换成别的颜色）；', '5. **逐边描边/逐角圆角/虚线**：`border-width` 分边写；dashPattern 用 `repeating-linear-gradient` 或 SVG stroke（CSS dashed 段长不可控）；', '6. **图标必须使用项目/图标库的 SVG**：带 `data-icon-library` 的节点按标识精确匹配；没有标识的先确认映射。', '   不许按 Figma 路径自绘，也不许凭图层名猜一个相似图标；', '7. 交互：受控表单、校验、按钮动作、关闭（Esc/遮罩）、可访问性；输出 `src/${name}.tsx`、`src/types.ts`、逻辑 hooks、必要测试；', '8. 类型安全、不引入第三方运行时依赖。', '', '## 已知占位（不是实现缺陷，不要"修"它）', '- 带 `data-src="placeholder"` / `data-guessed` 的元素是设计数据缺失处（实例内部、矢量图标、位图）；', '- 替换成项目组件即可；**不要为了"对齐截图"去编造颜色/图标/内部结构**。', '', '## 验证闭环（不做完不算完成）', '1. 按审计清单逐项勾选，**每项写清"在哪个文件哪一行实现的"**；', '2. 组件渲染截图 ↔ 基准图（static/index@2x.png）并排对照，差异逐条列出并修掉；', '3. 逐边描边、逐角圆角、控件高度这几类**必须用实测数值核对**（computed style），不要靠肉眼；', '   可先跑 `figma_visual_diff`（逐节点 expected/actual/Δ 的机器对照），再交人看；', '4. **必须过一轮 UI 专家审计**（涉及 UI 的交付一律如此）：', '   `summon_expert("UI 视觉验收设计师", 任务)` —— 任务里带设计基准图 static/index@2x.png、', '   设计规格 static/SPEC.md、以及你的组件截图（同尺寸/缩放），要求"逐条给出 问题/位置/期望/实际/级别"；', '   然后 `figma_review_to_round(output_dir, review=<专家原文>, reviewer="UI 视觉验收设计师")`；', '5. 专家会产出**标注图**（问题按 id 钉在基准图上）与**打回清单**；判定为 reject 时：', '   逐条修复 → `action="close"` 关闭 → **再提审一轮拿 pass**（开发自述"改完了"不算通过）；', '6. 把查到的项目既有模式沉淀成可复用事实。');
    writeFileSync(join(outDir, 'CODEGEN_PROMPT.md'), P.join('\n'), 'utf8');
    writeFileSync(join(outDir, 'README.md'), `# ${name}

由 dsh-design-to-code 从设计稿节点 \`${model.nodeId}\` 生成（零 REST API）。

- 视觉基准：\`SPEC.md\`（规格 + 台账 + 映射表）与静态还原页（由 \`figma_render_static\` 产出）
- 布局：按设计稿 auto-layout 生成 flex；\`abs.html\` 为绝对定位对照
- 设计令牌：\`src/tokens.ts\`（设计 literal 值，落项目要映射主题令牌）
- 几何骨架：\`src/${name}.tsx\` + \`src/${name}.module.css\`
- 补全指引：\`CODEGEN_PROMPT.md\`
`, 'utf8');
    return [
        ...relComponents,
        join(outDir, 'design-spec.json'),
        join(outDir, 'src', 'tokens.ts'),
        join(outDir, 'src', 'types.ts'),
        join(outDir, 'src', `${name}.tsx`),
        join(outDir, 'src', `${name}.module.css`),
        join(outDir, 'src', 'index.ts'),
        join(outDir, 'CODEGEN_PROMPT.md'),
        join(outDir, 'README.md'),
    ];
}
export function summarizeAudit(a) {
    return `节点 ${a.nodeCount}（实例 ${a.instanceCount}）· 核对项 ${a.checklist.length} · 真歧义 ${a.ambiguous.length} · 数据缺失 ${a.missing.length}`;
}
//# sourceMappingURL=codegen.js.map