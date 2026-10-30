# dsh-auto-update

给 DSH（DeepSeek Harness）用的**自动更新插件**：

- 每次打开 DSH 网页都会自动查一次 npm 上有没有新版本，有就在右下角弹窗提示；
- 设置里多一个「自动更新」侧边栏，能看当前版本、检查更新、手动更新；
- 更新前后**自动备份整个 DSH 安装目录**，更新完打不开会自动回滚；
- 更新后顺便把本机插件升到兼容版本，升不了的一条条说明原因。

界面文案中英双语，跟随 DSH 的语言设置。

## 安装

插件是一个普通 npm 包（本地目录，不需要先发布）。

**一键装（推荐）**：在本包目录里执行

```bat
node scripts/install.mjs
```

它会跑 `dsh plugin --profile web add <本包目录>`，然后确认 `dsh-auto-update` 在 profile 的
`dsh.profile.bundles` 清单里（缺了就补，补之前先备份 `package.json`），最后打印挂载状态。
`--dry-run` 只打印计划，`--uninstall` 反向卸载，`--profile <名字>` 换 profile。

> 关于清单：DSH 启动时只挂载 `dsh.profile.bundles` 里列出的包。`dsh plugin add` 在 0.2.0-rc.2 上
> 会自动把**声明了 `dsh.bundle`**的新依赖加进清单（装完 pnpm 后 reconcile），所以通常一步就够；
> 脚本里的清单检查是幂等的保险——旧/新版本行为可能不同，而漏挂的失败态是"装好了却不加载、还不报错"。
> `node bin/cli.js status` 最后一行永远告诉你当前是"已挂载"还是"未挂载"。

**手动装**：`dsh plugin --profile web add <本包目录>` 一步即可；如果之后
`node bin/cli.js status` 显示未挂载，再在 `%USERPROFILE%\.dsh\profiles\web\package.json` 的
`dsh.profile.bundles` 数组里加上 `"dsh-auto-update"`。

注意 `dsh plugin add` 会用 profile 的 `pnpm-lock.yaml` 重解析 `^` 范围（其它插件的补丁位可能顺带前进，
本机实测 `billion-context` 0.1.202 → 0.1.208）。要求严格不变的话，安装前先复制一份 profile 目录。

然后重启 DSH 网页服务（关掉当前 `dsh web` 窗口重新启动，用它打印的带 token 的地址打开）。
刷新后设置里会出现「自动更新」，首次打开会自动检查一次版本。

卸载：

```bat
node scripts/install.mjs --uninstall
```

## 使用

**弹窗**：有新版时右下角出现卡片，显示 `当前 → 最新`，可「稍后提醒」（当天不再弹）、「立即更新」。
点「立即更新」后页面会短暂显示"服务正在重启"，更新完自动刷新。

**设置页**（设置 → 自动更新）：

| 区域 | 能做什么 |
| --- | --- |
| 版本 | 当前版本、最新版本、发布通道、安装路径、检查时间 |
| 操作 | 检查更新 / 立即更新到某个版本 / 重新检查插件兼容性 |
| 进度 | 当前任务的 8 个步骤进度 + 可展开的实时日志 |
| 插件体检 | 每个插件的状态（可用 / 需升级 / 不兼容 / 本地链接 / 缺失）和原因 |
| 备份 | 备份列表、是否可离线回滚、删除备份 |
| 设置 | 自动检查、发布通道、检查间隔、备份模式、保留份数、registry 地址 |

## 命令行

```bat
dsh-auto-update status                     :: 版本、插件概况、备份
dsh-auto-update check                      :: 检查有无新版（含插件体检）
dsh-auto-update plugins [--target 0.2.1-rc.4]
dsh-auto-update update --dry-run           :: 只备份并打印计划，不动安装
dsh-auto-update update --yes               :: 真更新（会重启 DSH）
dsh-auto-update backups                    :: 列出备份点
dsh-auto-update rollback --backup <id> --yes
dsh-auto-update settings --set channel=next --set keepBackups=3
```

通用参数：`--profile <名称>`（默认 `web`）、`--json`。

## 更新是怎么做的

点「立即更新」后，宿主会做两件事：

1. 在 `~/.dsh/auto-update/jobs/<id>.cmd` 写一个批处理外壳，用 `cmd.exe /c start` **单独开一个命令行窗口**，
   在窗口里跑真正的执行器（`lib/runner.mjs --visible`）。窗口里实时打印每一步、npm 的输出，以及"结束/失败"提示；
   窗口末尾有 `pause`，失败时不会一闪而过（退出码：0 成功、2 已自动回滚、1 失败）。
