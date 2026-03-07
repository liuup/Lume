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

- **应用程序:** `src-tauri/target/release/bundle/macos/tauri-app.app`
  可以直接拖拽到 "应用程序 (Applications)" 文件夹中。
- **DMG 安装包:** `src-tauri/target/release/bundle/dmg/tauri-app_0.1.0_aarch64.dmg`
  用于分享和分发给其他用户。

**注意：** 苹果系统原生开启了 Gatekeeper 防止未签名的软件运行。首次打开打包后的应用如果提示“无法验证开发者”，请**进入系统设置 -> 隐私与安全性**，往下滑找到对应的拦截项，点击 **“仍要打开”**。
