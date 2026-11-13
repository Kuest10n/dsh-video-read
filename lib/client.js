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
      resolving: "解析来源",
      downloading: "下载视频",
      probing: "读取元数据",
      frames: "抽帧中",
      captions: "生成画面描述",
      danmaku: "拉取弹幕",
      done: "已完成",
      error: "失败",
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
      return h("button", {
        type: "button", disabled: Boolean(opts.disabled), onClick: onClick,
        "aria-label": opts.ariaLabel || text,
        style: {
          minHeight: 34, padding: "7px 14px", fontSize: 12, fontWeight: 600, borderRadius: 8,
          cursor: opts.disabled ? "not-allowed" : "pointer", opacity: opts.disabled ? 0.55 : 1,
          border: "1px solid " + (opts.primary ? COLORS.accent : COLORS.borderStrong),
          background: opts.primary ? COLORS.accent : COLORS.nested,
          color: opts.primary ? "var(--dsw-alias-bg-base, #fff)" : COLORS.text,
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
      maxFrames: 32, maxVideoMinutes: 180, imageWidth: 1280, quality: 3,
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
        function load() {
          if (inFlight || (typeof document !== "undefined" && document.visibilityState === "hidden")) return
          inFlight = true
          fetch(API + "/panel", { headers: { accept: "application/json" } })
            .then(function (response) {
              if (!response.ok) throw new Error("HTTP " + response.status)
              return response.json()
            })
            .then(function (json) {
              if (alive) setState({ status: "ready", data: json, error: null, stale: false })
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
        timer = setInterval(load, 4000)
        if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility)
        return function () {
          alive = false
          clearInterval(timer)
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility)
        }
      }, [])
      return state
    }

    function VideoReadPanel() {
      var state = usePanelState()
      var editsPair = React.useState({})
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
          return next
        })
      }

      function save() {
        var keys = Object.keys(edits)
        if (!keys.length) {
          setMessage("没有修改")
          return
        }
        setSaving(true)
        setMessage("")
        fetch(API + "/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
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
              setMessage("已保存 " + Object.keys(result.json.saved || {}).join(", ") + "；工具立即生效")
            } else {
              var detail =
                (result.json && (result.json.error || (result.json.errors || []).join("; "))) || "未知错误"
              setMessage("保存失败：" + detail)
            }
          })
          .catch(function (error) {
            setSaving(false)
            setMessage("网络错误：" + String((error && error.message) || error))
          })
      }

      function reset() {
        setEdits(DEFAULTS)
        setMessage("")
        setNotice({ text: "已填入推荐默认值，点击“保存设置”后生效。", tone: "muted" })
      }

      function pruneStale() {
        if (cleaning) return
        setCleaning(true)
        setPrunePreview(null)
        setNotice({ text: "正在预览过期产物…", tone: "muted" })
        fetch(API + "/cache", {
          method: "POST", headers: { "content-type": "application/json" },
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
          if (typeof window !== "undefined" && window.confirm) {
            var ok = window.confirm("将删除 " + preview.removedCount + " 个目录，共 " + fmtBytes(preview.removedBytes) + "，保留期为 " + (workspace.ttlDays || 14) + " 天。此操作不可撤销，是否继续？")
            if (!ok) { setCleaning(false); setNotice({ text: "已取消，未删除任何内容。", tone: "muted" }); return null }
          }
          setNotice({ text: "正在清理过期产物…", tone: "muted" })
          return fetch(API + "/cache", {
            method: "POST", headers: { "content-type": "application/json" },
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
        }).then(function () { setCleaning(false) })
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
          children.push(h("div", { key: "row", style: { display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" } },
            h("div", { style: { minWidth: 0, flex: 1 } },
              h("div", { title: progress.source || "", style: { fontSize: 13, fontWeight: 550, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, progress.source || "未命名来源"),
              h("div", { style: { color: COLORS.muted, fontSize: 11, marginTop: 6, lineHeight: 1.6 } }, (progress.detail || "处理中") + (progress.frames ? " · " + progress.frames + " 帧" : "") + " · " + fmtClock(progress.startedAt)),
            ),
            badge(phaseText, tone),
          ))
          children.push(h("div", {
            key: "bar", role: "progressbar", "aria-label": "下载进度", "aria-valuemin": 0, "aria-valuemax": 100,
            "aria-valuenow": percent === null ? undefined : percent,
            style: { height: 7, borderRadius: 99, background: COLORS.nested, overflow: "hidden", marginTop: 14 },
          }, h("div", { style: { width: percent === null ? (progress.done ? "100%" : "28%") : percent + "%", height: "100%", background: tone, opacity: percent === null && !progress.done ? 0.55 : 1, transition: "width .3s ease" } })))
          children.push(h("div", { key: "bytes", style: { display: "flex", justifyContent: "space-between", marginTop: 7, color: COLORS.muted, fontSize: 11 } },
            h("span", null, progress.bytes ? fmtBytes(progress.bytes) + (progress.totalBytes ? " / " + fmtBytes(progress.totalBytes) : "") : "等待可计量的进度"),
            percent === null ? null : h("span", null, percent + "%"),
          ))
          if (progress.error) children.push(h("div", { key: "error", role: "alert", style: { color: COLORS.error, fontSize: 12, lineHeight: 1.6, marginTop: 10 } }, progress.error))
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
        var rows = []
        for (var i = 0; i < TEXT_FIELDS.length; i += 1) {
          var spec = TEXT_FIELDS[i]
          ;(function (spec) {
            rows.push(
              h("div", { key: spec.key, style: { marginBottom: 10 } },
                fieldLabel(spec.label, "video-read-" + spec.key),
                h("input", {
                  id: "video-read-" + spec.key,
                  "aria-label": spec.label,
                  "aria-describedby": "video-read-help-" + spec.key,
                  min: spec.min, max: spec.max, step: spec.step,
                  type: spec.kind === "string" ? "text" : "number",
                  value: currentValue(spec.key) === undefined || currentValue(spec.key) === null ? "" : String(currentValue(spec.key)),
                  onChange: function (event) {
                    var raw = event.target.value
                    setField(spec.key, spec.kind === "string" ? raw : raw === "" ? "" : Number(raw))
                  },
                  style: {
                    width: "100%", boxSizing: "border-box", padding: "9px 10px", fontSize: 12, borderRadius: 8,
                    border: "1px solid " + COLORS.border,
                    background: COLORS.nested,
                    color: COLORS.text,
                    outlineColor: COLORS.accent,
                  },
                }),
                h("div", { id: "video-read-help-" + spec.key, style: { fontSize: 11, lineHeight: 1.55, color: COLORS.muted, marginTop: 5 } }, spec.help),
              ),
            )
          })(spec)
        }
        for (var b = 0; b < BOOL_FIELDS.length; b += 1) {
          var boolSpec = BOOL_FIELDS[b]
          ;(function (spec) {
            rows.push(
              h("div", { key: spec.key, style: { padding: "10px 0", borderTop: "1px solid " + COLORS.border } },
                h("label", { style: { display: "flex", alignItems: "center", gap: 9, fontSize: 12, fontWeight: 550, cursor: "pointer" } },
                  h("input", {
                    type: "checkbox",
                    "aria-label": spec.label,
                    checked: Boolean(currentValue(spec.key)),
                    onChange: function (event) { setField(spec.key, event.target.checked) },
                  }),
                  spec.label,
                ),
                helpText(spec.help),
              ),
            )
          })(boolSpec)
        }
        rows.push(
          h("div", { key: "actions", style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 12 } },
            button(saving ? "保存中…" : "保存设置", save, { primary: true, disabled: saving }),
            button("填入推荐值", reset, { disabled: saving }),
            message ? h("span", { role: "status", style: { fontSize: 11, color: message.indexOf("失败") >= 0 ? COLORS.error : COLORS.muted } }, message) : null,
          ),
        )
        return card([
          sectionTitle("阅读设置", "默认值优先控制 token 和下载成本；修改后新工具调用立即生效。"),
          h("div", { key: "grid", style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "8px 22px" } }, rows),
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
        notice.text ? h("div", { key: "notice", role: "status", style: { marginBottom: 12, padding: "10px 12px", borderRadius: 8, background: COLORS.nested, color: notice.tone === "error" ? COLORS.error : notice.tone === "success" ? COLORS.success : COLORS.muted, fontSize: 12 } }, notice.text) : null,
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
