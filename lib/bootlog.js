/**
 * 解析 DSH 宿主启动日志里“插件没有激活”的段落，并归因到具体插件。
 *
 * DSH 启动时会把结论打印到 stdout，两种格式（0.2.x 实测）：
 *
 *   dsh: warning: 1 entry did not activate
 *   better-sidebar (dsh-better-sidebar): pending (waiting for service: webRuntime)
 *
 *   dsh: startup failed: 1 required plugin did not activate
 *
 *   Failed plugins (9):
 *     web-runtime (required)
 *       Package: @deepseek-ai/dsh-web-app
 *       failed to import: file:///.../dsh-web-app/lib/index.js:7
 *       SyntaxError: The requested module ... does not provide an export named 'addHarnessSourceSection'
 *
 * 这类信息是 peerDependencies 版本检查抓不到的：插件 peer 区间满足、装得上，
 * 但依赖的服务在新版本里被删掉/改名，宿主启动时它就停在 pending。
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/** 行首的时间戳前缀（runner 会给自己的输出加一列时间）。 */
const RE_TIMESTAMP = /^\[\d{4}-\d{2}-\d{2}T[^\]]*\]\s*/

/** `dsh: warning: 3 entries did not activate` */
const RE_COUNT_WARNING = /^dsh: warning: (\d+) entr(?:y|ies) did not activate$/

/** `dsh: startup failed: 1 required plugin did not activate` */
const RE_COUNT_REQUIRED = /^dsh: startup failed: (\d+) required plugins? did not activate$/

/** `Failed plugins (9):` */
const RE_FAILED_HEADER = /^Failed plugins \((\d+)\):?$/

/** `better-sidebar (dsh-better-sidebar): pending (waiting for service: webRuntime)` */
const RE_ENTRY_LINE = /^(\S[^(]*?)\s*\(([^)]+)\):\s*(.+)$/

/** pending 的具体原因 */
const RE_PENDING = /^pending \(waiting for service:\s*([^)]+)\)$/

/** 其他未激活原因 */
const RE_NOT_ACTIVATED = /^(?:failed to activate|did not activate|inactive)[:. ]*(.*)$/

/** Failed plugins 段里的条目行：`  web-runtime (required)` */
const RE_BLOCK_ENTRY = /^ {2}(\S[^\n]*?)(?: \((required)\))?$/

/** Failed plugins 段里的包名行：`    Package: @deepseek-ai/dsh-web-app` */
const RE_BLOCK_PACKAGE = /^ {4}Package:\s*(.+)$/

/** Failed plugins 段里的细节行（缩进四格） */
const RE_BLOCK_DETAIL = /^ {4}(\S[^\n]*)$/

/**
 * 去掉 runner 加的时间戳前缀，并统一换行与行尾空白。
 * @param {string} line
 * @returns {string}
 */
function normalizeLine(line) {
  return line.replace(RE_TIMESTAMP, '').replace(/\r$/, '').trimEnd()
}

/**
 * 把 `Failed plugins (N):` 之后的缩进段落解析成条目。
 * @param {string[]} lines 已 normalize 的行
 * @param {number} start 段落首行（`Failed plugins` 的下一行）下标
 * @returns {{entries: Array<object>, nextIndex: number}}
 */
function parseFailedBlock(lines, start) {
  /** @type {Array<object>} */
  const entries = []
  /** @type {object | null} */
  let current = null
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      index += 1
      break
    }
    // 段落结束：出现非缩进行
    if (!/^\s/.test(line)) break
    const entryMatch = RE_BLOCK_ENTRY.exec(line)
    const packageMatch = RE_BLOCK_PACKAGE.exec(line)
    const detailMatch = RE_BLOCK_DETAIL.exec(line)
    if (entryMatch && !packageMatch) {
      // 新的入口名行：两个空格缩进
      current = {
        entry: entryMatch[1].trim(),
        packageName: null,
        required: entryMatch[2] === 'required',
        reason: 'failed',
        message: '',
        importError: null,
      }
      entries.push(current)
    } else if (packageMatch) {
      if (current) current.packageName = packageMatch[1].trim()
    } else if (detailMatch) {
      if (current) {
        const detail = detailMatch[1]
        if (/^failed to import:/.test(detail)) {
          current.importError = detail.replace(/^failed to import:\s*/, '').trim()
        }
        current.message = current.message ? `${current.message} ${detail}` : detail
      }
    }
    index += 1
  }
  return { entries, nextIndex: index }
}

