#!/usr/bin/env node
/**
 * 在桌面上生成 "启动DSH.cmd" / "停止DSH.cmd" 两个批处理。
 *
 * 发布版里不放死的绝对路径：模板在 scripts/templates/*.tmpl，占位符在运行时替换成
 * 当前机器上的 node、本包的启动器、工作目录、profile 和端口。
 *
 * 用法：
 *   node scripts/install-desktop.mjs                 # 生成到当前用户的桌面，端口 3080
 *   node scripts/install-desktop.mjs --port 3098 --profile web --workspace D:\code
 *   node scripts/install-desktop.mjs --dir .\out --dry-run
 *
 * 参数：--port <n> --profile <name> --workspace <dir> --dir <target> --force --dry-run --json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const launcher = join(packageRoot, 'lib', 'dsh-launch.mjs')
const templatesDir = join(here, 'templates')

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  if (index < 0) return fallback
  return argv[index + 1] ?? fallback
}
const flag = (name) => argv.includes(name)

const port = option('--port', process.env.DSH_LAUNCH_PORT ?? '3080')
const profile = option('--profile', process.env.DSH_LAUNCH_PROFILE ?? 'web')
const workspace = resolve(option('--workspace', process.env.DSH_LAUNCH_CWD ?? process.cwd()))
const defaultDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', 'Desktop')
const targetDir = resolve(option('--dir', defaultDir))
const force = flag('--force')
const dryRun = flag('--dry-run')
const asJson = flag('--json')

function render(templateName) {
  const source = readFileSync(join(templatesDir, templateName), 'utf8')
  return source
    .replaceAll('__NODE__', process.execPath)
    .replaceAll('__LAUNCHER__', launcher)
    .replaceAll('__WORKSPACE__', workspace)
    .replaceAll('__PROFILE__', profile)
    .replaceAll('__PORT__', port)
    .replaceAll('\r\n', '\n')
    // 批处理用 CRLF 最稳（纯 LF 也能跑，但记事本/部分工具会显示成一行）
    .replaceAll('\n', '\r\n')
}

const files = [
  { name: '启动DSH.cmd', template: 'start-dsh.cmd.tmpl' },
  { name: '停止DSH.cmd', template: 'stop-dsh.cmd.tmpl' },
]

if (!existsSync(launcher)) {
  console.error(`找不到启动器：${launcher}`)
  process.exit(1)
}

const written = []
const skipped = []
for (const file of files) {
  const output = join(targetDir, file.name)
  if (existsSync(output) && !force) {
    skipped.push(output)
    continue
  }
  const content = render(file.template)
  if (!dryRun) {
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(output, content, 'utf8')
  }
  written.push(output)
}

if (asJson) {
  console.log(JSON.stringify({ ok: true, targetDir, port, profile, workspace, written, skipped, dryRun }, null, 2))
} else {
  console.log(`目标目录：${targetDir}`)
  console.log(`端口：${port}　profile：${profile}　工作目录：${workspace}`)
  for (const file of written) console.log(`${dryRun ? '将写入' : '已写入'}：${file}`)
  for (const file of skipped) console.log(`已存在，跳过（加 --force 覆盖）：${file}`)
  if (written.length === 0 && skipped.length > 0) {
    console.log('没有写入任何文件。')
  }
}
