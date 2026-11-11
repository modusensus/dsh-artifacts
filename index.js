/**
 * dsh-artifacts — 全局产物收藏夹（Host 半边）。
 *
 * 「产物」= 跨会话的全局收藏箱（参考 Hermes 的收集式资产管理）：
 *   1. 自动收集（auto 配置：'all' 默认 / 'present' 仅① / 'off' 关闭）：
 *      ① present 交付：监听 session/event 的 deliverables/presented，交付的图片和文件入箱；
 *      ② 写入钩子：fs/write-intent / fs/edit-intent waterfall，模型写盘工具落盘的文件入箱；
 *      ③ 轮末清扫：turn/end 扫会话工作区本轮改动，兜住 bash/脚本等绕过 fs 服务的产物。
 *      ②③ 按扩展名白名单收（autoExts），内容均按 SHA-256 去重，单文件上限 50MB/视频 200MB。
 *   2. 手动收藏：/api/dsh-artifacts 管理 API——加链接、粘贴/上传图片与小文件、改注、删除。
 *   3. save_artifact 工具：模型在会话里主动把有用的链接/文件收进产物。
 *   4. /api/dsh-artifacts/file/<id> 内容路由：白名单 = 索引内 stored 文件，图片内联、
 *      文件可选 ?download=1 附件下载。
 *
 * 存储在 ~/.dsh/artifacts/（index.json + files/<sha256><ext>），见 store.js。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ArtifactStore, MAX_FILE_BYTES, MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES,
  artifactsRoot, collectFromDisk,
} from './store.js'
import { DEFAULT_AUTO_EXTS, normalizeExts, sweepWorkspace } from './auto.js'
import { backfillFromSessions } from './backfill.js'

export const name = 'dsh-artifacts'
export const inject = ['webServer', 'tools']

const API_ROUTE = '/api/dsh-artifacts'
const FILE_ROUTE = '/api/dsh-artifacts/file'

const pluginVersion = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
    return String(pkg.version || '').trim()
  } catch { return '' }
})()

/** 会话来源标签：工作区目录名 + 会话短 id。 */
function sourceLabel(session) {
  let ws = ''
  try { ws = session?.header?.cwd ? basename(session.header.cwd) : '' } catch { /* header 不可读就算了 */ }
  const id = String(session?.id || '').slice(0, 8)
  const parts = []
  if (ws) parts.push(ws)
  if (id) parts.push('会话 ' + id)
  return parts.join(' · ') || '会话'
}

const fileUrlOf = (item) => item.kind === 'link' ? '' : `${FILE_ROUTE}/${encodeURIComponent(item.id)}`
const publicItem = (item) => ({ ...item, url: item.kind === 'link' ? item.url : fileUrlOf(item), fileUrl: fileUrlOf(item) })

