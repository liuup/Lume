# Lume AI 功能规划（深度修订版）

> 首次版本：2026-03-13（全面重写）
> 最近更新：2026-03-16（按代码实际落地状态修订）
> 定位：Lume 作为对标并超越 Zotero 的现代论文阅读软件，AI 能力不是附加层，而是贯穿"发现→阅读→理解→笔记→写作"全链路的核心竞争力。

---

## 0. 现状盘点与 AI 切入点

### 当前实现状态（2026-03-16）

| 功能 | 状态 | 说明 |
|------|------|------|
| **F1 论文速览卡** | 部分完成 | 已有 AI 设置项（API Key / Completion URL / Model）、后端 `summarize_document` 命令、左侧 AI 面板自动总结区、本地 summary cache；尚未做到结构化 JSON、页码回链与可追溯引用 |
| **F2 选中文本解释 / 翻译** | 部分完成 | 已有 `translate_selection` 命令与 PDF 划词自动翻译弹层；尚未实现术语解释、公式解释、追问对话和上下文关联 |
| **F3 批注→结构化笔记** | 部分完成 | 已新增本地规则版 `generate_annotation_digest` 命令、Notes 区 AI 草稿预览、追加/替换写入笔记；当前仅能可靠整理文字批注，无法从高亮轨迹反推原文 |
| **AI 基础设施** | 部分完成 | 已支持用户在设置中配置 OpenAI-compatible API Key / Completion URL / Model、summary/translation system prompt、翻译引擎切换（Google / LLM），并打通本地缓存；尚无 provider 抽象、失败重试和统一任务调度体系 |

### 本轮新增落地（2026-03-16）

- 设置页新增 AI 配置项：API Key、Completion URL、Model、自动总结开关、总结语言、翻译目标语言
- 左侧 AI 面板新增自动论文总结区，打开论文后可自动请求大模型总结并支持手动刷新
- `TextLayer.tsx` 新增 PDF 划词自动翻译弹层
- 后端新增 `summarize_document(item_id)` 与 `translate_selection(text)` 命令
- `summarize_document` 已支持本地缓存与手动强制刷新
- MetaPanel Notes 区新增「AI 整理」按钮，生成结构化批注草稿预览
- 后端新增 `generate_annotation_digest(item_id)` Tauri 命令
- 草稿支持「追加到笔记」和「替换笔记」
- 草稿内容包含分类分组、页码、批注统计、覆盖范围与能力边界说明
- 当前实现为本地规则整理，不依赖联网模型

### 当前 Lume 已具备的能力基础

| 模块 | 已有能力 | AI 可增强点 |
|------|----------|-------------|
| **PDF 阅读器** | 渲染、批注、文本层、Ctrl+F 搜索 | 语义搜索、段落解释、公式识别 |
| **元数据系统** | Crossref/arXiv 补全、完整字段编辑 | 多源融合判断、实体识别补全 |
| **Notes 系统** | Markdown 编辑器、SQLite 存储、全局搜索 | 批注→笔记自动整理、AI 增写 |
| **标签系统** | 自定义标签、颜色、按标签过滤 | 自动标签推荐、主题聚类 |
| **引用导出** | 7 种格式生成 | AI 写作中上下文感知引用推荐 |
| **全局检索** | SQL 关键词搜索、字段过滤 | 语义检索、自然语言查询 |

### AI 功能的三条核心主线

```
主线一：理解加速   → 打开论文时快速建立认知地图
主线二：知识沉淀   → 阅读产物（批注/笔记）自动结构化复用
主线三：写作闭环   → 从库内知识直接生成可用文本
```

---

## 1. 产品目标与设计原则

### 1.1 AI 核心目标

- **读得更快**：30 秒理解一篇论文的价值密度，再决定是否细读。
- **记得更牢**：阅读产物（批注、笔记、摘录）自动工程化为可查找、可引用的知识资产。
- **写得更顺**：从论文库中直接生成有引用的写作草稿，打通"理解→输出"闭环。
- **找得更准**：从关键词匹配升级为语义理解，真正找到"和我研究相关的论文"。

