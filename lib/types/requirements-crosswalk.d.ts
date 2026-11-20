import type { DesignAnnotation } from './design.js';
/**
 * 「需求交互点 ↔ UI 交互标注」三方对照表。
 *
 * 纯函数：输入需求自由字符串 + 设计备注数组，输出一段可直接插进
 * CODEGEN_PROMPT 的 Markdown。不修改任何入参，不依赖 design.ts 的运行期实现
 * （DesignAnnotation 仅作类型约束，编译后此 import 被擦除）。
 *
 * 设计意图（接口即契约）：
 *  - 需求侧与 UI 侧都必须"逐条登记"，任一侧不得静默遗漏；
 *  - 粗匹配只作为提示，宁可标"未覆盖"也不做无证据的错配；
 *  - 标题/表头/指引为固定字面量，供 lead 单点集成与机器断言。
 */
/** 固定标题：首行、逐字一致 */
export declare const CROSSWALK_TITLE = "## \u9700\u6C42\u4EA4\u4E92\u70B9 \u2194 UI \u4EA4\u4E92\u6807\u6CE8 \u5BF9\u7167\u8868\uFF08\u9010\u6761\u843D\u5B9E\uFF09";
/** 固定表头：8 列，逐字一致 */
export declare const CROSSWALK_HEADER = "| \u9700\u6C42\u4EA4\u4E92\u70B9 | UI\u6807\u6CE8(\u5907\u6CE8N) | \u5BF9\u7167\u72B6\u6001 | \u627F\u8F7D props/state | \u4E8B\u4EF6 | \u771F\u5B9E\u63A7\u4EF6/\u884C\u4E3A | \u6587\u4EF6 | \u9A8C\u8BC1 |";
/** 段末逐字指引（机器断言用，勿改一字；「」不是本串的一部分） */
export declare const CROSSWALK_GUIDANCE = "\u6BCF\u4E00\u6761\u9700\u6C42\u4EA4\u4E92\u70B9\u4E0E\u6BCF\u4E00\u6761 UI \u6807\u6CE8\u90FD\u5FC5\u987B\u767B\u8BB0\uFF1B\u4E24\u4FA7\u4E0D\u8BB8\u9759\u9ED8\u9057\u6F0F\u3002\u5BF9\u7167\u72B6\u6001\u4E3A'\u672A\u8986\u76D6'\u7684\u4E5F\u8981\u6309\u5BF9\u5E94\u6765\u6E90\u5B9E\u73B0\u5E76\u5728\u9A8C\u8BC1\u5217\u8BF4\u660E\u3002";
/**
 * 渲染对照表段落。两侧都无内容时返回空字符串（不生成空表）。
 */
export declare function renderRequirementsCrosswalk(requirements: string, annotations: DesignAnnotation[]): string;