export function apply(ctx, config = {}) {
  const log = (event, data) => {
    const suffix = data === undefined ? '' : ' ' + JSON.stringify(data)
    ctx.logger?.info?.(`[dsh-artifacts] ${event}${suffix}`)
  }

  const store = new ArtifactStore(config.root || artifactsRoot())
  const reclassified = store.reclassify()
  if (reclassified) log('store.reclassified', { count: reclassified })
  log('store.ready', { root: store.root, items: store.load().length })

  const webServer = ctx.webServer ?? ctx.get?.('webServer')
  if (webServer) {
    // ---- 内容路由：GET /api/dsh-artifacts/file/<id>[?download=1] ----
    const fileHandler = {
      kind: 'prefix',
      path: FILE_ROUTE,
      handler(req, res) {
        const raw = String(req.url || '').split('?')[0]
        const download = /[?&]download=1/.test(String(req.url || ''))
        let id = ''
        try { id = decodeURIComponent(raw.startsWith(FILE_ROUTE + '/') ? raw.slice(FILE_ROUTE.length + 1) : '') } catch { id = '' }
        const item = id ? store.get(id) : null
        const path = item?.stored ? store.resolveStored(item.stored) : null
        if (!item || !path) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        try {
          const bytes = readFileSync(path)
          const inline = (item.kind === 'image' || item.kind === 'video') && !download
          const headers = {
            'Content-Type': item.mime || 'application/octet-stream',
            'Content-Length': String(bytes.byteLength),
            'Cache-Control': 'private, max-age=3600',
            'Content-Disposition': (inline ? 'inline' : 'attachment') + '; filename*=UTF-8\'\'' + encodeURIComponent(item.name),
          }
          res.writeHead(200, headers)
          res.end(bytes)
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not found')
        }
      },
    }

    // ---- 管理 API：GET 列表/统计；POST addLink/addBase64/update/remove ----
    const apiHandler = {
      kind: 'prefix',
      path: API_ROUTE,
      async handler(req, res) {
        const send = (code, obj) => {
          const body = JSON.stringify(obj)
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)) })
          res.end(body)
        }
        try {
          if (req.method === 'GET') {
            const q = new URL(String(req.url || ''), 'http://x').searchParams
            if (q.get('stats')) return send(200, { ok: true, counts: store.counts(), version: pluginVersion, root: store.root, maxFileBytes: MAX_FILE_BYTES, maxVideoBytes: MAX_VIDEO_BYTES, maxUploadBytes: MAX_UPLOAD_BYTES })
            const query = (q.get('query') || '').trim().toLowerCase()
            let items = store.load()
            if (query) items = items.filter((it) => ((it.name || '') + ' ' + (it.note || '') + ' ' + (it.host || '') + ' ' + (it.source || '')).toLowerCase().includes(query))
            return send(200, {
              ok: true,
              items: items.map((it) => ({ ...it, url: it.kind === 'link' ? it.url : fileUrlOf(it), fileUrl: fileUrlOf(it) })),
              counts: store.counts(),
              version: pluginVersion,
            })
          }
          if (req.method === 'POST') {
            const chunks = []
            let size = 0
            for await (const c of req) {
              size += c.length
              if (size > MAX_UPLOAD_BYTES + 64 * 1024) break
              chunks.push(c)
            }
            let body
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
              return send(400, { ok: false, message: '请求体不是合法 JSON' })
            }
            const action = String(body.action || '')
            if (action === 'addLink') {
              const r = store.addLink({ url: body.url, title: body.title, note: body.note })
              if (!r.added && r.reason === 'duplicate') return send(200, { ok: true, item: publicItem(r.item), message: '这个链接已经在产物里了' })
              if (!r.added) return send(200, { ok: false, message: r.reason === 'bad-url' ? '不是有效的 http(s) 链接' : '添加失败' })
              log('link.added', { id: r.item.id })
              return send(200, { ok: true, item: publicItem(r.item), message: '已收藏链接' })
            }
            if (action === 'addBase64') {
              const data = String(body.data || '').replace(/^data:[^,]+,/, '')
              const buf = Buffer.from(data, 'base64')
              if (!buf.byteLength) return send(200, { ok: false, message: '文件内容为空' })
              const r = store.addBuffer({ buf, name: body.name, mime: body.mime, note: body.note, source: body.source || '手动添加' })
              if (!r.added) return send(200, { ok: false, message: r.reason === 'too-large' ? '文件超过 50MB，收不进产物' : '添加失败' })
              log('file.added', { id: r.item.id, kind: r.item.kind, size: r.item.size })
              return send(200, { ok: true, item: publicItem(r.item), message: (r.item.kind === 'image' ? '已收藏图片：' : '已收藏文件：') + r.item.name })
            }
            if (action === 'update') {
              const item = store.update(String(body.id || ''), { note: body.note, title: body.title })
              if (!item) return send(200, { ok: false, message: '条目不存在' })
              return send(200, { ok: true, item: publicItem(item), message: '已更新' })
            }
            if (action === 'remove') {
              if (!store.remove(String(body.id || ''))) return send(200, { ok: false, message: '条目不存在' })
              log('removed', { id: String(body.id || '') })
              return send(200, { ok: true, message: '已删除' })
            }
            return send(400, { ok: false, message: '未知 action: ' + action })
          }
          return send(405, { ok: false, message: 'method not allowed' })
        } catch (error) {
          log('api.error', { message: error instanceof Error ? error.message : String(error) })
          return send(500, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      },
    }

    ctx.effect(() => webServer.register(fileHandler), 'dsh-artifacts: 内容路由')
    ctx.effect(() => webServer.register(apiHandler), 'dsh-artifacts: 管理 API')
  } else {
    log('webServer.missing')
  }

  // ---- 自动收集：present 交付 + 写入钩子 + 轮末清扫 ----
  // ① present 侧在工具成功后 session.append('deliverables/presented', {turn, callId, files})；
  //    监听器收到的是事件信封 {type, seq, time, data}，载荷在 event.data 里。
  // ② 写盘工具（write / editor 等）落盘前派发 fs/write-intent、fs/edit-intent waterfall
  //    （target, actor=exec, next），同宿主 dsh-workspace-changes 的用法；这里只把目标路径
  //    记进待收清单，等 tool/result、turn/end、session/disposed 时排水入箱——写失败（沙盒
  //    拒绝等）的路径因不存在自然跳过。
  // ③ turn/end 按 turn/start 起算的时间戳扫会话工作区，白名单命中才收。
  // 全部走 store 的 sha256+文件名去重，重启/重放不会收两次；present 交付不受白名单限制。
  const autoMode = config.auto === undefined || config.auto === null
    ? 'all'
    : (config.auto === false ? 'off' : String(config.auto))
  const autoActive = autoMode !== 'off'
  const autoExts = config.autoExts === undefined || config.autoExts === null
    ? DEFAULT_AUTO_EXTS
    : normalizeExts(config.autoExts)
  const sweepMax = Number.isFinite(Number(config.autoSweepMax)) && Number(config.autoSweepMax) >= 1
    ? Math.floor(Number(config.autoSweepMax))
    : 50
  log('auto.ready', { mode: autoMode, exts: autoExts.size, sweepMax })

  const pendingWrites = new Map() // sessionId → 待排水的写盘路径集合
  const turnStarts = new Map()    // sessionId → {turn, at}
  const sessionCwds = new Map()   // sessionId → 当前工作区
  const sweeping = new Set()      // 在扫的 sessionId（防重入）

  /** 事件时间戳归一为毫秒（宿主可能给秒），不可用返回 0。 */
  const timeMsOf = (value) => {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return 0
    return n < 1e12 ? n * 1000 : n
  }

  const withinWhitelist = (path) => autoExts.has(extname(path).toLowerCase())

  /** 排水：把待收清单里存在且白名单命中的文件入箱。 */
  function drainWrites(session) {
    const sid = String(session?.id || '')
    const set = pendingWrites.get(sid)
    if (!set?.size) return
    pendingWrites.delete(sid)
    for (const path of set) {
      if (!withinWhitelist(path)) continue
      const r = collectFromDisk(store, path, { source: sourceLabel(session), sessionId: sid })
      if (r.added) log('auto.written', { id: r.item.id, kind: r.item.kind, name: r.item.name })
      else if (r.reason !== 'duplicate' && r.reason !== 'missing' && r.reason !== 'not-file') {
        log('auto.skipped', { path, reason: r.reason })
      }
    }
  }

  /** 轮末清扫（防重入；本会话还在扫时下一个 turn/end 会自然并进下轮）。 */
  function queueSweep(session, sinceMs) {
    const sid = String(session?.id || '')
    if (!sid || sweeping.has(sid)) return
    const cwd = sessionCwds.get(sid) || session?.header?.cwd
    if (!cwd) return
    sweeping.add(sid)
    void sweepWorkspace(store, cwd, {
      sinceMs: timeMsOf(sinceMs) || Date.now(),
      exts: autoExts,
      maxFiles: sweepMax,
      source: sourceLabel(session),
      sessionId: sid,
    }).then((stats) => {
      if (stats.added) log('auto.swept', { session: sid.slice(0, 8), added: stats.added, seen: stats.seen })
    }).catch((error) => {
      log('auto.sweep.error', { message: error instanceof Error ? error.message : String(error) })
    }).finally(() => sweeping.delete(sid))
  }

  if (autoActive) {
    ctx.on?.('session/event', (session, event) => {
      const type = event?.type
      if (type === 'deliverables/presented') {
        const files = Array.isArray(event.data?.files) ? event.data.files : []
        for (const file of files) {
          const path = String(file?.path || '')
          if (!path) continue
          const r = collectFromDisk(store, path, {
            note: String(file?.description || '').slice(0, 500),
            source: sourceLabel(session),
            sessionId: String(session?.id || ''),
          })
          if (r.added) log('auto.presented', { id: r.item.id, kind: r.item.kind, name: r.item.name })
          else if (r.reason !== 'duplicate') log('auto.skipped', { path, reason: r.reason })
        }
        return
      }
      if (autoMode !== 'all') return
      const sid = String(session?.id || '')
      if (type === 'tool/result') return drainWrites(session)
      if (type === 'turn/start') {
        if (sid) {
          turnStarts.set(sid, { turn: Number(event.data?.turn) || 0, at: timeMsOf(event.time) || Date.now() })
          const cwd = String(session?.header?.cwd || '')
          if (cwd) sessionCwds.set(sid, cwd)
        }
        return
      }
      if (type === 'working-directory/change') {
        const cwd = String(event.data?.cwd || '')
        if (sid && cwd) sessionCwds.set(sid, cwd)
        return
      }
      if (type === 'turn/end') {
        drainWrites(session)
        queueSweep(session, turnStarts.get(sid)?.at)
      }
    }, { global: true })

    ctx.on?.('session/disposed', (session) => {
      const sid = String(session?.id || '')
      if (autoMode === 'all' && sid) {
        drainWrites(session)
        queueSweep(session, turnStarts.get(sid)?.at)
      }
      pendingWrites.delete(sid)
      turnStarts.delete(sid)
      sessionCwds.delete(sid)
      sweeping.delete(sid)
    }, { global: true })
  }

  if (autoMode === 'all') {
    const fsService = ctx.fs ?? ctx.get?.('fs')
    if (fsService && typeof fsService.processPath === 'function') {
      const noteIntent = (target, actor) => {
        try {
          const path = fsService.processPath(target)
          const sid = String(actor?.agent?.session?.id || '')
          if (!path || !sid) return
          let set = pendingWrites.get(sid)
          if (!set) pendingWrites.set(sid, (set = new Set()))
          if (set.size < 500) set.add(path)
        } catch { /* processPath 失败就当没看见 */ }
      }
      const onIntent = async (target, actor, next) => {
        const intent = await next()
        noteIntent(target, actor)
        return intent
      }
      ctx.on?.('fs/write-intent', onIntent, { global: true })
      ctx.on?.('fs/edit-intent', onIntent, { global: true })
    } else {
      log('fs.missing', { note: '写入钩子不可用，自动收集退化为仅轮末清扫' })
    }
  }

  // ---- 旧会话回填：默认首次启动后后台扫历史日志（marker 防重扫；内容去重保证幂等）----
  const markerPath = join(store.root, 'backfill.json')
  const backfillMode = config.backfill === undefined ? 'once' : config.backfill
  const shouldBackfill = backfillMode === 'always' || (backfillMode !== false && !existsSync(markerPath))
  if (shouldBackfill) {
    void (async () => {
      try {
        const stats = await backfillFromSessions(store, {
          days: config.backfillDays ?? 0,
          maxFiles: config.backfillMaxFiles ?? 500,
        })
        log('backfill.done', stats)
        try {
          writeFileSync(markerPath, JSON.stringify({ completedAt: new Date().toISOString(), ...stats }, null, 2))
        } catch { /* 写不进就下次再扫（去重保证幂等） */ }
      } catch (error) {
        log('backfill.error', { message: error instanceof Error ? error.message : String(error) })
      }
    })()
  }

  // ---- save_artifact 工具：模型把链接/文件主动收进产物 ----
  const tools = ctx.tools ?? ctx.get?.('tools')
  if (tools && typeof tools.register === 'function') {
    tools.register(defineTool({
      name: 'save_artifact',
      description: '把对本用户长期有用的东西收进全局「产物」收藏夹（跨会话可查）：' +
        '① kind=link 收网址（文档、参考、工具页等）；② kind=file 把会话工作区里生成的文件（图片/视频/文档等）收进去，' +
        '给 path（相对当前工作区）。收藏会去重：同一链接或同一内容不会重复入库。产物面板在左侧边栏。',
      parameters: {
        kind: { type: 'string', description: '要收藏的类型：link（网址）或 file（文件）。' },
        url: { type: 'string', description: 'kind=link 时必填：http(s) 网址。' },
        path: { type: 'string', description: 'kind=file 时必填：文件路径（相对当前工作区或绝对路径）。' },
        title: { type: 'string', description: '可选：收藏显示名（链接标题/文件更友好名）。' },
        note: { type: 'string', description: '可选：一句话说明它是什么、为什么值得收。' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args, exec) {
        const note = String(args.note || '').slice(0, 500)
        const title = String(args.title || '').slice(0, 200)
        const sessionId = String(exec?.agent?.session?.id || '')
        const source = sourceLabel(exec?.agent?.session)
        if (args.kind === 'link') {
          const r = store.addLink({ url: args.url, title, note, source, sessionId })
          if (r.added) return { ok: true, id: r.item.id, message: '已收藏链接「' + r.item.name + '」到产物。' }
          if (r.reason === 'duplicate') return { ok: true, id: r.item?.id, message: '这个链接已经在产物里了，未重复收藏。' }
          return { ok: false, message: r.reason === 'bad-url' ? '不是有效的 http(s) 链接：' + String(args.url || '') : '收藏失败。' }
        }
        if (args.kind === 'file') {
          const rawPath = String(args.path || '').trim()
          if (!rawPath) return { ok: false, message: 'kind=file 需要给 path。' }
          try {
            const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
            const target = await ctx.fs.resolve(rawPath, { cwd, signal: exec.signal })
            const processPath = ctx.fs.processPath(target)
            const r = collectFromDisk(store, processPath, { note, source, sessionId })
            if (r.added) return { ok: true, id: r.item.id, message: '已收藏文件「' + r.item.name + '」到产物。' }
            if (r.reason === 'duplicate' && r.item) return { ok: true, id: r.item.id, message: '这个文件已经在产物里了，未重复收藏。' }
            return { ok: false, message: '文件没收进去：' + (r.reason || '未知原因') + '。' }
          } catch (error) {
            return { ok: false, message: '文件读取失败：' + (error instanceof Error ? error.message : String(error)) + '。' }
          }
        }
        return { ok: false, message: 'kind 只支持 link 或 file。' }
      },
    }))
  } else {
    log('tools.missing')
  }
}
