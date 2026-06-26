# Snap Translate OCR

Snap Translate OCR 是一款桌面截图 OCR 翻译工具。它基于 Electron、React 和 TypeScript 构建，可以框选屏幕区域、识别图片文字，并调用本地 Hy-MT2 1.8B GGUF 模型完成翻译。

适合用来快速翻译网页、论文、软件界面、图片里的文本，尤其适合希望 OCR 和翻译尽量在本机完成的场景。

## 功能特性

- 框选截图后自动 OCR 并翻译。
- 支持读取剪贴板图片并翻译。
- 支持手动输入文本进行翻译。
- OCR 结果可编辑，编辑后可以重新翻译。
- 支持复制 OCR 原文和翻译结果。
- macOS 使用 Apple Vision OCR。
- Windows 使用系统 OCR 能力。
- 翻译使用本地 Hy-MT2 1.8B GGUF 模型，通过 `llama-cli` 运行。
- 支持简体中文、繁体中文、英文、日文、韩文、法文、德文等语言方向。

## 系统要求

- macOS 或 Windows。
- Node.js 18 或更高版本。
- pnpm。
- `llama-cli`，用于运行本地 GGUF 翻译模型。

Linux 目前可以打包，但项目里的本地 OCR 流程只实现了 macOS 与 Windows。

## 安装使用

### 方式一：安装打包版

如果已经有打包产物，可以直接安装：

- macOS：打开 `dist/Snap Translate OCR-1.0.0.dmg`，将应用拖入 `Applications`。
- Windows：运行 `dist` 目录中的安装包。

首次使用截图功能时，系统可能会请求屏幕录制或截图权限。macOS 上如果替换过 `.app` 后权限异常，建议删除旧应用，重新放入 `/Applications` 后再打开。

### 方式二：从源码运行

安装依赖：

```bash
pnpm install
```

启动开发环境：

```bash
pnpm dev
```

应用打开后：

1. 选择原文语言和目标语言。
2. 点击“检测截图能力”确认当前截图模式。
3. 点击“框选截图并翻译”或“系统截图并翻译”。
4. 框选需要识别的区域，松开鼠标后开始 OCR 和翻译。
5. 在右侧查看截图预览、OCR 原文和翻译结果。

也可以先复制一张图片到剪贴板，然后点击“翻译剪贴板图片”。

## 模型安装与导入

本软件的 OCR 使用系统能力，翻译部分依赖 GGUF 模型和 `llama-cli`。简单理解：

- `llama-cli` 是运行模型的命令行程序。
- `.gguf` 文件是翻译模型本体。
- 应用负责把 OCR 文字交给 `llama-cli`，再把翻译结果显示出来。

### 1. 安装 `llama-cli`

macOS 如果使用 Homebrew，可以安装 llama.cpp：

```bash
brew install llama.cpp
```

安装完成后确认命令可用：

```bash
llama-cli --version
```

如果你的 `llama-cli` 不在系统 `PATH` 中，可以通过环境变量指定完整路径：

```bash
LLAMA_CLI_PATH=/path/to/llama-cli pnpm dev
```

Windows 用户需要安装 llama.cpp 的 Windows 版本，或自行编译得到 `llama-cli.exe`。如果命令不在 `PATH` 中，也可以设置 `LLAMA_CLI_PATH` 指向 `llama-cli.exe`。

### 2. 放置默认模型

项目默认会优先查找这个模型文件：

```text
models/Hy-MT2-1.8B-GGUF/Hy-MT2-1.8B-Q4_K_M.gguf
```

也就是说，如果用户下载了模型，可以按下面的目录结构放进去：

```text
snap-translate-ocr/
  models/
    Hy-MT2-1.8B-GGUF/
      Hy-MT2-1.8B-Q4_K_M.gguf
```

放好以后启动应用即可。当前仓库里已经有这个模型文件时，开发模式会直接使用它。

### 3. 使用其他模型路径

如果用户不想把模型放进项目目录，也可以把模型放在任意位置，然后用 `HY_MT_MODEL_PATH` 指定：

```bash
HY_MT_MODEL_PATH=/path/to/model.gguf pnpm dev
```

例如：

```bash
HY_MT_MODEL_PATH=/Users/yy/Models/Hy-MT2-1.8B-Q4_K_M.gguf pnpm dev
```

Windows 示例：

```powershell
$env:HY_MT_MODEL_PATH="D:\Models\Hy-MT2-1.8B-Q4_K_M.gguf"
pnpm dev
```

应用会按以下顺序查找 `llama-cli`：

1. `LLAMA_CLI_PATH` 环境变量。
2. `/opt/homebrew/bin/llama-cli`。
3. `/usr/local/bin/llama-cli`。
4. 系统 `PATH` 中的 `llama-cli`。