### 1.2 设计原则（不妥协）

| 原则 | 含义 | 具体要求 |
|------|------|----------|
| **可追溯** | AI 结论必须可回链到原文 | 每条 AI 输出必须附带页码 + 原文片段 |
| **可控** | 用户始终在主导 | AI 结果默认草稿态，用户编辑后才保存 |
| **Local-first** | 默认不联网处理 | 敏感任务（文内问答）优先本地模型 |
| **轻打扰** | AI 是助手不是干扰 | 侧边注入、不强制弹窗、可随时关闭 |
| **防幻觉** | 所有输出附置信标注 | 低置信项用视觉提示，不自动保存 |

---

## 2. AI 功能全景图

### 功能分级总览

```
P0（MVP，v0.2）：投入产出比最高，必须先做
├── F1. 论文速览卡（Paper Brief Card）
├── F2. 阅读中文本解释（Explain on Selection）
└── F3. 批注→结构化笔记（Annotation Digest）

P1（差异化，v0.3）：形成对 Zotero 的明显竞争优势
├── F4. 全库语义搜索（Semantic Search）
├── F5. 跨论文多维对比（Cross-Paper Comparison）
├── F6. 自动标签与主题聚类（Auto-Tagging & Clustering）
└── F7. 引用感知写作辅助（Citation-aware Drafting）

P2（生态，v0.4+）：建立研究工作台护城河
├── F8. 知识图谱可视化（Knowledge Graph）
├── F9. AI Review 助手（Paper Review Mode）
├── F10. 个性化阅读推荐（Reading Recommendations）
└── F11. 会议/期刊匹配推荐（Venue Matching）
```

---

## 3. P0 功能详细设计

### F1. 论文速览卡（Paper Brief Card）

**用户价值**
打开一篇论文时，30 秒内对「这篇论文值不值得细读、核心贡献是什么」形成判断。

**输出结构（严格结构化，LLM 输出 JSON）**

```json
{
  "problem": "研究解决的核心问题（1-2句）",
  "method": "使用的方法与数据集",
  "contributions": ["贡献1（原文页码）", "贡献2（原文页码）"],
  "key_results": ["指标1", "指标2"],
  "limitations": "局限性与适用边界",
  "tldr": "一句话总结（≤25字）",
  "confidence": 0.87,
  "source_pages": [1, 2, 8, 12]
}
```

**交互设计**
- 当前已实现：左侧 AI 侧边栏展示论文总结，并支持手动刷新
- 未来目标位置：可演进为独立的「AI 速览」视图或卡片化总结面板
- 触发：首次打开论文时后台静默生成；生成完毕后以缓存优先展示
- 每条结论点击→PDF 滚动到对应页码（复用现有 `PdfViewer` 跳页能力）
- 支持"简版（5条）/ 详版（15条）"切换
- 当前缓存策略：已写入 `ai_paper_summary_cache` 表，按 `item_id + language + model + prompt_key + 文件签名` 命中；手动刷新可跳过缓存
- 后续若升级为结构化 brief，可再演进为独立 `ai_briefs` 表

**与现有代码的结合点**
- `src-tauri/src/pdf_handlers.rs`：新增 `extract_text_for_ai(item_id)` 命令，按段落结构提取全文
- 当前已实现：`src-tauri/src/library_commands.rs` 中 `summarize_document(item_id, language, force_refresh)` 命令
- 当前已实现：`src-tauri/src/db.rs` 中 `ai_paper_summary_cache` 表迁移
- 后续目标：`generate_paper_brief(item_id, model_config)` + 独立 Brief UI + 页码级回链

---

### F2. 阅读中文本解释（Explain on Selection）

**用户价值**
阅读时遇到不懂的段落、公式、术语，直接选中后得到解释，不离开阅读界面。

**能力细分（选中后弹出菜单，按场景分支）**

