# Lume CLI 原生支持开发计划与功能分析

## 一、 当前 CLI 支持现状分析

目前 Lume 的代码库中已经有了初步的 CLI 实现基础（主要位于 `src-tauri/src/cli.rs` 和 `src-tauri/src/bin/lume-cli.rs`），具体现状如下：
1. **基础命令支持**：目前仅支持 `--list-papers` 及其附加选项 `--json`，用于从数据库打印文献列表。
2. **纯后台执行能力**：`main.rs` 中通过 `try_run_embedded_from_env` 拦截了特定的 CLI 指令，允许程序在不启动 Tauri GUI 的情况下作为纯命令行工具运行。
3. **参数解析机制**：当前使用 Rust 标准库 `std::env::args().skip(1)` 手动处理参数，没有依赖专业的命令行解析库。
4. **并发与通信**：目前 CLI 运行时会直接初始化并连接独立的 SQLite 数据库连接，与正在运行的 GUI 实例彼此隔离。

---

## 二、 目前缺失的核心功能 (Gap Analysis)

要达到“原生级别”、“生产可用”的 CLI 支持，目前还存在以下明显的短板和缺失：

### 1. 现代化的命令行参数解析
手动处理 `args()` 难以适应复杂的子命令（Subcommands）、可选参数、标志（Flags）以及自动生成高质量的 `--help` 文档。需要引入成熟的解析方案。

### 2. 进程间通信 (IPC) 与单实例控制 (Single Instance)
这是当前**最致命**的缺失。
如果用户已经打开了 Lume（GUI 实例），此时在终端运行诸如 `lume update` 或 `lume open <file>`：
- **当前行为**：CLI 进程可能会直接跟原本已锁定的数据库抢占资源，或因状态不同步导致数据风险；不仅无法通知已打开的 GUI，还可能导致不可预知的崩溃。
- **期望行为**：CLI 进程检测到 GUI 已运行，应通过 Socket/Named Pipe 等 IPC 方式将指令发送给主 GUI 进程代为执行（例如唤起主窗口并打开某篇论文）。

### 3. Tauri 生态的深度集成
目前是作为一个纯后端的 Bin/拦截器 存在。如果需要通过 CLI 直接唤起前端特定路由，或修改前端状态，现有的分离架构将难以实现。

### 4. 核心业务维度的 CLI 子命令
目前只有枚举文献（`list-papers`），大量极具生产力的 CLI 行为尚未构建（例如：快速导入、搜索、导出）。

---

## 三、 开发计划与 Roadmap

为了打造极致的 CLI 体验，建议按照以下四个阶段逐步推进：

### Phase 1: 基础设施重构 (Infrastructure Refactoring)
**目标**：构建稳健的、可扩展的 CLI 参数解析底座。
- **引入 `clap` 库**：重写 `cli.rs`，使用 `clap` 的 Derive API 定义结构化的 CLI 参数和子命令。
- **搭建子命令路由框架**：将不同的 CLI 行为分发到独立的 handler 中。
- **日志与错误格式化**：引入 `tracing` 等库代替 `println!`，针对终端环境给出更加友好的报错信息。

### Phase 2: 进程通信与守护机制 (IPC & Daemon Mode)
**目标**：解决多开冲突与状态同步问题，实现 CLI 与 GUI 联动。
- **配置单实例锁 (Single Instance Lock)**：结合 Tauri 官方的 `single-instance` 机制，确保同时只有一个核心逻辑在跑。
- **建立 CLI -> GUI 通信管道**：当 Lume 主界面已打开时，任何在终端运行的 `lume <命令>` 都作为客户端，将参数打包发送给后台常驻的服务端处理。
- **Headless 模式支持**：当没有 GUI 进程时，允许某些不需要 UI 的命令（如后台同步、导入）自行启动 DB 执行完毕后立刻退出。

### Phase 3: 核心子命令开发 (Feature Implementation)
**目标**：实装用户平时在终端里最高频使用的功能。计划开发的子命令：
1. `lume open <ID/Path>`
   - **功能**：通过 CLI 快速唤起主界面，并在应用内定位/打开指定的 PDF 或者条目。
2. `lume import <Path> [--tag <tags>]`
   - **功能**：将终端当前目录的 PDF 或文件夹扫描并顺畅地静默导入到库中。
3. `lume search <Query> [--json]`
   - **功能**：提供终端内的超快全局搜索，通过 `--json` 提供给其他终端工具（如 `jq`, `fzf`）进行管道串联。
4. `lume export <BibTeX/JSON> [--out <Path>]`
   - **功能**：将数据库里的特定 Collection 或全部文献格式化导出。
5. `lume status` / `lume sync`
   - **功能**：展示当前文库统计信息（文献量、数据库大小），或强制触发后台文件树同步。

### Phase 4: 终端展示层优化 (Terminal UX Polish)
**目标**：提供类似现代 CLI 端工具（如 `gh`, `bat`）的使用体验。
- **表格与色彩**：引入类似 `comfy-table` 排版终端输出，高亮搜索匹配的关键字。
- **交互式 CLI (TUI 预留)**：利用类似 `inquire` 的库，当用户少输参数时，提供命令行的上下键交互式问答（例如 `lume import` 后让用户在终端选择归档的集合）。
- **Shell 自动补全**：利用 `clap_complete` 为 Zsh/Bash/Fish 生成命令参数的 Tab 自动补全脚本。