2. 执行器自己起一个**看护进程**（`lib/watchdog.mjs`，hidden + detached，窗口关掉也不会被带走）。

执行器按步骤干活：

```
preflight → backup → stop-host → install → verify → plugins → restart → health
```

1. **preflight**：确认安装目录、全局目录可写、不是 Electron 桌面模式；
2. **backup**：把 `@deepseek-ai/dsh` 整个目录 `tar.gz` 到 `~/.dsh/auto-update/backups/<id>/`，同时备份 profile 的配置文本；
   tar 起不来（受限环境、被杀软拦）时退而**整目录复制**，再不行才降级成"只记版本"；
3. **stop-host**：从端口找到宿主 PID 并结束（Windows 用 System32 的 `taskkill.exe`，退而用 `process.kill`）；
   15 秒内没放掉端口就报错走回滚，而不是硬装；
4. **install**：`npm install --global @deepseek-ai/dsh@<目标版本>`；
5. **verify**：重新读安装目录的 `package.json`，核对版本与关键文件；
6. **plugins**：插件兼容性同步（见下）；
7. **restart**：用**宿主原来的命令行参数**重新拉起（`--host`、`--patch` 这类参数不会丢），只替换 `--port`；
   起来就退出、或者超时，都会清一次端口再重试一遍；
8. **health**：轮询 `http://127.0.0.1:<port>/`。2xx/3xx/401/403 算出活，404/5xx 继续等
   （0.2.1 起首页会返回 `401 dsh web authentication required`，那是正常的"活着等令牌"）；
9. **对账**：健康检查过了也先别报成功，再核三件事——看护有没有写接管、磁盘版本是不是真等于目标、
   新宿主日志里有没有 `startup failed`。对不上就如实记成 `rolled-back` / `failed`，绝不报成功。

任何一步失败（尤其是 verify / restart / health）→ 自动回滚：用备份还原整个安装目录、还原 profile 配置、
重启旧版本、再健康检查，并写一份 `~/.dsh/auto-update/RECOVERY.txt` 说明情况与手动命令。

> **0.2.1 起的登录令牌**：新版 `dsh web` 首页要带令牌，窗口里会打印
> 「访问地址（含登录令牌，请整条复制）：`http://127.0.0.1:3080/?token=...`」，
> 升级后请用那条完整地址打开（旧的 `127.0.0.1:3080/` 会得到 401）。

### 安装那两三分钟，窗口里能看到什么

`npm install --global @deepseek-ai/dsh@<版本>` 要装上百个包，实测 3 分 18 秒，而 npm 自己的输出
默认进了日志文件——所以第一版看起来像卡死。现在窗口里有三样东西同时给你：

```
[19:02:24] npm install -g @deepseek-ai/dsh@0.2.1-rc.4（要装上百个包，通常 1–5 分钟；下面这行会一直走）
   ⠼ 正在安装 @deepseek-ai/dsh@0.2.1-rc.4 · 已用 1 分 12 秒 · npm 输出 87 行
[19:02:25]   npm · npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai%2fdsh 42ms
[19:04:31] npm 结束：退出码 0，耗时 2 分 07 秒
   ✔ 安装完成 @deepseek-ai/dsh@0.2.1-rc.4（用时 2 分 07 秒）
```

1. **一秒一跳的转圈行**：原地刷新，显示当前阶段 + 已用时间，不会刷屏；
2. **npm 的实时输出**：npm 的输出按 `--loglevel=http` 写进 `logs/<id>.npm.log`，同时被"跟读"着
   打到窗口（前缀 `npm · `），能看到它在下载哪个包；
3. **转发计数**：转圈行末尾的"npm 输出 N 行"就是证据——数字在涨，说明它一直在干活。

备份（约 500 MB，20 秒左右）、插件兼容性检查、等待宿主启动也都挂了同样的转圈行。
写日志时会先擦掉转圈行，两种输出不会糊在一起。

### 那个命令行窗口被关掉会怎样

执行器启动时写两个文件：`jobs/<id>.hb`（心跳，每秒一次，带 PID）和 `jobs/<id>.pid`（进程号，只写一次）。
看护进程独立判断：

| 情况 | 看护看到的 | 动作 |
| --- | --- | --- |
| 窗口被关 / 进程被强杀 | **进程号已不存在** | 立即接管 → 跑 `runner --action rollback` |
| 执行器还活着但完全卡死 | 进程号还在，但心跳 15 分钟没动 | 接管回滚 |
| 主线程忙一阵（备份、清理几百 MB） | 进程号还在 | **不插手**（这正是 10-29 那次误回滚的根因，已修） |