/**
 * 从一段日志文本里提取所有“未激活”信息。
 * @param {string} text
 * @returns {{
 *   warnings: Array<{entry: string, packageName: string | null, reason: string, service: string | null, message: string, required: boolean, importError: string | null}>,
 *   pendingCount: number | null,
 *   requiredMissing: number | null,
 *   failedBlockCount: number,
 *   lines: number,
 * }}
 */
export function parseActivationWarnings(text) {
  const raw = String(text ?? '').split(/\n/)
  const lines = raw.map(normalizeLine)
  /** @type {Array<object>} */
  const warnings = []
  let pendingCount = null
  let requiredMissing = null
  let failedBlockCount = 0

  const push = (warning) => {
    const key = `${warning.entry}|${warning.packageName ?? ''}|${warning.reason}|${warning.service ?? ''}`
    const seen = warnings.some(
      (item) => `${item.entry}|${item.packageName ?? ''}|${item.reason}|${item.service ?? ''}` === key,
    )
    if (!seen) warnings.push(warning)
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line) continue

    const countWarning = RE_COUNT_WARNING.exec(line)
    if (countWarning) {
      pendingCount = Number(countWarning[1])
      continue
    }
    const countRequired = RE_COUNT_REQUIRED.exec(line)
    if (countRequired) {
      requiredMissing = Number(countRequired[1])
      continue
    }
    const failedHeader = RE_FAILED_HEADER.exec(line)
    if (failedHeader) {
      const block = parseFailedBlock(lines, index + 1)
      failedBlockCount = block.entries.length
      for (const entry of block.entries) {
        push({
          entry: entry.entry,
          packageName: entry.packageName,
          reason: entry.required ? 'required' : 'failed',
          service: null,
          message: entry.message.slice(0, 400),
          required: entry.required,
          importError: entry.importError,
        })
      }
      index = block.nextIndex - 1
      continue
    }

    const entryLine = RE_ENTRY_LINE.exec(line)
    if (entryLine) {
      const entry = entryLine[1].trim()
      const packageName = entryLine[2].trim()
      const reason = entryLine[3].trim()
      // 排除明显不是激活信息的行（例如 “健康检查：HTTP 404” 里的括号）
      const pending = RE_PENDING.exec(reason)
      if (pending) {
        push({
          entry,
          packageName,
          reason: 'pending',
          service: pending[1].trim(),
          message: reason,
          required: false,
          importError: null,
        })
        continue
      }
      const notActivated = RE_NOT_ACTIVATED.exec(reason)
      if (notActivated) {
        push({
          entry,
          packageName,
          reason: 'failed',
          service: null,
          message: reason.slice(0, 400),
          required: false,
          importError: null,
        })
      }
    }
  }

  return { warnings, pendingCount, requiredMissing, failedBlockCount, lines: raw.length }
}

/**
 * 用中文说明一条未激活记录。
 * @param {{reason: string, service?: string | null, message?: string, importError?: string | null, required?: boolean}} warning
 * @returns {string}
 */
export function describeActivation(warning) {
  if (warning.reason === 'pending') {
    return `宿主启动时一直没激活：它在等 ${warning.service ?? '某个'} 服务。通常是新版本把这服务删掉或改名了，也可能是提供该服务的插件没启用`
  }
  if (warning.reason === 'required') {
    return '这是必需插件，它没激活会让 DSH 起不来'
  }
  if (warning.importError) {
    return `宿主启动时导入失败：${warning.importError}`
  }
  return `宿主启动时没有激活：${(warning.message ?? '').slice(0, 200) || '原因未在日志里写明'}`
}

/**
 * 把日志里的条目按包名归组，并尽量对应到体检表里的插件。
 * @param {ReturnType<typeof parseActivationWarnings>} parsed
 * @param {Array<{name: string, version?: string, status?: string, declaredRange?: string | null, isCore?: boolean}>} [plugins]
 * @returns {Array<{packageName: string, entries: Array<object>, explanation: string, plugin: object | null}>}
 */
export function attributeActivation(parsed, plugins = []) {
  const byPackage = new Map()
  for (const warning of parsed?.warnings ?? []) {
    const packageName = warning.packageName ?? warning.entry
    const bucket = byPackage.get(packageName) ?? { packageName, entries: [] }
    bucket.entries.push({ ...warning, explanation: describeActivation(warning) })
    byPackage.set(packageName, bucket)
  }
  const list = []
  for (const bucket of byPackage.values()) {
    const plugin = plugins.find((item) => item.name === bucket.packageName) ?? null
    const first = bucket.entries[0]
    const explanation =
      bucket.entries.length === 1
        ? first.explanation
        : bucket.entries.map((item) => `${item.entry}：${item.explanation}`).join('；')
    list.push({ packageName: bucket.packageName, entries: bucket.entries, explanation, plugin })
  }
  list.sort((left, right) => left.packageName.localeCompare(right.packageName))
  return list
}

