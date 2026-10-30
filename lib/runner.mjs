#!/usr/bin/env node
/**
 * 脱离宿主进程的更新 / 回滚执行器。
 *
 * 为什么必须脱离宿主：更新的中间步骤是"杀掉正在跑 dsh web 的那个进程"，
 * 而插件本身就跑在那个进程里。所以宿主只负责 `spawn` 本脚本并立刻回一句
 * "已开始"，真正的重活（备份、停宿主、npm 全局安装、验证、同步插件、重启、健康检查、
 * 失败自动回滚）全部在这里做，进度与结论写进 `jobs/<id>.json` + `logs/<id>.log`。
 *
 * 还有一层进程树上的讲究：宿主 spawn 的进程仍是宿主的子进程，`taskkill /T` 会把
 * 我们一起杀掉。因此宿主以 `--defer` 启动本脚本，本脚本再生一个不带 `--defer` 的
 * 自己（父进程随即便退出），真正的执行者就成了"父进程已死"的孤儿进程，不在宿主的
 * 进程树里，可以安全地终止宿主。
 *
 * 用法（由 lib/host.js 调用，不用手敲）：
 *   node runner.mjs --defer --job <id> --state-dir <dir> --action update --target 0.2.1-rc.4 --port 3080
 * @module dsh-auto-update/runner
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 本脚本目录（用于找到同目录的看护进程脚本）。 */
const HERE = dirname(fileURLToPath(import.meta.url))
/** 看护进程脚本：见到"更新进程死了"就回滚。 */
const WATCHDOG = join(HERE, 'watchdog.mjs')
import {
  appendLog,
  loadState,
  readJob,
  saveJob,
  tailLog,
  writeRecovery,
} from './state.js'
import { resolveLayout, readPackageJson, locateDshInstall, defaultGlobalRoot, globalRootOf } from './paths.js'
import { createBackup, restoreFullBackup, restoreProfileFiles, pruneBackups, cleanStaleStaging, readBackup } from './backup.js'
import { scanPlugins, summarizePlugins, findCompatibleVersion, userPluginsOf, reasonText } from './compat.js'
import { fetchPackument } from './registry.js'
import { parseActivationWarnings, scanActivation } from './bootlog.js'

const ROLLED_BACK = 'rolled-back'

const STEPS = {
  update: ['preflight', 'backup', 'stop-host', 'install', 'verify', 'plugins', 'restart', 'health'],
  rollback: ['preflight', 'stop-host', 'restore', 'verify', 'restart', 'health'],
  'sync-plugins': ['preflight', 'plugins'],
  // 看护进程用：只把宿主拉起来，不动版本（窗口被关在早期阶段时用）
  // 带 stop-host：设置页的"重启 DSH"和看护的第 2 次尝试都走这条，端口可能还被占着。
  restart: ['preflight', 'stop-host', 'restart', 'health'],
  // 只停不起：给设置页的"停止 DSH"和桌面脚本当后路，不依赖 Ctrl+C 也能停
  stop: ['preflight', 'stop-host'],
}