判断顺序是"先看进程号，再退回心跳"，因为**心跳只能证明主线程在转，证明不了进程还活着**。

接管后的回滚不依赖原来那个窗口：先停宿主、还原备份（还原用**纯 Node 解包**，不调用系统 tar）、
核对版本与 `lib/bin.js`、再拉起宿主。事后任务状态记为 `rolled-back`，原因写进任务里，
看护日志在 `logs/<id>.watchdog.log`，设置页的「最近任务」也能看到这一条。

> 还原之所以不用系统 tar：`tar.exe` 会把以 `@` 开头的成员名当成"从文件读列表"（scoped 包名必踩），
> 而某些受限环境里，从脱离的后代进程 spawn 出来的 exe 会直接 `0xC0000142` 起不来。
> 现在解包是 `lib/tar.js`（zlib + 自己解 tar 头），不依赖任何外部程序。

> 退出码：`0` 成功、`2` 已自动回滚（系统是好的，更新没成）、`1` 失败且没回滚成。

## 插件兼容性同步

DSH 官方判断"插件在新版本下能不能跑"的口径是：看插件 `peerDependencies` 里
`@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-*` 的版本区间是否被新版本满足（预发布版本参与比较）。
本插件用同一口径（`lib/semver.js` 与官方实现对拍过 390 组区间，0 差异），并补充四类官方不看的风险：

| 状态 | 含义 | 处理 |
| --- | --- | --- |
| `ok` | peer 区间满足新版本 | 不动 |
| `incompatible` | peer 区间不满足 | 去 npm 找该插件能兼容新版本的最高版本，用 `dsh plugin add pkg@版本` 原位升级；找不到就明确告诉你"作者还没发布兼容版本" |

> 找兼容版本时会读 npm 上**每一个历史版本的 peerDependencies**（不是只看 latest），
> 并且**装的是找到的那个兼容版本**，不是 dist-tag `latest`——两者经常不是同一个。
> （10-29 之前这里有两个 bug：把版本号数组当成 manifest 记录用，导致永远"检查了 0 个版本"；
> 以及找到兼容版本却装了 latest。都已修。）

| `declared-untested` | peer 没卡版本，但作者声明的 `dsh.compatibility` 没覆盖新版本 | 仍然升级/保留，但提示"作者未声称测试过" |
| `client-bundle` | 声明了 `dsh.client` 但 `exports["./client"]` 文件缺失 | 前端的插件会在浏览器里静默失效，单独报出来 |
| `engine` / `native` | Node 版本要求不满足 / 含原生 `.node` 模块 | 提示需要重编译 |
| `local` | `link:` / `file:` 本地链接插件 | 不去动它，提示"需在源码里自行适配" |
| `missing` | profile 里登记了但 `node_modules` 里没有 | 提示重新安装 |

每个不能直接运行的插件都会有一句中文说明（`explanation` 字段），设置页直接展示。

### 启动日志体检（peer 检查抓不到的那一类）

版本区间满足、装得上，**不代表能跑**。插件可能只是依赖了某个在新版本里被删掉或改名的服务，
宿主启动时它就停在 `pending (waiting for service: webRuntime)`——这种事只有在启动日志里才能看见。
所以升级重启之后，执行器会读新宿主的启动日志，把没激活的插件归因到具体包名，写进任务并显示在设置页：

- 日志样例：`dsh: warning: 1 entry did not activate` + `better-sidebar (dsh-better-sidebar): pending (waiting for service: webRuntime)`
- 界面会说：这个插件版本区间没问题，但宿主启动时一直在等 `webRuntime` 服务——通常是新版本把这服务删了或改名了
- **只有"必需插件没起来"（`dsh: startup failed:` / `Failed plugins (N):`）才判定升级失败并回滚**；
  单个可选插件 pending 属于"半残"，照样保留新版本，只是明确告诉你哪个插件坏了、为什么坏

本机实例：从 `0.2.0-rc.2` 升到 `0.2.1-rc.4` 后，`dsh-better-sidebar@0.28.2` 的 peer 区间满足，
但 0.2.1-rc.4 里已经没有 `webRuntime` 这个服务了（源码里 grep 不到），所以它的宿主半起不来——
侧边栏插件随之失效。这就是"区间满足但跑不起来"的真实例子。

