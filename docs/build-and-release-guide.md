# Lume 编译、打包与发布指南

本文档说明如何在本地或 GitHub Actions 中构建 Lume 的 macOS、Windows 与 Linux 发布产物。

---

## 一、项目基础信息

Lume 基于以下技术栈构建：

- Tauri v2
- React + TypeScript + Vite
- Rust
- PDFium

由于 PDF 渲染依赖平台动态库，因此打包时必须同时处理：

- macOS: `libpdfium.dylib`
- Windows: `pdfium.dll`
- Linux: `libpdfium.so`

---

## 二、本地开发环境准备

### 通用依赖

在开始前，请先安装：

- Node.js 20+
- Rust 工具链（`rustup` / `cargo`）
- 项目依赖

在仓库根目录执行：

```bash
npm install
```

### 开发模式运行

```bash
npm run tauri dev
```

### 本地构建 Release

```bash
npm run tauri build
```

---

## 三、macOS 构建说明

### 1. 准备 PDFium 动态库

需要下载与目标架构匹配的 `libpdfium.dylib`，并放到 `src-tauri/` 目录下。

当前项目通过平台专用配置文件注入该资源：

- [src-tauri/tauri.macos.conf.json](../src-tauri/tauri.macos.conf.json)

### 2. 本地打包命令

如果你在 macOS 本机上构建：

```bash
npm run tauri build
```

如果你要指定 Apple Silicon 目标：

```bash
npm run tauri build -- --target aarch64-apple-darwin
```

### 3. 产物位置

常见输出目录：

- `.app`: `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/`
- `.dmg`: `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`

### 4. 注意事项

- 未签名应用首次打开时，macOS 可能拦截
- 可在“系统设置 → 隐私与安全性”中手动允许打开

---

## 四、Windows 构建说明

### 1. 准备 Windows 环境

建议在真实 Windows 机器或 Windows 虚拟机中构建。

需要安装：

- Visual Studio Build Tools（包含“使用 C++ 的桌面开发”）
- Rust 工具链
- Node.js
- WebView2 Runtime（多数 Windows 10/11 已内置）

### 2. 准备 PDFium 动态库

下载 Windows x64 版本 PDFium，提取 `pdfium.dll`，放到 `src-tauri/` 目录下。

当前项目通过平台专用配置文件注入该资源：

- [src-tauri/tauri.windows.conf.json](../src-tauri/tauri.windows.conf.json)

### 3. 构建“免安装可运行版”

执行：

```bash
npm run tauri build -- --no-bundle --ci
```

构建出的主程序通常位于：

- `src-tauri/target/release/Lume.exe`

注意：

- 绿色版不能只拷贝 `Lume.exe`
- 需要把 `pdfium.dll` 和 `Lume.exe` 放在同一目录下

也就是说，真正可分发的绿色版目录应至少包含：

- `Lume.exe`
- `pdfium.dll`

### 4. 构建“安装版 exe”

当前 workflow 使用 NSIS 安装器。

本地可执行：

```bash
npm run tauri build -- --bundles nsis --ci
```

常见输出目录：

- `src-tauri/target/release/bundle/nsis/`

安装完成后，主程序本体仍然是 `Lume.exe`，因此安装版默认也支持：

```powershell
Lume.exe list
Lume.exe list --json
```

### 5. 重要说明

当前项目中的 PDFium 加载逻辑已兼容以下位置：

- Tauri 打包后的 `resource_dir`
- 当前可执行文件所在目录
- 项目开发目录

对应代码位于：

- [src-tauri/src/lib.rs](../src-tauri/src/lib.rs)

这意味着：

- **安装版** 可从 bundle 资源中找到 `pdfium.dll`
- **绿色版** 可从 `Lume.exe` 同目录找到 `pdfium.dll`
- **安装版 / 绿色版** 都复用同一个 `Lume.exe`，因此都内置原生子命令式 CLI（如 `list` / `search` / `open`）

---

## 五、Linux `.deb` 构建说明

### 1. 准备 Linux 环境

建议在 Ubuntu 24.04 或兼容的 Debian / Ubuntu 环境中构建。

需要安装：

- Rust 工具链
- Node.js
- GTK / WebKitGTK 构建依赖

常用依赖安装命令：

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

### 2. 准备 PDFium 动态库

下载 Linux x64 版本 PDFium，提取 `libpdfium.so`，放到 `src-tauri/` 目录下。

当前项目通过平台专用配置文件注入该资源：

- [src-tauri/tauri.linux.conf.json](../src-tauri/tauri.linux.conf.json)

示例命令：

```bash
curl -L -o pdfium.tgz https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-x64.tgz
tar -xzf pdfium.tgz lib/libpdfium.so
mv lib/libpdfium.so src-tauri/libpdfium.so
```

