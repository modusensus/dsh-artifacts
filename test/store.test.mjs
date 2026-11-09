/**
 * dsh-artifacts 存储层冒烟测试。
 * 运行：DSH_ARTIFACTS_HOME=<临时目录> node test/store.test.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactStore, collectFromDisk } from '../store.js'

process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-test-'))
const store = new ArtifactStore()

// 1. 内容条目 + 去重
const buf = Buffer.from('hello artifact')
const r1 = store.addBuffer({ buf, name: 'a.png', mime: 'image/png', source: 'test' })
assert.equal(r1.added, true)
assert.equal(r1.item.kind, 'image')
const r2 = store.addBuffer({ buf, name: 'a.png', mime: 'image/png', source: 'test' })
assert.equal(r2.added, false)
assert.equal(r2.reason, 'duplicate')
const r3 = store.addBuffer({ buf, name: 'b.png', mime: 'image/png', source: 'test' })
assert.equal(r3.added, true, '同名不同名同内容 → 新条目复用落盘')

// 2. 链接条目 + 归一去重
const l1 = store.addLink({ url: 'https://example.com/x/', title: '示例' })
assert.equal(l1.added, true)
const l2 = store.addLink({ url: 'https://example.com/x' })
assert.equal(l2.added, false)
assert.equal(l2.reason, 'duplicate')
const bad = store.addLink({ url: 'ftp://nope' })
assert.equal(bad.added, false)

// 3. 白名单解析
assert.ok(store.resolveStored(r1.item.stored), '索引内文件可解析')
assert.equal(store.resolveStored(r3.item.stored + '.nope'), null, '非索引文件拒绝')
assert.equal(store.resolveStored('../index.json'), null, '路径穿越拒绝')

// 4. remove + 引用计数：同 stored 仍被另一条目引用时不删文件
assert.equal(store.remove(r1.item.id), true)
const item3 = store.get(r3.item.id)
assert.ok(store.resolveStored(item3.stored), '另一条目仍引用，文件保留')
assert.equal(store.remove(r3.item.id), true)
assert.equal(store.resolveStored(item3.stored), null, '引用清零后文件删除')

// 5. collectFromDisk（图片/视频扩展名判定 + 原路径记录）
const srcDir = join(process.env.DSH_ARTIFACTS_HOME, 'src')
mkdirSync(srcDir, { recursive: true })
writeFileSync(join(srcDir, 'pic.png'), Buffer.from('fakepng'))
writeFileSync(join(srcDir, 'clip.mp4'), Buffer.from('fakemp4-bytes'))
const c1 = collectFromDisk(store, join(srcDir, 'pic.png'), { source: '会话 abc · work' })
assert.equal(c1.added, true)
assert.equal(c1.item.kind, 'image')
assert.ok(c1.item.originPath.endsWith('pic.png'))
const c2 = collectFromDisk(store, join(srcDir, 'pic.png'), {})
assert.equal(c2.added, false, '同内容同名 → duplicate')
const c3 = collectFromDisk(store, join(srcDir, 'missing.png'), {})
assert.equal(c3.added, false)
assert.ok(c3.reason)
const c4 = collectFromDisk(store, join(srcDir, 'clip.mp4'), { source: '视频测试' })
assert.equal(c4.added, true)
assert.equal(c4.item.kind, 'video', 'mp4 → video 类型')

// 6. counts + update
assert.deepEqual(store.counts(), { all: 3, image: 1, video: 1, file: 0, link: 1 })
const u = store.update(l1.item.id, { note: '注' })
assert.equal(u.note, '注')

// 7. 索引持久化（新实例读同一份）
const store2 = new ArtifactStore(store.root)
assert.equal(store2.load().length, 3)

rmSync(process.env.DSH_ARTIFACTS_HOME, { recursive: true, force: true })
console.log('store tests passed ✓')
