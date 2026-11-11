/**
 * dsh-artifacts 自动收集测试（写入钩子 + 轮末清扫，不依赖宿主）。
 * 运行：node test/auto.test.mjs
 * dsh-tools stub 复用 apply.mock.mjs 的手法：临时放 default 工作区层，测完必删。
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 临时 dsh-tools stub（测完必删）----
const stubDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '@deepseek-ai', 'dsh-tools')
mkdirSync(stubDir, { recursive: true })
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-mock', type: 'module', main: 'index.js' }))
writeFileSync(join(stubDir, 'index.js'), 'export function defineTool(def) { return def }\n')

process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-auto-home-'))
const { apply } = await import('../index.js')

const fakeRes = () => {
  const res = { statusCode: 0, headers: {}, body: null }
  res.writeHead = (code, headers) => { res.statusCode = code; res.headers = headers || {} }
  res.end = (data) => { res.body = data }
  return res
}

/** 独立 mock 宿主；fs.processPath 兼容字符串与 {path} 两种 target 形状。 */
function makeCtx(workDir) {
  const handlers = []
  const routes = []
  const logs = []
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => routes.push(route) }
      if (name === 'tools') return { register: () => {} }
      return undefined
    },
    on(event, handler, options) { handlers.push({ event, handler, options }) },
    effect(fn) { fn() },
    logger: { info: (m) => logs.push(m) },
    fs: {
      resolve: async (p, opts) => (p.startsWith('/') ? p : join(opts.cwd, p)),
      processPath: (t) => (typeof t === 'string' ? t : String(t?.path || '')),
    },
    workingDirectory: { ensure: async () => workDir },
  }
  return { ctx, handlers, routes, logs }
}

const findHandler = (handlers, event) => handlers.find((h) => h.event === event)?.handler
const nextTick = () => new Promise((r) => setTimeout(r, 0))

/** 等异步清扫落定：轮询断言条件成立或超时。 */
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > ms) return false
    await new Promise((r) => setTimeout(r, 30))
  }
}

const apiOf = (routes) => routes.find((r) => r.path === '/api/dsh-artifacts')
const namesOf = async (api) => (await new Promise((resolve) => {
  const res = fakeRes()
  void api.handler({ method: 'GET', url: '/api/dsh-artifacts?list=1' }, res).then(() => resolve(res.body))
}))
const listNames = async (api) => JSON.parse(await namesOf(api)).items.map((it) => it.name)

// ================= 默认配置（auto: 'all'）=================
{
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-auto-work-'))
  const session = { id: 'sess-auto111', header: { cwd: workDir } }
  const { ctx, handlers, routes } = makeCtx(workDir)
  apply(ctx, {})

  const onEvent = findHandler(handlers, 'session/event')
  const onWrite = findHandler(handlers, 'fs/write-intent')
  const onEdit = findHandler(handlers, 'fs/edit-intent')
  const onDisposed = findHandler(handlers, 'session/disposed')
  assert.ok(onEvent && onWrite && onEdit && onDisposed, '默认配置注册全部监听器')

  const api = apiOf(routes)

  // ---- ① 写入钩子：写盘 → tool/result 排水 → 入箱；写失败的路径自然跳过 ----
  const mdPath = join(workDir, 'report.md')
  writeFileSync(mdPath, '# 报告')
  await onWrite(mdPath, { agent: { session } }, async () => undefined)
  await onWrite(join(workDir, 'ghost.md'), { agent: { session } }, async () => undefined) // 不存在
  onEvent(session, { type: 'tool/result', seq: 1, time: 1, data: {} })
  await nextTick()
  assert.ok((await listNames(api)).includes('report.md'), '写入钩子排水入箱')

  // ---- 白名单外（json）不入箱 ----
  const jsonPath = join(workDir, 'config.json')
  writeFileSync(jsonPath, '{}')
  await onEdit({ path: jsonPath }, { agent: { session } }, async () => undefined)
  onEvent(session, { type: 'tool/result', seq: 2, time: 1, data: {} })
  await nextTick()
  assert.ok(!(await listNames(api)).includes('config.json'), 'json 在白名单外')

  // ---- ② 轮末清扫：本轮新增 png 入箱；白名单外/忽略目录/旧文件不入箱 ----
  onEvent(session, { type: 'turn/start', seq: 3, time: Date.now(), data: { turn: 1 } })
  const pngPath = join(workDir, 'render.png')
  writeFileSync(pngPath, Buffer.from('89504e470d0a1a0a', 'hex'))
  mkdirSync(join(workDir, 'node_modules'), { recursive: true })
  writeFileSync(join(workDir, 'node_modules', 'hidden.png'), Buffer.from('89504e47', 'hex'))
  writeFileSync(join(workDir, 'notes.txt'), '白名单外')
  const oldPng = join(workDir, 'old.png')
  writeFileSync(oldPng, Buffer.from('89504e47', 'hex'))
  const past = new Date(Date.now() - 60_000)
  utimesSync(oldPng, past, past) // mtime 在 turn/start 之前 → 不算本轮
  onEvent(session, { type: 'turn/end', seq: 4, time: Date.now(), data: { turn: 1, reason: 'end' } })

  const swept = await waitFor(async () => (await listNames(api)).includes('render.png'))
  assert.ok(swept, '轮末清扫收本轮 png')
  const names = await listNames(api)
  assert.ok(!names.includes('hidden.png'), 'node_modules 不扫')
  assert.ok(!names.includes('notes.txt'), 'txt 在白名单外')
  assert.ok(!names.includes('old.png'), '本轮之前的文件不收')

  // ---- ③ session/disposed 排水 + 兜底清扫 ----
  const latePath = join(workDir, 'late.csv')
  writeFileSync(latePath, 'a,b\n1,2')
  await onWrite(latePath, { agent: { session } }, async () => undefined)
  onDisposed(session)
  const drained = await waitFor(async () => (await listNames(api)).includes('late.csv'))
  assert.ok(drained, 'disposed 时排水入箱')

  rmSync(workDir, { recursive: true, force: true })
}

