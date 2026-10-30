#!/usr/bin/env node
/**
 * dsh-auto-update 命令行：不打开网页也能查版本、检查更新、升级、回滚、看插件兼容性。
 *
 * 真正的升级/回滚仍然交给 `lib/runner.mjs`（同一个执行器，同样的备份与自动回滚保证），
 * 因此命令行和网页两条路径的行为是一致的。
 *
 * 用法：
 *   dsh-auto-update status                 当前版本、最新版本、备份、插件摘要
 *   dsh-auto-update check [--channel next] 只检查，不动系统
 *   dsh-auto-update plugins [--target v]   逐个体检已装插件的兼容性
 *   dsh-auto-update update [--to v] [--yes] [--no-restart]
 *   dsh-auto-update rollback [--backup id] [--yes]
 *   dsh-auto-update backups                列出备份
 *   dsh-auto-update settings [--set k=v ...]
 *   --profile <name>  指定 profile（默认 web）
 *   --json            机器可读输出
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLayout, locateDshInstall, readPackageJson } from '../lib/paths.js'
import {
  DEFAULT_SETTINGS,
  createJob,
  listJobs,
  loadState,
  normalizeLastCheck,
  saveState,
  settingsPatchSchema,
  updateSettings,
} from '../lib/state.js'
import { checkDshUpdate } from '../lib/registry.js'
import { scanPlugins, summarizePlugins, reasonText, describeSelfMount } from '../lib/compat.js'
import { listBackups, describeBackup, backupTotals, planBackup } from '../lib/backup.js'

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'runner.mjs')

/**
 * 极简参数解析：`--key value`、`--flag`、位置参数。
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{command: string, positionals: string[], flags: Record<string, any>}} */
  const result = { command: '', positionals: [], flags: {} }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const [rawKey, inline] = token.slice(2).split('=')
      const key = rawKey
      if (inline !== undefined) {
        result.flags[key] = inline
        continue
      }
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        result.flags[key] = next
        index += 1
      } else {
        result.flags[key] = true
      }
      continue
    }
    if (!result.command) result.command = token
    else result.positionals.push(token)
  }
  return result
}

/** 打印表格（等宽对齐）。 */
function table(rows, headers) {
  const widths = headers.map((header, column) =>
    Math.max(String(header).length, ...rows.map((row) => String(row[column] ?? '').length)),
  )
  const line = (cells) => cells.map((cell, column) => String(cell ?? '').padEnd(widths[column])).join('  ')
  console.log(line(headers))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(line(row))
}

function fail(message, code = 1) {
  console.error(`错误：${message}`)
  process.exitCode = code
}

function printHelp() {
  console.log(`dsh-auto-update —— DSH 版本检查 / 升级 / 回滚

  dsh-auto-update status                     当前状态
  dsh-auto-update check [--channel auto|latest|next|alpha|newest]
  dsh-auto-update plugins [--target <version>]
  dsh-auto-update update [--to <version>] [--yes] [--no-restart]
  dsh-auto-update backups
  dsh-auto-update rollback [--backup <id>] [--yes]
  dsh-auto-update settings [--set autoCheck=true --set channel=next]

  通用选项：--profile <name>（默认 web）、--json、--help
`)
}

/** 找到安装信息或抛错。 */
function requireInstall(layout) {
  const install = locateDshInstall(layout)
  if (!install) throw new Error('找不到已安装的 @deepseek-ai/dsh（可用 npm root -g 检查全局安装）')
  return install
}

/**
 * 启动执行器并等待结束：直接用命令行跑（不经过宿主），所以不用 --defer。
 * @param {object} layout
 * @param {object} job
 * @param {string[]} argv 额外参数（不要重复传 --state-dir）
 */
function runRunner(layout, job, argv) {
  const result = spawnSync(
    process.execPath,
    [RUNNER, '--job', job.id, '--state-dir', layout.stateDir, ...argv],
    { stdio: 'inherit', env: process.env },
  )
  return result.status ?? 1
}

async function commandStatus(layout, flags) {
  const install = requireInstall(layout)
  const state = loadState(layout)
  const backups = listBackups(layout)
  const scan = scanPlugins({ profileDir: layout.profileDir, targetVersion: install.version })
  const summary = summarizePlugins(scan)
  const payload = {
    dsh: { version: install.version, dir: install.dir, source: install.source },
    profile: { name: layout.profile, dir: layout.profileDir },
    plugins: summary,
    backups: backups.map(describeBackup),
    backupSpace: backupTotals(backups),
    settings: state.settings,
    skipped: state.skipped,
    lastCheck: normalizeLastCheck(state.lastCheck, install.version),
    stateDir: layout.stateDir,
    jobs: listJobs(layout, 5).map((job) => ({ id: job.id, kind: job.kind, status: job.status, phase: job.phase })),
  }
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2))
    return 0
  }
  console.log(`DSH        ${install.version}（${install.dir}）`)
  console.log(`profile    ${layout.profile}（${layout.profileDir}）`)
  console.log(
    `插件       ${summary.userPlugins} 个用户插件：可用 ${summary.ok}，不兼容 ${summary.incompatible}，未测试 ${summary.unknown}，本地 ${summary.local}，缺失 ${summary.missing}`,
  )
  if (payload.lastCheck) {
    const check = payload.lastCheck
    console.log(
      `上次检查   ${check.checkedAt} → 目标 ${check.targetVersion ?? '—'}（${check.channel}）${check.available ? ' 有新版' : ' 已最新'}`,
    )
  } else {
    console.log('上次检查   还没有检查过')
  }
  const spaceMb = Math.round((payload.backupSpace.bytes ?? 0) / 1024 / 1024)
  console.log(`备份       ${backups.length} 份，共 ${spaceMb ? `${spaceMb}MB` : '0'}`)
  const mount = describeSelfMount(layout.profileDir)
  console.log(`本插件     ${mount.mounted ? '已挂载（在 dsh.profile.bundles 清单里）' : `未挂载 —— ${mount.hint}`}`)
  return 0
}

