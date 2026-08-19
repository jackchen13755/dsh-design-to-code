# dsh-design-to-code

DSH 工具：**设计稿 + 需求 → 符合项目约定的 React/TS 高质量代码骨架**。

- 设计数据来源：复用 `dsh-figma-reader` 的零 REST 链路（浏览器扩展静默捕获
  Kiwi 帧 → vendored 解码器），或直接传入已解码的节点 JSON；
- 确定性输出设计令牌（颜色/字体/间距/阴影）与组件树，样式数字不改；
- 生成可运行的 React + TypeScript + CSS Modules 骨架（**零运行时第三方依赖**）；
- 交互/业务逻辑由 `CODEGEN_PROMPT.md` 引导会话 LLM 按需求补全，
  兼顾复用、简洁、高扩展与项目约定。

## 工具（多轮生成）

| 工具 | 轮次 | 作用 |
|---|---|---|
| `figma_audit_node` | 第 0/1 步 | 全量遍历输出视觉属性 + 自动生成「实现前核对清单」（歧义标记待人工确认） |
| `figma_gen_component` | 第 1 轮 | 设计 + 需求 → React/TS/CSS Modules 骨架 + Codegen Prompt（可传入 `audit_path`） |
| `figma_codegen_round` | 第 2+ 轮 | 在已有输出上追加下一轮反馈/差异指令，迭代直到 checklist 全勾选 |

### figma_audit_node

| 参数 | 说明 |
|---|---|
| `url` / `file_key`+`node_id` | 设计稿定位（同 figma_gen_component） |
| `design_json` | 已解码节点 JSON；缺省读 `~/Downloads/figma_ws` 帧自动解码 |
| `output_dir` | 输出 audit.md / audit.json |

输出：全量节点清单（guid/name/type/position/size/fill/stroke/strokeWeight/
dashPattern/padding/文本/effects）+ 实现前核对清单 + ⚠️ 待人工确认列表。

### figma_gen_component（多轮）

额外参数：`audit_path`（审计 md 路径，并入 Prompt）、`round`（第几轮）、
`round_feedback`（上一轮差异/评审，round>1 必填）。

### figma_codegen_round

参数：`output_dir` + `round_feedback`（必填）。在 `CODEGEN_PROMPT.md` 追加
第 N 轮迭代指令（含验证闭环与“查项目既有实现”要求）。

## 示例（多轮流程）

```
1. figma_audit_node url=...?node-id=8049-4704 output_dir=./out
2. figma_gen_component url=...?node-id=8049-4704 \
     requirements="房号输入、制卡数量、有效期至，复制卡/制新卡，Esc 关闭" \
     component_name=ReplaceRoomDialog output_dir=./out \
     audit_path=./out/figma_..._8049:4704.audit.md
3. （会话 LLM 按 CODEGEN_PROMPT.md 补全）
4. figma_codegen_round output_dir=./out \
     round_feedback="底部操作栏应使用项目 profile-footer-wrap 模式（fixed+width100%+left0），不要写死 left:220px"
```

输出：

```
output_dir/
├── design-spec.json        # 设计模型（令牌/树/文本）
├── figma_*_*.audit.md      # 实现前核对清单（figma_audit_node）
├── src/tokens.ts           # 自动生成的设计令牌
├── src/types.ts            # 组件契约骨架
├── src/ReplaceRoomDialog.tsx
├── src/ReplaceRoomDialog.module.css
├── src/index.ts
├── CODEGEN_PROMPT.md       # 需求 → 最终代码的补全指引（多轮追加）
└── README.md
```

## CLI（复用设计审计）

```bash
node scripts/audit-node.mjs <fileKey> <nodeId> --json <decoded.json> --out <dir>
node scripts/audit-node.mjs <fileKey> <nodeId> --dir ~/Downloads/figma_ws
```

## 架构

```
Figma（REST 缓存 / WS 扩展帧）
   │  dsh-figma-reader 解码（零 REST）
   ▼
DesignModel（design.ts：令牌 + 组件树 + 文本）    ← 确定性
   │
   ▼
Audit（audit.ts：全量视觉属性 + 核对清单）        ← 确定性，先于编码
   │
   ▼
Codegen（codegen.ts：模板渲染，含 dashPattern/effects） ← 确定性
   │
   ▼
React/TS 骨架 + CODEGEN_PROMPT.md（多轮追加）
   │  会话 LLM 按需求补全交互/业务/API；
   │  运行时行为先 grep 项目既有实现再写，不自己发明
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