/**
 * 解析命令行。
 * @param {string[]} argv
 * @returns {Record<string, string | boolean>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      index += 1
    }
  }
  return out
}

/** 主流程。 */
async function main() {
  /** @type {import('node:child_process').ChildProcess | null} */
  let watchdogProc = null
  const args = parseArgs(process.argv.slice(2))
  if (args.defer) {
    deferSelf(args)
    return
  }
  const jobId = String(args.job ?? '')
  const action = String(args.action ?? 'update')
  if (!jobId) fail('missing --job')
  const layout = resolveLayout({
    dshHome: args['dsh-home'] ? String(args['dsh-home']) : undefined,
    stateDir: args['state-dir'] ? String(args['state-dir']) : undefined,
  })
  const job = readJob(layout, jobId)
  if (!job) fail(`job ${jobId} not found`)
  const logFd = openSync(job.logPath, 'a')
  const visible = args.visible === true
  const progress = createProgress({
    visible,
    write: (text) => {
      try {
        process.stdout.write(text)
      } catch {
        // 控制台没了也不影响任务
      }
    },
  })
  const npmLogPath = join(layout.logsDir, `${job.id}.npm.log`)
  const log = (line) => {
    progress.clear()
    appendLog(layout, job, line)
    try {
      writeFileSync(logFd, `${line}\n`)
    } catch {
      // fd 写失败时 appendLog 已经落盘
    }
    if (visible) {
      try {
        process.stdout.write(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}\n`)
      } catch {
        // 控制台没了也不影响任务
      }
    }
  }
  if (visible) {
    // 中文提示只能在这里打：.cmd 外壳是纯 ASCII（cmd 解析不了的坑见 lib/host.js 的注释）。
    try {
      const target = args.target ? `到 ${args.target}` : ''
      process.stdout.write(
        [
          '==========================================================',
          ` dsh-auto-update 正在${action === 'rollback' ? '回滚' : action === 'sync-plugins' ? '同步插件' : action === 'restart' ? '重启 DSH' : '更新'}${target}，请勿关闭本窗口`,
          action === 'restart'
            ? ' 重启不改版本：先停掉当前进程，再在新窗口里拉起一个同样的 DSH'
            : ' 关闭本窗口会中断操作；看护进程会自动回滚到原版本',
          '==========================================================',
          '',
        ].join('\n'),
      )
    } catch {
      // 控制台不可用也不影响任务
    }
  }
  const settings = loadState(layout).settings
  const expected = STEPS[action] ?? STEPS.update
  job.steps = expected.map((key) => job.steps.find((step) => step.key === key) ?? { key, status: 'pending', startedAt: 0 })
  job.status = 'running'
  job.phase = 'starting'
  saveJob(layout, job)

  const mark = (key, status, message) => {
    const step = job.steps.find((entry) => entry.key === key)
    if (!step) return
    step.status = status
    if (message) step.message = message
    if (status === 'running') step.startedAt = Date.now()
    if (status !== 'running' && status !== 'pending') step.endedAt = Date.now()
    job.phase = key
    saveJob(layout, job)
    beat(key)
  }

  /**
   * 心跳：看护进程（watchdog.mjs）靠它判断"更新还在活着"。
   * 窗口被关闭 → 本进程被杀 → 心跳停 → 看护进程接管并回滚。
   */
  const heartbeatPath = join(layout.jobsDir, `${job.id}.hb`)
  const abortPath = join(layout.jobsDir, `${job.id}.abort`)
  /** 独立的进程号文件：看护进程靠它判断“执行器还活着吗”，不依赖心跳时间戳是否新鲜。 */
  const pidPath = join(layout.jobsDir, `${job.id}.pid`)
  try {
    writeFileSync(pidPath, String(process.pid))
  } catch {
    // 写不进去就算了，看护进程会退回按心跳判断
  }
  const beat = (phase) => {
    try {
      writeFileSync(heartbeatPath, JSON.stringify({ ts: Date.now(), pid: process.pid, phase: phase ?? job.phase ?? '' }))
    } catch {
      // 心跳写不进去不影响主流程（看护进程会按"进程已退出"判定）
    }
  }
  beat('starting')
  const beatTimer = setInterval(() => beat(), 1000)
  if (typeof beatTimer.unref === 'function') beatTimer.unref()

  /**
   * 窗口被关闭 / Ctrl+C 时：立刻落一个"中断"标记就退出。
   *
   * 真正的回滚交给看护进程做——本进程马上就要被杀掉，来不及还原 500MB 的备份。
   */
  const onSignal = (signal) => {
    try {
      writeFileSync(abortPath, JSON.stringify({ ts: Date.now(), pid: process.pid, signal, phase: job.phase ?? '' }))
    } catch {
      // 忽略
    }
    log(`收到 ${signal}：已请求看护进程回滚，本窗口退出`)
    if (visible) process.stdout.write(`\n收到 ${signal}：窗口要关了。回滚交给看护进程，请稍候…\n`)
    setTimeout(() => process.exit(130), 250)
  }
  for (const signal of ['SIGINT', 'SIGBREAK', 'SIGHUP']) {
    try {
      process.on(signal, () => onSignal(signal))
    } catch {
      // 某些平台不支持 SIGBREAK
    }
  }

  const targetDir = String(args['install-dir'] ?? '')
  /** @type {{dir: string, version: string} | null} */
  const install = targetDir
    ? { dir: targetDir, version: readPackageJson(join(targetDir, 'package.json'))?.version ?? '' }
    : pickInstall(layout, args)
  if (!install) {
    job.status = 'failed'
    job.error = '找不到已安装的 @deepseek-ai/dsh 目录'
    saveJob(layout, job)
    return
  }
  const port = Number(args.port ?? job.detail?.port ?? 0) || null
  const cwd = String(args.cwd ?? job.detail?.cwd ?? process.cwd())
  const restart = args['no-restart'] !== true
  const dryRun = args['dry-run'] === true
  const env = childEnv()
  // 宿主原来的启动参数：重启时尽量原样还原（否则 `--host`、`--patch` 之类的参数会丢）
  const restartArgs = parseRestartArgs(args['restart-args'] ?? job.detail?.restartArgs)
  const restartEntry = String(args['restart-entry'] ?? job.detail?.restartEntry ?? '') || null
  // 允许注入 npm CLI 路径（测试用假 npm；也方便 npm 装在非标准位置的环境）
  const npmCliOverride = String(args["npm-cli"] ?? process.env.DSH_AUTO_UPDATE_NPM_CLI ?? "")

  // 记进任务详情：回滚时也要按同样的方式重启、按同一个目录还原
  // （installDir 尤其重要：npm prefix 不在默认位置时，看护进程起回滚就得靠它）
  job.action = action
  job.detail = { ...(job.detail ?? {}), port, cwd, restartArgs, restartEntry, installDir: install.dir }
  if (npmCliOverride) job.detail.npmCli = npmCliOverride

  saveJob(layout, job)
  log(`== 开始 ${action}：${install.version} → ${args.target ?? '(无)'}；端口 ${port ?? '未知'}；${dryRun ? '演练模式' : '实际执行'} ==`)

  // 看护进程：更新/回滚会杀掉宿主、还会动全局安装目录，一旦本进程被强杀（用户关了那个命令行窗口），
  // 必须有人在旁边判断"事情坏没坏"并回滚。它 detached + 隐藏窗口，所以关掉窗口不会带走它。
  if (action !== 'sync-plugins' && !dryRun) watchdogProc = startWatchdog(layout, job, { port, cwd, npmCliOverride })

  /** @type {{record: object | null, mode: 'full' | 'metadata' | null}} */
  const backupState = { record: null, mode: null }

  /** 失败时的兜底：自动回滚到备份 / 旧版本。 */
  const rollback = async (reason) => {
    if (!settings.autoRollback) {
      log(`自动回滚已关闭，跳过。原因：${reason}`)
      job.status = 'failed'
      job.error = reason
      saveJob(layout, job)
      return false
    }
    log(`== 失败，开始自动回滚：${reason} ==`)
    try {
      await mark('stop-host', 'running')
      await stopHost(port, log)
      await mark('stop-host', 'ok', port ? `已停止端口 ${port} 上的进程` : '已完成')
      job.phase = 'rollback-restore'
      saveJob(layout, job)
      // 优先用完整备份离线还原（不需要网络，最可靠）。
      // 万一 tar 起不来/备份损坏，**绝不能就此放弃**——退回到按版本号重装，仍然能救回 DSH。
      let restoredByBackup = false
      if (backupState.record?.mode === 'full' && backupState.record.tarPath) {
        const restored = await restoreFullBackup({ record: backupState.record, targetDir: install.dir, log, logFd }).catch((error) => ({
          ok: false,
          error: error.message,
        }))
        if (restored.ok) {
          restoredByBackup = true
          if (backupState.record.id) restoreProfileFiles(join(layout.backupsDir, backupState.record.id), layout.profileDir)
          log(`已从完整备份还原：${restored.version ?? '未知'}`)
        } else {
          log(`完整备份还原失败（${restored.error ?? '未知原因'}），改为按版本号重装`)
        }
      }
      if (!restoredByBackup) {
        const from = backupState.record?.fromVersion ?? job.fromVersion
        if (!from) throw new Error('没有可回滚的版本记录')
        log(`用 npm 重新安装旧版本 ${from}`)
        const code = await npmInstall(`@deepseek-ai/dsh@${from}`, env, logFd, npmCliOverride, { log, npmLogPath })
        if (code !== 0) throw new Error(`重新安装 ${from} 失败（npm 退出码 ${code}）`)
        if (backupState.record?.id) restoreProfileFiles(join(layout.backupsDir, backupState.record.id), layout.profileDir)
      }
      const verify = readPackageJson(join(install.dir, 'package.json'))
      if (!verify) throw new Error('回滚后安装目录不可读')
      log(`回滚后版本：${verify.version}`)
      job.status = 'rolled-back'
      job.error = reason
      job.phase = 'rolled-back'
      saveJob(layout, job)
      writeRecovery(layout, job, reason, verify.version, true)
      if (restart && port) {
        const outcome = await bringBackHost({
          installDir: install.dir,
          layout,
          profile: layout.profile,
          port,
          cwd,
          restartArgs,
          restartEntry,
          log,
          logFd,
          env,
          timeoutSeconds: settings.healthTimeoutSeconds,
        })
        // 版本已经回滚好了，宿主没起来只是"需要手动启动"，不该把 rolled-back 改判成 failed
        if (!outcome.ok) log(`回滚后宿主未能自动启动（${outcome.health?.reason ?? '未知'}），请手动运行 dsh web`)
        else log('回滚后宿主已重新启动')
      }
      return true
    } catch (error) {
      log(`回滚也失败了：${error.message}`)
      job.status = 'failed'
      job.error = `${reason}；回滚失败：${error.message}`
      job.phase = 'rollback-failed'
      saveJob(layout, job)
      writeRecovery(layout, job, reason, null, false)
      return false
    }
  }

  try {
    // ---- preflight ----
    mark('preflight', 'running')
    const problems = []
    if (!existsSync(join(install.dir, 'package.json'))) problems.push('安装目录缺少 package.json')
    if (!existsSync(join(install.dir, 'lib', 'bin.js'))) problems.push('安装目录缺少 lib/bin.js（无法重启）')
    try {
      const globalRoot = globalRootOf(install.dir)
      const probe = join(globalRoot, `.dsh-auto-update-probe-${process.pid}`)
      writeFileSync(probe, 'ok')
      log(`全局目录可写：${globalRoot}`)
      // 探针文件留着不影响任何东西，下次更新会被 cleanStaleStaging 清掉
      void probe
    } catch (error) {
      problems.push(`全局安装目录不可写：${error.message}`)
    }
    if (problems.length > 0) throw new Error(problems.join('；'))
    mark('preflight', 'ok', dryRun ? '检查通过（演练）' : '检查通过')

    // ---- stop：只停，不起（"停止 DSH"按钮 / 折腾不动时的后路）----
    if (action === 'stop') {
      if (!port) throw new Error('缺少 --port（不知道该停哪个端口的宿主）')
      mark('stop-host', 'running')
      const stopped = await stopHost(port, log, { strict: true })
      mark('stop-host', 'ok', stopped)
      job.host.restarted = false
      job.status = 'succeeded'
      job.phase = 'done'
      job.endedAt = Date.now()
      saveJob(layout, job)
      log('DSH 已停止。把它再拉起来：桌面上的「启动DSH.cmd」，或设置页的「重启 DSH」。')
      return
    }

    // ---- restart：只重启，不动版本（设置页的"重启 DSH"与看护进程都走这条）----
    if (action === 'restart') {
      if (!port) throw new Error('缺少 --port（不知道该在哪个端口重启）')
      // 先把现在这个宿主停掉再起，否则新进程只会 EADDRINUSE。
      // 严格模式：停不掉就别假装重启成功，直接报错让用户看到。
      mark('stop-host', 'running')
      const stopped = await stopHost(port, log, { strict: true })
      mark('stop-host', 'ok', stopped)
      mark('restart', 'running')
      const outcome = await bringBackHost({
        installDir: install.dir,
        layout,
        profile: layout.profile,
        port,
        cwd,
        restartArgs,
        restartEntry,
        log,
        logFd,
        env,
        timeoutSeconds: settings.healthTimeoutSeconds,
        onFirstSpawn: () => {
          job.host.restarted = true
          job.host.url = `http://127.0.0.1:${port}/`
        },
      })
      mark('restart', 'ok', `已启动 --port ${port}`)
      mark('health', 'running')
      const health = outcome.health
      if (!outcome.ok) throw new Error(`重启健康检查失败：${health?.reason ?? '未知'}`)
      job.host.healthChecked = true
      job.host.healthMs = health.ms
      mark('health', 'ok', `${health.ms}ms 内有响应`)
      job.status = 'succeeded'
      job.phase = 'done'
      job.endedAt = Date.now()
      saveJob(layout, job)
      log(`== 已重启：${install.version} ==`)
      return
    }

    // ---- backup（update 才有；rollback 用已有备份）----
    if (action === 'update') {
      mark('backup', 'running')
      progress.start('打包安装目录（约 500 MB，通常 20 秒左右）')
      const planned = settings.backupMode === 'full' ? 'full' : 'metadata'
      log(`备份模式：${planned}`)
      const created = await createBackup({
        layout,
        install: { dir: install.dir, version: install.version },
        mode: planned,
        jobId: job.id,
        log,
        logFd,
      })
      backupState.record = created.record
      backupState.mode = created.record?.mode ?? null
      job.backupId = created.record?.id ?? null
      saveJob(layout, job)
      progress.stop('备份完成')
      mark('backup', 'ok', created.record ? `${created.record.mode === 'full' ? '完整备份' : '仅版本+配置'} ${created.record.bytes ? `${(created.record.bytes / 1048576).toFixed(1)}MB` : ''}` : '已完成')
      if (created.record?.reason) log(created.record.reason)
      if (!created.ok) throw new Error('备份失败')
      if (dryRun) {
        for (const key of ['stop-host', 'install', 'verify', 'plugins', 'restart', 'health']) mark(key, 'skipped', '演练模式')
        job.status = 'succeeded'
        job.phase = 'done'
        job.endedAt = Date.now()
        saveJob(layout, job)
        log('== 演练结束 ==')
        return
      }
    } else if (action === 'rollback') {
      const id = String(args.backup ?? '')
      const record = id ? readBackup(layout, id) : null
      if (!record) {
        // 兜底：备份记录没了（或被手工删了）也能回滚——按 task 里记的原版本号重装
        const from = String(args['from-version'] ?? job.fromVersion ?? '')
        if (!from) throw new Error(`找不到备份 ${id || '(未指定)'}，也没有记录原版本号`)
        log(`没有可用备份记录，改为按版本号重装 ${from}`)
        backupState.record = { id: null, mode: 'metadata', fromVersion: from }
      } else {
        backupState.record = record
        log(`使用备份 ${record.id}（${record.mode}，来源版本 ${record.fromVersion}）`)
      }
      job.backupId = backupState.record.id
      job.fromVersion = backupState.record.fromVersion
      backupState.mode = backupState.record.mode
      saveJob(layout, job)
    } else {
      job.fromVersion = install.version
      job.toVersion = install.version
      saveJob(layout, job)
    }

    // ---- stop-host ----
    if (action !== 'sync-plugins') {
      mark('stop-host', 'running')
      const stopped = await stopHost(port, log, { strict: true })
      mark('stop-host', 'ok', stopped)
    }

    // ---- install / restore ----
    let nextVersion = install.version
    if (action === 'update') {
      mark('install', 'running')
      const spec = `@deepseek-ai/dsh@${String(args.target ?? '')}`
      if (!args.target) throw new Error('缺少 --target（要升级到的版本）')
      log(`npm install -g ${spec}（要装上百个包，通常 1–5 分钟；下面这行会一直走）`)
      progress.start(`正在安装 ${spec}`)
      const code = await npmInstall(spec, env, logFd, npmCliOverride, { log, npmLogPath, progress })
      progress.stop(code === 0 ? `安装完成 ${spec}` : `安装失败（退出码 ${code}）`)
      if (code !== 0) throw new Error(`npm 安装失败（退出码 ${code}）`)
      mark('install', 'ok', spec)
    } else if (action === 'rollback') {
      mark('restore', 'running')
      let restoredByBackup = false
      if (backupState.record.mode === 'full') {
        const restored = await restoreFullBackup({ record: backupState.record, targetDir: install.dir, log, logFd }).catch((error) => ({
          ok: false,
          error: error.message,
        }))
        if (restored.ok) {
          restoredByBackup = true
          nextVersion = restored.version ?? ''
        } else {
          log(`完整备份还原失败（${restored.error ?? '未知原因'}），改为按版本号重装`)
        }
      }
      if (!restoredByBackup) {
        const from = backupState.record?.fromVersion ?? job.fromVersion
        if (!from) throw new Error('完整备份还原失败，而且任务里没有旧版本号，无法自动重装')
        const code = await npmInstall(`@deepseek-ai/dsh@${from}`, env, logFd, npmCliOverride, { log, npmLogPath })
        if (code !== 0) throw new Error(`npm 安装旧版本失败（退出码 ${code}）`)
        nextVersion = from
      }
      if (backupState.record.id) restoreProfileFiles(join(layout.backupsDir, backupState.record.id), layout.profileDir)
      mark('restore', 'ok', `已还原到 ${nextVersion}`)
    }

    // ---- verify ----
    if (action !== 'sync-plugins') {
      mark('verify', 'running')
      const manifest = readPackageJson(join(install.dir, 'package.json'))
      if (!manifest) throw new Error('安装后读不到 package.json')
      if (!existsSync(join(install.dir, 'lib', 'bin.js'))) throw new Error('安装目录缺少 lib/bin.js')
      const version = manifest.version ?? ''
      if (action === 'update' && version !== String(args.target)) {
        throw new Error(`安装后版本校验不符：期望 ${args.target}，实际 ${version}`)
      }
      nextVersion = version
      job.toVersion = version
      cleanStaleStaging(globalRootOf(install.dir))
      saveJob(layout, job)
      mark('verify', 'ok', `版本 ${version}`)
    }

    // ---- plugins（插件同步）----
    if (action === 'update' || action === 'sync-plugins') {
      mark('plugins', 'running')
      progress.start('检查已装插件的兼容性')
      const report = await syncPlugins({ layout, install, targetVersion: nextVersion, env, logFd, log, registry: settings.registry, onlyBroken: action === 'update' || !settings.syncPlugins })
      job.pluginReport = report
      saveJob(layout, job)
      const summary = report?.summary
      progress.stop()
      mark('plugins', 'ok', summary ? `用户插件 ${summary.userPlugins}：可用 ${summary.ok}，需处理 ${summary.incompatible + summary.unknown + summary.missing}` : '已扫描')
    }

    if (action === 'sync-plugins') {
      job.status = 'succeeded'
      job.phase = 'done'
      job.endedAt = Date.now()
      saveJob(layout, job)
      log('== 插件同步完成 ==')
      return
    }

    // ---- restart + health ----
    if (!restart || !port) {
      mark('restart', 'skipped', '未要求重启')
      mark('health', 'skipped', '未要求重启')
      job.status = 'succeeded'
    } else {
      mark('restart', 'running')
      const outcome = await bringBackHost({
        installDir: install.dir,
        layout,
        profile: layout.profile,
        port,
        cwd,
        restartArgs,
        restartEntry,
        log,
        logFd,
        env,
        timeoutSeconds: settings.healthTimeoutSeconds,
        onFirstSpawn: () => {
          job.host.restarted = true
          job.host.url = `http://127.0.0.1:${port}/`
          saveJob(layout, job)
        },
      })
      mark('restart', 'ok', `已启动 dsh web --port ${port}`)
      progress.start('等待宿主启动并自检（最多 90 秒）')
      if (!outcome.ok) throw new Error(`重启健康检查失败：${outcome.health?.reason ?? '未知'}`)
      const health = outcome.health
      job.host.healthChecked = true
      job.host.healthMs = health.ms
      progress.stop('宿主已就绪')
      mark('health', 'ok', `${health.ms}ms 内有响应${health.status ? `（HTTP ${health.status}）` : ''}`)
      // 体检补一刀：读这次重启之后的启动输出，找出"装得上但没激活"的插件。
      await collectActivation({ layout, job, log, offset: outcome.restartOffset ?? 0 })
      // 收尾自检：健康检查可能探到"别人"（例如看护进程正在还原的宿主），所以再核一遍账。
      const audit = auditOutcome({ layout, job, install, targetVersion: nextVersion, restarted: true })
      if (audit.superseded) {
        job.status = ROLLED_BACK
        job.phase = ROLLED_BACK
        job.error = audit.message
        job.endedAt = Date.now()
        saveJob(layout, job)
        log(`== 任务已被看护进程接管：${audit.message} ==`)
        return
      }
      if (audit.message) throw new Error(audit.message)
      announceUrl({ layout, job, port, log })
      job.status = 'succeeded'
    }
    job.status = action === 'rollback' ? ROLLED_BACK : job.status
    job.phase = action === 'rollback' ? ROLLED_BACK : 'done'
    job.endedAt = Date.now()
    saveJob(layout, job)
    try {
      const removed = pruneBackups(layout, settings.keepBackups)
      if (removed.length > 0) log(`清理旧备份：${removed.join(', ')}`)
    } catch {
      // 清理失败不算更新失败
    }
    log(`== ${action} 成功：${install.version} → ${nextVersion} ==`)
  } catch (error) {
    log(`失败：${error.stack ?? error.message}`)
    const marked = job.steps.find((step) => step.status === 'running')
    if (marked) {
      marked.status = 'failed'
      marked.message = error.message
      marked.endedAt = Date.now()
      saveJob(layout, job)
    }
    if (action === 'update' && backupState.record) {
      const ok = await rollback(error.message)
      if (!ok) {
        job.status = 'failed'
        job.error = error.message
        job.endedAt = Date.now()
        saveJob(layout, job)
      }
    } else if (action === 'rollback') {
      job.status = 'failed'
      job.error = `回滚失败：${error.message}`
      job.endedAt = Date.now()
      saveJob(layout, job)
      writeRecovery(layout, job, error.message, null, false)
    } else {
      job.status = 'failed'
      job.error = error.message
      job.endedAt = Date.now()
      saveJob(layout, job)
    }
  } finally {
    try {
      clearInterval(beatTimer)
    } catch {
      // 忽略
    }
    // 正常跑完就把看护进程收掉；异常/被杀时它会接管并回滚
    try {
      if (watchdogProc) watchdogProc.kill()
    progress.stop()
    } catch {
      // 忽略
    }
    try {
      unlinkSync(pidPath)
    } catch {
      // 忽略
    }
    try {
      closeSync(logFd)
    } catch {
      // 忽略
    }
    // 退出码就是结论：0 = 达成目标；2 = 已自动回滚（更新没成功，但系统是好的）；
    // 1 = 失败且没回滚成。CLI 与自动化脚本靠它判断，宿主侧只读任务状态。
    if (job.status === 'rolled-back') process.exitCode = 2
    else if (job.status !== 'succeeded') process.exitCode = 1
    // 可见窗口：自己等一次按键再退出，控制台跟着关。
    // 失败时窗口里已经有完整报错行，多停一下是好事；成功时也是一按就走。
    if (visible) {
      await waitForAnyKey()
      // 按了键就一定要关窗：健康检查用的 fetch 会在 undici 里留空闲连接，
      // 光靠"事件循环空了自然退出"会让窗口多挂几秒（甚至不关）。
      // 状态此时已全部落盘，直接退出不会丢任何东西。
      await new Promise((resolve) => setTimeout(resolve, 80))
      process.exit(process.exitCode ?? 0)
    }
  }
}

