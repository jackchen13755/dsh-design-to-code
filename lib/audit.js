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
export function auditModel(model) {
    const nodes = flat(model);
    const checklist = new Set();
    const ambiguous = [];
    const missing = new Set();
    // ── 骨架 ──
    checklist.add(`【骨架】画布 ${model.width}×${model.height}（节点 ${nodes.length}）`);
    for (const n of nodes) {
        if (n.kind === 'frame' || n.kind === 'root') {
            if (n.w && n.h)
                checklist.add(`【骨架】容器 "${n.name}" ${n.w}×${n.h} @(${n.x},${n.y})`);
        }
    }
    // ── 逐边描边：按 (颜色, 四边, 圆角) 去重 ──
    const borderSet = new Map();
    for (const n of nodes) {
        if (!n.border)
            continue;
        const b = n.border;
        const edges = `${b.top}/${b.right}/${b.bottom}/${b.left}`;
        const key = `${b.color} ${edges} r=${n.radius ?? '0'}`;
        if (!borderSet.has(key))
            borderSet.set(key, []);
        const list = borderSet.get(key);
        if (list.length < 4)
            list.push(`${n.id} "${n.name}"`);
    }
    for (const [key, who] of borderSet) {
        const only = key.split(' ')[1];
        const note = only === '0/0/0/1' || only === '0/0/0/2'
            ? ' ← 只有左边框'
            : only.startsWith('0/0/1') ? ' ← 只有下边框' : '';
        checklist.add(`【描边】${key}${note} · 例：${who.join('、')}`);
    }
    // ── 逐角圆角 ──
    const radiusSet = new Map();
    for (const n of nodes) {
        if (!n.radius)
            continue;
        radiusSet.set(n.radius, (radiusSet.get(n.radius) ?? 0) + 1);
    }
    for (const [r, c] of [...radiusSet.entries()].sort((a, b) => b[1] - a[1])) {
        const perCorner = r.includes(' ');
        checklist.add(`【圆角】${r}${perCorner ? '（逐角不同：拼接控件组两端圆角/中间直角）' : ''} × ${c} 处`);
    }
    // ── 字体 ──
    const fontSet = new Map();
    for (const n of nodes) {
        if (!n.text)
            continue;
        const key = `${n.text.family} ${n.text.weight} ${n.text.size}px${n.text.lineHeight ? `/${n.text.lineHeight}` : ''} ${n.text.color ?? ''}`;
        fontSet.set(key, (fontSet.get(key) ?? 0) + 1);
    }
    for (const [f, c] of [...fontSet.entries()].sort((a, b) => b[1] - a[1])) {
        checklist.add(`【字体】${f} × ${c} 处`);
    }
    // ── auto-layout（落组件时要变成 flex，别绝对定位） ──
    for (const n of nodes) {
        if (!n.layout?.mode)
            continue;
        checklist.add(`【布局】"${n.name}" ${n.layout.mode} spacing=${n.layout.spacing ?? '-'} padding=${n.layout.paddingTop ?? '-'}/${n.layout.paddingRight ?? '-'}/${n.layout.paddingBottom ?? '-'}/${n.layout.paddingLeft ?? '-'}${n.layout.counterAlign ? ` align=${n.layout.counterAlign}` : ''}`);
    }
    // ── 阴影 ──
    for (const s of model.tokens.shadows)
        checklist.add(`【阴影】${s}`);
    // ── 真歧义（设计没说清） ──
    for (const n of nodes) {
        const raw = n.raw;
        const hiddenFills = (raw.fillPaints ?? []).filter((p) => p && p.visible === false);
        if (hiddenFills.length)
            ambiguous.push(`[${n.id}] ${n.name}：有 fill 但 visible=false（到底要不要底色？）`);
        const hasStrokeGeometry = Array.isArray(raw.strokeGeometry) && raw.strokeGeometry.length > 0;
        if (hasStrokeGeometry && !n.border) {
            ambiguous.push(`[${n.id}] ${n.name}：有描边几何但读不到 strokePaints/描边权重（颜色待确认）`);
        }
        if (Array.isArray(raw.dashPattern) && raw.dashPattern.length && !n.border) {
            ambiguous.push(`[${n.id}] ${n.name}：dashPattern=${JSON.stringify(raw.dashPattern)} 但无描边信息（虚线颜色待确认）`);
        }
    }
    // ── 数据缺失（有兜底规则，不是"不要猜"） ──
    const opaqueInstances = nodes.filter((n) => n.instanceInternalMissing);
    if (opaqueInstances.length) {
        const byName = new Map();
        for (const n of opaqueInstances)
            byName.set(n.name, (byName.get(n.name) ?? 0) + 1);
        missing.add(`【实例内部数据缺失】${opaqueInstances.length} 个实例（${[...byName.entries()].map(([k, v]) => `${k}×${v}`).join('、')}）：`
            + 'ws.json 里实例无 children / 无 fillPaints / 无 strokePaints，内部结构拿不到。'
            + '兜底规则：用**项目既有组件**重建（尺寸/逐角圆角/覆写文案已给出），不要自己画一套控件。');
        const withText = opaqueInstances.filter((n) => n.value);
        if (withText.length) {
            missing.add(`【实例文案已从覆写链取到】${withText.length} 处，例：${withText.slice(0, 8).map((n) => `${n.name}="${n.value}"`).join('、')}`);
        }
    }
    return {
        fileKey: model.fileKey,
        nodeId: model.nodeId,
        componentName: model.componentName,
        width: model.width,
        height: model.height,
        nodeCount: nodes.length,
        instanceCount: nodes.filter((n) => n.type === 'INSTANCE').length,
        checklist: [...checklist],
        ambiguous,
        missing: [...missing],
        rows: model.spec,
    };
}
export function auditToMarkdown(a) {
    const L = [];
    L.push(`# 设计审计：${a.componentName}（${a.fileKey} · ${a.nodeId}）`);
    L.push('');
    L.push(`- 画布：${a.width}×${a.height} · 节点 ${a.nodeCount}（实例 ${a.instanceCount}）`);
    L.push(`- 核对项 ${a.checklist.length} · 真歧义 ${a.ambiguous.length} · 数据缺失 ${a.missing.length}`);
    L.push('');
    L.push('## 实现前核对清单');
    L.push('');
    for (const c of a.checklist)
        L.push(`- [ ] ${c}`);
    if (a.missing.length) {
        L.push('');
        L.push('## 数据缺失（按兜底规则做，不必问设计）');
        L.push('');
        for (const m of a.missing)
            L.push(`- ${m}`);
    }
    if (a.ambiguous.length) {
        L.push('');
        L.push('## ⚠️ 真歧义（需要问设计，不要猜）');
        L.push('');
        for (const m of a.ambiguous)
            L.push(`- [ ] ${m}`);
    }
    L.push('');
    L.push('## 全量节点清单');
    L.push('');
    L.push('| guid | name | type | x | y | w | h | 背景 | 边框四边 T/R/B/L | 圆角 | 字体 | 文案 | layout |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const e of a.rows) {
        L.push(`| ${e.id} | ${String(e.name).replace(/\|/g, '\\|')} | ${e.type} | ${e.x} | ${e.y} | ${e.w} | ${e.h} | ${e.background ?? ''} | ${e.borderEdges ? `${e.border}(${e.borderEdges})` : ''} | ${e.radius ?? ''} | ${e.font ?? ''} | ${String(e.text ?? '').replace(/\|/g, '\\|')} | ${e.layout ?? ''} |`);
    }
    L.push('');
    return L.join('\n');
}
//# sourceMappingURL=audit.js.map