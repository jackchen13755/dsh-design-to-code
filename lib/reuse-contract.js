/**
 * 组件复用契约（Component Reuse Contract）
 *
 * 需求：UI 设计是静态的，但项目已有完整组件库。实现时应优先复用项目既有组件，
 * 只实现内容/差异部分。本模块把"识别 → 生成 → 验证"闭环中与识别/建模有关的
 * 部分固化成**纯函数 + 冻结契约**，供工具层（index.ts）消费。
 *
 * 设计原则（software-architect）：
 *  - 接口即契约：T1–T6 类型逐字冻结，跨席位共享；不擅自改字段。
 *  - 事实优先 / 保守兜底：只有 explicit 与 code-dir（真读到组件）标 confirmed；
 *    symbol-instance / name-semantics / structure 一律 suspected；无 catalog 时 confirmed=0。
 *  - 泛化：不硬编码任何具体业务组件名；词表是通用 UI 角色词（英文 + 中文）。
 *  - 纯函数：planComponentReuse 只读入参、无 I/O、确定性输出。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const WORDS = {
    mask: { en: ['bg', 'background', 'mask', 'overlay', 'scrim', 'backdrop'], zh: ['遮罩', '蒙层', '背景'] },
    titlebar: { en: ['titlebar', 'title-bar', 'topbar', 'top-bar'], zh: ['标题栏', '顶栏'] },
    close: { en: ['close', 'dismiss'], zh: ['关闭', '收起'] },
    shell: { en: ['panel', 'sheet', 'container', 'modal', 'dialog', 'card', 'popover', 'side-panel'], zh: ['面板', '弹窗', '弹层', '模态', '卡片', '浮层', '容器'] },
    header: { en: ['header', 'head'], zh: ['头部', '标题'] },
    body: { en: ['body', 'main'], zh: ['主体', '正文', '内容区'] },
    footer: { en: ['footer'], zh: ['底部', '页脚'] },
    content: { en: ['content', 'section'], zh: ['内容', '详情', '列表'] },
};
const CONTROLS = {
    input: { en: ['input', 'textbox', 'text-field'], zh: ['输入框', '文本框', '输入'] },
    select: { en: ['select', 'dropdown', 'combobox'], zh: ['下拉', '选择器'] },
    tag: { en: ['tag', 'chip'], zh: ['标签'] },
    button: { en: ['button', 'btn'], zh: ['按钮'] },
    checkbox: { en: ['checkbox', 'check-box'], zh: ['复选框', '多选框'] },
    radio: { en: ['radio'], zh: ['单选框', '单选'] },
    datepicker: { en: ['datepicker', 'date-picker', 'calendar'], zh: ['日期选择', '日期控件', '日历'] },
    upload: { en: ['upload'], zh: ['上传'] },
};
/** 词命中：英文按「非字母边界」匹配，中文按子串匹配（中文无 \b 边界）。 */
function hasWord(name, set) {
    const en = new RegExp(`(?:^|[^A-Za-z])(?:${set.en.join('|')})(?:$|[^A-Za-z])`, 'i');
    return en.test(name) || set.zh.some((w) => name.includes(w));
}
function flatten(node, out = []) {
    if (node.raw?.visible === false)
        return out;
    out.push(node);
    for (const c of node.children ?? [])
        flatten(c, out);
    return out;
}
function descendantCount(node) {
    let n = 0;
    const walk = (x) => { for (const c of x.children ?? []) {
        n++;
        walk(c);
    } };
    walk(node);
    return n;
}
function symbolIdOf(node) {
    const sid = node.raw?.symbolData?.symbolID;
    if (!sid)
        return undefined;
    if (typeof sid === 'string')
        return sid;
    return [sid.sessionID, sid.localID].filter((v) => v != null).join(':') || undefined;
}
/** 结构 + 通用角色词 → 单一类别（不写死任何具体组件名） */
function categoryOf(node, root, rootChildIds) {
    const name = String(node.name ?? '');
    const wFull = root.w > 0 && node.w >= root.w * 0.92 && node.h >= root.h * 0.92;
    // 满画布且几乎无子结构 → 遮罩（结构信号，优先于名字，因其名字可能是 "BG"）
    if (node.id !== root.id && wFull && descendantCount(node) <= 1) {
        return { category: 'mask', signal: 'structure', detail: `full-canvas ${node.w}x${node.h} vs root ${root.w}x${root.h}, leaf → scrim` };
    }
    if (hasWord(name, WORDS.mask))
        return { category: 'mask', signal: 'name-semantics', detail: `name matches mask word` };
    if (hasWord(name, WORDS.titlebar))
        return { category: 'titlebar', signal: 'name-semantics', detail: `name matches titlebar word` };
    if (hasWord(name, WORDS.close))
        return { category: 'close', signal: 'name-semantics', detail: `name matches close word` };
    for (const [kind, set] of Object.entries(CONTROLS)) {
        if (hasWord(name, set))
            return { category: `control:${kind}`, signal: 'name-semantics', detail: `name matches control word '${kind}'` };
    }
    if (hasWord(name, WORDS.shell))
        return { category: 'shell', signal: 'name-semantics', detail: `name matches shell word` };
    if (hasWord(name, WORDS.header))
        return { category: 'header', signal: 'name-semantics', detail: `name matches header word` };
    if (hasWord(name, WORDS.body))
        return { category: 'body', signal: 'name-semantics', detail: `name matches body word` };
    if (hasWord(name, WORDS.footer))
        return { category: 'footer', signal: 'name-semantics', detail: `name matches footer word` };
    if (hasWord(name, WORDS.content))
        return { category: 'content', signal: 'name-semantics', detail: `name matches content word` };
    // 窄面板 → 壳（结构信号；不依赖具体图层名，故对任意业务都成立）
    if (rootChildIds.has(node.id) && root.w > 0 && node.w < root.w * 0.85 && node.h >= root.h * 0.5 && (node.children?.length ?? 0) > 0) {
        return { category: 'shell', signal: 'structure', detail: `narrow panel child ${node.w}/${root.w}<0.85, tall ${node.h}>=${Math.round(root.h * 0.5)} → shell` };
    }
    return { category: 'unknown', signal: 'none', detail: 'no role signal' };
}
function roleLevelOf(category) {
    if (category === 'shell')
        return { role: 'shell', level: 'shell' };
    if (category.startsWith('control:'))
        return { role: 'control', level: 'control' };
    if (category === 'unknown')
        return { role: 'unknown', level: 'business' };
    return { role: 'content', level: 'business' };
}
/** 目录项按名字匹配设计节点（保守：精确或明确包含，长度>=2） */
function catalogFor(name, catalog) {
    const n = String(name ?? '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    if (!n)
        return undefined;
    return catalog.find((c) => {
        const cn = c.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
        return cn === n || (cn.length >= 2 && n.includes(cn)) || (n.length >= 2 && cn.includes(n));
    });
}
function genericComponent(category, name) {
    if (category === 'shell')
        return 'ProjectShell';
    if (category.startsWith('control:')) {
        const kind = category.slice('control:'.length);
        return `Project${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
    }
    return name.trim() || 'ProjectBlock';
}
function pageReference(node, catalog) {
    // catalog 中 sourceFile 落在 pages/views/screens 的条目 = "项目已有相似页面/实现"候选。
    // 仅当文件名语义与设计节点名有交集才填入；否则留空（无法可靠判定）。
    const name = String(node.name ?? '').toLowerCase();
    const tokens = name.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length >= 2);
    const refs = catalog
        .filter((c) => /(?:^|\/)(?:pages|views|screens)(?:\/|$)/i.test(c.sourceFile))
        .filter((c) => {
        const cn = c.name.toLowerCase();
        return tokens.some((t) => cn.includes(t) || name.includes(cn)) || cn.includes(name);
    })
        .map((c) => c.sourceFile);
    return refs.length ? [...new Set(refs)] : undefined;
}
/** 由目录项的 props/slots 推导 slot 元信息（确定性、保守） */
function slotMetaFromCatalog(c) {
    const contentSlot = c.slots.find((s) => /children|default|content/i.test(s)) ?? (c.slots[0] || undefined);
    const headerSlot = c.slots.find((s) => /header|title|extra/i.test(s));
    return {
        ...(contentSlot ? { contentSlot } : {}),
        ...(headerSlot ? { headerSlot } : {}),
        valueProps: c.props.filter((p) => /value|data|items|selected|checked/i.test(p)),
        eventProps: c.props.filter((p) => /^on|change|click|submit|select/i.test(p)),
    };
}
function resolve(node, category, catMatch, detectedSignal, detail) {
    if (catMatch) {
        return {
            source: 'code-dir', status: 'confirmed', confidence: 0.95,
            evidence: `catalog '${catMatch.name}' from ${catMatch.sourceFile} matched design node '${node.name}' (${detail})`,
            projectComponent: catMatch.name, importPath: catMatch.importPath, catalog: catMatch,
        };
    }
    const sym = symbolIdOf(node);
    if (sym) {
        return {
            source: 'symbol-instance', status: 'suspected', confidence: 0.6,
            evidence: `INSTANCE symbolData.symbolID=${sym}; no project component verified without code_dir`,
            projectComponent: genericComponent(category, node.name),
        };
    }
    if (detectedSignal === 'name-semantics') {
        return {
            source: 'name-semantics', status: 'suspected', confidence: 0.5,
            evidence: `generic role word on name '${node.name}' (${detail}); no catalog to confirm`,
            projectComponent: genericComponent(category, node.name),
        };
    }
    return {
        source: 'structure', status: 'suspected', confidence: 0.35,
        evidence: `geometry signal (${detail}); no catalog to confirm`,
        projectComponent: genericComponent(category, node.name),
    };
}
function isOmit(category) {
    return category === 'mask' || category === 'close' || category === 'titlebar';
}
function isContent(category) {
    return category === 'header' || category === 'body' || category === 'footer' || category === 'content';
}
/* ── T8：纯函数 —— 识别设计树里可复用的组件并产出契约 ────────── */
export function planComponentReuse(root, opts) {
    const policy = opts.policy;
    if (policy === 'off')
        return [];
    // 形状守卫：容忍误传整个 DesignModel（含 .tree），零成本兜底；raw WS json（node/descendants）不猜。
    const maybeTree = root.tree;
    if (maybeTree && Array.isArray(maybeTree.children))
        root = maybeTree;
    const catalog = opts.catalog ?? [];
    const explicit = opts.contracts ?? [];
    // 显式契约：最高优先级，恒 confirmed；深拷贝避免污染入参。
    const out = explicit.map((c, i) => ({
        ...c,
        id: c.id || `reuse-explicit-${i}`,
        // match 可能缺失（输入解析器接受只含 projectComponent 的契约）——防御式兜底，避免 c.match.source 抛 TypeError。
        // 逐字段取值（不 spread，避免 TS2783 重复键告警）；显式契约强制 source=explicit / status=confirmed。
        match: {
            source: 'explicit',
            confidence: c.match?.confidence ?? 1,
            status: 'confirmed',
            evidence: c.match?.evidence ?? 'explicit contract',
        },
        slot: {
            ...c.slot,
            // 默认值放展开之后：c.slot 可能显式给出这些键，用 ?? 兜底而非先写默认值再被覆盖（避免 TS2783）。
            contentDesignNodeIds: c.slot?.contentDesignNodeIds ?? [],
            omitDesignNodeIds: c.slot?.omitDesignNodeIds ?? [],
        },
    }));
    if (policy === 'explicit')
        return out;
    const nodes = flatten(root);
    const rootChildIds = new Set((root.children ?? []).map((c) => c.id));
    const classified = nodes
        .filter((n) => n.id !== root.id)
        .map((n) => ({ node: n, info: categoryOf(n, root, rootChildIds), cat: catalogFor(n.name, catalog) }));
    const explicitIds = new Set(explicit.map((c) => c.designNodeId).filter(Boolean));
    for (const { node, info, cat } of classified) {
        if (explicitIds.has(node.id))
            continue;
        const { category, signal, detail } = info;
        const isSym = !!symbolIdOf(node);
        // 只有壳 / 控件 / 设计系统实例才产出独立契约；遮罩/关闭/内容节等只喂给壳的 slot。
        const emitsContract = category === 'shell' || category.startsWith('control:') || isSym;
        if (!emitsContract)
            continue;
        const { role, level } = roleLevelOf(category);
        const m = resolve(node, category, cat, signal, detail);
        const slot = {
            contentDesignNodeIds: [], omitDesignNodeIds: [],
        };
        if (m.catalog)
            Object.assign(slot, slotMetaFromCatalog(m.catalog));
        if (category === 'shell') {
            // 壳层：遮罩/关闭/标题栏入 omit，body/header 等内容节入 content。
            // 扫描整棵树做归类（壳的遮罩常是壳的兄弟节点，如满画布 BG）。
            for (const other of classified) {
                if (other.node.id === node.id)
                    continue;
                const oc = other.info.category;
                // 仅收集与该壳相关（在壳子树内，或满画布遮罩这类全局 chrome）的节点
                const inSubtree = descendantCount(node) > 0 && isDescendant(other.node, node);
                const globalChrome = oc === 'mask';
                if (!inSubtree && !globalChrome)
                    continue;
                if (isOmit(oc))
                    slot.omitDesignNodeIds.push(other.node.id);
                else if (isContent(oc))
                    slot.contentDesignNodeIds.push(other.node.id);
            }
            const nested = classified
                .filter((o) => o.node.id !== node.id && o.info.category === 'shell' && isDescendant(o.node, node))
                .map((o) => o.node.id);
            if (nested.length)
                slot.contentDesignNodeIds.push(...nested);
            // 去重
            slot.omitDesignNodeIds = [...new Set(slot.omitDesignNodeIds)];
            slot.contentDesignNodeIds = [...new Set(slot.contentDesignNodeIds)].filter((id) => !slot.omitDesignNodeIds.includes(id));
        }
        out.push({
            id: `reuse-${node.id}-${category}`,
            designNodeId: node.id,
            designName: node.name,
            level, role,
            projectComponent: m.projectComponent,
            ...(m.importPath ? { importPath: m.importPath } : {}),
            match: { source: m.source, confidence: m.confidence, status: m.status, evidence: m.evidence },
            slot,
            verify: {
                nodeId: node.id,
                note: role === 'shell'
                    ? `确认项目壳组件自带遮罩/关闭/标题栏（omit），并暴露内容插槽；content=${slot.contentDesignNodeIds.length} omit=${slot.omitDesignNodeIds.length}`
                    : role === 'control'
                        ? '确认项目存在同类控件，整节点由组件替换、不渲染设计子节点'
                        : '确认 design-system 实例对应的项目组件；suspected，需人工核对',
            },
            ...(() => { const rp = pageReference(node, catalog); return rp ? { referencePages: rp } : {}; })(),
        });
    }
    return out;
}
function isDescendant(node, ancestor) {
    let cur = node;
    const seen = new Set();
    while (cur) {
        if (seen.has(cur.id))
            return false;
        seen.add(cur.id);
        // 通过递归查找（DesignNode 无 parent 指针）
        if (cur.id === ancestor.id)
            return true;
        cur = findParent(ancestor, cur.id);
    }
    return false;
}
function findParent(node, childId) {
    for (const c of node.children ?? []) {
        if (c.id === childId)
            return node;
        const p = findParent(c, childId);
        if (p)
            return p;
    }
    return undefined;
}
/* ── 组件库索引持久化（⑤）—— 供工具层落盘/读取 gen/component-catalog.json ── */
export function writeComponentCatalog(catalog, path) {
    const dir = dirname(path);
    if (dir && dir !== '.')
        mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(catalog, null, 2), 'utf8');
}
export function readComponentCatalog(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((x) => !!x && typeof x === 'object' && typeof x.name === 'string' &&
            typeof x.importPath === 'string' && Array.isArray(x.props));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=reuse-contract.js.map