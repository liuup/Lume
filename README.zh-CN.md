# Lume

[English](README.md) | [中文](README.zh-CN.md)

> [!WARNING]
> Lume 目前仍处于原型阶段，存在较多 bug、未完成功能和体验问题。暂时不建议将它用于重要数据管理或正式研究工作流。

Lume 是一个面向学术阅读与知识整理的桌面文献工具。它将 PDF 阅读、批注、元数据管理、标签、笔记与引用导出整合在一个轻量的本地应用中。

基于 Tauri + React + TypeScript + PDFium 构建，Lume 的目标不是做一个“能打开 PDF 的工具”，而是做一个真正顺手的研究工作台。

---

## 为什么是 Lume

- **本地优先**：文献、批注、笔记都在本地掌控
- **阅读与整理一体化**：不是“看完就散”，而是直接沉淀到笔记与引用流
- **轻量桌面体验**：启动快、界面干净、跨平台
- **面向研究场景**：标签、元数据、注释、导出都围绕论文工作流设计

---

## 当前已具备的核心能力

### 文献管理
- 本地论文库目录管理
- 文件夹 / 子文件夹组织
- PDF 导入、删除、重命名、移动
- 全局检索与字段过滤
- 标签系统与颜色管理

### PDF 阅读
- 多标签阅读
- 页面渲染与懒加载
- 放大 / 缩小 / 适应宽度 / 适应高度
- 文本层加载与文本选择
- PDF 内关键词搜索（Ctrl+F）

### 批注与知识整理
- 手写绘制、荧光笔、文本批注
- 批注本地持久化
- 论文级 Markdown 笔记
- 从 DOI / arXiv 补全元数据
- 引用预览与多格式导出

---

## 适合谁

Lume 目前特别适合：

- 需要高频阅读 PDF 论文的学生 / 研究者
- 希望把“阅读 + 批注 + 笔记 + 引用”放在一个工具里的用户
- 喜欢本地优先、可控、轻量工作流的 Zotero / PDF Expert / Skim 用户

---

## 开发状态

Lume 正在快速迭代中，当前重点方向包括：

- 批注管理视图
- 拖入 PDF 自动识别元数据
- BibTeX / RIS 导入
- 阅读器快捷键与更完整的人性化细节

完整产品差距分析与路线图见 [docs/zotero-gap-analysis.md](docs/zotero-gap-analysis.md)。

---

## 快速开始

### 本地开发

```bash
npm install
npm run tauri dev
```

### CLI

Lume 现在提供了原生 CLI，既可以通过主程序二进制使用，也可以在开发环境中通过独立的 `lume-cli` 辅助二进制使用。

列出当前文库中的条目：

```bash
Lume list
Lume list --json
```

搜索、导出或唤起 GUI：

```bash
Lume search "transformer" --json
Lume export --format bibtex -o refs.bib
Lume open /absolute/path/to/paper.pdf
```

开发时可直接运行：

```bash
npm run cli:list
```

### 构建应用

```bash
npm run tauri build
```

详细的本地编译、打包、平台差异说明，以及 GitHub Actions 手动构建方式，已迁移到单独文档：

- [docs/build-and-release-guide.md](docs/build-and-release-guide.md)

---

## 发布产物

当前仓库已支持手动执行 GitHub Actions 构建：

- **macOS**：产出 `.app` / `.dmg`
- **Windows 绿色版**：产出可直接运行的 `Lume.exe + pdfium.dll`
- **Windows 安装版**：产出 NSIS 安装器 `.exe`

如需本地手工打包或修改 CI 流程，请查看 [docs/build-and-release-guide.md](docs/build-and-release-guide.md)。

---

## 技术栈

- **Desktop Shell**: Tauri v2
- **Frontend**: React + TypeScript + Vite
- **Styling**: Tailwind CSS
- **Backend**: Rust
- **PDF Engine**: PDFium
- **Storage**: SQLite + 本地 sidecar 批注文件

---

## 愿景

Lume 想解决的问题不是“再做一个 PDF 阅读器”，而是：

> 如何让研究者从“打开论文”到“整理知识”之间的链路尽可能短、轻、自然。

如果你正在关注文献管理、学术阅读工作流或 Zotero 替代方案，欢迎关注这个项目。