如果未安装 `llama-cli`，翻译会失败并在界面里显示错误信息。

### 4. 模型能不能内置进安装包？

可以。把模型文件放在项目的 `models/Hy-MT2-1.8B-GGUF/` 目录下，然后重新打包即可。

不过要注意：模型文件很大，当前 `Hy-MT2-1.8B-Q4_K_M.gguf` 大约 1.1 GB。内置模型后，DMG、ZIP 或 Windows 安装包也会增加接近这个体积。

如果要正式内置模型，建议在 `electron-builder.yml` 中保留或加入下面配置，让模型随安装包发布，并且不要被压进 `app.asar`：

```yaml
asarUnpack:
  - resources/**
  - models/**
```

这样外部的 `llama-cli` 才能像读取普通文件一样读取模型。

内置模型适合“给用户开箱即用”的安装包；不内置模型适合“安装包更小，用户自己下载模型”的分发方式。

### 5. 用户下载模型后怎么导入？

推荐提供两种导入方式。

第一种是默认目录导入：

1. 下载 `Hy-MT2-1.8B-Q4_K_M.gguf`。
2. 在应用目录或源码目录下创建 `models/Hy-MT2-1.8B-GGUF/`。
3. 把模型文件放进去。
4. 确认最终路径是 `models/Hy-MT2-1.8B-GGUF/Hy-MT2-1.8B-Q4_K_M.gguf`。
5. 重启应用。

第二种是环境变量导入：

1. 下载模型到任意目录，比如 `/Users/yy/Models/Hy-MT2-1.8B-Q4_K_M.gguf`。
2. 启动应用前设置 `HY_MT_MODEL_PATH`。
3. 应用会优先使用这个路径。

开发模式示例：

```bash
HY_MT_MODEL_PATH=/Users/yy/Models/Hy-MT2-1.8B-Q4_K_M.gguf pnpm dev
```

如果是给普通用户使用，更推荐内置模型，或者后续在应用界面里增加“选择模型文件”的设置项，把用户选择的路径保存下来。

### 6. 在线模型切换

应用界面里的“翻译模型”支持在本地 Hy-MT2、ChatGPT / OpenAI、DeepSeek、Gemini 之间切换。

- 本地 Hy-MT2 不需要 API Key，但需要本机可用的 `llama-cli` 和模型文件。
- ChatGPT / OpenAI、DeepSeek、Gemini 都需要填写对应服务自己的 API Key。
- 模型名可以在界面里改，例如 OpenAI 默认是 `gpt-4o-mini`，DeepSeek 默认是 `deepseek-chat`，Gemini 默认是 `gemini-1.5-flash`。
- 在线模型会把 OCR 文本发送给对应服务做翻译；如果文本敏感，建议使用本地模型。
- API Key 会保存到本机 Electron 用户数据目录，系统支持时会使用 Electron `safeStorage` 加密。

## 构建

类型检查和构建：

```bash
pnpm build
```

构建 macOS 安装包：

```bash
pnpm build:mac
```

构建 Windows 安装包：

```bash
pnpm build:win
```

构建 Linux 安装包：

```bash
pnpm build:linux
```

打包产物会输出到 `dist` 目录。

## 常用脚本

```bash
pnpm dev              # 开发模式运行
pnpm start            # 预览已构建应用
pnpm build            # 类型检查并构建
pnpm build:mac        # 构建 macOS 应用
pnpm build:win        # 构建 Windows 应用
pnpm build:linux      # 构建 Linux 应用
pnpm typecheck        # TypeScript 类型检查
pnpm lint             # ESLint 检查
pnpm format           # Prettier 格式化
```

## 常见问题

### 提示找不到 `llama-cli`

请先安装 llama.cpp 的命令行工具，并确保 `llama-cli` 在系统 `PATH` 中。也可以通过 `LLAMA_CLI_PATH` 指定完整路径：

```bash
LLAMA_CLI_PATH=/path/to/llama-cli pnpm dev
```

### 翻译很慢或首次运行等待时间较长

首次运行需要加载本地 GGUF 模型，耗时会更长。当前项目使用 CPU 运行参数 `--device none`，速度取决于机器性能。

### 剪贴板图片翻译提示没有图片

请先用系统截图工具截图并复制到剪贴板，或直接使用应用内的截图翻译按钮。

### macOS 截图权限反复弹出

打包版默认优先调用系统截图以减少权限问题。如果替换过应用后权限异常，可以删除旧应用，重新拖入 `/Applications`，再在系统设置中确认截图或屏幕录制权限。

## 技术栈

- Electron
- electron-vite
- React
- TypeScript
- Apple Vision OCR / Windows OCR
- llama.cpp `llama-cli`
- Hy-MT2 1.8B GGUF
