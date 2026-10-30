/**
 * 更新前的备份与还原。
 *
 * 两种模式，各有取舍：
 * - `full`：把整个已安装的 `@deepseek-ai/dsh` 包目录打成一个 tar.gz。
 *   断网也能回滚，最可靠；代价是需要约等于包体积的磁盘与几十秒压缩时间（本机约 500MB）。
 * - `metadata`：只记版本号 + 备份 profile 配置，回滚时用 `npm i -g @deepseek-ai/dsh@<旧版本>`
 *   重新下载。几乎不占磁盘、几秒钟完成；代价是回滚依赖网络与 registry 可用性。
 *
 * 默认 `full`：一次更新最痛的场景就是"新版起不来"，此时离线还原才有意义。
 * @module dsh-auto-update/backup
 */
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { extractTarGz } from './tar.js'
import { globalRootOf, readPackageJson } from './paths.js'
import { readJsonSafe, writeJsonAtomic } from './state.js'

/** profile 目录里需要跟着备份的配置文件（相对路径）。 */
export const PROFILE_FILES = [
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'gro.ngilp-hsd-versions.json',
]

/**
 * 选一个可用的 tar 可执行文件。
 *
 * Windows 上优先用 `C:\Windows\System32\tar.exe`（bsdtar，Win10 1803+ 自带）：
 * PATH 上可能先命中其它工具链附带的 cygwin/GNU tar，那些在受限账户下会初始化失败。
 * @param {{platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export function tarExecutable(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform === 'win32') {
    const systemTar = join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(systemTar)) return systemTar
  }
  return 'tar'
}

/**
 * 起一个子进程并把 stdout/stderr 都写到日志文件句柄（不建管道）。
 *
 * 用文件描述符而不是 pipe：便于在受限环境里工作，也让日志天然落盘、进程被杀也不丢。
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, logFd: number}} options
 * @returns {Promise<{code: number | null, signal: string | null}>}
 */
export function runToLog(file, args, options) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['ignore', options.logFd, options.logFd],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: -1, signal: null, spawnError: error.message })
      return
    }
    child.on('error', (error) => resolve({ code: -1, signal: null, spawnError: error.message }))
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

/**
 * 目录所在卷的可用字节数。
 *
 * 逐个候选路径试：某些受限宿主上对深层目录取卷信息会失败，但从卷根或用户目录常常能拿到。
 * @param {string} dir
 * @returns {number | null}
 */
export function diskFreeBytes(dir) {
  const candidates = [dir, `${dir.slice(0, 2)}\\`, process.env.USERPROFILE, process.env.HOME, process.env.TEMP]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const stats = statfsSync(candidate)
      return Number(stats.bavail) * Number(stats.bsize)
    } catch {
      /* 换下一个候选 */
    }
  }
  return null
}

/**
 * 备份目录体积估算：已安装 DSH 包目录大小。
 * @param {string} installDir
 * @returns {number}
 */
export function installSize(installDir) {
  let total = 0
  const stack = [installDir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      try {
        if (entry.isDirectory()) stack.push(path)
        else if (entry.isFile()) total += statSync(path).size
      } catch {
        // 单个文件统计失败不影响整体
      }
    }
  }
  return total
}

/**
 * 决定这次用哪种备份模式，并给出理由。
 * @param {object} input
 * @param {string} input.installDir
 * @param {'full' | 'metadata'} input.preferred
 * @param {string} input.stateDir
 * @returns {{mode: 'full' | 'metadata', reason: string, estimatedBytes: number, freeBytes: number | null, tarExe: string}}
 */
export function planBackup(input) {
  const tarExe = tarExecutable()
  const estimatedBytes = installSize(input.installDir)
  const freeBytes = diskFreeBytes(input.stateDir)
  if (input.preferred !== 'full') {
    return { mode: 'metadata', reason: '已设置为只备份版本信息与配置', estimatedBytes, freeBytes, tarExe }
  }
  if (freeBytes === null) {
    return { mode: 'full', reason: '无法读取磁盘剩余空间，仍尝试完整备份', estimatedBytes, freeBytes, tarExe }
  }
  // 压缩后大约 25%，再留 200MB 余量给临时文件
  const need = Math.ceil(estimatedBytes * 0.4) + 200 * 1024 * 1024
  if (freeBytes < need) {
    return {
      mode: 'metadata',
      reason: `磁盘剩余 ${(freeBytes / 1e9).toFixed(1)}GB 不足完整备份所需（约 ${(need / 1e9).toFixed(1)}GB），改为只备份版本与配置`,
      estimatedBytes,
      freeBytes,
      tarExe,
    }
  }
  return { mode: 'full', reason: '完整备份：断网也能回滚', estimatedBytes, freeBytes, tarExe }
}