| 操作 | 触发条件 | AI 行为 |
|------|----------|---------|
| **解释段落** | 选中≥20字的普通文本 | 用简洁语言解释该段核心意思 |
| **解释术语** | 选中≤5字（术语/缩写） | 给出领域定义 + 在本文中的含义 |
| **解释公式** | 选中含数学符号的文本 | 拆解公式含义，说明各变量 |
| **与前文关联** | 选中任意文本 | 解释该段与摘要/引言的逻辑关系 |
| **翻译** | 选中任意文本 | 翻译为中文/英文（可配置目标语言） |
| **质疑/追问** | 用户自由输入 | 基于选中上下文回答用户自定问题 |

**交互设计**
- 位置：`TextLayer.tsx` 的 selection 事件触发浮动工具条（参考 Readwise Reader 设计）
- 弹出工具条包含：🔍 解释 / 📖 翻译 / 🔗 关联 / 💬 追问
- 结果在 PDF 右侧滑入的「AI 解释抽屉」中展示，抽屉不遮挡 PDF 正文
- 每次解释附带：原文片段引用 + 当前页码 + 可信度
- 追问支持多轮对话（对话历史保存在当前 session，不持久化，关闭抽屉后清空）

**与现有代码的结合点**
- `src/components/TextLayer.tsx`：监听 `mouseup` 事件，获取 selection range 并触发浮层
- `src/components/PdfViewer.tsx`：新增 `AIExplanationDrawer` 侧边抽屉
- `src-tauri/src/library_commands.rs`：新增 `explain_selection(text, context, task_type)` 命令

---

### F3. 批注→结构化笔记（Annotation Digest）

**用户价值**
用户读完一篇论文，往往有大量高亮和批注，但最终复盘时找不到重点。AI 将所有批注自动分类整理，生成结构化 Markdown 草稿，用户编辑后一键保存到 Notes。

**整理逻辑（AI 分类器）**

```
输入：当前论文的所有批注（高亮文本 + 手写 + 文字批注）
分类输出：
  📌 核心观点      ← 高亮了但用户没有评论的关键句
  🔬 方法细节      ← 涉及实验设置/参数/模型结构的摘录
  📊 关键数据      ← 数字、表格引用、对比结果
  ❓ 待验证问题     ← 用户写了「?」或「why」的批注
  💡 可引用句      ← 适合直接引用到论文写作的表述
  🚧 局限性        ← 批注中标注的问题或不足之处
```

**交互设计**
- 位置：MetaPanel Notes Tab 顶部「✨ AI 整理批注」按钮（已有「提取批注」能力，此为增强版）
- 点击后生成预览（草稿态，显示为淡蓝色背景），用户可：
  - 直接「追加到笔记末尾」
  - 「替换整篇笔记」
  - 「逐条选择采纳」（类似 Git diff 视图）
- 整理结果含源批注链接（点击跳转到 PDF 对应页）

**与现有代码的结合点**
- 已有：`annotations` 数据库表 + MetaPanel Notes 系统（2026-03-10 完成）
- 已完成：`src-tauri/src/library_commands.rs` 中 `generate_annotation_digest(item_id)` 命令
- 已完成：Notes 区内 AI 草稿预览、追加/替换写入交互（集成在 `MetaPanel.tsx` 中）
- 未完成：真正的 LLM 版 `digest_annotations(item_id, model_config)` 命令
- 未完成：逐条采纳 UI、源批注点击直达、基于高亮原文的分类整理

**当前版本限制（已实现能力边界）**

- 当前仅对文字批注做语义分类；高亮与手写只统计数量，不参与正文级总结
- 摘要为本地规则整理，不是大模型总结，因此更偏“结构化归档”而不是“抽象归纳”
- 输出会明确标注 coverage / limitations，避免误导用户认为已具备完整 AI 理解能力

---

## 4. P1 功能详细设计

### F4. 全库语义搜索（Semantic Search）

**用户价值**
现有搜索是 SQL 关键词匹配，搜"transformer模型"找不到写了"attention mechanism"的论文。语义搜索让用户用自然语言描述研究需求，找到真正相关的文献。

