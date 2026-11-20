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
export type Prov = 'design' | 'inferred' | 'placeholder';
export interface DesignTextStyle {
    family: string;
    size: number;
    weight: number;
    italic?: boolean;
    lineHeight?: string;
    letterSpacing?: string;
    /** 水平对齐（LEFT/CENTER/RIGHT/JUSTIFIED → css） */
    align?: string;
    /** 垂直对齐（TOP/CENTER/BOTTOM）——决定文字贴顶还是居中 */
    alignVertical?: string;
    /** NONE/WIDTH_AND_HEIGHT/HEIGHT/TRUNCATE：决定"该不该按设计框换行" */
    autoResize?: string;
    maxLines?: number;
    color?: string;
}
export interface DesignBorder {
    color: string;
    top: number;
    right: number;
    bottom: number;
    left: number;
    /** 虚线样式（Kiwi dashPattern，如 [2,2]）——不读它会把虚线画成实线 */
    dash?: number[];
    /** INSIDE | OUTSIDE | CENTER（默认 INSIDE） */
    align?: string;
}
/**
 * auto-layout 归一。
 * 前半段（mode/spacing/padding/primaryAlign/counterAlign/sizing/wrap）描述**自己这个容器**；
 * 后半段（childGrow/childAlignSelf/absolute）描述**自己在父容器里**的行为。
 */
export interface DesignLayout {
    mode?: string;
    spacing?: number;
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    /** 主轴对齐：MIN | CENTER | MAX | SPACE_BETWEEN */
    primaryAlign?: string;
    /** 交叉轴对齐：MIN | CENTER | MAX | BASELINE */
    counterAlign?: string;
    /** FIXED | RESIZE_TO_FIT | RESIZE_TO_FIT_WITH_IMPLICIT_SIZE */
    primarySizing?: string;
    counterSizing?: string;
    /** NO_WRAP | WRAP */
    wrap?: string;
    /** WRAP 时两条主轴之间的距离（Kiwi stackCounterSpacing） */
    counterSpacing?: number;
    /** Kiwi Grid：轨道顺序 + sizing。不要把 GRID 当 VERTICAL 渲染。 */
    grid?: {
        columnIds: string[];
        rowIds: string[];
        columnSizing: DesignGridTrack[];
        rowSizing: DesignGridTrack[];
        columnGap: number;
        rowGap: number;
    };
    /** 自己在父 auto-layout 里的拉伸权重（0/1） */
    childGrow?: number;
    /** 自己在父容器交叉轴上的对齐：AUTO | STRETCH | ... */
    childAlignSelf?: string;
    /** 自己是否被绝对定位在父 auto-layout 里（不能参与 flex 流） */
    absolute?: boolean;
    /** 边框是否占空间（影响 padding 计算） */
    bordersTakeSpace?: boolean;
}
export interface DesignGridTrack {
    type: string;
    value: number;
}
/** INSTANCE 的 derivedSymbolData 中保留下来的真实文本度量与字体。 */
export interface InstanceTextPart {
    path: string;
    value: string;
    x: number;
    y: number;
    w: number;
    h: number;
    size: number;
    family: string;
    weight: number;
    lineHeight?: string;
    /** 该局部坐标来自 derived 容器，而非 n.rx/ry */
    hasPosition: boolean;
    /** 有父 derived 几何的嵌套文本（如计數徽标）；容器尺寸可单独用于渲染 */
    containerWidth?: number;
    containerHeight?: number;
    /** 父 derived 图形自带描边几何（有边框证据，不是"看图像猜"） */
    containerStroke?: boolean;
    /** 该段 derived 字体缺失，沿用同实例上一段（数据缺口，需在台账标明） */
    fontInferred?: boolean;
}
/**
 * 一条判定信号：kind 稳定标识 + weight 权重（可正可负）+ value 可读值。
 * 备注与标题共用；detectedBy 是其人类可读投影。
 */
export interface AnnotationSignal {
    kind: string;
    weight: number;
    value?: string;
}
/**
 * 画布上的设计备注（不是产品 UI）：通常是红字说明，写明交互/状态约束。
 * 只做"识别 + 归属 + 原文透传"，不把备注当需求自由发挥；判定依据一并记录。
 */
