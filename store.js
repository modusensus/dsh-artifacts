/**
 * dsh-artifacts — 全局产物收藏夹（存储层）。
 *
 * 布局与 dsh-sticker 图库同构：
 *   ~/.dsh/artifacts/index.json   条目索引（一个 JSON 数组，原子写）
 *   ~/.dsh/artifacts/files/<sha256><ext>   内容文件，按内容哈希落盘（天然去重）
 *
 * 三类条目：
 *   image —— 图片（聊天产出、粘贴、上传），UI 缩略图直显
 *   file  —— 其他文件（present 交付、上传），下载/新开查看
 *   link  —— 网址收藏（手动添加、模型 save_artifact）
 */
import {
  createHash, randomUUID,
} from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'

/** dsh 的 home 目录（junction 到真实数据盘）。测试用 DSH_ARTIFACTS_HOME 覆盖。 */
export function dshHome() {
  return process.env.DSH_ARTIFACTS_HOME || homedir()
}

export function artifactsRoot() {
  return join(dshHome(), '.dsh', 'artifacts')
}

export function filesDir() {
  return join(artifactsRoot(), 'files')
}

export function indexFile() {
  return join(artifactsRoot(), 'index.json')
}

/** 单文件体积上限：图片/文件 50MB；视频单独放宽到 200MB（remotion 等渲染产物常几十上百 MB）。 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024
/** base64 上传（粘贴图片/小文件）上限：25MB（走请求体，收敛一点）。 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

export const IMAGE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml', 'image/avif',
])

const MIME_BY_EXT = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.bmp', 'image/bmp'], ['.svg', 'image/svg+xml'], ['.avif', 'image/avif'],
  ['.txt', 'text/plain'], ['.md', 'text/markdown'], ['.json', 'application/json'],
  ['.csv', 'text/csv'], ['.html', 'text/html'], ['.pdf', 'application/pdf'],
  ['.zip', 'application/zip'], ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'],
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'],
  ['.mkv', 'video/x-matroska'], ['.avi', 'video/x-msvideo'], ['.mpg', 'video/mpeg'], ['.mpeg', 'video/mpeg'],
])

export function mimeForExt(ext) {
  return MIME_BY_EXT.get(String(ext || '').toLowerCase()) || 'application/octet-stream'
}

export function extForMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim()
  for (const [ext, known] of MIME_BY_EXT) {
    if (known === m) return ext
  }
  return ''
}

/** 图片条目判定：MIME 或扩展名。 */
export function isImageMime(mime) {
  return IMAGE_MIME.has(String(mime || '').toLowerCase().split(';')[0].trim())
}

export function looksLikeImage(name, mime) {
  if (mime && isImageMime(mime)) return true
  return IMAGE_MIME.has(mimeForExt(extname(String(name || ''))))
}

/** 视频条目判定：MIME（video/*）或视频扩展名。 */
export function isVideoMime(mime) {
  return String(mime || '').toLowerCase().split(';')[0].trim().startsWith('video/')
}

export function looksLikeVideo(name, mime) {
  if (mime && isVideoMime(mime)) return true
  return isVideoMime(mimeForExt(extname(String(name || ''))))
}

/** 按名称/MIME 判定条目类型。 */
export function classify(name, mime) {
  if (looksLikeVideo(name, mime)) return 'video'
  if (looksLikeImage(name, mime)) return 'image'
  return 'file'
}

