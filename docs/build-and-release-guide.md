# Lume 编译、打包与发布指南

本文档基于当前仓库的实际配置更新，目标是说明：

- 当前项目的构建技术栈
- 本地开发与本地打包方式
- macOS / Windows / Linux 的平台差异
- 当前 GitHub Actions 发布流的真实行为

## 一、当前项目技术栈

Lume 当前不是单一技术栈应用，而是一个桌面壳 + 前端 + Rust 后端 + 混合 PDF 运行时的组合：

- 桌面框架：`Tauri v2`
- 前端：`React 19` + `TypeScript` + `Vite 7`
- 样式：`Tailwind CSS 3`
- 后端：`Rust`
- 数据库：`SQLite`，通过 `rusqlite` 的 `bundled` 特性静态集成 SQLite
- PDF 运行时：
  - Rust 侧使用 `pdfium-render`
  - 前端侧使用 `pdfjs-dist`
- 原生 CLI：`clap`

当前相关配置文件：

- [package.json](../package.json)
- [src-tauri/Cargo.toml](../src-tauri/Cargo.toml)
- [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json)

## 二、当前构建产物模型

Lume 当前会生成两类可执行入口：

1. Tauri 桌面应用主程序
2. 独立原生 CLI 二进制 `lume-cli`

需要特别注意的是，桌面应用和 CLI 都依赖当前项目的 PDF / 数据层实现，但打包发布时真正对最终用户分发的主入口仍然是桌面应用 bundle。

当前仓库中与 CLI 相关的实现位置：

- [src-tauri/src/cli.rs](../src-tauri/src/cli.rs)
- [src-tauri/src/bin/lume-cli.rs](../src-tauri/src/bin/lume-cli.rs)

CLI 推荐使用的当前语法是子命令风格，例如：

```bash
Lume list
Lume search "transformer"
Lume export --format bibtex -o refs.bib
Lume open /absolute/path/to/paper.pdf
```

仓库里仍保留了 `--list-papers` 这类旧参数兼容层，主要用于现有 workflow 冒烟测试，但文档和日常使用应优先采用新的子命令形式。

## 三、版本号与发布前检查

当前 release workflow 用 `package.json` 中的版本号生成：

- Git tag：`v<version>`
- Release 标题：`Lume v<version>`

但仓库中还有至少两个地方也维护版本号：

- [package.json](../package.json)
- [src-tauri/Cargo.toml](../src-tauri/Cargo.toml)
- [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json)

发布前建议先确认这三个文件中的版本一致，否则最终产物、窗口 About 信息、Cargo 元数据和 GitHub Release 名称可能出现不一致。

## 四、本地开发环境准备

### 通用依赖

建议准备以下环境：

- Node.js 20.x
- npm
- Rust stable toolchain
- 平台对应的 Tauri 构建依赖

安装前端依赖：

```bash
npm install
```

### 本地开发模式

```bash
npm run tauri dev
```

这会：

- 启动 Vite 开发服务器
- 启动 Tauri 开发壳
- 使用 [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json) 中定义的 `beforeDevCommand`

### 本地前端构建

```bash
npm run build
```

该命令会先执行 `tsc`，再执行 `vite build`。

### 本地测试

```bash
npm test
```

当前前端测试基于 `Vitest`。

## 五、PDF 运行时与平台动态库

Lume 当前在 Rust 侧依赖 PDFium，因此构建桌面发布包时必须为目标平台准备对应动态库：

- macOS: `libpdfium.dylib`
- Windows: `pdfium.dll`
- Linux: `libpdfium.so`

平台资源注入由以下配置负责：

- [src-tauri/tauri.macos.conf.json](../src-tauri/tauri.macos.conf.json)
- [src-tauri/tauri.windows.conf.json](../src-tauri/tauri.windows.conf.json)
- [src-tauri/tauri.linux.conf.json](../src-tauri/tauri.linux.conf.json)

当前仓库只直接带了 macOS 的 `src-tauri/libpdfium.dylib`。Windows 和 Linux 构建前通常需要手动下载对应 PDFium 动态库并放到 `src-tauri/`。

## 六、本地打包通用命令

最基础的桌面打包命令：

```bash
npm run tauri build
```

该命令会先执行：

```bash
npm run build
```

然后再执行 Tauri bundling。

如果你要传递 Tauri 额外参数，写法如下：

```bash
npm run tauri build -- --ci
```

## 七、macOS 构建

### 前置条件

- macOS 主机
- Node.js 20
- Rust stable
- 若目标为 Apple Silicon，建议安装 `aarch64-apple-darwin` target
- `src-tauri/libpdfium.dylib` 已存在

仓库当前的 release workflow 构建的是 Apple Silicon 包：

```bash
rustup target add aarch64-apple-darwin
npm install
npm run tauri build -- --target aarch64-apple-darwin --ci
```

### 常见产物位置

- `.app`: `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/`
- `.dmg`: `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`

### 现状说明

- 当前 workflow 没有做 Apple 签名或 notarization
- 未签名应用在用户机器上可能触发 Gatekeeper 拦截

## 八、Windows 构建

### 前置条件

建议在真实 Windows 机器或 GitHub Actions `windows-latest` 环境中构建。

需要：

- Node.js 20
- Rust stable
- Visual Studio Build Tools
- NSIS
- `src-tauri/pdfium.dll`
- WebView2 Runtime

### 准备 PDFium

