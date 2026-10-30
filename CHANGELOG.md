# 变更记录

本文件记录对外可见的行为变化。版本号遵循 semver：`0.x` 期间小版本可能夹带不兼容调整。

## 0.3.0 — 首个可发布版本

这一版把内部开发版（0.2.x）**脱敏**成可公开发布的形式：不含任何本机路径、用户名、工作目录或
他人机器上的插件名。

- 新增 `scripts/install-desktop.mjs` 与 `scripts/templates/`：桌面上的「启动DSH.cmd」「停止DSH.cmd」
  改为**按当前机器现生成**（node 路径、本包位置、工作目录、profile、端口都在运行时填入），
  仓库里不再保存任何写死路径的批处理。
- 新增 `scripts/check-package.mjs`（`npm pack` 前自动跑）与 `test/sanitize-smoke.mjs`：
  打包前扫描文件清单，出现用户目录绝对路径、用户名、工作区路径等泄露内容直接失败。
- 宿主侧新增平台检查：`POST /update`、`/rollback`、`/restart`、`/stop`、`/sync-plugins`
  在非 Windows 上返回明确的 409（停止/重启依赖 `netstat` + `taskkill`），而不是抛底层错误。
  「检查更新」「插件体检」「看版本」在所有平台照常可用。
- `lib/dsh-launch.mjs` 的默认 profile / 端口 / 工作目录改为读 `DSH_LAUNCH_PROFILE`、
  `DSH_LAUNCH_PORT`、`DSH_LAUNCH_CWD`（缺省 `web` / `3080` / 当前目录），不再依赖开发机布局。
- `test/mount-smoke.mjs` 用当前包的真实路径做断言，仓库移动后仍可跑。
- 包元数据补齐：`license`（MIT）、`files`、`publishConfig.access`，英文 `description`。

## 0.2.7 — 干净地 Ctrl+C

- 桌面启动方式改为「一次性 `start` + `lib/dsh-launch.mjs` 接管」：窗口里不再出现
  `终止批处理操作吗(Y/N)?`；Ctrl+C 时启动器 `taskkill /T /F` 收掉整棵树，并让窗口立即关闭。
- 启动器把 DSH 的退出码透传；只有「异常退出且是终端」才停住等按键，方便看崩溃信息。
- 顺带修掉启动器参数解析导致 `--profile` 丢失（`error: --profile <name> is required`）的 bug。

## 0.2.6 — 停止 DSH 按钮

- 设置页新增「停止 DSH」（`POST /stop`）：停掉宿主就结束，不会再拉起来。
- 可见窗口的重启不再用 `detached`：Windows 上 `CREATE_NEW_PROCESS_GROUP` 会让整组进程
  忽略 Ctrl+C，这是之前「按 Ctrl+C 没反应」的根因。

## 0.2.5 — Ctrl+C 能停了

- 启动器不再吞 `SIGINT/SIGBREAK`，收到后 1 秒内 `taskkill /T /F` 子进程树，5 秒兜底强退。

## 0.2.4 — 启动日志体检

- 升级后读新宿主的启动输出，抓 `did not activate` / `pending (waiting for service: …)`，
  归因到具体插件并在设置页逐条说明；这类"装得上但跑不动"的插件不再无声无息。

## 0.2.3 — 单一窗口

- 可见窗口里跑的是 node 启动器而不是批处理，能区分「被我们停掉」和「启动崩溃」，
  只在该停住的时候停住。

## 0.2.2 — 重启按钮

- 设置页「重启 DSH」：网页点一下就重启，页面在恢复后自动刷新。
- 升级结束后的重启也改成可见窗口（可用 `DSH_AUTO_UPDATE_NO_WINDOW=1` 关掉），
  并自动补 `--no-open`，不再每次重启多开一个浏览器标签页。

## 0.2.1 — 假成功修复

- 健康检查只认 2xx，避免把鉴权页的 401/404 当成"已启动"。
- 任务结局以实际状态为准：看护进程接管回滚后不再被报告成 succeeded。
- 看护进程用 pid 文件判断执行器死活，安装大包时的长时间静默不再被误判为卡死。

## 0.2.0 — 自动更新可用

- 打开网页自动检查、弹窗提示、设置页检查/手动更新、更新前完整备份、失败自动回滚、
  已装插件兼容性同步与逐条原因说明。