/** 条目体积上限：视频单独放宽。 */
export function capForKind(kind) {
  return kind === 'video' ? MAX_VIDEO_BYTES : MAX_FILE_BYTES
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 条目 id：短哈希（URL/内容去重键）。 */
function shortId(seed) {
  return createHash('sha256').update(String(seed)).digest('hex').slice(0, 16)
}

export class ArtifactStore {
  constructor(root = artifactsRoot()) {
    this.root = root
    this.files = join(root, 'files')
    this.indexPath = join(root, 'index.json')
    mkdirSync(this.files, { recursive: true })
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8'))
      if (Array.isArray(parsed)) return parsed
    } catch { /* 首次或坏文件都从空开始（原子写保证不易坏） */ }
    return []
  }

  save(items) {
    const tmp = this.indexPath + '.tmp'
    writeFileSync(tmp, JSON.stringify(items, null, 2))
    renameSync(tmp, this.indexPath)
  }

  /** 引用计数：某内容文件是否仍被其他条目使用。 */
  #referenced(items, stored, exceptId) {
    return items.some((it) => it.stored === stored && it.id !== exceptId)
  }

  /**
   * 新增内容型条目（图片/文件）。buf 已读入内存。
   * 返回 {added, item?, reason?}；同内容同名已存在时按重复跳过（重命名收藏会复用同一落盘文件）。
   */
  addBuffer({ buf, name, mime = '', note = '', source = '', sessionId = '', originPath = '' }) {
    if (!buf || !buf.byteLength) return { added: false, reason: 'empty' }
    const kind = classify(name, mime)
    if (buf.byteLength > capForKind(kind)) return { added: false, reason: 'too-large' }
    const hash = sha256(buf)
    const ext = (extname(String(name || '')) || extForMime(mime) || '').toLowerCase()
    const stored = hash + ext
    const storedPath = join(this.files, stored)
    if (!existsSync(storedPath)) writeFileSync(storedPath, buf)
    const displayName = basename(String(name || stored)) || stored
    const items = this.load()
    const dup = items.find((it) => it.sha256 === hash && it.name === displayName)
    if (dup) return { added: false, reason: 'duplicate', item: dup }
    const id = shortId(kind + ':' + hash + ':' + Date.now() + ':' + randomUUID())
    const item = {
      id, kind, stored,
      name: displayName,
      mime: mime || mimeForExt(ext),
      size: buf.byteLength,
      sha256: hash,
      note: String(note || '').slice(0, 500),
      source: String(source || '').slice(0, 120),
      sessionId: String(sessionId || '').slice(0, 80),
      originPath: String(originPath || '').slice(0, 500),
      addedAt: new Date().toISOString(),
    }
    items.unshift(item)
    this.save(items)
    return { added: true, item }
  }

  /** 新增链接条目。同 URL（含尾斜杠归一）已存在时不重复收。 */
  addLink({ url, title = '', note = '', source = '', sessionId = '' }) {
    const raw = String(url || '').trim()
    let parsed
    try { parsed = new URL(raw) } catch { return { added: false, reason: 'bad-url' } }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { added: false, reason: 'bad-protocol' }
    const norm = parsed.origin + parsed.pathname.replace(/\/+$/, '') + parsed.search + parsed.hash
    const items = this.load()
    const dup = items.find((it) => it.kind === 'link' && (it.url === raw || it.url === norm || it.urlNorm === raw || it.urlNorm === norm))
    if (dup) return { added: false, reason: 'duplicate', item: dup }
    const id = shortId('link:' + norm + ':' + Date.now() + ':' + randomUUID())
    const item = {
      id, kind: 'link', stored: '',
      name: String(title || '').trim().slice(0, 200) || parsed.hostname + (parsed.pathname === '/' ? '' : parsed.pathname),
      url: raw, urlNorm: norm, host: parsed.hostname,
      mime: '', size: 0, sha256: '',
      note: String(note || '').slice(0, 500),
      source: String(source || '').slice(0, 120),
      sessionId: String(sessionId || '').slice(0, 80),
      addedAt: new Date().toISOString(),
    }
    items.unshift(item)
    this.save(items)
    return { added: true, item }
  }

  update(id, patch) {
    const items = this.load()
    const item = items.find((it) => it.id === id)
    if (!item) return null
    if (typeof patch.note === 'string') item.note = patch.note.slice(0, 500)
    if (typeof patch.title === 'string' && patch.title.trim()) item.name = patch.title.trim().slice(0, 200)
    this.save(items)
    return item
  }

  remove(id) {
    const items = this.load()
    const idx = items.findIndex((it) => it.id === id)
    if (idx < 0) return false
    const [item] = items.splice(idx, 1)
    this.save(items)
    if (item.stored && !this.#referenced(items, item.stored, id)) {
      try { unlinkSync(join(this.files, item.stored)) } catch { /* 已不在盘上 */ }
    }
    return true
  }

  get(id) {
    return this.load().find((it) => it.id === id) || null
  }

  /** 内容文件白名单：只有索引里引用过的 stored 文件才允许被路由读出。 */
  resolveStored(stored) {
    const name = String(stored || '')
    if (!/^[0-9a-f]{64}(\.[a-z0-9]+)?$/.test(name)) return null
    if (!this.load().some((it) => it.stored === name)) return null
    const path = join(this.files, name)
    return existsSync(path) ? path : null
  }

  /**
   * 按当前分类规则重估内容条目类型（视频分类是 0.2.0 新增，旧库里的视频可能被
   * 收成了 file）。链接条目不动。有变更才写盘。返回修正条数。
   */
  reclassify() {
    const items = this.load()
    let changed = 0
    for (const item of items) {
      if (item.kind === 'link') continue
      const kind = classify(item.name, item.mime)
      if (kind !== item.kind) {
        item.kind = kind
        changed += 1
      }
    }
    if (changed) this.save(items)
    return changed
  }

  counts() {
    const items = this.load()
    const c = { all: items.length, image: 0, video: 0, file: 0, link: 0 }
    for (const it of items) c[it.kind] = (c[it.kind] || 0) + 1
    return c
  }
}

/** 从磁盘收一个文件（auto-collect / 回填 / 模型 save_artifact 共用），上限按类型放宽。 */
export function collectFromDisk(store, absPath, { note = '', source = '', sessionId = '' } = {}) {
  try {
    const st = statSync(absPath)
    if (!st.isFile()) return { added: false, reason: 'not-file' }
    const kind = classify(basename(absPath), mimeForExt(extname(absPath)))
    if (st.size > capForKind(kind)) return { added: false, reason: 'too-large' }
    const buf = readFileSync(absPath)
    return store.addBuffer({
      buf, name: basename(absPath),
      mime: mimeForExt(extname(absPath)),
      note, source, sessionId,
      originPath: absPath,
    })
  } catch (error) {
    return { added: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 索引损坏兜底：外部工具想直接搬旧库时用（复制树进来并重建索引）。 */
export function importDirectory(store, dir, { note = '', source = '导入' } = {}) {
  let added = 0, skipped = 0
  for (const name of readdirSync(dir)) {
    const r = collectFromDisk(store, join(dir, name), { note, source })
    if (r.added) added += 1
    else skipped += 1
  }
  return { added, skipped }
}

export { copyFileSync, existsSync, rmSync, join, basename }
