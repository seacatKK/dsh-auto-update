/**
 * 极简语义化版本实现（本插件不引入任何第三方依赖）。
 *
 * 为什么自己写：插件在 profile/node_modules 里运行，能不能 require 到 semver
 * 取决于宿主装了谁；而"插件是否兼容新版 DSH"这个判断恰好是升级前唯一的护栏，
 * 不能因为少装一个包就静默降级。
 *
 * 语义与 node-semver 对齐，重点是 `satisfies(version, range, { includePrerelease })`：
 * DSH 官方 `evaluatePluginCompatibility()` 用的就是 `includePrerelease: true`
 * （预发布版参与区间比较）。两条口径必须一致，否则本插件说"兼容"、宿主说
 * "不兼容"，用户会在升级后看到一个和检查结果相反的警告。
 */

const VERSION_RE =
  /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/
const PARTIAL_RE =
  /^[vV]?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/

/** 解析完整版本号；非法返回 null。 */
export function parse(input) {
  if (typeof input !== 'string') return null
  const match = VERSION_RE.exec(input.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
    raw: input.trim(),
  }
}

export function valid(input) {
  return parse(input) === null ? null : input.trim()
}

/** 是否为预发布版（带 `-rc.1` 之类后缀）。 */
export function isPrerelease(input) {
  const v = parse(input)
  return v !== null && v.prerelease.length > 0
}

/** 预发布标识（`0.2.1-rc.4` → `rc`）；正式版返回 null。 */
export function prereleaseId(input) {
  const v = parse(input)
  if (v === null || v.prerelease.length === 0) return null
  return /^\d+$/.test(v.prerelease[0]) ? '0' : v.prerelease[0]
}

/** 主版本.次版本.补丁号（忽略预发布后缀）。 */
export function triple(input) {
  const v = parse(input)
  return v === null ? null : `${v.major}.${v.minor}.${v.patch}`
}

function compareIdentifiers(a, b) {
  const anum = /^\d+$/.test(a)
  const bnum = /^\d+$/.test(b)
  if (anum && bnum) {
    const an = Number(a)
    const bn = Number(b)
    return an === bn ? 0 : an < bn ? -1 : 1
  }
  if (anum) return -1
  if (bnum) return 1
  return a === b ? 0 : a < b ? -1 : 1
}

/** 比较两个版本，返回 -1 / 0 / 1；任一非法抛错（调用方应先 valid 校验）。 */
export function compare(a, b) {
  const left = typeof a === 'string' ? parse(a) : a
  const right = typeof b === 'string' ? parse(b) : b
  if (left === null || right === null) throw new Error(`invalid semver in compare(): ${String(a)} / ${String(b)}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  const lp = left.prerelease
  const rp = right.prerelease
  if (lp.length === 0 && rp.length === 0) return 0
  // 有预发布后缀的版本永远小于同号正式版
  if (lp.length === 0) return 1
  if (rp.length === 0) return -1
  const length = Math.max(lp.length, rp.length)
  for (let i = 0; i < length; i += 1) {
    if (lp[i] === undefined) return -1
    if (rp[i] === undefined) return 1
    const order = compareIdentifiers(lp[i], rp[i])
    if (order !== 0) return order
  }
  return 0
}

export const gt = (a, b) => compare(a, b) > 0
export const gte = (a, b) => compare(a, b) >= 0
export const lt = (a, b) => compare(a, b) < 0
export const lte = (a, b) => compare(a, b) <= 0
export const eq = (a, b) => compare(a, b) === 0

/** 宽松解析区间片段（允许 1 / 1.2 / 1.2.x / * ）。 */
function partial(input) {
  const match = PARTIAL_RE.exec(input.trim())
  if (match === null) return null
  const wild = (part) => part === undefined || part === 'x' || part === 'X' || part === '*'
  return {
    major: wild(match[1]) ? null : Number(match[1]),
    minor: wild(match[2]) ? null : Number(match[2]),
    patch: wild(match[3]) ? null : Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** 组装内部版本对象。 */
function makeVersion(major, minor, patch, prerelease = []) {
  return { major, minor, patch, prerelease, raw: `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join('.')}` : ''}` }
}

/** 上界哨兵版本 `x.y.0-0`：预发布 `-0` 让它严格小于所有 x.y.0 正式版与预发布版。 */
function upperVersion(major, minor) {
  return makeVersion(major, minor, 0, ['0'])
}

/** 生成"小于上界哨兵"的比较器。 */
function upperComparator(major, minor) {
  return { op: '<', version: upperVersion(major, minor) }
}

const ANY = { op: '>=', version: makeVersion(0, 0, 0) }