/**
 * 拉起看护进程（隐藏窗口、detached，不随命令行窗口一起被杀）。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {object} job
 * @param {{port: number | null, cwd: string, npmCliOverride?: string}} options
 */
function startWatchdog(layout, job, options) {
  try {
    const argv = [WATCHDOG, '--job', job.id, '--state-dir', layout.stateDir, '--dsh-home', layout.dshHome]
    if (options.port) argv.push('--port', String(options.port))
    if (options.cwd) argv.push('--cwd', options.cwd)
    if (options.npmCliOverride) argv.push('--npm-cli', String(options.npmCliOverride))
    const fd = openSync(join(layout.logsDir, `${job.id}.watchdog.log`), 'a')
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, DSH_HOME: layout.dshHome },
    })
    child.unref()
    return child
  } catch (error) {
    // 看护进程起不来不该阻断更新本身，但要留痕
    appendLog(layout, job, `看护进程启动失败（窗口意外关闭时不会自动回滚）：${error.message}`)
  }
  return null
}

/** 打印错误并退出。 */
function fail(message) {
  process.stderr.write(`dsh-auto-update runner: ${message}\n`)
  process.exitCode = 2
}

/**
 * 再 spawn 一个自己（去掉 --defer），然后立刻退出，让自己变成孤儿进程。
 * @param {Record<string, string | boolean>} args
 */
