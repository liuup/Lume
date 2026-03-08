# Lume: PDF Reader (Tauri + React + TypeScript)

This is a high-performance cross-platform PDF Reader application built with Tauri, React, and PDFium.

---

## 🛠 macOS 端编译与打包指南

因为本应用依赖底层的 C++ 动态链接库 `libpdfium.dylib` 来进行高性能的 PDF 页面渲染，所以在打包为独立的 Mac 应用程序（`.app` 或 `.dmg`）时，需要做一些特殊适配，否则会导致应用打包后在独立打开时崩溃或白屏。以下是详细指南：

### 1. 准备环境

- 安装 **Node.js** 和 npm。
- 安装 **Rust** 工具链（`rustup` / `cargo`）。
- 确保根目录下运行过 `npm install`。

### 2. PDFium 动态链接库配置

你需要预先下载与你 macOS 架构（M1/M2 `aarch64` 或 Intel `x86_64`）匹配的 `libpdfium.dylib`，并放置于 `src-tauri` 根目录下。

在 `src-tauri/tauri.conf.json` 中，通过添加 `resources` 字段显式地向安装包（`.app`）内部注入该 `.dylib`，这样最终打包时，应用内会自带此驱动库：

```json
"bundle": {
  "active": true,
  "resources": ["libpdfium.dylib"],
  "targets": "all"
}
```

而在 Rust 后端（`src-tauri/src/lib.rs`）中，我们在 `tauri::Builder::default().setup(...)` 阶段使用了应用提供的上下文（Resource path），动态去定位并加载该 `libpdfium.dylib`：

```rust
let resource_dir = app.path().resource_dir().unwrap_or_else(|_| std::path::PathBuf::from("./"));
let lib_path = resource_dir.join("libpdfium.dylib");
```

### 3. 生成可执行文件及打包

要编译并打包正式的 Release 版本，请在项目主目录下运行以下命令：

```bash
npm run tauri build
```

如果你只想在开发模式下运行并热更新调试，可以执行：

```bash
npm run dev
# 或
npm run tauri dev
```

### 4. 获取编译产物

打包完成后，`tauri build` 命令会输出所有 Mac 端需要的分发文件：

- **应用程序:** `src-tauri/target/release/bundle/macos/Lume.app`
  可以直接拖拽到 "应用程序 (Applications)" 文件夹中。
- **DMG 安装包:** `src-tauri/target/release/bundle/dmg/Lume_0.1.0_aarch64.dmg`
  用于分享和分发给其他用户。

**注意：** 苹果系统原生开启了 Gatekeeper 防止未签名的软件运行。首次打开打包后的应用如果提示“无法验证开发者”，请**进入系统设置 -> 隐私与安全性**，往下滑找到对应的拦截项，点击 **“仍要打开”**。

---

## 🛠 Windows 端编译与打包指南 (.exe)

如果你希望在 Windows 上编译出 `Lume.exe` 及对应的安装程序，请遵循下面的环境配置与打包说明。与 macOS 类似，Windows 端必须搭载对应的 `pdfium.dll` 动态库。由于跨平台的限制，**强烈推荐在真实的 Windows 实体机或 Windows 虚拟机中完成后续操作。**

### 1. 准备 Windows 开发环境

在 Windows 电脑中，你需要准备以下系统级的底层编译依赖：

- **Visual Studio C++ 生成工具**: 前往微软官网下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，在安装时务必勾选 **“使用 C++ 的桌面开发” (Desktop development with C++)** 以及它默认带的 Windows SDK。
- **Rust 工具链**: 访问 [rustup.rs](https://rustup.rs) 下载并安装 `rustup`（会自动配置 Cargo 环境）。
- **Node.js**: 去 Node.js 官网下载最新的 LTS 版本并安装。
- **WebView2 运行时**: 通常 Windows 10/11 版本已经原生内置了 Edge WebView2；如果系统属于极其精简版，你需要去微软官网手动下载 WebView2 Runtime 安装包。
- 确保上述安装完毕后，打开 CMD / PowerShell 进入源码根目录，执行一次依赖下载。
  ```bash
  npm install
  ```

### 2. 准备 PDFium的 Windows 动态链接库

必须向应用中内置 Windows 可执行的 PDF 解析库资源，否则应用前端只能显示白屏：
1. 寻找并下载适用于你当前 Windows 硬件架构 (通常寻找 `pdfium-windows-x64` 发布版) 的 PDFium 二进制包。
2. 解压它，提取出其中的核心驱动文件：**`pdfium.dll`**。
3. 将这枚 **`pdfium.dll`** 文件复制进项目的 `src-tauri` 下的根目录（和之前的 `libpdfium.dylib` 放在相同的并排位置）。

### 3. 配置跨平台资源加载路径

为了让 Tauri 应用在不同系统打包时都能聪明地识别各自平台的库文件，我们需要调整两处代码：

**① 修改 `src-tauri/tauri.conf.json`**  
找到 `"bundle": { "resources": [...] }` 资源注入阵列，把新加的 `.dll` 补充进来，告知 Tauri 无论何种平台统一将这两种内核全部打包进去：
```json
"bundle": {
  "active": true,
  "resources": [
    "libpdfium.dylib",
    "pdfium.dll"
  ],
  "targets": "all"
}
```

**② 修改 `src-tauri/src/lib.rs` 的引擎定位逻辑**  
在 `tauri::Builder::default().setup()` 方法中，你需要加入 Rust 条件编译宏 `#[cfg(target_os)]`，使它根据跑在哪个操作系统来加载正确的后缀名库：

```rust
let resource_dir = app.path().resource_dir().unwrap_or_else(|_| std::path::PathBuf::from("./"));

// 针对 Windows 挂载 DLL
#[cfg(target_os = "windows")]
let lib_path = resource_dir.join("pdfium.dll");

// 针对 macOS 挂载 Dylib
#[cfg(target_os = "macos")]
let lib_path = resource_dir.join("libpdfium.dylib");

// 甚至针对Linux挂载 SO
#[cfg(target_os = "linux")]
let lib_path = resource_dir.join("libpdfium.so");
```

### 4. 编译与打包 EXE 可执行文件

当你确认环境、代码均已准备好，并在终端处在项目所在的基础目录 `/Lume` 下时，直接运行：

```bash
npm run tauri build
```
*(在 Windows 首次运行该命令时，各种 crates 和 C++ 编译器耗时较长，请耐心等待无报错即可)*

### 5. 获取编译产物

构建操作成功通过后，所有的 exe 与分发版安装包均放置于 `src-tauri/target/release/bundle` 目录下：

- **单文件免安装执行程序:** 位处 `src-tauri/target/release/Lume.exe` — 这个文件可以直接双击独立运行查看效果。
- **MSI 标准安装包:** 位置是在 `.../bundle/msi/Lume_0.1.0_x64_en-US.msi` — 适合将其分发和发送给任何人。
- **NSIS 高级安装向导版**（可选，需在 Tauri config 自定义启用）：位置位于 `.../bundle/nsis/Lume_0.1.0_x64-setup.exe`。

此时，你可以通过微信或直接在分发平台上传 `Lume.msi` 安装包啦！因为你已经在配置中内置并引用了 dll 资源，所以无需担心其他用户的电脑里缺失组件等情况。