当前 workflow 使用的是 `pdfium-win-x64.tgz`，并将其中的 `pdfium.dll` 放到：

```bash
src-tauri/pdfium.dll
```

### 构建绿色版

```bash
npm install
npm run tauri build -- --no-bundle --ci
```

常见主程序位置：

- `src-tauri/target/release/Lume.exe`

当前项目的便携版目录至少应包含：

- `Lume.exe`
- `pdfium.dll`

也就是说，不能只分发单独一个 `Lume.exe`。

### 构建 NSIS 安装版

```bash
npm install
npm run tauri build -- --bundles nsis --ci
```

常见输出目录：

- `src-tauri/target/release/bundle/nsis/`

### 当前 release workflow 的 Windows 行为

当前 [.github/workflows/release.yml](../.github/workflows/release.yml) 会：

1. 构建 `--no-bundle` 绿色版
2. 手工将 `Lume.exe` 与 `pdfium.dll` 组装到 `dist-portable/Lume/`
3. 运行一次 CLI 冒烟测试
4. 再构建 NSIS 安装器
5. 静默安装后再运行一次 CLI 冒烟测试

上传的 artifact 名称：

- `Lume-windows-portable`
- `Lume-windows-installer`

## 九、Linux 构建

### 前置条件

当前 workflow 使用 `ubuntu-24.04`，并构建 `.deb`。

需要安装的构建依赖与 workflow 保持一致：

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  build-essential \
  pkg-config \
  curl
```

### 准备 PDFium

当前 workflow 的做法：

```bash
curl -L -o pdfium.tgz https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-x64.tgz
tar -xzf pdfium.tgz lib/libpdfium.so
mv lib/libpdfium.so src-tauri/libpdfium.so
```

### 构建 `.deb`

```bash
npm install
npm run tauri build -- --bundles deb --ci
```

常见输出目录：

- `src-tauri/target/release/bundle/deb/`

### 运行时依赖

当前 Linux 打包配置声明在：

- [src-tauri/tauri.linux.conf.json](../src-tauri/tauri.linux.conf.json)

其中 `.deb` 运行时依赖包括：

- `libwebkit2gtk-4.1-0`
- `libjavascriptcoregtk-4.1-0`
- `libgtk-3-0`
- `libayatana-appindicator3-1`
- `librsvg2-2`

### 当前 release workflow 的 Linux 行为

Linux job 会：

1. 构建 `.deb`
2. 用 `dpkg -i` 安装该包
3. 找到安装出来的 CLI / 主程序入口
4. 执行一次 CLI 冒烟测试

上传的 artifact 名称：

- `Lume-linux-deb`

## 十、独立 CLI 构建与验证

除了 Tauri 主程序，当前仓库还提供独立 CLI binary：

开发态快速验证：

```bash
npm run cli:list
```

直接使用 Cargo：

```bash
cargo run --manifest-path src-tauri/Cargo.toml --bin lume-cli -- list
```

发布态二进制通常位于：

- macOS / Linux: `src-tauri/target/release/lume-cli`
- Windows: `src-tauri/target/release/lume-cli.exe`

如果你需要纯终端使用而不依赖桌面窗口，这个入口比直接调用 GUI 主程序更明确。

## 十一、当前 GitHub Actions 发布流

当前发布工作流文件：

- [.github/workflows/release.yml](../.github/workflows/release.yml)

### 触发方式

当前只支持：

- `workflow_dispatch`

也就是说，它不会在 push、tag 或 release event 上自动运行。

### 当前会构建的产物

- macOS Apple Silicon `.dmg` 与 `.app`
- Windows 绿色版目录
- Windows NSIS 安装器
- Linux `.deb`

### 上传到 Actions 的 artifact

- `Lume-macos-aarch64`
- `Lume-windows-portable`
- `Lume-windows-installer`
- `Lume-linux-deb`

### Draft Release 行为

工作流最后会：

1. 读取 `package.json` 的版本号
2. 生成 `v<version>` 形式的 tag
3. 创建或更新对应的 GitHub Draft Release
4. 上传以下资源：

- macOS `.dmg`
- Windows 安装器 `.exe`
- Windows 绿色版 `.zip`
- Linux `.deb`

### 失败条件

只要以下任一环节失败，后续草稿发布就不会继续：

- 平台构建失败
- PDFium 注入失败
- Windows 绿色版 CLI 冒烟测试失败
- Windows 安装版 CLI 冒烟测试失败
- Linux `.deb` 安装后 CLI 冒烟测试失败

## 十二、推荐发布检查清单

正式发布前建议至少执行以下检查：

1. 确认 `package.json`、`Cargo.toml`、`tauri.conf.json` 版本一致。
2. 本地执行 `npm install`。
3. 本地执行 `npm test`。
4. 本地执行 `npm run build`。
5. 检查目标平台的 PDFium 动态库已放在 `src-tauri/`。
6. 至少在一个目标平台本地执行一次 `npm run tauri build`。
7. 如果使用 GitHub Actions 发布，手动触发 `Build Lume Desktop` workflow。

## 十三、当前尚未覆盖的发布能力

这份仓库当前还没有完整自动化的部分包括：

- macOS 签名与 notarization
- Windows 代码签名
- 版本变更自动同步到多个配置文件
- 基于 tag push 的正式自动发布
- 多架构 macOS 通用包
- `.rpm` / AppImage / Snap 等 Linux 发行格式

如果后续这些能力补齐，这份文档也应该一起更新，而不是继续沿用旧描述。
