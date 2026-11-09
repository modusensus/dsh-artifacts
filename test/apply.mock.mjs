/**
 * dsh-artifacts apply() 全链路 mock 测试（不依赖宿主）。
 * 运行：node test/apply.mock.mjs
 * dsh-tools stub 临时放在 default 工作区层（宿主的 junction 解析链不经过那里，不会遮蔽真包）。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 临时 dsh-tools stub（测完必删）----
const stubDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '@deepseek-ai', 'dsh-tools')
mkdirSync(stubDir, { recursive: true })
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-mock', type: 'module', main: 'index.js' }))
writeFileSync(join(stubDir, 'index.js'), 'export function defineTool(def) { return def }\n')

process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-apply-'))
const { apply } = await import('../index.js')

// ---- mock 宿主 ----
const registeredRoutes = []
const registeredTools = []
const eventHandlers = []
const effects = []
const logs = []

const fakeRes = () => {
  const res = { statusCode: 0, headers: {}, body: null, ended: false }
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {} }
  res.end = (data) => { res.ended = true; res.body = data }
  return res
}

const ctx = {
  get(name) {
    if (name === 'webServer') {
      return { register(route) { registeredRoutes.push(route) } }
    }
    if (name === 'tools') {
      return { register(tool) { registeredTools.push(tool) } }
    }
    return undefined
  },
  on(event, handler, options) { eventHandlers.push({ event, handler, options }) },
  // cordis effect 语义：立即执行，返回值作为 dispose 回调
  effect(fn, label) { effects.push({ label, dispose: fn() }) },
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
}

// 工作区 mock：save_artifact file 分支用
const workDir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-work-'))
writeFileSync(join(workDir, 'report.md'), '# 报告\n内容', 'utf8')
writeFileSync(join(workDir, 'shot.png'), Buffer.from('89504e47', 'hex'), 'utf8')
ctx.workingDirectory = { ensure: async () => workDir }
ctx.fs = {
  resolve: async (p, opts) => (p.startsWith('/') ? p : join(opts.cwd, p)),
  processPath: (p) => p,
}

apply(ctx, {})
assert.equal(registeredRoutes.length, 2, '内容路由 + 管理 API')
assert.equal(registeredTools.length, 1, 'save_artifact 工具')
assert.equal(eventHandlers.length, 1, 'session/event 监听')
assert.equal(eventHandlers[0].event, 'session/event')
assert.ok(eventHandlers[0].options.global)

const api = registeredRoutes.find((r) => r.path === '/api/dsh-artifacts')
const fileRoute = registeredRoutes.find((r) => r.path === '/api/dsh-artifacts/file')
assert.ok(api && fileRoute)

// ---- GET stats ----
{
  const res = fakeRes()
  await api.handler({ method: 'GET', url: '/api/dsh-artifacts?stats=1' }, res)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.deepEqual(body.counts, { all: 0, image: 0, file: 0, link: 0 })
}

// ---- POST addLink ----
{
  const req = { method: 'POST', url: '/api/dsh-artifacts' }
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ action: 'addLink', url: 'https://example.com/doc', title: '文档' }), 'utf8')
  }
  const res = fakeRes()
  await api.handler(req, res)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true, 'addLink ok: ' + body.message)
}

// ---- POST addBase64（图片）----
let imageItemId = ''
{
  const req = { method: 'POST', url: '/api/dsh-artifacts' }
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({
      action: 'addBase64',
      data: Buffer.from('fakepng-bytes').toString('base64'),
      mime: 'image/png', name: '截图.png', source: '手动添加',
    }), 'utf8')
  }
  const res = fakeRes()
  await api.handler(req, res)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true, 'addBase64 ok: ' + body.message)
  assert.equal(body.item.kind, 'image')
  imageItemId = body.item.id
}

// ---- GET list ----
{
  const res = fakeRes()
  await api.handler({ method: 'GET', url: '/api/dsh-artifacts?list=1' }, res)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.items.length, 2)
  assert.deepEqual(body.counts, { all: 2, image: 1, file: 0, link: 1 })
  const img = body.items.find((it) => it.kind === 'image')
  assert.match(img.url, /^\/api\/dsh-artifacts\/file\//)
}

// ---- 内容路由（白名单内 + 白名单外）----
{
  const res = fakeRes()
  fileRoute.handler({ url: '/api/dsh-artifacts/file/' + encodeURIComponent(imageItemId) }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Content-Type'], 'image/png')
}
{
  const res = fakeRes()
  fileRoute.handler({ url: '/api/dsh-artifacts/file/deadbeef' }, res)
  assert.equal(res.statusCode, 404)
}

// ---- session/event 自动收集（deliverables/presented，信封 {type, seq, time, data}）----
const session = { id: 'sess-12345678', header: { cwd: 'D:\\proj\\turf' } }
eventHandlers[0].handler(session, {
  type: 'deliverables/presented', seq: 9, time: 1,
  data: { turn: 3, callId: 'c9', files: [{ path: join(workDir, 'report.md'), description: '最终报告' }, { path: join(workDir, 'missing.txt') }] },
})
await new Promise((r) => setTimeout(r, 50))
{
  const res = fakeRes()
  await api.handler({ method: 'GET', url: '/api/dsh-artifacts?list=1' }, res)
  const body = JSON.parse(res.body)
  assert.equal(body.counts.all, 3, '自动收集 +1（缺失文件跳过）: ' + JSON.stringify(body.counts))
  const md = body.items.find((it) => it.kind === 'file')
  assert.equal(md.name, 'report.md')
  assert.equal(md.note, '最终报告')
  assert.equal(md.source, 'turf · 会话 sess-123')
}

// ---- save_artifact 工具 ----
const tool = registeredTools[0]
assert.equal(tool.name, 'save_artifact')
{
  const r = await tool.execute({ kind: 'link', url: 'https://deepseek.com', note: '官网' }, {
    agent: { session }, signal: undefined,
  })
  assert.equal(r.ok, true, 'tool link: ' + r.message)
}
{
  const r = await tool.execute({ kind: 'file', path: 'shot.png' }, {
    agent: { session }, signal: undefined,
  })
  assert.equal(r.ok, true, 'tool file: ' + r.message)
}
{
  const dup = await tool.execute({ kind: 'link', url: 'https://deepseek.com' }, { agent: { session } })
  assert.equal(dup.ok, true)
  assert.match(dup.message, /已经/, '链接去重')
}
{
  const bad = await tool.execute({ kind: 'file', path: 'nope.bin' }, { agent: { session }, signal: undefined })
  assert.equal(bad.ok, false)
}
{
  const res = fakeRes()
  await api.handler({ method: 'GET', url: '/api/dsh-artifacts?stats=1' }, res)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.counts, { all: 5, image: 2, file: 1, link: 2 })
}

// ---- remove ----
{
  const req = { method: 'POST', url: '/api/dsh-artifacts' }
  req[Symbol.asyncIterator] = async function* () {
    yield Buffer.from(JSON.stringify({ action: 'remove', id: imageItemId }), 'utf8')
  }
  const res = fakeRes()
  await api.handler(req, res)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
}

console.log('apply() mock tests passed ✓')
console.log('host 日志样例:', logs.slice(0, 3).join(' | '))

// ---- 清理临时 stub 与临时 home ----
rmSync(stubDir, { recursive: true, force: true })
try { rmSync(dirname(stubDir), { recursive: true, force: true }) } catch { /* node_modules/@deepseek-ai 空了就删 */ }
try { rmSync(dirname(dirname(stubDir)), { recursive: true, force: true }) } catch { /* node_modules 空了就删 */ }
rmSync(process.env.DSH_ARTIFACTS_HOME, { recursive: true, force: true })
