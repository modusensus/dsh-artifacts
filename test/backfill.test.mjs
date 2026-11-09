/**
 * backfill 单元测试：自造「多帧 zstd JSONL」会话日志，验证帧扫描、信封解析、收集与去重。
 * 运行：DSH_ARTIFACTS_HOME=<临时目录> node test/backfill.test.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { backfillFromSessions, extractPresented, scanZstdFrames } from '../backfill.js'
import { ArtifactStore } from '../store.js'

process.env.DSH_ARTIFACTS_HOME = mkdtempSync(join(tmpdir(), 'dsh-artifacts-bf-'))
const home = process.env.DSH_ARTIFACTS_HOME

// ---- 1. 帧扫描：多帧（有/无 checksum）+ 撕裂尾帧边界 ----
const payloadA = Buffer.from('a'.repeat(5000))
const payloadB = Buffer.from('{"x":1}\n'.repeat(400))
const fA = zstdCompressSync(payloadA, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
const fB = zstdCompressSync(payloadB) // 无 checksum 帧
const tornTail = fA.subarray(0, 10) // 模拟撕裂尾帧
const multi = Buffer.concat([fA, fB, tornTail])
const { frames, tornStart } = scanZstdFrames(multi)
assert.equal(frames.length, 2, '两个完整帧')
assert.equal(tornStart, fA.length + fB.length, '撕裂帧起点')
assert.ok(zstdDecompressSync(multi.subarray(frames[0].start, frames[0].end)).equals(payloadA), '帧 0 独立可解')
assert.ok(zstdDecompressSync(multi.subarray(frames[1].start, frames[1].end)).equals(payloadB), '帧 1 独立可解')

// ---- 2. 造一个完整会话日志并回填 ----
const sid = 'session-bf11aabb-0000-0000-0000-000000000001'
const sessDir = join(home, '.dsh', 'sessions', '--D--proj--turf--', sid)
mkdirSync(sessDir, { recursive: true })
const srcDir = join(home, 'work')
mkdirSync(srcDir, { recursive: true })
writeFileSync(join(srcDir, 'report.md'), '# 报告内容', 'utf8')
writeFileSync(join(srcDir, 'shot.png'), Buffer.from('89504e47fa', 'hex'))
const header = JSON.stringify({ type: 'session', version: 4, id: sid, cwd: 'D:\\proj\\turf', createdAt: 1794000000000 })
const evOther = JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { text: 'hi' } })
const evPresented = JSON.stringify({
  type: 'deliverables/presented', seq: 2, time: 2,
  data: { turn: 1, callId: 'c1', files: [
    { path: join(srcDir, 'report.md'), description: '最终报告' },
    { path: join(srcDir, 'shot.png') },
    { path: join(srcDir, 'gone.bin') }, // 已不存在 → missing
    { path: '' }, // 空路径 → 忽略
  ] },
})
const evPresentedDup = JSON.stringify({
  type: 'deliverables/presented', seq: 3, time: 3,
  data: { turn: 2, callId: 'c2', files: [{ path: join(srcDir, 'report.md'), description: '重复交付' }] },
})
writeFileSync(join(sessDir, 'session.v4.jsonl.zstd'), Buffer.concat([
  zstdCompressSync(Buffer.from(header + '\n')),
  zstdCompressSync(Buffer.from(evOther + '\n' + evPresented + '\n')),
  zstdCompressSync(Buffer.from(evPresentedDup + '\n')),
]))

const store = new ArtifactStore()
const stats = await backfillFromSessions(store, { maxFiles: 10 })
assert.deepEqual(
  { scanned: stats.scanned, added: stats.added, duplicates: stats.duplicates, missing: stats.missing },
  { scanned: 1, added: 2, duplicates: 1, missing: 1 },
  '收集 2、去重 1、缺失 1：' + JSON.stringify(stats),
)
const items = store.load()
assert.equal(items.length, 2)
const md = items.find((it) => it.name === 'report.md')
assert.equal(md.source, 'turf · 会话 bf11aabb', '来源标签: ' + md.source)
assert.equal(md.note, '最终报告')
assert.ok(existsSync(join(store.root, 'files', md.stored)), '内容落盘')

// ---- 3. extractPresented 直接调用 ----
const ex = await extractPresented(join(sessDir, 'session.v4.jsonl.zstd'))
assert.equal(ex.lines.length, 2)
assert.equal(ex.header.cwd, 'D:\\proj\\turf')

// ---- 4. 重复回填：全部 duplicate（幂等）——report/shot/report 重复交付 共 3 次 dup ----
const stats2 = await backfillFromSessions(store, { maxFiles: 10 })
assert.equal(stats2.added, 0)
assert.equal(stats2.duplicates, 3)

// ---- 5. days 窗口：mtime 是现在，days=1 应仍包含 ----
const stats3 = await backfillFromSessions(store, { maxFiles: 10, days: 1 })
assert.equal(stats3.scanned, 1)

rmSync(home, { recursive: true, force: true })
console.log('backfill tests passed ✓')
