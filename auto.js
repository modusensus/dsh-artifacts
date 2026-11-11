/**
 * dsh-artifacts — 自动收集（写入钩子 + 轮末清扫）。
 *
 * present 交付之外的两条自动入口：
 *   1. 写入钩子（index.js 挂 fs/write-intent / fs/edit-intent）：模型写盘工具落盘的
 *      路径先进待收清单，等 tool/result / turn/end 时排水入箱；本模块不感知钩子。
 *   2. 轮末清扫（sweepWorkspace）：turn/end 时按 turn/start 起算的时间戳，扫会话
 *      工作区里本轮改动过的文件，扩展名白名单命中才收——兜住 bash/脚本/渲染等
 *      绕过 fs 服务的产物。
 * 内容 SHA-256 + 文件名去重在 store 层，与 present / 回填互不冲突。
 */
import { promises as fsp } from 'node:fs'
import { extname, join } from 'node:path'
import { collectFromDisk } from './store.js'

/** 默认自动收集白名单：媒体 + 常见成文交付（present 交付不受白名单限制）。 */
export const DEFAULT_AUTO_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif',
  '.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.mpg', '.mpeg',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a',
  '.pdf', '.zip', '.md', '.html', '.htm', '.csv',
])

/** 清扫跳过的目录：依赖/构建缓存，永不是交付。其余可见目录（含 dist/out）都扫。 */
const IGNORED_DIRS = new Set(['node_modules', '__pycache__', 'venv'])
/** 明确是临时态的后缀。 */
const IGNORED_SUFFIXES = ['.tmp', '.part', '.crdownload', '.swp', '.download', '.bak']
const MAX_DEPTH = 8
const MAX_ENTRIES = 8000
/** 文件 mtime 与事件时间戳的容差（时钟/文件系统粒度）。 */
const MTIME_SKEW_MS = 2000

/** 归一化配置里的扩展名列表（可数组的点/无点混写，或逗号分隔字符串），返回 Set。 */
export function normalizeExts(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(',')
  const out = new Set()
  for (const item of raw) {
    let ext = String(item || '').trim().toLowerCase()
    if (!ext) continue
    if (!ext.startsWith('.')) ext = '.' + ext
    out.add(ext)
  }
  return out
}

/**
 * 轮末清扫：扫 cwd 下 mtime ≥ sinceMs 的白名单文件并入箱。
 * 返回 {seen, added, capped, ms}；capped 表示因条数/规模上限提前收手。
 */
export async function sweepWorkspace(store, cwd, { sinceMs, exts, maxFiles = 50, source = '', sessionId = '' } = {}) {
  const t0 = Date.now()
  const stats = { seen: 0, added: 0, capped: false, ms: 0 }
  const whitelist = exts instanceof Set ? exts : normalizeExts(exts)
  const queue = [[String(cwd), 0]]
  let entries = 0
  while (queue.length && !stats.capped) {
    const [dir, depth] = queue.shift()
    let dirents
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const dirent of dirents) {
      if (++entries > MAX_ENTRIES) { stats.capped = true; break }
      const abs = join(dir, dirent.name)
      if (dirent.isDirectory()) {
        const name = dirent.name.toLowerCase()
        if (depth < MAX_DEPTH && !name.startsWith('.') && !IGNORED_DIRS.has(name)) queue.push([abs, depth + 1])
        continue
      }
      if (!dirent.isFile()) continue
      const lower = dirent.name.toLowerCase()
      if (!whitelist.has(extname(lower))) continue
      if (IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) continue
      let st
      try { st = await fsp.stat(abs) } catch { continue }
      if (!st.isFile() || st.mtimeMs < sinceMs - MTIME_SKEW_MS) continue
      stats.seen += 1
      const r = collectFromDisk(store, abs, { source, sessionId })
      if (r.added) stats.added += 1
      if (stats.added >= maxFiles) { stats.capped = true; break }
    }
  }
  stats.ms = Date.now() - t0
  return stats
}