function expandCaret(p) {
  const { major, minor, patch, prerelease } = p
  if (major === null) return [ANY]
  // ^1.2.x → [1.2.0, 2.0.0) ；^0.2.x → [0.2.0, 0.3.0) ；^0.0.x → [0.0.0, 0.1.0)
  if (patch === null) {
    const lower = makeVersion(major, minor ?? 0, 0, prerelease)
    if (major !== 0) return [{ op: '>=', version: lower }, upperComparator(major + 1, 0)]
    if (minor === null) return [{ op: '>=', version: lower }, upperComparator(1, 0)]
    if (minor !== 0) return [{ op: '>=', version: lower }, upperComparator(0, minor + 1)]
    return [{ op: '>=', version: lower }, { op: '<', version: makeVersion(0, 1, 0, ['0']) }]
  }
  const lower = { op: '>=', version: makeVersion(major, minor, patch, prerelease) }
  let upper
  if (major !== 0) upper = upperComparator(major + 1, 0)
  else if (minor !== 0) upper = upperComparator(0, minor + 1)
  else upper = { op: '<', version: makeVersion(0, 0, patch + 1, ['0']) }
  return [lower, upper]
}

function expandTilde(p) {
  const { major, minor, patch, prerelease } = p
  if (major === null) return [ANY]
  const lower = { op: '>=', version: makeVersion(major, minor ?? 0, patch ?? 0, prerelease) }
  const upper = minor === null ? upperComparator(major + 1, 0) : upperComparator(major, minor + 1)
  return [lower, upper]
}

function expandXRange(p) {
  // 1.2.x → [1.2.0, 1.3.0) ；1.x → [1.0.0, 2.0.0) ；* → 任意
  const { major, minor, patch, prerelease } = p
  if (major === null) return [ANY]
  if (minor === null) return [{ op: '>=', version: makeVersion(major, 0, 0, prerelease) }, upperComparator(major + 1, 0)]
  if (patch === null) return [{ op: '>=', version: makeVersion(major, minor, 0, prerelease) }, upperComparator(major, minor + 1)]
  return [{ op: '=', version: makeVersion(major, minor, patch, prerelease) }]
}

const OPERATOR_RE = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/

/** 把一个区间片段展开成比较器数组（返回 null 表示无法解析）。 */
function comparatorsOf(token) {
  const match = OPERATOR_RE.exec(token)
  if (match === null) return null
  const op = match[1] === undefined ? '' : match[1]
  const rest = match[2].trim()
  const p = partial(rest)
  if (p === null) return null
  const hasWildcard = p.major === null || p.minor === null || p.patch === null
  switch (op) {
    case '^':
      if (hasWildcard) return expandXRange(p)
      return expandCaret(p)
    case '~':
      return expandTilde(p)
    case '>':
    case '>=':
    case '<':
    case '<=':
      if (p.major === null) return op.startsWith('>') ? [ANY] : null
      if (p.minor === null) {
        // >1 视为 >=2.0.0 ；<=1 视为 <2.0.0
        const base = makeVersion(p.major, 0, 0, p.prerelease)
        if (op === '>') return [{ op: '>=', version: makeVersion(p.major + 1, 0, 0) }]
        if (op === '>=') return [{ op: '>=', version: base }]
        if (op === '<') return [{ op: '<', version: base }]
        return [{ op: '<', version: makeVersion(p.major + 1, 0, 0, ['0']) }]
      }
      if (p.patch === null) {
        const nextMinor = makeVersion(p.major, p.minor + 1, 0, ['0'])
        const base = makeVersion(p.major, p.minor, 0, p.prerelease)
        if (op === '>=') return [{ op: '>=', version: base }]
        if (op === '>') return [{ op: '>=', version: nextMinor }]
        if (op === '<') return [{ op: '<', version: base }]
        return [{ op: '<', version: nextMinor }]
      }
      return [{ op, version: makeVersion(p.major, p.minor, p.patch, p.prerelease) }]
    case '=':
    case '':
      if (hasWildcard) return expandXRange(p)
      return [{ op: '=', version: makeVersion(p.major, p.minor, p.patch, p.prerelease) }]
    default:
      return null
  }
}

const cache = new Map()

/** 版本对象 → `1.2.3-rc.1` 这样可直接喂给 comparatorsOf() 的文本。 */
function textOf(p) {
  const base = `${p.major}.${p.minor}.${p.patch}`
  return p.prerelease.length === 0 ? base : `${base}-${p.prerelease.join('.')}`
}

/**
 * 连字符区间 `A - B` 的展开，口径与 node-semver 的 hyphenReplace 一致：
 * includePrerelease 为真时两端都补 `-0` 哨兵，否则下界原样、上界补一位。
 */
