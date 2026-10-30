/**
 * 本地插件清单与"升级到目标 DSH 版本后还能不能跑"的判定。
 *
 * 判定口径必须与 DSH 官方一致：`@deepseek-ai/dsh-app-boot` 的
 * `evaluatePluginCompatibility()` 只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
 * 的 peerDependencies，比较用 `semver.satisfies(runtime, range, {includePrerelease:true})`。
 * 这里用自带的 semver 复刻同一口径（test/semver-oracle.mjs 与官方实现逐项对拍过），
 * 避免为了一个区间判断去依赖会随 DSH 升级而改名/搬迁的内部包。
 *
 * 在此之上补充官方没覆盖、但真的会导致插件跑不起来的三类证据：
 * - `dsh.compatibility.dsh` 作者自述的已验证版本清单（只提醒，不算失败）；
 * - `engines.node` 与当前 Node 主版本冲突；
 * - 声明了 `dsh.client` 但 `exports['./client']` 产物缺失（浏览器端起不来）；
 * 以及 `link:` 本地插件（不随 npm 更新）、含 `.node` 原生模块（需按新 ABI 重编译）。
 * @module dsh-auto-update/compat
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { gt, satisfies, sortDesc, valid } from './semver.js'

/** 会被官方兼容性检查纳入的 peer 前缀。 */
const HARNESS_PREFIX = '@deepseek-ai/dsh'

/** 本插件自己的包名（体检时跳过它）。 */
const SELF_NAME = 'dsh-auto-update'

/**
 * @typedef {object} PluginReason
 * @property {string} code   机器可读的原因码
 * @property {'blocker' | 'warning' | 'info'} level
 * @property {string} message 给人看的一句话
 * @property {string} [detail] 细节（区间、期望值、实测值）
 */

/**
 * @typedef {object} PluginEntry
 * @property {string} name
 * @property {string | null} version
 * @property {string} spec          profile package.json 里的依赖写法
 * @property {boolean} isLink       link:/file: 本地插件
 * @property {string | null} dir    已安装目录
 * @property {boolean} hasClient    声明了浏览器端 bundle
 * @property {string[]} clientInject
 * @property {Record<string, string>} peerDependencies
 * @property {Record<string, string>} engines
 * @property {string | null} declaredDshRange  作者自述兼容区间
 * @property {string[]} declaredDshReleases
 * @property {'ok' | 'incompatible' | 'unknown' | 'local' | 'missing' | 'core'} status
 * @property {boolean} isCore   官方 @deepseek-ai/* 包（随 DSH 一起替换，不算用户插件）
 * @property {PluginReason[]} reasons
 * @property {{version: string, peers: Record<string, string>}[]} peerMismatches
 * @property {string | null} upgradeTo  建议升级到的版本（由 registry 补齐）
 */

/**
 * 读取 profile 的 package.json 里登记的插件。
 * @param {string} profileDir
 * @returns {{dependencies: Record<string, string>, bundles: string[], manifest: any}}
 */
export function readProfilePlugins(profileDir) {
  const path = join(profileDir, 'package.json')
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    manifest = null
  }
  const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((entry) => typeof entry === 'string')
    : []
  return { dependencies, bundles, manifest }
}

/**
 * 本插件自己是否在 profile 的 `dsh.profile.bundles` 清单里。
 *
 * DSH 启动时只挂载清单里列出的 bundle：`dsh plugin add` 只把包装进 `node_modules`，
 * 不写清单，插件就不会被加载——这个检查用来发现那种"装了但没生效"的状态。
 * @param {string} profileDir
 * @param {string} [name]
 * @returns {{mounted: boolean, installed: boolean, hint: string}}
 */
export function describeSelfMount(profileDir, name = 'dsh-auto-update') {
  const { bundles, dependencies } = readProfilePlugins(profileDir)
  const installed = Object.keys(dependencies).includes(name)
  const mounted = bundles.includes(name)
  if (mounted) return { mounted: true, installed, hint: '' }
  const hint = installed
    ? '已在 node_modules 里，但没写进 dsh.profile.bundles，宿主不会加载它。跑 node scripts/install.mjs 补上。'
    : '还没安装。跑 node scripts/install.mjs 一步装好（依赖 + 清单）。'
  return { mounted: false, installed, hint }
}

/**
 * 读取一个已安装插件的 manifest。
 * @param {string} profileDir
 * @param {string} name
 * @returns {{manifest: any, dir: string} | null}
 */
