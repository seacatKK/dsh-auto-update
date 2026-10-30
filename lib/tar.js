/**
 * 纯 Node 的 .tar.gz 解包器。
 *
 * 为什么不用系统 tar：回滚是一条"出问题时才走"的路，它最不该依赖外部程序。
 * 实测本机有两条坑：`tar.exe` 会把以 `@` 开头的成员名当成"从文件读列表"（scoped 包名必然踩），
 * 而某些受限环境里从脱离的后代进程 spawn 出来的 exe 会直接 0xC0000142 起不来。
 * 用 zlib（Node 内建）+ 自己解 tar 头，就没有这些不确定性，也不挑平台。
 */

import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, symlinkSync, writeSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const BLOCK = 512

/** 读定长字符串字段（到第一个 NUL 为止）。 */
function readString(block, offset, length) {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8')
}

/** 读八进制数字字段，兼容 base-256 编码（超长文件用）。 */
function readNumber(block, offset, length) {
  if (block[offset] & 0x80) {
    let value = 0
    for (let index = offset + 1; index < offset + length; index += 1) value = value * 256 + block[index]
    return value
  }
  const text = readString(block, offset, length).trim()
  if (!text) return 0
  const value = Number.parseInt(text, 8)
  return Number.isFinite(value) ? value : 0
}

/** 解析 pax 扩展头里的 "key=value\n" 记录。 */
function parsePax(buffer) {
  const fields = {}
  let offset = 0
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(buffer.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = buffer.subarray(space + 1, offset + length - 1).toString('utf8')
    const equal = record.indexOf('=')
    if (equal > 0) fields[record.slice(0, equal)] = record.slice(equal + 1)
    offset += length
  }
  return fields
}

/**
 * 解包 .tar.gz 到目录。
 *
 * @param {string} tarPath
 * @param {string} destDir
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {Promise<{ok: boolean, files: number, links: number, skipped: number, error?: string}>}
 */
