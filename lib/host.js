/**
 * dsh-auto-update 宿主半：挂着 `/dsh-auto-update/api/*` 同源路由，供设置页与弹窗使用。
 *
 * 设计要点：
 * - 这里**不 import 任何 `@deepseek-ai/*` 运行时包**，只用 `ctx.webServer` 服务与 Node 内建。
 *   跨 DSH 版本活下来比用上新 API 更重要——这个插件要能陪着 DSH 一起升级。
 * - 真正的安装/回滚跑在脱离宿主的子进程里（见 lib/runner.mjs），因为那套动作的第一件事
 *   就是杀掉宿主自己。本文件只负责"检查版本、读状态、起子进程、回一句已开始"。
 * @module dsh-auto-update/host
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendLog,
  createJob,
  currentJob,
  DEFAULT_SETTINGS,
  lastJob,
  listJobs,
  loadState,
  normalizeLastCheck,
  pruneJobs,
  readJob,
  reconcileJob,
  saveJob,
  saveState,
  setSkipped,
  settingsPatchSchema,
  tailLog,
  updateSettings,
} from './state.js'
import { defaultGlobalRoot, globalRootOf, locateDshInstall, readPackageJson, resolveLayout } from './paths.js'
import { checkDshUpdate } from './registry.js'
import { scanPlugins, summarizePlugins, reasonText } from './compat.js'
import { listBackups, planBackup, deleteBackup, backupTotals, describeBackup } from './backup.js'
import { attributeActivation, findLastRestartOffset, parseActivationWarnings, readLogSegment, summarizeActivation } from './bootlog.js'
import { valid as semverValid } from './semver.js'

export const name = 'dsh-auto-update'

/** 宿主服务依赖。 */
export const inject = ['webServer']

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'runner.mjs')
const API_PREFIX = '/dsh-auto-update/api'
const CHECK_MEMORY_MS = 60_000

/**
 * 从进程参数里读 profile 名。
 * @param {string} fallback
 * @returns {string}
 */
export function readProfileArg(fallback = 'web') {
  const argv = process.argv
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile' && argv[index + 1]) return argv[index + 1]
    if (argv[index].startsWith('--profile=')) return argv[index].slice('--profile='.length)
  }
  const boot = argv.find((token, index) => index >= 2 && !token.startsWith('-'))
  if (boot && !['plugin', 'web', 'tui', 'desktop'].includes(boot)) return boot
  return fallback
}

/**
 * 挂载路由。
 * @param {object} ctx cordis 宿主上下文
 * @param {object} config 来自 cordis.patch.yml 的插件配置
 */
export function apply(ctx, config = {}) {
  const profile = config.profile ?? readProfileArg('web')
  const layout = resolveLayout({ profile })

  // 首次运行时把 patch 里的配置写进设置（之后一切以用户在设置页里的选择为准）
  bootstrapSettings(layout, config)

  ctx.inject(['webServer'], (host) => {
    host.effect(
      () =>
        host.webServer.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: (req, res) => handle(host, req, res, { layout, profile, config }),
        }),
      'dsh-auto-update: http routes',
    )
    // 启动后静默检查一次，让"打开网页就发现新版本"即使不点按钮也有数据可用
    // （测试/离线场景可用 DSH_AUTO_UPDATE_NO_WARM=1 关掉这次后台请求）
    const timer =
      process.env.DSH_AUTO_UPDATE_NO_WARM === '1'
        ? null
        : setTimeout(() => {
            void warmCheck(layout).catch(() => {})
          }, 8000)
    if (timer) host.effect(() => () => clearTimeout(timer), 'dsh-auto-update: boot check timer')
  })
}

/**
 * 首次启动时把配置里的默认值落进 state.json，避免每次启动覆盖用户改过的设置。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {object} config
 */
function bootstrapSettings(layout, config) {
  try {
    const state = loadState(layout)
    const patch = {}
    for (const key of ['autoCheck', 'channel', 'checkIntervalHours', 'registry', 'backupMode', 'keepBackups', 'autoRollback', 'syncPlugins', 'healthTimeoutSeconds']) {
      if (config[key] !== undefined) patch[key] = config[key]
    }
    if (!existsSync(join(layout.stateDir, 'state.json')) && Object.keys(patch).length > 0) {
      updateSettings(layout, /** @type {any} */ (patch))
    }
  } catch {
    // 配置不合规时用内置默认值继续
  }
}

