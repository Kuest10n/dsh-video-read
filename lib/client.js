/**
 * Browser half of dsh-video-read: one settings-panel section.
 *
 * Written as a prebuilt module-loader bundle on purpose: the plugin ships no
 * build step, so this file is loaded verbatim as a classic script and only
 * registers a lazy factory (the real module body runs when the shell
 * materializes this entry). The panel talks to the host routes registered by
 * lib/panel.js and renders with inline styles so it needs no UI kit.
 */
window.__ModuleLoader__.load({
  id: "dsh-video-read",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require("react")
    var h = React.createElement

    var API = "/api/dsh-video-read"

    var PHASES = {
      starting: "准备中",
      runtime: "准备运行环境",
      resolving: "解析来源",
      downloading: "下载视频",
      probing: "读取元数据",
      frames: "抽帧中",
      captions: "生成画面描述",
      danmaku: "拉取弹幕",
      done: "已完成",
      error: "失败",
    }

    var ERROR_HINTS = {
      E_FFMPEG_MISSING: "缺少 ffmpeg：安装到 PATH，或允许自动下载。",
      E_YTDLP_MISSING: "缺少 yt-dlp：安装一次，或允许自动下载（B站/本地不受影响）。",
      E_DISK_FULL: "磁盘空间不足以下载视频：清理空间、在面板清理过期缓存，或调低 maxMediaBytes。",
      E_NO_SUBTITLE: "这个视频没有可用字幕：画面本身正常，可改用 video_frames 看画面。",
      E_PRIVATE_URL: "链接指向内网/保留地址，已拒绝访问。",
      E_VIP_CONTENT: "B站没有返回可下载流：可能是付费/大会员内容，试试降低清晰度或用本地文件。",
      E_RISK_CONTROL: "触发B站风控(412)：用打开过 bilibili.com 的浏览器导出 cookie，配置 cookieFile 后重试。",
      E_NEEDS_COOKIE: "该请求需要登录：配置有效 cookieFile 后重试。",
      E_DRM: "该平台使用 DRM 保护，本插件不做破解；请使用你自己的本地副本。",
      E_TOO_LONG: "视频超过时长上限：调高 maxVideoMinutes，或使用本地剪辑文件。",
      E_PLAYLIST: "这是播放列表而非单个视频：请传入单个视频地址。",
      E_NO_SPRITE: "B站未提供关键帧拼图：改用 video_frames。",
      E_FILE_NOT_FOUND: "本地文件不存在：确认路径，或使用工作区相对路径。",
      E_DOWNLOAD: "下载失败或中断：稍后重试，或换一个来源。",
      E_SEGMENTED: "该视频被分段提供，暂不支持：稍后重试或使用本地文件。",
      E_BILIBILI_API: "B站接口返回错误：稍后重试。",
    }

    function errorHint(code) {
      if (!code) return ""
      return ERROR_HINTS[code] ? ERROR_HINTS[code] + "（" + code + "）" : String(code)
    }

    function fmtBytes(value) {
      var n = Number(value) || 0
      if (n < 1024) return n + " B"
      if (n < 1048576) return (n / 1024).toFixed(1) + " KB"
      if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB"
      return (n / 1073741824).toFixed(2) + " GB"
    }

    function fmtClock(iso) {
      if (!iso) return "—"
      try {
        return new Date(iso).toLocaleTimeString()
      } catch (error) {
        return String(iso)
      }
    }

    function card(children, extra) {
      return h("section", {
        style: Object.assign({
          background: COLORS.surface,
          border: "1px solid " + COLORS.border,
          borderRadius: 14,
          padding: 18,
          boxShadow: "0 8px 28px rgba(0,0,0,0.05)",
        }, extra || {}),
      }, children)
    }

    function sectionTitle(title, subtitle, right) {
      return h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 14 } },
        h("div", null,
          h("h3", { style: { margin: 0, fontSize: 14, lineHeight: 1.4, fontWeight: 650, color: COLORS.text } }, title),
          subtitle ? h("p", { style: { margin: "4px 0 0", fontSize: 12, lineHeight: 1.6, color: COLORS.muted } }, subtitle) : null,
        ),
        right || null,
      )
    }

    function badge(text, color) {
      return h("span", { style: {
        display: "inline-flex", alignItems: "center", padding: "3px 8px", borderRadius: 999,
        fontSize: 11, lineHeight: 1.3, fontWeight: 600, whiteSpace: "nowrap",
        color: color || COLORS.muted, background: COLORS.nested, border: "1px solid " + COLORS.border,
      } }, text)
    }

    function button(text, onClick, options) {
      var opts = options || {}
      // The settings dialog owns its top-right close (×). Some shells close on
      // any click that bubbles to the dialog chrome, which made our bottom
      // action buttons look like "close" buttons. Keep clicks local to us.
      function handleClick(event) {
        if (event && typeof event.stopPropagation === "function") event.stopPropagation()
        if (typeof onClick === "function") onClick(event)
      }
      return h("button", {
        type: "button", disabled: Boolean(opts.disabled), onClick: handleClick,
        "aria-label": opts.ariaLabel || text,
        style: {
          // Keep the label on one line: a narrow settings pane used to wrap
          // "保存设置" into two clipped lines, which made the primary button
          // look like an empty blue block. Inline-flex centering plus an
          // explicit line height also keeps short labels vertically centered.
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          whiteSpace: "nowrap", lineHeight: 1.25, minHeight: 36,
          padding: "8px 16px", fontSize: 12, fontWeight: 600, borderRadius: 8,
          cursor: opts.disabled ? "not-allowed" : "pointer", opacity: opts.disabled ? 0.55 : 1,
          border: "1px solid " + (opts.primary ? COLORS.accent : COLORS.borderStrong),
          background: opts.primary ? COLORS.accent : COLORS.nested,
          // The shell's --dsw-alias-bg-base token resolves to a dark colour in
          // dark themes; a literal white keeps the label legible on blue.
          color: opts.primary ? "#ffffff" : COLORS.text,
        },
      }, text)
    }

    function fieldLabel(text, htmlFor) {
      return h("label", { htmlFor: htmlFor, style: { display: "block", fontSize: 12, fontWeight: 550, color: COLORS.text, marginBottom: 6 } }, text)
    }

    function helpText(text) {
      return h("div", { style: { fontSize: 11, lineHeight: 1.55, color: COLORS.muted, marginTop: 5 } }, text)
    }

    function metric(label, value) {
      return h("div", { style: { minWidth: 0 } },
        h("div", { style: { fontSize: 11, color: COLORS.muted, marginBottom: 4 } }, label),
        h("div", { style: { fontSize: 20, lineHeight: 1.2, fontWeight: 650, fontVariantNumeric: "tabular-nums", color: COLORS.text } }, value),
      )
    }

    // Unsaved edits survive closing and reopening the settings window: the
    // draft is mirrored into localStorage on every keystroke and only cleared
    // by a successful save or an explicit discard. localStorage can be absent
    // or denied in sandboxed contexts, so every access is guarded.
    var DRAFT_KEY = "dsh-video-read.draft-config"
    function loadDraftEdits() {
      try {
        if (typeof localStorage === "undefined") return {}
        var raw = localStorage.getItem(DRAFT_KEY)
        if (!raw) return {}
        var parsed = JSON.parse(raw)
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
      } catch (error) {
        return {}
      }
    }
    function saveDraftEdits(edits) {
      try {
        if (typeof localStorage === "undefined") return
        localStorage.setItem(DRAFT_KEY, JSON.stringify(edits))
      } catch (error) { /* storage unavailable — draft stays in memory only */ }
    }
    function clearDraftEdits() {
      try {
        if (typeof localStorage === "undefined") return
        localStorage.removeItem(DRAFT_KEY)
      } catch (error) { /* same as above */ }
    }
    var COLORS = {
      surface: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.07))",
      nested: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.1))",
      border: "var(--dsw-alias-border-l1, rgba(127,127,127,0.22))",
      borderStrong: "var(--dsw-alias-border-l2, rgba(127,127,127,0.4))",
      text: "var(--dsw-alias-label-primary, inherit)",
      muted: "var(--dsw-alias-label-secondary, rgba(127,127,127,0.7))",
      accent: "var(--dsw-alias-brand-primary, #4d8dff)",
      error: "var(--dsw-alias-state-error-primary, #e5484d)",
      success: "var(--dsw-alias-state-success-primary, #30a46c)",
      warning: "var(--dsw-alias-state-warn-primary, #f5a623)",
    }
    var MONO = "ui-monospace, SFMono-Regular, Consolas, monospace"
    var DEFAULTS = {
      maxFrames: 32, maxVideoMinutes: 180, imageWidth: 1280, quality: 3, bilibiliQuality: 64,
      captionModel: "", autoDownloadFfmpeg: true, autoDownloadYtdlp: true,
      burnTimestamps: true, keepSource: true,
    }

    var TEXT_FIELDS = [
      { key: "maxFrames", label: "单次帧数上限", kind: "int", min: 1, max: 32, step: 1, help: "默认 32；grid 联系表可用一张图覆盖多帧，省 token。" },
      { key: "imageWidth", label: "单帧宽度", kind: "int", min: 320, max: 2560, step: 32, help: "默认 1280px；细节不足时先局部补帧，不要盲目拉满。" },
      { key: "quality", label: "JPEG 质量", kind: "int", min: 1, max: 51, step: 1, help: "ffmpeg qscale；默认 3（越小越清晰，数值并非百分制）。" },
      { key: "bilibiliQuality", label: "B站下载清晰度", kind: "int", min: 16, max: 120, step: 16, help: "B站 qn：16=360p、32=480p、64=720p；高清晰度受账号和权限限制。" },
      { key: "maxVideoMinutes", label: "视频时长上限", kind: "number", min: 1, max: 600, step: 1, help: "超过即拒绝下载，防止误抓超长文件；默认 180 分钟。" },
      { key: "captionModel", label: "视觉描述模型", kind: "string", help: "留空使用当前视觉路由；纯文本模型可另选图文模型生成描述。" },
    ]

    var BOOL_FIELDS = [
      { key: "burnTimestamps", label: "联系表烧录时间戳", help: "每格显示相对时间，帮助模型按故事顺序理解。" },
      { key: "autoDownloadFfmpeg", label: "自动准备 ffmpeg", help: "首次使用从可信包源下载并校验；B站/本地视频也需要。" },
      { key: "autoDownloadYtdlp", label: "自动准备 yt-dlp", help: "YouTube 等通用网页视频需要；B站原生链路不依赖它。" },
      { key: "keepSource", label: "保留源视频缓存", help: "复用同一视频可避免重复下载；关闭仅影响新下载。" },
    ]

    function usePanelState() {
      var pair = React.useState({ status: "loading", data: null, error: null, stale: false })
      var state = pair[0]
      var setState = pair[1]
      React.useEffect(function () {
        var alive = true
        var inFlight = false
        var timer = null
        // Adaptive cadence: a running task deserves a live-feeling 2s poll;
        // an idle panel only needs a heartbeat refresh every 15s.
        var IDLE_MS = 15000
        var ACTIVE_MS = 2000
        function isRunning(value) {
          var progress = value && value.data && value.data.progress
          return Boolean(progress && !progress.done)
        }
        function schedule() {
          if (timer) clearInterval(timer)
          timer = setInterval(load, isRunning(latest) ? ACTIVE_MS : IDLE_MS)
        }
        var latest = null
        function load() {
          if (inFlight || (typeof document !== "undefined" && document.visibilityState === "hidden")) return
          inFlight = true
          fetch(API + "/panel", { headers: { accept: "application/json" } })
            .then(function (response) {
              if (!response.ok) throw new Error("HTTP " + response.status)
              return response.json()
            })
            .then(function (json) {
              if (!alive) return
              latest = { status: "ready", data: json, error: null, stale: false }
              setState(latest)
              schedule()
            })
            .catch(function (error) {
              if (!alive) return
              setState(function (previous) {
                if (previous.status === "ready") return Object.assign({}, previous, { stale: true })
                return { status: "error", data: null, error: String((error && error.message) || error), stale: false }
              })
            })
            .then(function () { inFlight = false })
        }
        function visibility() {
          if (typeof document !== "undefined" && document.visibilityState === "visible") load()
        }
        load()
        schedule()
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility)
        return function () {
          alive = false
          if (timer) clearInterval(timer)
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility)
        }
      }, [])
      return state
    }

    function VideoReadPanel() {
      var state = usePanelState()
      var editsPair = React.useState(loadDraftEdits)
      var edits = editsPair[0]
      var setEdits = editsPair[1]
      var msgPair = React.useState("")
      var message = msgPair[0]
      var setMessage = msgPair[1]
      var savingPair = React.useState(false)
      var saving = savingPair[0]
      var setSaving = savingPair[1]

      var cleaningPair = React.useState(false)
      var cleaning = cleaningPair[0]
      var setCleaning = cleaningPair[1]
      var prunePair = React.useState(null)
      var prunePreview = prunePair[0]
      var setPrunePreview = prunePair[1]
      var noticePair = React.useState({ text: "", tone: "muted" })
      var notice = noticePair[0]
      var setNotice = noticePair[1]

      if (state.status === "loading") {
        return h("div", { style: { padding: 24, color: COLORS.muted, fontSize: 13 }, role: "status" }, "正在连接 Video Reader…")
      }
      if (state.status === "error") {
        return h("div", { style: { padding: 18, color: COLORS.text } },
          h("div", { style: { color: COLORS.error, marginBottom: 8, fontWeight: 600 }, role: "alert" }, "面板接口不可用：" + state.error),
          h("p", { style: { color: COLORS.muted, lineHeight: 1.7 } }, "请确认 Web Host 已加载 dsh-video-read。首次安装或更新客户端后，重启 Host 再刷新页面。"),
        )
      }

      var data = state.data
      var config = data.config || {}
      var progress = data.progress
      var cache = data.cache || { dirs: [] }
      var workspace = data.workspaceCache || { dirs: [], totalBytes: 0, staleBytes: 0 }
      var percent =
        progress && progress.totalBytes > 0
          ? Math.max(0, Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100)))
          : null

      function currentValue(key) {
        return Object.prototype.hasOwnProperty.call(edits, key) ? edits[key] : config[key]
      }

      function setField(key, value) {
        setEdits(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          saveDraftEdits(next)
          return next
        })
      }

      function validateField(key, value) {
        if (value === "" || value === undefined || value === null) return null
        var spec = null
        for (var i = 0; i < TEXT_FIELDS.length; i += 1) if (TEXT_FIELDS[i].key === key) spec = TEXT_FIELDS[i]
        if (!spec || spec.kind === "string") return null
        var num = Number(value)
        if (!Number.isFinite(num)) return "需要数字"
        if (spec.min !== undefined && num < spec.min) return "最小值 " + spec.min
        if (spec.max !== undefined && num > spec.max) return "最大值 " + spec.max
        return null
      }

      function fieldErrors() {
        var errors = {}
        for (var key in edits) {
          var problem = validateField(key, edits[key])
          if (problem) errors[key] = problem
        }
        return errors
      }

      function save() {
        var keys = Object.keys(edits)
        if (!keys.length) {
          setMessage("没有修改")
          return
        }
        var errors = fieldErrors()
        var errorKeys = Object.keys(errors)
        if (errorKeys.length) {
          setMessage("请先修正 " + errorKeys.length + " 个字段的取值")
          return
        }
        setSaving(true)
        setMessage("")
        fetch(API + "/config", {
          method: "POST",
          headers: { "content-type": "application/json", "x-dsh-video-read-client": "1" },
          body: JSON.stringify({ config: edits }),
        })
          .then(function (response) {
            return response.json().then(function (json) {
              return { ok: response.ok, json: json }
            })
          })
          .then(function (result) {
            setSaving(false)
            if (result.ok && result.json && result.json.ok) {
              setEdits({})
              clearDraftEdits()
              setMessage("已保存 " + Object.keys(result.json.saved || {}).join(", ") + "；工具立即生效")
            } else {
              var detail =
                (result.json && (result.json.error || (result.json.errors || []).join("; "))) || "未知错误"
              setMessage("保存失败：" + detail)
              if (typeof document !== "undefined") {
                var first = document.getElementById("video-read-" + keys[0])
                if (first && first.focus) first.focus()
              }
            }
          })
          .catch(function (error) {
            setSaving(false)
            setMessage("网络错误：" + String((error && error.message) || error))
          })
      }

      function reset() {
        setEdits(DEFAULTS)
        saveDraftEdits(DEFAULTS)
        setMessage("")
        setNotice({ text: "已填入推荐默认值，点击“保存设置”后生效。", tone: "muted" })
      }

      function pruneStale() {
        if (cleaning) return
        var trigger = typeof document !== "undefined" && document.activeElement ? document.activeElement : null
        setCleaning(true)
        setPrunePreview(null)
        setNotice({ text: "正在预览过期产物…", tone: "muted" })
        fetch(API + "/cache", {
          method: "POST", headers: { "content-type": "application/json", "x-dsh-video-read-client": "1" },
          body: JSON.stringify({ action: "prune-stale", dryRun: true }),
        }).then(function (response) {
          return response.json().then(function (json) { return { ok: response.ok, json: json } })
        }).then(function (result) {
          if (!result.ok || !result.json || !result.json.ok) throw new Error((result.json && result.json.error) || "HTTP 错误")
          var preview = result.json
          setPrunePreview(preview)
          if (!preview.removedCount) {
            setNotice({ text: "没有超过保留期的视频产物。", tone: "success" })
            setCleaning(false)
            return null
          }
          var confirmed = false
          if (typeof window !== "undefined" && window.confirm) {
            confirmed = window.confirm("将删除 " + preview.removedCount + " 个目录，共 " + fmtBytes(preview.removedBytes) + "，保留期为 " + (workspace.ttlDays || 14) + " 天。此操作不可撤销，是否继续？")
          } else {
            confirmed = true
          }
          if (!confirmed) {
            setCleaning(false)
            setNotice({ text: "已取消，未删除任何内容。", tone: "muted" })
            if (trigger && trigger.focus) trigger.focus()
            return null
          }
          setNotice({ text: "正在清理过期产物…", tone: "muted" })
          return fetch(API + "/cache", {
            method: "POST", headers: { "content-type": "application/json", "x-dsh-video-read-client": "1" },
            body: JSON.stringify({ action: "prune-stale", dryRun: false, confirm: "PRUNE_STALE" }),
          }).then(function (response) {
            return response.json().then(function (json) { return { ok: response.ok, json: json } })
          })
        }).then(function (result) {
          if (!result) return
          if (!result.ok || !result.json || !result.json.ok) throw new Error((result.json && result.json.error) || "HTTP 错误")
          setNotice({ text: "已清理 " + result.json.removedCount + " 项，释放 " + fmtBytes(result.json.removedBytes) + "。", tone: "success" })
          setPrunePreview(null)
        }).catch(function (error) {
          setNotice({ text: "清理失败：" + String((error && error.message) || error), tone: "error" })
        }).then(function () {
          setCleaning(false)
          if (trigger && trigger.focus) trigger.focus()
        })
      }
      function statusSection() {
        var children = [
          sectionTitle("运行状态", "下载、解析、抽帧和画面描述的最近进度。"),
        ]
        if (!progress) {
          children.push(h("div", { key: "empty", style: { padding: "18px 0", fontSize: 12, color: COLORS.muted } }, "还没有读取记录。把一个 B站链接交给 Agent，先说“总结这个视频”，即可开始。"))
        } else {
          var phaseText = PHASES[progress.phase] || progress.phase || "—"
          var tone = progress.error ? COLORS.error : progress.done ? COLORS.success : COLORS.accent
          var displayName = progress.title || progress.source || "未命名来源"
          children.push(h("div", { key: "row", style: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" } },
            h("div", { style: { minWidth: 0, flex: 1 } },
              h("div", { title: progress.source || "", style: { fontSize: 13, fontWeight: 550, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, displayName),
              h("div", { style: { color: COLORS.muted, fontSize: 11, marginTop: 6, lineHeight: 1.6 } }, (progress.detail || "处理中") + (progress.frames ? " · " + progress.frames + " 帧" : "") + " · " + fmtClock(progress.startedAt)),
            ),
            badge(phaseText, tone),
          ))
          // Progress shows only known facts: a determinate bar when a byte
          // total exists, an indeterminate bar while running, nothing fake.
          // Respect prefers-reduced-motion by dropping the fill transition.
          var reducedMotion =
            typeof window !== "undefined" && window.matchMedia
              ? Boolean(window.matchMedia("(prefers-reduced-motion: reduce)").matches)
              : false
          var barChildren =
            percent === null
              ? progress.done
                ? [h("div", { key: "full", style: { width: "100%", height: "100%", background: tone } })]
                : [h("div", { key: "indeterminate", style: { width: "34%", height: "100%", background: tone, opacity: 0.55 } })]
              : [h("div", { key: "fill", style: { width: percent + "%", height: "100%", background: tone, transition: reducedMotion ? "none" : "width .3s ease" } })]
          children.push(h("div", {
            key: "bar", role: "progressbar",
            "aria-label": phaseText + "进度",
            "aria-valuemin": 0, "aria-valuemax": 100,
            "aria-valuenow": percent === null ? undefined : percent,
            "aria-valuetext": percent === null ? undefined : percent + "% · " + phaseText,
            style: { height: 7, borderRadius: 99, background: COLORS.nested, overflow: "hidden", marginTop: 14 },
          }, barChildren))
          children.push(h("div", { key: "bytes", style: { display: "flex", justifyContent: "space-between", marginTop: 7, color: COLORS.muted, fontSize: 11 } },
            h("span", null, progress.bytes ? fmtBytes(progress.bytes) + (progress.totalBytes ? " / " + fmtBytes(progress.totalBytes) : "") : "等待可计量的进度"),
            percent === null ? null : h("span", null, percent + "%"),
          ))
          if (progress.error) {
            children.push(h("div", { key: "error", role: "alert", style: { color: COLORS.error, fontSize: 12, lineHeight: 1.6, marginTop: 10 } },
              progress.error,
              progress.errorCode ? h("div", { style: { marginTop: 6, fontSize: 11, color: COLORS.muted } }, errorHint(progress.errorCode)) : null,
            ))
          }
          if (progress.artifactsDir) children.push(h("code", { key: "dir", style: { display: "block", fontFamily: MONO, fontSize: 10, color: COLORS.muted, marginTop: 12, wordBreak: "break-all" } }, progress.artifactsDir))
        }
        return card(children)
      }

      function guideSection() {
        function step(number, title, text) {
          return h("div", { style: { display: "flex", gap: 12, alignItems: "flex-start" } },
            h("span", { style: { width: 24, height: 24, flex: "0 0 24px", display: "grid", placeItems: "center", borderRadius: "50%", background: COLORS.nested, color: COLORS.accent, fontSize: 11, fontWeight: 700 } }, number),
            h("div", null,
              h("div", { style: { fontSize: 12, fontWeight: 600 } }, title),
              h("div", { style: { fontSize: 11, color: COLORS.muted, lineHeight: 1.6, marginTop: 3 } }, text),
            ),
          )
        }
        return card([
          sectionTitle("三步开始", "无需在这里粘贴视频；直接把链接或本地路径交给 Agent。"),
          h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 18 } }, [
            step("1", "说一句自然语言", "“总结这个视频：https://www.bilibili.com/video/BV…”"),
            step("2", "先看文本，再看画面", "长视频先读字幕时间轴，再按问题定位关键帧，避免整段灌图。"),
            step("3", "追问具体时刻", "“看看 02:15 的画面”或“人物什么时候出现？”Agent 会局部补帧。"),
          ]),
        ])
      }

      function configSection() {
        var groups = [
          { legend: "阅读预算", fields: ["maxFrames", "imageWidth", "quality", "maxVideoMinutes"] },
          { legend: "下载与辅助模型", fields: ["bilibiliQuality", "autoDownloadFfmpeg", "autoDownloadYtdlp", "captionModel"] },
          { legend: "产物与缓存", fields: ["burnTimestamps", "keepSource"] },
        ]
        var byKey = {}
        for (var t = 0; t < TEXT_FIELDS.length; t += 1) byKey[TEXT_FIELDS[t].key] = Object.assign({ kind: "text" }, TEXT_FIELDS[t])
        for (var b = 0; b < BOOL_FIELDS.length; b += 1) byKey[BOOL_FIELDS[b].key] = Object.assign({ kind: "bool" }, BOOL_FIELDS[b])
        var groupNodes = []
        for (var g = 0; g < groups.length; g += 1) {
          var group = groups[g]
          var fieldNodes = []
          for (var f = 0; f < group.fields.length; f += 1) {
            var spec = byKey[group.fields[f]]
            if (!spec) continue
            if (spec.kind === "bool") {
              fieldNodes.push(
                h("label", { key: spec.key, style: { display: "flex", alignItems: "flex-start", gap: 9, fontSize: 12, fontWeight: 550, cursor: "pointer", padding: "8px 0", minHeight: 24 } },
                  h("input", {
                    type: "checkbox",
                    "aria-label": spec.label,
                    "aria-describedby": "video-read-help-" + spec.key,
                    checked: Boolean(currentValue(spec.key)),
                    onChange: function (event) { setField(spec.key, event.target.checked) },
                    style: { width: 16, height: 16, minHeight: 24, minWidth: 24, marginTop: 0, accentColor: COLORS.accent },
                  }),
                  h("span", null,
                    spec.label,
                    h("span", { id: "video-read-help-" + spec.key, style: { display: "block", fontSize: 11, lineHeight: 1.55, color: COLORS.muted, marginTop: 3, fontWeight: 400 } }, spec.help),
                  ),
                ),
              )
            } else {
              var fieldProblem = validateField(spec.key, currentValue(spec.key))
              fieldNodes.push(
                h("div", { key: spec.key, style: { marginBottom: 12 } },
                  fieldLabel(spec.label, "video-read-" + spec.key),
                  h("input", {
                    id: "video-read-" + spec.key,
                    "aria-label": spec.label,
                    "aria-describedby": "video-read-help-" + spec.key + (fieldProblem ? " video-read-error-" + spec.key : ""),
                    "aria-invalid": fieldProblem ? true : undefined,
                    min: spec.min, max: spec.max, step: spec.step,
                    type: spec.kind === "string" ? "text" : "number",
                    value: currentValue(spec.key) === undefined || currentValue(spec.key) === null ? "" : String(currentValue(spec.key)),
                    onChange: function (event) {
                      var raw = event.target.value
                      setField(spec.key, spec.kind === "string" ? raw : raw === "" ? "" : Number(raw))
                    },
                    style: {
                      width: "100%", boxSizing: "border-box", padding: "8px 10px", fontSize: 12, borderRadius: 8,
                      border: "1px solid " + (fieldProblem ? COLORS.error : COLORS.border),
                      background: COLORS.nested,
                      color: COLORS.text,
                      outlineColor: COLORS.accent,
                    },
                  }),
                  fieldProblem
                    ? h("div", { id: "video-read-error-" + spec.key, role: "alert", style: { fontSize: 11, color: COLORS.error, marginTop: 5 } }, spec.label + "：" + fieldProblem)
                    : null,
                  h("div", { id: "video-read-help-" + spec.key, style: { fontSize: 11, lineHeight: 1.55, color: COLORS.muted, marginTop: 5 } }, spec.help),
                ),
              )
            }
          }
          groupNodes.push(
            h("fieldset", { key: group.legend, style: { border: "none", padding: 0, margin: 0, minWidth: 0 } },
              h("legend", { style: { padding: 0, fontSize: 12, fontWeight: 650, color: COLORS.text, marginBottom: 10 } }, group.legend),
              h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "2px 22px" } }, fieldNodes),
            ),
          )
        }
        var hasEdits = Object.keys(edits).length > 0
        var invalidCount = Object.keys(fieldErrors()).length
        return card([
          sectionTitle("阅读设置", "默认值优先控制 token 和下载成本；修改后新工具调用立即生效。"),
          h("div", { key: "groups", style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "18px 24px" } }, groupNodes),
          h("div", { key: "actions", style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 16, paddingTop: 12, borderTop: "1px solid " + COLORS.border } },
            button(saving ? "保存中…" : "保存设置", save, { primary: true, disabled: saving || !hasEdits || invalidCount > 0 }),
            button("填入推荐值", reset, { disabled: saving }),
            hasEdits ? button("放弃未保存修改", function () { setEdits({}); clearDraftEdits(); setMessage("") }, { disabled: saving }) : null,
            message ? h("span", { role: "status", "aria-live": "polite", style: { fontSize: 11, color: message.indexOf("失败") >= 0 || message.indexOf("修正") >= 0 ? COLORS.error : COLORS.muted } }, message) : null,
          ),
          h("div", { key: "note", style: { fontSize: 11, color: COLORS.muted, marginTop: 12, wordBreak: "break-all" } },
            "设置保存在 " + (cache.settingsPath || "settings.json") + "。Cookie 等敏感路径不放入网页表单。"),
        ])
      }

      function cacheSection() {
        return card([
          sectionTitle("缓存与成本", "区分全局运行时与工作区视频产物；只清理明确过期的内容。",
            button(cleaning ? "清理中…" : "清理过期视频", pruneStale, { disabled: cleaning || !(workspace.staleBytes > 0) })),
          h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 18, marginBottom: 16 } }, [
            metric("视频产物", fmtBytes(workspace.totalBytes || 0)),
            metric("可清理", fmtBytes(workspace.staleBytes || 0)),
            metric("全局运行时", fmtBytes(cache.totalBytes || 0)),
          ]),
          h("p", { style: { margin: "0 0 12px", fontSize: 11, lineHeight: 1.65, color: COLORS.muted } },
            "视频产物保留期 " + (workspace.ttlDays || 14) + " 天；全局缓存主要是 ffmpeg / yt-dlp，不按视频 TTL 删除。工作区统计：" + (workspace.rootDir || "尚无")),
          h("div", { style: { fontSize: 11, color: COLORS.muted } }, "包含 " + (workspace.dirCount || 0) + " 个视频目录；未过期文件不会被清理。"),
        ])
      }

      return h("main", { style: { maxWidth: 980, margin: "0 auto", padding: "4px 2px 28px", fontSize: 13, color: COLORS.text, lineHeight: 1.5 } }, [
        h("header", { key: "head", style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 18 } },
          h("div", null,
            h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
              h("h2", { style: { margin: 0, fontSize: 22, lineHeight: 1.3, fontWeight: 680, letterSpacing: "-0.02em" } }, "Video Reader"),
              badge("v" + (data.version || "?"), COLORS.accent),
            ),
            h("p", { style: { margin: "6px 0 0", fontSize: 12, color: COLORS.muted } }, "把视频变成可追问、可定位、可复核的时间轴证据。"),
          ),
          state.stale ? badge("连接中断 · 显示旧数据", COLORS.warning) : badge("本地运行", COLORS.success),
        ),
        // Always-mounted live region: screen readers announce text reliably
        // when the node persists and only its content changes (W3C status
        // messages), so never mount/unmount the notice itself.
        h("div", {
          key: "notice",
          role: "status",
          "aria-live": "polite",
          style: {
            marginBottom: 12, padding: notice.text ? "10px 12px" : 0,
            borderRadius: 8, background: COLORS.nested,
            color: notice.tone === "error" ? COLORS.error : notice.tone === "success" ? COLORS.success : COLORS.muted,
            fontSize: 12,
            visibility: notice.text ? "visible" : "hidden",
          },
        }, notice.text || "\u00a0"),
        h("div", { key: "guide", style: { marginBottom: 14 } }, guideSection()),
        h("div", { key: "status", style: { marginBottom: 14 } }, statusSection()),
        h("div", { key: "config", style: { marginBottom: 14 } }, configSection()),
        h("div", { key: "cache" }, cacheSection()),
      ])
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        try {
          return ctx.slots.register(
            {
              name: "settings.section",
              id: "dsh-video-read",
              order: 140,
              label: function () {
                return "Video Reader"
              },
            },
            VideoReadPanel,
          )
        } catch (error) {
          return function () {}
        }
      })
    }

    exports.name = "dsh-video-read-panel"
    exports.inject = ["slots"]
    exports.apply = apply
    return module.exports
  },
})