export function readPluginManifest(profileDir, name) {
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    const manifestPath = require.resolve(`${name}/package.json`)
    return { manifest: JSON.parse(readFileSync(manifestPath, 'utf8')), dir: dirname(manifestPath) }
  } catch {
    const fallback = join(profileDir, 'node_modules', name, 'package.json')
    if (!existsSync(fallback)) return null
    try {
      return { manifest: JSON.parse(readFileSync(fallback, 'utf8')), dir: dirname(fallback) }
    } catch {
      return null
    }
  }
}

/**
 * 插件目录里是否存在原生模块（`.node`）。
 * @param {string} dir
 * @returns {boolean}
 */
function hasNativeModule(dir) {
  const stack = [dir]
  let visited = 0
  while (stack.length > 0 && visited < 400) {
    const current = stack.pop()
    visited += 1
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.name.endsWith('.node')) return true
    }
  }
  return false
}

/**
 * 把作者自述的兼容清单（`dsh.compatibility.dsh`，形如 `0.2.0-rc.2 || 0.2.1-alpha.1`）转成数组。
 * @param {any} manifest
 * @returns {{range: string | null, releases: string[]}}
 */
function readDeclaredCompatibility(manifest) {
  const declared = manifest?.dsh?.compatibility?.dsh
  const releases = manifest?.dsh?.compatibility?.dshReleases
  return {
    range: typeof declared === 'string' && declared.trim() !== '' ? declared.trim() : null,
    releases: releases && typeof releases === 'object' ? Object.keys(releases) : [],
  }
}

/**
 * 判定单个插件在目标 DSH 版本下能否正常运行。
 * @param {PluginEntry} plugin
 * @param {string} targetVersion 目标 DSH 版本
 * @param {{nodeMajor?: number}} [context]
 * @returns {PluginEntry}
 */
export function evaluatePlugin(plugin, targetVersion, context = {}) {
  const nodeMajor = context.nodeMajor ?? Number(process.versions.node.split('.')[0])
  const reasons = []
  const peerMismatches = []

  for (const [peer, range] of Object.entries(plugin.peerDependencies)) {
    if (!peer.startsWith(HARNESS_PREFIX) || peer === '@deepseek-ai/dsh') continue
    if (!satisfies(targetVersion, range, { includePrerelease: true })) {
      peerMismatches.push({ version: peer, peers: { [peer]: range } })
    }
  }
  const ownRange = plugin.peerDependencies['@deepseek-ai/dsh']
  if (ownRange && !satisfies(targetVersion, ownRange, { includePrerelease: true })) {
    peerMismatches.push({ version: '@deepseek-ai/dsh', peers: { '@deepseek-ai/dsh': ownRange } })
  }

  if (plugin.isLink) {
    reasons.push({
      code: 'link',
      level: 'info',
      message: '本地链接插件（link:）不会随 npm 更新，需要你手动在其源码里适配',
    })
  }

  if (peerMismatches.length > 0 && !plugin.isLink) {
    const first = peerMismatches[0]
    const unique = [...new Set(peerMismatches.map((item) => Object.keys(item.peers)[0]))]
    reasons.push({
      code: 'peer',
      level: 'blocker',
      message: `插件声明的 Harness peer 依赖不包含 ${targetVersion}（${unique.length} 个模块不满足）`,
      detail: `${first.version} 需要 ${Object.values(first.peers)[0] ?? ''}`,
    })
  }

  const declared = plugin.declaredDshRange
  if (declared && !satisfies(targetVersion, declared, { includePrerelease: true })) {
    reasons.push({
      code: 'declared-untested',
      level: 'warning',
      message: `作者只声明兼容 ${declared}，${targetVersion} 不在其自测范围内`,
    })
  }

  const engineNode = plugin.engines?.node
  if (engineNode && !satisfies(`${nodeMajor}.0.0`, engineNode, { includePrerelease: true })) {
    reasons.push({
      code: 'engine',
      level: 'blocker',
      message: `插件要求 node ${engineNode}，当前是 node ${process.versions.node}`,
    })
  }

  if (plugin.hasClient && plugin.clientEntryMissing) {
    reasons.push({
      code: 'client-bundle',
      level: 'blocker',
      message: '声明了浏览器端 bundle，但 exports["./client"] 指向的文件不存在（界面会整体加载失败）',
    })
  }

  if (plugin.hasNativeModule) {
    reasons.push({
      code: 'native',
      level: 'warning',
      message: '包含 .node 原生模块，Node ABI 变化后需要重新编译/安装',
    })
  }

  const blockers = reasons.filter((reason) => reason.level === 'blocker')
  plugin.reasons = reasons
  plugin.peerMismatches = peerMismatches
  plugin.status = plugin.isLink
    ? 'local'
    : blockers.length > 0
      ? 'incompatible'
      : reasons.some((reason) => reason.code === 'declared-untested' || reason.code === 'native')
        ? 'unknown'
        : 'ok'
  return plugin
}