/** 发 JSON。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 读 JSON 请求体，限制 64KB。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 判断请求是否来自本应用（同源）。
 *
 * 这个接口能触发全局安装，必须挡住跨站请求：只接受回环地址的 Host，
 * Origin 缺失（同源导航/桌面壳）或与 Host 一致才放行。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isTrustedRequest(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  const hostname = host.replace(/^\[|\](:\d+)?$/g, '').split(':')[0] ?? ''
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(hostname)
  if (host !== '' && !loopback) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  if (String(origin) === 'dsh-app:' || String(origin).startsWith('dsh-app://')) return true
  try {
    const parsed = new URL(String(origin))
    return parsed.host.toLowerCase() === host
  } catch {
    return false
  }
}

/** 状态目录里的能力探测缓存。 */
const capabilityCache = new Map()

/**
 * 探测本机是否具备自动更新的条件（结果缓存 60 秒）。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {{dir: string, version: string} | null} install
 * @param {number | null} port
 * @returns {object}
 */
function capabilities(layout, install, port) {
  const key = `${layout.stateDir}:${install?.dir ?? ''}`
  const cached = capabilityCache.get(key)
  if (cached && Date.now() - cached.at < CHECK_MEMORY_MS) return cached.value
  const electron = process.env.ELECTRON_RUN_AS_NODE === '1'
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  let writable = false
  let writableReason = '找不到安装目录'
  if (install) {
    try {
      const globalRoot = globalRootOf(install.dir)
      const probe = join(globalRoot, `.dsh-auto-update-probe-${process.pid}`)
      writeFileSync(probe, 'ok')
      rmSync(probe, { force: true })
      writable = true
      writableReason = '全局安装目录可写'
    } catch (error) {
      writableReason = `全局安装目录不可写：${error.message}`
    }
  }
  // 停止宿主、重启宿主、装/备份都依赖 Windows 的 netstat / taskkill / tar，其它平台先只读
  const supported = process.platform === 'win32'
  const value = {
    electron,
    supported,
    writable,
    writableReason: supported ? writableReason : `暂不支持 ${process.platform}（更新/回滚目前只用 Windows 的 netstat、taskkill、tar）`,
    npmCli: existsSync(npmCli),
    tar: supported ? existsSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')) : true,
    port,
    canSelfUpdate: supported && !electron && writable && existsSync(npmCli),
    restartable: supported && !electron && Boolean(port),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
  }
  capabilityCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * 汇总一份给 UI 的全量状态。
 * @param {object} input
 * @param {ReturnType<typeof resolveLayout>} input.layout
 * @param {string} input.profile
 * @param {number | null} input.port
 * @returns {object}
 */
/**
 * 把"宿主启动时哪些插件没有激活"整理成界面能直接用的结构。
 *
 * 数据来源有两种：
 * 1. 升级任务自己收集的（`job.activation`，最准，因为它只解析重启之后那段日志）；
 * 2. 兜底解析最近一次任务的日志（找最后一个"重启："标记之后的部分）。
 *    这样即使日志是旧版本 runner 写的，设置页也能看到当次启动的结果。
 * @param {{layout: object, job?: object | null, plugins?: Array<object>}} input
 * @returns {object}
 */
function activationReport(input) {
  const { layout, job, plugins = [] } = input
  if (job && job.activation) return { ...job.activation, source: 'job' }
  let jobs = []
  try {
    jobs = listJobs(layout, 12)
  } catch {
    jobs = []
  }
  const key = jobs.map((entry) => entry.id).join(',')
  if (activationCache.key === key && Date.now() - activationCache.at < 30_000) return activationCache.value
  let value = {
    count: 0,
    summary: '还没有可分析的启动日志（升级或回滚一次之后，这里会列出启动时没有激活的插件）',
    groups: [],
    pendingCount: null,
    requiredMissing: null,
    source: 'none',
  }
  for (const entry of jobs) {
    const logPath = entry.logPath ?? (entry.id ? join(layout.logsDir, `${entry.id}.log`) : null)
    if (!logPath || !existsSync(logPath)) continue
    const offset = findLastRestartOffset(logPath)
    if (offset === null) continue
    const segment = readLogSegment(logPath, { offset })
    if (!segment.text) continue
    const parsed = parseActivationWarnings(segment.text)
    const groups = attributeActivation(parsed, plugins)
    value = {
      count: groups.length,
      summary: summarizeActivation(groups, parsed).summary,
      groups: groups.map((group) => ({
        packageName: group.packageName,
        pluginStatus: group.plugin?.status ?? null,
        explanation: group.explanation,
        entries: group.entries.map((item) => ({
          entry: item.entry,
          reason: item.reason,
          service: item.service ?? null,
          explanation: item.explanation,
        })),
      })),
      pendingCount: parsed.pendingCount,
      requiredMissing: parsed.requiredMissing,
      source: entry.id,
      logPath,
      scannedAt: Date.now(),
    }
    break
  }
  activationCache = { key, value, at: Date.now() }
  return value
}

/**
 * 启动告警的缓存：避免 2 秒一次的轮询反复读日志。
 * @type {{key: string, value: object | null, at: number}}
 */
let activationCache = { key: '', value: null, at: 0 }

/**
 * 组装 /status 的响应。
 * @param {object} input
 * @param {ReturnType<typeof resolveLayout>} input.layout
 * @param {string} input.profile
 * @param {number | null} input.port
 * @returns {object}
 */
function buildStatus(input) {
  const { layout, profile, port } = input
  const notes = []
  /** @type {any} */
  let state = { settings: { ...DEFAULT_SETTINGS }, lastCheck: null, skipped: {}, jobs: [] }
  try {
    state = loadState(layout)
  } catch (error) {
    notes.push(`读不到状态文件：${error.message}`)
  }
  let stateWritable = true
  try {
    writeFileSync(join(layout.stateDir, `.probe-${process.pid}`), 'ok')
    rmSync(join(layout.stateDir, `.probe-${process.pid}`), { force: true })
  } catch (error) {
    stateWritable = false
    notes.push(`状态目录不可写（${layout.stateDir}）：${error.message}`)
  }
  const found = locateDshInstall(layout)
  const install = found ? { dir: found.dir, version: found.version, source: found.source } : null
  let job = null
  let mostRecent = null
  let jobs = []
  let backups = []
  let pluginScan = null
  let pluginScannedAt = 0
  try {
    job = reconcileJob(layout, currentJob(layout))
    jobs = listJobs(layout, 10)
    mostRecent = reconcileJob(layout, jobs[0] ?? lastJob(layout))
    backups = listBackups(layout)
  } catch (error) {
    notes.push(`读不到任务/备份：${error.message}`)
  }
  try {
    pluginScan = scanPlugins({ profileDir: layout.profileDir, targetVersion: install?.version ?? '0.0.0' })
    pluginScannedAt = Date.now()
  } catch (error) {
    notes.push(`插件扫描失败：${error.message}`)
  }
  // 缓存是"针对某个已装版本"的结论：升级完之后旧结论必须作废，
  // 否则界面会拿 0.2.0 时代的"有新版本"继续弹窗（用户实际已经是最新）。
  const lastCheck = normalizeLastCheck(state.lastCheck, install?.version)
  const activation = activationReport({ layout, job, plugins: pluginScan ?? [] })
  return {
    ok: true,
    plugin: { name, version: pluginVersion() },
    installation: install,
    profile: { name: profile, dir: layout.profileDir },
    settings: state.settings,
    lastCheck,
    activation,
    skipped: state.skipped,
    currentJob: job,
    lastJob: mostRecent
      ? {
          id: mostRecent.id,
          kind: mostRecent.kind,
          status: mostRecent.status,
          phase: mostRecent.phase,
          fromVersion: mostRecent.fromVersion,
          toVersion: mostRecent.toVersion,
          startedAt: mostRecent.startedAt,
          endedAt: mostRecent.endedAt ?? null,
          error: mostRecent.error ?? null,
        }
      : null,
    jobs: jobs.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
      phase: entry.phase,
      fromVersion: entry.fromVersion,
      toVersion: entry.toVersion,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt ?? null,
      error: entry.error ?? null,
    })),
    backups: backups.map(describeBackup),
    backupSpace: backupTotals(backups),
    plugins: pluginScan
      ? { summary: summarizePlugins(pluginScan), scannedAt: pluginScannedAt }
      : { summary: null, scannedAt: Date.now() },
    capabilities: capabilities(layout, install, port),
    stateDir: layout.stateDir,
    stateWritable,
    notes,
  }
}