## HTTP 接口

宿主半挂在同源 `/dsh-auto-update/api` 下，写操作都要求同源 POST：

```
GET  /status  /check  /plugins?target=  /job  /backups  /plan
POST /check  /update  /rollback  /restart  /sync-plugins  /settings  /skip  /dismiss  /delete-backup  /prune
```

## 重启 DSH（不用再找命令行）

设置 → DSH 更新 最下面有「重启 DSH」：点一下就走执行器把宿主停掉再拉起来，
**不改版本、不动安装目录**，重启期间页面显示"正在重启"，恢复后自动刷新。

重启和更新结束后的启动都用**可见的控制台窗口**，原因很实际：

- 任何时候都有一个窗口可以 `Ctrl+C`，不用去找隐藏进程；
- 启动报错（`did not activate`、模块缺失）直接显示在窗口里，不用摸黑猜；
- 那个窗口关掉了也只是这次 DSH 退出，不会连带别的东西。

**这个窗口不是 `detached` 起的**（以前是，现在不是了）。Windows 上 `detached` 意味着
`CREATE_NEW_PROCESS_GROUP`，而在这个进程组里 **Ctrl+C 是被禁用的、而且会被所有子进程继承** ——
这就是「窗口在、但 Ctrl+C 没反应」的真正原因。现在改成普通子进程（继承控制台），
Ctrl+C 才能送到那个 node 启动器，再由它转成对 DSH 的强杀（见下一节）。
代价是宿主所在的控制台和本进程在同一个作业里，所以停宿主统一走 `netstat` 找 PID + `taskkill /T /F`，
而不是靠父进程信号。

窗口标题是 `DSH web <端口>`，里面直接是 `node <安装目录>/lib/bin.js --profile <p> --port <端口>`
加上你原来启动 DSH 时用的那些参数（`--host`、`--patch` 等都会被原样带上），
工作目录也沿用原来的 —— 所以重启出来的 DSH 和你手动起的那个一模一样。

几个细节：

- **重启不会新开标签页**。`dsh web` 默认会用系统浏览器打开 UI（它自己的 `--no-open` 就是关这个的），
  插件在重启命令行里统一补上 `--no-open`，页面交给原来那个标签自己刷新 ——
  浏览器里始终只有一个标签，登录态也不掉（会话 cookie 是签名的，重启后仍有效）。
- **窗口按任意键就会关**。等按键是在执行器（node）里做的，不是批处理的 `pause` ——
  node 是那个控制台的原始进程，它退出时窗口一定关，不受终端"运行完保留窗口"设置的影响；
  只有出错时才会多停一次，方便你读完报错再按键。
- **被替换掉的旧 DSH 窗口会自己关**。DSH 本体跑在一个 node 启动器里（`logs/dsh-launch-*.mjs`），
  它按存活时长分流：启动阶段就崩才停住等按键，正常被重启停掉或用户 Ctrl+C 则直接退出关窗 ——
  所以连续重启不会把窗口越积越多。

`GET /job` 不带 `id` 时返回"进行中的任务，没有就返回最近一次"，响应里多一个 `isCurrent`
（`false` 表示已经结束，界面拿它显示结局而不是继续转圈）；`/status` 里也有 `lastJob`
摘要，刷新页面能恢复上一次任务的结论。

任务卡在"正在执行"时不用管：`/status` 与 `/job` 都会对任务做一次对账
（`lib/state.js` 的 `reconcileJob`）—— 执行器的心跳 `jobs/<id>.hb` 停了、或者它记下的
`pid` 已经不在、或者建了任务却迟迟没起来，任务会被改写成 `failed` 并写明原因
（例如"执行器进程 3092 已经退出，但任务没有写完结论（命令行窗口被关掉了？）"）。

## 在那个窗口里按 Ctrl+C

DSH 的窗口是一个很小的 node 启动器（不是 cmd 本体），它负责：起 DSH、转发输出、崩溃时留住窗口。
按 Ctrl+C 时它会自己接管：

1. 打印「收到 Ctrl+C，正在结束 DSH…」；
2. 给 DSH 1 秒自己优雅退出（控制台事件它也会收到）；
3. 1 秒后 `taskkill /PID … /T /F` 收掉整棵进程树，再兜一层 `child.kill()`；
4. 窗口随即关闭（不会再停「按任意键」）。

所以 Ctrl+C 一定能停。反过来，**关掉窗口**（点 ×）等于给启动器发 SIGHUP，它不是 Ctrl+C 那条路：
更新/回滚过程中关窗口会被看护进程判定为中断并自动回滚，正常运行时关窗口只是把 DSH 一起带走。