function expandHyphen(fromText, toText, includePrerelease) {
  const from = partial(fromText)
  const to = partial(toText)
  if (from === null || to === null) return `>=${fromText} <=${toText}`
  const parts = []
  if (from.major === null) parts.push('>=0.0.0')
  else {
    const lowerBase = `${from.major}.${from.minor ?? 0}.${from.patch ?? 0}`
    const suffix = from.prerelease.length > 0
      ? `-${from.prerelease.join('.')}`
      : includePrerelease ? '-0' : ''
    parts.push(`>=${lowerBase}${suffix}`)
  }
  if (to.major !== null) {
    if (to.minor === null) parts.push(`<${to.major + 1}.0.0-0`)
    else if (to.patch === null) parts.push(`<${to.major}.${to.minor + 1}.0-0`)
    else if (to.prerelease.length > 0) parts.push(`<=${textOf(to)}`)
    else if (includePrerelease) parts.push(`<${to.major}.${to.minor}.${to.patch + 1}-0`)
    else parts.push(`<=${textOf(to)}`)
  }
  return parts.join(' ')
}

/**
 * 解析区间（`||` 分隔的并集）；无法解析返回 null。
 * @param {string} range
 * @param {{includePrerelease?: boolean}} [options]
 */
export function parseRange(range, options = {}) {
  if (typeof range !== 'string') return null
  const trimmed = range.trim()
  if (trimmed === '') return null
  const includePrerelease = options.includePrerelease === true
  const key = `${includePrerelease ? 'p' : 's'}\u0000${trimmed}`
  if (cache.has(key)) return cache.get(key)
  const alternatives = trimmed.split('||').map((part) => {
    let text = part.trim()
    if (text === '') return null
    // 连字符区间：1.2.3 - 2.3.4
    text = text.replace(/(\S+)\s+-\s+(\S+)/g, (_, from, to) => expandHyphen(from, to, includePrerelease))
    // `>= 0.2.0` 这类"操作符与版本号之间有空格"的写法（node-semver 的 comparatorTrimReplace）
    text = text.replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
    const tokens = text.split(/\s+/).filter(Boolean)
    const comparators = []
    for (const token of tokens) {
      const expanded = comparatorsOf(token)
      if (expanded === null) return null
      comparators.push(...expanded)
    }
    return comparators.length === 0 ? null : comparators
  })
  if (alternatives.some((item) => item === null)) {
    cache.set(key, null)
    return null
  }
  cache.set(key, alternatives)
  return alternatives
}

function testComparator(comparator, version) {
  const order = compare(version, comparator.version)
  switch (comparator.op) {
    case '>=':
      return order >= 0
    case '>':
      return order > 0
    case '<':
      return order < 0
    case '<=':
      return order <= 0
    case '=':
      return order === 0
    default:
      return false
  }
}

function sameTriple(a, b) {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch
}

/**
 * 版本是否满足区间。
 * @param {string} version
 * @param {string} range
 * @param {{includePrerelease?: boolean}} [options] - DSH 官方口径用 includePrerelease: true
 */
export function satisfies(version, range, options = {}) {
  const parsedVersion = parse(version)
  if (parsedVersion === null) return false
  // 宿主把 workspace:^ / workspace:~ / workspace:* 映射成"就是当前运行时版本"
  if (range === 'workspace:^' || range === 'workspace:~' || range === 'workspace:*') return true
  const alternatives = parseRange(range, options)
  if (alternatives === null) return false
  const includePrerelease = options.includePrerelease === true
  for (const comparators of alternatives) {
    if (!comparators.every((comparator) => testComparator(comparator, parsedVersion))) continue
    if (includePrerelease || parsedVersion.prerelease.length === 0) return true
    // 不含 includePrerelease 时，node-semver 要求区间里存在同号预发布比较器
    if (comparators.some((comparator) => comparator.version.prerelease.length > 0 && sameTriple(comparator.version, parsedVersion))) return true
  }
  return false
}

/** 区间里能取到的最大版本（用于查 registry 上"哪个版本兼容目标"）。 */
export function maxSatisfying(versions, range, options = {}) {
  let best = null
  for (const version of versions) {
    if (parse(version) === null) continue
    if (!satisfies(version, range, options)) continue
    if (best === null || gt(version, best)) best = version
  }
  return best
}

/** 升序排序版本号（非法值排在前面）。 */
export function sortVersions(versions) {
  return [...versions].sort((a, b) => {
    if (parse(a) === null) return -1
    if (parse(b) === null) return 1
    return compare(a, b)
  })
}

/** 取一组版本里的最高版（忽略非法值）。 */
export function highest(versions) {
  let best = null
  for (const version of versions) {
    if (parse(version) === null) continue
    if (best === null || gt(version, best)) best = version
  }
  return best
}

/**
 * 从高到低排序（新 → 旧，非法值排最后）。
 * @param {string[]} versions
 * @returns {string[]}
 */
export function sortDesc(versions) {
  return sortVersions(versions).reverse()
}