### 3. 构建 `.deb`

执行：

```bash
npm run tauri build -- --bundles deb --ci
```

常见输出目录：

- `src-tauri/target/release/bundle/deb/`

### 4. 安装与验证

安装：

```bash
sudo dpkg -i src-tauri/target/release/bundle/deb/*.deb
```

安装后可直接验证 CLI：

```bash
Lume list
Lume list --json
```

### 5. 重要说明

- `.deb` 包会携带 `libpdfium.so`
- Linux 包同样复用主程序二进制，因此默认支持原生子命令式 CLI
- 当前配置为 Debian 包声明了常见运行时依赖，减少安装后缺库概率

---

## 六、GitHub Actions 构建说明

当前仓库的发布工作流为：

- [.github/workflows/release.yml](../.github/workflows/release.yml)

### 当前特性

该 workflow：

- **不会自动触发**
- 仅支持 **手动执行**（`workflow_dispatch`）
- 同时构建：
  - macOS 包
  - Windows 绿色版
  - Windows 安装版
  - Linux `.deb`
- 在上传 Windows / Linux artifact 之前，会自动验证 CLI 是否可用
- 构建完成后会自动创建或更新一个 **Draft Release**

### 产物说明

手动运行后，Actions 中会出现以下 artifact：

- `Lume-macos-aarch64`
- `Lume-windows-portable`
- `Lume-windows-installer`
- `Lume-linux-deb`

其中：

- `Lume-windows-portable` 为免安装运行版
- `Lume-windows-installer` 为安装器版
- `Lume-linux-deb` 为 Debian / Ubuntu 安装包

Windows job 当前还包含两步 CLI 冒烟验证：

- 直接运行绿色版中的 `Lume.exe list`
- 静默安装 NSIS 包后，再运行安装目录里的 `Lume.exe list`

Linux job 当前还包含一步 CLI 冒烟验证：

- 安装 `.deb` 后直接运行包内安装出的 `Lume list`

如果这些检查中的任意一步失败，artifact 不会上传，草稿发布也不会继续更新。

此外，workflow 还会基于 `package.json` 中的版本号自动创建或更新一个草稿发布：

- Tag 形式：`v<version>`
- Release 标题：`Lume v<version>`

草稿发布会附带以下资源：

- macOS `.dmg`
- Windows 安装版 `.exe`
- Windows 绿色版 `.zip`
- Linux `.deb`

---

## 七、关于“免安装可运行 exe”的边界

这里的“免安装”指：

- 用户不需要先运行安装向导
- 直接解压后双击 `Lume.exe` 即可运行

但仍有系统前提：

- Windows 机器需要具备 WebView2 Runtime

这属于 Tauri/Windows 运行前提，不是 Lume 独有要求。

---

## 八、推荐发布方式

如果你准备开始公开宣传，建议同时提供两种 Windows 下载项：

### 1. 普通用户
- 推荐下载 **安装版 exe**
- 优点：安装体验更标准，适合大多数用户

### 2. 高级用户 / 便携使用场景
- 提供 **绿色版压缩包**
- 适合放在移动硬盘、同步盘或临时测试

### 3. macOS 用户
- 提供 `.dmg`
- 如无签名，说明首次打开的系统放行方法

### 4. Linux 用户
- 提供 `.deb`
- 明确说明当前优先支持 Debian / Ubuntu 系发行版

---

## 九、推荐宣传页下载文案

你可以在官网或发布页上直接使用类似文案：

- **macOS (Apple Silicon)** — DMG 安装包
- **Windows Installer** — 推荐大多数用户下载
- **Windows Portable** — 免安装绿色版，解压即用
- **Linux (.deb)** — Debian / Ubuntu 安装包

---

## 十、常见问题

### 1. 为什么 Windows 绿色版不能只有一个 exe？
因为 PDF 渲染依赖 `pdfium.dll`，它必须和 `Lume.exe` 一起分发。

### 2. 为什么用户电脑上可能仍然打不开？
最常见原因是缺少 WebView2 Runtime，或系统安全策略阻止未签名程序。

### 3. Linux `.deb` 安装后打不开怎么办？
最常见原因是系统缺少 WebKitGTK 相关运行库，或目标发行版不是 Debian / Ubuntu 兼容环境。建议优先在 Ubuntu 24.04 / 22.04 上验证。

### 3. 为什么 macOS 会提示无法验证开发者？
因为应用尚未完成 Apple Developer 签名与公证。

---

## 十、后续可继续完善的发布能力

后续可以继续补充：

- 版本号驱动的正式发布流
- macOS 签名 / notarization
- Windows 代码签名
- 自动生成发布说明