**技术方案**

```
文本预处理（后台异步）：
  PDF 全文 → 按段落切块（512 token/块）→ 向量化 → 存入本地向量索引

检索流程：
  用户输入自然语言查询
  → 查询向量化
  → 余弦相似度检索 Top-K 段落
  → 段落按所属文献聚合，计算文献相关性得分
  → 结果：文献列表 + 每篇对应的最相关段落（含页码）
```

**交互设计**
- 位置：全局搜索栏（SearchBar.tsx）增加「语义」模式切换 toggle
- 结果展示：在命中段落下方显示原文片段预览（非全文，只显示最相关的 1-2 句 + 页码）
- 支持混合检索：关键词过滤（年份/作者/标签）+ 语义排序组合
- 向量索引构建进度在底部任务栏显示（和现有长耗时任务体系对齐）

**数据库新增**
```sql
-- 文本切块元数据（向量本体存本地文件）
CREATE TABLE ai_chunks (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  chunk_index INTEGER NOT NULL,
  page_number INTEGER,
  text TEXT NOT NULL,
  token_count INTEGER,
  vector_file_offset INTEGER,  -- 指向本地向量文件中的偏移位置
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_chunks_item ON ai_chunks(item_id);
```

---

### F5. 跨论文多维对比（Cross-Paper Comparison）

**用户价值**
做文献综述时，需要对比多篇论文的方法差异。人工比对耗时且容易遗漏，AI 自动生成对比表。

**交互设计**
1. 在文献列表中多选 2-6 篇论文（已有多选能力）
2. 右键菜单或浮动操作条新增「AI 对比」选项
3. 在新的全屏对话框或独立侧边栏中展示对比矩阵

**对比矩阵结构**

| 维度 | 论文A | 论文B | 论文C |
|------|-------|-------|-------|
| 研究任务 | ... | ... | ... |
| 数据集 | ... | ... | ... |
| 核心方法 | ... | ... | ... |
| 关键指标 | ... | ... | ... |
| 结论 | ... | ... | ... |
| 局限性 | ... | ... | ... |

- 每个单元格可点击→高亮对应论文的原文来源
- 支持导出为 Markdown 表格（直接粘贴到写作工具）
- 支持自定义对比维度（用户可增删行）

---

### F6. 自动标签与主题聚类（Auto-Tagging & Clustering）

**用户价值**
用户库中有几百篇论文，手动打标签费力且不系统。AI 自动推荐标签并按研究主题聚类。

**两个子功能**

**6a. 单篇自动标签推荐**
- 触发：导入新论文时，或在 MetaPanel Tags 区点击「AI 推荐」按钮
- AI 从摘要/标题提取 3-5 个标签，以「建议标签」气泡展示，用户一键接受或拒绝
- 历史上用户接受的标签会进入个性化词典，影响后续推荐

**6b. 全库主题聚类视图**
- 触发：侧边栏「Collections」区新增「AI 主题聚类」入口
- AI 对当前库内所有论文进行无监督聚类，输出 3-10 个主题
- 每个主题：主题名（AI 生成）+ 代表论文列表 + 核心关键词
- 用户可将某个主题一键转换为 Smart Collection

---

### F7. 引用感知写作辅助（Citation-aware Drafting）

**用户价值**
写论文相关工作章节时，用 AI 从库内已读论文中直接生成有引用的段落草稿，而不是从白板开始写。

**工作流**
1. 用户在一个写作面板（新模块）中描述写作意图：「帮我写一段关于 Transformer 在 NLP 中的应用综述，引用我库中相关论文」
2. AI 检索库内相关论文（复用语义搜索能力）
3. 生成段落草稿，引用以 `[Smith, 2023]` 格式占位
4. 用户点击引用占位符→显示匹配的 item，可替换或确认
5. 确认后，复制带完整引用的段落（支持直接导出为 BibTeX + 正文段落组合）

**这是 Lume 对 Zotero 最大的超越点之一：Zotero 只管理引用，Lume 直接参与写作。**

---