如果哪次 Ctrl+C 还是不灵（比如 DSH 卡在某个驱动里），用桌面上的 `停止DSH.cmd`
或者设置页里的「停止 DSH」：两者都是 `netstat` 找 PID + `taskkill /T /F` 收整棵树，不依赖信号。

### 为什么按 Ctrl+C 会带出一段 python 堆栈

实测里两个"副作用"的原因都不是插件，而是 Windows 控制台的机制：

1. **`终止批处理操作吗(Y/N)?`** —— 桌面脚本以前直接在批处理里 `node …`，cmd 是那个窗口的前台
   并"等着" node，Ctrl+C 同时打在 cmd 身上，它就要问要不要终止批处理。现在桌面脚本只做一次
   `start` 就退出，窗口里跑的是 `lib/dsh-launch.mjs`，由它接管 Ctrl+C —— **不会再问这一句**。
2. **`KeyboardInterrupt` 堆栈**（常见于 python 写的 MCP 服务）—— Ctrl+C 是**广播给同一个
   控制台里所有进程**的，DSH 拉起的 python MCP 子进程同样收到，python 的习惯就是打一段堆栈再退出。
   DSH 自己是干净的（5 秒有界关停），噪音来自子进程。想**完全安静地停**，用「停止 DSH」或
   `停止DSH.cmd`：它们只做 `netstat` 找 PID + `taskkill /T /F`，**不发控制台事件**。
   要根治得在 DSH 侧把 MCP 子进程放进独立进程组（`CREATE_NEW_PROCESS_GROUP`），那是上游的事。

## 停止 DSH

设置 → DSH 更新 → 「进程」卡片里有「停止 DSH」：执行器把宿主停掉就结束，**不会再拉起来**
（想重新起来就用桌面上的 `启动DSH.cmd` 或「重启 DSH」）。用它代替 `Ctrl+C` 也行。

## 桌面上的两个小脚本

插件装好后，生成两个可以双击的批处理（**路径按当前机器自动填**，不会把别人的路径写死）：

```bat
node scripts/install-desktop.mjs                       # 写到当前用户桌面，端口 3080
node scripts/install-desktop.mjs --port 3098 --profile web --workspace D:\code
```

- `启动DSH.cmd`：一行 `start "DSH web <端口>" /D <工作目录> <node> <本包>\lib\dsh-launch.mjs --profile … --port …`
  然后退出。窗口标题 `DSH web <端口>`，里面是启动器 + DSH 本体；
- `停止DSH.cmd`：PowerShell 读 `netstat` 找该端口的监听 PID → `taskkill /PID … /T /F`，
  不依赖信号；无监听时输出 `DSH is not listening on port <端口> - nothing to stop.`。

`lib/dsh-launch.mjs` 是那个窗口的"主进程"：起 DSH（stdio 继承、工作目录沿用原样）、
接管 `SIGINT/SIGBREAK/SIGHUP`，收到就 `taskkill /T /F` 整棵树并让窗口立即关闭；
DSH 自己退出时透传退出码，非零且是终端时才停住等按键（崩溃看报错）。

两个脚本都是单行语法（CRLF），并且刻意**不做端口检测分支**：中文 codepage 下
`netstat | findstr /r /c:":<端口> .*LISTENING"` 会报"内存资源不足"，加一段不可靠的检测
不如让 DSH 自己报 `EADDRINUSE`。

## 数据放在哪

```
~/.dsh/auto-update/
├── state.json          设置、上次检查结果、跳过清单、最后一次任务
├── jobs/<id>.json      任务（步骤、时间、结果）
├── jobs/<id>.hb        执行器心跳（看护进程靠它判断死活）
├── jobs/<id>.pid       执行器进程号（任务对账时判断它还在不在）
├── jobs/<id>.cmd       那个命令行窗口用的批处理外壳
├── logs/<id>.log       执行器完整日志
├── backups/<id>/       备份（backup.json + profile/ + dsh-<版本>.tar.gz）
└── RECOVERY.txt        失败时的人工兜底说明
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DSH_AUTO_UPDATE_STATE_DIR` | 换一个状态目录（测试/多实例时用） |
| `DSH_AUTO_UPDATE_NO_WARM=1` | 关掉启动后那次静默检查 |
| `DSH_AUTO_UPDATE_DEBUG=1` | 接口 500 时回传堆栈 |
| `DSH_AUTO_UPDATE_NPM_CLI` | 指定 npm CLI 路径（npm 装在非标准位置时） |
| `DSH_AUTO_UPDATE_NO_WINDOW=1` | 不弹命令行窗口，改成后台跑（看不到进度，不推荐） |
| `DSH_AUTO_UPDATE_NO_LAUNCH=1` | 只建任务、不拉起执行器（测试用，`host-smoke` 靠它验证接口语义） |
| `DSH_AUTO_UPDATE_STALE_MS` | 心跳多久算"卡死"（默认 15000 毫秒） |
| `DSH_AUTO_UPDATE_WATCHDOG_MAX_MS` | 看护最长看多久（默认 2 小时，超时不再等） |

