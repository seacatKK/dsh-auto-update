// DSH 的控制台启动器：双击桌面脚本、或从「重启 DSH」拉起时，都由它包一层。
//
// 为什么需要这一层：
// 1) Windows 的控制台 Ctrl+C 会送给**同一个控制台里的所有进程**（cmd、node、以及 DSH 拉起的
//    python MCP 子进程）。如果让 cmd 直接等 node，按 Ctrl+C 时 cmd 会追问
//    「终止批处理操作吗(Y/N)?」；而 MCP 子进程会打印 KeyboardInterrupt 堆栈。
// 2) 这一层接管 SIGINT/SIGBREAK，收到就立刻对 DSH 整棵树 taskkill /T /F，
//    所以「按一次 Ctrl+C 一定停」且窗口立刻关闭，不需要二次确认。
//
// 用法：
//   node dsh-launch.mjs --profile web --port 3080 [--entry <bin.js>] [--cwd <dir>] [原有 dsh 参数...]
// 测试钩子：
//   DSH_AU_LAUNCH_SELFTEST_MS=500  启动 0.5 秒后自动模拟一次 Ctrl+C（沙箱里无法真按键）
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);

// 本启动器自己的参数：--profile / --port / --entry / --cwd（可写成 --x=v 或 --x v）。
// 其余参数原样透传给 DSH（--host、--patch …）。
const ownOptions = new Map()
const forward = []
for (let index = 0; index < argv.length; index += 1) {
  const item = argv[index]
  const equal = /^(--profile|--port|--entry|--cwd)=(.*)$/.exec(item)
  if (equal) {
    ownOptions.set(equal[1], equal[2])
    continue
  }
  if (item === '--profile' || item === '--port' || item === '--entry' || item === '--cwd') {
    ownOptions.set(item, argv[index + 1])
    index += 1
    continue
  }
  forward.push(item)
}

const profile = ownOptions.get('--profile') ?? process.env.DSH_LAUNCH_PROFILE ?? 'web'
const port = ownOptions.get('--port') ?? process.env.DSH_LAUNCH_PORT ?? '3080'
const cwd = resolve(ownOptions.get('--cwd') ?? process.env.DSH_LAUNCH_CWD ?? process.cwd())
const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')

const entryOption = { value: ownOptions.get('--entry') }

function locateEntry() {
  if (entryOption.value) return resolve(entryOption.value);
  const profileDir = join(dshHome, 'profiles', profile);
  try {
    const requireFromProfile = createRequire(join(profileDir, 'package.json'));
    const manifestPath = requireFromProfile.resolve('@deepseek-ai/dsh/package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return join(dirname(manifestPath), manifest.bin?.dsh ?? 'lib/bin.js');
  } catch {
    const fallback = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(fallback)) return fallback;
    throw new Error('找不到 DSH 安装位置（可用 --entry 指定 lib/bin.js）');
  }
}

const entry = locateEntry()
if (!forward.includes('--profile')) forward.push('--profile', profile)
if (!forward.includes('--port')) forward.push('--port', String(port))

function taskkillTree(pid) {
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  try {
    const result = spawnSync(existsSync(exe) ? exe : 'taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

console.log(`DSH web ${port} — ${entry}`);
console.log(`工作目录 ${cwd}`);
console.log('按 Ctrl+C 停止 DSH（整棵树一起结束，窗口随即关闭）。');
console.log('');

const child = spawn(process.execPath, [entry, ...forward], {
  cwd,
  stdio: 'inherit',
  env: { ...process.env, DSH_HOME: dshHome },
  windowsHide: false,
});

let stopping = false;

function stop(reason) {
  if (stopping) {
    // 连按第二次：不再等，直接退出（子树已经被第一次的 taskkill 带去）
    process.exit(0);
  }
  stopping = true;
  console.log('');
  console.log(`收到 ${reason}，正在结束 DSH（含子进程）…`);
  const killed = taskkillTree(child.pid);
  if (!killed) {
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
  }
  // taskkill 是同步的；给控制台一点时间把最后几行刷出来，然后直接关窗
  setTimeout(() => process.exit(0), 150);
}

process.on('SIGINT', () => stop('Ctrl+C'));
process.on('SIGBREAK', () => stop('Ctrl+Break'));
process.on('SIGHUP', () => stop('窗口关闭'));

const selftestAfter = Number(process.env.DSH_AU_LAUNCH_SELFTEST_MS ?? 0);
if (selftestAfter > 0) {
  setTimeout(() => stop('Ctrl+C（自检）'), selftestAfter);
}

child.on('error', (error) => {
  console.error(`无法启动 DSH：${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (stopping) {
    process.exit(0);
  }
  const shown = code !== null ? `退出码 ${code}` : `信号 ${signal ?? '未知'}`;
  console.log('');
  console.log(`DSH 已退出（${shown}，运行 ${Math.round(process.uptime())} 秒）。`);
  if (code !== 0 && process.stdin.isTTY) {
    // 崩溃留窗：让用户能读完报错再关
    console.log('按任意键关闭窗口…');
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(code ?? 1));
    setTimeout(() => process.exit(code ?? 1), 120_000);
  } else {
    process.exit(code ?? 0);
  }
});