## 5. P2 功能详细设计

### F8. 知识图谱可视化（Knowledge Graph）

**用户价值**
帮助研究者"看见"自己的知识版图——论文之间通过引用、主题、方法形成的网络。

**图谱类型**
- **引用网络**：A 引用 B（来源：元数据中的参考文献列表）
- **主题相似网络**：A 和 B 在语义上相似（来源：向量相似度）
- **作者合作网络**：共同作者关系（来源：作者字段解析）
- **方法传承网络**：使用了相同方法或数据集的论文（来源：AI 提取）

**交互设计**
- 独立视图（非 PDF 阅读模式），使用力导向图布局
- 点击节点→打开对应论文详情
- 支持按主题/年份/标签过滤图谱

---

### F9. AI Review 助手（Paper Review Mode）

**用户价值**
做论文审稿时，AI 提供结构化评审框架，帮助审稿人不遗漏评分维度。

**输出结构**

```
Novelty（新颖性）：[1-5分] + AI 分析依据
Soundness（严谨性）：[1-5分] + AI 分析依据
Clarity（清晰度）：[1-5分] + AI 分析依据
Reproducibility（可复现性）：[1-5分] + AI 分析依据
Significance（影响力）：[1-5分] + AI 分析依据

主要优点：...
主要缺陷：...
审稿建议（Accept/Major Revision/Minor Revision/Reject）：...
```

- AI 输出为草稿，用户在界面内编辑后导出为文本
- 支持配置目标期刊/会议的审稿规范

---

### F10. 个性化阅读推荐（Reading Recommendations）

**用户价值**
库内已有几十篇论文，AI 分析阅读历史（打标签、笔记密度、批注多）推断用户核心研究方向，主动推荐可能感兴趣的未读文献（库内或来自 arXiv 每日推送）。

**数据来源**
- 库内：基于语义相似度推荐相关未读论文
- arXiv RSS（可开启）：每日拉取 cs.AI / cs.CL 等方向新论文，用向量相似度过滤推荐

**交互设计**
- 侧边栏「推荐」区，展示今日推荐 3-5 篇
- 每篇显示推荐理由：「与你最近阅读的 [论文名] 在方法上高度相关」

---

### F11. 会议/期刊匹配推荐（Venue Matching）

**用户价值**
研究者写完论文后，不确定投哪个会议或期刊最合适，AI 基于论文内容推荐最匹配的投稿目标。

- 输入：当前打开的论文（或粘贴摘要）
- 输出：推荐 Top-5 会议/期刊 + 理由（内容匹配方向、历史接收相似工作）
- 数据来源：预训练模型内嵌知识 + 可选联网查询 Semantic Scholar

---

## 6. 技术架构

### 6.1 整体架构分层

```
┌───────────────────────────────────────────────────────┐
│                    前端（React/TypeScript）              │
│  AI 速览 Tab │ 解释抽屉 │ 语义搜索 │ 写作面板 │ 图谱视图  │
└──────────────────────────┬────────────────────────────┘
                           │ Tauri IPC（invoke）
┌──────────────────────────▼────────────────────────────┐
│                    后端（Rust/Tauri）                    │
│  ai_commands.rs          │  AI 任务调度与结果缓存         │
│  pdf_handlers.rs         │  全文提取与分块               │
│  library_commands.rs     │  现有 CRUD 命令               │
└──────────────────────────┬────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────┐
│                    AI 推理层                            │
│  本地路径：llama.cpp / Ollama（隐私优先任务）            │
│  云端路径：OpenAI / Anthropic / Gemini API（可配置）     │
│  向量层：本地 Hnswlib 或 SQLite-vec（嵌入存储与检索）    │
└──────────────────────────┬────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────┐
│                    SQLite 数据库                        │
│  ai_briefs │ ai_chunks │ ai_tasks │ ai_conversations    │
└───────────────────────────────────────────────────────┘
```

### 6.2 新增后端文件结构

