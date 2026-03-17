# Lume

[English](README.md) | [中文](README.zh-CN.md)

> [!WARNING]
> Lume 目前仍处于原型阶段。数据流、功能和交互都还在快速变化，现阶段仍然会有 bug、缺口和破坏性调整。

Lume 是一个面向学术阅读与整理的本地优先桌面应用。它把论文库管理、PDF 阅读、批注、笔记、元数据补全、翻译、AI 摘要和引用导出整合在同一个 Tauri 应用里。

## 当前已经支持

- 本地论文库，支持文件夹 / 子文件夹 / 回收站 / 重命名 / 移动 / 搜索
- 通过文件选择器或直接拖拽 PDF 到应用窗口导入
- 多标签阅读、懒加载渲染、缩放预设、文内搜索
- 本地批注持久化，以及论文级 Markdown 笔记
- 先从 PDF 本体提取线索，再通过 arXiv、Crossref、OpenAlex 做元数据补全
- 元数据抓取报告，可查看每一步 provider 命中了什么字段
- 引用生成与导出
- 划词翻译，支持 `google`、`bing` 网页端、`llm`
- AI 论文摘要和批注 digest
- 原生 CLI，可用于列出、搜索、导出、打标签、打开条目

## 当前技术架构

### 前端

- `React 19 + TypeScript + Vite`
- `Tailwind CSS`
- `src/App.tsx` 负责主界面骨架、拖拽导入、标签页、阅读面板和文库交互
- 状态按职责拆在几个 hook 里：
  - `useLibrary`：文库状态和 Tauri 命令调用
  - `useSettings`：持久化设置、主题和字号应用
  - `useFeedback`：右下角消息提示
  - `useI18n`：运行时语言包加载

### 后端

- `Tauri v2 + Rust`
- `src-tauri/src/lib.rs` 负责共享状态、插件、CLI IPC 和命令注册
- `src-tauri/src/library_commands.rs` 负责文库 CRUD、搜索、笔记、标签、导出、翻译、批注 sidecar 和设置持久化
- `src-tauri/src/metadata_fetch.rs` 负责元数据解析、provider 编排、重试、缓存、字段合并策略和抓取报告
- `src-tauri/src/pdf_handlers.rs` 负责基于 PDFium 的页面渲染、文本提取、选区矩形和 PDF 原始元数据线索
- `src-tauri/src/cli.rs` 与 `src-tauri/src/cli_ipc.rs` 负责原生 CLI 和单实例 GUI 唤起

### PDF 管线

Lume 现在是混合 PDF 架构：

- Rust 侧的 `pdfium-render` 负责位图渲染、文本提取、选区定位和 PDF 内部线索提取
- 前端的 `pdfjs-dist` 负责文档 / 页面缓存和预热

所以当前项目已经不能简单描述成“纯 PDFium”或“纯 PDF.js”方案，两边都在参与运行时。

### 存储模型

应用数据存放在 Tauri 的 `app_data_dir()` 下：

- `library/`：导入后的 PDF
- `trash/`：软删除后的 PDF
- `lume_library.db`：SQLite 数据库，保存条目、附件、笔记、标签、设置和缓存
- 每篇 PDF 旁边会有批注 sidecar：`.<文件名>.Lume-annotations.json`

Lume 是本地优先模型。导入时会把 PDF 复制进 Lume 管理的目录，而不是直接引用原始路径。

## 元数据抓取流程

当前元数据流程不是“查一个源就结束”，而是分阶段推进：

1. 先从 PDF 本体提取候选标题、作者、年份、DOI、arXiv ID。
2. 先跑精确查询：`arXiv ID`、`Crossref DOI`、`OpenAlex DOI`。
3. 如果结果仍然不完整，再跑模糊标题检索：`OpenAlex`、`Crossref`、`arXiv`，并结合标题变体、作者和年份打分。
4. 按字段粒度 merge，不同 provider 有优先级，preprint 结果不会反向覆盖正式发表信息。
5. 结果会缓存，并把抓取报告保存下来，供 UI 展示。

这套流程的目标是提升“从 PDF 导入论文后自动补全元数据”的稳定性，尤其是减少预印本信息覆盖正式 venue 的问题。

## AI 与翻译

- AI 摘要和 `llm` 翻译走用户配置的 OpenAI 兼容 completion endpoint
- 非 LLM 翻译目前支持：
  - `google`：公共网页接口
  - `bing`：Bing Translator 网页端流程
- 只有 `llm` 翻译需要先配置 AI 接口

## 快速开始

### 本地开发

```bash
npm install
npm run tauri dev
```

### CLI

示例：

```bash
Lume list
Lume list --json
Lume search "transformer" --json
Lume export --format bibtex -o refs.bib
Lume open /absolute/path/to/paper.pdf
```

开发环境可直接运行：

```bash
npm run cli:list
```

### 构建

```bash
npm run tauri build
```

打包与发布说明见 [docs/build-and-release-guide.md](docs/build-and-release-guide.md)。

## 技术栈

- 桌面壳：`Tauri v2`
- 前端：`React 19`、`TypeScript`、`Vite`
- 样式：`Tailwind CSS`
- 后端：`Rust`
- 数据库：`rusqlite` 驱动的 `SQLite`
- PDF 引擎：`pdfium-render` + `pdfjs-dist`
- 元数据来源：`arXiv`、`Crossref`、`OpenAlex`

## 当前状态

这个项目已经有比较清晰的本地研究工作流雏形，但还没有到稳定可托付主数据的阶段。更准确的描述是：

- 适合开发、试用和快速迭代
- 还不适合作为唯一的正式文献管理器

路线图和产品差距分析见 [docs/zotero-gap-analysis.md](docs/zotero-gap-analysis.md)。