export async function extractTarGz(tarPath, destDir, options = {}) {
  const log = options.log ?? (() => {})
  mkdirSync(destDir, { recursive: true })

  let buffer = Buffer.alloc(0)
  let current = null // 正在写入的文件 { fd, remaining, path }
  let longName = null
  let longLink = null
  let pax = {}
  let globalPax = {}
  let stop = false
  let files = 0
  let links = 0
  let skipped = 0

  // 写入当前文件的数据；tar 的条目数据按 512 字节对齐，写完还要吃掉 padding，
  // 否则下一次读到的"头"会落在 padding 中间，路径就会变成半截（实测坑）。
  const drainCurrent = () => {
    while (current && buffer.length > 0) {
      if (current.remaining > 0) {
        const take = Math.min(current.remaining, buffer.length)
        writeSync(current.fd, buffer, 0, take)
        current.remaining -= take
        buffer = buffer.subarray(take)
        continue
      }
      if (current.padding > 0) {
        const take = Math.min(current.padding, buffer.length)
        current.padding -= take
        buffer = buffer.subarray(take)
        continue
      }
      closeSync(current.fd)
      current = null
    }
    if (current && buffer.length === 0 && current.remaining === 0 && current.padding === 0) {
      closeSync(current.fd)
      current = null
    }
  }

  const applyHeader = (block) => {
    const rawName = readString(block, 0, 100)
    const prefix = readString(block, 345, 155)
    const type = String.fromCharCode(block[156] || 0x30)
    const linkname = readString(block, 157, 100)
    const size = readNumber(block, 124, 12)

    if (type === 'L') {
      longName = { size }
      return { kind: 'longname', size }
    }
    if (type === 'K') {
      longLink = { size }
      return { kind: 'longlink', size }
    }
    if (type === 'x' || type === 'X') return { kind: 'pax', size }
    if (type === 'g') return { kind: 'pax-global', size }

    let name = pax.path ?? (prefix ? `${prefix}/${rawName}` : rawName)
    if (longName?.value) name = longName.value
    let target = linkname
    if (pax.linkpath) target = pax.linkpath
    if (longLink?.value) target = longLink.value
    const effectiveSize = Number.isFinite(Number(pax.size)) && pax.size !== undefined ? Number(pax.size) : size
    pax = { ...globalPax }
    longName = null
    longLink = null

    if (!name || name === './' || name === '.') return { kind: 'skip', size: effectiveSize }
    const full = join(destDir, name)

    if (type === '5' || name.endsWith('/')) {
      mkdirSync(full, { recursive: true })
      return { kind: 'skip', size: 0 }
    }

    mkdirSync(dirname(full), { recursive: true })

    if (type === '2') {
      // pnpm 的 node_modules 全是"目录符号链接"，Windows 上目录用 junction 不需要管理员权限
      const absolute = isAbsolute(target) ? target : resolve(dirname(full), target)
      try {
        symlinkSync(target, full, 'dir')
      } catch {
        try {
          symlinkSync(absolute, full, 'junction')
        } catch (error) {
          log(`跳过符号链接 ${name}（${error.code ?? error.message}）`)
          skipped += 1
        }
      }
      links += 1
      return { kind: 'skip', size: 0 }
    }

    if (type === '1') {
      const source = resolve(destDir, target)
      try {
        linkSync(source, full)
        links += 1
      } catch {
        try {
          copyFileSync(source, full)
          files += 1
        } catch (error) {
          log(`跳过硬链接 ${name}（${error.code ?? error.message}）`)
          skipped += 1
        }
      }
      return { kind: 'skip', size: 0 }
    }

    if (type === '0' || type === '7') {
      files += 1
      return { kind: 'file', size: effectiveSize, path: full }
    }

    skipped += 1
    return { kind: 'skip', size: effectiveSize }
  }

  // 扩展头（长名 / pax）要先把它的数据块收全，才能知道下一个条目的真名
  let meta = null // { plan, data: Buffer, need: number }
  const consume = () => {
    while (!stop) {
      if (current) {
        drainCurrent()
        if (current) return
        continue
      }
      if (meta) {
        const take = Math.min(meta.need - meta.data.length, buffer.length)
        meta.data = Buffer.concat([meta.data, buffer.subarray(0, take)])
        buffer = buffer.subarray(take)
        if (meta.data.length < meta.need) return
        const padded = Math.ceil(meta.need / BLOCK) * BLOCK - meta.need
        buffer = buffer.subarray(Math.min(padded, buffer.length))
        const plan = meta.plan
        const data = meta.data.subarray(0, meta.need)
        meta = null
        if (plan.kind === 'longname') longName = { value: data.toString('utf8') }
        else if (plan.kind === 'longlink') longLink = { value: data.toString('utf8') }
        else if (plan.kind === 'pax') pax = { ...pax, ...parsePax(data) }
        else if (plan.kind === 'pax-global') globalPax = { ...globalPax, ...parsePax(data) }
        continue
      }
      if (buffer.length < BLOCK) return
      const block = buffer.subarray(0, BLOCK)
      if (block.every((byte) => byte === 0)) {
        stop = true
        return
      }
      buffer = buffer.subarray(BLOCK)
      const plan = applyHeader(block)
      if (!plan || plan.kind === 'skip') continue
      if (plan.kind === 'file') {
        if (plan.size === 0) {
          closeSync(openSync(plan.path, 'w'))
          continue
        }
        current = {
          fd: openSync(plan.path, 'w'),
          remaining: plan.size,
          padding: Math.ceil(plan.size / BLOCK) * BLOCK - plan.size,
          path: plan.path,
        }
        continue
      }
      // 长名 / pax 扩展头：先取数据，再决定后续条目
      const dataSize = plan.size
      if (dataSize === 0) {
        continue
      }
      meta = { plan, data: Buffer.alloc(0), need: dataSize }
    }
  }

  try {
    for await (const chunk of createReadStream(tarPath).pipe(createGunzip())) {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
      consume()
      if (stop) break
    }
  } catch (error) {
    if (current) {
      try {
        closeSync(current.fd)
      } catch {
        // 忽略
      }
    }
    return { ok: false, files, links, skipped, error: `解包失败：${error.message}` }
  }

  if (current) {
    try {
      closeSync(current.fd)
    } catch {
      // 忽略
    }
  }
  log(`解包完成：文件 ${files} 个，链接 ${links} 个${skipped ? `，跳过 ${skipped} 个` : ''}`)
  return { ok: true, files, links, skipped }
}

/** 目标目录里是否已经有解出来的东西（用于判断备份是否可用）。 */
export function looksExtracted(dir) {
  return existsSync(dir)
}
