#!/usr/bin/env node
/**
 * 看护进程（watchdog）：更新窗口被关掉时，把 DSH 拉回原版本。
 *
 * 为什么需要它：执行器（runner.mjs）在更新过程中会杀掉宿主、替换全局安装目录。
 * 用户关掉那个"实时进度命令行窗口"时，Windows 会直接终止里面的 node 进程——
 * 来不及还原 500MB 的备份，于是 DSH 可能停在"装到一半"的状态。看护进程是
 * detached + 隐藏窗口启动的，不在那个控制台里，能活下来并接管：
 *
 *   1. 每秒看一次任务状态、心跳文件（jobs/<id>.hb）和中断标记（jobs/<id>.abort）；
 *   2. 判定"执行器已经死了、而且已经动过磁盘"（phase 在 stop-host 之后）；
 *   3. 起一个 `runner.mjs --action rollback` 把备份还原、重启宿主、做健康检查；
 *   4. 全过程写进同一个任务日志与 RECOVERY.txt。
 *
 * 只在"确实改过东西"时才回滚：还在 preflight/backup 阶段就断了，说明安装目录没被碰，
 * 只把任务标成失败并确保宿主在跑。
 *
 * 用法（由 runner.mjs 自动拉起，不用手敲）：
 *   node watchdog.mjs --job <id> --state-dir <dir> --port 3080 --cwd <dir>
 * @module dsh-auto-update/watchdog
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { appendLog, readJob, saveJob, writeRecovery } from './state.js'
import { resolveLayout } from './paths.js'


const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(HERE, 'runner.mjs')

/** 已经被改过的阶段：从这里开始断掉就必须回滚。 */
const TOUCHED_PHASES = new Set(['stop-host', 'install', 'verify', 'plugins', 'restart', 'health', 'rollback-restore'])

/** 心跳多久没更新就认定执行器死了（仅用于完全没有进程号的情况）。环境变量覆盖供测试用。 */
const STALE_MS = Number(process.env.DSH_AUTO_UPDATE_STALE_MS || 15_000)
/** 进程还活着但久到离谱（同步解压/统计目录可能停顿几十秒）才算真的卡死。 */
const HARD_STALE_MS = Number(process.env.DSH_AUTO_UPDATE_HARD_STALE_MS || 15 * 60 * 1000)
/** 最多看护多久（2 小时），防止僵尸进程永远留着。 */
const MAX_MS = Number(process.env.DSH_AUTO_UPDATE_WATCHDOG_MAX_MS || 2 * 60 * 60 * 1000)

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      index += 1
    }
  }
  return out
}

/** 进程还活着吗（EPERM 说明活着，只是不是我们的）。 */
function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** 简单睡眠。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const jobId = String(args.job ?? '')
  if (!jobId) return
  const layout = resolveLayout({
    dshHome: args['dsh-home'] ? String(args['dsh-home']) : undefined,
    stateDir: args['state-dir'] ? String(args['state-dir']) : undefined,
  })
  const port = Number(args.port ?? 0) || null
  const cwd = String(args.cwd ?? process.cwd())
  const npmCli = args['npm-cli'] ? String(args['npm-cli']) : ''

  const watchdogLog = join(layout.logsDir, `${jobId}.watchdog.log`)
  const fd = openSync(watchdogLog, 'a')
  const note = (line) => {
    try {
      writeFileSync(fd, `[${new Date().toISOString()}] ${line}\n`)
    } catch {
      // 忽略
    }
  }

  // 同一任务只允许一个看护进程（O_EXCL 原子占位）
  const claim = join(layout.jobsDir, `${jobId}.watchdog.claim`)
  try {
    writeFileSync(claim, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' })
  } catch {
    const existing = (() => {
      try {
        return JSON.parse(readFileSync(claim, 'utf8'))
      } catch {
        return null
      }
    })()
    if (existing && existing.pid !== process.pid && alive(existing.pid)) {
      note(`已有看护进程 ${existing.pid} 在看着 ${jobId}，本进程退出`)
      return
    }
    writeFileSync(claim, JSON.stringify({ pid: process.pid, ts: Date.now() }))
  }

  const heartbeatPath = join(layout.jobsDir, `${jobId}.hb`)
  const pidPath = join(layout.jobsDir, `${jobId}.pid`)
  const abortPath = join(layout.jobsDir, `${jobId}.abort`)
  note(`看护开始：job=${jobId} port=${port ?? '-'} cwd=${cwd}`)

  const startedAt = Date.now()
  let acted = false
  while (Date.now() - startedAt < MAX_MS) {
    const job = readJob(layout, jobId)
    if (!job) {
      note('任务不见了，退出')
      return
    }
    if (job.status !== 'running' && job.status !== 'pending') {
      note(`任务已是终态 ${job.status}，看护正常退出`)
      return
    }

    const beat = (() => {
      try {
        return JSON.parse(readFileSync(heartbeatPath, 'utf8'))
      } catch {
        return null
      }
    })()
    const abort = existsSync(abortPath)
      ? (() => {
          try {
            return JSON.parse(readFileSync(abortPath, 'utf8'))
          } catch {
            return {}
          }
        })()
      : null

    // 进程号优先读独立的 pid 文件：心跳时间戳会因同步大操作停顿，pid 不会撒谎。
    const pidFromFile = (() => {
      try {
        return Number(readFileSync(pidPath, 'utf8').trim()) || 0
      } catch {
        return 0
      }
    })()
    const pid = pidFromFile || Number(beat?.pid || 0)

    const reason = decide({ job, beat, abort, pid, pidAlive: alive, now: Date.now(), startedAt })

    if (reason) {
      acted = true
      await takeOver({ layout, job, jobId, reason, port, cwd, npmCli, note })
      return
    }
    await sleep(1000)
  }
  if (!acted) note('看护超时（2 小时），退出；任务状态保留，用户可手动回滚')
  try {
    unlinkSync(claim)
  } catch {
    // 忽略
  }
  try {
    closeSync(fd)
  } catch {
    // 忽略
  }
}

