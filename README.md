# Stream Guard 流式回复备份

一个用于 SillyTavern 的服务器端插件，可在崩溃时捕获完整的 AI 流式回复以供恢复。

## 功能概述

当你在与 AI 聊天时遇到流式响应卡住、浏览器崩溃或意外刷新页面等情况，AI 的回复内容就会丢失。Stream Guard 通过以下机制来防止这种情况：

- **服务器端捕获**：在 Node.js 层面拦截 SSE（服务器推送事件）流，收集流经的每一个 token。
- **客户端备份**：定期将当前回复保存到 localStorage 中作为二级备份。
- **自动恢复**：页面重载后自动检测未保存的回复，并提供一键恢复功能。
- **智能去重**：对比服务器端与客户端备份，始终选择更完整的版本。

## 工作原理

```
AI 服务商 → SillyTavern 服务器 → Stream Guard（捕获 token）→ 浏览器
                                        ↓
                                  备份存储于内存中
                                        ↓
                              页面重载时：弹出恢复提示
```

1. 服务器插件钩入 Node.js 的 HTTP 响应，以检测 SSE 流。
2. 流式数据的每一个分块都会被收集到内存中。
3. 流式响应结束时，提取完整文本并存储为备份。
4. 若生成正常完成，客户端脚本会清除备份。
5. 若在完成前刷新了页面，备份将持久保留，并在下次加载时提供恢复选项。

## 安装

> Stream Guard 需要同时安装 **服务器插件** 与 **酒馆助手脚本**，两者缺一不可。

### 前提条件

需要先安装 [酒馆助手 (JS-Slash-Runner)](https://github.com/N0VI028/JS-Slash-Runner) 扩展。如果尚未安装，请先在酒馆的 扩展 → 安装扩展 中输入以下地址进行安装：

```
https://github.com/N0VI028/JS-Slash-Runner
```

### 第一步：安装服务器插件

1. 打开 SillyTavern 根目录下的 `config.yaml`，将 `enableServerPlugins: false` 改为 `enableServerPlugins: true`
2. 将 `stream-guard` 文件夹放入 SillyTavern 的 `plugins/` 目录
3. 重启 SillyTavern

控制台出现以下信息表示服务器插件安装成功：

```
[StreamGuard] 服务器插件已加载
```

### 第二步：导入客户端脚本

1. 打开 SillyTavern，找到 **酒馆助手** 面板
2. 点击 **导入脚本**
3. 选择插件文件夹中的 `酒馆助手脚本-流式数据保护.json` 文件导入
4. 确保脚本处于 **启用** 状态
5. 刷新页面

> 💡 `酒馆助手脚本-流式数据保护.json` 就在你刚才放进 `plugins/` 目录的 `stream-guard` 文件夹里，不需要额外下载。

### 验证安装

两部分都安装好后，正常聊一次天。如果一切正常：

1. 命令行窗口会显示：`[StreamGuard] 备份已保存 (XX字)，可刷新前端`
2. 在 AI 回复过程中或回复完成后刷新页面，刷新后会弹出恢复提示

如果浏览器控制台显示 `未检测到服务器插件`，请检查：
- `config.yaml` 中的 `enableServerPlugins` 是否为 `true`
- `plugins/stream-guard/` 目录是否存在且包含 `index.js`
- SillyTavern 是否已重启

## API 端点

所有端点均仅使用 GET 请求（无 CSRF 问题）。

| 端点 | 描述 |
|------|------|
| `GET /api/plugins/stream-guard/backup` | 获取当前备份 |
| `GET /api/plugins/stream-guard/clear` | 清除当前备份 |
| `GET /api/plugins/stream-guard/debug` | 调试信息（活跃流、备份状态等） |

## 兼容性

- 适用于所有支持流式输出的 AI 服务商（OpenAI、Claude、Gemini、NovelAI、KoboldCpp 等）。
- 通过内容检查检测 SSE 流（在无法获取响应头时作为回退方案）。
- 同时支持真实流式与平滑流式模式。

## 数据保留策略

- 备份仅保存在服务器内存中（不写入磁盘）。
- 30 分钟后自动清理。
- 生成正常完成时立即清除。
- 无持久化存储，不会积累数据。
