# dsh-design-to-code

DSH 工具：**设计稿 + 需求 → 符合项目约定的 React/TS 高质量代码骨架**。

- 设计数据来源：复用 `dsh-figma-reader` 的零 REST 链路（浏览器扩展静默捕获
  Kiwi 帧 → vendored 解码器），或直接传入已解码的节点 JSON；
- 确定性输出设计令牌（颜色/字体/间距/阴影）与组件树，样式数字不改；
- 生成可运行的 React + TypeScript + CSS Modules 骨架（**零运行时第三方依赖**）；
- 交互/业务逻辑由 `CODEGEN_PROMPT.md` 引导会话 LLM 按需求补全，
  兼顾复用、简洁、高扩展与项目约定。

## 工具

`figma_gen_component`

| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | 二选一 | Figma 设计稿 URL（含 node-id） |
| `file_key` + `node_id` | 二选一 | 直接指定 |
| `design_json` | 否 | 已解码节点 JSON（dsh-figma-reader 的 `*.ws.json`）；缺省读 `~/Downloads/figma_ws` 帧自动解码 |
| `requirements` | 否 | 需求描述（交互/校验/接口） |
| `conventions` | 否 | 项目约定（技术栈/目录/命名/测试） |
| `component_name` | 否 | 生成组件名（英文），缺省由设计节点名推导 |
| `output_dir` | 否 | 输出目录 |

## 示例

```
figma_gen_component \
  url=https://www.figma.com/design/Zh9LpkjKgNrwuBITsD5d6g/...?node-id=8049-4704 \
  requirements="房号输入、制卡数量、有效期至（日期+时间），复制卡/制新卡按钮，Esc 关闭" \
  component_name=ReplaceRoomDialog
```

输出：

```
output_dir/
├── design-spec.json        # 设计模型（令牌/树/文本）
├── src/tokens.ts           # 自动生成的设计令牌
├── src/types.ts            # 组件契约骨架
├── src/ReplaceRoomDialog.tsx
├── src/ReplaceRoomDialog.module.css
├── src/index.ts
├── CODEGEN_PROMPT.md       # 需求 → 最终代码的补全指引
└── README.md
```

## 架构

```
Figma（REST 缓存 / WS 扩展帧）
   │  dsh-figma-reader 解码（零 REST）
   ▼
DesignModel（design.ts：令牌 + 组件树 + 文本）    ← 确定性
   │
   ▼
Codegen（codegen.ts：模板渲染）                  ← 确定性
   │
   ▼
React/TS 骨架 + CODEGEN_PROMPT.md
   │  会话 LLM 按需求补全交互/业务/API
   ▼
最终高质量组件（符合项目约定，零外部依赖）
```

## 构建

```bash
DSH_CHECKOUT=<deepseek-harness checkout> bash scripts/build.sh
```

## 依赖

- 运行时复用 `@deepseek-ai/dsh-tool-figma-reader`（git 依赖）的 Kiwi 解码器；
- peer 依赖：`dsh-tools` / `dsh-llm` / `cordis` / `schemastery`。
