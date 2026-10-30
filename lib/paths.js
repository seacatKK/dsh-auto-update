/**
 * 路径与安装位置解析：DSH_HOME、profile 目录、全局安装目录、状态目录。
 *
 * 设计原则：不 import 任何 `@deepseek-ai/*` 运行时包（DSH 升级换代后宿主模块名、
 * 导出形态都可能变），只依赖 node 内建 + 目录约定 + `createRequire` 解析。
 * @module dsh-auto-update/paths
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** DSH 的 npm 包名。 */
export const DSH_PACKAGE = '@deepseek-ai/dsh'

/**
 * @typedef {object} Layout
 * @property {string} dshHome      DSH_HOME（默认 ~/.dsh）
 * @property {string} profile      profile 名（默认 web）
 * @property {string} profileDir   ~/.dsh/profiles/<profile>
 * @property {string} stateDir     ~/.dsh/auto-update
 * @property {string} jobsDir      状态目录下的 jobs/
 * @property {string} backupsDir   状态目录下的 backups/
 * @property {string} logsDir      状态目录下的 logs/
 */

/**
 * 计算目录布局。
 * @param {{dshHome?: string, profile?: string, stateDir?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {Layout}
 */
export function resolveLayout(options = {}) {
  const env = options.env ?? process.env
  const dshHome = resolve(options.dshHome || env.DSH_HOME || join(homedir(), '.dsh'))
  const profile = options.profile || env.DSH_PROFILE || 'web'
  const profileDir = join(dshHome, 'profiles', profile)
  // DSH_AUTO_UPDATE_STATE_DIR 允许把状态目录挪到别处（受限环境、只读的 DSH_HOME、测试用）
  const stateDir = resolve(options.stateDir || env.DSH_AUTO_UPDATE_STATE_DIR || join(dshHome, 'auto-update'))
  return {
    dshHome,
    profile,
    profileDir,
    stateDir,
    jobsDir: join(stateDir, 'jobs'),
    backupsDir: join(stateDir, 'backups'),
    logsDir: join(stateDir, 'logs'),
  }
}

/**
 * 从某个目录出发解析一个包的 package.json 绝对路径。
 * @param {string} fromDir 解析基点（通常是 profile 目录，那里能穿透到全局安装）
 * @param {string} specifier 例如 '@deepseek-ai/dsh/package.json'
 * @returns {string | null}
 */
function resolveFrom(fromDir, specifier) {
  try {
    const require = createRequire(join(fromDir, 'package.json'))
    return require.resolve(specifier)
  } catch {
    return null
  }
}

/**
 * 读一个 package.json（解析失败返回 null）。
 * @param {string} path
 * @returns {any | null}
 */
export function readPackageJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 定位已安装的 DSH 包目录。
 *
 * 解析顺序：profile 目录 → 状态目录 → 本插件所在目录 → 全局 node_modules 约定路径
 * → `npm root -g` 的结果（由调用方注入，避免在这里同步起子进程）。
 * @param {Layout} layout
 * @param {{globalRoot?: string}} [hints]
 * @returns {{dir: string | null, manifestPath: string | null, version: string | null, source: string}}
 */
export function locateDshInstall(layout, hints = {}) {
  const probes = [
    { from: layout.profileDir, source: 'profile' },
    { from: layout.stateDir, source: 'state' },
    { from: process.cwd(), source: 'cwd' },
  ]
  for (const probe of probes) {
    const manifestPath = resolveFrom(probe.from, `${DSH_PACKAGE}/package.json`)
    if (manifestPath && existsSync(manifestPath)) {
      const manifest = readPackageJson(manifestPath)
      if (manifest?.version) {
        return { dir: dirname(manifestPath), manifestPath, version: manifest.version, source: probe.source }
      }
    }
  }
  const roots = [hints.globalRoot, defaultGlobalRoot()].filter(Boolean)
  for (const root of roots) {
    const manifestPath = join(root, DSH_PACKAGE, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = readPackageJson(manifestPath)
      if (manifest?.version) {
        return { dir: dirname(manifestPath), manifestPath, version: manifest.version, source: `global:${root}` }
      }
    }
  }
  return { dir: null, manifestPath: null, version: null, source: 'not-found' }
}

/**
 * 猜全局 node_modules 目录（win32：%APPDATA%\npm\node_modules；其他：依赖 npm prefix）。
 * @param {{env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform}} [options]
 * @returns {string}
 */
export function defaultGlobalRoot(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const appData = env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'npm', 'node_modules')
  }
  return '/usr/local/lib/node_modules'
}

/**
 * 从全局 node_modules 里的包目录反推全局 node_modules 根。
 * @param {string} packageDir `.../node_modules/@deepseek-ai/dsh`
 * @returns {string}
 */
export function globalRootOf(packageDir) {
  // .../node_modules/@scope/name → .../node_modules
  return dirname(dirname(packageDir))
}

/**
 * 目录体积（递归，字节）。用于备份体积核算与磁盘占用提示。
 * @param {string} dir
 * @returns {number}
 */
export function directorySize(dir) {
  let total = 0
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      try {
        if (entry.isDirectory()) walk(path)
        else if (entry.isFile()) total += statSync(path).size
      } catch {
        // 权限/竞态导致的单点失败不影响整体统计
      }
    }
  }
  walk(dir)
  return total
}
