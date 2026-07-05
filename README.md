# AnyForge

AnyForge 是一个迷你 macOS 工具，用本机 `ffmpeg` 把媒体文件转成 GIF 或 WebP。

## 使用

1. 打开应用。
2. 把 `ffmpeg` 支持的媒体文件拖进窗口，先看预览。
3. 选择尺寸，或直接修改宽高。
4. 点击右上角 `any to WEBP/GIF` 切换输出格式。
5. 设置 FPS、输出参数和保存文件夹，默认保存到桌面。
6. 点击“转换”生成文件。
7. 转换完成后点“定位”，在 Finder 里选中新生成的文件。

## 开发命令

- `pnpm install`：安装前端打包工具。
- `pnpm build`：生成 Tauri 使用的静态前端文件。
- `cargo test --manifest-path src-tauri/Cargo.toml`：运行 Rust 测试。
- `pnpm tauri build`：打包 macOS App 和 DMG。

打包后的 macOS App 和 DMG 会放在 git 忽略的 `release/` 目录。