/**
 * 扫描 profile 里已安装的全部插件并逐个判定。
 * @param {object} input
 * @param {string} input.profileDir
 * @param {string} input.targetVersion
 * @param {string[]} [input.bundles]
 * @param {number} [input.nodeMajor]
 * @returns {PluginEntry[]}
 */
export function scanPlugins(input) {
  const { dependencies, bundles } = readProfilePlugins(input.profileDir)
  const names = new Set([...Object.keys(dependencies), ...(input.bundles ?? bundles)])
  /** @type {PluginEntry[]} */
  const plugins = []
  const profileModules = join(input.profileDir, 'node_modules')
  for (const name of names) {
    // 本插件自己不参与体检：它不靠 npm 升级（它自己就是更新器），
    // 列进来只会得到"本地链接插件不会随 npm 更新"这种误导性说明。
    if (name === SELF_NAME) continue
    const spec = dependencies[name] ?? '*'
    const isLink = /^(link|file|portal):/.test(spec)
    const found = readPluginManifest(input.profileDir, name)
    // 官方 bundle（@deepseek-ai/*）装在 DSH 自己的安装树里，随 DSH 升级一起替换，
    // 不属于"用户插件"；判定它们的 peer 兼容性没有意义（它们每次都与运行时同版本）。
    const isCore = name.startsWith('@deepseek-ai/') && !(found?.dir ?? '').startsWith(profileModules)
    const declared = readDeclaredCompatibility(found?.manifest)
    const clientExport = found?.manifest?.exports?.['./client']
    const clientPath = typeof clientExport === 'string'
      ? clientExport
      : clientExport && typeof clientExport === 'object'
        ? clientExport.default ?? null
        : null
    /** @type {PluginEntry} */
    const plugin = {
      name,
      version: found?.manifest?.version ?? null,
      spec,
      isLink,
      dir: found?.dir ?? null,
      isCore,
      hasClient: Boolean(found?.manifest?.dsh?.client),
      clientInject: Array.isArray(found?.manifest?.dsh?.client?.inject) ? found.manifest.dsh.client.inject : [],
      clientEntryMissing: Boolean(found?.manifest?.dsh?.client) && (!clientPath || !existsSync(join(found.dir, clientPath))),
      hasNativeModule: found?.dir ? hasNativeModule(found.dir) : false,
      peerDependencies: found?.manifest?.peerDependencies ?? {},
      engines: found?.manifest?.engines ?? {},
      declaredDshRange: declared.range,
      declaredDshReleases: declared.releases,
      status: 'missing',
      reasons: [],
      peerMismatches: [],
      upgradeTo: null,
    }
    if (isCore) {
      plugin.status = 'core'
      plugin.reasons.push({
        code: 'core',
        level: 'info',
        message: found
          ? 'DSH 官方包，随 DSH 升级一起替换，无需单独处理'
          : '官方 bundle 但本地解析不到（可能只是可选包未安装），不影响第三方插件',
      })
      plugins.push(plugin)
      continue
    }
    if (!found) {
      plugin.reasons.push({
        code: 'missing',
        level: 'blocker',
        message: 'profile 里登记了但磁盘上没有这个包（依赖不完整），需要重新安装',
      })
      plugins.push(plugin)
      continue
    }
    plugins.push(evaluatePlugin(plugin, input.targetVersion, { nodeMajor: input.nodeMajor }))
  }
  return plugins.sort((a, b) => Number(a.isCore) - Number(b.isCore) || a.name.localeCompare(b.name))
}

/**
 * 汇总统计。
 * @param {PluginEntry[]} plugins
 * @returns {{total: number, userPlugins: number, ok: number, incompatible: number, unknown: number, local: number, missing: number, core: number, blockers: number}}
 */
export function summarizePlugins(input) {
  // 容错：既接受扫描结果数组，也接受 {plugins} 包装（调用方容易踩这个坑）
  const plugins = Array.isArray(input) ? input : (input?.plugins ?? [])
  const count = (status) => plugins.filter((plugin) => plugin.status === status).length
  return {
    total: plugins.length,
    userPlugins: plugins.filter((plugin) => !plugin.isCore).length,
    ok: count('ok'),
    incompatible: count('incompatible'),
    unknown: count('unknown'),
    local: count('local'),
    missing: count('missing'),
    core: count('core'),
    blockers: plugins.reduce((sum, plugin) => sum + plugin.reasons.filter((reason) => reason.level === 'blocker').length, 0),
  }
}

