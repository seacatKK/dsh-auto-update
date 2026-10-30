#!/usr/bin/env node
/**
 * 一键安装 / 卸载 dsh-auto-update。
 *
 * 为什么需要这个脚本：`dsh plugin add` 只是把包交给 pnpm 装进 profile 的 node_modules，
 * 而 DSH 启动时只挂载 profile 的 `dsh.profile.bundles` 清单里列出的包。也就是说
 * "装完依赖"和"插件真的会加载"是两件事，第二步必须自己写清单。这个脚本把两步一起做，
 * 并且改清单前先备份。
 *
 * 用法：
 *   node scripts/install.mjs                    # 装到 web profile
 *   node scripts/install.mjs --profile web
 *   node scripts/install.mjs --dry-run          # 只打印将要做的事
 *   node scripts/install.mjs --uninstall        # 从清单和依赖里移除
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLayout } from '../lib/paths.js'
import { writeJsonAtomic } from '../lib/state.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifest.name

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith('--')) continue
    const key = item.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      index += 1
    } else {
      flags[key] = true
    }
  }
  return flags
}

/** 子进程一律继承 stdio，不建管道（受限环境里 pipe 会 EPERM）。 */
function runInherit(file, argv, options = {}) {
  const result = spawnSync(file, argv, { stdio: 'inherit', env: options.env ?? process.env, cwd: options.cwd })
  return result.status ?? 1
}

/**
 * 执行一次 `dsh ...`。
 *
 * Windows 上 `dsh` 是 npm 生成的 `.cmd` 垫片，Node 不能直接 spawn `.cmd`（必须经 shell），
 * 而 shell + 参数数组会触发 DEP0190 警告，所以 shell 模式下把整条命令拼成一个字符串。
 * @param {{file: string, shell: boolean, env: NodeJS.ProcessEnv}} dsh
 * @param {string[]} argv
 * @param {'inherit' | 'ignore'} stdio
 */
function spawnDsh(dsh, argv, stdio) {
  if (dsh.shell) {
    const line = [dsh.file, ...argv].map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(' ')
    return spawnSync(line, { stdio, env: dsh.env, shell: true })
  }
  return spawnSync(dsh.file, argv, { stdio, env: dsh.env })
}

/**
 * 找到可用的 `dsh` 命令。
 * @returns {{file: string, shell: boolean, env: NodeJS.ProcessEnv} | null}
 */
function resolveDshCommand() {
  const env = { ...process.env }
  const extra = [dirname(process.execPath)]
  if (process.platform === 'win32' && process.env.APPDATA) extra.push(join(process.env.APPDATA, 'npm'))
  const sep = process.platform === 'win32' ? ';' : ':'
  env.PATH = [...extra, env.PATH ?? env.Path ?? ''].filter(Boolean).join(sep)
  if (process.platform === 'win32') env.Path = env.PATH

  const candidates = []
  if (process.platform === 'win32') {
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'dsh.cmd'))
    candidates.push(join(dirname(process.execPath), 'dsh.cmd'))
  } else {
    candidates.push(join(dirname(process.execPath), 'dsh'))
    if (process.env.HOME) candidates.push(join(process.env.HOME, '.local', 'bin', 'dsh'))
  }
  /** @type {Array<{file: string, shell: boolean, env: NodeJS.ProcessEnv}>} */
  const options = candidates
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ file: candidate, shell: process.platform === 'win32', env }))
  // 最后退回 PATH 上的 dsh（Windows 必须经 shell 才能执行 .cmd 垫片）
  options.push({ file: 'dsh', shell: process.platform === 'win32', env })
  for (const option of options) {
    const probe = spawnDsh(option, ['--version'], 'ignore')
    if (probe.status === 0) return option
  }
  return null
}

/**
 * 把包名写进 / 移出 profile 的 `dsh.profile.bundles`。
 * @param {string} profileDir
 * @param {{add: boolean}} options
 * @returns {{changed: boolean, bundles: string[], backupPath?: string}}
 */
function editBundles(profileDir, options) {
  const manifestPath = join(profileDir, 'package.json')
  const current = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = Array.isArray(current.dsh?.profile?.bundles) ? [...current.dsh.profile.bundles] : []
  const has = bundles.includes(PACKAGE_NAME)
  if (options.add === has) return { changed: false, bundles }
  const backupPath = `${manifestPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(manifestPath, backupPath)
  const next = options.add ? [...bundles, PACKAGE_NAME] : bundles.filter((name) => name !== PACKAGE_NAME)
  const updated = {
    ...current,
    dsh: { ...current.dsh, profile: { ...current.dsh?.profile, bundles: next } },
  }
  writeJsonAtomic(manifestPath, updated)
  return { changed: true, bundles: next, backupPath }
}

function main() {
  const flags = parseArgs(process.argv.slice(2))
  const layout = resolveLayout({ profile: typeof flags.profile === 'string' ? flags.profile : undefined })
  const uninstall = flags.uninstall === true || flags.remove === true
  const dryRun = flags['dry-run'] === true

  console.log(`包目录：${packageDir}`)
  console.log(`目标 profile：${layout.profile}（${layout.profileDir}）`)
  if (!existsSync(join(layout.profileDir, 'package.json'))) {
    console.error(`✗ ${layout.profileDir} 里没有 package.json —— profile 名对吗？先跑一次 dsh --profile ${layout.profile} 让它初始化。`)
    process.exit(2)
  }

  const dsh = resolveDshCommand()
  if (!dsh) {
    console.error('✗ 找不到 dsh 命令，请确认它在 PATH 上（或本脚本所在环境的 npm 全局目录里）')
    process.exit(2)
  }

  const pluginArgs = uninstall
    ? ['plugin', '--profile', layout.profile, 'remove', PACKAGE_NAME]
    : ['plugin', '--profile', layout.profile, 'add', packageDir]

  if (dryRun) {
    console.log(`[dry-run] 将执行：dsh ${pluginArgs.join(' ')}`)
    console.log(`[dry-run] 将${uninstall ? '移除' : '加入'} dsh.profile.bundles：${PACKAGE_NAME}`)
    return 0
  }

  const code = spawnDsh(dsh, pluginArgs, 'inherit').status ?? 1
  if (code !== 0) {
    console.error(`✗ dsh plugin ${uninstall ? 'remove' : 'add'} 失败（退出码 ${code}）`)
    console.error('  常见原因：pnpm 不在 PATH 上（dsh 的 plugin 命令靠它）；或网络/registry 不可用。')
    return code
  }

  const edited = editBundles(layout.profileDir, { add: !uninstall })
  if (edited.changed) {
    console.log(`✓ 已${uninstall ? '移除' : '加入'} dsh.profile.bundles：${PACKAGE_NAME}`)
    if (edited.backupPath) console.log(`  清单改动前已备份：${edited.backupPath}`)
  } else {
    console.log(`· dsh.profile.bundles 里${uninstall ? '本来就没有' : '已经包含'} ${PACKAGE_NAME}`)
  }

  if (uninstall) {
    console.log('')
    console.log('✓ 已卸载。重启 dsh 网页服务后生效；状态与备份仍留在 ' + layout.stateDir + '（可手删）')
  } else {
    console.log('')
    console.log('✓ 安装完成。现在重启 dsh 网页服务（关掉当前 dsh web 窗口再启动），刷新浏览器：')
    console.log('  · 设置里会出现「自动更新」侧边栏')
    console.log('  · 首次打开会自动检查一次版本')
  }
  return 0
}

if (import.meta.main) process.exitCode = main()

export { editBundles, parseArgs, resolveDshCommand }
