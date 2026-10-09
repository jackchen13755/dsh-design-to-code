/**
 * 代码生成器：DesignModel + 选项 → React/TS/CSS Modules 骨架 + Codegen Prompt。
 *
 * 定位没变：生成"**设计准确的骨架 + 交互挂载点**"，业务交互由 CODEGEN_PROMPT.md 引导会话 LLM 补全。
 * 但这一版修掉了三个让骨架不可用的缺陷：
 * 1. **坐标**：上一版把根节点的画布坐标（6119/4653）也累加进子节点，而根容器只有 1440×2318
 *    且 overflow:hidden → 整个组件渲染成**空白**。现在用 DesignModel 里"根节点归零"的绝对坐标，
 *    并**扁平渲染**（不再嵌套，避免相对/绝对混用再次叠加偏移）。
 * 2. **文字样式**：上一版只写 color，tokens 里收的 12/13/14/16px 全丢，浏览器按默认 16px 渲染。
 *    现在字号/字重/字体族/行高/字距/对齐全部落到 span。
 * 3. **实例**：上一版把实例的**图层名**当正文渲染（实测 89 处会出现 Input、Select、*、Hand 字面量）。
 *    现在实例渲染成语义占位元素（input/select/button/radio…），文案取覆写链，
 *    并带 data-design-name 供会话 LLM 用项目组件替换。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inferDesignSystem, specTable } from './render-static.js';
import { detectRepeats } from './componentize.js';
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
/** 单节点 → CSS 声明（几何/逐边描边/逐角圆角/阴影/字体） */
function cssDecl(n) {
    const d = [
        'position: absolute',
        `left: ${n.x}px`,
        `top: ${n.y}px`,
        `width: ${n.w}px`,
        `height: ${n.h}px`,
        'box-sizing: border-box',
    ];
    if (n.background && n.kind !== 'text')
        d.push(`background: ${n.background}`);
    if (n.border) {
        d.push('border-style: solid', `border-color: ${n.border.color}`);
        d.push(`border-width: ${n.border.top}px ${n.border.right}px ${n.border.bottom}px ${n.border.left}px`);
    }
    if (n.radius)
        d.push(`border-radius: ${n.radius}`);
    if (n.shadow)
        d.push(`box-shadow: ${n.shadow}`);
    if (n.opacity != null)
        d.push(`opacity: ${n.opacity}`);
    if (n.kind === 'text' && n.text) {
        d.push(`font-family: '${n.text.family}', system-ui, sans-serif`);
        d.push(`font-size: ${n.text.size}px`, `font-weight: ${n.text.weight}`);
        if (n.text.lineHeight)
            d.push(`line-height: ${n.text.lineHeight}`);
        if (n.text.letterSpacing)
            d.push(`letter-spacing: ${n.text.letterSpacing}`);
        if (n.text.align)
            d.push(`text-align: ${n.text.align}`);
        if (n.text.color)
            d.push(`color: ${n.text.color}`);
        d.push('white-space: pre', 'overflow: visible');
    }
    return d.join(';\n  ');
}
export function generateCode(model, opts) {
    const name = safeName(opts.componentName);
    const ds = inferDesignSystem(model);
    const allNodes = flat([model.tree]);
    const outDir = resolve(opts.outputDir);
    mkdirSync(join(outDir, 'src'), { recursive: true });
    // ── 组件化：把"重复出现的结构"抽成可复用组件，页面只负责组合 ──
    // 选中的重复组（按复用价值排序，最多 maxExtract 个，且互不嵌套）
    const maxExtract = Math.max(0, Number(opts.maxExtract ?? 3));
    const candidates = detectRepeats(model).filter((r) => r.count >= 3 && r.reusable !== false);
    const picked = [];
    const pickedSigs = new Set();
    for (const c of candidates) {
        if (picked.length >= maxExtract)
            break;
        // 同签名的候选只能选一个：否则 groupBySignature 会被后者覆盖，
        // 出现"import 的是 V2、用的却是原名"这种对不上的情况（实测踩过）
        if (pickedSigs.has(c.signature))
            continue;
        pickedSigs.add(c.signature);
        picked.push(c);
    }
    // 组件名唯一化必须在**生成骨架之前**做完（否则 import 里还是旧名字）
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
    const groupByRoot = new Map();
    for (const g of picked)
        groupByRoot.set(g.representativeId, g);
    // 注意：不同实例的 id 不同，需要把"同签名的所有实例"都映射到同一个组件
    const groupBySignature = new Map();
    for (const g of picked)
        groupBySignature.set(g.signature, g);
    const signatureCache = new Map();
    const sigOf = (n) => {
        const hit = signatureCache.get(n.id);
        if (hit)
            return hit;
        // 必须与 componentize.signatureOf 完全一致：depth 0 比尺寸，往下只比类型+图层名
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
    /** 这个节点是否属于某个"被抽出去的组件"（同签名的所有实例都算） */
    const groupFor = (n) => groupBySignature.get(sigOf(n));
    // ── tokens.ts ──
    const colors = Object.entries(model.tokens.colors).map(([k, v]) => `  '${k}': '${v}',`).join('\n');
    const fonts = Object.entries(model.tokens.fonts)
        .map(([k, v]) => `  '${k}': { family: '${v.family}', weight: '${v.weight}', size: ${v.size}${v.lineHeight ? `, lineHeight: '${v.lineHeight}'` : ''}${v.letterSpacing ? `, letterSpacing: '${v.letterSpacing}'` : ''} },`)
        .join('\n');
    writeFileSync(join(outDir, 'src', 'tokens.ts'), `// 由设计稿自动生成的设计令牌（dsh-design-to-code）\n// 注意：这里的色值是**设计稿 literal 值**，落项目时要映射到项目主题令牌（见 SPEC.md 第 2 节）。\n\nexport const designTokens = {\n  colors: {\n${colors}\n  },\n  fonts: {\n${fonts}\n  },\n  spacing: [${model.tokens.spacing.join(', ')}],\n  shadows: [${model.tokens.shadows.map((s) => `'${s}'`).join(', ')}],\n  /** 从设计数据投票得出的设计系统常量（用于重建实例占位） */\n  inferred: {\n    line: '${ds.line}',\n    text: '${ds.text}',\n    placeholder: '${ds.placeholder}',\n    primary: '${ds.primary}',\n    radius: ${ds.radius},\n    controlHeight: ${ds.controlH},\n  },\n};\n`, 'utf8');
    // ── types.ts ──
    writeFileSync(join(outDir, 'src', 'types.ts'), `// 组件契约（骨架版）：业务语义由需求 → CODEGEN_PROMPT.md 补全\n\nexport interface ${name}Props {\n  /** 初始表单值，key 用 data-design-name（设计稿控件名） */\n  initialData?: Record<string, string>;\n  onAction?: (action: string, data: Record<string, string>) => void;\n  onClose?: () => void;\n}\n`, 'utf8');
    // ── 组件 + CSS ──
    const cssRules = ['.root {\n  position: relative;\n  overflow: hidden;\n}'];
    const jsx = [];
    const instanceTodo = [];
    // 顶层节点顺序（到"选中的重复组"就停，交给组件渲染）
    const nodes = [];
    const walkTop = (list) => {
        for (const n of list) {
            if (n.raw.visible === false)
                continue;
            if (n.kind === 'root') {
                walkTop(n.children);
                continue;
            } // 根节点"穿过"，不能跳过子树
            nodes.push(n);
            if (groupFor(n))
                continue; // 这一组交给组件，内部不再展开
            walkTop(n.children);
        }
    };
    walkTop([model.tree]);
    nodes.forEach((n, i) => {
        const cls = `n${i}`;
        const asGroup = groupFor(n);
        if (asGroup) {
            // 这个节点是"被抽出去的组件"的一个实例：
            // 位置仍用设计坐标（外层套定位 div），内部结构由组件负责 → 页面不再复制粘贴。
            cssRules.push(`.${cls} {\n  position: absolute;\n  left: ${n.x}px;\n  top: ${n.y}px;\n  width: ${n.w}px;\n  height: ${n.h}px;\n}`);
            const vals = textValuesOf(n);
            const propsJsx = asGroup.props
                .map((pr, idx) => `${pr.name}="${escAttr(vals[idx] ?? pr.sample)}"`)
                .join(' ');
            jsx.push(`      <div className={styles.${cls}}><${asGroup.suggestedName}${propsJsx ? ` ${propsJsx}` : ''} /></div>`);
            return;
        }
        cssRules.push(`.${cls} {\n  ${cssDecl(n)}\n}`);
        if (n.type === 'INSTANCE') {
            const tag = instanceTag(n);
            if (tag === 'skip')
                return;
            const designName = escAttr(`${n.name} ${n.w}x${n.h}`);
            instanceTodo.push(`- ${n.id} \`${n.name}\` ${n.w}×${n.h} @(${n.x},${n.y})${n.value ? ` 文案「${n.value}」` : ''}`);
            switch (tag) {
                case 'input':
                case 'select':
                case 'date':
                    jsx.push(`      <div className={styles.${cls}} data-design-name="${designName}"><input className={styles.instInput} defaultValue="${escAttr(n.value ?? '')}" aria-label="${escAttr(n.name)}" /></div>`);
                    return;
                case 'button':
                    cssRules.push(`.${cls} {\n  display: flex;\n  align-items: center;\n  justify-content: center;\n}`);
                    jsx.push(`      <button type="button" className={styles.${cls}} data-design-name="${designName}" onClick={() => onAction?.('${escAttr(n.value ?? n.name)}', data)}>${escText(n.value ?? n.name)}</button>`);
                    return;
                case 'radio':
                    jsx.push(`      <input type="radio" className={styles.${cls}} data-design-name="${designName}" name="design-radio-${i}" />`);
                    return;
                case 'required':
                    cssRules.push(`.${cls} {\n  color: #e64545;\n}`);
                    jsx.push(`      <span className={styles.${cls}} aria-hidden="true">*</span>`);
                    return;
                case 'tag':
                case 'upload':
                    jsx.push(`      <span className={styles.${cls}} data-design-name="${designName}">${escText(n.value ?? n.name)}</span>`);
                    return;
                default:
                    jsx.push(`      <div className={styles.${cls}} data-design-name="${designName}" />`);
                    return;
            }
        }
        if (n.kind === 'text') {
            jsx.push(`      <span className={styles.${cls}}>${escText(n.value ?? '')}</span>`);
            return;
        }
        if (n.kind === 'icon') {
            jsx.push(`      {/* 图标占位：设计数据里没有矢量路径，请用项目图标组件替换 */}\n      <div className={styles.${cls}} aria-hidden="true" />`);
            return;
        }
        jsx.push(`      <div className={styles.${cls}} />`);
    });
    cssRules.push(`.instInput {\n  width: 100%;\n  height: 100%;\n  box-sizing: border-box;\n  border: 0;\n  outline: 0;\n  padding: 0 12px;\n  background: transparent;\n  font: inherit;\n  color: inherit;\n}`);
    writeFileSync(join(outDir, 'src', `${name}.tsx`), `import { useState } from 'react';
import type { ${name}Props } from './types.js';
import styles from './${name}.module.css';
${picked.map((g) => `import { ${g.suggestedName} } from './components/${g.suggestedName}';`).join('\n')}

/**
 * 由设计稿 ${model.nodeId} 生成的**几何骨架**（扁平绝对定位，坐标已归零）。
 * 注意：这是"设计准确"的起点，不是最终实现 —— 请按 CODEGEN_PROMPT.md
 * 把实例占位换成项目既有组件、把绝对定位收敛成 flex、并做截图回归。
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
    // 【安全约束】生成物**只写输出目录**，绝不写进目标项目：
    // 插件不知道项目里哪些文件已存在，直接写进去会污染/覆盖用户仓库（实测踩过一次）。
    // 项目的真实落点写在 component-plan.md 第 4 节，由会话在实现阶段按项目实际创建。
    const compRoot = join(outDir, 'src', 'components');
    const dirIndex = opts.projectLayout?.layout !== 'flat';
    for (const g of picked) {
        const rep = allNodes.find((n) => n.id === g.representativeId);
        if (!rep)
            continue;
        const styles = [];
        let uid = 0;
        const cls = (decl) => { const id = `c${uid++}`; styles.push(`.${id} { ${decl} }`); return id; };
        const lines = [];
        let propIdx = 0;
        const inner = flat([rep]).filter((x) => x.id !== rep.id);
        for (const x of inner) {
            const rel = `position: absolute; left: ${x.x - rep.x}px; top: ${x.y - rep.y}px; width: ${x.w}px; height: ${x.h}px; box-sizing: border-box;`;
            const isProp = (x.kind === 'text' && !!x.value) || (x.type === 'INSTANCE' && !!x.value);
            const propName = isProp && propIdx < g.props.length ? g.props[propIdx].name : undefined;
            if (isProp)
                propIdx++;
            if (x.kind === 'text') {
                const t = x.text;
                const st = `${rel} font-family: '${t.family}', system-ui, sans-serif; font-size: ${t.size}px; font-weight: ${t.weight};${t.lineHeight ? ` line-height: ${t.lineHeight};` : ''}${t.color ? ` color: ${t.color};` : ''} white-space: pre; overflow: visible;`;
                const c = cls(st);
                lines.push(`      <span className={styles.${c}}>${propName ? `{${propName}}` : escText(x.value ?? '')}</span>`);
                continue;
            }
            if (x.type === 'INSTANCE') {
                const c = cls(`${rel} border: 1px solid ${ds.line}; border-radius: ${x.radius ?? `${ds.radius}px`}; background: #fff;`);
                const val = propName ? `{${propName}}` : `"${escAttr(x.value ?? '')}"`;
                lines.push(`      <div className={styles.${c}}><input className={styles.instInput} defaultValue=${val} aria-label="${escAttr(x.name)}" /></div>`);
                continue;
            }
            const c = cls(rel + (x.background ? ` background: ${x.background};` : '') + (x.radius ? ` border-radius: ${x.radius};` : ''));
            lines.push(`      <div className={styles.${c}} />`);
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
        // 宽度交给父级（可复用性）：设计里同一结构在不同宽度的列里出现，写死宽度就没法复用
        const css = `.root { position: relative; width: 100%; height: ${rep.h}px; overflow: hidden; }
.instInput { width: 100%; height: 100%; box-sizing: border-box; border: 0; outline: 0; padding: 0 12px; background: transparent; font: inherit; color: inherit; }
${styles.join('\n')}
`;
        const dir = dirIndex ? join(compRoot, g.suggestedName) : compRoot;
        mkdirSync(dir, { recursive: true });
        const tsxPath = dirIndex ? join(dir, 'index.tsx') : join(dir, `${g.suggestedName}.tsx`);
        writeFileSync(tsxPath, tsx, 'utf8');
        writeFileSync(join(dir, `${g.suggestedName}.module.css`), css, 'utf8');
        relComponents.push(tsxPath);
    }
    // barrel：只在**输出目录**里生成汇总（项目里的 barrel 由会话在实现阶段按项目约定挂）
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
    P.push(`设计稿已提取为 \`design-spec.json\`（含逐节点规格表），几何骨架见 \`src/${name}.tsx\`。`);
    if (opts.staticPagePath) {
        P.push('', `**视觉基准**：\`${opts.staticPagePath}\`（由设计数据逐节点生成的 1:1 静态还原页）。`);
        P.push('实现完成后必须把"组件渲染截图"与这张基准页并排对照；对不上就改，不要以"看起来差不多"收尾。');
    }
    P.push('', '## 需求', opts.requirements);
    P.push('', '## 项目约定', opts.conventions);
    if (opts.componentPlanMd) {
        P.push('', '## 组件化方案（复用优先 / 无则组件化 / 落点按项目实际）', '', opts.componentPlanMd.trim(), '');
    }
    if (opts.auditMd) {
        P.push('', '## 设计审计核对清单（逐项勾选；"真歧义"才需要问人，"数据缺失"按兜底规则做）', '', '```markdown', opts.auditMd.trim(), '```', '');
    }
    P.push('', '## 逐节点规格表（id | name | type | x | y | w | h | 背景 | 描边(四边) | 圆角 | 字体 | 文案 | layout）', '', '```', specTable(model, 500), '```', '');
    if (instanceTodo.length) {
        P.push('', '## 需要你用项目组件替换的实例占位（设计数据里没有实例内部结构）', '', ...instanceTodo.slice(0, 120));
    }
    P.push('', '## 必做', '1. **先看基准页**：`index.html`/`SPEC.md` 是视觉与规格基准，逐条对齐；', '2. **占位换组件**：把 `data-design-name` 标记的占位换成项目既有组件（Input/Select/DatePicker/Button…），', '   不要自己重画控件；设计给的尺寸/逐角圆角/文案要保留；', '3. **绝对定位收敛成布局**：把"并列/堆叠"关系改成项目约定的 flex 布局（规格表里的 layout 列就是 auto-layout 依据），', '   只在确实需要的地方保留绝对定位；', '4. **色值走主题令牌**：`tokens.ts` 里是设计稿 literal 值，落项目时映射到项目主题变量；', '   映射不上的列出来找设计确认（不要静默换成别的颜色）；', '5. **逐边描边/逐角圆角**：`border-width` 分边写（如"只有左边框"），拼接控件组用相邻重叠 1px 共用一条边；', '6. 交互：受控表单、校验、按钮动作、关闭（Esc/遮罩）、可访问性；输出 `src/${name}.tsx`、`src/types.ts`、逻辑 hooks、必要测试；', '7. 类型安全、不引入第三方运行时依赖。', '', '## 验证闭环（不做完不算完成）', '1. 按审计清单逐项勾选，**每项写清"在哪个文件哪一行实现的"**；', '2. 组件渲染截图 ↔ 基准图（static/index@2x.png）并排对照，差异逐条列出并修掉；', '3. 逐边描边、逐角圆角、控件高度这几类**必须用实测数值核对**（computed style），不要靠肉眼；', '4. **必须过一轮 UI 专家审计**（涉及 UI 的交付一律如此）：', '   `summon_expert("UI 视觉验收设计师", 任务)` —— 任务里带设计基准图 static/index@2x.png、', '   设计规格 static/SPEC.md、以及你的组件截图（同尺寸/缩放），要求"逐条给出 问题/位置/期望/实际/级别"；', '   然后 `figma_review_to_round(output_dir, review=<专家原文>, reviewer="UI 视觉验收设计师")`；', '5. 专家会产出**标注图**（问题按 id 钉在基准图上）与**打回清单**；判定为 reject 时：', '   逐条修复 → `action="close"` 关闭 → **再提审一轮拿 pass**（开发自述"改完了"不算通过）；', '   代码位置可用行内标注（diff_approval_annotate）钉到对应行上，直接在代码里对话；', '6. 把查到的项目既有模式沉淀成可复用事实。');
    writeFileSync(join(outDir, 'CODEGEN_PROMPT.md'), P.join('\n'), 'utf8');
    writeFileSync(join(outDir, 'README.md'), `# ${name}

由 dsh-design-to-code 从设计稿节点 \`${model.nodeId}\` 生成（零 REST API）。

- 视觉基准：\`SPEC.md\`（规格 + 映射表）与静态还原页（由 \`figma_render_static\` 产出，路径见 CODEGEN_PROMPT.md）
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