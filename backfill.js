/**
 * dsh-artifacts — 旧会话产物回填（backfill）。
 *
 * 插件启动时（默认仅首次）后台扫描 ~/.dsh/sessions/ 的会话日志，提取
 * deliverables/presented 事件中仍然存在的文件，收进产物库（内容去重，
 * 与实时收集互不冲突）。会话日志是「多帧 zstd 的 JSONL」：每帧独立可解，
 * 帧结构按 dsh-session-persistence-jsonl 的 scanZstdFrames 同款规则走位。
 *
 * 事件行信封：{type, seq, time, data:{turn, callId, files:[{path, description?}]}}
 * 帧 0 是 header 行：{type:'session', id, cwd, createdAt, ...}
 */
import { promises as fsp } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { capForKind, classify, collectFromDisk, dshHome, mimeForExt, workspaceLabel } from './store.js'

const ZSTD_MAGIC = 4247762216
const MAX_SESSION_FILE_BYTES = 150 * 1024 * 1024

/** 会话日志帧定位（结构化扫描，不解压块；同 dsh-session-persistence-jsonl 规则）。 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length && frames.length < maxFrames) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const yieldTick = () => new Promise((resolve) => setImmediate(resolve))

/** 列出候选会话日志（mtime 降序），返回 {path, size, mtime}。 */
export async function listSessionLogs({ days = 0, maxFiles = 300, sessionsRoot } = {}) {
  const root = sessionsRoot || join(dshHome(), '.dsh', 'sessions')
  const out = []
  let workspaces = []
  try { workspaces = await fsp.readdir(root) } catch { return out }
  const cutoff = days > 0 ? Date.now() - days * 86400000 : 0
  for (const ws of workspaces) {
    let sessions = []
    try { sessions = await fsp.readdir(join(root, ws)) } catch { continue }
    for (const sid of sessions) {
      const dir = join(root, ws, sid)
      let st
      try { st = await fsp.stat(dir) } catch { continue }
      if (!st.isDirectory()) continue
      // zstd 为主，明文 jsonl 兜底（部署可关压缩）
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const path = join(dir, name)
        let fst
        try { fst = await fsp.stat(path) } catch { continue }
        if (cutoff && fst.mtimeMs < cutoff) break
        if (fst.size > MAX_SESSION_FILE_BYTES) break
        out.push({ path, size: fst.size, mtimeMs: fst.mtimeMs })
        break
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return maxFiles > 0 ? out.slice(0, maxFiles) : out
}

/** 从一个会话日志提取 deliverables/presented 事件（容错：坏帧跳过）。 */
export async function extractPresented(logPath) {
  const buffer = await fsp.readFile(logPath)
  const lines = []
  if (logPath.endsWith('.zstd')) {
    const { frames } = scanZstdFrames(buffer)
    for (const frame of frames) {
      let text
      try { text = (await zlibDecompress(buffer.subarray(frame.start, frame.end))).toString() } catch { continue }
      for (const line of text.split('\n')) {
        if (line.includes('"deliverables/presented"')) lines.push(line)
      }
      await yieldTick()
    }
  } else {
    for (const line of buffer.toString('utf8').split('\n')) {
      if (line.includes('"deliverables/presented"')) lines.push(line)
    }
  }
  const header = await readHeader(buffer, logPath)
  return { header, lines }
}

async function zlibDecompress(input) {
  const { zstdDecompressSync } = await import('node:zlib')
  return zstdDecompressSync(input)
}

/** 帧 0 = 会话 header 行（含 id / cwd）。 */
async function readHeader(buffer, logPath) {
  try {
    let text
    if (logPath.endsWith('.zstd')) {
      const { frames } = scanZstdFrames(buffer, 1)
      if (!frames.length) return {}
      text = (await zlibDecompress(buffer.subarray(frames[0].start, frames[0].end))).toString()
    } else {
      text = buffer.toString('utf8')
    }
    const line = text.split('\n', 1)[0]
    const parsed = JSON.parse(line)
    return parsed.type === 'session' ? parsed : {}
  } catch {
    return {}
  }
}

/** 回填主流程。返回 {scanned, events, added, duplicates, missing, tooLarge, skippedSessions, ms}。 */
export async function backfillFromSessions(store, { days = 0, maxFiles = 300, onProgress, sessionsRoot } = {}) {
  const t0 = Date.now()
  const stats = { scanned: 0, events: 0, added: 0, duplicates: 0, missing: 0, tooLarge: 0, skippedSessions: 0, ms: 0 }
  const logs = await listSessionLogs({ days, maxFiles, sessionsRoot })
  for (const log of logs) {
    try {
      const { header, lines } = await extractPresented(log.path)
      stats.scanned += 1
      if (!lines.length) continue
      const ws = workspaceLabel(header.cwd)
      const sid = String(header.id || '').replace(/^session-/, '').slice(0, 8)
      const source = [ws, sid ? `会话 ${sid}` : ''].filter(Boolean).join(' · ') || '会话'
      for (const line of lines) {
        let payload
        try { payload = (JSON.parse(line).data) || {} } catch { continue }
        stats.events += 1
        const files = Array.isArray(payload.files) ? payload.files : []
        for (const file of files) {
          const path = String(file?.path || '')
          if (!path) continue
          const r = await collect(store, path, {
            note: String(file?.description || '').slice(0, 500),
            source, sessionId: String(header.id || ''),
          })
          if (r.added) stats.added += 1
          else if (r.reason === 'duplicate') stats.duplicates += 1
          else if (r.reason === 'missing') stats.missing += 1
          else if (r.reason === 'too-large') stats.tooLarge += 1
        }
        if (onProgress && stats.added % 10 === 0 && stats.added > 0) onProgress(stats)
        await yieldTick()
      }
    } catch {
      stats.skippedSessions += 1
    }
  }
  stats.ms = Date.now() - t0
  return stats
}

/** 收单个文件，区分缺失/超大（上限按图片/视频/文件类型放宽）。 */
async function collect(store, absPath, meta) {
  try {
    const st = await fsp.stat(absPath)
    if (!st.isFile()) return { added: false, reason: 'missing' }
    const kind = classify(basename(absPath), mimeForExt(extname(absPath)))
    if (st.size > capForKind(kind)) return { added: false, reason: 'too-large' }
  } catch {
    return { added: false, reason: 'missing' }
  }
  return collectFromDisk(store, absPath, meta)
}
