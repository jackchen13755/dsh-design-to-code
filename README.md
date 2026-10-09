# dsh-design-to-code

DSH 工具：**设计稿 → 可核对的视觉基准 / 审计清单 / 代码骨架 / 变更简报**。

核心立场：设计稿与实现之间，**先有一个能被人一眼确认的"视觉基准"**，
再让组件实现去对齐它；差异必须能用实测数值核对，而不是"看起来差不多"。

- 设计数据来源：复用 `dsh-figma-reader` 的零 REST 链路（浏览器扩展静默捕获 Kiwi 帧 →
  vendored 解码器），或直接传入已解码的节点 JSON；
- 确定性输出：坐标/逐边描边/逐角圆角/字体/阴影/auto-layout 全部来自设计数据，不靠肉眼抄数；
- 生成物零运行时第三方依赖；交互与业务逻辑由 `CODEGEN_PROMPT.md` 引导会话 LLM 按需求补全。

## 工具

| 工具 | 场景 | 作用 |
|---|---|---|
| `figma_render_static` | **新建 / 改造，第一步** | 逐节点渲染 1:1 **静态还原页** `static/index.html` + 规格/映射表 `SPEC.md`。这是唯一的视觉基准，人工先确认它 |
| `figma_change_brief` | **需求是"在现有页面上改几处"** | 新稿 → 静态基准页 + **旧稿 vs 新稿的逐字段设计差异** + 在目标仓库里 grep 出的**代码落点候选** + 逐条变更计划模板 `CHANGE.md` |
| `figma_audit_node` | 新建 | 实现前核对清单（逐边描边/逐角圆角/字体/auto-layout）；把「真歧义（要问设计）」与「数据缺失（按兜底规则做）」分开 |
| `figma_gen_component` | 新建 | 设计 + 需求 → React/TS/CSS Modules **几何骨架** + Codegen Prompt（实例渲染为语义占位并带 `data-design-name` 供替换为项目组件） |
| `figma_codegen_round` | 新建，第 2+ 轮 | 在已有输出上追加下一轮差异指令，迭代到差异清零 |

### 两条推荐流程

**A. 新建组件**

```
1. figma_render_static   → 人工确认 static/index.html 与设计稿一致
2. figma_audit_node      → 核对清单（真歧义先问设计）
3. figma_gen_component   → 骨架 + CODEGEN_PROMPT.md（static_page 传入基准页路径）
4. 会话 LLM 按 Prompt 把占位换成项目既有组件、绝对定位收敛成 flex、色值映射主题令牌
5. figma_codegen_round   → 按"组件渲染截图 ↔ 基准页"的差异迭代
```

**B. 改现有页面**（需求只动几处，最容易"顺手重画"出错）

```
1. figma_change_brief node_id=<新稿> old_node_id=<旧稿> code_dir=<项目目录> \
     project=<项目名> output_dir=<out>
   → CHANGE.md：设计差异 + 代码落点 + 变更计划模板 + 收尾检查（含静态基准页）
2. 按 §4 计划逐条填「现状（代码实测）→ 改法（文件:行）」，再做最小改动
3. 用 §5 收尾检查 + 基准页对照验收
```

## 设计数据里六个必踩的坑（都已处理，改代码前请先读）

1. **transform 是相对父节点的**，根节点自身还带画布坐标（如 6119/4653）。
   必须"根节点归零 + 逐层累加"，否则生成物整体跑到画布外（历史 bug：组件渲染成**空白**）。
2. **`strokeWeight` 是带默认值的标量**（实测 364 个节点 281 个 =1），不能当"有描边"的证据；
   要看 `strokePaints` / `strokeGeometry`。旧版拿它判"隐藏边框"，对 259 个节点误报，
   把清单变成噪音，最终让会话 LLM 整份忽略。
3. **描边可能是逐边的**：`borderStrokeWeightsIndependent=true` + `borderLeft/Right/Top/BottomWeight`。
   设计稿"只有左边框"就是这么表达的。
4. **圆角可能是逐角的**：`rectangleCornerRadiiIndependent` + `rectangle*CornerRadius`。
   拼接控件组"两端圆角 8、中间直角"靠它。
5. **实例（INSTANCE）在 ws.json 里没有 children、没有填充描边**：内部结构拿不到。
   能拿到的是 size / 逐角圆角 / **覆写文案** `symbolData.symbolOverrides[].textData.characters`；
   落实现时必须用项目既有组件重建，插件只给占位与规格。
6. **auto-layout 的 `stackMode/stackSpacing/stackPadding*` 都在数据里**：绝对定位只是静态还原的手段，
   落到组件时应转成 flex。

## 静态还原页不是"要搬进项目的样式"

`static/index.html` 是视觉基准（绝对定位 + 内联样式 + 设计稿 literal 色值），
直接搬进项目会与项目/组件库样式打架（重复定义、优先级、主题失效、失去自适应）。
`SPEC.md` 第 2 节给出"设计规律 → 项目 token"的映射表（逐边描边用 `border-width` 分边、
逐角圆角用相邻重叠 1px、色值映射主题变量…），实现按映射表走。

## 输出结构

```
output_dir/
├── static/index.html        # 视觉基准页（figma_render_static）
├── static/SPEC.md           # 逐节点规格 + 设计→项目 token 映射表
├── CHANGE.md                # 变更简报（figma_change_brief）
├── figma_*_*.audit.md       # 实现前核对清单（figma_audit_node）
├── gen/design-spec.json     # 设计模型（令牌/树/规格表）
├── gen/src/*.tsx|.module.css|tokens.ts|types.ts
├── gen/CODEGEN_PROMPT.md    # 需求 → 最终代码的补全指引（多轮追加）
└── gen/README.md
```

## 构建

```bash
./node_modules/.bin/tsc -p tsconfig.json     # 或 bash scripts/build.sh
```

装进 DSH profile：把 `lib/` 与 `package.json` 同步到
`~/.dsh/profiles/<profile>/node_modules/@deepseek-ai/dsh-tool-design-to-code/`，
可用 `dev_reload_package` 热重载（无需重启）。

## 依赖

- 运行时复用 `@deepseek-ai/dsh-tool-figma-reader`（git 依赖）的 Kiwi 解码器；
- peer 依赖：`dsh-tools` / `cordis` / `schemastery`。

## 变更记录

- **0.1.0**：新增 `figma_render_static`（视觉基准）与 `figma_change_brief`（改现有页面）；
  修正 DesignModel 的坐标/逐边描边/逐角圆角/实例文案/auto-layout；审计歧义判据重写（259 误报 → 0）；
  骨架修掉"渲染成空白"、文字样式丢失、实例图层名当正文三个致命缺陷。
- **0.0.2**：兼容 DSH 0.2.0-rc.1 的 peer 范围。