// ================= auto: 'present'（0.2.x 行为）=================
{
  process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-auto-present-'))
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-present-work-'))
  const session = { id: 'sess-present1', header: { cwd: workDir } }
  const { ctx, handlers, routes } = makeCtx(workDir)
  apply(ctx, { auto: 'present' })

  const onEvent = findHandler(handlers, 'session/event')
  assert.ok(onEvent, 'present 模式保留 session/event')
  assert.ok(!findHandler(handlers, 'fs/write-intent'), 'present 模式无写入钩子')

  const presented = join(workDir, 'given.md')
  writeFileSync(presented, '# 交付')
  onEvent(session, { type: 'deliverables/presented', seq: 1, time: 1, data: { files: [{ path: presented }] } })
  await nextTick()

  const written = join(workDir, 'wrote.md')
  writeFileSync(written, '# 白名单内但非 present')
  onEvent(session, { type: 'turn/start', seq: 2, time: Date.now(), data: { turn: 1 } })
  onEvent(session, { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1 } })
  await new Promise((r) => setTimeout(r, 200))

  const names = await listNames(apiOf(routes))
  assert.ok(names.includes('given.md'), 'present 交付照常入箱')
  assert.ok(!names.includes('wrote.md'), 'present 模式不扫工作区')

  rmSync(workDir, { recursive: true, force: true })
}

// ================= auto: 'off' =================
{
  process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-auto-off-'))
  const { ctx, handlers } = makeCtx(join(tmpdir(), 'unused'))
  apply(ctx, { auto: 'off' })
  assert.ok(!findHandler(handlers, 'session/event'), 'off 模式无任何自动收集监听')
}

// ================= autoSweepMax 单轮上限 =================
{
  process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-auto-cap-'))
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-cap-work-'))
  const session = { id: 'sess-cap0001', header: { cwd: workDir } }
  const { ctx, handlers, routes } = makeCtx(workDir)
  apply(ctx, { autoSweepMax: 1 })

  const onEvent = findHandler(handlers, 'session/event')
  onEvent(session, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
  writeFileSync(join(workDir, 'one.png'), Buffer.from('89504e47', 'hex'))
  writeFileSync(join(workDir, 'two.png'), Buffer.from('89504e48', 'hex'))
  onEvent(session, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1 } })
  await new Promise((r) => setTimeout(r, 300))

  const body = JSON.parse(await namesOf(apiOf(routes)))
  assert.equal(body.items.length, 1, '单轮清扫受 autoSweepMax 限制')
  assert.equal(body.items[0].kind, 'image')

  rmSync(workDir, { recursive: true, force: true })
}

// ================= autoExts 自定义白名单 =================
{
  process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-auto-exts-'))
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-exts-work-'))
  const session = { id: 'sess-exts001', header: { cwd: workDir } }
  const { ctx, handlers, routes } = makeCtx(workDir)
  apply(ctx, { autoExts: ['txt'] })

  const onEvent = findHandler(handlers, 'session/event')
  onEvent(session, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
  writeFileSync(join(workDir, 'log.txt'), 'hello')
  writeFileSync(join(workDir, 'pic.png'), Buffer.from('89504e47', 'hex'))
  onEvent(session, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1 } })
  await new Promise((r) => setTimeout(r, 300))

  const names = await listNames(apiOf(routes))
  assert.ok(names.includes('log.txt'), '自定义白名单收 txt')
  assert.ok(!names.includes('pic.png'), '自定义白名单替换默认清单')

  rmSync(workDir, { recursive: true, force: true })
}

console.log('auto-collect tests passed ✓')

// ---- 清理临时 stub 与临时 home ----
rmSync(stubDir, { recursive: true, force: true })
try { rmSync(dirname(stubDir), { recursive: true, force: true }) } catch { /* node_modules/@deepseek-ai 空了就删 */ }
try { rmSync(dirname(dirname(stubDir)), { recursive: true, force: true }) } catch { /* node_modules 空了就删 */ }
rmSync(process.env.DSH_ARTIFACTS_HOME, { recursive: true, force: true })