export interface DesignAnnotation {
    id: string;
    /** 原文（保留换行） */
    text: string;
    /** 第一行：备注标题 */
    title: string;
    x: number;
    y: number;
    w: number;
    h: number;
    color?: string;
    /** 判定依据（人类可读的信号摘要） */
    detectedBy: string[];
    /** 备注适用的组件/节点 */
    targetId?: string;
    targetName?: string;
    /** 同一文档帧里的状态变体（备注通常描述整组行为） */
    variantIds: string[];
    variantNames: string[];
    /** 加权打分的全部信号（含未达阈值的弱信号） */
    signals: AnnotationSignal[];
    /** 置信度 0..1 = min(1, score/10) */
    confidence: number;
    /** auto=从树摘除；candidate=保留在树、audit 待确认 */
    disposition: 'auto' | 'candidate';
    /** 归属范围：整组变体 / 单组件 / 无目标 */
    scope: 'group' | 'single' | 'unassigned';
}
export interface DesignTokens {
    colors: Record<string, string>;
    fonts: Record<string, {
        family: string;
        weight: string;
        size: number;
        lineHeight?: string;
        letterSpacing?: string;
    }>;
    spacing: number[];
    shadows: string[];
}
export type NodeKind = 'root' | 'frame' | 'text' | 'input' | 'button' | 'icon' | 'instance' | 'ellipse' | 'other';
export interface DesignNode {
    id: string;
    type: string;
    name: string;
    kind: NodeKind;
    /** 相对**父节点**的坐标（嵌套渲染 / flex 流里的绝对子项用） */
    rx: number;
    ry: number;
    /** 相对**根节点**画布原点的坐标（已归零；扁平绝对定位与规格表用） */
    x: number;
    y: number;
    w: number;
    h: number;
    background?: string;
    opacity?: number;
    border?: DesignBorder;
    /** 已归一成 CSS 的圆角，如 "8px" / "8px 0px 0px 8px" */
    radius?: string;
    shadow?: string;
    /** 旋转角（度，来自 transform 矩阵）——0 之外才写 transform */
    rotation?: number;
    /** 容器是否裁剪子元素（Figma clipsContent / frameMaskDisabled） */
    clips?: boolean;
    /** TEXT：可见文字；INSTANCE：从覆写链取到的文案 */
    value?: string;
    text?: DesignTextStyle;
    layout?: DesignLayout;
    /** INSTANCE 内部结构在 ws.json 中缺失（无 children / 无填充描边）→ 必须用项目组件重建 */
    instanceInternalMissing?: boolean;
    /** 实例内每段覆写文字及 derived 度量；普通 TEXT 不使用。 */
    instanceTexts?: InstanceTextPart[];
    /** 每个视觉属性的来源：design / inferred / placeholder */
    prov?: Record<string, Prov>;
    children: DesignNode[];
    raw: Record<string, any>;
}
export interface DesignSpecRow {
    id: string;
    name: string;
    type: string;
    kind: NodeKind;
    x: number;
    y: number;
    w: number;
    h: number;
    background?: string;
    border?: string;
    radius?: string;
    borderEdges?: string;
    /** 文本颜色（TEXT 节点的 fillPaints；别和背景混为一谈） */
    color?: string;
    /** 虚线样式，如 "2,2" */
    dash?: string;
    /** INSIDE / OUTSIDE / CENTER */
    strokeAlign?: string;
    font?: string;
    /** INSTANCE 的 derived 文本字体与局部几何（已恢复到 non-opaque 的那部分） */
    instanceFonts?: string;
    text?: string;
    layout?: string;
    /** 完整的行内 auto-layout 描述（含 grow/align-self/wrap） */
    layoutFull?: string;
    shadow?: string;
    clips?: boolean;
    instanceInternalMissing?: boolean;
    /** 属性来源汇总，如 "fill=design,stroke=design,instance=placeholder" */
    prov?: string;
}
/**
 * 组件/页面标题：从显著文本或语义帧名推断，供 codegen 命名与文档使用。
 * source 标明来源；signals 记录为何选它；level 区分页面标题与分区标题。
 */