/**
 * 接管：必要时回滚，确保宿主活着。
 * @param {object} input
 * @param {ReturnType<typeof resolveLayout>} input.layout
 * @param {any} input.job
 * @param {string} input.jobId
 * @param {string} input.reason
 * @param {number | null} input.port
 * @param {string} input.cwd
 * @param {string} input.npmCli
 * @param {(line: string) => void} input.note
 */
async function takeOver(input) {
  const { layout, job, jobId, reason, port, cwd, npmCli, note } = input
  note(`判定需要接管：${reason}（phase=${job.phase ?? '?'}）`)
  appendLog(layout, job, `== 看护进程接管：${reason} ==`)
  job.watchdog = { at: Date.now(), pid: process.pid, reason, phase: job.phase ?? null }
  saveJob(layout, job)

  const touched = TOUCHED_PHASES.has(String(job.phase ?? ''))
  const backupId = job.backupId ? String(job.backupId) : ''

  // 重启任务没有版本变更、也没有文件改动：接管时**绝不能走回滚**
  // （回滚会还原一份旧备份或按版本号重装，等于把"重启"变成"重装"）。只要把宿主拉起来。
  if (job.kind === 'restart') {
    job.status = 'failed'
    job.error = `${reason}（重启任务没有改动安装目录，这里只重新拉起宿主）`
    job.phase = 'aborted-restart'
    job.endedAt = Date.now()
    saveJob(layout, job)
    appendLog(layout, job, '重启任务：跳过文件回滚，只把宿主拉起来')
    await ensureHostRunning({ layout, job, port, cwd, note })
    return
  }

  if (!touched) {
    // 还在 preflight/backup：安装目录没被碰过，回滚没有意义
    job.status = 'failed'
    job.error = `${reason}（当时还没改动安装目录，无需回滚）`
    job.phase = 'aborted-before-install'
    job.endedAt = Date.now()
    saveJob(layout, job)
    appendLog(layout, job, '未改动安装目录，跳过回滚')
    await ensureHostRunning({ layout, job, port, cwd, note })
    return
  }

  appendLog(layout, job, `启动回滚：backup=${backupId || '(无，按版本号重装)'}`)
  const argv = [RUNNER, '--job', jobId, '--state-dir', layout.stateDir, '--dsh-home', layout.dshHome, '--action', 'rollback']
  if (backupId) argv.push('--backup', backupId)
  if (job.fromVersion) argv.push('--from-version', String(job.fromVersion))
  if (job.detail?.installDir) argv.push('--install-dir', String(job.detail.installDir))
  if (port) argv.push('--port', String(port))
  if (cwd) argv.push('--cwd', cwd)
  if (npmCli) argv.push('--npm-cli', npmCli)
  else if (job.detail?.npmCli) argv.push('--npm-cli', String(job.detail.npmCli))
  if (job.detail?.restartArgs) argv.push('--restart-args', JSON.stringify(job.detail.restartArgs))
  if (job.detail?.restartEntry) argv.push('--restart-entry', String(job.detail.restartEntry))

  // 回滚自己也可能被杀——它有自己的日志；这里等它把任务写进终态
  const rollbackFd = openSync(join(layout.logsDir, `${jobId}.rollback.log`), 'a')
  try {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...process.env, DSH_HOME: layout.dshHome },
      detached: true,
      stdio: ['ignore', rollbackFd, rollbackFd],
      windowsHide: true,
    })
    child.unref()
  } catch (error) {
    appendLog(layout, job, `启动回滚失败：${error.message}`)
    writeRecovery(layout, job, `${reason}；回滚未能启动：${error.message}`, null, false)
    job.status = 'failed'
    job.error = `${reason}；回滚未能启动：${error.message}`
    job.endedAt = Date.now()
    saveJob(layout, job)
    return
  }

  // 最多等 10 分钟，等回滚自己把任务写成终态
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(1500)
    const latest = readJob(layout, jobId)
    if (!latest) break
    if (latest.status !== 'running') {
      note(`回滚结束：${latest.status}`)
      return
    }
  }
  note('回滚等待超时，请人工查看日志')
}