/**
 * 本插件自己的版本号（读相邻的 package.json）。
 * @returns {string}
 */
function pluginVersion() {
  try {
    const manifest = readPackageJson(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))
    return manifest?.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * 静默检查一次（把结果写进 state.lastCheck）。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @returns {Promise<object | null>}
 */
async function warmCheck(layout) {
  return runCheck(layout, { force: false })
}

/**
 * 执行一次版本检查（带最小间隔缓存）。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {{force?: boolean, channel?: string}} options
 * @returns {Promise<object>}
 */
async function runCheck(layout, options = {}) {
  const state = loadState(layout)
  const found = locateDshInstall(layout)
  if (!found) throw new Error('找不到已安装的 @deepseek-ai/dsh')
  const settings = state.settings
  const minInterval = Math.max(Number(settings.checkIntervalHours) || 0, 0) * 3600_000
  const lastCheckedAt = state.lastCheck?.checkedAt ? Date.parse(String(state.lastCheck.checkedAt)) : Number.NaN
  // 缓存还必须属于同一个已装版本：刚升级完（0.2.0 → 0.2.1）时旧结论会误报"有新版本"。
  const sameInstall = !state.lastCheck?.installedVersion || state.lastCheck.installedVersion === found.version
  // 注意 checkedAt 是 ISO 字符串，直接参与减法会得到 NaN（缓存形同失效）
  if (!options.force && sameInstall && Number.isFinite(lastCheckedAt) && Date.now() - lastCheckedAt < minInterval) {
    return { ...state.lastCheck, cached: true }
  }
  const result = await checkDshUpdate({
    installedVersion: found.version,
    registry: settings.registry,
    channel: options.channel ?? settings.channel,
    skipVersions: state.skipped,
  })
  const pluginScan = result.targetVersion
    ? scanPlugins({ profileDir: layout.profileDir, targetVersion: result.targetVersion })
    : null
  const payload = {
    ...result,
    pluginSummary: pluginScan ? summarizePlugins(pluginScan) : null,
  }
  state.lastCheck = payload
  saveState(layout, state)
  return payload
}

/**
 * HTTP 分发。
 * @param {object} host cordis 上下文（含 webServer）
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{layout: ReturnType<typeof resolveLayout>, profile: string, config: object}} context
 */
async function handle(host, req, res, context) {
  const { layout, profile } = context
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : url.pathname
  const method = (req.method ?? 'GET').toUpperCase()
  // 端口优先取宿主服务自己报告的；有些宿主/代理场景下拿不到，就退到"这个请求是从哪个本地端口进来的"，
  // 两者对本插件要做的事（停下并重启这个进程）等价。
  const port = Number(host.webServer?.port) || Number(req.socket?.localPort) || null
  const write = method !== 'GET' && method !== 'HEAD'
  if (write && !isTrustedRequest(req)) {
    sendJson(res, 403, { ok: false, error: '只接受本应用内的请求' })
    return
  }
  try {
    if (method === 'GET' && (route === '/status' || route === '/')) {
      sendJson(res, 200, buildStatus({ layout, profile, port }))
      return
    }
    if (method === 'GET' && route === '/check') {
      const force = url.searchParams.get('force') === '1'
      const channel = url.searchParams.get('channel') ?? undefined
      const result = await runCheck(layout, { force, channel })
      sendJson(res, 200, { ok: true, ...result })
      return
    }
    if (method === 'GET' && route === '/plugins') {
      const found = locateDshInstall(layout)
      const target = url.searchParams.get('target') ?? found?.version ?? '0.0.0'
      const scan = scanPlugins({ profileDir: layout.profileDir, targetVersion: target })
      let jobForActivation = null
      try {
        jobForActivation = currentJob(layout)
      } catch {
        jobForActivation = null
      }
      // 版本区间满足 ≠ 真的跑起来了：把启动日志里的未激活记录并到每一行上。
      const activationNotes = activationReport({ layout, job: jobForActivation, plugins: scan })
      const activationByPackage = new Map((activationNotes.groups ?? []).map((group) => [group.packageName, group]))
      sendJson(res, 200, {
        ok: true,
        targetVersion: target,
        summary: summarizePlugins(scan),
        activation: activationNotes,
        plugins: scan.map((plugin) => {
          const group = activationByPackage.get(plugin.name) ?? null
          const base = reasonText({ ...plugin, targetVersion: target })
          return {
            name: plugin.name,
            version: plugin.version,
            spec: plugin.spec ?? null,
            status: plugin.status,
            isCore: Boolean(plugin.isCore),
            declaredRange: plugin.declaredDshRange ?? null,
            compatibleVersion: plugin.compatibleVersion ?? null,
            reasons: plugin.reasons ?? [],
            explanation: group ? `${base}（${group.explanation}）` : base,
            activation: group ? { failed: true, entries: group.entries, explanation: group.explanation } : null,
          }
        }),
      })
      return
    }
    if (method === 'GET' && route === '/job') {
      const id = url.searchParams.get('id') ?? ''
      const job = reconcileJob(layout, id ? readJob(layout, id) : (currentJob(layout) ?? lastJob(layout)))
      if (!job) {
        sendJson(res, 404, { ok: false, error: '还没有任何任务' })
        return
      }
      // isCurrent 让前端能区分"这个任务是活的"还是"只是最近一次"
      sendJson(res, 200, { ok: true, job, isCurrent: job.status === 'running' || job.status === 'pending', log: tailLog(job.logPath, 32_000) })
      return
    }
    if (method === 'GET' && route === '/backups') {
      const backups = listBackups(layout)
      sendJson(res, 200, { ok: true, backups: backups.map(describeBackup), totals: backupTotals(backups) })
      return
    }
    if (method === 'GET' && route === '/plan') {
      const found = locateDshInstall(layout)
      if (!found) {
        sendJson(res, 400, { ok: false, error: '找不到已安装的 @deepseek-ai/dsh' })
        return
      }
      const state = loadState(layout)
      const plan = planBackup({
        installDir: found.dir,
        preferred: state.settings.backupMode,
        stateDir: layout.stateDir,
      })
      sendJson(res, 200, { ok: true, plan })
      return
    }
    if (method === 'POST' && route === '/check') {
      const body = await readJsonBody(req)
      const result = await runCheck(layout, { force: true, channel: body.channel })
      sendJson(res, 200, { ok: true, ...result })
      return
    }
    if (method === 'POST' && route === '/settings') {
      const body = await readJsonBody(req)
      const parsed = settingsPatchSchema(body)
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error })
        return
      }
      const settings = updateSettings(layout, parsed.value)
      sendJson(res, 200, { ok: true, settings })
      return
    }
    if (method === 'POST' && route === '/skip') {
      const body = await readJsonBody(req)
      if (!body.version || !semverValid(String(body.version))) {
        sendJson(res, 400, { ok: false, error: '缺少合法版本号' })
        return
      }
      const skipped = setSkipped(layout, String(body.version), body.skip !== false)
      sendJson(res, 200, { ok: true, skipped })
      return
    }
    if (method === 'POST' && route === '/dismiss') {
      const body = await readJsonBody(req)
      const hours = Math.min(Math.max(Number(body.hours ?? 24), 0), 24 * 30)
      const settings = updateSettings(layout, { dismissUntil: Date.now() + hours * 3600_000 })
      sendJson(res, 200, { ok: true, settings })
      return
    }
    if (method === 'POST' && route === '/update') {
      const body = await readJsonBody(req)
      const version = String(body.version ?? '').trim()
      if (!semverValid(version)) {
        sendJson(res, 400, { ok: false, error: '目标版本号不合法' })
        return
      }
      const found = locateDshInstall(layout)
      if (!found) {
        sendJson(res, 400, { ok: false, error: '找不到已安装的 @deepseek-ai/dsh' })
        return
      }
      const caps = capabilities(layout, found, port)
      if (!caps.supported) {
        sendJson(res, 409, { ok: false, error: caps.writableReason, capabilities: caps })
        return
      }
      if (caps.electron) {
        sendJson(res, 409, {
          ok: false,
          error: '当前是桌面客户端（Electron）运行模式，自动更新会替换正在运行的安装包，请改用桌面端的更新通道。',
          capabilities: caps,
        })
        return
      }
      if (!caps.writable) {
        sendJson(res, 409, {
          ok: false,
          error: `无法写入全局安装目录，请用管理员身份重新打开终端后执行 npm i -g @deepseek-ai/dsh@${version}`,
          capabilities: caps,
        })
        return
      }
      const job = createJob(layout, {
        kind: 'update',
        fromVersion: found.version,
        toVersion: version,
        steps: ['preflight', 'backup', 'stop-host', 'install', 'verify', 'plugins', 'restart', 'health'],
        detail: { port, cwd: process.cwd() },
      })
      appendLog(layout, job, `宿主请求更新到 ${version}（当前 ${found.version}）`)
      sendJson(res, 200, { ok: true, job: { id: job.id, status: job.status }, willRestart: true, port })
      launchRunner(layout, job, { action: 'update', target: version, port })
      return
    }
    if (method === 'POST' && route === '/rollback') {
      const body = await readJsonBody(req)
      const id = String(body.backupId ?? '')
      const backups = listBackups(layout)
      const record = backups.find((entry) => entry.id === id)
      if (!record) {
        sendJson(res, 400, { ok: false, error: '找不到该备份' })
        return
      }
      const job = createJob(layout, {
        kind: 'rollback',
        fromVersion: readPackageJson(join(record.dshDir, 'package.json'))?.version ?? null,
        toVersion: record.fromVersion,
        steps: ['preflight', 'stop-host', 'restore', 'verify', 'restart', 'health'],
        detail: { port, cwd: process.cwd(), backupId: id },
      })
      appendLog(layout, job, `宿主请求回滚到备份 ${id}（${record.fromVersion}）`)
      sendJson(res, 200, { ok: true, job: { id: job.id }, willRestart: Boolean(port) })
      launchRunner(layout, job, { action: 'rollback', backup: id, port })
      return
    }
    if (method === 'POST' && route === '/sync-plugins') {
      const found = locateDshInstall(layout)
      if (!found) {
        sendJson(res, 400, { ok: false, error: '找不到已安装的 @deepseek-ai/dsh' })
        return
      }
      if (process.platform !== 'win32') {
        sendJson(res, 409, { ok: false, error: '同步插件目前只用 Windows 的 netstat / taskkill 判断宿主状态' })
        return
      }
      const job = createJob(layout, {
        kind: 'sync-plugins',
        fromVersion: found.version,
        toVersion: found.version,
        steps: ['preflight', 'plugins'],
        detail: { cwd: process.cwd() },
      })
      appendLog(layout, job, '宿主请求同步插件')
      sendJson(res, 200, { ok: true, job: { id: job.id } })
      launchRunner(layout, job, { action: 'sync-plugins', port: null })
      return
    }
    if (method === 'POST' && route === '/restart') {
      const found = locateDshInstall(layout)
      if (!found) {
        sendJson(res, 400, { ok: false, error: '找不到已安装的 @deepseek-ai/dsh' })
        return
      }
      const caps = capabilities(layout, found, port)
      if (!caps.supported) {
        sendJson(res, 409, { ok: false, error: caps.writableReason, capabilities: caps })
        return
      }
      if (caps.electron) {
        sendJson(res, 409, {
          ok: false,
          error: '当前是桌面客户端（Electron）运行模式，进程由桌面端托管，请用桌面端自己的重启入口。',
          capabilities: caps,
        })
        return
      }
      if (!port) {
        sendJson(res, 409, { ok: false, error: '拿不到本进程的监听端口，无法重启（用 dsh web --port N 指定端口后重试）' })
        return
      }
      const job = createJob(layout, {
        kind: 'restart',
        fromVersion: found.version,
        toVersion: found.version,
        steps: ['preflight', 'stop-host', 'restart', 'health'],
        detail: { port, cwd: process.cwd() },
      })
      appendLog(layout, job, `宿主请求重启（端口 ${port}）`)
      sendJson(res, 200, { ok: true, job: { id: job.id, status: job.status }, willRestart: true, port })
      launchRunner(layout, job, { action: 'restart', port })
      return
    }
    if (method === 'POST' && route === '/stop') {
      const found = locateDshInstall(layout)
      if (!found) {
        sendJson(res, 400, { ok: false, error: '找不到已安装的 @deepseek-ai/dsh' })
        return
      }
      if (!port) {
        sendJson(res, 409, { ok: false, error: '拿不到本进程的监听端口，无法停止（用 dsh web --port N 指定端口后重试）' })
        return
      }
      if (process.platform !== 'win32') {
        sendJson(res, 409, { ok: false, error: '停止宿主目前只用 Windows 的 netstat / taskkill' })
        return
      }
      const job = createJob(layout, {
        kind: 'stop',
        fromVersion: found.version,
        toVersion: found.version,
        steps: ['preflight', 'stop-host'],
        detail: { port, cwd: process.cwd() },
      })
      appendLog(layout, job, `宿主请求停止（端口 ${port}）`)
      sendJson(res, 200, { ok: true, job: { id: job.id, status: job.status }, willStop: true, port })
      launchRunner(layout, job, { action: 'stop', port })
      return
    }
    if (method === 'POST' && route === '/delete-backup') {
      const body = await readJsonBody(req)
      const id = String(body.id ?? '')
      const removed = deleteBackup(layout, id)
      sendJson(res, removed ? 200 : 400, removed ? { ok: true, backups: listBackups(layout).map(describeBackup) } : { ok: false, error: '删除失败' })
      return
    }
    if (method === 'POST' && route === '/prune') {
      pruneJobs(layout, 30)
      sendJson(res, 200, { ok: true })
      return
    }
    sendJson(res, 404, { ok: false, error: `未知接口 ${method} ${route}` })
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error?.message ?? String(error),
      // 排错用：设 DSH_AUTO_UPDATE_DEBUG=1 才回传堆栈
      ...(process.env.DSH_AUTO_UPDATE_DEBUG === '1' ? { stack: String(error?.stack ?? '') } : {}),
    })
  }
}