```
src-tauri/src/
├── ai_commands.rs       ← 所有 AI Tauri 命令入口（新增）
├── ai_engine.rs         ← 模型调用、prompt 管理、结果解析（新增）
├── vector_store.rs      ← 文本切块、嵌入生成、向量检索（新增）
├── pdf_handlers.rs      ← 新增 extract_structured_text() 函数
├── db.rs                ← 新增 AI 相关表迁移
└── lib.rs               ← 注册新命令
```

### 6.3 新增数据库表

```sql
-- AI 速览缓存
CREATE TABLE ai_briefs (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL UNIQUE REFERENCES items(id),
  model_provider TEXT NOT NULL,   -- 'ollama', 'openai', 'anthropic'
  model_name TEXT NOT NULL,
  content_json TEXT NOT NULL,     -- 结构化 JSON
  input_token_count INTEGER,
  output_token_count INTEGER,
  generated_at TEXT DEFAULT (datetime('now')),
  invalidated INTEGER DEFAULT 0   -- 1 = 需要重新生成
);

-- 文本切块与向量索引元数据
CREATE TABLE ai_chunks (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  chunk_index INTEGER NOT NULL,
  page_number INTEGER,
  section_hint TEXT,              -- 'abstract', 'introduction', 'method', ...
  text TEXT NOT NULL,
  token_count INTEGER,
  embedding_file TEXT,            -- 对应本地 .bin 向量文件路径
  embedding_offset INTEGER,       -- 向量在文件中的字节偏移
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(item_id, chunk_index)
);
CREATE INDEX idx_ai_chunks_item ON ai_chunks(item_id);

-- 异步 AI 任务队列
CREATE TABLE ai_tasks (
  id INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items(id),
  task_type TEXT NOT NULL,        -- 'brief', 'digest', 'embed', 'compare'
  status TEXT DEFAULT 'pending',  -- 'pending', 'running', 'done', 'failed'
  priority INTEGER DEFAULT 5,     -- 1=最高, 10=最低
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  error_message TEXT,
  result_ref TEXT                 -- 指向结果表的 id
);

-- 问答对话历史（可选持久化）
CREATE TABLE ai_conversations (
  id INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items(id),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,             -- 'user', 'assistant'
  content TEXT NOT NULL,
  source_page INTEGER,
  source_text TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 6.4 模型策略（两层）

| 任务类型 | 推荐模型 | 说明 |
|----------|----------|------|
| 摘要生成、标签推荐（轻任务） | 本地小模型（Qwen2.5-7B / Mistral-7B） | 本地优先，保护隐私 |
| 段落解释、术语定义（中任务） | 本地中模型 或 云端 API | 可配置 |
| 跨论文对比、写作辅助（重任务） | 云端 API（GPT-4o / Claude 3.5） | 长上下文，用户明确授权 |
| 向量嵌入（批量） | 本地嵌入模型（all-MiniLM / BGE-M3） | 全程本地，无需联网 |

### 6.5 Prompt 管理

- 所有 prompt 模板存放在 `src-tauri/resources/prompts/` 目录下（`.toml` 格式）
- 支持用户自定义覆盖（高级设置）
- 每个 prompt 包含：system、user_template、output_schema、max_tokens、temperature

```toml
# prompts/paper_brief.toml
[meta]
name = "paper_brief"
version = "1.0"
model_family = "any"

[prompt]
system = """你是一个专业的学术论文分析助手..."""
user_template = """请分析以下论文并按 JSON 格式输出速览卡：\n\n{paper_text}"""
output_schema = "PaperBrief"
max_tokens = 1024
temperature = 0.2
```

---

## 7. 前端组件规划

### 7.1 新增组件清单

```
src/components/
├── ai/
│   ├── AIBriefTab.tsx           ← 论文速览卡 Tab（MetaPanel 内）
│   ├── AIExplanationDrawer.tsx  ← 选中文本解释抽屉
│   ├── AnnotationDigest.tsx     ← 批注整理草稿预览
│   ├── SemanticSearchResult.tsx ← 语义搜索结果条
│   ├── ComparisonMatrix.tsx     ← 跨论文对比矩阵
│   ├── WritingAssistant.tsx     ← 写作辅助面板（独立视图）
│   ├── AIModelConfig.tsx        ← AI 模型配置（设置页内）
│   └── AITaskCenter.tsx         ← 底部 AI 任务进度条
└── meta-panel/
    └── (已有文件，新增 AI 相关 Tab 和按钮)