async function commandCheck(layout, flags) {
  const install = requireInstall(layout)
  const state = loadState(layout)
  const result = await checkDshUpdate({
    installedVersion: install.version,
    registry: state.settings.registry,
    channel: flags.channel ?? state.settings.channel,
    skipVersions: state.skipped,
  })
  state.lastCheck = result
  saveState(layout, state)
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2))
    return 0
  }
  console.log(`当前版本 ${install.version}`)
  console.log(`目标版本 ${result.targetVersion ?? '—'}（通道 ${result.channel}${result.targetTag ? `，tag ${result.targetTag}` : ''}）`)
  console.log(result.available ? '有可用更新' : '已是最新版本')
  const scan = scanPlugins({ profileDir: layout.profileDir, targetVersion: result.targetVersion ?? install.version })
  const summary = summarizePlugins(scan)
  console.log(
    `插件体检 可用 ${summary.ok} / 不兼容 ${summary.incompatible} / 未测试 ${summary.unknown} / 本地 ${summary.local} / 缺失 ${summary.missing}`,
  )
  return 0
}

async function commandPlugins(layout, flags) {
  const install = requireInstall(layout)
  const target = flags.target ?? install.version
  const scan = scanPlugins({ profileDir: layout.profileDir, targetVersion: target })
  const summary = summarizePlugins(scan)
  if (flags.json) {
    console.log(JSON.stringify({ targetVersion: target, summary, plugins: scan }, null, 2))
    return 0
  }
  const rows = scan.map((plugin) => [plugin.name, plugin.version ?? '—', plugin.status, reasonText({ ...plugin, targetVersion: target })])
  table(rows, ['插件', '版本', '状态', '说明'])
  console.log(
    `\n目标版本 ${target}：可用 ${summary.ok}，不兼容 ${summary.incompatible}，未测试 ${summary.unknown}，本地 ${summary.local}，缺失 ${summary.missing}`,
  )
  return 0
}

async function commandBackups(layout, flags) {
  const backups = listBackups(layout)
  if (flags.json) {
    console.log(JSON.stringify(backups.map(describeBackup), null, 2))
    return 0
  }
  if (backups.length === 0) {
    console.log('还没有备份（第一次更新时会自动创建）')
    return 0
  }
  table(
    backups.map((backup) => [
      backup.id,
      backup.fromVersion ?? '—',
      backup.mode,
      `${Math.round((backup.sizeBytes ?? 0) / 1024 / 1024)}MB`,
      new Date(backup.createdAt).toLocaleString(),
    ]),
    ['id', '版本', '方式', '体积', '时间'],
  )
  return 0
}

async function commandUpdate(layout, flags) {
  const install = requireInstall(layout)
  const state = loadState(layout)
  let target = flags.to ?? flags.version ?? ''
  if (!target) {
    if (flags['dry-run']) {
      const plan = planBackup({ installDir: install.dir, preferred: state.settings.backupMode, stateDir: layout.stateDir })
      console.log(`当前 ${install.version}；备份计划：${plan.mode}（${plan.reason}）`)
      return 0
    }
    const result = await checkDshUpdate({
      installedVersion: install.version,
      registry: state.settings.registry,
      channel: flags.channel ?? state.settings.channel,
      skipVersions: state.skipped,
    })
    if (!result.available || !result.targetVersion) {
      console.log(`已是最新版本（${install.version}）`)
      return 0
    }
    target = result.targetVersion
    console.log(`发现新版本 ${target}（通道 ${result.channel}）`)
  }
  const caps = {
    electron: process.env.ELECTRON_RUN_AS_NODE === '1',
  }
  if (caps.electron) {
    return fail('当前是桌面客户端（Electron）运行模式，不能用命令行替换正在运行的安装包', 2)
  }
  if (!flags.yes) {
    // 非交互环境（管道/CI）没法和用户确认，直接要求 --yes
    if (!process.stdin.isTTY) {
      return fail(`将升级到 ${target}，请加 --yes 确认（会先备份，失败自动回滚）`, 2)
    }
    const answer = await ask(`确认从 ${install.version} 升级到 ${target}？（会先备份，失败自动回滚）[y/N] `)
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('已取消')
      return 0
    }
  }
  const job = createJob(layout, {
    kind: 'update',
    fromVersion: install.version,
    toVersion: target,
    steps: ['preflight', 'backup', 'stop-host', 'install', 'verify', 'plugins', 'restart', 'health'],
    detail: { cli: true },
  })
  job.stateDir = layout.stateDir
  const argv = ['--action', 'update', '--target', target, '--profile', layout.profile]
  if (flags['no-restart']) argv.push('--no-restart')
  if (flags['backup-mode']) argv.push('--backup-mode', String(flags['backup-mode']))
  if (flags['dry-run']) argv.push('--dry-run')
  console.log(`任务 ${job.id}：升级 ${install.version} → ${target}（日志 ${job.logPath}）`)
  const code = runRunner(layout, job, argv)
  console.log(code === 0 ? '升级完成' : `升级失败（退出码 ${code}），详情见日志 ${job.logPath}`)
  return code
}