/**
 * 打开一个**可见的命令行窗口**跑更新，现场直播进度。
 *
 * 为什么不用隐藏的孤儿进程：隐藏进程出问题时用户只看到网页白屏，
 * 不知道它在干什么、干到哪一步、失败在哪。所以这里让 Windows `start`
 * 新开一个控制台窗口跑 `runner.mjs --visible`，窗口里是逐行日志。
 *
 * 关掉窗口怎么办：runner 自己会写心跳（jobs/<id>.hb）并拉起看护进程
 * （watchdog.mjs，隐藏窗口、detached）。窗口被关 → 心跳停 → 看护进程
 * 判定"更新死了"→ 自动回滚到原版本并重启 DSH。
 *
 * 这个新窗口不在宿主的控制台里，`taskkill /PID <宿主>` 只杀宿主，窗口里的执行器活着。
 * @param {ReturnType<typeof resolveLayout>} layout
 * @param {object} job
 * @param {{action: string, target?: string, backup?: string, port: number | null}} options
 */
function launchRunner(layout, job, options) {
  // 测试用：只建任务、不真的拉起执行器（host-smoke 里验证 /restart 的接口语义时用，
  // 否则执行器会把这个测试用的临时宿主当成真宿主杀掉）。
  if (process.env.DSH_AUTO_UPDATE_NO_LAUNCH === '1') {
    appendLog(layout, job, '已请求拉起执行器（DSH_AUTO_UPDATE_NO_LAUNCH=1，测试模式下跳过）')
    return
  }
  const argv = [
    RUNNER,
    '--job',
    job.id,
    '--state-dir',
    layout.stateDir,
    '--dsh-home',
    layout.dshHome,
    '--action',
    options.action,
  ]
  if (options.target) argv.push('--target', options.target)
  if (options.backup) argv.push('--backup', options.backup)
  if (options.port) argv.push('--port', String(options.port))
  argv.push('--cwd', process.cwd())
  // 把宿主自己的启动命令行交给执行器：更新后要按原样把它拉起来
  const ownArgs = process.argv.slice(2)
  if (ownArgs.length > 0) argv.push('--restart-args', JSON.stringify(ownArgs))
  const ownEntry = process.argv[1]
  if (ownEntry && /\.(?:js|mjs|cjs)$/i.test(ownEntry)) argv.push('--restart-entry', ownEntry)

  const env = { ...process.env, DSH_HOME: layout.dshHome }
  const wantWindow = process.platform === 'win32' && process.env.DSH_AUTO_UPDATE_NO_WINDOW !== '1'

  if (wantWindow) {
    try {
      // 用批处理做外壳：编码、标题、命令、结束后的 pause 都在里面，省得跟 cmd 的引号规则打架。
      //
      // 关键约束：这个 .cmd 必须是**纯 ASCII**。
      // cmd 读批处理是按块读的，`chcp 65001` 下遇到跨块的多字节汉字会吃掉半行，
      // 实测报 `'细日志:' is not recognized as an internal or external command`。
      // 中文提示一律交给执行器自己 `--visible` 打到控制台（那是 node 在 print，不受此限）。
      const shimPath = join(layout.jobsDir, `${job.id}.cmd`)
      const quote = (value) => (/[\s"&|<>]/.test(value) ? `"${String(value).replace(/"/g, '""')}"` : String(value))
      // 窗口里必须带 --visible：执行器默认只写日志文件，带上它才会把每行同步打到控制台
      const command = [process.execPath, ...argv, '--visible'].map(quote).join(' ')
      writeFileSync(
        shimPath,
        [
          '@echo off',
          'chcp 65001 >nul',
          `title DSH auto-update ${String(options.action)}${options.target ? ` ${String(options.target)}` : ''}`,
          `set "DSH_AU_LOG=${String(job.logPath ?? '')}"`,
          'echo.',
          command,
          'set DSH_AUTO_UPDATE_EXIT=%ERRORLEVEL%',
          'echo.',
          'echo ==================== finished ====================',
          'echo exit code %DSH_AUTO_UPDATE_EXIT%  (0=ok  2=rolled back  1=failed)',
          'echo log: %DSH_AU_LOG%',
          'echo.',
          // 执行器自己已经等过一次按键（`--visible`），这里再 pause 就是"按两次"，
          // 而且某些终端下 pause 结束后窗口也不走。只有**硬失败**（1）才停住让人读报错；
          // 0=成功、2=已自动回滚，都属于"事情已了结"，读完直接关窗。
          'if not "%DSH_AUTO_UPDATE_EXIT%"=="0" if not "%DSH_AUTO_UPDATE_EXIT%"=="2" pause',
          'exit',
          '',
        ].join('\r\n'),
        'utf8',
      )
      const comspec = process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
      const child = spawn(comspec, ['/c', 'start', '/D', process.cwd(), shimPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env,
        cwd: process.cwd(),
      })
      child.unref()
      appendLog(layout, job, `已打开更新窗口：${shimPath}`)
      return
    } catch (error) {
      appendLog(layout, job, `打开更新窗口失败，改为后台执行：${error.message}`)
    }
  }

  // 兜底：后台跑（没有窗口，但看护进程照样在）
  try {
    const fd = openSync(join(layout.logsDir, `${job.id}.console.log`), 'a')
    const child = spawn(process.execPath, [...argv, '--visible'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env,
    })
    child.unref()
  } catch (error) {
    appendLog(layout, job, `启动更新进程失败：${error.message}`)
    job.status = 'failed'
    job.error = `启动更新进程失败：${error.message}`
    job.endedAt = Date.now()
    saveJob(layout, job)
  }
}

/** 调试用：读一个文件（不注册成接口，仅内部）。 */
export function readText(path) {
  return readFileSync(path, 'utf8')
}

/** 供测试：列出状态目录条目。 */
export function stateEntries(layout) {
  return existsSync(layout.stateDir) ? readdirSync(layout.stateDir) : []
}

export { defaultGlobalRoot }
