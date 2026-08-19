/**
 * DesignModel：把 dsh-figma-reader 解码出的 Kiwi 节点 JSON 提炼成
 * 可供代码生成器使用的结构化设计模型（令牌 + 组件树 + 文本）。
 *
 * 输入格式：`{ fileKey, nodeId, node, descendants }`（figma_read_node_ws / CLI 产物）。
 */
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
    kind: 'root' | 'frame' | 'text' | 'input' | 'button' | 'icon-close' | 'instance' | 'other';
    label?: string;
    value?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    background?: string;
    color?: string;
    font?: string;
    children: DesignNode[];
    raw: Record<string, any>;
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
}
type Any = Record<string, any>;
export declare function buildDesignModel(nodeJson: Any): DesignModel;
export {};
