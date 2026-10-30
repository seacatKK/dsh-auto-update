window.__ModuleLoader__.load({
  id: 'dsh-auto-update',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // React 只能从客户端模块表拿，绝不能 import 任何 Harness UI 包
    var React = require('react');
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var useRef = React.useRef;
    var useCallback = React.useCallback;

    var NS = 'dsh-auto-update';
    var API = '/dsh-auto-update/api';

    // ---------------------------------------------------------------- locale
    var zh = {
      nav: 'DSH 更新',
      title: 'DSH 自动更新',
      subtitle: '检查新版本、一键升级、必要时回滚',
      currentVersion: '当前版本',
      installPath: '安装位置',
      profileName: '当前 Profile',
      channel: '更新通道',
      latestVersion: '最新版本',
      checking: '检查中…',
      checkNow: '检查更新',
      upToDate: '已是最新版本',
      updateAvailable: '发现新版本',
      updateNow: '立即更新',
      skipVersion: '跳过此版本',
      later: '稍后提醒',
      publishedAt: '发布于',
      noUpdateInfo: '还没有检查过更新',
      checkFailed: '检查更新失败',
      plugins: '插件兼容性',
      pluginsHint: '升级前先按官方 peerDependencies 口径预演，升级后自动处理能修好的插件',
      pluginName: '插件',
      pluginVersion: '版本',
      pluginStatus: '状态',
      pluginReason: '说明',
      statusOk: '可用',
      statusLocal: '本地链接',
      statusUnknown: '未测试',
      statusIncompatible: '不兼容',
      statusMissing: '缺失',
      statusCore: '官方内置',
      summaryOfPlugins: '共 %s 个插件：可用 %s，需处理 %s',
      syncPlugins: '同步插件',
      backups: '备份与回滚',
      backupsHint: '回滚会用备份里的 DSH 与 profile 配置覆盖当前安装，然后自动重启',
      noBackups: '还没有备份。第一次更新时会自动创建',
      backupTime: '时间',
      backupSize: '体积',
      backupMode: '方式',
      modeFull: '完整备份',
      modeMetadata: '仅配置',
      rollback: '回滚到此备份',
      rollbackConfirm: '确认回滚？DSH 会先停止，还原后自动重启',
      delete: '删除',
      settings: '偏好设置',
      autoCheck: '打开网页时自动检查更新',
      autoCheckHint: '宿主启动后会静默检查一次；关掉后只能手动检查',
      checkInterval: '自动检查间隔（小时）',
      backupModeSetting: '备份方式',
      backupFullHint: '完整备份能离线回滚（约 500MB，视安装体积而定）',
      backupMetadataHint: '只备份配置与版本号，回滚时需联网重装',
      keepBackups: '保留备份数量',
      registry: 'registry 地址',
      save: '保存设置',
      saving: '保存中…',
      saved: '已保存',
      channelAuto: '自动（正式版跟 latest，预发布版跟 next）',
      channelLatest: '仅正式版（latest）',
      channelNext: '预发布（next）',
      channelAlpha: '内测（alpha）',
      channelNewest: '可选最高版本',
      jobTitle: '任务进度',
      jobRunning: '正在执行',
      jobSucceeded: '已完成',
      jobFailed: '失败',
      jobRolledBack: '已回滚',
      windowHint: '更新在独立的命令行窗口里执行，窗口中有实时进度',
      windowCloseWarning: '请不要关闭那个命令行窗口：关掉会中断更新，看护进程会自动回滚到原版本',
      windowOpened: '已打开命令行窗口',
      restartDuringWindow: '服务正在重启，页面恢复后会自动刷新；命令行窗口里仍在继续',
      abortedByWindow: '更新窗口被关闭，已自动回滚到原版本',
      lastJobs: '最近任务',
      noJobs: '还没有执行过更新或回滚',
      activationTitle: '启动告警',
      activationIntro:
        '读的是宿主启动日志：插件“装得上”不等于“真的跑起来了”。这里列出启动时没有激活的插件——常见原因是它依赖的服务在新版本里被删掉或改名了。',
      activationNone: '最近一次启动里，所有插件都激活了。',
      activationBadge: '未激活',
      activationPending: '一直没激活：在等 %s 服务',
      activationRequired: '必需插件，它不激活会让 DSH 起不来',
      activationFailed: '启动时没有激活（详情见任务日志）',
      kindUpdate: '更新',
      kindRollback: '回滚',
      kindSync: '同步插件',
      kindRestart: '重启',
      restartDsh: '重启 DSH',
      restartHint: '重启宿主进程本身（不改版本、不动安装目录）。重启期间页面会断开几十秒，恢复后自动刷新。',
      stopDsh: '停止 DSH',
      stopHint: '直接结束宿主进程（不改版本、不动文件）。停止后网页立刻断开，用桌面上的「启动DSH.cmd」或上面的「重启 DSH」再拉起来。',
      stopConfirm: '确定停止 DSH？停止后网页会断开，需要重新启动才能继续用。',
      kindStop: '停止',
      restartingHost: 'DSH 正在重启…恢复后页面会自动刷新，请不要关闭标签页。',
      jobSteps: '步骤',
      jobCancelled: '已取消',
      stepPreflight: '环境检查',
      stepBackup: '备份',
      stepStopHost: '停止 DSH',
      stepInstall: '安装新版本',
      stepVerify: '校验安装',
      stepPlugins: '同步插件',
      stepRestart: '重启',
      stepHealth: '健康检查',
      stepRestore: '还原备份',
      log: '日志',
      showLog: '查看日志',
      hideLog: '收起日志',
      reconnecting: 'DSH 正在重启，恢复后页面会自动刷新…',
      reloadNow: '立即刷新',
      updateConfirm: '确认更新？过程中 DSH 会停止，随后自动重启并刷新页面',
      dismiss: '关闭',
      openSettings: '查看详情',
      prereq: '更新前自动备份，升级失败会自动回滚到当前版本',
      restartWarning: '更新期间 DSH 会短暂离线',
      cannotUpdate: '当前环境不能自动更新',
      electronBlocked: '当前是桌面客户端（Electron）模式，自动更新会替换正在运行的安装包，请使用桌面端自己的更新方式',
      unwritable: '没有写入全局安装目录的权限，请用管理员身份重开终端后再试',
      noNpm: '找不到 npm，无法执行安装',
      bannerTitle: 'DSH 有新版本',
      bannerReady: '可以更新',
      syncDone: '插件同步完成',
      confirmDeleteBackup: '确认删除这个备份？删除后无法再用它回滚',
      errorPrefix: '操作失败',
      loadFailed: '无法连接更新服务（可能正在重启）',
      retry: '重试',
      progress: '进度',
      of: '/',
      updatedTo: '已更新到',
      rolledBackTo: '已回滚到',
    }

    var en = {
      nav: 'DSH Updates',
      title: 'DSH Auto Update',
      subtitle: 'Check for new versions, upgrade in one click, roll back if needed',
      currentVersion: 'Current version',
      installPath: 'Install path',
      profileName: 'Profile',
      channel: 'Channel',
      latestVersion: 'Latest version',
      checking: 'Checking…',
      checkNow: 'Check for updates',
      upToDate: 'You are up to date',
      updateAvailable: 'New version available',
      updateNow: 'Update now',
      skipVersion: 'Skip this version',
      later: 'Remind me later',
      publishedAt: 'Published',
      noUpdateInfo: 'No update check yet',
      checkFailed: 'Update check failed',
      plugins: 'Plugin compatibility',
      pluginsHint: 'Rehearsed against the official peerDependencies rules before upgrading',
      pluginName: 'Plugin',
      pluginVersion: 'Version',
      pluginStatus: 'Status',
      pluginReason: 'Details',
      statusOk: 'Ready',
      statusLocal: 'Local link',
      statusUnknown: 'Untested',
      statusIncompatible: 'Incompatible',
      statusMissing: 'Missing',
      statusCore: 'Built-in',
      summaryOfPlugins: '%s plugins: %s ready, %s need attention',
      syncPlugins: 'Sync plugins',
      backups: 'Backups & rollback',
      backupsHint: 'Rollback restores the DSH install and profile files from a backup, then restarts',
      noBackups: 'No backups yet. One is created automatically on the first update',
      backupTime: 'Time',
      backupSize: 'Size',
      backupMode: 'Mode',
      modeFull: 'Full',
      modeMetadata: 'Config only',
      rollback: 'Roll back to this backup',
      rollbackConfirm: 'Roll back now? DSH will stop, restore, then restart automatically',
      delete: 'Delete',
      settings: 'Preferences',
      autoCheck: 'Check for updates when the web UI opens',
      autoCheckHint: 'A silent check runs after the host starts; disable to check manually',
      checkInterval: 'Auto-check interval (hours)',
      backupModeSetting: 'Backup mode',
      backupFullHint: 'Full backups roll back offline (about 500MB, depending on size)',
      backupMetadataHint: 'Only config and versions are saved; rollback re-downloads over the network',
      keepBackups: 'Backups to keep',
      registry: 'Registry',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      channelAuto: 'Auto (latest for releases, next for pre-releases)',
      channelLatest: 'Releases only (latest)',
      channelNext: 'Pre-release (next)',
      channelAlpha: 'Canary (alpha)',
      channelNewest: 'Highest available',
      jobTitle: 'Task progress',
      jobRunning: 'Running',
      jobSucceeded: 'Completed',
      jobFailed: 'Failed',
      jobRolledBack: 'Rolled back',
      windowHint: 'The update runs in its own command prompt window, with live progress',
      windowCloseWarning: 'Do not close that command prompt window: closing it aborts the update and the watchdog rolls back to the current version',
      windowOpened: 'Command prompt window opened',
      restartDuringWindow: 'DSH is restarting; this page refreshes when it is back, the command prompt keeps working',
      abortedByWindow: 'The update window was closed; rolled back to the previous version',
      lastJobs: 'Recent jobs',
      noJobs: 'No update or rollback has run yet',
      activationTitle: 'Startup warnings',
      activationIntro:
        'Read from the host startup log: a plugin that installs is not necessarily a plugin that runs. Anything that failed to activate at startup shows up here — usually because a service it needs was removed or renamed in the new version.',
      activationNone: 'Every plugin activated in the most recent startup.',
      activationBadge: 'inactive',
      activationPending: 'never activated: waiting for the %s service',
      activationRequired: 'required plugin — without it DSH cannot start',
      activationFailed: 'did not activate at startup (see the job log)',
      kindUpdate: 'Update',
      kindRollback: 'Rollback',
      kindSync: 'Sync plugins',
      kindRestart: 'Restart',
      restartDsh: 'Restart DSH',
      restartHint: 'Restart the host process itself (no version change, install dir untouched). The page is offline for a few seconds and reloads once it is back.',
      stopDsh: 'Stop DSH',
      stopHint: 'Kill the host process outright (no version change, no files touched). The page disconnects immediately; start DSH again with the desktop launcher or with Restart DSH above.',
      stopConfirm: 'Stop DSH now? The web UI will disconnect and you will need to start it again.',
      kindStop: 'Stop',
      restartingHost: 'DSH is restarting… the page reloads as soon as it is back; keep this tab open.',
      jobSteps: 'steps',
      jobCancelled: 'Cancelled',
      stepPreflight: 'Preflight',
      stepBackup: 'Backup',
      stepStopHost: 'Stop DSH',
      stepInstall: 'Install',
      stepVerify: 'Verify',
      stepPlugins: 'Sync plugins',
      stepRestart: 'Restart',
      stepHealth: 'Health check',
      stepRestore: 'Restore',
      log: 'Log',
      showLog: 'Show log',
      hideLog: 'Hide log',
      reconnecting: 'DSH is restarting; the page reloads as soon as it is back…',
      reloadNow: 'Reload now',
      updateConfirm: 'Update now? DSH stops, restarts and the page reloads automatically',
      dismiss: 'Dismiss',
      openSettings: 'Details',
      prereq: 'A backup is taken first; a failed upgrade rolls back automatically',
      restartWarning: 'DSH goes briefly offline during the update',
      cannotUpdate: 'This environment cannot self-update',
      electronBlocked: 'Running inside the desktop (Electron) shell; use its own updater instead',
      unwritable: 'No permission to write the global install directory. Reopen a terminal as administrator',
      noNpm: 'npm was not found, cannot install',
      bannerTitle: 'A new DSH version is available',
      bannerReady: 'ready to install',
      syncDone: 'Plugin sync finished',
      confirmDeleteBackup: 'Delete this backup? It can no longer be used for rollback',
      errorPrefix: 'Failed',
      loadFailed: 'Cannot reach the update service (it may be restarting)',
      retry: 'Retry',
      progress: 'Progress',
      of: 'of',
      updatedTo: 'Updated to',
      rolledBackTo: 'Rolled back to',
    }

    // ------------------------------------------------------------------ util
    function formatBytes(bytes) {
      if (!bytes || bytes < 0) return '—'
      var units = ['B', 'KB', 'MB', 'GB', 'TB']
      var value = bytes
      var index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return (value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[index]
    }

    function formatTime(value) {
      if (!value) return '—'
      var date = new Date(typeof value === 'number' ? value : String(value))
      if (Number.isNaN(date.getTime())) return '—'
      var pad = function (n) {
        return n < 10 ? '0' + n : String(n)
      }
      return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        ' ' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes())
      )
    }

    function request(path, options) {
      var init = Object.assign({ credentials: 'same-origin', headers: {} }, options || {})
      if (init.body !== undefined && typeof init.body !== 'string') {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(init.body)
      }
      return fetch(API + path, init).then(function (response) {
        return response.text().then(function (text) {
          var data
          try {
            data = text ? JSON.parse(text) : {}
          } catch (error) {
            throw new Error('HTTP ' + response.status)
          }
          if (!response.ok || data.ok === false) {
            var failure = new Error(data && data.error ? data.error : 'HTTP ' + response.status)
            // 带上状态码：调用方要能区分"任务记录不存在（404）"和"宿主暂时连不上"
            failure.status = response.status
            throw failure
          }
          return data
        })
      })
    }

    function statusTone(status) {
      if (status === 'ok') return 'success'
      if (status === 'incompatible' || status === 'missing') return 'danger'
      if (status === 'unknown' || status === 'local') return 'warn'
      return 'muted'
    }

    function statusLabel(t, status) {
      if (status === 'ok') return t('statusOk')
      if (status === 'local') return t('statusLocal')
      if (status === 'unknown') return t('statusUnknown')
      if (status === 'incompatible') return t('statusIncompatible')
      if (status === 'missing') return t('statusMissing')
      if (status === 'core') return t('statusCore')
      return status
    }

    // ----------------------------------------------------------------- store
    // 一个极小的外部 store：设置页与全局弹窗共享同一份 /status 快照与任务进度。
    function createStore() {
      var state = {
        loading: true,
        offline: false,
        error: null,
        status: null,
        job: null,
        log: '',
        dismissed: false,
        checkedAt: 0,
        // 正在通过设置页的"重启 DSH"重启宿主：从这一刻起到宿主回来之前，
        // 页面会短暂连不上，回来之后自动刷新。
        restarting: false,
      }
      var listeners = new Set()
      var timer = null
      var inflight = false
      var bootChecked = false
      // 重启期间必须真的"看见过断开"再刷新，否则 POST 刚返回、宿主还没死就去刷新，
      // 会刷新到一个马上就要消失的页面。
      var sawOffline = false

      function emit() {
        var snapshot = state
        listeners.forEach(function (listener) {
          try {
            listener(snapshot)
          } catch (error) {
            /* 单个订阅者出错不能影响别人 */
          }
        })
      }

      function set(patch) {
        state = Object.assign({}, state, patch)
        emit()
      }

      function stopPolling() {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
      }

      function schedule(delay) {
        stopPolling()
        timer = setTimeout(function () {
          timer = null
          void refresh()
        }, delay)
      }

      function isLive(job) {
        return Boolean(job) && (job.status === 'running' || job.status === 'pending')
      }

      function pollJob() {
        // 必须按 id 查自己那个任务：不带 id 的 /job 在任务刚结束时会返回"最近一次"，
        // 而更早的实现在这段时间里会 404，前端就把本地的"正在执行"一直挂着。
        var id = state.job && state.job.id
        var path = id ? '/job?id=' + encodeURIComponent(id) : '/job'
        return request(path)
          .then(function (data) {
            set({ job: data.job || null, log: data.log || '', offline: false, loading: false })
            if (isLive(data.job)) {
              schedule(1200)
            } else {
              // 任务刚结束：重新取一次状态，把版本号/备份列表/插件结论刷新过来
              schedule(400)
            }
            return data
          })
          .catch(function (error) {
            if (error && error.status === 404) {
              // 记录没了（被清理或换过状态目录）：不能再显示"正在执行"
              set({ job: null, log: '', offline: false, loading: false })
              schedule(400)
              return null
            }
            throw error
          })
      }

      function refresh() {
        if (inflight) return Promise.resolve()
        inflight = true
        return request('/status')
          .then(function (data) {
            inflight = false
            var patch = {
              status: data,
              offline: false,
              loading: false,
              error: null,
              checkedAt: Date.now(),
            }
            var localLive = isLive(state.job)
            if (data.currentJob) {
              patch.job = data.currentJob
            } else if (!localLive && data.lastJob) {
              // 页面刷新/重新打开时恢复"最近一次任务"的结局，而不是显示空白
              patch.job = data.lastJob
            }
            set(patch)
            sawOffline = false
            if (state.restarting) {
              // 重启流程：宿主已经回来了，直接整页刷新拿新进程的下发内容
              try {
                window.location.reload()
              } catch (error) {
                /* 刷新不了就保持状态，用户自己按 F5 */
              }
              return null
            }
            // 服务端说还在跑 → 继续追；本地以为在跑但服务端没有进行中的任务（任务刚好收尾）
            // → 也要再追一次，把结局取回来。这两种情况缺一个，界面就会卡在"正在执行"。
            if (data.currentJob || localLive) return pollJob()
            return null
          })
          .catch(function (error) {
            inflight = false
            sawOffline = true
            set({ offline: true, loading: false, error: error.message })
            // 宿主可能正在被更新/回滚：一直重试，恢复后自动刷新
            schedule(2000)
            return null
          })
      }

      function check(force) {
        set({ loading: true, error: null })
        return request('/check' + (force ? '?force=1' : ''))
          .then(function (data) {
            set({ loading: false })
            return refresh().then(function () {
              return data
            })
          })
          .catch(function (error) {
            set({ loading: false, error: error.message })
            throw error
          })
      }

      function startUpdate(version) {
        return request('/update', { method: 'POST', body: { version: version } }).then(function (data) {
          set({ job: { id: data.job.id, status: 'running', phase: 'starting', steps: [], kind: 'update' } })
          schedule(600)
          return data
        })
      }

      function rollback(backupId) {
        return request('/rollback', { method: 'POST', body: { backupId: backupId } }).then(function (data) {
          set({ job: { id: data.job.id, status: 'running', phase: 'starting', steps: [], kind: 'rollback' } })
          schedule(600)
          return data
        })
      }

      function stopDsh() {
        return request('/stop', { method: 'POST', body: {} }).then(function (data) {
          set({
            error: null,
            restarting: false,
            job: { id: data.job.id, status: 'running', phase: 'starting', steps: [], kind: 'stop' },
          })
          schedule(800)
          return data
        })
      }

      function restartDsh() {
        return request('/restart', { method: 'POST', body: {} }).then(function (data) {
          sawOffline = false
          set({
            restarting: true,
            error: null,
            job: { id: data.job.id, status: 'running', phase: 'starting', steps: [], kind: 'restart' },
          })
          schedule(800)
          return data
        })
      }

      function saveSettings(patch) {
        return request('/settings', { method: 'POST', body: patch }).then(function (data) {
          return refresh().then(function () {
            return data
          })
        })
      }

      function skip(version) {
        return request('/skip', { method: 'POST', body: { version: version } }).then(function () {
          return refresh()
        })
      }

      function dismiss() {
        set({ dismissed: true })
      }

      function subscribe(listener) {
        listeners.add(listener)
        if (state.loading && listeners.size === 1) {
          // 每次打开网页：先拿状态，再按设置里的开关自动检查一次新版本。
          // 宿主侧有 checkIntervalHours 缓存兜底，这里不会真的每次都打 registry。
          void refresh().then(function () {
            if (bootChecked) return
            bootChecked = true
            var current = state.status
            if (!current) return
            var settings = (current.settings || {})
            if (settings.autoCheck === false) return
            void check(false).catch(function () {})
          })
        }
        return function () {
          listeners.delete(listener)
          if (listeners.size === 0) stopPolling()
        }
      }

      return {
        subscribe: subscribe,
        get: function () {
          return state
        },
        refresh: refresh,
        check: check,
        startUpdate: startUpdate,
        rollback: rollback,
        restartDsh: restartDsh,
        stopDsh: stopDsh,
        saveSettings: saveSettings,
        skip: skip,
        dismiss: dismiss,
        recheck: function () {
          return refresh()
        },
      }
    }

    function useStoreSlice(store, pick) {
      var pair = useState(store.get())
      var snapshot = pair[0]
      var setSnapshot = pair[1]
      useEffect(function () {
        return store.subscribe(function (next) {
          setSnapshot(Object.assign({}, next))
        })
      }, [store])
      return pick ? pick(snapshot) : snapshot
    }

    // ------------------------------------------------------------------ atoms
    var cardStyle = {
      background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-l2, #1c1d21))',
      border: '1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1, rgba(255,255,255,.09)))',
      borderRadius: '12px',
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    }

    var mutedText = {
      color: 'var(--dsw-alias-label-tertiary, rgba(235,235,245,.6))',
      fontSize: '12px',
      lineHeight: '1.5',
    }

    var secondaryText = {
      color: 'var(--dsw-alias-label-secondary, rgba(235,235,245,.75))',
      fontSize: '13px',
      lineHeight: '1.6',
    }

    var rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      flexWrap: 'wrap',
    }

    function Button(props) {
      var variant = props.variant || 'secondary'
      var disabled = Boolean(props.disabled)
      var base = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        height: '32px',
        padding: '0 14px',
        borderRadius: '8px',
        border: '1px solid ' + 'var(--dsw-alias-border-l1, rgba(255,255,255,.14))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #f5f5f7)',
        fontFamily: 'inherit',
        fontSize: '13px',
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background .15s ease, opacity .15s ease',
        whiteSpace: 'nowrap',
      }
      if (variant === 'primary') {
        // 不能用 --dsw-alias-button-primary-fill：本机主题下它解析成浅色，
        // 配白字等于白底白字（用户实测"看不清立即更新四个字"）。
        // 直接给一个饱和的深蓝 + 白字，任何主题下都够对比度。
        base.background = '#3d5afe'
        base.border = '1px solid #3451e6'
        base.color = '#ffffff'
        base.fontWeight = 600
        base.boxShadow = '0 1px 2px rgba(0,0,0,.28)'
      }
      if (variant === 'danger') {
        base.color = 'var(--dsw-alias-label-error, #ff6b6b)'
        base.border = '1px solid var(--dsw-alias-label-error, rgba(255,107,107,.5))'
      }
      if (variant === 'ghost') {
        base.border = '1px solid transparent'
        base.padding = '0 8px'
        base.height = '28px'
        base.color = 'var(--dsw-alias-label-secondary, rgba(235,235,245,.75))'
      }
      return h(
        'button',
        {
          type: 'button',
          disabled: disabled,
          title: props.title,
          style: Object.assign(base, props.style || {}),
          onMouseEnter: disabled
            ? undefined
            : (event) => {
                try {
                  event.currentTarget.style.background = variant === 'primary' ? '#2f4be0' : 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))'
                } catch {
                  // 拿不到 DOM 就算了
                }
              },
          onMouseLeave: disabled
            ? undefined
            : (event) => {
                try {
                  event.currentTarget.style.background = variant === 'primary' ? '#3d5afe' : 'transparent'
                } catch {
                  // 同上
                }
              },
          onClick: disabled ? undefined : props.onClick,
        },
        props.children,
      )
    }

    function Badge(props) {
      var tone = props.tone || 'muted'
      var colors = {
        success: ['var(--dsw-alias-state-success-primary, #3ecf8e)', 'rgba(62,207,142,.14)'],
        danger: ['var(--dsw-alias-label-error, #ff6b6b)', 'rgba(255,107,107,.14)'],
        warn: ['var(--dsw-alias-state-warn-primary, #f5a623)', 'rgba(245,166,35,.16)'],
        brand: ['var(--dsw-alias-brand-primary, #4d6bfe)', 'rgba(77,107,254,.16)'],
        muted: ['var(--dsw-alias-label-tertiary, rgba(235,235,245,.6))', 'rgba(255,255,255,.06)'],
      }
      var pair = colors[tone] || colors.muted
      return h(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '2px 8px',
            borderRadius: '999px',
            fontSize: '11px',
            fontWeight: 600,
            lineHeight: '18px',
            color: pair[0],
            background: pair[1],
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function ErrorNote(props) {
      if (!props.message) return null
      return h(
        'div',
        {
          style: {
            color: 'var(--dsw-alias-label-error, #ff6b6b)',
            fontSize: '12px',
            lineHeight: '1.5',
            wordBreak: 'break-word',
          },
        },
        props.message,
      )
    }

    function SectionTitle(props) {
      return h(
        'div',
        {
          style: {
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--dsw-alias-label-primary, #f5f5f7)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            justifyContent: 'space-between',
          },
        },
        h('span', null, props.children),
        props.extra || null,
      )
    }

    // ------------------------------------------------------------ banner body
    function UpdateBanner(props) {
      var t = props.t
      var store = props.store
      var snapshot = useStoreSlice(store)
      var status = snapshot.status
      var job = snapshot.job
      var visible = useMemo(function () {
        if (!status) return false
        if (snapshot.dismissed) return false
        var running = job && job.status === 'running'
        if (running) return true
        var check = status.lastCheck
        if (!check || !check.available) return false
        if (check.stale) return false
        if (check.skipped) return false
        // 已经是最新版本就别再弹了：缓存结论属于旧版本、或目标版本就是当前版本，都算过期。
        var installed = status.installation && status.installation.version
        if (installed && check.installedVersion && check.installedVersion !== installed) return false
        if (installed && check.targetVersion && check.targetVersion === installed) return false
        var dismissedUntil = Number(status.settings && status.settings.dismissUntil)
        if (Number.isFinite(dismissedUntil) && dismissedUntil > Date.now()) return false
        return Boolean(check.targetVersion)
      }, [status, job, snapshot.dismissed])

      if (!visible) return null
      var running = job && job.status === 'running'
      var done = job && job.status !== 'running'
      var target = job ? job.toVersion : status && status.lastCheck ? status.lastCheck.targetVersion : null
      var stepIndex = 0
      var total = job && job.steps ? job.steps.length : 0
      var phaseNote = ''
      if (snapshot.restarting && snapshot.offline) phaseNote = t('restartingHost')
      else if (running) {
        if (snapshot.offline) phaseNote = t('restartDuringWindow')
        else if (job.phase === 'restart' || job.phase === 'health') phaseNote = t('reconnecting')
        else phaseNote = t('windowHint')
      }
      if (job && job.steps) {
        job.steps.forEach(function (step) {
          if (step.status === 'ok' || step.status === 'skipped') stepIndex += 1
        })
      }

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            top: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 900,
            width: '420px',
            maxWidth: 'calc(100vw - 32px)',
            padding: '14px 16px',
            borderRadius: '14px',
            border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.12))',
            background: 'var(--dsw-alias-bg-overlay, rgba(28,29,33,.96))',
            boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.42))',
            color: 'var(--dsw-alias-label-primary, #f5f5f7)',
            fontFamily: 'var(--dsw-font-family, inherit)',
            fontSize: '13px',
            lineHeight: '1.55',
            pointerEvents: 'auto',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: '10px' } },
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            h(
              'div',
              { style: { fontWeight: 600, fontSize: '13px', marginBottom: '2px' } },
              running
                ? t('jobRunning') + (target ? ' → ' + target : '')
                : done && job.status === 'succeeded'
                  ? t('updatedTo') + ' ' + (job.toVersion || target || '')
                  : t('bannerTitle'),
            ),
            h(
              'div',
              { style: Object.assign({}, secondaryText, { fontSize: '12px' }) },
              running
                ? (job.phase === 'restart' || job.phase === 'health'
                    ? t('reconnecting')
                    : (job.steps || [])
                        .filter(function (step) {
                          return step.status === 'running'
                        })
                        .map(function (step) {
                          return t('step' + step.key.charAt(0).toUpperCase() + step.key.slice(1).replace(/-([a-z])/g, function (_, c) {
                            return c.toUpperCase()
                          }))
                        })
                        .join('') +
                      ' ' +
                      stepIndex +
                      '/' +
                      total)
                : done
                  ? t(job.status === 'failed' ? 'jobFailed' : job.status === 'rolled-back' ? 'jobRolledBack' : 'jobSucceeded') +
                    (job.error ? '：' + job.error : '')
                  : status.lastCheck.available
                    ? t('bannerReady') + ' ' + status.lastCheck.targetVersion + '（' + t('currentVersion') + ' ' + (status.installation ? status.installation.version : '') + '）'
                    : '',
            ),
            running && phaseNote
              ? h('div', { style: { marginTop: '6px', fontSize: '12px' } }, phaseNote)
              : null,
            running
              ? h(
                  'div',
                  {
                    style: {
                      marginTop: '4px',
                      fontSize: '12px',
                      color: 'var(--dsw-alias-state-warn-primary, #f2b544)',
                    },
                  },
                  t('windowCloseWarning'),
                )
              : null,
          ),
          h(
            Button,
            {
              variant: 'ghost',
              onClick: function () {
                if (done) {
                  store.dismiss()
                  void store.refresh()
                  return
                }
                if (running) return
                store.dismiss()
              },
              title: t('later'),
            },
            '×',
          ),
        ),
            running
              ? null
              : h(
                  'div',
                  { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
                  done
                    ? h(
                        Button,
                        {
                          variant: 'primary',
                          onClick: function () {
                            store.dismiss()
                            window.location.reload()
                          },
                        },
                        t('reloadNow'),
                      )
                    : h(
                        Button,
                        {
                          variant: 'primary',
                          onClick: function () {
                            if (!window.confirm(t('updateConfirm'))) return
                            void store.startUpdate(status.lastCheck.targetVersion).catch(function (error) {
                              window.alert(t('errorPrefix') + '：' + error.message)
                            })
                          },
                        },
                        t('updateNow'),
                      ),
              done
                ? null
                : h(
                    Button,
                    {
                      onClick: function () {
                        void store.skip(status.lastCheck.targetVersion).catch(function () {})
                        store.dismiss()
                      },
                    },
                    t('skipVersion'),
                  ),
              done
                ? null
                : h(
                    Button,
                    {
                      variant: 'ghost',
                      onClick: function () {
                        store.dismiss()
                      },
                    },
                    t('later'),
                  ),
            ),
      )
    }

    // ------------------------------------------------------------ settings tab
    function UpdateSettingsSection(props) {
      var t = props.t
      var store = props.store
      var snapshot = useStoreSlice(store)
      var status = snapshot.status
      var job = snapshot.job
      var logRef = useRef(null)
      var localErrorPair = useState(null)
      var localError = localErrorPair[0]
      var setLocalError = localErrorPair[1]
      var busyPair = useState('')
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var showLogPair = useState(false)
      var showLog = showLogPair[0]
      var setShowLog = showLogPair[1]
      var formPair = useState(null)
      var form = formPair[0]
      var setForm = formPair[1]

      // 插件结论单独取一次：/status 不塞整张表，避免轮询时反复扫 profile
      var pluginPair = useState({ target: '', list: [], summary: null, loaded: false, error: null })
      var pluginState = pluginPair[0]
      var setPluginState = pluginPair[1]
      var pluginTarget = (status && status.lastCheck && status.lastCheck.targetVersion) ||
        (status && status.installation && status.installation.version) ||
        ''

      var settings = status ? status.settings : null

      // 表单初值：跟随服务端设置，用户一旦改动就不再被轮询覆盖
      useEffect(function () {
        if (!settings || form !== null) return
        setForm({
          autoCheck: settings.autoCheck !== false,
          channel: settings.channel || 'auto',
          checkIntervalHours: settings.checkIntervalHours ?? 6,
          backupMode: settings.backupMode || 'full',
          keepBackups: settings.keepBackups ?? 2,
          registry: settings.registry || 'https://registry.npmjs.org',
        })
      }, [settings, form])

      useEffect(function () {
        if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
      }, [showLog, snapshot.log])

      useEffect(function () {
        if (!pluginTarget) return
        if (pluginState.loaded && pluginState.target === pluginTarget) return
        var cancelled = false
        request('/plugins?target=' + encodeURIComponent(pluginTarget))
          .then(function (data) {
            if (cancelled) return
            setPluginState({ target: pluginTarget, list: data.plugins || [], summary: data.summary || null, loaded: true, error: null })
          })
          .catch(function (error) {
            if (cancelled) return
            setPluginState({ target: pluginTarget, list: [], summary: null, loaded: true, error: error.message })
          })
        return function () {
          cancelled = true
        }
      }, [pluginTarget, pluginState.loaded, pluginState.target])

      if (snapshot.loading && !status) {
        return h('div', { style: Object.assign({}, cardStyle, { margin: '16px 0' }) }, t('checking'))
      }

      if (snapshot.offline && !status) {
        return h(
          'div',
          { style: Object.assign({}, cardStyle, { margin: '16px 0' }) },
          h('div', { style: secondaryText }, snapshot.error || t('loadFailed')),
          h(
            Button,
            {
              onClick: function () {
                void store.refresh()
              },
            },
            t('retry'),
          ),
        )
      }

      if (!status) return null

      var install = status.installation || {}
      var caps = status.capabilities || {}
      var lastCheck = status.lastCheck || null
      var updated = Boolean(lastCheck && lastCheck.available)
      var running = job && job.status === 'running'
      var pluginSummary = pluginState.summary || (status.plugins && status.plugins.summary)
      var plugins = pluginState.list || []
      var backups = status.backups || []
      var notes = status.notes || []

      var canUpdate = Boolean(caps.canSelfUpdate) && !running
      var blockReason = caps.electron ? t('electronBlocked') : !caps.writable ? t('unwritable') : !caps.npmCli ? t('noNpm') : ''

      function runCheck() {
        setBusy('check')
        setLocalError(null)
        void store
          .check(true)
          .catch(function (error) {
            setLocalError(error.message)
          })
          .then(function () {
            setBusy('')
          })
      }

      function doUpdate(version) {
        if (!window.confirm(t('updateConfirm'))) return
        setBusy('update')
        setLocalError(null)
        void store
          .startUpdate(version)
          .catch(function (error) {
            setLocalError(error.message)
          })
          .then(function () {
            setBusy('')
          })
      }

      function saveSettings() {
        if (!form) return
        setBusy('save')
        setLocalError(null)
        void store
          .saveSettings(form)
          .then(function () {
            setBusy('')
          })
          .catch(function (error) {
            setBusy('')
            setLocalError(error.message)
          })
      }

      function doRollback(backup) {
        if (!window.confirm(t('rollbackConfirm'))) return
        setBusy('rollback')
        setLocalError(null)
        void store
          .rollback(backup.id)
          .catch(function (error) {
            setLocalError(error.message)
          })
          .then(function () {
            setBusy('')
          })
      }

      function deleteBackup(backup) {
        if (!window.confirm(t('confirmDeleteBackup'))) return
        void request('/delete-backup', { method: 'POST', body: { id: backup.id } })
          .then(function () {
            return store.refresh()
          })
          .catch(function (error) {
            setLocalError(error.message)
          })
      }

      function syncPlugins() {
        setBusy('sync')
        setLocalError(null)
        void request('/sync-plugins', { method: 'POST', body: {} })
          .then(function () {
            return store.refresh()
          })
          .then(function () {
            setBusy('')
          })
          .catch(function (error) {
            setBusy('')
            setLocalError(error.message)
          })
      }

      function selectValue(key, value) {
        setForm(Object.assign({}, form, (function () {
          var patch = {}
          patch[key] = value
          return patch
        })()))
      }

      var stepLabel = function (step) {
        var name = step.key.replace(/-([a-z])/g, function (_, c) {
          return c.toUpperCase()
        })
        return t('step' + name.charAt(0).toUpperCase() + name.slice(1))
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0 24px' } },

        // ---- header: versions + primary actions
        h(
          'div',
          { style: cardStyle },
          h(
            'div',
            { style: rowStyle },
            h(
              'div',
              null,
              h('div', { style: { fontSize: '15px', fontWeight: 600 } }, t('title')),
              h('div', { style: mutedText }, t('subtitle')),
            ),
            h(
              Button,
              { onClick: runCheck, disabled: busy === 'check' || running },
              busy === 'check' || snapshot.loading ? t('checking') : t('checkNow'),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '28px', flexWrap: 'wrap', marginTop: '2px' } },
            h(
              'div',
              null,
              h('div', { style: mutedText }, t('currentVersion')),
              h(
                'div',
                { style: { fontSize: '20px', fontWeight: 700, letterSpacing: '.01em' } },
                install.version || '—',
                h(
                  'span',
                  { style: { marginLeft: '8px', verticalAlign: 'middle' } },
                  lastCheck && lastCheck.isPrerelease ? h(Badge, { tone: 'warn' }, 'pre-release') : null,
                ),
              ),
            ),
            h(
              'div',
              null,
              h('div', { style: mutedText }, t('latestVersion')),
              h(
                'div',
                { style: { fontSize: '20px', fontWeight: 700 } },
                lastCheck && lastCheck.targetVersion ? lastCheck.targetVersion : '—',
              ),
            ),
            h(
              'div',
              null,
              h('div', { style: mutedText }, t('channel')),
              h('div', { style: { fontSize: '13px', paddingTop: '6px' } }, lastCheck ? lastCheck.channel : settings ? settings.channel : '—'),
            ),
            h(
              'div',
              { style: { minWidth: '260px' } },
              h('div', { style: mutedText }, t('installPath')),
              h('div', { style: Object.assign({}, secondaryText, { wordBreak: 'break-all' }) }, install.dir || '—'),
            ),
          ),
          h(
            'div',
            { style: rowStyle },
            h(
              'div',
              { style: mutedText },
              lastCheck
                ? updated
                  ? t('updateAvailable') + '：' + lastCheck.targetVersion + (lastCheck.targetPublishedAt ? ' · ' + t('publishedAt') + ' ' + formatTime(lastCheck.targetPublishedAt) : '')
                  : t('upToDate') + ' · ' + formatTime(lastCheck.checkedAt)
                : t('noUpdateInfo'),
            ),
            updated && !running
              ? h(
                  'div',
                  { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                  h(Button, { variant: 'primary', disabled: !canUpdate || Boolean(busy), onClick: function () { doUpdate(lastCheck.targetVersion) } }, t('updateNow')),
                  h(
                    Button,
                    {
                      onClick: function () {
                        void store.skip(lastCheck.targetVersion).catch(function () {})
                      },
                    },
                    t('skipVersion'),
                  ),
                )
              : null,
          ),
          updated && !running ? h('div', { style: mutedText }, t('prereq') + ' · ' + t('restartWarning')) : null,
          blockReason ? h('div', { style: Object.assign({}, mutedText, { color: 'var(--dsw-alias-state-warn-primary, #f5a623)' }) }, t('cannotUpdate') + '：' + blockReason) : null,
          h(ErrorNote, { message: localError }),
          notes.length > 0 ? h('div', { style: mutedText }, notes.join('；')) : null,
        ),

        // ---- restart（重启宿主本身：不需要更新版本，也不会碰全局安装目录）
        h(
          'div',
          { style: cardStyle },
          h(
            'div',
            { style: rowStyle },
            h('div', { style: Object.assign({}, mutedText, { flex: '1 1 auto', minWidth: 0 }) }, t('restartHint') + ' ' + t('stopHint')),
            h(
              Button,
              {
                disabled: running || Boolean(busy),
                onClick: function () {
                  setLocalError(null)
                  setBusy('restart')
                  void store
                    .restartDsh()
                    .catch(function (error) {
                      setLocalError(error.message)
                    })
                    .then(function () {
                      setBusy('')
                    })
                },
              },
              t('restartDsh'),
            ),
            // 「停止 DSH」：Ctrl+C 不可靠或窗口找不到时的后路。走执行器的 stop-host（taskkill /T /F），
            // 与窗口形态无关，一定能停。
            h(
              Button,
              {
                disabled: running || Boolean(busy),
                onClick: function () {
                  setLocalError(null)
                  if (!window.confirm(t('stopConfirm'))) return
                  setBusy('stop')
                  void store
                    .stopDsh()
                    .catch(function (error) {
                      setLocalError(error.message)
                    })
                    .then(function () {
                      setBusy('')
                    })
                },
              },
              t('stopDsh'),
            ),
          ),
        ),

        // ---- job progress
        job
          ? h(
              'div',
              { style: cardStyle },
              h(
                'div',
                { style: rowStyle },
                h(
                  SectionTitle,
                  null,
                  t('jobTitle') +
                    ' · ' +
                    (job.status === 'running'
                      ? t('jobRunning')
                      : job.status === 'succeeded'
                        ? t('jobSucceeded')
                        : job.status === 'failed'
                          ? t('jobFailed')
                          : job.status === 'rolled-back'
                            ? t('jobRolledBack')
                            : t('jobCancelled')),
                ),
                h(
                  Button,
                  {
                    variant: 'ghost',
                    onClick: function () {
                      setShowLog(!showLog)
                    },
                  },
                  showLog ? t('hideLog') : t('showLog'),
                ),
              ),
              job.steps && job.steps.length > 0
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                    job.steps.map(function (step) {
                      var tone = step.status === 'ok' ? 'success' : step.status === 'failed' ? 'danger' : step.status === 'running' ? 'brand' : 'muted'
                      return h(
                        'div',
                        { key: step.key, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' } },
                        h(Badge, { tone: tone }, step.status === 'ok' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'running' ? '…' : '·'),
                        h('span', { style: secondaryText }, stepLabel(step)),
                        step.message ? h('span', { style: mutedText }, step.message) : null,
                      )
                    }),
                  )
                : null,
              job.error ? h(ErrorNote, { message: job.error }) : null,
              job.status !== 'running' && job.toVersion
                ? h(
                    Button,
                    {
                      variant: 'primary',
                      style: { alignSelf: 'flex-start' },
                      onClick: function () {
                        window.location.reload()
                      },
                    },
                    t('reloadNow'),
                  )
                : null,
              showLog
                ? h('pre', {
                    ref: logRef,
                    style: {
                      margin: 0,
                      maxHeight: '220px',
                      overflow: 'auto',
                      padding: '10px',
                      borderRadius: '8px',
                      background: 'var(--dsw-alias-bg-base, rgba(0,0,0,.28))',
                      color: 'var(--dsw-alias-label-secondary, rgba(235,235,245,.75))',
                      fontSize: '11px',
                      lineHeight: '1.55',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    },
                  }, snapshot.log || '—')
                : null,
            )
          : null,

        // ---- plugins
        h(
          'div',
          { style: cardStyle },
          h(
            SectionTitle,
            {
              extra: h(
                Button,
                {
                  onClick: syncPlugins,
                  disabled: Boolean(busy) || running || !caps.canSelfUpdate,
                  title: t('pluginsHint'),
                },
                busy === 'sync' ? t('jobRunning') : t('syncPlugins'),
              ),
            },
            t('plugins'),
          ),
          h('div', { style: mutedText }, t('pluginsHint')),
          pluginSummary
            ? h(
                'div',
                { style: mutedText },
                t('summaryOfPlugins')
                  .replace('%s', String(pluginSummary.userPlugins))
                  .replace('%s', String(pluginSummary.ok))
                  .replace('%s', String(pluginSummary.incompatible + pluginSummary.unknown + pluginSummary.missing)),
              )
            : null,
          plugins.length === 0
            ? h('div', { style: mutedText }, '—')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                plugins.map(function (plugin) {
                  return h(
                    'div',
                    {
                      key: plugin.name,
                      style: {
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0,1.2fr) auto minmax(0,2fr)',
                        gap: '10px',
                        alignItems: 'start',
                        padding: '6px 0',
                        borderTop: '1px solid var(--dsw-alias-separator-primary, rgba(255,255,255,.06))',
                      },
                    },
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h('div', { style: Object.assign({}, secondaryText, { wordBreak: 'break-all' }) }, plugin.name),
                      h('div', { style: mutedText }, plugin.version || '—'),
                    ),
                    h(Badge, { tone: statusTone(plugin.status) }, statusLabel(t, plugin.status)),
                    h(
                      'div',
                      { style: mutedText },
                      plugin.explanation || '—',
                      plugin.compatibleVersion ? h('div', { style: { marginTop: '2px' } }, t('compatibleVersion') + ' ' + plugin.compatibleVersion) : null,
                    ),
                  )
                }),
              ),
        ),

        // ---- activation（启动时没激活的插件：版本区间通不过看不出来的那类）
        (function () {
          var activation = status.activation || null
          if (!activation) return null
          var groups = activation.groups || []
          return h(
            'div',
            { style: cardStyle },
            h(SectionTitle, null, t('activationTitle')),
            h('div', { style: mutedText }, t('activationIntro')),
            groups.length === 0
              ? h('div', { style: mutedText }, t('activationNone'))
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' } },
                  groups.map(function (group) {
                    return h(
                      'div',
                      {
                        key: group.packageName,
                        style: Object.assign({}, rowStyle, {
                          borderTop: '1px solid var(--dsw-alias-separator-primary, rgba(255,255,255,.06))',
                          paddingTop: '8px',
                        }),
                      },
                      h(
                        'div',
                        { style: { minWidth: 0 } },
                        h(
                          'div',
                          { style: Object.assign({}, secondaryText, { wordBreak: 'break-all' }) },
                          group.packageName,
                        ),
                        h(
                          'div',
                          { style: mutedText },
                          (group.entries || []).map(function (entry) {
                            return entry.service
                              ? t('activationPending').replace('%s', entry.service)
                              : entry.reason === 'required'
                                ? t('activationRequired')
                                : t('activationFailed')
                          }).join(' / '),
                        ),
                      ),
                      h(Badge, { tone: 'warn' }, t('activationBadge')),
                    )
                  }),
                ),
            h(
              'div',
              { style: Object.assign({}, mutedText, { marginTop: '6px' }) },
              activation.summary || '',
            ),
          )
        })(),

        // ---- backups
        h(
          'div',
          { style: cardStyle },
          h(SectionTitle, null, t('backups')),
          h('div', { style: mutedText }, t('backupsHint')),
          backups.length === 0
            ? h('div', { style: mutedText }, t('noBackups'))
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                backups.map(function (backup) {
                  return h(
                    'div',
                    { key: backup.id, style: Object.assign({}, rowStyle, { borderTop: '1px solid var(--dsw-alias-separator-primary, rgba(255,255,255,.06))', paddingTop: '8px' }) },
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h(
                        'div',
                        { style: secondaryText },
                        backup.fromVersion || '—',
                        ' · ',
                        backup.mode === 'full' ? t('modeFull') : t('modeMetadata'),
                        backup.sizeBytes ? ' · ' + formatBytes(backup.sizeBytes) : '',
                      ),
                      h('div', { style: mutedText }, formatTime(backup.createdAt)),
                    ),
                    h(
                      'div',
                      { style: { display: 'flex', gap: '8px' } },
                      h(
                        Button,
                        {
                          disabled: running || Boolean(busy) || backup.mode !== 'full',
                          title: backup.mode === 'full' ? t('rollback') : t('backupMetadataHint'),
                          onClick: function () {
                            doRollback(backup)
                          },
                        },
                        t('rollback'),
                      ),
                      h(
                        Button,
                        {
                          variant: 'ghost',
                          disabled: running,
                          onClick: function () {
                            deleteBackup(backup)
                          },
                        },
                        t('delete'),
                      ),
                    ),
                  )
                }),
              ),
        ),

        // ---- recent jobs（更新/回滚的历史，尤其"窗口被关掉后自动回滚"的记录会出现在这里）
        h(
          'div',
          { style: cardStyle },
          h(SectionTitle, null, t('lastJobs')),
          !status || !status.jobs || status.jobs.length === 0
            ? h('div', { style: mutedText }, t('noJobs'))
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                status.jobs.slice(0, 6).map(function (entry) {
                  var kindLabel = entry.kind === 'rollback' ? t('kindRollback') : entry.kind === 'sync-plugins' ? t('kindSync') : entry.kind === 'stop' ? t('kindStop') : entry.kind === 'restart' ? t('kindRestart') : t('kindUpdate')
                  var stateLabel =
                    entry.status === 'succeeded'
                      ? t('jobSucceeded')
                      : entry.status === 'rolled-back'
                        ? t('jobRolledBack')
                        : entry.status === 'failed'
                          ? t('jobFailed')
                          : t('jobRunning')
                  var tone =
                    entry.status === 'succeeded' ? 'success' : entry.status === 'rolled-back' ? 'warn' : entry.status === 'failed' ? 'danger' : 'neutral'
                  return h(
                    'div',
                    { key: entry.id, style: Object.assign({}, rowStyle, { borderTop: '1px solid var(--dsw-alias-separator-primary, rgba(255,255,255,.06))', paddingTop: '8px' }) },
                    h(
                      'div',
                      { style: { minWidth: 0 } },
                      h(
                        'div',
                        { style: secondaryText },
                        kindLabel,
                        ' · ',
                        (entry.fromVersion || '—') + ' → ' + (entry.toVersion || '—'),
                      ),
                      h('div', { style: mutedText }, formatTime(entry.startedAt)),
                      entry.error ? h('div', { style: mutedText }, entry.error) : null,
                    ),
                    h(Badge, { tone: tone }, stateLabel),
                  )
                }),
              ),
        ),

        // ---- settings form
        settings && form
          ? h(
              'div',
              { style: cardStyle },
              h(SectionTitle, null, t('settings')),
              h(
                'label',
                { style: Object.assign({}, rowStyle, { justifyContent: 'flex-start' }) },
                h('input', {
                  type: 'checkbox',
                  checked: Boolean(form.autoCheck),
                  onChange: function (event) {
                    selectValue('autoCheck', event.target.checked)
                  },
                }),
                h(
                  'div',
                  null,
                  h('div', { style: secondaryText }, t('autoCheck')),
                  h('div', { style: mutedText }, t('autoCheckHint')),
                ),
              ),
              h(
                'div',
                { style: rowStyle },
                h('div', { style: secondaryText }, t('channel')),
                h(
                  'select',
                  {
                    value: form.channel,
                    onChange: function (event) {
                      selectValue('channel', event.target.value)
                    },
                    style: selectStyle,
                  },
                  h('option', { value: 'auto' }, t('channelAuto')),
                  h('option', { value: 'latest' }, t('channelLatest')),
                  h('option', { value: 'next' }, t('channelNext')),
                  h('option', { value: 'alpha' }, t('channelAlpha')),
                  h('option', { value: 'newest' }, t('channelNewest')),
                ),
              ),
              h(
                'div',
                { style: rowStyle },
                h('div', { style: secondaryText }, t('checkInterval')),
                h('input', {
                  type: 'number',
                  min: 0,
                  max: 168,
                  value: form.checkIntervalHours,
                  onChange: function (event) {
                    selectValue('checkIntervalHours', Number(event.target.value))
                  },
                  style: Object.assign({}, selectStyle, { width: '90px' }),
                }),
              ),
              h(
                'div',
                { style: rowStyle },
                h(
                  'div',
                  null,
                  h('div', { style: secondaryText }, t('backupModeSetting')),
                  h('div', { style: mutedText }, form.backupMode === 'full' ? t('backupFullHint') : t('backupMetadataHint')),
                ),
                h(
                  'select',
                  {
                    value: form.backupMode,
                    onChange: function (event) {
                      selectValue('backupMode', event.target.value)
                    },
                    style: selectStyle,
                  },
                  h('option', { value: 'full' }, t('modeFull')),
                  h('option', { value: 'metadata' }, t('modeMetadata')),
                ),
              ),
              h(
                'div',
                { style: rowStyle },
                h('div', { style: secondaryText }, t('keepBackups')),
                h('input', {
                  type: 'number',
                  min: 0,
                  max: 10,
                  value: form.keepBackups,
                  onChange: function (event) {
                    selectValue('keepBackups', Number(event.target.value))
                  },
                  style: Object.assign({}, selectStyle, { width: '90px' }),
                }),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { style: secondaryText }, t('registry')),
                h('input', {
                  type: 'text',
                  value: form.registry,
                  onChange: function (event) {
                    selectValue('registry', event.target.value)
                  },
                  style: Object.assign({}, selectStyle, { width: '100%' }),
                  spellCheck: false,
                }),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
                h(
                  Button,
                  { onClick: saveSettings, disabled: Boolean(busy) },
                  busy === 'save' ? t('saving') : t('save'),
                ),
                busy === 'save' ? h('span', { style: mutedText }, '…') : null,
              ),
            )
          : null,

        h('div', { style: Object.assign({}, mutedText, { marginTop: '2px' }) }, 'DSH ' + (install.version || '') + ' · ' + (status.profile ? status.profile.name : '') + ' · ' + (caps.platform || '') + '/' + (caps.arch || '')),
      )
    }

    var selectStyle = {
      height: '30px',
      padding: '0 8px',
      borderRadius: '8px',
      border: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.14))',
      background: 'var(--dsw-alias-bg-l1, rgba(255,255,255,.04))',
      color: 'var(--dsw-alias-label-primary, #f5f5f7)',
      fontFamily: 'inherit',
      fontSize: '13px',
    }

    // ------------------------------------------------------------------- entry
    var name = 'dsh-auto-update'
    var inject = ['slots', 'locale']

    function apply(ctx) {
      var store = createStore()
      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: zh, en: en })
        },
        'dsh-auto-update: locale dictionaries',
      )
      var t = ctx.locale.bind(NS)

      // 全局弹窗：打开网页后发现有新版就在这里提示（官方唯一推荐的帧级浮层座位）
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-auto-update-prompt',
            order: 80,
            locale: NS,
            inject: function () {
              return { t: t, store: store }
            },
          },
          UpdateBanner,
        )
      })

      // 设置页单独侧边栏
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-auto-update',
            order: 80,
            label: function () {
              return t('nav')
            },
            locale: NS,
            inject: function () {
              return { t: t, store: store }
            },
          },
          UpdateSettingsSection,
        )
      })
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    // 仅用于导出语言表（scripts/export-locales.mjs），运行时不读它
    exports.__locales = { zh: zh, en: en }

    return module.exports;
  },
});