```

### 7.2 AI 设置页新增项

在现有设置面板中新增「AI & 隐私」分区：

```
AI 提供方：○ 仅本地模型  ● 本地优先（云端备选）  ○ 云端模型
本地模型路径：[路径选择器] （Ollama 端点或模型文件）
云端 API Key：[输入框，值不显示]  [测试连接]
隐私保护：
  ☑ 论文全文不上传云端（仅摘要用于速览）
  ☑ 保存 AI 对话历史到本地
  ☐ 允许遥测以改善 AI 推荐

向量索引：
  状态：已索引 42/156 篇论文  [立即全量索引]
  索引位置：~/.lume/ai_vectors/  （磁盘使用：1.2 GB）
```

---

## 8. 风险管理

### 8.1 主要风险与对策

| 风险 | 严重程度 | 对策 |
|------|----------|------|
| **幻觉风险**：AI 编造引用或结论 | 🔴 高 | 所有输出强制附带原文来源定位；无来源的内容不允许保存 |
| **隐私风险**：学术预印本/机密研究上传 | 🔴 高 | 默认本地处理；云端处理前明确弹窗授权 |
| **成本风险**：多论文对比、写作辅助 token 消耗大 | 🟡 中 | 预估 token 数量并提示用户；支持模型降级 |
| **性能风险**：向量索引构建阻塞 UI | 🟡 中 | 全部异步，后台线程，底部进度条；支持暂停/恢复 |
| **依赖风险**：本地模型体积大（7B≈4GB） | 🟡 中 | 可选下载，默认走云端 API；提供轻量嵌入模型替代 |
| **格式风险**：LLM 输出不符合 JSON 格式 | 🟢 低 | structured output / function calling 强制约束格式 |

### 8.2 置信度显示规范

```
置信度 ≥ 0.85：正常显示，不特别标注
置信度 0.65-0.84：显示「⚠️ 部分内容有不确定性，建议核对原文」
置信度 < 0.65：显示「🔴 该结论来自低质量提取，强烈建议人工核验」，且默认不可保存
```

---

## 9. 版本路线图

### v0.2 — AI MVP（建议 4-6 周）

- [ ] **F1** 论文速览卡
  - [x] 后端：基础 PDF 文本抽取 + `summarize_document` 命令
  - [x] 前端：MetaPanel 自动总结区 + 手动刷新
  - [x] 设置：AI 提供方配置入口
  - [ ] 数据库：`ai_briefs` + `ai_tasks` 表
  - [ ] 前端：结构化速览卡 + 跳页联动
- [~] **F2** 选中文本解释
  - [x] 前端：`TextLayer.tsx` 选中检测 + 自动翻译弹层
  - [x] 后端：`translate_selection` 命令
  - [ ] 前端：解释 / 追问 / 关联的统一浮动菜单
  - [ ] 前端：`AIExplanationDrawer.tsx` 右侧抽屉
  - [ ] 后端：`explain_selection` 命令
- [~] **F3** 批注整理助手（已落地本地规则版，LLM 版未完成）
  - [x] 后端：`generate_annotation_digest` 命令
  - [x] 前端：Notes 区 AI 草稿预览 + 追加/替换写入
  - [ ] 后端：LLM 版 `digest_annotations` 命令
  - [ ] 前端：逐条采纳 UI + 源批注跳转
  - [ ] 数据层：高亮内容和原文片段绑定

### v0.3 — AI 差异化（建议 6-8 周）

- [ ] **F4** 语义搜索
  - [ ] 后端：`vector_store.rs` 切块与嵌入
  - [ ] 数据库：`ai_chunks` 表 + 向量文件管理
  - [ ] 前端：SearchBar 语义模式切换 + 相关段落展示
  - [ ] 前端：`AITaskCenter.tsx` 索引进度显示
- [ ] **F5** 跨论文对比（选 2-6 篇论文触发）
- [ ] **F6** 自动标签推荐（单篇 + 全库聚类）

### v0.4 — 写作闭环（建议 8-10 周）

- [ ] **F7** 引用感知写作辅助（独立写作面板）
- [ ] **F8** 知识图谱可视化（考虑使用 D3.js 或 Cytoscape.js）

### v0.5+ — 研究工作台

- [ ] **F9** AI Review 助手
- [ ] **F10** 个性化阅读推荐 + arXiv RSS 过滤
- [ ] **F11** 会议/期刊匹配

---

## 10. 成功指标

### 行为指标（AI 功能是否被使用）

| 指标 | 目标 |
|------|------|
| AI 速览卡打开率（打开论文后查看） | ≥ 60% |
| 速览卡"采纳/有用"比例 | ≥ 70% |
| 选中文本解释每日触发次数（活跃用户） | ≥ 3次/天 |
| 批注整理后"追加到笔记"转化率 | ≥ 40% |
| 语义搜索使用率（vs 关键词搜索） | ≥ 30% |

### 结果指标（AI 功能是否有实际价值）

| 指标 | 目标 |
|------|------|
| 单篇论文首轮理解时间 | 较无 AI 时下降 40% |
| 阅读→可用笔记生成时间 | 较无 AI 时下降 50% |
| 文献综述写作任务完成时间 | 较无 AI 时下降 35% |
| 用户留存（AI 功能上线后 30 天） | 提升 20%+ |

---

## 11. 立即可执行的第一步（两周内）

> 优先级顺序已调整：F3 已有可用雏形，下一步应优先补齐 AI 基础设施并推进 F1/F2，避免产品只停留在“规则整理”层。

**Week 1**
1. 在 `src-tauri/src/` 新建 `ai_commands.rs` 和 `ai_engine.rs`，实现最小 OpenAI API 调用能力（带重试、超时、错误处理）
2. 在 `pdf_handlers.rs` 新增 `extract_text_for_ai(item_id)` — 将 PDF 全文按页结构提取为 `Vec<PageText>`
3. 在 `db.rs` 新增 `ai_briefs` 和 `ai_tasks` 表迁移
4. 实现 `generate_paper_brief` Tauri 命令（先跑通云端 OpenAI 路径）
5. 在 MetaPanel 新增空的「AI 速览」Tab（`AIBriefTab.tsx`），显示 loading → 结果 → 错误三种状态

**Week 2**
6. AIBriefTab 中实现每条结论点击→跳转 PDF 页码（复用 `PdfViewer` 的 `scrollToPage`）
7. 在设置页实现 AI 模型配置（API Key 存储到 Tauri 安全存储）
8. 实现结果缓存读写（写入/读取 `ai_briefs` 表，含手动刷新按钮）
9. 开始 F2 选中文本解释的 `TextLayer.tsx` 修改（选中检测 + 浮动菜单 UI）
10. 回补 F3 的高亮原文绑定能力，使 AI 整理不再只依赖文字批注

---

## 12. 总结

Lume 目前已具备完整的文献管理器底座（阅读 + 批注 + 笔记 + 引用 + 搜索），这是引入 AI 的最佳时机。

**与 Zotero 的本质差异将体现在：**
1. Zotero 的 AI 是事后附加（基于插件），Lume 的 AI 是原生内嵌于工作流
2. Zotero 管理文献，Lume 处理知识——从读完论文到生成可用写作素材的链路距离更短
3. Zotero 缺乏语义理解，Lume 的语义搜索将让"找到真正相关的论文"成为可能

**AI 功能的落地优先级一句话总结：**
> 先让 F1（速览）给用户留下第一印象，再用 F3（整理批注）让用户真正离不开，最后用 F4（语义搜索）和 F7（写作辅助）形成护城河。