function deferSelf(args) {
  const passthrough = []
  for (const [key, value] of Object.entries(args)) {
    if (key === 'defer') continue
    passthrough.push(`--${key}`)
    if (value !== true) passthrough.push(String(value))
  }
  const child = spawn(process.execPath, [process.argv[1], ...passthrough], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: process.cwd(),
    env: process.env,
  })
  child.unref()
}

/**
 * 找已安装的 dsh。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {Record<string, string | boolean>} args
 * @returns {{dir: string, version: string} | null}
 */
function pickInstall(layout, args) {
  const found = locateDshInstall(layout, { globalRoot: args['global-root'] ? String(args['global-root']) : undefined })
  if (!found) return null
  return { dir: found.dir, version: found.version }
}

/**
 * 子进程环境：把 node 所在目录与 npm 全局 bin 前置进 PATH。
 *
 * `dsh plugin` 内部要靠 PATH 找到 pnpm，而受限环境里 PATH 往往不全，所以显式补上
 * `%APPDATA%\npm`（pnpm.cmd 与 dsh.cmd 都在那里）。
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv() {
  const env = { ...process.env }
  const extra = [dirname(process.execPath)]
  if (process.platform === 'win32' && process.env.APPDATA) extra.push(join(process.env.APPDATA, 'npm'))
  const separator = process.platform === 'win32' ? ';' : ':'
  const current = env.PATH ?? env.Path ?? ''
  env.PATH = [...extra, current].filter(Boolean).join(separator)
  if (process.platform === 'win32') env.Path = env.PATH
  return env
}

/**
 * 跑一次 `npm install -g`。
 *
 * 优先用 `node <npm-cli.js>`，避免依赖 cmd 解析与 .cmd 后缀；找不到 npm 时退回 `npm.cmd`。
 * @param {string} spec
 * @param {NodeJS.ProcessEnv} env
 * @param {number} logFd
 * @returns {Promise<number>}
 */
async function npmInstall(spec, env, logFd, override, hooks = {}) {
  const npmCli = override || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  /** @type {string} */
  let file
  /** @type {string[]} */
  let argv
  if (existsSync(npmCli)) {
    file = process.execPath
    argv = [npmCli, 'install', '--global', spec, '--no-fund', '--no-audit', '--loglevel=http']
  } else {
    file = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    argv = ['install', '--global', spec, '--no-fund', '--no-audit', '--loglevel=http']
  }
  // npm 自己的输出另存一个文件再"跟读"着打到控制台：
  // 全局安装要装上百个包，实测 3 分多钟里 npm 只偶尔吐几行，光靠转圈不够。
  const startAt = Date.now()
  const own = typeof hooks.npmLogPath === 'string' ? hooks.npmLogPath : ''
  const npmFd = own ? openSync(own, 'a') : logFd
  const follower = own && typeof hooks.log === 'function' ? followFile(own, (line) => {
        hooks.progress?.bump?.()
        hooks.log(`  npm · ${line}`)
      }) : null
  try {
    const code = await runChild(file, argv, { env, logFd: npmFd, cwd: dirname(process.execPath) })
    if (typeof hooks.log === 'function') {
      hooks.log(`npm 结束：退出码 ${code}，耗时 ${formatElapsed(Math.round((Date.now() - startAt) / 1000))}`)
    }
    return code
  } finally {
    follower?.stop()
    if (own) {
      try {
        closeSync(npmFd)
      } catch {
        // 关不掉也无所谓
      }
    }
  }
}

/**
 * 控制台上那行"转圈"的进度提示。
 *
 * 为什么需要它：npm 全局安装 dsh 要装上百个包，实测 3 分多钟，期间它自己几乎不输出
 * （输出又都进了日志文件），窗口看起来像卡死。这里每秒原地刷新一行"已用 65 秒 · 当前阶段"，
 * 让人一眼看到还活着。只在 --visible（有个真控制台）时输出。
 * @param {{visible: boolean, write: (text: string) => void}} hooks
 */
function createProgress(hooks) {
  const state = { timer: null, label: '', startedAt: 0, painted: false, frame: 0, bumps: 0 }
  // 转动的"菊花"：比静止的图标更像"在动"，一秒一跳
  const frames = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f']
  // 中文按两个字符宽度算，否则覆盖旧行时会残留半行
  const width = (text) => {
    let total = 0
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0
      const wide =
        code >= 0x1100 &&
        (code <= 0x115f ||
          (code >= 0x2e80 && code <= 0xa4cf) ||
          (code >= 0xac00 && code <= 0xd7a3) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xfe30 && code <= 0xfe6f) ||
          (code >= 0xff00 && code <= 0xff60) ||
          (code >= 0xffe0 && code <= 0xffe6))
      total += wide ? 2 : 1
    }
    return total
  }
  const paint = () => {
    if (!hooks.visible || !state.label) return
    const seconds = Math.round((Date.now() - state.startedAt) / 1000)
    state.frame = (state.frame + 1) % frames.length
    const extra = state.bumps > 0 ? ` · npm 输出 ${state.bumps} 行` : ''
    const text = `   ${frames[state.frame]} ${state.label} · 已用 ${formatElapsed(seconds)}${extra}`
    hooks.write(`\r${text}${' '.repeat(Math.max(0, 74 - width(text)))}`)
    state.painted = true
  }
  return {
    /** 开始一个新阶段（会先擦掉上一行） */
    start(label) {
      this.clear()
      state.label = label
      state.startedAt = Date.now()
      state.frame = 0
      state.bumps = 0
      if (hooks.visible) {
        state.timer = setInterval(paint, 1000)
        state.timer.unref?.()
        paint()
      }
    },
    /** 阶段内改文案，不重置计时 */
    update(label) {
      if (!state.label) {
        this.start(label)
        return
      }
      state.label = label
      paint()
    },
    /** 结束阶段，留一行用时 */
    stop(label) {
      if (state.timer) clearInterval(state.timer)
      state.timer = null
      if (state.label && hooks.visible) {
        const seconds = Math.round((Date.now() - state.startedAt) / 1000)
        const text = label ? `   \u2714 ${label}（用时 ${formatElapsed(seconds)}）` : ''
        hooks.write(`\r${text}${' '.repeat(Math.max(0, 74 - width(text)))}\n`)
      }
      state.label = ''
      state.painted = false
    },
    /** 有新的子进程输出被转发过来：只计数，让转圈行多一个"它在动"的证据 */
    bump() {
      state.bumps += 1
      if (state.bumps % 4 === 0) paint()
    },
    /** 要写普通日志了，先把进度行擦掉，免得两行糊在一起 */
    clear() {
      if (state.painted && hooks.visible) {
        hooks.write(`\r${' '.repeat(74)}\r`)
        state.painted = false
      }
    },
  }
}