## 配置（可写进 profile 的 `cordis.patch.yml`）

```yaml
- id: dsh-auto-update
  name: dsh-auto-update
  config:
    channel: auto            # auto | latest | next | alpha | newest
    autoCheck: true
    checkIntervalHours: 6
    registry: https://registry.npmjs.org
```

## 测试

```bat
node test/semver-oracle.mjs      :: 与官方 evaluatePluginCompatibility 对拍 390 组
node test/backup-roundtrip.mjs   :: 备份 → 弄坏 → 还原 的往返
node test/mount-smoke.mjs        :: 「装了但没写清单」的挂载检测与清单编辑
node test/host-smoke.mjs         :: 所有 HTTP 接口（真实 http server）
node test/client-smoke.mjs       :: 浏览器 bundle 的注册与三种状态渲染
node test/runner-e2e.mjs         :: 假 npm + 假 dsh 跑完整升级与自动回滚
node test/bundle-boot.mjs        :: 真起一个隔离 DSH（临时 DSH_HOME + 随机端口）验证真挂载
```

`npm test` 跑前 6 个（快），`npm run test:boot` 单独跑真启动验证（会起一个临时 DSH 实例并在结束时杀掉，不碰你的 profile 与 3080）。
端到端测试用假 npm，**不会**动你的真实全局安装。

## 限制

- **桌面客户端（Electron）模式不支持自更新**：那里 DSH 由安装包托管，插件会直接拒绝并说明原因，请用安装包升级。
- 更新会**重启网页服务**，正在跑的会话会中断几秒；如果你正开着别的标签页，刷新即可。
- `dsh-plugin` 这类把 `@deepseek-ai/cordis` 精确锁版本的插件，官方兼容性口径**看不到** cordis 的 peer，属于已知盲区（升级后如出现运行时错误，回滚即可）。
- 回滚依赖 `tar.gz` 完整备份；磁盘空间不足时自动降级为"只备份配置"，这种备份不能离线还原安装目录。
- 只会在安装目录是 npm 全局安装时自更新；其它安装方式（pnpm 全局、本地源码）请用原方式升级。

## 平台支持

| 能力 | Windows | macOS / Linux |
| --- | --- | --- |
| 打开网页自动检查版本、弹窗提示 | ✅ | ✅ |
| 设置页看版本、检查更新、插件体检 | ✅ | ✅ |
| 手动更新（`npm i -g` + 重启） | ✅ | 未验证（`npm i -g` 可跑，重启用系统服务管理器） |
| 停止 / 重启宿主 | ✅（`netstat` + `taskkill`） | ❌ 接口会返回 409 并说明原因 |
| 完整备份与自动回滚（纯 Node 解包 `tar.gz`） | ✅ | ✅ |

非 Windows 上 `/update`、`/rollback`、`/restart`、`/stop`、`/sync-plugins` 统一返回 409 +
原因，不会抛底层错误；「检查更新」和「插件体检」在任何平台都能用。

## 发布（维护者）

```bat
npm test                      :: 8 个套件（含脱敏自检与端到端）
node scripts/check-package.mjs :: 单独跑发布自检（npm pack 前会自动跑）
npm pack --dry-run            :: 看会打出哪些文件
npm publish                   :: 发布到 npm（需要你自己登录）
```

脱敏约定：

- 仓库里**不放**任何写死路径的批处理——桌面脚本由 `scripts/install-desktop.mjs` 按当前机器生成，
  模板在 `scripts/templates/`；
- `scripts/check-package.mjs` 会按 `package.json` 的 `files` 扫一遍，命中用户名、用户目录绝对路径、
  开发目录名、他人插件名等直接让 `npm pack` 失败；
- 文档里的路径一律用占位符（`<本包目录>`、`<端口>`）而不是某个人的真实目录。

