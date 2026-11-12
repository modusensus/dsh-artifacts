/**
 * inject 契约测试：插件声明的 inject 必须覆盖它用属性语法访问的所有服务。
 *
 * 背景：cordis 的 ctx 代理对「未在 inject 里声明的服务」做直接属性访问会抛
 *   cannot get property "<name>" without inject
 * 而 ctx.get(name) 是可选查询，未声明也不抛。0.3.0 就是因为 index.js 里写了
 * ctx.fs / ctx.workingDirectory 却没在 inject 中声明，apply 抛错 → entry FAILED →
 * 工具、路由、收集器全部缺席，面板自然空着。
 *
 * 这个测试用 Proxy 复刻同一套语义，让「未声明就属性访问」在测试期直接炸。
 * 运行：node test/inject-contract.test.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 临时 dsh-tools stub（测完必删，手法同 apply.mock.mjs）----
const stubDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '@deepseek-ai', 'dsh-tools')
mkdirSync(stubDir, { recursive: true })
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-mock', type: 'module', main: 'index.js' }))
writeFileSync(join(stubDir, 'index.js'), 'export function defineTool(def) { return def }\n')

process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-inject-'))
const mod = await import('../index.js')

const declared = new Set(mod.inject || [])

// 宿主里确实存在的服务（未声明的那些，属性访问必须抛）
/** 绝对路径判断（兼容 POSIX 与 Windows 盘符）。 */
const isAbsolutePath = (p) => p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p)

const services = {
  webServer: { register: () => () => {} },
  tools: { register: () => () => {} },
  fs: {
    resolve: async (p, opts) => (isAbsolutePath(p) ? p : join(opts.cwd, p)),
    processPath: (t) => (typeof t === 'string' ? t : String(t?.path || '')),
  },
  workingDirectory: { ensure: async () => process.cwd() },
  logger: { info: () => {} },
}

/**
 * 复刻 cordis ReflectService.handler.get：
 *   - 在 inject 里声明的服务 → 正常返回
 *   - 未声明但存在的服务 → 抛 cannot get property "X" without inject
 *   - ctx.get(name) 永远可选，不抛
 */
function makeCordisLikeCtx() {
  const handlers = []
  const target = {
    get(name) { return services[name] },
    on(event, handler, options) { handlers.push({ event, handler, options }) },
    effect(fn) { fn() },
    logger: services.logger,
  }
  const ctx = new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop !== 'string' || prop in obj) return Reflect.get(obj, prop, receiver)
      const error = new Error('cannot get property "' + prop + '" without inject')
      // get 是特殊属性，不走 inject 校验
      if (prop === 'get') return Reflect.get(obj, prop, receiver)
      if (declared.has(prop)) {
        if (services[prop] !== undefined) return services[prop]
        throw new Error('cannot get required service "' + prop + '" in inactive context')
      }
      // 未声明：服务存在也不给，按 cordis 语义抛
      if (services[prop] !== undefined) throw error
      return undefined
    },
    set(obj, prop, value) {
      throw new Error('cannot set property "' + prop + '" without provide')
    },
  })
  return { ctx, handlers }
}

const { ctx } = makeCordisLikeCtx()

// 关键断言：带着 cordis 语义跑 apply 不能抛
assert.doesNotThrow(() => mod.apply(ctx, {}), 'apply 不能在真实 inject 语义下抛错')

// save_artifact 的 file 分支必须真的用得上 fs —— 单靠"没抛"还不够，
// 得确认它走 ctx.get 拿到了服务并成功收藏文件。
const dir = mkdtempSync(join(tmpdir(), 'dsh-artifacts-inject-work-'))
writeFileSync(join(dir, 'note.md'), '# 笔记\n内容', 'utf8')

let registeredTool = null
services.tools = { register(tool) { if (tool.name === 'save_artifact') registeredTool = tool; return () => {} } }

const { ctx: ctx2 } = makeCordisLikeCtx()
mod.apply(ctx2, {})
assert.ok(registeredTool, 'save_artifact 必须注册成功')

const session = { id: 'sess-inject01', header: { cwd: dir } }
const r = await registeredTool.execute({ kind: 'file', path: join(dir, 'note.md') }, { agent: { session }, signal: undefined })
assert.equal(r.ok, true, 'file 分支必须能收藏：' + r.message)

// 反向自证：把 fs 从服务表里摘掉，apply 仍然不能抛（fs 是可选能力）
delete services.fs
const { ctx: ctx3 } = makeCordisLikeCtx()
assert.doesNotThrow(() => mod.apply(ctx3, {}), '宿主没有 fs 服务时 apply 也不许抛')

console.log('inject contract tests passed ✓')

// ---- 清理 ----
rmSync(stubDir, { recursive: true, force: true })
try { rmSync(dirname(stubDir), { recursive: true, force: true }) } catch { /* 空目录 */ }
try { rmSync(dirname(dirname(stubDir)), { recursive: true, force: true }) } catch { /* 空目录 */ }
rmSync(process.env.DSH_ARTIFACTS_HOME, { recursive: true, force: true })
rmSync(dir, { recursive: true, force: true })