/**
 * 在日志里找最后一次"重启"标记之后的字节偏移。
 *
 * 为什么需要：由升级任务写入的日志里，前面可能还有上一次（失败的那次）启动的输出，
 * 直接从头解析会把历史告警当成现在的。只取最后一次重启之后的部分才准确。
 * @param {string} logPath
 * @param {{marker?: string, maxBytes?: number}} [options]
 * @returns {number | null} 找不到标记时返回 null
 */
export function findLastRestartOffset(logPath, options = {}) {
  const marker = Buffer.from(options.marker ?? '重启：', 'utf8')
  const maxBytes = Math.max(Number(options.maxBytes ?? 8_000_000) || 8_000_000, 1024)
  let fd = null
  try {
    fd = openSync(logPath, 'r')
    const size = fstatSync(fd).size
    const from = Math.max(size - maxBytes, 0)
    const length = size - from
    if (length <= 0) return null
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, from)
    const index = buffer.lastIndexOf(marker)
    if (index < 0) return null
    let lineStart = index
    while (lineStart > 0 && buffer[lineStart - 1] !== 0x0a) lineStart -= 1
    return from + lineStart
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * 读日志文件的一段（默认从 offset 读到结尾，最多 4MB）。
 * @param {string} logPath
 * @param {{offset?: number, maxBytes?: number}} [options]
 * @returns {{text: string, fromOffset: number, size: number, truncated: boolean}}
 */
export function readLogSegment(logPath, options = {}) {
  const offset = Math.max(Number(options.offset ?? 0) || 0, 0)
  const maxBytes = Math.max(Number(options.maxBytes ?? 4_000_000) || 4_000_000, 1024)
  let size = 0
  let fd = null
  try {
    fd = openSync(logPath, 'r')
    size = fstatSync(fd).size
  } catch {
    if (fd !== null) closeSync(fd)
    return { text: '', fromOffset: offset, size: 0, truncated: false }
  }
  const from = Math.min(offset, size)
  const length = Math.min(size - from, maxBytes)
  const buffer = Buffer.alloc(length)
  try {
    if (length > 0) readSync(fd, buffer, 0, length, from)
  } finally {
    closeSync(fd)
  }
  return {
    text: buffer.toString('utf8'),
    fromOffset: from,
    size,
    truncated: from + length < size,
  }
}

/**
 * 扫一段启动日志，产出可直接塞进 /status 的结构。
 * @param {string} logPath
 * @param {{offset?: number, plugins?: Array<object>}} [options]
 * @returns {{
 *   ok: boolean,
 *   groups: ReturnType<typeof attributeActivation>,
 *   summary: {count: number, packages: string[], summary: string},
 *   pendingCount: number | null,
 *   requiredMissing: number | null,
 *   fromOffset: number,
 *   bytesRead: number,
 *   truncated: boolean,
 *   scannedAt: number,
 * }}
 */
export function scanActivation(logPath, options = {}) {
  const segment = readLogSegment(logPath, { offset: options.offset ?? 0 })
  const parsed = parseActivationWarnings(segment.text)
  const groups = attributeActivation(parsed, options.plugins ?? [])
  return {
    ok: true,
    groups,
    summary: summarizeActivation(groups, parsed),
    pendingCount: parsed.pendingCount,
    requiredMissing: parsed.requiredMissing,
    fromOffset: segment.fromOffset,
    bytesRead: Buffer.byteLength(segment.text, 'utf8'),
    truncated: segment.truncated,
    scannedAt: Date.now(),
  }
}

/**
 * overall：给 UI 用的一句话结论。
 * @param {ReturnType<typeof attributeActivation>} groups
 * @param {{requiredMissing?: number | null}} [parsed]
 * @returns {{count: number, packages: string[], summary: string}}
 */
export function summarizeActivation(groups, parsed = {}) {
  const count = groups.length
  if (count === 0) {
    return { count: 0, packages: [], summary: '宿主启动时所有插件都激活了' }
  }
  const names = groups.map((group) => group.packageName)
  const required = Number(parsed?.requiredMissing ?? 0)
  const prefix = required > 0 ? `${required} 个必需插件没激活（DSH 会起不来）；` : ''
  return {
    count,
    packages: names,
    summary: `${prefix}有 ${count} 个插件在宿主启动时没有激活：${names.join('、')}`,
  }
}
