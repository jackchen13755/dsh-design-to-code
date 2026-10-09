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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inferDesignSystem, specTable } from './render-static.js';
function safeName(name) {
    const cleaned = name.replace(/[^A-Za-z0-9_]/g, '').replace(/^(\d)/, '_$1');
    return cleaned || 'DesignComponent';
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
    const nodes = flat([model.tree]);
    const outDir = resolve(opts.outputDir);
    mkdirSync(join(outDir, 'src'), { recursive: true });
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
    nodes.forEach((n, i) => {
        const cls = `n${i}`;
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
    if (opts.auditMd) {
        P.push('', '## 设计审计核对清单（逐项勾选；"真歧义"才需要问人，"数据缺失"按兜底规则做）', '', '```markdown', opts.auditMd.trim(), '```', '');
    }
    P.push('', '## 逐节点规格表（id | name | type | x | y | w | h | 背景 | 描边(四边) | 圆角 | 字体 | 文案 | layout）', '', '```', specTable(model, 500), '```', '');
    if (instanceTodo.length) {
        P.push('', '## 需要你用项目组件替换的实例占位（设计数据里没有实例内部结构）', '', ...instanceTodo.slice(0, 120));
    }
    P.push('', '## 必做', '1. **先看基准页**：`index.html`/`SPEC.md` 是视觉与规格基准，逐条对齐；', '2. **占位换组件**：把 `data-design-name` 标记的占位换成项目既有组件（Input/Select/DatePicker/Button…），', '   不要自己重画控件；设计给的尺寸/逐角圆角/文案要保留；', '3. **绝对定位收敛成布局**：把"并列/堆叠"关系改成项目约定的 flex 布局（规格表里的 layout 列就是 auto-layout 依据），', '   只在确实需要的地方保留绝对定位；', '4. **色值走主题令牌**：`tokens.ts` 里是设计稿 literal 值，落项目时映射到项目主题变量；', '   映射不上的列出来找设计确认（不要静默换成别的颜色）；', '5. **逐边描边/逐角圆角**：`border-width` 分边写（如"只有左边框"），拼接控件组用相邻重叠 1px 共用一条边；', '6. 交互：受控表单、校验、按钮动作、关闭（Esc/遮罩）、可访问性；输出 `src/${name}.tsx`、`src/types.ts`、逻辑 hooks、必要测试；', '7. 类型安全、不引入第三方运行时依赖。', '', '## 验证闭环（不做完不算完成）', '1. 按审计清单逐项勾选，**每项写清"在哪个文件哪一行实现的"**；', '2. 组件渲染截图 ↔ 基准页截图并排对照，差异逐条列出并修掉；', '3. 逐边描边、逐角圆角、控件高度这几类**必须用实测数值核对**（computed style），不要靠肉眼；', '4. 把查到的项目既有模式（如"底部操作栏统一用 xxx"）沉淀成可复用事实。');
    writeFileSync(join(outDir, 'CODEGEN_PROMPT.md'), P.join('\n'), 'utf8');
    writeFileSync(join(outDir, 'README.md'), `# ${name}

由 dsh-design-to-code 从设计稿节点 \`${model.nodeId}\` 生成（零 REST API）。

- 视觉基准：\`SPEC.md\`（规格 + 映射表）与静态还原页（由 \`figma_render_static\` 产出，路径见 CODEGEN_PROMPT.md）
- 设计令牌：\`src/tokens.ts\`（设计 literal 值，落项目要映射主题令牌）
- 几何骨架：\`src/${name}.tsx\` + \`src/${name}.module.css\`
- 补全指引：\`CODEGEN_PROMPT.md\`
`, 'utf8');
    return [
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