async function commandRollback(layout, flags) {
  const backups = listBackups(layout)
  if (backups.length === 0) return fail('还没有任何备份，无法回滚', 2)
  let backup = backups.find((entry) => entry.id === flags.backup)
  if (!backup) {
    if (backups.length > 1 && !flags.backup) {
      return fail(`有 ${backups.length} 份备份，请用 --backup <id> 指定（dsh-auto-update backups 查看）`, 2)
    }
    backup = backups[0]
  }
  if (backup.mode !== 'full') {
    return fail('这份备份只包含配置（metadata 模式），不能离线还原整个 DSH 安装', 2)
  }
  if (!flags.yes && process.stdin.isTTY) {
    const answer = await ask(`确认回滚到 ${backup.fromVersion}（备份 ${backup.id}）？[y/N] `)
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('已取消')
      return 0
    }
  } else if (!flags.yes) {
    return fail('请加 --yes 确认回滚', 2)
  }
  const install = locateDshInstall(layout)
  const job = createJob(layout, {
    kind: 'rollback',
    fromVersion: install?.version ?? null,
    toVersion: backup.fromVersion,
    steps: ['preflight', 'stop-host', 'restore', 'verify', 'restart', 'health'],
    detail: { cli: true, backupId: backup.id },
  })
  const argv = ['--action', 'rollback', '--backup', backup.id, '--profile', layout.profile]
  if (flags['no-restart']) argv.push('--no-restart')
  console.log(`任务 ${job.id}：回滚到 ${backup.fromVersion}（日志 ${job.logPath}）`)
  const code = runRunner(layout, job, argv)
  console.log(code === 0 ? '回滚完成' : `回滚失败（退出码 ${code}），详情见日志 ${job.logPath}`)
  return code
}

async function commandSettings(layout, flags) {
  const state = loadState(layout)
  const updates = flags.set ? [flags.set].flat() : []
  if (updates.length === 0) {
    const merged = { ...DEFAULT_SETTINGS, ...state.settings }
    if (flags.json) {
      console.log(JSON.stringify(merged, null, 2))
      return 0
    }
    console.log(JSON.stringify(merged, null, 2))
    return 0
  }
  /** @type {Record<string, any>} */
  const patch = {}
  for (const item of updates) {
    const [key, rawValue] = String(item).split('=')
    if (!key) continue
    let value = rawValue
    if (rawValue === 'true') value = true
    else if (rawValue === 'false') value = false
    else if (rawValue !== undefined && /^-?\d+(\.\d+)?$/.test(rawValue)) value = Number(rawValue)
    patch[key] = value
  }
  const parsed = settingsPatchSchema(patch)
  if (!parsed.ok) return fail(parsed.error, 2)
  const settings = updateSettings(layout, parsed.value)
  console.log(JSON.stringify(settings, null, 2))
  return 0
}

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question)
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('\n')) {
        process.stdin.off('data', onData)
        process.stdin.pause()
        resolve(buffer)
      }
    }
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    process.stdin.on('data', onData)
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const { command, flags } = parseArgs(argv)
  if (!command || command === 'help' || flags.help) {
    printHelp()
    return 0
  }
  const layout = resolveLayout({
    profile: typeof flags.profile === 'string' ? flags.profile : 'web',
  })
  switch (command) {
    case 'status':
      return commandStatus(layout, flags)
    case 'check':
      return commandCheck(layout, flags)
    case 'plugins':
      return commandPlugins(layout, flags)
    case 'backups':
      return commandBackups(layout, flags)
    case 'update':
      return commandUpdate(layout, flags)
    case 'rollback':
      return commandRollback(layout, flags)
    case 'settings':
      return commandSettings(layout, flags)
    default:
      printHelp()
      return fail(`未知命令 ${command}`, 2)
  }
}

main().then(
  (code) => {
    process.exitCode = code ?? 0
  },
  (error) => {
    fail(error?.message ?? String(error))
  },
)
