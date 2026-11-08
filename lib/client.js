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
      return h(
        "div",
        {
          style: Object.assign(
            {
              background: "var(--dsh-surface-secondary, rgba(127,127,127,0.07))",
              border: "1px solid var(--dsh-border-subtle, rgba(127,127,127,0.22))",
              borderRadius: 10,
              padding: 14,
            },
            extra || {},
          ),
        },
        children,
      )
    }

    function fieldLabel(text) {
      return h("div", { style: { fontSize: 11, opacity: 0.65, marginBottom: 4 } }, text)
    }

    var TEXT_FIELDS = [
      { key: "maxFrames", label: "每次最多帧数", kind: "int" },
      { key: "maxVideoMinutes", label: "最长视频（分钟）", kind: "number" },
      { key: "imageWidth", label: "帧宽度（px）", kind: "int" },
      { key: "quality", label: "抽帧质量（ffmpeg qscale）", kind: "int" },
      { key: "captionModel", label: "视觉描述模型（留空=当前路由）", kind: "string" },
    ]

    var BOOL_FIELDS = [
      { key: "autoDownloadFfmpeg", label: "首次使用时自动下载 ffmpeg" },
      { key: "autoDownloadYtdlp", label: "首次使用时自动安装 yt-dlp（npm 镜像）" },
      { key: "burnTimestamps", label: "联系表每格烧录时间戳" },
      { key: "keepSource", label: "保留已下载的视频文件" },
    ]

    function usePanelState() {
      var pair = React.useState({ status: "loading", data: null, error: null })
      var state = pair[0]
      var setState = pair[1]
      React.useEffect(function () {
        var alive = true
        function load() {
          fetch(API + "/panel", { headers: { accept: "application/json" } })
            .then(function (response) {
              if (!response.ok) throw new Error("HTTP " + response.status)
              return response.json()
            })
            .then(function (json) {
              if (alive) setState({ status: "ready", data: json, error: null })
            })
            .catch(function (error) {
              if (!alive) return
              setState(function (previous) {
                if (previous.status === "ready") return previous
                return { status: "error", data: null, error: String((error && error.message) || error) }
              })
            })
        }
        load()
        var timer = setInterval(load, 2500)
        return function () {
          alive = false
          clearInterval(timer)
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

      if (state.status === "loading") {
        return h("div", { style: { padding: 16, fontSize: 13, opacity: 0.7 } }, "正在读取 dsh-video-read 面板…")
      }
      if (state.status === "error") {
        return h(
          "div",
          { style: { padding: 16, fontSize: 13 } },
          h("div", { style: { color: "var(--dsh-danger, #e5484d)", marginBottom: 8 } }, "面板接口不可用：" + state.error),
          h("div", { style: { opacity: 0.7 } }, "该面板需要 Web 版 DSH（Host 注册了 Web 路由）才会出现数据。"),
        )
      }

      var data = state.data
      var config = data.config || {}
      var progress = data.progress
      var cache = data.cache || { dirs: [] }
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

      function statusSection() {
        var children = [
          h("div", { key: "title", style: { fontSize: 12, fontWeight: 600, marginBottom: 10, opacity: 0.8 } }, "最近一次读取"),
        ]
        if (!progress) {
          children.push(h("div", { key: "empty", style: { fontSize: 12, opacity: 0.6 } }, "本次会话还没有运行过 video_read / video_frames。"))
        } else {
          var phaseText = PHASES[progress.phase] || progress.phase || "—"
          children.push(
            h(
              "div",
              { key: "row", style: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, marginBottom: 8 } },
              h("div", { style: { minWidth: 0, flex: 1 } },
                h("div", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, progress.source || "—"),
                h("div", { style: { opacity: 0.6, marginTop: 2 } },
                  phaseText +
                    (progress.detail ? " · " + progress.detail : "") +
                    (progress.frames ? " · " + progress.frames + " 帧" : "") +
                    " · " + fmtClock(progress.startedAt),
                ),
              ),
              h("div", { style: { textAlign: "right", whiteSpace: "nowrap" } },
                progress.done
                  ? progress.error
                    ? h("span", { style: { color: "var(--dsh-danger, #e5484d)" } }, "失败")
                    : "完成"
                  : "运行中",
                progress.bytes ? h("div", { style: { opacity: 0.6 } }, fmtBytes(progress.bytes) + (progress.totalBytes ? " / " + fmtBytes(progress.totalBytes) : "")) : null,
              ),
            ),
          )
          if (percent !== null) {
            children.push(
              h("div", { key: "bar", style: { height: 6, borderRadius: 3, background: "rgba(127,127,127,0.2)", overflow: "hidden" } },
                h("div", { style: { width: percent + "%", height: "100%", background: "var(--dsh-accent, #4d8dff)", transition: "width .3s ease" } }),
              ),
            )
          } else if (!progress.done) {
            children.push(h("div", { key: "pulse", style: { height: 6, borderRadius: 3, background: "rgba(127,127,127,0.18)" } }))
          }
          if (progress.artifactsDir) {
            children.push(h("div", { key: "dir", style: { fontSize: 11, opacity: 0.55, marginTop: 8, wordBreak: "break-all" } }, progress.artifactsDir))
          }
        }
        return card(children)
      }

      function configSection() {
        var rows = []
        for (var i = 0; i < TEXT_FIELDS.length; i += 1) {
          var spec = TEXT_FIELDS[i]
          ;(function (spec) {
            rows.push(
              h("div", { key: spec.key, style: { marginBottom: 10 } },
                fieldLabel(spec.label),
                h("input", {
                  type: spec.kind === "string" ? "text" : "number",
                  value: currentValue(spec.key) === undefined || currentValue(spec.key) === null ? "" : String(currentValue(spec.key)),
                  onChange: function (event) {
                    var raw = event.target.value
                    setField(spec.key, spec.kind === "string" ? raw : raw === "" ? "" : Number(raw))
                  },
                  style: {
                    width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 12, borderRadius: 6,
                    border: "1px solid var(--dsh-border-subtle, rgba(127,127,127,0.3))",
                    background: "var(--dsh-surface-primary, rgba(0,0,0,0.15))",
                    color: "inherit",
                  },
                }),
              ),
            )
          })(spec)
        }
        for (var b = 0; b < BOOL_FIELDS.length; b += 1) {
          var boolSpec = BOOL_FIELDS[b]
          ;(function (spec) {
            rows.push(
              h("label", { key: spec.key, style: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 8 } },
                h("input", {
                  type: "checkbox",
                  checked: Boolean(currentValue(spec.key)),
                  onChange: function (event) { setField(spec.key, event.target.checked) },
                }),
                spec.label,
              ),
            )
          })(boolSpec)
        }
        rows.push(
          h("div", { key: "actions", style: { display: "flex", alignItems: "center", gap: 10, marginTop: 6 } },
            h("button", {
              type: "button",
              disabled: saving,
              onClick: save,
              style: {
                padding: "6px 14px", fontSize: 12, borderRadius: 6, cursor: saving ? "default" : "pointer",
                border: "1px solid var(--dsh-border-strong, rgba(127,127,127,0.45))",
                background: "var(--dsh-accent-muted, rgba(77,141,255,0.18))", color: "inherit",
              },
            }, saving ? "保存中…" : "保存设置"),
            message ? h("span", { style: { fontSize: 11, opacity: 0.75 } }, message) : null,
          ),
        )
        return card([
          h("div", { key: "title", style: { fontSize: 12, fontWeight: 600, marginBottom: 10, opacity: 0.8 } }, "配置"),
          h("div", { key: "grid", style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "4px 18px" } }, rows),
          h("div", { key: "note", style: { fontSize: 11, opacity: 0.55, marginTop: 8 } },
            "保存写入 " + (cache.settingsPath || "settings.json") + "；下次启动仍然生效。"),
        ])
      }

      function cacheSection() {
        var rows = []
        var dirs = cache.dirs || []
        for (var i = 0; i < dirs.length; i += 1) {
          rows.push(
            h("div", { key: dirs[i].name, style: { display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, padding: "4px 0", borderTop: i ? "1px solid rgba(127,127,127,0.12)" : "none" } },
              h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, dirs[i].name),
              h("span", { style: { opacity: 0.65, whiteSpace: "nowrap" } }, fmtBytes(dirs[i].bytes)),
            ),
          )
        }
        return card([
          h("div", { key: "title", style: { fontSize: 12, fontWeight: 600, marginBottom: 6, opacity: 0.8 } },
            "缓存（" + fmtBytes(cache.totalBytes || 0) + "）"),
          h("div", { key: "root", style: { fontSize: 11, opacity: 0.55, marginBottom: 6, wordBreak: "break-all" } }, cache.root || ""),
          rows.length ? h("div", { key: "rows" }, rows) : h("div", { key: "empty", style: { fontSize: 12, opacity: 0.6 } }, "缓存为空"),
        ])
      }

      return h("div", { style: { padding: "4px 2px 20px", fontSize: 13, color: "inherit" } }, [
        h("div", { key: "head", style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 } },
          h("div", { style: { fontSize: 15, fontWeight: 600 } }, "Video Reader"),
          h("div", { style: { fontSize: 11, opacity: 0.55 } }, "v" + (data.version || "?") + " · 视频阅读 / 抽帧 / 字幕时间轴"),
        ),
        h("div", { key: "status", style: { marginBottom: 12 } }, statusSection()),
        h("div", { key: "config", style: { marginBottom: 12 } }, configSection()),
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
