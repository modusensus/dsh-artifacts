/**
 * 回归测试：@deepseek-ai/dsh-tools 解析不到时，插件仍然要能加载。
 *
 * 背景：@deepseek-ai/dsh-tools 是宿主提供的模块，正常装配下活得了，但它不该是
 * 硬依赖。顶层静态 `import { defineTool } from '@deepseek-ai/dsh-tools'` 一旦解析
 * 失败，整个模块在 import 阶段就抛错，宿主只记一条日志不挂 fiber —— 插件静默消失，
 * 工具、路由、收集器全都没有，而客户端面板还在，看起来就是「面板在但加载不出内容」。
 * 所以 index.js 改成运行时三级兜底 + 本地等价实现，这个测试守的就是那条兜底。
 *
 * 本文件故意不造 stub：只要 index.js 还能被 import，就说明兜底生效了。
 * 运行：node test/fallback.test.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-fallback-'))

// 没有 stub 也必须 import 成功
const mod = await import('../index.js')
assert.equal(typeof mod.apply, 'function', 'apply 必须导出')
assert.equal(mod.name, 'dsh-artifacts')
assert.deepEqual(mod.inject, ['webServer', 'tools'])

// apply 在 mock 宿主里跑通：路由、工具、监听器都在
const routes = []
const tools = []
const handlers = []
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: (route) => routes.push(route) }
    if (name === 'tools') return { register: (tool) => tools.push(tool) }
    return undefined
  },
  on(event, handler, options) { handlers.push({ event, handler, options }) },
  effect(fn) { return fn() },
  logger: { info() {}, warn() {} },
}

mod.apply(ctx, {})

assert.equal(routes.length, 2, '内容路由 + 管理 API')
assert.equal(routes[0].path, '/api/dsh-artifacts/file')
assert.equal(routes[1].path, '/api/dsh-artifacts')
assert.equal(tools.length, 1, 'save_artifact 工具')
assert.equal(tools[0].name, 'save_artifact')
assert.equal(tools[0].parameters.type, 'object', '本地兜底要把友好 schema 编译成 JSON Schema')
assert.ok(tools[0].parameters.properties.kind, '参数里有 kind')
// 与宿主 parameterSchemaSpecToJsonSchema 逐字节一致：只有 type / properties（/ required），
// 不写 additionalProperties —— 真机编译结果里没有这个键，模型看到的 schema 不该被我们改样。
assert.deepEqual(Object.keys(tools[0].parameters).sort(), ['properties', 'type'])
assert.deepEqual(tools[0].output.schema, {}, 'type:"json" 编译成注解式 schema');

assert.ok(handlers.length >= 1)

console.log('fallback tests passed ✓')
