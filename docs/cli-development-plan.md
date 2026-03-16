# Lume CLI 现状与后续规划

## 一、当前实现状态

Lume 的 CLI 已不再停留在早期的 `--list-papers` 单 flag 阶段。当前代码基于 [`src-tauri/src/cli.rs`](../src-tauri/src/cli.rs)、[`src-tauri/src/cli_ipc.rs`](../src-tauri/src/cli_ipc.rs) 与 [`src-tauri/src/bin/lume-cli.rs`](../src-tauri/src/bin/lume-cli.rs)，已经具备：

1. **结构化 `clap` 子命令体系**
   - `list`
   - `search`
   - `import`
   - `export`
   - `info`
   - `status`
   - `sync`
   - `open`
   - `completions`
2. **嵌入式主程序 CLI**
   - 打包后的 `Lume` / `Lume.exe` 可直接执行 CLI 子命令。
3. **独立辅助二进制**
   - 开发环境可通过 `lume-cli` 运行相同 CLI 逻辑。
4. **单实例 + IPC 联动**
   - 运行中的 GUI 会启动本地 IPC 服务。
   - `open` 在 GUI 已运行时会转发给主实例处理。
   - `import` / `sync` 在 GUI 已运行时也会转发给主实例执行，避免 CLI 与 GUI 抢占数据库或文件系统。
5. **启动时 open 请求回放**
   - 当 GUI 未运行时，`Lume open <target>` 会启动 GUI，并在前端就绪后自动消费待处理的打开请求。
6. **旧命令兼容层**
   - 仍兼容历史公开过的 `--list-papers` 与 `--list-papers --json`，内部会归一化为 `list` / `list --json`。

## 二、当前 CLI 行为约定

### 1. 命令路由策略

- **只读命令**：`list` / `search` / `export` / `info` / `status` / `completions`
  - 默认直接在终端里本地执行。
- **写命令**：`import` / `sync`
  - 若 GUI 已运行，则通过 IPC 交给主实例执行，并把结果回传给 CLI。
  - 若 GUI 未运行，则允许 headless 本地执行。
- **UI 命令**：`open`
  - 若 GUI 已运行，则转发给主实例，并聚焦主窗口。
  - 若 GUI 未运行，则启动 GUI 并在前端 ready 后打开目标。

### 2. `open` 目标解析

`lume open <target>` 的 v1 行为：

1. 先按**精确 item id** 查找库内条目。
2. 若未命中，则把 `<target>` 当作**明确 PDF 路径**处理。
3. 对于库外 PDF，只会在 GUI 中临时打开，不会自动导入。

## 三、已完成阶段

### Phase 1: 基础设施重构

- 已完成 `clap` 化参数解析。
- 已完成子命令分发。
- 已完成自动补全脚本生成。

### Phase 2: 进程通信与守护机制

- 已接入单实例插件。
- 已建立 CLI -> GUI 的本地 IPC 请求-响应通道。
- 已打通 `open` / `import` / `sync` 的 GUI 联动。

## 四、后续 Roadmap

当前尚未完成的部分主要集中在终端体验和更深一层的业务扩展：

### Phase 3: 继续扩充 CLI 业务能力

- 增加更多筛选与批量操作能力。
- 视需求补充更细粒度的导入/导出控制。
- 若后续需要，可把更多写操作统一收敛到 GUI 主实例中。

### Phase 4: 终端展示层优化

- 更好的表格排版与色彩输出。
- 交互式 CLI / TUI 预留。
- 更完整的 Shell 补全与文档示例。
