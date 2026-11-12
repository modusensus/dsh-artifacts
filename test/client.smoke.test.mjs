import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// 极简 React 桩：面板组件只被注册、不被渲染，所以 h() 返回标记对象即可
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(), useCallback: (fn) => fn(),
}
const registered = []
const slotsInjected = []
const slots = {
  register(options, component) {
    registered.push({ options, component })
    return () => {}
  },
  inject(key, cb) { slotsInjected.push(key); return cb() },
}

const ctx = {
  slots,
  get(name) { return name === 'slots' ? slots : undefined },
  effect(fn) { fn() },
}

const source = readFileSync('./client.js', 'utf8')
let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => { captured = spec } } },
  document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
  console,
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, items: [], counts: { all: 0, image: 0, video: 0, file: 0, link: 0 } }) }),
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

assert.ok(captured, '必须调用 __ModuleLoader__.load')
assert.equal(captured.id, '@modusensus/dsh-artifacts')
const mod = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
assert.equal(typeof mod.apply, 'function', '必须导出 apply')
assert.deepEqual(Array.from(mod.inject || []), ['slots'], '必须声明 inject: [\'slots\']')

mod.apply(ctx)
assert.deepEqual(slotsInjected.sort(), ['main', 'sidebar.panellist'], '两个槽位都要注册')
const ids = registered.map((r) => r.options.name)
assert.ok(ids.includes('main') && ids.includes('sidebar.panellist'), '面板体 + 侧栏入口都要注册：' + ids)

console.log('client smoke tests passed ✓  注册:', JSON.stringify(registered.map((r) => ({ name: r.options.name, key: r.options.key, id: r.options.id }))))