/**
 * 只挑出真正需要用户关心的第三方插件（去掉官方包）。
 * @param {PluginEntry[]} plugins
 * @returns {PluginEntry[]}
 */
export function userPluginsOf(plugins) {
  return plugins.filter((plugin) => !plugin.isCore)
}

/**
 * 在 registry 上为该插件找一个"能跑在目标 DSH 版本下"的最高版本。
 *
 * 只做纯 manifest 判定（abbreviated packument 里带了每个版本的 peerDependencies），
 * 因此可以在真正升级 DSH 之前就把结论摆给用户。
 * @param {object} input
 * @param {string} input.name
 * @param {string} input.targetVersion
 * @param {string | null} [input.currentVersion]
 * @param {(name: string, options: any) => Promise<{versions: Record<string, any>, distTags: Record<string, string>}>} input.fetchManifestVersions
 * @param {number} [input.limit] 最多检查多少个候选版本
 * @returns {Promise<{name: string, found: string | null, latest: string | null, checked: number, notes: string[]}>}
 */
export async function findCompatibleVersion(input) {
  const notes = []
  let body
  try {
    body = await input.fetchManifestVersions(input.name, {})
  } catch (error) {
    return { name: input.name, found: null, latest: null, checked: 0, notes: [`查询 registry 失败：${error.message}`] }
  }
  // fetchPackument 返回的 `versions` 是版本号数组，manifest 在 `manifests` 里；
  // 测试里也可能直接塞一个 `{版本: manifest}` 的记录，两种形状都要认。
  const raw = body.manifests ?? body.versions ?? {}
  const versions = Array.isArray(raw) ? (body.raw?.versions ?? {}) : raw
  const distTags = body.distTags ?? {}
  // 从新到旧检查：先命中最高兼容版本。
  // registry 里偶尔混进不合法的版本号（本机真见过一个包把版本号写成 "0"），
  // 先过滤掉，否则比较时会抛 invalid semver 并把整次更新带崩。
  const candidates = sortDesc(Object.keys(versions).filter((version) => valid(version))).slice(0, input.limit ?? 40)
  let checked = 0
  for (const version of candidates) {
    const manifest = versions[version]
    if (!manifest) continue
    checked += 1
    const peers = manifest.peerDependencies ?? {}
    let ok = true
    for (const [peer, range] of Object.entries(peers)) {
      if (!peer.startsWith(HARNESS_PREFIX)) continue
      if (!satisfies(input.targetVersion, String(range), { includePrerelease: true })) {
        ok = false
        break
      }
    }
    if (!ok) continue
    if (input.currentVersion && !gt(version, input.currentVersion)) {
      notes.push(`已安装 ${input.currentVersion}，registry 上没有更高的兼容版本`)
      return { name: input.name, found: null, latest: distTags.latest ?? null, checked, notes }
    }
    return { name: input.name, found: version, latest: distTags.latest ?? null, checked, notes }
  }
  notes.push(`检查了 ${checked} 个版本，没有一个声明兼容 ${input.targetVersion}`)
  return { name: input.name, found: null, latest: distTags.latest ?? null, checked, notes }
}

/**
 * 把插件的判定理由拼成一句中文，供日志与界面直接展示。
 *
 * `plugin.reasons` 是 `{code, level, message}` 数组；没有理由时按状态兜底，
 * 保证"每个不能正常运行的插件都有说明"这条需求不会漏项。
 * @param {PluginEntry} plugin
 * @returns {string}
 */
export function reasonText(plugin) {
  const reasons = Array.isArray(plugin?.reasons) ? plugin.reasons : []
  if (reasons.length > 0) {
    return reasons
      .map((reason) => (reason.detail ? `${reason.message}（${reason.detail}）` : reason.message))
      .join('；')
  }
  switch (plugin?.status) {
    case 'ok':
      return `兼容 ${plugin.targetVersion ?? '目标版本'}`
    case 'core':
      return '官方内置 bundle，随 DSH 一起替换'
    case 'local':
      return '本地链接插件，不随 npm 更新'
    case 'missing':
      return 'profile 里登记了，但 node_modules 里没有（可能已被手动删除）'
    default:
      return '未判定'
  }
}