/** 秒 → "1 分 05 秒" */
function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`
}

/**
 * 跟读一个正在被别的进程写入的文本文件，把新增的完整行交给回调。
 *
 * 用途：npm 的 stdout/stderr 进了日志文件（不建管道，见 runChild 的注释），
 * 这里再用普通文件读把新内容捞出来打到控制台，等于"实时转发"。
 * @param {string} file
 * @param {(line: string) => void} onLine
 * @param {{intervalMs?: number, max?: number}} [options]
 */
function followFile(file, onLine, options = {}) {
  const intervalMs = options.intervalMs ?? 800
  const maxLines = options.max ?? 500
  let offset = 0
  let buffer = ''
  let seen = 0
  const drain = () => {
    let chunk = ''
    try {
      const size = statSync(file).size
      if (size <= offset) return
      const fd = openSync(file, 'r')
      const raw = Buffer.alloc(size - offset)
      readSync(fd, raw, 0, raw.length, offset)
      closeSync(fd)
      offset = size
      chunk = raw.toString('utf8')
    } catch {
      return
    }
    if (!chunk) return
    buffer += chunk
    const parts = buffer.split(/\r?\n/)
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trim()
      if (!line) continue
      seen += 1
      if (seen > maxLines) return
      onLine(line.length > 160 ? `${line.slice(0, 160)}…` : line)
    }
  }
  const timer = setInterval(drain, intervalMs)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      drain()
    },
  }
}

/**
 * 跑子进程，输出全部落到日志 fd（不建管道）。
 * @param {string} file
 * @param {string[]} argv
 * @param {{env: NodeJS.ProcessEnv, logFd: number, cwd?: string}} options
 * @returns {Promise<number>}
 */
function runChild(file, argv, options) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, argv, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', options.logFd, options.logFd],
        windowsHide: true,
      })
    } catch {
      resolve(-1)
      return
    }
    child.on('error', () => resolve(-1))
    child.on('close', (code) => resolve(code ?? -1))
  })
}

/**
 * 停掉占用端口的进程（也就是宿主自己）。
 *
 * 强制结束而不是优雅退出：宿主正在跑我们注册的路由，等它"优雅"关机可能永远等不到；
 * 更新期间短暂不可用是可以接受的，客户端会显示"正在重启"并轮询。
 * @param {number | null} port
 * @param {(line: string) => void} log
 * @returns {Promise<string>}
 */
async function stopHost(port, log, options = {}) {
  if (!port) return '未提供端口，跳过'
  const pids = await findListeningPids(port, log)
  if (pids.length === 0) {
    log(`端口 ${port} 上没有监听进程（可能已停止）`)
    return '端口已空闲'
  }
  for (const pid of pids) {
    log(`结束进程 ${pid}（占用端口 ${port}）`)
    await taskkill(pid, log)
  }
  const ok = await waitPortFree(port, 15_000)
  if (ok) {
    log(`端口 ${port} 已释放`)
    return `已停止 PID ${pids.join(', ')}`
  }
  log(`端口 ${port} 仍被占用（PID ${pids.join(', ')}）`)
  // 更新流程里这一步失败必须中止：宿主还活着时替换全局目录里的文件会失败或留下半装状态。
  // 回滚流程里只警告——那时已经没有更好的选择，能还原多少算多少。
  if (options.strict) {
    throw new Error(
      `无法停止占用端口 ${port} 的进程（PID ${pids.join(', ')}）。` +
        '它可能以管理员权限启动，请手动结束该进程后重试。',
    )
  }
  return `停止 PID ${pids.join(', ')} 后端口仍被占用`
}

/**
 * 找监听指定端口的进程号。
 * @param {number} port
 * @param {(line: string) => void} log
 * @returns {Promise<number[]>}
 */
async function findListeningPids(port, log) {
  const out = await capture(['netstat', ['-ano', '-p', 'TCP']])
  if (!out) {
    log('netstat 不可用，改用连接探测判断')
    return []
  }
  const pids = new Set()
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.includes('LISTENING')) continue
    const fields = trimmed.split(/\s+/)
    if (fields.length < 5) continue
    if (!fields[1].endsWith(`:${port}`)) continue
    const pid = Number(fields[4])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/**
 * 结束一个进程；Windows 用 taskkill，其它平台用 SIGTERM → SIGKILL。
 *
 * PATH 上的 `taskkill` 可能不是 Windows 自带的那个（本机的 DSH ops 环境里就有一个
 * 会篡改 `/PID` 参数的 shim），所以 Windows 下优先用 System32 的绝对路径；
 * 再退回 Node 自己的 `process.kill`（Windows 上等价于 TerminateProcess，不经过 PATH）。
 * @param {number} pid
 * @param {(line: string) => void} [log]
 * @returns {Promise<boolean>} 是否确认已结束
 */
async function taskkill(pid, log) {
  if (pid === process.pid) {
    log?.('跳过结束自身进程')
    return false
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM')
      await sleep(1500)
    } catch {
      // 已经退出
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经退出
    }
    return !alive(pid)
  }
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const exe = join(systemRoot, 'System32', 'taskkill.exe')
  if (existsSync(exe)) {
    await capture([exe, ['/PID', String(pid), '/T', '/F']])
    await sleep(300)
    if (!alive(pid)) return true
  }
  try {
    process.kill(pid)
    await sleep(300)
  } catch {
    // 权限不足或已退出
  }
  if (!alive(pid)) return true
  log?.(`进程 ${pid} 未能结束（可能以更高权限运行）`)
  return false
}

/**
 * 进程是否还活着。
 * @param {number} pid
 * @returns {boolean}
 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * 等端口空闲。
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitPortFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return true
    await sleep(250)
  }
  return !(await portOpen(port))
}

/**
 * 端口是否还有人监听。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function portOpen(port) {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (open) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(800)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 简单睡眠。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 等一次按键，然后让 node 自己退出（控制台随之关闭）。
 *
 * 为什么不用 cmd 的 `pause`：那个窗口是 `start ... <shim>.cmd` 开的，
 * `pause` 之后严格来说 cmd 会退出、窗口会关，但实际终端（Windows Terminal 的
 * closeOnExit 设置、"运行完保持窗口"之类）经常把窗口留住，用户按了键也不走。
 * node 是那个控制台的原始进程，它退出时窗口一定关。
 * @param {string} [message]
 * @returns {Promise<boolean>}
 */
async function waitForAnyKey(message = '\n按任意键关闭本窗口…') {
  const stdin = process.stdin
  if (!stdin?.isTTY) return false
  process.stdout.write(message)
  const wasRaw = stdin.isRaw === true
  try {
    stdin.setRawMode?.(true)
  } catch {
    // 不支持裸模式也无所谓，按回车一样能过
  }
  stdin.resume()
  await new Promise((resolve) => {
    const done = () => {
      stdin.off('data', done)
      try {
        stdin.setRawMode?.(wasRaw)
      } catch {
        // 忽略
      }
      stdin.pause()
      resolve()
    }
    stdin.on('data', done)
  })
  process.stdout.write('\n')
  return true
}

/**
 * 启动新的 dsh web。
 *
 * 用 `node <installDir>/lib/bin.js --profile <profile> --port <port>`：
 * 这条路径等价于 `dsh web --port <port>`，但不依赖 PATH 上的 dsh.cmd（更新后 bin 链接可能还没重建）。
 * @param {object} input
 * @param {string} input.installDir
 * @param {ReturnType<typeof resolveLayout>} input.layout
 * @param {string} input.profile
 * @param {number} input.port
 * @param {string} input.cwd
 * @param {string[]} [input.restartArgs] 宿主原来的启动参数
 * @param {string} [input.restartEntry] 宿主原来的入口脚本
 * @param {(line: string) => void} input.log
 * @param {number} input.logFd
 * @param {NodeJS.ProcessEnv} input.env
 */
/**
 * 重启宿主并等它活过来，最多两次（中间清一次端口）。
 * 一次就够时不会多此一举；第一次起来就退出时立刻重试，而不是傻等满超时。
 */
async function bringBackHost(input) {
  const { port, log } = input
  // 记录重启前的日志长度：之后只解析"这次重启之后"的启动输出，
  // 否则会把上一轮（例如失败前那次）的告警重复算进来。
  let restartOffset = 0
  try {
    restartOffset = fstatSync(input.logFd).size
  } catch {
    restartOffset = 0
  }
  let health = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) {
      // 重试前先看清现场：端口上如果已经有进程在监听，说明上一次其实起来了
      //（只是响应慢，或者正在处理鉴权跳转），这时候再 spawn 一个必然抢端口。
      if (await portOpen(port)) {
        log(`端口 ${port} 上已经有进程在监听（上一轮：${health?.reason ?? '未知'}），不再重复启动，继续等它响应`)
        health = await waitHealthy(port, input.timeoutSeconds ?? 90, log, null)
        if (health.ok) return { ok: true, health, restartOffset }
        return { ok: false, health, restartOffset }
      }
      log(`第 1 次重启后进程已退出（${health?.reason ?? '未知'}），清理端口后重试`)
      await stopHost(port, log)
    }
    const child = await restartHost(input)
    if (attempt === 1 && input.onFirstSpawn) input.onFirstSpawn()
    const budget = attempt === 1 ? Math.min(input.timeoutSeconds ?? 90, 45) : input.timeoutSeconds ?? 90
    health = await waitHealthy(port, budget, log, child)
    if (health.ok) return { ok: true, health, restartOffset }
  }
  // 兜底：可见窗口在某些环境里可能根本拉不起来（start 被策略拦、无交互桌面、被杀软挡住……）。
  // 到这一步"没有窗口"可以接受，"起不来"不可接受——所以最后再用后台进程试一次。
  log('可见窗口没能起来，最后再用后台进程试一次（没有窗口，但 DSH 能跑）')
  await stopHost(port, log)
  const fallbackChild = await restartHost({ ...input, forceHidden: true })
  health = await waitHealthy(port, input.timeoutSeconds ?? 90, log, fallbackChild)
  if (health.ok) return { ok: true, health, restartOffset }
  return { ok: false, health, restartOffset }
}

/**
 * 读重启后的启动日志，把"插件没激活"归因出来写进任务。
 *
 * 为什么放在这里：peerDependencies 只能证明"版本区间满足"，证明不了"依赖的服务还在"。
 * 0.2.1-rc.4 就出现过 better-sidebar 版本检查通过、但宿主启动时一直
 * `pending (waiting for service: webRuntime)`——这个信号只在启动日志里。
 * @param {{layout: any, job: any, log: (line: string) => void, offset: number}} input
 */
async function collectActivation(input) {
  const { layout, job, log } = input
  if (!job.logPath) return
  // 宿主是刚 spawn 的，告警行通常早于监听端口，但给后端一点余量。
  await sleep(600)
  let scanned = null
  try {
    scanned = scanActivation(job.logPath, {
      offset: input.offset,
      plugins: job.pluginReport?.plugins ?? [],
    })
  } catch (error) {
    log(`启动日志体检失败（不影响更新）：${error.message}`)
    return
  }
  const groups = scanned.groups.map((group) => ({
    packageName: group.packageName,
    pluginStatus: group.plugin?.status ?? null,
    explanation: group.explanation,
    entries: group.entries.map((entry) => ({
      entry: entry.entry,
      reason: entry.reason,
      service: entry.service ?? null,
      explanation: entry.explanation,
    })),
  }))
  job.activation = {
    scannedAt: scanned.scannedAt,
    count: groups.length,
    summary: scanned.summary.summary,
    pendingCount: scanned.pendingCount,
    requiredMissing: scanned.requiredMissing,
    groups,
  }
  saveJob(layout, job)
  if (groups.length === 0) {
    log('启动体检：所有插件都激活了')
    return
  }
  log(`启动体检：${scanned.summary.summary}`)
  for (const group of groups) log(`  - ${group.packageName}：${group.explanation}`)
}

/**
 * 生成"可见控制台窗口"的启动器脚本（node，不是批处理）。
 *
 * 为什么不用批处理：批处理只能无条件 `pause`，无法区分"DSH 被我们停掉"和"DSH 启动就崩"，
 * 于是每次重启都会把上一个 DSH 的窗口留在桌面上（用户实测越点越多窗口）。
 * node 启动器能拿到子进程的退出码和存活时长，可以做到"启动期崩溃才停住、正常停止直接关窗"。
 *
 * 环境变量 `DSH_AUTO_UPDATE_LAUNCH_GRACE_MS` 可改"启动期"阈值（默认 20 秒），测试用。
 */
function buildLauncherScript({ entry, argv, cwd, port }) {
  const write = (value) => JSON.stringify(value)
  return [
    '// 由 dsh-auto-update 生成：在可见控制台里跑 DSH，并决定退出后要不要留住窗口。',
    "import { spawn } from 'node:child_process'",
    "import { join } from 'node:path'",
    `const entry = ${write(entry)}`,
    `const args = ${write(argv)}`,
    `const cwd = ${write(cwd)}`,
    `const port = ${write(String(port ?? ''))}`,
    'const graceMs = Number(process.env.DSH_AUTO_UPDATE_LAUNCH_GRACE_MS || 20000)',
    'const canWaitForKey = Boolean(process.stdin && process.stdin.isTTY)',
    'try { process.title = `DSH web ${port}` } catch {}',
    'process.stdout.write(`DSH web ${port}  启动中…（这个窗口就是 DSH 本体，Ctrl+C 可停）\\n`)',
    'const startedAt = Date.now()',
    "const child = spawn(process.execPath, [entry, ...args], { cwd, stdio: 'inherit', env: process.env })",
    'let shuttingDown = false',
    'let killTimer = null',
    'const waitThenExit = (code) => {',
    '  if (!canWaitForKey) process.exit(code)',
    '  process.stdout.write("按任意键关闭本窗口…")',
    '  process.stdin.resume()',
    "  process.stdin.once('data', () => process.exit(code))",
    '}',
    '// Ctrl+C 走这里。为什么必须自己动手：',
    '// 1) 控制台的 Ctrl+C 发给"整个控制台"，子进程是否响应取决于它自己有没有装处理器；',
    '// 2) 即便 DSH 收到了，优雅退出也可能被插件（隧道、子进程、未完成的请求）卡住不返回；',
    '// 3) node 在 Windows 上没有"给子进程发信号"这回事，child.kill() 等于直接 TerminateProcess。',
    '// 所以：先给 DSH 1 秒自己收尾，再用 taskkill /T /F 收掉整棵子树，最后兜一层 child.kill()。',
    '// 不能只靠 taskkill——它在受限环境里可能被拦或起不来，那就会"按了没反应"。',
    'const forceKillChild = () => {',
    '  try { child.kill() } catch {}',
    '}',
    'const killChildTree = () => {',
    '  try {',
    "    const tk = join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'taskkill.exe')",
    "    const killer = spawn(tk, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })",
    "    killer.on('error', () => { forceKillChild() })",
    '  } catch {',
    '    forceKillChild()',
    '  }',
    '  setTimeout(forceKillChild, 700)',
    '  // 安全网：万一进程杀不掉，也别让这个窗口卡住不退',
    '  setTimeout(() => process.exit(1), 5000)',
    '}',
    'const onInterrupt = (label) => {',
    '  if (shuttingDown) return',
    '  shuttingDown = true',
    '  process.stdout.write(`\\n收到 ${label}，正在结束 DSH…（1 秒内没退就强制结束）\\n`)',
    '  killTimer = setTimeout(killChildTree, 1000)',
    '}',
    "process.on('SIGINT', () => onInterrupt('Ctrl+C'))",
    "process.on('SIGBREAK', () => onInterrupt('Ctrl+Break'))",
    '// 自检钩子：测试里用它模拟"按下 Ctrl+C"，不必真去操作键盘',
    'const selfTestAt = Number(process.env.DSH_AUTO_UPDATE_LAUNCHER_SELFTEST_MS || 0)',
    "if (selfTestAt > 0) setTimeout(() => onInterrupt('self-test'), selfTestAt)",
    "child.on('error', (error) => {",
    '  process.stdout.write(`\\nDSH 启动失败：${error.message}\\n`)',
    '  waitThenExit(1)',
    '})',
    "child.on('exit', (code, signal) => {",
    '  if (killTimer) clearTimeout(killTimer)',
    '  const lived = Date.now() - startedAt',
    '  const label = signal ? `signal ${signal}` : `exit ${code}`',
    '  process.stdout.write(`\\n===== DSH 已退出（${label}，运行 ${Math.round(lived / 1000)} 秒）=====\\n`)',
    '  // 用户主动按 Ctrl+C（或我们自己 taskkill 收的）：窗口直接关，别停在这里',
    '  if (shuttingDown) process.exit(0)',
    '  const crashedAtStartup = lived < graceMs && !signal',
    '  if (crashedAtStartup) {',
    '    // 启动阶段就崩（端口被占、插件 startup failed、配置错）→ 留住窗口给人读报错',
    '    process.stdout.write("这看起来是启动阶段的失败，上面的报错可以直接看；")',
    '    waitThenExit(typeof code === "number" ? code : 1)',
    '    return',
    '  }',
    '  process.exit(typeof code === "number" ? code : 0)',
    '})',
    '',
  ].join('\r\n')
}
async function restartHost(input) {
  const preferred = input.restartEntry && existsSync(input.restartEntry) ? input.restartEntry : null
  const entry = preferred ?? join(input.installDir, 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`重启失败：${entry} 不存在`)
  // 注意这里拆成两半：`dshArgs` 只含**选项**，entry 单独带着。
  // 曾经直接把 [entry, ...args] 交给启动器，而启动器又拼了一次 entry，
  // 结果 DSH 收到 `node bin.js <entry> --profile web` —— 第一个位置参数被当成 profile 名，
  // 于是报 `select a profile only once`，重启直接失败（本机真的踩过）。
  const dshArgs = buildRestartArgs(input.restartArgs, input.profile, input.port)
  const argv = [entry, ...dshArgs]
  input.log(`重启：${process.execPath} ${argv.join(' ')}（cwd=${input.cwd}）`)

  // 默认给 DSH 一个**可见的控制台窗口**：任何时候都有 Ctrl+C 的位置，启动崩溃也能直接看到。
  // （之前是 detached + windowsHide 的后台进程，更新完用户就再也找不到能停它的地方了。）
  // 测试/后台场景可以用 DSH_AUTO_UPDATE_NO_WINDOW=1 退回隐藏进程。
  if (process.platform === 'win32' && process.env.DSH_AUTO_UPDATE_NO_WINDOW !== '1' && input.forceHidden !== true) {
    try {
      // 窗口外壳用**一个 node 启动器**，不用批处理：
      //  - 批处理没法判断"DSH 是正常被停掉还是启动就崩了"，只能无条件 pause，
      //    于是每次重启都把上一个 DSH 的窗口留在桌面上（用户实测就是"越点越多窗口"）；
      //  - node 能拿到子进程退出码和存活时长，可以做到"启动期崩溃才停住、正常停止直接关窗"；
      //  - 也省掉 cmd 的编码/引号坑（中文在 chcp 65001 的批处理里会被吃掉半行）。
      const launcher = join(input.layout.logsDir, `dsh-launch-${Date.now().toString(36)}.mjs`)
      writeFileSync(launcher, buildLauncherScript({ entry, argv: dshArgs, cwd: input.cwd ?? process.cwd(), port: input.port }), 'utf8')
      const comspec = process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
      const child = spawn(
        comspec,
        ['/c', 'start', `DSH web ${String(input.port ?? '')}`, '/D', input.cwd ?? process.cwd(), process.execPath, launcher],
        {
          cwd: input.cwd,
          env: { ...input.env, DSH_HOME: input.layout.dshHome },
          // 这里**故意不用 detached**：Windows 上 detached 会带 CREATE_NEW_PROCESS_GROUP，
          // 而 MSDN 写明"新进程组内的所有进程 CTRL+C 被禁用"，且这个"忽略 Ctrl+C"会被子进程继承。
          // 结果是窗口起来了、看着一切正常，但按 Ctrl+C 谁都收不到（本机实测：启动器和 DSH 都不响应）。
          // start 本身就会给新窗口一个独立的控制台和进程，不需要再叠一层 detached。
          stdio: 'ignore',
          windowsHide: false,
        },
      )
      child.unref()
      await sleep(600)
      // 返回 null 而不是 child：这个 child 是 `cmd /c start`，把窗口拉起来就立刻以 0 退出。
      // 交给 waitHealthy 会被当成"宿主进程启动后立即退出"，于是误判失败、再拉一个窗口，
      // 两个实例抢同一个端口 → 后一个 EADDRINUSE 崩在窗口里（本机真的踩过这一下）。
      return null
    } catch (error) {
      input.log(`打开可见窗口失败（${error.message}），改用后台进程重启`)
    }
  }

  const child = spawn(process.execPath, argv, {
    cwd: input.cwd,
    env: { ...input.env, DSH_HOME: input.layout.dshHome },
    detached: true,
    stdio: ['ignore', input.logFd, input.logFd],
    windowsHide: true,
  })
  child.unref()
  await sleep(400)
  return child
}

/**
 * 用宿主原来的命令行重启它，只把 `--port`（和 `--profile`）改成新值。
 *
 * 这一点很重要：用户可能用 `dsh web --host 0.0.0.0 --patch x.yml` 启动，
 * 如果重启时只传 `--profile/--port`，这些参数就丢了，界面行为跟着变。
 * @param {string[] | undefined} original
 * @param {string} profile
 * @param {number} port
 * @returns {string[]}
 */
function buildRestartArgs(original, profile, port) {
  const args = Array.isArray(original) ? [...original] : []
  // `dsh web --port 3080` 这种简写：位置参数 `web` 只是 profile 名的缩写，而且第一个位置参数
  // 之后的所有参数都会被 dsh 原样交给应用。既然下面已经补了 `--profile <name>`，这个缩写必须去掉，
  // 否则 `dsh --profile web web --port 3080` 会被 web 应用当成多余的位置参数并报
  // "too many arguments. Expected 0 arguments but got 1: web"（本机真的踩过这一下）。
  if (args.length > 0 && !args[0].startsWith('-')) args.shift()
  // --profile 一律放在最前面：dsh 用 enablePositionalOptions + passThroughOptions，
  // 第一个位置参数之后的选项都会原样交给应用，放在后面的 --profile 会被当成应用参数。
  const out = ['--profile', profile]
  let sawPort = false
  let sawNoOpen = false
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]
    if (item === '--profile') {
      index += 1
      continue
    }
    if (item.startsWith('--profile=')) continue
    if (item === '--no-open') {
      sawNoOpen = true
      continue
    }
    if (item === '--port') {
      index += 1
      out.push('--port', String(port))
      sawPort = true
      continue
    }
    if (item.startsWith('--port=')) {
      out.push(`--port=${port}`)
      sawPort = true
      continue
    }
    out.push(item)
  }
  if (!sawPort) out.push('--port', String(port))
  // 关键：`dsh web` 启动后默认会用系统浏览器打开 Web UI（它自己的 `--no-open` 选项就是关这个）。
  // 不加的话每次重启都会再弹一个新标签页，原标签还在 → 变成两个标签。
  // 重启只该重启服务，页面交给原来那个标签自己刷新。
  if (!sawNoOpen) out.push('--no-open')
  return out
}

/**
 * 收尾对账：确认这一轮到底算不算成功。
 *
 * 2026-10-29 的教训：看护进程误判、在升级收尾时把目录还原了，执行器却因为
 * 探到一次 HTTP 404 就报“成功”，用户以为升级成功、其实被撤回了。
 * 所以最后必须核对三件事：看护进程有没有接管、磁盘上的版本对不对、新宿主有没有启动失败。
 * @returns {{superseded: boolean, message: string}}
 */
function auditOutcome({ layout, job, install, targetVersion, restarted }) {
  // 注意：看护进程的 claim 文件是"锁"，它一开始看护就建好了，不能拿它判断接管。
  // 真正的接管痕迹是它写进任务里的 watchdog 字段（takeOver 时落盘）。
  const onDiskJob = readJob(layout, job.id) ?? job
  if (onDiskJob.watchdog?.reason) return { superseded: true, message: onDiskJob.watchdog.reason }
  if (onDiskJob.status === 'rolled-back') return { superseded: true, message: onDiskJob.error || '任务已被看护进程回滚' }
  const version = readPackageJson(join(install.dir, 'package.json'))?.version ?? ''
  if (version && targetVersion && version !== targetVersion) {
    return { superseded: false, message: `安装目录里现在是 ${version}，不是目标 ${targetVersion}（目录被其他进程改动过）` }
  }
  if (restarted && job.logPath) {
    const tail = readLogTail(job.logPath, 400)
    // 只有"必装插件没起来"才算启动失败。`did not activate` 也可能只是某个可选插件
    // 在等一个服务（本机 better-sidebar 就是这样），那是半残而非打不开，降级为告警。
    const activation = parseActivationWarnings(tail)
    if (activation.requiredMissing || /dsh: startup failed|Failed plugins \(\d+\)/i.test(tail)) {
      return {
        superseded: false,
        message: `新版本启动时有必需插件没起来（${activation.requiredMissing || '见日志'}），请查看日志`,
      }
    }
  }
  return { superseded: false, message: '' }
}

/** 读日志尾部若干行（读不到就返回空串）。 */
function readLogTail(file, lines) {
  try {
    const text = readFileSync(file, 'utf8')
    const all = text.split(/\r?\n/)
    return all.slice(Math.max(0, all.length - lines)).join('\n')
  } catch {
    return ''
  }
}

/**
 * 新版 DSH 首页需要带 token 才能打开，token 只打印在宿主启动日志里。
 * 更新完把这条地址抄到窗口里，免得用户打开网页看到 401 不知道怎么进。
 */
function announceUrl({ layout, job, port, log }) {
  if (!job.logPath) return
  const text = readLogTail(job.logPath, 400)
  const match = text.match(/https?:\/\/127\.0\.0\.1:\d+\/\?[^\s"'）)]+/)
  if (!match) return
  job.host.url = match[0]
  saveJob(layout, job)
  log(`访问地址（含登录令牌，请整条复制）：${match[0]}`)
}

/**
 * 等新宿主起来。
 *
 * 2xx/3xx/401/403 都算出活（首页可能需要登录、会重定向），但 404/5xx 不算：
 * 那通常说明服务还没真正就绪，或者启动到一半就塌了（2026-10-29 就吃过这个亏：
 * 回滚正在替换目录时探到一次 404，被当成"更新成功"）。
 * @param {number} port
 * @param {number} timeoutSeconds
 * @param {(line: string) => void} log
 * @returns {Promise<{ok: boolean, ms?: number, status?: number, reason?: string}>}
 */
async function waitHealthy(port, timeoutSeconds, log, child = null) {
  const started = Date.now()
  const deadline = started + Math.max(timeoutSeconds, 10) * 1000
  let lastError = '未知错误'
  let lastStatus = 0
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null && child.exitCode !== undefined) {
      return { ok: false, ms: Date.now() - started, reason: `宿主进程启动后立即退出（退出码 ${child.exitCode}）` }
    }
    if (!(await portOpen(port))) {
      lastError = '端口尚未监听'
      await sleep(500)
      continue
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(4000),
        headers: { accept: 'text/html' },
      })
      lastStatus = response.status
      if (response.status !== 404 && response.status < 500) {
        log(`健康检查：HTTP ${response.status}`)
        return { ok: true, ms: Date.now() - started, status: response.status }
      }
      lastError = `HTTP ${response.status}`
      await sleep(500)
    } catch (error) {
      lastError = error.message
      await sleep(500)
    }
  }
  return {
    ok: false,
    ms: Date.now() - started,
    status: lastStatus || undefined,
    reason: `${Math.round((Date.now() - started) / 1000)}s 内没有可用响应（${lastError}）`,
  }
}

/**
 * 解析 `--restart-args`（JSON 数组）或任务详情里已经解析好的数组。
 * @param {unknown} raw
 * @returns {string[] | undefined}
 */
function parseRestartArgs(raw) {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : undefined
  } catch {
    return undefined
  }
}

/**
 * 插件同步：让本机已安装插件在新版本 DSH 下继续可用。
 *
 * 策略是"只救必要的"：
 * 1. 官方兼容性判定（与宿主同一口径）说不兼容时，去 registry 找一个 peer 覆盖新版本的最新版，
 *    用 `dsh plugin --profile <p> add <name>@<version>` 原位覆盖；
 * 2. 找得到就装、装完复检；
 * 3. 找不到就**如实说明原因**（作者没发布兼容版本 / 精确锁死 peer / 不受官方检查覆盖的 cordis 依赖等），
 *    并给出可以手动强行安装的命令。
 * @param {object} input
 * @param {ReturnType<typeof resolveLayout>} input.layout
 * @param {{dir: string, version: string}} input.install
 * @param {string} input.targetVersion
 * @param {NodeJS.ProcessEnv} input.env
 * @param {number} input.logFd
 * @param {(line: string) => void} input.log
 * @param {boolean} [input.onlyBroken] 只处理不兼容的（更新流程）；false 时也升级到最新兼容版
 * @returns {Promise<object>}
 */
async function syncPlugins(input) {
  const scan = scanPlugins({ profileDir: input.layout.profileDir, targetVersion: input.targetVersion })
  const summary = summarizePlugins(scan)
  input.log(`插件扫描：共 ${summary.total}（用户插件 ${summary.userPlugins}：可用 ${summary.ok}，不兼容 ${summary.incompatible}，未测试 ${summary.unknown}，本地 ${summary.local}，缺失 ${summary.missing}）`)
  /** @type {object[]} */
  const changes = []
  const entry = join(input.install.dir, 'lib', 'bin.js')
  for (const plugin of userPluginsOf(scan)) {
    if (plugin.status === 'ok' || plugin.status === 'core') continue
    if (plugin.status === 'local' || plugin.status === 'missing') {
      changes.push({ name: plugin.name, action: 'none', result: 'skipped', reason: reasonText(plugin) })
      input.log(`${plugin.name}：跳过（${reasonText(plugin)}）`)
      continue
    }
    if (plugin.status === 'unknown' && input.onlyBroken !== false) {
      // unknown = 作者没声明测过，通常仍能跑；只在显式同步时才尝试升级
      changes.push({ name: plugin.name, action: 'none', result: 'kept', reason: reasonText(plugin) })
      continue
    }
    input.log(`${plugin.name}：${plugin.status}，查找兼容 ${input.targetVersion} 的版本…`)
    const found = await findCompatibleVersion({
      name: plugin.name,
      targetVersion: input.targetVersion,
      currentVersion: plugin.version,
      registry: input.registry ?? 'https://registry.npmjs.org',
      limit: 40,
      fetchManifestVersions: (name, options) =>
        fetchPackument(name, { registry: input.registry ?? 'https://registry.npmjs.org', ...options }),
    })
    if (!found.found) {
      // notes 里已经带了“检查了 N 个版本”的结论，别再拼一遍变成两句重复的话。
      const detail = found.notes?.length ? found.notes.slice(0, 3).join('；') : `已检查 ${found.checked} 个版本`
      const reason = `作者尚未发布兼容 ${input.targetVersion} 的版本：${detail}${
        found.latest ? `（作者最新版 ${found.latest} 也不兼容）` : ''
      }`
      changes.push({ name: plugin.name, action: 'none', result: 'failed', reason, currentVersion: plugin.version })
      input.log(`${plugin.name}：${reason}`)
      continue
    }
    const compatible = found.found
    if (compatible === plugin.version) {
      changes.push({ name: plugin.name, action: 'none', result: 'kept', reason: `当前版本 ${plugin.version} 已是声明兼容 ${input.targetVersion} 的最新版（registry 最新是 ${found.latest ?? '未知'}）` })
      continue
    }
    input.log(`${plugin.name}：升级 ${plugin.version} → ${compatible}`)
    const argv = [entry, 'plugin', '--profile', input.layout.profile, 'add', `${plugin.name}@${compatible}`]
    const code = await runChild(process.execPath, argv, {
      env: { ...input.env, DSH_HOME: input.layout.dshHome },
      logFd: input.logFd,
      cwd: dirname(entry),
    })
    if (code !== 0) {
      const reason = `安装 ${plugin.name}@${compatible} 失败（退出码 ${code}）`
      changes.push({ name: plugin.name, action: 'upgrade', result: 'failed', reason, to: compatible })
      input.log(reason)
      continue
    }
    changes.push({ name: plugin.name, action: 'upgrade', result: 'ok', from: plugin.version, to: compatible })
  }
  const rescanned = scanPlugins({ profileDir: input.layout.profileDir, targetVersion: input.targetVersion })
  const resummary = summarizePlugins(rescanned)
  return {
    checkedAt: Date.now(),
    targetVersion: input.targetVersion,
    summary: resummary,
    changes,
    plugins: rescanned.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      status: plugin.status,
      reason: reasonText(plugin),
    })),
  }
}

/**
 * 采集子进程输出（netstat / taskkill 这类短命令用）。
 *
 * 只有把这些命令的输出写到文件再读回来才可靠：受限环境里直接 pipe 会失败。
 * @param {[string, string[]]} command
 * @returns {Promise<string | null>}
 */
async function capture(command) {
  const [file, argv] = command
  const temp = join(process.env.TEMP ?? '/tmp', `dsh-auto-update-capture-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  let fd
  try {
    fd = openSync(temp, 'a')
  } catch {
    return null
  }
  const code = await new Promise((resolve) => {
    let child
    try {
      child = spawn(file, argv, { stdio: ['ignore', fd, fd], windowsHide: true })
    } catch {
      resolve(-1)
      return
    }
    child.on('error', () => resolve(-1))
    child.on('close', (exit) => resolve(exit ?? -1))
  })
  try {
    closeSync(fd)
  } catch {
    // 忽略
  }
  let text = null
  try {
    if (code >= 0) text = readFileSync(temp, 'utf8')
  } catch {
    text = null
  }
  try {
    const { rmSync } = await import('node:fs')
    rmSync(temp, { force: true })
  } catch {
    // 忽略
  }
  return text && text.trim() !== '' ? text : null
}

// 只有"直接被执行"才跑 main()；被测试 import 时只导出纯函数（否则 import 就会去操作真实系统）。
const invokedDirectly = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`dsh-auto-update runner crashed: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}

export { buildLauncherScript, tailLog, defaultGlobalRoot, globalRootOf }
