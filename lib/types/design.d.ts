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
 * 4. 圆角可能是**逐角**的：`rectangleCornerRadiiIndependent` + `rectangle*CornerRadius`。
 *    拼接控件组"两端圆角 8、中间直角"就靠它。
 * 5. 实例（INSTANCE）在 ws.json 里**没有 children、没有 fillPaints/strokePaints**：内部结构拿不到。
 *    能拿到的只有 size / cornerRadius / 逐角圆角 / 以及**覆写文案**
 *    `symbolData.symbolOverrides[].textData.characters`（如 "Please Input"）。
 * 6. auto-layout 的 `stackMode/stackSpacing/stackPadding*` 都在数据里，
 *    绝对定位只是"静态还原"的手段；落到组件时应转成 flex（见 render-static / codegen）。
 */
export interface DesignTextStyle {
    family: string;
    size: number;
    weight: number;
    lineHeight?: string;
    letterSpacing?: string;
    align?: string;
    color?: string;
}
export interface DesignBorder {
    color: string;
    top: number;
    right: number;
    bottom: number;
    left: number;
}
export interface DesignLayout {
    mode?: string;
    spacing?: number;
    paddingTop?: number;
    paddingRight?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    counterAlign?: string;
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
export interface DesignNode {
    id: string;
    type: string;
    name: string;
    kind: 'root' | 'frame' | 'text' | 'input' | 'button' | 'icon' | 'instance' | 'other';
    /** 相对**父节点**的坐标（保留原始语义，自绘 HTML 用） */
    rx: number;
    ry: number;
    /** 相对**根节点**画布原点的坐标（已归零，绝对定位与规格表用） */
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
    /** TEXT：可见文字；INSTANCE：从覆写链取到的文案 */
    value?: string;
    text?: DesignTextStyle;
    layout?: DesignLayout;
    /** INSTANCE 内部结构在 ws.json 中缺失（无 children / 无填充描边）→ 必须用项目组件重建 */
    instanceInternalMissing?: boolean;
    children: DesignNode[];
    raw: Record<string, any>;
}
export interface DesignSpecRow {
    id: string;
    name: string;
    type: string;
    kind: DesignNode['kind'];
    x: number;
    y: number;
    w: number;
    h: number;
    background?: string;
    border?: string;
    radius?: string;
    borderEdges?: string;
    font?: string;
    text?: string;
    layout?: string;
    shadow?: string;
    instanceInternalMissing?: boolean;
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
}
type Any = Record<string, any>;
/** fillPaints / strokePaints / 文字色 → CSS 颜色（只取第一个可见 SOLID） */
export declare function paintToCss(list: Any[] | undefined): string | undefined;
export declare function rgbToHex(rgb: number[]): string;
/**
 * 逐边描边。关键：`borderStrokeWeightsIndependent=true` 时四条边独立，
 * 缺省的那几条是 **0**（不是继承 strokeWeight）。
 */
export declare function borderOf(n: Any): DesignBorder | undefined;
/** 逐角圆角 → CSS border-radius 值（TL TR BR BL），无圆角返回 undefined */
export declare function radiusOf(n: Any): string | undefined;
export declare function shadowOf(n: Any): string | undefined;
export declare function fontKeyOf(n: Any): string;
/** 实例内部结构在 ws.json 中是否缺失（实测：96 个实例全部 0 children） */
export declare function instanceIsOpaque(n: Any, childCount: number): boolean;
/** 实例里真正显示的文字藏在覆写链里（普通 TEXT 节点的 textData 拿不到） */
export declare function overrideTextOf(n: Any): string | undefined;
export declare function buildDesignModel(nodeJson: Any): DesignModel;
export {};
