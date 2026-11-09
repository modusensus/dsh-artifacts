# dsh-artifacts — DSH「产物」插件

DSH（DeepSeek Harness）左侧边栏的全局产物收藏夹：跨会话统一收纳**图片、文件、链接**。

## 功能

- **侧边栏入口**：左侧「产物」面板（排在定时任务前），全部 / 图片 / 视频 / 文件 / 链接 五个 tab 带计数，支持搜索。
- **自动收集**：会话里模型用 `present` 工具交付的文件、图片和视频自动入箱（内容 SHA-256 去重；图片/文件 ≤ 50MB，视频 ≤ 200MB），来源标注工作区 + 会话短 id；视频卡片直接显示首帧，灯箱内可播放。
- **历史回填**：首次启动后台扫描会话日志（多帧 zstd JSONL），把历史 `deliverables/presented` 交付的、仍存在于磁盘的文件收进产物；默认只扫一次（marker 防重扫），内容去重保证幂等。
- **手动收藏**：右上角「收藏」菜单——收藏链接 / 粘贴图片（Ctrl+V 即收）/ 上传文件（≤ 25MB）。
- **模型工具**：`save_artifact`——模型可在会话里主动把有用的链接（`kind: link`）或工作区文件（`kind: file`）收进产物，自动去重。
- **卡片操作**：打开（图片灯箱 / 链接新开 / 文件查看）、复制（链接 URL 或文件原路径）、下载、删除。
- **存储**：`~/.dsh/artifacts/`（`index.json` 索引 + `files/<sha256><ext>` 内容文件，按内容落盘天然去重）。

## 配置

`cordis.patch.yml` 里 `dsh-artifacts` 行的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `root` | `~/.dsh/artifacts/` | 存储目录 |
| `backfill` | `once` | 回填：`once` 首次启动扫一次 / `always` 每次启动都扫 / `false` 关闭 |
| `backfillDays` | `0` | 只扫最近 N 天的会话日志（0 = 不限） |
| `backfillMaxFiles` | `500` | 单次回填最多扫的会话日志数（mtime 降序） |

## 安装（desktop profile）

```bash
# 1. clone 到本地任意目录，junction/symlink 进 profile 的 node_modules
git clone https://github.com/modusensus/dsh-artifacts.git
ln -s "$(pwd)/dsh-artifacts" "<profile>/node_modules/dsh-artifacts"

# 2. profile 的 package.json
#    dependencies 加 "dsh-artifacts": "link:<clone 目录>"
#    dsh.profile.bundles 数组加 "dsh-artifacts"

# 3. pnpm install --ignore-scripts（刷新 lockfile）后重启 DSH
```

其中 `<profile>` 是你的 DSH profile 目录（如 `~/.dsh/profiles/desktop`）。

## 配置

`cordis.patch.yml` 里 `dsh-artifacts` 行的 `config.root` 可覆盖存储目录（默认 `~/.dsh/artifacts/`）。

## 已知边界

- 自动收集与回填只覆盖 `present` 交付；聊天内直接展示但未交付的图片不收（可在会话里让模型 `save_artifact`）。
- 上传走 base64，单文件 ≤ 25MB；present 自动收集与回填：图片/文件 ≤ 50MB，视频 ≤ 200MB。
- 回填只收磁盘上仍存在的文件；已被删除/清理的交付不收。
- 文件「打开」在新标签查看，浏览器对不可预览类型会转下载。
