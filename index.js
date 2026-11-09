/**
 * dsh-artifacts — 全局产物收藏夹（Host 半边）。
 *
 * 「产物」= 跨会话的全局收藏箱（参考 Hermes 的收集式资产管理）：
 *   1. 自动收集：监听 session/event 的 deliverables/presented，会话交付的图片和文件
 *      自动入箱（按内容 SHA-256 去重，单文件上限 50MB）。
 *   2. 手动收藏：/api/dsh-artifacts 管理 API——加链接、粘贴/上传图片与小文件、改注、删除。
 *   3. save_artifact 工具：模型在会话里主动把有用的链接/文件收进产物。
 *   4. /api/dsh-artifacts/file/<id> 内容路由：白名单 = 索引内 stored 文件，图片内联、
 *      文件可选 ?download=1 附件下载。
 *
 * 存储在 ~/.dsh/artifacts/（index.json + files/<sha256><ext>），见 store.js。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ArtifactStore, MAX_FILE_BYTES, MAX_UPLOAD_BYTES,
  artifactsRoot, collectFromDisk,
} from './store.js'

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
          const inline = item.kind === 'image' && !download
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
            if (q.get('stats')) return send(200, { ok: true, counts: store.counts(), version: pluginVersion, root: store.root, maxFileBytes: MAX_FILE_BYTES, maxUploadBytes: MAX_UPLOAD_BYTES })
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

  // ---- 自动收集：会话交付（present 工具）的文件/图片入箱 ----
  // present 侧在工具成功后 session.append('deliverables/presented', {turn, callId, files})；
  // 恢复的历史种子不发布 session/event，且按 sha256 去重，重启/重放不会收两次。
  ctx.on?.('session/event', (session, event) => {
    if (event?.type !== 'deliverables/presented') return
    const files = Array.isArray(event.files) ? event.files : []
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
  }, { global: true })

  // ---- save_artifact 工具：模型把链接/文件主动收进产物 ----
  const tools = ctx.tools ?? ctx.get?.('tools')
  if (tools && typeof tools.register === 'function') {
    tools.register(defineTool({
      name: 'save_artifact',
      description: '把对本用户长期有用的东西收进全局「产物」收藏夹（跨会话可查）：' +
        '① kind=link 收网址（文档、参考、工具页等）；② kind=file 把会话工作区里生成的文件（图片/文档等）收进去，' +
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