export interface DesignTitle {
    text: string;
    source: 'prominentText' | 'frameName' | 'annotationTitle';
    nodeId?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    fontSize?: number;
    weight?: number;
    level: 'page' | 'section';
    confidence: number;
    signals: AnnotationSignal[];
}
export interface DesignModel {
    fileKey: string;
    nodeId: string;
    componentName: string;
    width: number;
    height: number;
    tokens: DesignTokens;
    texts: Array<{
        text: string;
        font: string;
        color: string;
        x: number;
        y: number;
        w: number;
        h: number;
    }>;
    tree: DesignNode;
    /** 扁平规格表（逐节点一行），审计/Prompt/对照表都用它 */
    spec: DesignSpecRow[];
    /** 属性来源台账（P3）：按 design/inferred/placeholder 统计 + 逐节点明细 */
    coverage: CoverageReport;
    /** 画布备注：实现时要落实为行为，但**不渲染进 UI** */
    annotations: DesignAnnotation[];
    /** 推断出的页面/组件标题（显著文本 / 语义帧名 / 备注标题） */
    titles: DesignTitle[];
}
export interface CoverageReport {
    /** 总节点数（不含隐藏） */
    nodes: number;
    /** 各来源的"属性项"计数 */
    counts: {
        design: number;
        inferred: number;
        placeholder: number;
    };
    /** placeholder 占全部属性项的比例（0-1） */
    placeholderRatio: number;
    /** 逐项：哪个节点哪个属性是 placeholder / inferred */
    entries: Array<{
        id: string;
        name: string;
        property: string;
        prov: Prov;
    }>;
    /** 用到的字体族（是否本机安装要在渲染时探测） */
    fonts: string[];
    /** 说明性摘要（写进 SPEC） */
    summary: string;
}
type Any = Record<string, any>;
/**
 * fillPaints / strokePaints / 文字色 → CSS 颜色。
 * 多个可见纯色叠加时取**最后一个**（Kiwi 的 paints 按绘制顺序，后者在上层）。
 */
export declare function paintToCss(list: Any[] | undefined): string | undefined;
export declare function rgbToHex(rgb: number[]): string;
/** 填充 → { css, prov }；IMAGE 拿不到位图资源，画中性底纹并标 placeholder */
export declare function backgroundOf(n: Any): {
    css?: string;
    prov?: Prov;
};
/**
 * 逐边描边。关键：`borderStrokeWeightsIndependent=true` 时四条边独立，
 * 缺省的那几条是 **0**（不是继承 strokeWeight）。
 * 只有存在 `strokeGeometry`（确实画了描边）时才允许回落到 strokeWeight。
 */
export declare function borderOf(n: Any): DesignBorder | undefined;
/**
 * 逐角圆角 → CSS border-radius 值（TL TR BR BL）。
 * `rectangleCornerRadiiIndependent=true` 时四角就是**显式值**（全 0 也是显式 0），
 * 不能再回落到 cornerRadius —— 否则拼接组中间格会凭空长出圆角。
 */
export declare function radiusOf(n: Any): string | undefined;
export declare function shadowOf(n: Any): string | undefined;
export declare function fontKeyOf(n: Any): string;
/** 实例内部结构在 ws.json 中是否缺失（实测：96 个实例全部 0 children） */
export declare function instanceIsOpaque(n: Any, childCount: number): boolean;
/** 实例里真正显示的文字藏在覆写链里（普通 TEXT 节点的 textData 拿不到） */
export declare function overrideTextOf(n: Any): string | undefined;
/** 文本位置：优先用包围它的 derived 容器；根文本再把 auto-layout 的计算补在后面。 */
export declare function instanceTextPartsOf(n: Any): InstanceTextPart[];
/** 扁平化（不含隐藏节点） */
export declare function flatten(model: DesignModel): DesignNode[];
export declare function extractAnnotations(root: DesignNode): DesignAnnotation[];
/**
 * 推断页面/组件标题。CANVAS 根名永不作标题；无语义帧名被 deny-list 过滤。
 * prominentText 需同时满足：全局最大字号且唯一、>=1.5×正文字号众数、码点<=30、位于画布顶部带。
 * 候选备注（保留在树里的 red prose）第一行作为 annotationTitle。
 */
export declare function extractTitles(root: DesignNode): DesignTitle[];
export declare function buildDesignModel(nodeJson: Any): DesignModel;
export {};
