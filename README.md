# @modusensus/dsh-artifacts

**DSH（DeepSeek Harness）的全局产物收藏夹** —— 跨会话统一收纳图片、视频、文件和链接。

[![npm version](https://img.shields.io/npm/v/%40modusensus%2Fdsh-artifacts.svg)](https://www.npmjs.com/package/@modusensus/dsh-artifacts)
[![npm downloads](https://img.shields.io/npm/dm/%40modusensus%2Fdsh-artifacts.svg)](https://www.npmjs.com/package/@modusensus/dsh-artifacts)
[![license](https://img.shields.io/npm/l/%40modusensus%2Fdsh-artifacts.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![GitHub stars](https://img.shields.io/github/stars/modusensus/dsh-artifacts.svg)](https://github.com/modusensus/dsh-artifacts)

会话里跑出来的图、生成的视频、写好的文件，聊完就散在各自的会话里。产物插件把它们收进一个地方：左侧边栏多一个「产物」入口，所有会话交付过的东西都躺在里面，按内容去重，跨会话可查。

---

## 特性

| | |
|---|---|
| 🗂 **五个分类** | 全部 / 图片 / 视频 / 文件 / 链接，各自带计数，支持关键词搜索 |
| ✨ **自动收集** | 会话里用 `present` 交付的文件、图片、视频自动入箱，按 SHA-256 内容去重 |
| 🎞 **视频首帧** | 视频卡片直接显示首帧缩略图，点开灯箱即可播放 |
| 🕓 **历史回填** | 首次启动后台扫描历史会话日志，把过去交付过、磁盘上仍在的文件一并收进来 |
| 📌 **手动收藏** | 收藏链接、Ctrl+V 粘贴图片、上传文件（≤ 25MB） |
| 🤖 **模型工具** | 提供 `save_artifact`，模型可在会话里主动把有用的链接或工作区文件收进产物 |
| 🖼 **卡片操作** | 打开（图片灯箱 / 链接新开 / 文件查看）、复制、下载、删除 |

---

## 安装

### 从 npm 安装

```bash
# 1. 装进 profile（profile 用 pnpm 管理，npm 亦可）
cd <profile>          # 例如 ~/.dsh/profiles/desktop
pnpm add @modusensus/dsh-artifacts

# 2. 在 profile 的 package.json 里把包登记进 bundle 列表
#    dsh.profile.bundles 数组追加一项 "@modusensus/dsh-artifacts"

# 3. 重启 DSH
```

装完后包会落在 `<profile>/node_modules/@modusensus/dsh-artifacts`，无需软链。

### 从源码安装

```bash
git clone https://github.com/modusensus/dsh-artifacts.git
cd dsh-artifacts && npm install
```

然后把目录链进 profile：

```bash
# Windows
mklink /J "<profile>\node_modules\@modusensus\dsh-artifacts" "<clone 目录>"
# macOS / Linux
ln -s "<clone 目录>" "<profile>/node_modules/@modusensus/dsh-artifacts"
```

再改 profile 的 `package.json`：

```jsonc
{
  "dependencies": {
    "@modusensus/dsh-artifacts": "link:<clone 目录>"   // 追加
  },
  "dsh": {
    "profile": {
      "bundles": [
        // … 原有列表
        "@modusensus/dsh-artifacts"        // 追加
      ]
    }
  }
}
```

刷新 lockfile 后重启 DSH：

```bash
pnpm install --ignore-scripts
```

> `<profile>` 是你的 DSH profile 目录，桌面版通常在 `~/.dsh/profiles/desktop`。

---

## 配置

在 `cordis.patch.yml` 中 `dsh-artifacts` 那一项的 `config` 里填写：

| 键 | 默认值 | 说明 |
|---|---|---|
| `root` | `~/.dsh/artifacts/` | 存储目录 |
| `backfill` | `once` | 历史回填策略：`once` 首次启动扫一次 / `always` 每次启动都扫 / `false` 关闭 |
| `backfillDays` | `0` | 只扫最近 N 天的会话日志，`0` 表示不限 |
| `backfillMaxFiles` | `500` | 单次回填最多扫描多少个会话日志（按 mtime 降序） |

示例：

```yaml
- id: dsh-artifacts
  name: '@modusensus/dsh-artifacts'
  config:
    root: ~/.dsh/artifacts/
    backfill: once
    backfillDays: 30
```

---

## 存储结构

```
~/.dsh/artifacts/
├── index.json              # 元数据索引（id / kind / stored / name / mime / size / sha256 / 来源 …）
├── files/
│   └── <sha256><ext>       # 内容文件，按内容哈希落盘，天然去重
└── backfill.json           # 回填进度标记，防止重复扫描
```

内容按 SHA-256 命名，同一份文件无论被交付多少次，磁盘上只存一份。

---

## API

插件在宿主注册两条路由：

| 路由 | 说明 |
|---|---|
| `GET /api/dsh-artifacts` | 管理 API：列表、统计、添加链接、上传、改注、删除 |
| `GET /api/dsh-artifacts/file/<id>` | 内容路由：白名单校验，图片内联展示，其余类型可选 `?download=1` 附件下载 |

白名单只认索引里登记过的 `stored` 文件名，外部无法通过构造路径读取任意文件。

---

## 模型工具

插件注册了 `save_artifact`，模型在会话中可以直接调用：

```jsonc
// 收藏一条链接
{ "kind": "link", "url": "https://example.com/doc", "title": "参考文档", "note": "第 3 章有用" }

// 收藏工作区里的文件
{ "kind": "file", "path": "reports/summary.md", "title": "周报" }
```

同一个链接或同一份内容不会重复入库。

---

## 已知边界

- 自动收集只覆盖 `present` 交付。聊天里直接贴出但未交付的图片不会自动入箱，可以在会话里让模型调用 `save_artifact`。
- 上传走 base64，单文件上限 25MB；`present` 自动收集与回填：图片 / 文件 ≤ 50MB，视频 ≤ 200MB。
- 回填只收磁盘上仍然存在的文件，已被清理的交付不会入库。
- 文件「打开」在新标签页查看，浏览器不支持预览的类型会转为下载。

---

## 开发

```bash
npm test          # 跑全部测试（store / backfill / 客户端注册）
```

源码结构：

| 文件 | 职责 |
|---|---|
| `index.js` | 宿主半边：路由注册、事件监听、`save_artifact` 工具 |
| `client.js` | 浏览器半边：侧边栏入口、面板 UI、灯箱 |
| `store.js` | 存储层：索引读写、内容落盘、去重、上限控制 |
| `backfill.js` | 历史回填：扫描会话日志中的 `deliverables/presented` |
| `cordis.patch.yml` | 插件装载声明 |

---

## License

[MIT](./LICENSE) © modusensus
