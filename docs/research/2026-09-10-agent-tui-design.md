# Research: 主流 Coding-Agent TUI 界面设计调研（供 Nova 界面重构依据）

日期：2026-09-10。调研范围：Claude Code、Codex CLI、OpenCode、Gemini CLI、aider、Charm Crush / goose、pi（@earendil-works/pi-coding-agent），并对照 Nova 现状（`src/tui/`）。

## Summary

行业主流是「滚动 transcript + 底部输入框」的主缓冲区模式（终端自身持有 scrollback，复制/选择体验不受损），pi 提供主屏默认 + 实验性全屏 alternate-screen 双模式是较好的折中样本。工具调用统一用「行内可折叠块 + 状态图标（旋转 spinner → ✓/✗）」呈现，diff 用行级绿/红 +/− 并配语法高亮；权限确认普遍是行内选项列表（编号/箭头选择），而非传统模态。Nova 现状在输入区（单行、无补全/历史/粘贴处理）、diff 渲染、动画 spinner、状态区（无 cost/上下文百分比）、主题化五方面差距最大；另发现 `PermissionDialog` 存在条件调用 hooks 的 bug。

## 方法与证据等级（重要说明）

- **第一手（本次直接读源码/文档）**：pi（v0.85.1，本地 `D:\nodejs\node_global\node_modules\@earendil-works\pi-coding-agent`：README、CHANGELOG、docs/themes.md、`@earendil-works/pi-tui` README）；Nova（`D:\project\codeagent\src\tui\` 全部组件源码：App.tsx、ChatView.tsx、MessageBubble.tsx、InputBar.tsx、StatusBar.tsx、ToolCallView.tsx、PermissionDialog.tsx、TodoView.tsx、MarkdownText.tsx、stream-batcher.ts、hooks/useAgent.ts）。
- **非本次抓取**：本次运行没有可用的 web_search/source_check 工具，Claude Code / Codex CLI / OpenCode / Gemini CLI / aider / Crush / goose 的结论来自既有知识，逐条标注 **[unverified-this-run]**，并附官方 URL 供后续核验；这些条目 confidence 相应降级，决策前建议按 URL 抽查原文。

## Findings

### 1. 整体布局模式

1.1 **Claim:** 「滚动 transcript + 底部输入框」是多数 Ink 系工具（Claude Code、Gemini CLI）的默认模式：历史输出留在终端 scrollback，只有底部一小块区域动态重绘（流式输出、输入框、状态行）。
**Sources:** [Claude Code 仓库](https://github.com/anthropics/claude-code) / [Claude Code 文档](https://code.claude.com/docs) / [Gemini CLI 仓库](https://github.com/google-gemini/gemini-cli)。**Support:** interpretation（既有知识）[unverified-this-run]。**Confidence:** medium-high。
理由（推断）：Ink 天然适合「追加式渲染」——已完成的段落一次性写入后不再触碰，保留原生 scrollback、原生选择/复制，实现也最简单。

1.2 **Claim:** Codex CLI（Rust/ratatui 重写版）采用全屏 alternate-screen 布局：固定视口内 transcript 区域 + 底部 composer + 底部状态，输出为临时性（退出不留 scrollback）；历史 TS/Ink 版已被 Rust 版取代。
**Sources:** [openai/codex](https://github.com/openai/codex)。**Support:** interpretation [unverified-this-run]。**Confidence:** medium。
理由（推断）：ratatui 生态惯例就是 alt-screen + 自管滚动；代价是丢 scrollback，收益是精确的视口布局、内部滚动、全局快捷键。

1.3 **Claim:** OpenCode（Go，bubbletea/lipgloss/bubbles 系）也是全屏式布局：消息区（分页/滚动）、底部 editor、状态条；其 UI 以「消息块 + 工具块 + 权限对话框」等组件化呈现，风格紧凑、大量使用圆角边框和主题 token。
**Sources:** [sst/opencode](https://github.com/sst/opencode) / [opencode.ai 文档](https://opencode.ai/docs/)。**Support:** interpretation [unverified-this-run]。**Confidence:** medium。

1.4 **Claim:** aider 不用 TUI 框架：基于 Python prompt_toolkit 的输入循环，输出直接写入终端（prompt_toolkit 负责输入区多行编辑、/命令与文件名补全、语法高亮输入）；transcript 即终端 scrollback。
**Sources:** [Aider-AI/aider](https://github.com/Aider-AI/aider) / [aider.chat docs](https://aider.chat/docs/usage/watch.html)。**Support:** interpretation [unverified-this-run]。**Confidence:** medium-high。

1.5 **Claim:** Crush（charmbracelet/crush）是 Bubble Tea 全屏布局：顶部 header、消息/transcript 区、底部 composer、状态条，风格与其他 Charm 工具一致；goose（block/goose，Rust）同样走 ratatui 全屏方向。两者细节本次未能核实。
**Sources:** [charmbracelet/crush](https://github.com/charmbracelet/crush) / [block/goose](https://github.com/block/goose)。**Support:** interpretation [unverified-this-run]。**Confidence:** low-medium（goose 的具体 UI 栈不确定，勿据此下结论）。

1.6 **Claim（第一手）:** pi 默认 `TuiMainScreen`（主缓冲区、差分渲染、保留 scrollback），`--tui-mode fullscreen` 提供实验性 alternate-screen 视口：`VStack` 划分 transcript ScrollView（follow:"end"）+ 底部 editor/footer 固定区，支持鼠标滚轮/拖选/点击、OSC 133 提示符跳转、内嵌搜索面板、滚动条。
**Sources:** pi 包内 `@earendil-works/pi-tui/README.md`（本地已读）。**Support:** direct evidence。**Confidence:** high。
印证了「两种模式各有取舍」：pi 用同一套组件库同时支持二者，主屏保 scrollback，全屏换精确布局。

1.7 **Nova 现状（第一手）:** `App.tsx` 为单列 `Box`：StatusBar → TodoView → ChatView → PermissionDialog → InputBar，无高度管理/滚动策略，依赖 Ink 全量重绘。**Confidence:** high（direct evidence）。

### 2. 输入区设计

2.1 **Claim:** 头部产品输入区已趋同的能力矩阵（各家大都有）：
| 能力 | Claude Code | Codex CLI | OpenCode | Gemini CLI | aider | pi（第一手） |
|---|---|---|---|---|---|---|
| 多行编辑 | `\` 续行 / 选项粘贴 | Alt/Shift+Enter | 有 | Alt+Enter | Meta+Enter | Shift+Enter（Win Terminal Ctrl+Enter） |
| 历史回溯 | 上箭头/双 Esc 编辑历史 | 有 | 有 | 上箭头 | 上箭头（persistent） | —（走 /tree 回跳） |
| @文件引用 | `@` 模糊引用 | 有 | 有 | `@` | 文件名 Tab 补全 | `@` 模糊搜索 + Tab 补全 |
| /命令补全 | `/` 触发 | `/` | `/` | `/` | `/` + Tab 补全 | `/` 触发，扩展可注册 |
| 粘贴处理 | 大粘贴折叠提示 | 有 | 有 | 有 | 有 | bracketed paste；>10 行折叠为 `[paste #1 +50 lines]` 标记 |
| 外部编辑器 | — | — | — | — | 启动即编辑器流 | Ctrl+G 打开 $VISUAL/$EDITOR |

**Sources:** [Claude Code docs](https://code.claude.com/docs)、[openai/codex](https://github.com/openai/codex)、[sst/opencode](https://github.com/sst/opencode)、[google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)、[aider.chat](https://aider.chat/docs/)、pi README（本地）。**Support:** 表中 pi 列为 direct evidence；其余为 interpretation [unverified-this-run]。**Confidence:** pi 高；其余 medium。个别格子（如各家的粘贴折叠细节）未核实，按行取共识即可，不必逐格引用。

2.2 **Claim（第一手）:** pi 的 Editor 组件（pi-tui 内置）承担了大部分输入体验：多行 + word wrap、fake cursor（真光标隐藏、IME 定位用 CURSOR_MARKER）、`/` 斜杠命令与 Tab 文件路径双补全（`CombinedAutocompleteProvider`，支持 `~/`、`./`、`@` 前缀且 `@` 只列可附加文件）、bracketed paste、边框颜色表达 thinking 级别并在流式时兼作 working indicator；还有消息队列：Enter 队列 steering 消息（当前工具回合后注入）、Alt+Enter 队列 follow-up（全部完成后注入）、Esc 退出并还原队列、Alt+Up 取回。
**Sources:** pi README、pi-tui README（本地）。**Support:** direct evidence。**Confidence:** high。

2.3 **Nova 现状（第一手）:** `InputBar` 是最小实现：单行字符串拼接（`setInput(prev + inputChar)`），仅 Enter/Backspace/Ctrl+C/Esc（打断）；无历史、无多行、无补全、无光标位置/选区、无粘贴合并处理（终端粘贴多字符时会逐字符追加，含转义序列风险——`key.ctrl||meta` 过滤不足以拦截）、cwd 前缀直接展示 `process.cwd()`。**Confidence:** high（direct evidence，InputBar.tsx）。

### 3. 流式输出：markdown 渲染与 token 合批

3.1 **Claim（第一手）:** Nova 已有 32ms 合批（`StreamBatcher`：窗口内多个 delta 只触发一次 setState，回合结束强制 flush，unmount dispose）——这个策略与业界惯例一致（约一帧到两帧，16–50ms），可以保留。
**Sources:** `src/tui/stream-batcher.ts`、`hooks/useAgent.ts` 注释（本地）。**Support:** direct evidence。**Confidence:** high。

3.2 **Claim:** 各家对 markdown 都做终端渲染（标题/列表/粗体/代码块/行内代码），代码块普遍加语法高亮：pi 用 marked + highlight.js（依赖清单可见 `marked`、`highlight.js`）且渲染结果缓存（只重渲染变化消息）；Claude Code / Gemini CLI（Ink 系）同样渲染 markdown；Codex（ratatui）用临时 markdown 渲染层。
**Sources:** pi `package.json`（本地，direct）；[anthropics/claude-code](https://github.com/anthropics/claude-code)、[google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)、[openai/codex](https://github.com/openai/codex) [unverified-this-run]。**Confidence:** pi 部分 high，其余 medium。

3.3 **Claim:** 合批之外的常见性能策略：已完成消息不再重渲染（Ink 系用 `<Static>` 把历史消息移出 React reconciliation），只保留「流中最后一条 + 输入区」在动态区。Claude Code 的长输出还依赖终端 scrollback 本身，不在 React 里长期持有全部历史。
**Sources:** [ink 文档 Static](https://github.com/vadimdemedes/ink#static)、[anthropics/claude-code](https://github.com/anthropics/claude-code)。**Support:** interpretation [unverified-this-run]（Ink Static 机制为公开文档；Claude Code 具体用法未核实）。**Confidence:** medium。

3.4 **Nova 现状（第一手）:** `MarkdownText` 为手写 chalk 级解析器：仅支持 #/##/### 标题、`-`/`*` 列表、**bold**、行内代码、``` 代码块；代码块整块放单个 `Text`（backgroundColor gray + `\n` join，跨行样式会失效、且无语法高亮、无自动换行）；`ChatView` 对全部消息每次重渲染（`MessageBubble` 未 memo）。流式 markdown 片段（未闭合代码块等）按行容错处理但很脆弱。**Confidence:** high（direct evidence）。

### 4. 工具调用展示

4.1 **Claim:** 视觉状态惯例：running=旋转 spinner（braille 帧 ⠋⠙⠸… 持续动画）+ 黄色；done=✓ 绿色；error=✗ 红色；pending（等权限）=⚠/黄色提示。完成态用一行摘要（工具名+关键参数），输出默认折叠、可展开（快捷键或点击）。
**Sources:** pi README（Ctrl+O 折叠/展开工具输出，本地 direct）；[anthropics/claude-code](https://github.com/anthropics/claude-code)（`⏺` 符号 + Ctrl+O verbose 切换）[unverified-this-run]。**Support:** pi direct；Claude Code interpretation。**Confidence:** pi high，其余 medium。

4.2 **Claim:** diff 渲染惯例：行级 +/−，added 绿、removed 红、context 暗色，配合语法高亮和文件头（路径 + 修改统计）；edit 类工具（Edit/Write）展示 unified diff 而非参数 JSON；部分工具（Codex/OpenCode/aider）把 diff 作为「审批卡片」的一部分先预览后执行。
**Sources:** pi themes.md（`toolDiffAdded/Removed/Context`、`toolPendingBg/SuccessBg/ErrorBg` 等 token，本地 direct）；[openai/codex](https://github.com/openai/codex)、[sst/opencode](https://github.com/sst/opencode)、[Aider-AI/aider](https://github.com/Aider-AI/aider) [unverified-this-run]。**Support:** pi token 体系 direct；其余 interpretation。**Confidence:** medium-high（token 体系 high）。

4.3 **Claim:** aider 的编辑确认与 diff 展示自成一体：每次 AI 编辑应用后打印带色的 diff 摘要与 "Applied edit to X" 横幅；编辑前可要求确认（y/n/a=always/d=don't，`--yes-always` 等配置）；`/diff` 查看上次改动。
**Sources:** [aider.chat/docs/usage/tips](https://aider.chat/docs/usage/tips.html)、[Aider-AI/aider](https://github.com/Aider-AI/aider)。**Support:** interpretation [unverified-this-run]。**Confidence:** medium。

4.4 **Nova 现状（第一手）:** `ToolCallView`：
- 状态图标是**静态字符** `⠋`（无动画循环），黄/绿/红正确；
- 折叠摘要 = 工具名 + 前 80 字符 JSON args；展开显示全量 args + 结果（截 20 行）——**没有**对 edit/write/bash 等工具做类型化展示，**没有** diff 渲染；
- `useInput` 在**每个** ToolCallView 实例上全局注册，Enter 会让所有已渲染的工具块同时翻转 expanded（多块时行为混乱），且与 InputBar 的 Enter 提交在焦点上无仲裁；
- running/done 之间没有 pending（等权限）态。
**Confidence:** high（direct evidence）。

### 5. 权限/审批交互

5.1 **Claim:** 主流是**行内选项列表**而非系统式模态：Claude Code 在流下方插入编号选项（如 1. Yes 2. Yes, don't ask again 3. No），数字/箭头选择；Codex CLI 用审批卡片（approve / approve for session / deny）；OpenCode 用权限对话框（allow/deny/all）。共同点：列出将要执行的具体命令/路径、危险项高亮、提供「本次 + 会话级记住」两档放行。
**Sources:** [Claude Code docs](https://code.claude.com/docs)、[openai/codex](https://github.com/openai/codex)、[sst/opencode](https://github.com/sst/opencode)。**Support:** interpretation [unverified-this-run]。**Confidence:** medium。

5.2 **Claim:** pi 反其道而行：核心**没有权限弹窗**（README 明言 "No permission popups. Run in a container, or build your own confirmation flow with extensions"），把审批留给扩展/容器化。
**Sources:** pi README Philosophy 节（本地）。**Support:** direct evidence。**Confidence:** high。

5.3 **Nova 现状（第一手）:** `PermissionDialog`：黄色双线边框盒子插在 ChatView 与 InputBar 之间，展示工具名/参数/危险原因（bash 命令匹配 `DANGEROUS_PATTERNS`），按键 `a/d/A`（无箭头导航、无编号、无会话级 Always 持久化——注释承认 "the permission policy would need to be updated"）。**另有一个真实 bug：`if (!pending) return null;` 在 `useInput` 之前提前返回，违反 React hooks 条件调用规则**（pending 从 null → 非空切换时 hooks 顺序改变，可能崩溃或行为异常）。**Confidence:** high（direct evidence）。

### 6. 状态区

6.1 **Claim（第一手）:** pi 的 footer 是最完整范式：working directory、session 名、总 token/缓存用量（`↑` input、`↓` output、`R` cache read、`W` cache write、`CH` 最新命中率）、cost、context 占用、当前 model；editor 边框兼作 working indicator（颜色=thinking 级别）。
**Sources:** pi README「Interactive Mode」与 docs/themes.md（本地）。**Support:** direct evidence。**Confidence:** high。

6.2 **Claim:** 其余各家状态信息大同小异：Claude Code 在 `/status` 与上下文剩余自动压缩警告中展示模型/上下文；Codex 在 composer 下方显示 token 与 context 百分比；OpenCode 底部状态条显示 model/tokens。
**Sources:** 同上各官方仓库/文档 [unverified-this-run]。**Support:** interpretation。**Confidence:** medium。

6.3 **Nova 现状（第一手）:** `StatusBar` 已有：model、cwd、MCP 数、pi 风格 R/W/CH 缓存指标、更新提示、subagent 活动行——但**缺**：总 token、cost、context 百分比（数据源 `PromptCacheMetrics`/usage 回调已在 useAgent 中存在，扩展成本低）。**Confidence:** high。

### 7. 主题与配色

7.1 **Claim（第一手）:** pi 用 JSON 主题 token 体系：`vars`（primary/secondary）+ 语义 token（border/borderAccent/success/error/warning/muted/thinkingText/selectedBg/toolPendingBg/toolSuccessBg/toolErrorBg/toolTitle/toolOutput/toolDiffAdded/Removed/Context/mdHeading/mdCode/mdListBullet/syntaxKeyword…），支持终端背景检测自动选 dark/light、热重载、`--use-theme light/dark` 跟随外观。这是值得直接借鉴的 token 命名法。
**Sources:** docs/themes.md + theme-schema.json（本地）。**Support:** direct evidence。**Confidence:** high。

7.2 **Claim:** Ink 系（Claude Code/Gemini CLI）多用 chalk 命名色 + `dim`/`bold` 惯例：dim gray = 元信息/次要文本、bold = 标签与强调、蓝 = 用户消息、绿 = 成功/diff 增行、红 = 错误/diff 删行、黄 = 进行中/警告；Bubble Tea 系（Crush）则重度依赖 lipgloss 主题文件。
**Sources:** [charmbracelet/lipgloss](https://github.com/charmbracelet/lipgloss)、各家仓库 [unverified-this-run]。**Support:** interpretation。**Confidence:** medium。

### 8. 行业共识 vs 差异化

**共识（几乎每家都做）：**
- 底部 composer + 消息流；Esc 中断；markdown 终端渲染；工具调用行内块（spinner→✓/✗、输出可折叠）；diff 行级 +/− 着色；`/` 斜杠命令；`@` 文件引用；token/上下文/模型状态展示；警告/危险项黄色/红色高亮。

**差异化：**
- 主屏 scrollback vs 全屏 alt-screen（Claude Code/aider/pi-default vs Codex/OpenCode/Crush/pi-fullscreen）；
- 消息队列与 steering/follow-up 语义（pi 独有，第一手）；
- 编辑前 diff 审批卡片（Codex/OpenCode）vs 编辑后展示（aider/Nova）；
- 主题 token 体系与热重载（pi）、无权限弹窗哲学（pi）vs 行内审批列表（Claude Code/Codex/OpenCode）；
- 原生图片渲染（pi Kitty/iTerm2 协议）。

### 9. Nova 差距与重构建议（对照 `src/tui/`，仅建议不实现）

| # | 领域 | 现状（第一手） | 建议（参照对象） |
|---|------|----------------|------------------|
| 1 | 布局 | 单列 Box，无静态/动态分区 | 采用 Ink `<Static>`：完成消息进 Static、仅「最后一条+输入区+状态」动态；长期评估主屏/全屏双模式（pi 模式可作蓝本） |
| 2 | 输入区 | 单行拼接、无历史/补全/光标 | 重写为多行 Editor：光标管理、Shift+Enter 换行、上箭头历史、bracketed paste + 大粘贴折叠标记、`/` 命令与 `@` 文件补全（先做 `@` 与 `/`，Tab 补全其次）；参照 pi Editor 功能集 |
| 3 | 流式 | 32ms 合批（保留）；MarkdownText 手写、代码块无高亮无换行 | 保留 StreamBatcher；markdown 渲染改 marked + highlight.js 管线（pi 同方案）、渲染结果按消息缓存；MessageBubble 用 React.memo |
| 4 | 工具块 | 静态 `⠋`、Enter 全局翻转、无 diff、无 pending 态 | 换 Ink Spinner 动画；折叠/展开改为每块独立快捷键或点击（去掉全局 useInput）；为 edit/write 增加 diff 渲染（行级 +/−、绿/红、语法高亮）；增加 pending（等权限）态 |
| 5 | 权限 | a/d/A 键、Always 未持久化、**条件 hooks bug** | 修复 useInput 条件调用（把 hook 提到早退之前或拆组件）；改为编号/箭头选项列表；实现会话级「总是允许」持久化；展示具体命令而非原始 JSON 参数 |
| 6 | 状态区 | 有 R/W/CH，缺 token/cost/context% | footer 增加总 token（↑↓）、cost、context 百分比（数据已在 useAgent usage 回调中）；working indicator 移入输入框边框（pi 做法） |
| 7 | 主题 | 颜色硬编码散落各组件 | 引入 theme token 层（参照 pi token 命名：border/success/error/warning/muted/toolDiff*/md*），先建 `theme.ts` 单点替换 |
| 8 | Todo | TodoView 纯展示（合格） | 保留；建议展示当前 in_progress 高亮 + 计数 |

优先级建议（researcher 推断）：2（输入区）> 4（工具块/diff）> 5（权限 bug+交互）> 1（Static 分区）> 6（状态区）> 7（主题）。

## Contradictions

- 布局模式上「保 scrollback」与「全屏精确布局」是真实的设计张力：pi 两个都做（默认主屏、可选全屏），Codex/OpenCode 选全屏，Claude Code/aider 选主屏。未发现谁"更正确"的证据，属于产品取舍。pi 的一手证据表明：全屏模式需自建滚动/选择/搜索才能补回 scrollback 的便利（pi 为此实现了鼠标拖选、OSC 52 复制、内嵌搜索）。
- goose 的当前 UI 技术栈（Rust ratatui 还是历史 TS Ink 残留）本次无法核实，与任务描述「Bubble Tea 系」的说法存在出入可能——goose 主体是 Rust，TUI 框架归属未验证。标注为待查。

## Missing evidence

- 本次运行无 web 访问工具：Claude Code、Codex CLI、OpenCode、Gemini CLI、aider、Crush 的所有 [unverified-this-run] 条目均未对照 2026-09 现状原文；特别是：各家粘贴处理细节、Claude Code 权限选项的当前文案、Codex 审批卡片的当前形态、OpenCode 组件清单。决策前请按 Sources URL 抽查。
- Crush/goose 的布局细节完全未核实（仅风格层面的常识性描述）。
- pi 全屏模式（`--tui-mode fullscreen`）为实验性，其稳定性/默认化时间表未知（CHANGELOG 0.85.0–0.85.1 仍在持续改进 fullscreen 交互，第一手）。

## Sources

**Kept（第一手，本次已读）**
- pi README（`D:\nodejs\...\@earendil-works\pi-coding-agent\README.md`，v0.85.1，2026-09-05）— 布局/编辑器/命令/快捷键/消息队列/主题/Philosophy
- pi CHANGELOG（同上）— 版本时间线、fullscreen 持续改进证据
- pi docs/themes.md + `@earendil-works/pi-tui/README.md`（嵌套 node_modules）— 主题 token 体系、TUI 组件库（Editor/Markdown/SelectList/Overlays/差分渲染/CSI 2026）
- Nova `src/tui/` 全部 10 个文件 — 现状对照的事实基础

**Kept（官方 URL，[unverified-this-run]，供核验）**
- https://github.com/anthropics/claude-code 与 https://code.claude.com/docs — Claude Code
- https://github.com/openai/codex — Codex CLI
- https://github.com/sst/opencode 与 https://opencode.ai/docs — OpenCode
- https://github.com/google-gemini/gemini-cli — Gemini CLI
- https://github.com/Aider-AI/aider 与 https://aider.chat/docs — aider
- https://github.com/charmbracelet/crush — Crush
- https://github.com/block/goose — goose
- https://github.com/vadimdemedes/ink#static — Ink Static 机制（公开文档）

**Rejected/deprioritized**
- 各类博客转述/SEO 汇总（未访问，因无法核验，一律不用）
- 旧版 Codex TS 版相关的第三方教程 — 已被 Rust 版取代，参考价值低

## Next steps

1. 按 Kept 的官方 URL 逐条核验 [unverified-this-run] 结论，重点：Claude Code 权限选项文案、Codex 审批卡片、OpenCode 组件清单、aider 编辑确认键位。
2. 若要落地建议 #1/#3：读 Ink `<Static>` 文档并验证与 32ms 合批的组合行为（长会话性能基准）。
3. 若考虑全屏模式：精读 pi `TuiAltScreen` 源码（VStack/ScrollView 布局与差分行更新）评估在 Ink 中复刻的成本。

## Supervisor coordination

已通过 contact_supervisor 确认：日期 2026-09-10；同时写入 runtime artifact 与 `D:\project\codeagent\docs\research\2026-09-10-agent-tui-design.md`；无 web 工具的限制已被接受，条件是逐条标注 [unverified-this-run] 并附官方 URL（已照办）。