/**
 * 端口上有没有 HTTP 响应（任意状态码都算活着）。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function pingHost(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(4000),
      headers: { accept: 'text/html' },
    })
    return Boolean(response)
  } catch {
    return false
  }
}

/**
 * 只保证宿主在跑（回滚分支之外用：没改过东西但宿主被停掉了）。
 * @param {object} input
 */
async function ensureHostRunning(input) {
  const { layout, job, port, cwd, note } = input
  if (!port) return
  const probe = await pingHost(port)
  if (probe) {
    note(`端口 ${port} 正常，无需重启`)
    return
  }
  note(`端口 ${port} 没有响应，尝试重启宿主`)
  const argv = [RUNNER, '--job', job.id, '--state-dir', layout.stateDir, '--dsh-home', layout.dshHome, '--action', 'restart']
  if (port) argv.push('--port', String(port))
  if (job.detail?.installDir) argv.push('--install-dir', String(job.detail.installDir))
  if (cwd) argv.push('--cwd', cwd)
  if (job.detail?.restartArgs) argv.push('--restart-args', JSON.stringify(job.detail.restartArgs))
  if (job.detail?.restartEntry) argv.push('--restart-entry', String(job.detail.restartEntry))
  const restartFd = openSync(join(layout.logsDir, `${job.id}.restart.log`), 'a')
  try {
    const child = spawn(process.execPath, argv, {
      cwd,
      env: { ...process.env, DSH_HOME: layout.dshHome },
      detached: true,
      stdio: ['ignore', restartFd, restartFd],
      windowsHide: true,
    })
    child.unref()
  } catch (error) {
    appendLog(layout, job, `重启失败：${error.message}`)
  }
}

/**
 * 判定是否该接管。纯函数（不碰磁盘、不读时钟），可以直接单测。
 * @param {{job: any, beat: any, abort: any, pidAlive: (pid: number) => boolean, now: number, startedAt: number}} input
 * @returns {string | null} 需要接管的原因；null 表示继续看着
 */
export function decide(input) {
  const { job, beat, abort, pidAlive, now, startedAt } = input
  if (job.status !== 'running' && job.status !== 'pending') return null
  if (abort) return `更新窗口被关闭（${abort.signal ?? '中断'}），已自动回滚`
  // 进程号优先：只要执行器还活着，就绝不因为心跳停顿十几秒抢着回滚。
  // 教训（2026-10-29）：更新里夹着同步大操作，心跳曾停 15 秒，看护进程误判回滚，
  // 结果把一次成功的升级又撤了回来，窗口却报成功。
  const pid = Number(beat?.pid || input.pid || 0)
  if (pid) {
    if (!pidAlive(pid)) return '更新进程已退出（命令行窗口被关闭或崩溃），已自动回滚'
    if (now - Number(beat?.ts ?? startedAt) > HARD_STALE_MS) {
      return `更新进程无响应超过 ${Math.round(HARD_STALE_MS / 60_000)} 分钟，已自动回滚`
    }
    return null
  }
  if (!beat && now - startedAt > 60_000) return '更新进程一直没有心跳（可能启动即崩溃），已自动回滚'
  if (!beat) return null
  if (now - Number(beat.ts ?? 0) > STALE_MS) {
    return `更新进度停止响应超过 ${Math.round(STALE_MS / 1000)} 秒（进程已不存在），已自动回滚`
  }
  return null
}

/** 只有被当作脚本直接执行时才开跑；被 import（测试）时只导出 decide。 */
const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false

if (invokedDirectly) main().catch((error) => {
  try {
    process.stderr.write(`dsh-auto-update watchdog: ${error.stack ?? error.message}\n`)
  } catch {
    // 忽略
  }
  process.exitCode = 1
})