/** 备份目录。 */
export function backupDir(layout, id) {
  return join(layout.backupsDir, id)
}

/** 读一份备份的元数据。 */
export function readBackup(layout, id) {
  return readJsonSafe(join(backupDir(layout, id), 'backup.json'), null)
}

/**
 * 列出全部备份（新 → 旧）。
 * @param {ReturnType<import('./paths.js').resolveLayout>} layout
 * @returns {object[]}
 */
export function listBackups(layout) {
  if (!existsSync(layout.backupsDir)) return []
  const records = []
  for (const entry of readdirSync(layout.backupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const record = readJsonSafe(join(layout.backupsDir, entry.name, 'backup.json'), null)
    if (record?.id) records.push(record)
  }
  return records.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/**
 * 把 profile 的配置文件复制进备份目录。
 * @param {string} profileDir
 * @param {string} targetDir
 * @returns {string[]} 实际备份到的文件
 */
function copyProfileFiles(profileDir, targetDir) {
  const copied = []
  mkdirSync(join(targetDir, 'profile'), { recursive: true })
  for (const name of PROFILE_FILES) {
    const source = join(profileDir, name)
    if (!existsSync(source)) continue
    try {
      copyFileSync(source, join(targetDir, 'profile', name))
      copied.push(name)
    } catch {
      // 单个文件失败不阻断备份
    }
  }
  return copied
}

/**
 * 把 profile 配置文件写回（回滚时用）。
 * @param {string} targetDir 备份目录
 * @param {string} profileDir
 * @returns {string[]} 实际还原的文件
 */
export function restoreProfileFiles(targetDir, profileDir) {
  const sourceDir = join(targetDir, 'profile')
  if (!existsSync(sourceDir)) return []
  const restored = []
  mkdirSync(profileDir, { recursive: true })
  for (const name of readdirSync(sourceDir)) {
    try {
      copyFileSync(join(sourceDir, name), join(profileDir, name))
      restored.push(name)
    } catch {
      // 单个文件失败不阻断回滚
    }
  }
  return restored
}

/**
 * 创建备份。
 * @param {object} input
 * @param {ReturnType<import('./paths.js').resolveLayout>} input.layout
 * @param {{dir: string, version: string}} input.install
 * @param {'full' | 'metadata'} input.mode
 * @param {string} input.jobId
 * @param {(line: string) => void} input.log
 * @param {number} input.logFd
 * @returns {Promise<{ok: boolean, record: object | null, error?: string}>}
 */
export async function createBackup(input) {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${input.jobId.slice(-6)}`
  const dir = backupDir(input.layout, id)
  mkdirSync(dir, { recursive: true })
  const globalRoot = globalRootOf(input.install.dir)
  const relative = input.install.dir.slice(globalRoot.length).replace(/^[\\/]+/, '')
  /** @type {any} */
  const record = {
    id,
    createdAt: Date.now(),
    mode: input.mode,
    fromVersion: input.install.version,
    dshDir: input.install.dir,
    globalRoot,
    relativePath: relative,
    profileDir: input.layout.profileDir,
    nodeVersion: process.versions.node,
    platform: process.platform,
    tarPath: null,
    bytes: 0,
    profileFiles: [],
    reason: null,
  }
  if (input.mode === 'full') {
    const tarPath = join(dir, `dsh-${input.install.version}.tar.gz`)
    const tarExe = tarExecutable()
    // 成员名必须带 ./ 前缀：bsdtar 会把以 @ 开头的参数当成"从文件里读列表"，
    // 而 scoped 包名恰好以 @ 开头（会把 @deepseek-ai/dsh 读成 deepseek-ai/dsh 而打开失败）。
    // 同时统一成正斜杠，避免 Windows 反斜杠被当成成员名的一部分。
    const member = './' + relative.split(/[\\/]+/).join('/')
    input.log(`tar: ${tarExe} -czf ${tarPath} -C ${globalRoot} ${member}`)
    const result = await runToLog(tarExe, ['-czf', tarPath, '-C', globalRoot, member], { logFd: input.logFd })
    if (result.code !== 0) {
      // tar 起不来（受限环境、被杀软拦、退出码异常）时的第二选择：直接复制整棵目录，不需要任何外部程序
      const copyPath = join(dir, 'dsh-copy')
      input.log(`tar 备份失败（退出码 ${result.code}${result.spawnError ? `：${result.spawnError}` : ''}），改为整目录复制`)
      try {
        copyTree(input.install.dir, copyPath)
        record.dirPath = copyPath
        record.method = 'copy'
        record.bytes = dirSize(copyPath)
        input.log(`整目录备份完成：${(record.bytes / 1024 / 1024).toFixed(1)}MB`)
      } catch (error) {
        record.mode = 'metadata'
        record.reason = `完整备份失败（tar 退出码 ${result.code}，整目录复制也失败：${error.message}），降级为只备份版本与配置`
        input.log(record.reason)
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })
      }
    } else {
      const bytes = existsSync(tarPath) ? statSync(tarPath).size : 0
      if (bytes <= 0) {
        record.mode = 'metadata'
        record.reason = '完整备份产物为空，降级为只备份版本与配置'
        input.log(record.reason)
      } else {
        record.tarPath = tarPath
        record.method = 'tar'
        record.bytes = bytes
        input.log(`备份完成：${(bytes / 1024 / 1024).toFixed(1)}MB`)
      }
    }
  }
  record.profileFiles = copyProfileFiles(input.layout.profileDir, dir)
  writeJsonAtomic(join(dir, 'backup.json'), record)
  writeFileSync(join(dir, 'README.txt'), [
    `dsh-auto-update 备份 ${id}`,
    `模式：${record.mode}`,
    `DSH 版本：${record.fromVersion}`,
    `安装目录：${input.install.dir}`,
    `tar：${record.tarPath ?? '（无，回滚依赖 npm 重新下载）'}`,
    `创建时间：${new Date(record.createdAt).toISOString()}`,
    '',
    '手动回滚：',
    record.tarPath
      ? `  tar -xzf "${record.tarPath}" -C "${globalRoot}"`
      : record.dirPath
        ? `  把 "${record.dirPath}" 整个复制回 "${globalRoot}\${record.relativePath}"`
        : `  npm i -g @deepseek-ai/dsh@${record.fromVersion}`,
    '',
  ].join('\n'), 'utf8')
  return { ok: true, record }
}

/**
 * 用完整备份还原 DSH 包目录。
 *
 * 先解压到 `<globalRoot>/.dsh-auto-update-stage-*`（同卷，rename 是原子的），
 * 校验包里确实有 package.json 之后才替换旧目录；旧目录改名留档而直接删除，
 * 替换成功后再清掉——任何一步失败都还能退回旧目录。
 * @param {object} input
 * @param {object} input.record
 * @param {string} input.targetDir 现安装目录
 * @param {(line: string) => void} input.log
 * @param {number} input.logFd
 * @returns {Promise<{ok: boolean, error?: string, version?: string | null}>}
 */
export async function restoreFullBackup(input) {
  const { record, targetDir, log } = input
  if (!record.tarPath && !record.dirPath) return { ok: false, error: '这份备份没有可还原的内容（只有版本与配置记录）' }
  const globalRoot = record.globalRoot
  const stageRoot = join(globalRoot, `.dsh-auto-update-stage-${record.id}`)
  const oldRoot = join(globalRoot, `.dsh-auto-update-old-${record.id}`)
  rmSync(stageRoot, { recursive: true, force: true })
  mkdirSync(stageRoot, { recursive: true })
  let stagedPackage = stageRoot
  if (record.dirPath) {
    if (!existsSync(record.dirPath)) return { ok: false, error: '备份目录不存在（可能已被清理）' }
    log(`从备份目录复制到 ${stageRoot}`)
    copyTree(record.dirPath, stageRoot)
  } else {
    if (!existsSync(record.tarPath)) return { ok: false, error: '备份包不存在（可能已被清理）' }
    log(`解压备份到 ${stageRoot}（纯 Node 解包，不依赖系统 tar）`)
    const extracted = await extractTarGz(record.tarPath, stageRoot, { log })
    if (!extracted.ok) return { ok: false, error: extracted.error ?? '解压失败' }
    stagedPackage = join(stageRoot, record.relativePath)
  }
  if (!existsSync(join(stagedPackage, 'package.json'))) {
    return { ok: false, error: '备份包里没有预期的 package.json，放弃还原' }
  }
  rmSync(oldRoot, { recursive: true, force: true })
  mkdirSync(dirname(targetDir), { recursive: true })
  if (existsSync(targetDir)) renameSync(targetDir, oldRoot)
  try {
    renameSync(stagedPackage, targetDir)
  } catch (error) {
    // 替换失败就把旧目录搬回来
    if (existsSync(oldRoot) && !existsSync(targetDir)) renameSync(oldRoot, targetDir)
    return { ok: false, error: `替换安装目录失败：${error.message}` }
  }
  rmSync(stageRoot, { recursive: true, force: true })
  const restored = readPackageJson(join(targetDir, 'package.json'))
  log(`已还原到 ${restored?.version ?? '未知版本'}；旧目录留档于 ${oldRoot}`)
  // 留档目录在重启成功后由下一次更新清理，这里不立刻删：出问题还能人工捞回
  return { ok: true, version: restored?.version ?? null }
}

/**
 * 清理旧备份，保留最新 `keep` 份。
 * @param {ReturnType<import('./paths.js').resolveLayout>} layout
 * @param {number} keep
 * @returns {string[]} 被删除的备份 id
 */
export function pruneBackups(layout, keep) {
  const removed = []
  for (const record of listBackups(layout).slice(Math.max(keep, 0))) {
    rmSync(backupDir(layout, record.id), { recursive: true, force: true })
    removed.push(record.id)
  }
  return removed
}

/**
 * 删除一份备份。
 * @param {ReturnType<import('./paths.js').resolveLayout>} layout
 * @param {string} id
 */
export function deleteBackup(layout, id) {
  if (!/^[\w.:-]+$/.test(id)) return false
  rmSync(backupDir(layout, id), { recursive: true, force: true })
  return true
}

/**
 * 清理历史遗留的 stage/old 目录（上次更新中途被打断时可能残留）。
 * @param {string} globalRoot
 * @returns {string[]}
 */
export function cleanStaleStaging(globalRoot) {
  const removed = []
  try {
    for (const entry of readdirSync(globalRoot)) {
      if (!entry.startsWith('.dsh-auto-update-')) continue
      rmSync(join(globalRoot, entry), { recursive: true, force: true })
      removed.push(entry)
    }
  } catch {
    // 目录不可读就算了
  }
  return removed
}

/**
 * 备份体积统计（给 UI 显示）。
 * @param {object[]} records
 * @returns {{count: number, bytes: number}}
 */
export function backupTotals(records) {
  return {
    count: records.length,
    bytes: records.reduce((sum, record) => sum + (record.bytes ?? 0), 0),
  }
}

/** 把记录里的 profile 配置也一起复制进备份（供 metadata 模式用）。 */
export function copyProfileIntoBackup(profileDir, dir) {
  return copyProfileFiles(profileDir, dir)
}

/** 备份记录里带的 profile 文件清单（用于 UI 展示）。 */
export function describeBackup(record) {
  return {
    id: record.id,
    mode: record.mode,
    fromVersion: record.fromVersion,
    toVersion: record.toVersion ?? null,
    createdAt: record.createdAt,
    sizeBytes: record.bytes ?? 0,
    mb: Number(((record.bytes ?? 0) / 1024 / 1024).toFixed(1)),
    profileFiles: record.profileFiles ?? [],
    reason: record.reason ?? null,
    dshDir: record.dshDir ?? null,
    restoreCommand: record.tarPath
      ? `tar -xzf "${record.tarPath}" -C "${record.globalRoot}"`
      : `npm i -g @deepseek-ai/dsh@${record.fromVersion}`,
  }
}

/** 递归统计目录大小（备份目录自身体积）。 */
export function dirSize(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += dirSize(path)
      else if (entry.isFile()) total += statSync(path).size
    } catch {
      // 忽略
    }
  }
  return total
}

/** 深拷贝目录（供测试与手工修复用）。 */
export function copyTree(source, target) {
  cpSync(source, target, { recursive: true, force: true })
}
