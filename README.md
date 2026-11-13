# dsh-video-read

让 DSH Agent 具备「阅读视频」能力的 Host 级插件：给一个 B 站链接或本地视频文件，插件自动取流、抽帧、对齐字幕时间轴，把画面帧作为图片证据交给模型；对纯文本模型提供文本证据链（分段摘要 + 时间轴检索），并可选地把帧交给视觉模型写 caption。

## 3 分钟快速开始

1. 安装插件并重启 Host（安装命令见下方「安装」）。首次使用会自动准备 ffmpeg；YouTube 等网页来源另需 yt-dlp，均不需手动配置。
2. 直接把链接或本地路径发给 Agent，例如：**“总结这个视频：https://www.bilibili.com/video/BV1kvxF6zEDu”**。不需要手动填写工具 JSON。
3. 长视频先说 **“先给时间轴提纲，再找出关键画面”**；追问某个细节时说 **“找某句话出现的时刻，并看当时的画面”**。Agent 会先读文本证据，再局部补帧，而不是把整段视频都变成图片。
4. 本地文件可直接说：**“阅读 D:\\clips\\demo.mp4，列出主要镜头”**。可选字幕放在同目录并命名为 `demo.zh.srt`、`demo.srt`、`demo.vtt` 或 `demo.ass`；没有字幕也能抽帧，只是没有台词时间轴。
5. 设置页位于 **设置 → Video Reader**：三步指南、真实下载/抽帧进度、参数说明、缓存占用和“预览后清理”都在这里。

**能力边界**：当前模型声明图片输入时才能直接看图；纯文本模型可使用字幕摘要/检索，并可通过独立视觉模型生成画面描述。没有字幕不代表插件能理解所有画面内容，此时请明确让 Agent 抽帧。插件不会绕过 DRM 或抖音风控。

> **版本 0.5.1（三维度完善：可访问性 / 错误韧性 / 性能与反馈）**：面板按官方设置页规范重排（分组 fieldset、原生进度条不伪装百分比、字段级校验与首错聚焦、危险操作预览+确认+焦点返还、reduced-motion 支持、后台自动降频轮询）；全部失败路径挂结构化错误码（面板直接显示"码+人话"对照，见下方排查表）；进度上报覆盖 probe/digest/ask/shots 全部工具；yt-dlp 调用统一 `--ignore-config` 防全局配置破坏 CLI 契约；无字幕时返回显式原因（no-subs / needs-cookie / fetch-failed）与"画面正常，只是没有词"提示。0.5.0 的面板重设计/缓存安全记录见文末。
>
> 抖音因 2026-10 起引入 `x-secsdk-web-signature` 风控、公开提取器失效，本插件**不实现绕过**，遇到抖音链接会返回明确的结构化错误；DRM 视频（Netflix / 迪士尼 / 爱奇艺 VIP / 腾讯 VIP 等）一律拒绝。

## 工具

| 工具 | 用途 | 下载媒体 | 返回图片 |
| --- | --- | --- | --- |
| `video_probe` | 探明标题、时长、分辨率、音轨、字幕语言与条数、ffmpeg 状态、当前模型是否支持图片输入 | 否 | 否 |
| `video_frames` | 按 `fps` / `times` / `scene` / `grid` 四种模式抽帧，逐帧附时间戳、最近字幕，可选弹幕与 caption；`grid` 把整段采样拼成一张联系表（1 张图代替 N 张） | 首次 | 需图片模态 |
| `video_read` | 一次完成：取流 → 抽帧（默认 1fps、上限 8，硬上限 32）→ 逐帧字幕 → 时间轴字幕 → 证据集 | 首次 | 需图片模态 |
| `video_digest` | **纯文本**长视频摘要：把字幕（和 B 站弹幕）按时间分段成可读文本，不下载媒体、不花图片 token | 否 | 否 |
| `video_ask` | **纯文本**时间轴检索：用问题检索字幕 + 弹幕，返回最相关的时间戳台词，再用 `video_frames mode="times"` 看画面 | 否 | 否 |
| `video_scenes` | 场景切换检测（`video_frames mode="scene"` 的专用入口），每个切换点返回一张图 | 首次 | 需图片模态 |
| `video_shots` | B 站自带 videoshot 关键帧精灵图（10×10 瓦片）裁切，一页图片得到多个关键帧，适合长视频低成本取帧 | 否（只取精灵图） | 需图片模态 |
| `video_storyboard` | 分镜表：场景切点（候选过多时均匀抽稀、覆盖全片）→ 每镜时间范围、最近字幕、可选 caption，并返回画面 | 首次 | 需图片模态 |
| `video_cache` | 查看 / 清理工作区 `.video-read` 产物缓存：`status` 列目录大小与过期，`prune` 删过期目录（`dry_run` 预览） | 否 | 否 |

### 典型调用

```text
video_probe(source="https://www.bilibili.com/video/BV1xx411c7mD")
video_read(source="BV1xx411c7mD", fps=1, max_frames=8, start=0, end=60)
video_frames(source="D:\\clips\\demo.mp4", mode="times", times=[1.5, 12, 30.2])
video_frames(source="...", mode="scene", max_frames=10)
video_frames(source="...", mode="grid", fps=2, max_frames=16)   # 16 帧 → 一张 4×4 联系表
video_digest(source="BV1xx411c7mD", segment_seconds=120, max_segments=12)
video_ask(source="BV1xx411c7mD", question="草鞋出现在哪一段", limit=8)
video_shots(source="BV1xx411c7mD", max_shots=8, start=0, end=300)
video_probe(source="https://media.w3.org/2010/05/sintel/trailer.mp4")   # 直链媒体：无 yt-dlp、无页面解析
video_read(source="https://cdn.example.com/clip.mp4?token=...", fps=0.2, max_frames=4)
```

- 每一帧按时间顺序编号，并附 `[frame i/N] t=mm:ss.s | subtitle: ...` 标签，模型可以把画面与字幕对齐。
- 结果写入 `<workspace>/.video-read/<标题>-<hash>/`：`manifest.json`（v2：coverage / route / notes / frames）、`meta.json`、`timeline.json`、`frames/*.jpg`。
- B 站重复调用复用已下载的 `source.mp4`，不会重复下载；多 P 视频按 `bvid+p+cid` 分目录。
- 片尾最后一帧若过暗（常见黑帧/淡出），采样时间会自动提前 1.4s，并在 `notes` 说明。

### Web 设置面板（M2 客户端半）

插件带一个 Host 级设置页（`设置 → Video Reader`，无需任何前端构建步骤）：

- **最近一次读取**：显示 `video_probe`/`video_digest`/`video_ask`/`video_shots`/`video_read`/`video_frames` 等全部工具的真实阶段（解析 → 下载 → 探测 → 抽帧 → 描述 → 弹幕 → 完成）、字节进度、帧数、视频标题、源与错误详情；空闲 15 秒 / 运行 2 秒自适应轮询，后台标签页暂停，断线保留旧数据并标注。
- **配置**：按「阅读预算 / 下载与辅助模型 / 产物与缓存」三组分区，字段级校验（非法值即时标红、保存聚焦第一个错误项），修改后新工具调用立即生效，并写入 `~/.dsh/cache/dsh-video-read/settings.json`。Cookie/yt-dlp 路径等敏感字段不在网页表单暴露。
- **错误码**：所有失败路径返回结构化错误码（`E_FFMPEG_MISSING`、`E_RISK_CONTROL` 等），面板显示"码+人话"对照，完整对照见下方排查表。
- **缓存**：分别显示工作区 `.video-read` 视频产物与全局 ffmpeg/yt-dlp 运行时；只清理超过保留期的工作区目录，先 dry-run 列出数量与字节，再显式确认，确认对话框关闭后焦点返回触发按钮。
- 宿主路由：`GET /api/dsh-video-read/panel`（状态 JSON）、`POST /api/dsh-video-read/config`（`{"config":{...}}`，成功返回已保存项与持久化路径）。这两个路由由 `lib/panel.js` 在 Host Web carrier 上注册；纯 Electron 组合没有 Web carrier 时自动跳过。
- 客户端半是 `lib/client.js`（预构建模块装载器 bundle，注册 `settings.section`）；宿主半是 `lib/panel.js` + `lib/progress.js`。
- **生效条件**：client 模块图在 Host 启动时组合，本版本首次加入 `dsh.client` 声明，因此需要**重启一次 Host 并刷新页面**后设置页才会出现；之后修改 `lib/client.js` 只需重启 Host 或走客户端 HMR。

### 文本证据链（C2，纯文本模型可用）

- `video_digest`：把字幕按 `segment_seconds` 分段（自动放宽以不超过 `max_segments`），每段保留最多 40 条台词 + 8 条弹幕；返回 `digestText` 可直接阅读，适合 1–3 小时长视频先建立全局理解。每段标明 `已展示/总数`，不会把截薄后的文本说成完整字幕。
- `video_ask`：本地关键词匹配与轻量排序（拉丁词/中文二元组 + 字幕权重 1.0 / 弹幕权重 0.7），不调用任何模型、不下载媒体；返回时间戳 + 文本 + 命中词，便于后续 `video_frames mode="times"` 定点看画面。
- 两者都要求视频有字幕；B 站 AI 字幕未生成时返回 0 条并在 `subtitle.note` 说明。

### 弹幕（B 站）

`video_read` / `video_frames` 传 `include_danmaku=true` 时额外返回前 200 条弹幕（时间 + 文本），与字幕时间轴互补；数据来自公开的 `comment.bilibili.com/<cid>.xml`，失败只记 `notes`，不影响抽帧。

### B 站关键帧截图（videoshot）

B 站为每个视频提供一张 10×10 的关键帧瓦片图（含每个瓦片的时间索引）。`video_shots` 只下载这一张精灵图，用 ffmpeg 裁切出所需关键帧，**不下载完整视频**；对长视频是成本最低的视觉证据手段。某些视频没有 videoshot 数据，此时报错并提示改用 `video_frames`。

### C1 视觉桥（caption）

给纯文本模型补充「别人替它看」的能力：`video_read` / `video_frames` 传 `captions="always"`，或 `auto` 且当前路由**不支持图片**且已配置可用 caption 模型时，对附加帧逐帧调用视觉模型（`ctx.llm.stream`，`purpose: "compaction"`），把每帧画面写成 1–2 句 caption，随帧返回。

- 默认 caption 用当前路由模型；可用 `captionProvider` / `captionModel` 指定更便宜的视觉模型。
- 只对前 `maxCaptionFrames`（默认 8）帧生成，每帧最多 `captionMaxTokens`（默认 400）token；失败逐帧记录在 `notes`，不影响帧证据。
- 每次 caption 都是一次真实的模型调用，按帧计费，长视频请配合 `start` / `end` 分段。

### YouTube / 通用站点（M2，自动安装 yt-dlp）

- 插件**自动安装 yt-dlp**：首次遇到非 B 站链接时，从 npm 镜像取 `yt-dlp-static` 的 registry 元数据，校验 `dist.integrity`（sha512）后只解压 `package/bin/win/yt-dlp.exe`，二进制必须能 `--version` 输出 yt-dlp 版本号，否则删除；安装记录写在 `~/.dsh/cache/dsh-video-read/bin/yt-dlp.json`。`autoDownloadYtdlp: false` 可关闭，`ytdlpPath` 可指向自装版本。
- 已知 yt-dlp 在这个环境里需要可写 `TEMP`，插件会把 `TEMP/TMP/TMPDIR` 指向 `<cache>/tmp` 后再 spawn（PyInstaller 否则报 `Cannot create temporary directory`）。
- 解析用 `yt-dlp -J`；下载先写字幕（`zh-Hans,zh-CN,zh,en.*`），再用 `--ffmpeg-location` 指向插件 ffmpeg 目录合并 ≤720P mp4；某个 CDN/codec 连接被拒时自动换格式侧重试一次。
- 通用兜底：任何非 B 站 / 非 DRM 的 http(s) 链接都会交给 yt-dlp（先经 `assertPublicHttpUrl` 拒绝 localhost、私网、`.local` 等地址）。抖音/快手/小红书仍按站点明确拒绝，不走兜底。

## 纯文本 / 无图片模态模型

当当前路由模型未声明 `image` 输入（例如 `deepseek-v4-pro`），`video_read` / `video_frames` 仍完成取流与抽帧（落盘），但返回：

- 元数据、逐帧时间戳与字幕、时间轴字幕文本；
- `textOnlyFallback: true` 与原因；
- 帧文件路径（模型可转述给用户，或交给 C1 caption / 视觉模型）。

推荐的纯文本工作流：`video_digest`（全局）→ `video_ask`（定位）→ `video_frames mode="times"`（定点看画面，若路由无图则只拿文本证据）。

原生视频模态（整段视频输入）目前 DSH 内核没有对应 content block，插件层无法实现；图像抽帧 + 文本证据链是当前可落地的「读视频」路径。

## 安装

从 GitHub 仓库安装（推荐）：

```text
plugin_manager(action="install_bundle", target="https://github.com/Kuest10n/dsh-video-read")
```

本地开发时也可以直接指向检出目录：

```text
plugin_manager(action="install_bundle", target="E:\\path\\to\\dsh-video-read")
```

安装后重启 Host；工具对当前 profile 的所有 Agent 可见（Host 级注册，不属于任何预设）。**修改插件代码后**：对 `include:dsh-video-read` 执行一次 `plugin_manager set_plugin`「禁用 → 启用」即可重载新代码（免重启）；若遇到模块缓存不刷新，再重启 Host。

> 本插件从 0.4.1 起使用与仓库一致的公开包名 `dsh-video-read`（此前本地开发包名为 `@local/dsh-video-read`）。

## 配置（`cordis.patch.yml` 中的 `config`）

> 面板保存的用户设置写入 `~/.dsh/cache/dsh-video-read/settings.json`，激活时覆盖下表同名项；下表是 bundle 侧默认值。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `autoDownloadFfmpeg` | `true` | 首次使用自动下载并校验 ffmpeg；查找顺序为显式路径 → 插件缓存 → PATH → 自动下载 |
| `autoDownloadYtdlp` | `true` | 首次遇到 YouTube / 通用 Web 链接时从 npm 镜像安装 `yt-dlp-static`（sha512 校验 + 单文件解压 + `--version` 验证） |
| `ffmpegPath` | `""` | 指定已有的 `ffmpeg.exe`；设置后不再下载 |
| `cacheDir` | `""` | ffmpeg 缓存目录，默认 `~/.dsh/cache/dsh-video-read` |
| `cookieFile` | `""` | B 站 cookie JSON 文件（`{"cookie": "SESSDATA=...; ..."}`），只读；用于高画质与 AI 字幕。通过 bundle/settings.json 配置，不开放网页写入 |
| `quality` | `3` | JPEG qscale（2–31 常用，越小越清晰，不是百分制） |
| `bilibiliQuality` | `64` | B 站 qn：16=360P、32=480P、64=720P（默认）、80=1080P；高画质受账号权限限制 |
| `maxFrames` | `32` | 单次抽帧硬上限 |
| `imageWidth` | `1280` | 抽帧最长边 |
| `sceneThreshold` | `0.3` | `mode="scene"` 的转场阈值 |
| `maxTimelineCues` | `300` | 返回的时间轴字幕条数上限 |
| `maxAttachImages` | `20` | 单次调用实际附加为图片的帧数上限（DSH `maxImagesPerMessage=20`，超出只给路径与时间戳） |
| `frameConcurrency` | `0`（自动） | 逐帧回退提取的并发数；0 = 按 CPU 核数（2–8） |
| `keepSource` | `true` | B 站抽帧后是否保留 `source.mp4`；`false` 时删除以省磁盘 |
| `maxVideoMinutes` | `180` | 允许下载的视频时长上限（分钟） |
| `maxMediaBytes` | `1200000000` | 允许下载的媒体字节上限（1.2GB） |
| `cacheTtlDays` | `14` | 产物目录清理阈值（天） |
| `pruneArtifacts` | `true` | 每次取流顺手清理过期产物与旧帧 run |
| `verifyFfmpegIntegrity` | `true` | 下载 ffmpeg npm tarball 时校验 `dist.integrity`（sha512） |
| `digestSegmentSeconds` | `120` | `video_digest` 目标分段长度（秒） |
| `maxDigestSegments` | `12` | `video_digest` 分段数上限 |
| `maxShots` | `8` | `video_shots` 单次关键帧上限 |
| `gridCellWidth` / `gridCellHeight` | `320` / `240` | `mode="grid"` 每个格子的像素尺寸（不足处补黑边） |
| `captionProvider` / `captionModel` | `""` | caption 用的视觉模型路由；留空用当前路由 |
| `maxCaptionFrames` | `8` | 单次最多 caption 的帧数 |
| `captionMaxTokens` | `400` | 每帧 caption 的输出 token 上限（含推理模型的思考 token） |
| `ytdlpPath` | `""` | 指定 `yt-dlp.exe`；留空依次查 PATH / `%LOCALAPPDATA%\\Programs\\yt-dlp` / `~/.dsh/cache/dsh-video-read/bin`，都没有且 `autoDownloadYtdlp` 未关时自动安装 |

## 排查表（错误码对照）

所有失败路径都会在工具输出与面板中给出结构化错误码。对照表：

| 错误码 | 常见原因 | 怎么检查 | 下一步 |
| --- | --- | --- | --- |
| `E_FFMPEG_MISSING` | ffmpeg 不可用且自动下载被禁用 | 面板/README「配置」确认 `autoDownloadFfmpeg`；`ffmpeg -version` 是否在 PATH | 开启自动下载，或 `ffmpegPath` 指向已有 ffmpeg |
| `E_YTDLP_MISSING` | yt-dlp 不可用且自动安装被禁用/失败 | 确认 `autoDownloadYtdlp`；`yt-dlp --version` 是否可用 | 开启自动安装，或 `ytdlpPath` 指向已有 yt-dlp |
| `E_RISK_CONTROL` | B 站风控（412），常见于无 cookie 的数据中心 IP | 换浏览器网络验证 URL 是否可看 | 从**打开过 B 站的浏览器**导出 cookie（无需登录），配 `cookieFile` 后重试 |
| `E_NEEDS_COOKIE` | 接口要求登录（-101），AI 字幕/高画质需要 | `video_probe` 看 subtitle.note | 配置 `cookieFile`（含 SESSDATA） |
| `E_VIP_CONTENT` | 视频为付费/大会员内容，无流可取 | 确认浏览器里能否播放 | 降低 `bilibiliQuality`；或本地文件 |
| `E_PRIVATE_URL` | 链接指向内网/私网地址（SSRF 防护） | URL 是否为公网 | 改用公网直链或页面 URL |
| `E_DRM` | Netflix/爱奇艺 VIP 等 DRM 平台 | — | 插件不绕过 DRM；用自有本地文件 |
| `E_TOO_LONG` | 视频超过 `maxVideoMinutes`（默认 180 分钟） | `video_probe` 看时长 | 分段本地文件；或调高 `maxVideoMinutes` |
| `E_SEGMENTED` | B 站返回多段 FLV（老视频） | `video_probe` 看 notes | 稍后重试（通常会有 DASH）；或用其他工具下载后传本地文件 |
| `E_PLAYLIST` | URL 是合集/列表而非单个视频 | — | 传单个视频 URL |
| `E_NO_SPRITE` | 该视频没有 B 站 videoshot 精灵图 | `video_probe` 确认是 B 站 | 改用 `video_frames` |
| `E_FILE_NOT_FOUND` | 本地文件路径不存在 | 核对路径与工作区 | 用绝对路径或相对工作区的路径 |
| `E_DOWNLOAD` | 下载失败/卡死/超时 | 面板进度显示字节数 | 重试；网络不稳时调低画质 |

无字幕时的原因枚举（`subtitle.note` / `notes`）：`no-subs`（视频确实没有字幕——画面正常，只是没有词，请改用抽帧）、`needs-cookie`（未登录拿不到 AI 字幕，配 `cookieFile`）、`fetch-failed`（网络/接口临时失败，可重试）。

## 限制与已知问题

- **B 站 4K / 高码率**：只保证 720P / 1080P（登录 cookie）；更高档位有已知限制。
- **B 站 412**：风控触发时等待几分钟；`bilibili.js` 对 412 / 429 / -509 做退避重试并提示等待。
- **抖音**：不支持，不是配置问题。请用户下载后传本地文件。
- **YouTube / 通用站点**：自动安装的 yt-dlp 是 npm 镜像里 2024.07 的 PyInstaller 单文件构建；连接 YouTube 本身仍需网络可达（本机网络被阻断时只能解析已可达站点）。登录/年龄限制视频会被 yt-dlp 自身的 cookie 需求挡住。
- **DRM**：不可实现，取流前按主机名拦截并拒绝。
- **单次帧数**：32 帧是模型与请求体预算下的保守上限；长视频用 `start` / `end` 分段，或 `mode="times"` 定点。
- **`mode="grid"`**：联系表每格固定 `320×240`（不足补黑边），画面细节被压缩；需要看清细节时用 `mode="times"` 返回单张原尺寸帧。一格约对应一个时间戳，索引文本逐格给出时间与字幕。
- **`mode="times"`**：单次最多 4096 个时间戳；越界会夹紧并在 `notes` 说明。
- **解码器年龄**：npm 镜像得到的 ffmpeg 4.1.0（2018 年静态构建）能解 H.264/H.265 常见档位，但对新编码/恶意媒体不如新版稳健；可 `ffmpegPath` 指向自装新版。
- **caption 成本**：每帧一次模型调用，按 token 计费；默认上限 8 帧。
- **videoshot 缺失**：部分视频没有关键帧精灵图，`video_shots` 会报错并建议 `video_frames`。
- **弹幕**：公开接口可能限流或对部分稿件关闭；失败只记 `notes`。
- **设置面板首次出现需重启 Host**：client 模块图在 Host 启动时组合，0.3.0 首次加入 `dsh.client` 声明，旧进程缓存的包元数据不会失效；重启 Host + 刷新页面后 `设置 → Video Reader` 才会出现。宿主侧路由（`/api/dsh-video-read/*`）与进度记录在重载后即生效，不依赖重启。
- **面板报「HTTP 404 / 接口不可用」**：0.3.3 之前是路由注册时机问题——Host bundle 在启动早期 apply 时 `webServer` 还未组合，`ctx.get('webServer')` 为 `undefined`，两条精确路由没有注册（客户端的 404 兜底文案会把原因归到「需要 Web 版 DSH」）。0.3.3 起改为 `ctx.inject(['webServer'], …)` 延迟挂载：重启 Host 后路由会在 Web carrier 出现时注册；可用 `GET /api/dsh-video-read/panel`（同机 loopback）确认返回 200 JSON。

## 卸载

```text
plugin_manager(action="remove_bundle", target="dsh-video-read")
```

## 开发自测

```bash
node scripts/self-test.mjs             # 合成视频 + 三种模式 + 纯文本降级（31 项）
node scripts/self-test.mjs --bilibili  # 追加真实 B 站探明、取流与抽帧（37 项）
node scripts/m15-test.mjs              # 纯函数快速冒烟：danmaku / digest / ask / shots / yt-dlp JSON / storyboard / grid / cache / panel / URL guard（60 项）
node scripts/client-test.mjs           # 客户端 bundle 契约：模块装载器注册、settings.section 注册、apply 容错（22 项）
node scripts/panel-test.mjs            # Host 路由与安全契约：配置校验 / 同源 / 缓存确认 / 快照字段（20 项）
```

`scripts/self-test.mjs` 不依赖 Host；`m15-test.mjs` 不联网、不依赖 ffmpeg；`client-test.mjs` 用假的 `window.__ModuleLoader__` 与 `require` 离线执行 `lib/client.js`。

## 路线图

- **M1（已完成）**：B 站 + 本地取流、三种抽帧模式、字幕对齐、图片证据、纯文本降级。
- **M1.5（已完成）**：danmaku 时间轴、videoshot 关键帧截图、长视频文本证据链（`video_digest`）、C1 进程内视觉桥（caption）、联系表 `mode="grid"`、片尾黑帧夹紧。
- **M2（已完成）**：时间轴检索 `video_ask`、产物缓存管理 `video_cache`、Web 设置面板 + 下载/抽帧进度上报（0.3.0）、yt-dlp 首次使用时自动安装 + 通用站点兜底（0.3.1）、直链媒体 URL 快速通道（0.3.2）、安全加固：SSRF 逐跳校验 / 面板 CSRF 防护 / PE 校验（0.3.3）；可选后续：面板内手动清理缓存按钮（当前用 `video_cache action="prune"`）。
- **M3（部分完成）**：场景切换 `video_scenes`、分镜表 `video_storyboard`（候选切点均匀抽稀，避免只看片头）；原生视频模态适配仍受 DSH 内核 content block 限制。

## 验证记录

### 2026-10-25 首次交付

- **本地合成视频 18/18 通过**：探明、图片证据、逐帧字幕配对、`times` / `scene` 两种模式、纯文本降级、抖音链接结构化拒绝。
- **B 站真实视频 23/23 通过**（`BV1SzHK6xEcx`）：WBI 签名取流 → 720P DASH 下载 → ffmpeg 合成 `source.mp4` → 抽帧并附加图片证据。
- **AI 字幕链路**：`BV1DKn461EDF` 返回 326 条 `ai-zh` 字幕，与帧时间轴对齐（B 站字幕 JSON 有裸数组与 `{body:[...]}` 两种封装，均已兼容）。
- **安装后 Host 实测**：`dsh-video-read` 以 profile bundle 安装并启用；`video_probe` 返回真实元数据与字幕，`video_read` 在 `deepseek-flash`（image 输入）下返回帧图片证据。
- **ffmpeg 获取**：优先 npmmirror 的 `@ffmpeg-installer/win32-x64` + `@ffprobe-installer/win32-x64`（22MB / 28MB，约 3 秒），gyan.dev / BtbN GitHub 作回退。

### 2026-10-31 安全 / 性能 / 正确性审计

三个只读审计子代理（安全、性能、正确性）审查后修复并回归：

- **本地 36/36、含真实 B 站 42/42 通过**（新增：`extractEven` 单遍四帧互异、联系表烧录时间戳、首尾黑边检测与裁剪、时间轴「抽稀但覆盖到结尾」、越界时间戳说明、`formatClock` 进位、`cleanCueText`、manifest v2、DRM / 本地缺失拒绝）。
- **安全**：B 站媒体 URL 主机白名单 + https；short-link 精确主机跟随；字幕/API 8MB 上限+超时+空闲检测；下载临时文件后原子 rename；解压前校验条目路径；npm tarball 校验 `dist.integrity`；cookie 只发 `api.bilibili.com`；错误信息不打印 cookie；路径 `displayPath` 化。
- **性能**：均匀抽帧改为单次解码按 fps 取样（16 帧 4173ms → 279ms，约 15×）；`ffprobe` 结果记忆化；B 站元数据只取一次；WBI key 缓存 10 分钟；失败 npm 源 30 秒冷却；artifact 按 `bvid|cid|p` 复用；并发受限。
- **正确性**：多 P 按 `bvid+p+cid` 分目录；`scene` 带 `-ss` 窗口；时间轴保留覆盖率并报 `coversUntil`；越界写入 `notes`；probe `hasVideo` 真实值、缓存命中标 `cached`；manifest v2；每调用唯一 run 目录。

### 2026-10-31 M1.5 / M2 / M3 增量

- **代码**：新增 6 个模块（`danmaku.js` / `digest.js` / `ask.js` / `shots.js` / `caption.js` / `youtube.js`），`index.js` 从 3 个工具扩展到 7 个，`sources.js` 增加 YouTube 分支，`frames.js` 增加片尾黑帧夹紧。
- **静态检查**：12 个 JS 文件 `node --check` 全部通过。
- **纯函数冒烟 15/15**：弹幕 XML 解析（实体解码）、digest 分段覆盖到结尾、检索命中最相关台词、videoshot 选帧升序、`yt-dlp -J` JSON 解析、even 采样计划。
- **Host 内实测（0.2.0 已加载，`include:dsh-video-read` 禁用→启用重载）**：
  - `video_digest`（`BV1kvxF6zEDu`，含弹幕）：17 条字幕 + 600 条弹幕，按 30s 分为 3 段，文本证据链可读；
  - `video_ask`（同视频，问「草鞋 破旧」）：命中 `00:29.4 这时你不难发现这是一双破旧的草鞋`，并返回相关弹幕；
  - `video_shots`（同视频）：从 videoshot 精灵图裁出 2 张关键帧（480×270），无整片下载；
  - `video_scenes`（同视频）：场景检测返回 2 个切点画面；
  - caption（C1，`video_read` / `video_frames` 传 `captions="always"`）：`deepseek-flash` 为每帧生成中文 caption 并随帧返回；发现推理 token 会吃掉预算，默认 `captionMaxTokens` 从 120 提到 400 后稳定；
  - 片尾夹紧：`video_frames` 采样最后一帧提前 1.4s（`notes` 有说明），避免黑帧；
  - 缓存复用：再次读取同一 B 站视频返回 `reused cached download (7.1 MB)`，不重复下载。

### 2026-10-31 0.2.1 增量（分镜表 / 缓存管理）

- **纯函数冒烟 24/24**：新增 storyboard（场景切分、时间范围、最近字幕、caption 文本）与 cache（统计、dry_run、TTL 删除、删除后复核、非 `.video-read` 目录拒绝）。
- **Host 内实测（0.2.1，`include:dsh-video-read` 禁用→启用热重载）**：
  - `video_storyboard`（`BV1kvxF6zEDu`，`max_frames=3`）：场景检测找到 12 个切点 → 均匀保留 3 个（`00:02.6` / `00:15.1` / `00:57.1`），覆盖全片而非只看片头；
  - `video_cache action=status`：工作区 `.video-read` 共 4 个来源目录、13,072,950 字节，`staleBytes=0`；`prune` 只删过期目录，路径不是 `.video-read` 时直接拒绝；
  - `video_storyboard` 的 `manifest.json` 同时写入 `storyboard` 场景表（时间范围 + 字幕 + caption + 路径）。
- **顺手修**：场景模式此前按时间顺序截断候选（长视频只保留前 N 个切点），现在先检测 `max_frames*4` 个候选再均匀抽稀，`video_scenes` 与 `video_storyboard` 一致覆盖整段。

### 2026-10-31 0.2.2 增量（联系表 grid）

- **纯函数冒烟 28/28**：新增 `planGridCells`（16→4×4、10→4×3、1→1×1、34 列数封顶 4）。
- **Host 内实测（0.2.2，热重载）**：
  - 本地样例 `mode="grid" fps=2`：16 帧 → 一张 4×4（1300×980）JPEG，逐格时间/字幕照常返回；
  - B 站 `BV1kvxF6zEDu` `mode="grid" fps=0.15`：9 帧 → 一张 3×3（976×736），命中缓存不重下。
- **收益**：原来 16 帧 = 16 张图片的 token，现在 1 张；采样率可以按需提高（如 2–5 fps 甚至更高）而不按图片数线性涨 token，这正是最初「每秒 2/5/12/15/24/30/60 次截屏」需求在图片模态下的可行解法。

### 2026-11-01 0.3.0 增量（设置面板 / 进度上报 / 设置持久层）

- **测试**：`m15-test.mjs` 33/33（新增 panel 白名单校验：合法 patch 强转、未知键忽略、越界/类型错误拒绝、空 patch 拒绝、配置投影裁剪）、`client-test.mjs` 15/15（bundle 只调用一次 `load`、id 与包名一致、factory 可执行、注册 `settings.section`（id `dsh-video-read`、order 140、label `Video Reader`）、`apply` 在注册被拒时不崩溃）；4 个改动文件 `node --check` 全过。
- **宿主路由实测**（`include:dsh-video-read` 禁用→启用热重载后，`http://127.0.0.1:64354`）：
  - `GET /api/dsh-video-read/panel` → 200，`version=0.3.0`、`cacheDirs`、`settingsPath`、`config.maxFrames=32`；
  - `POST /config {"maxFrames":999}` → **400**（越界拒绝）；`POST {"imageWidth":1024}` → 200，随后 `GET /panel` 立即读到 `imageWidth=1024`；
  - 保存写入 `C:\Users\Administrator\.dsh\cache\dsh-video-read\settings.json`，测试后已清理。
- **进度上报实测**：跑一次 `video_read`（本地样例、1 帧）后 `GET /panel` 读到 `progress.phase=done`、`frames=1`、`mode=even`、`artifactsDir=E:\talkchat assisment\.video-read\sample-64756aec81`；此前 0.3.0 接线初版曾因 `startRun/updateRun/finishRun` 签名不一致把成功记为 `error`，已改为 handle 制（`updateRun(handle, phase, patch)`、`finishRun(handle, {ok,...})`）并复测为 `done`。
- **未在浏览器内实测**：当前 Host 进程在新增 `dsh.client` 声明之前启动，client 模块图未组合本包（`/plugins/...` 返回 404、`settings.section` 占位无 `dsh-video-read`）；按 `dsh-client-modules` 的 `pkgMeta` 缓存逻辑，需重启 Host 后由页面加载新 bundle 才能看到面板。宿主侧行为已用 HTTP 全量验证。

### 2026-11-01 0.3.1 增量（yt-dlp 自动安装 / 通用站点兜底）

- **yt-dlp 自动安装实测**：读取 `registry.npmmirror.com/yt-dlp-static/latest` → tarball `77,608,276` 字节 → 校验 `dist.integrity`（sha512）通过 → 用 `tar.exe` 只解压 `package/bin/win/yt-dlp.exe`（`19,160,088` 字节）→ `--version` 输出 `2024.07.25` → 记录写入 `~/.dsh/cache/dsh-video-read/bin/yt-dlp.json`（含包名、版本、integrity、安装时间）。失败路径任一环节不通过都会删除可执行文件。
- **PyInstaller 临时目录**：直接 spawn 会报 `Cannot create temporary directory!`；改为子进程环境 `TEMP/TMP/TMPDIR=<cache>/tmp` 后正常。
- **通用解析实测**（离线集成脚本，临时）：`resolveYoutube('https://www.bilibili.com/video/BV1kvxF6zEDu', { kind:'yt-dlp', download:true })` → `title` 正确、`durationSec=62.733`、`width=360, height=640`、`hasAudio=true`、`source.mp4` 落盘。调试链：无 `--ffmpeg-location` 时 yt-dlp 只留下 `source.f30011.mp4` + `source.f30280.m4a`（未合并）；加 `--ffmpeg-location` 后遇到某个 B 站 CDN 镜像 `WinError 10061` 连接被拒；最终实现「首次失败自动换 codec 侧重试一次 + 清理残留分片」，两种格式侧重试后成功。
- **安全拦截实测**：`video_probe("http://127.0.0.1:9/video.mp4")` → `refusing to fetch a private address: 127.0.0.1`；`assertPublicHttpUrl` 单测覆盖 localhost / 127.0.0.1 / 192.168.x / 169.254.x / 非 http 协议共 5 个拒绝用例。
- **测试**：`m15-test.mjs` **37/37**（新增面板 ytdlp 开关、配置投影、URL guard）、`client-test.mjs` 15/15；`youtube.js` / `sources.js` / `panel.js` / `client.js` / `index.js` / `m15-test.mjs` 均 `node --check` 通过。
- **Host 内实测（热重载两次禁用→启用，均 applied）**：`GET /api/dsh-video-read/panel` → 200、`version=0.3.1`、`config.autoDownloadYtdlp=true`；B 站 `video_probe` 回归正常（17 条字幕、`route.declaredInputs=["text","image"]`）。
- **仍未闭环**：YouTube 本身在当前网络不可达，自动安装与通用解析只能对「网络可达的站点」生效；面板在浏览器中的最终视觉需要重启 Host 后确认。

### 2026-11-01 0.3.2 增量（直链媒体快速通道）

- **动机**：通用站点兜底依赖 yt-dlp，而实测 yt-dlp 对**直链 mp4** 会因站点风控/提取器策略返回 403（`media.w3.org` 的 Sintel trailer 即是），而这类 URL 完全不需要页面解析。
- **实现**：`lib/sources.js` 新增 `directMediaExtension(url)`（对 `.mp4/.webm/.mkv/.mov/.m4v/.flv/.avi/.ts` 判定，忽略 query）与 `resolveDirectMedia`：`assertPublicHttpUrl` 拒绝 localhost/私网 → 先按 fetch 默认头下载（带 idle/总超时与字节上限）→ 403 时自动用浏览器 UA 重试一次 → ffprobe 补全元数据 → 复用 `source.{ext}` 缓存并写 `source.json`。分发逻辑在 `directMediaExtension` 命中时优先于 bilibili/YouTube 分类。
- **403 经验**：同一 URL `plain GET → 200 video/mp4 (content-length 4372373)`，而带 Chrome UA + `accept:*/*` + `referer` 的 GET `→ 403 text/html`；因此默认头优先、UA 仅作重试，而不是无条件伪装浏览器。
- **Host 内实测（热重载两次禁用→启用，均 applied）**：`video_probe("https://media.w3.org/2010/05/sintel/trailer.mp4")` → `source.kind="direct"`；`video_read(fps=0.05, max_frames=2)` → 下载 4,372,373B、探测 `00:52.2 · 854x480 · audio=true`，返回 2 帧图片（首帧城堡场景、末帧 Sintel 片尾字幕卡），`notes` 含 “downloaded directly from the URL (no yt-dlp needed)”。
- **测试**：`m15-test.mjs` **41/41**（新增 4 个 `directMediaExtension` 用例：mp4 带 query、大小写、webm、非媒体 URL）、`client-test.mjs` 15/15；`sources.js` / `m15-test.mjs` `node --check` 通过。
- **面板回归**：`GET /api/dsh-video-read/panel` → `version=0.3.2`；`POST /api/dsh-video-read/config {"maxFrames":24}` → 200 且 `settings.json` 落盘（随后回写 32 复原），证明 `settings.json` 持久层在 0.3.2 下仍正常。
- **说明**：`video_probe` 对直链媒体默认只取元数据（不下载），因此 `durationSec=0`、`sizeBytes=null` 属预期；调用 `video_read`/`video_frames` 才会下载并补全。

### 2026-11-01 0.3.3 增量（安全加固 / 性能）

- **SSRF（重定向与 DNS）**：`lib/net.js` 的 `fetchWithDeadline` 新增 `validateUrl` 逐跳校验：手动跟随 3xx（最多 5 跳），每跳重新执行 `assertPublicUrlResolvesPublicly`；该函数在原来「IP 字面量/主机名」判断之外，对域名做 `dns.lookup(all)` 并拒绝解析到回环/私网/链路本地地址。`downloadToFile` 透传 `validateUrl`，直链媒体与通用站点入口都走这条路径；B 站 CDN 下载仍走 allowlist。
- **错误页伪装视频**：直链下载完成后读前 4KB，若以 `<`、`{`、`[` 开头（HTML/JSON）则删除并报错「the URL returned text (HTML/JSON) instead of video data」。
- **面板 CSRF**：`POST /api/dsh-video-read/config` 现在要求同源 `Origin`（跨站 403）且 `Content-Type: application/json`（否则 415），堵住「任意网页用 `no-cors` + 纯文本请求改写设置」的路径；`GET /panel` 同样拒绝跨站 `Origin`。响应附带 `X-Content-Type-Options: nosniff`。
- **yt-dlp 供应链**：解包后先校验 PE 头（`MZ`）与最小体积（≥5MB）再执行 `--version`，不满足即删除；所有传给 yt-dlp 的 URL 前加 `--` 终止选项解析（防 URL 被当作命令行选项）。
- **性能**：`describeCache()` 加 5s 记忆化，面板 2.5s 轮询不必每次递归 stat 缓存目录；实测同一面板 GET 首请求 ~67ms、次请求 ~1ms。
- **测试**：`m15-test.mjs` **50/50**（新增 IPv4/IPv6 私网分类、`assertPublicUrlResolvesPublicly`、重定向逐跳校验用例）、`client-test.mjs` 15/15；`net.js` / `sources.js` / `youtube.js` / `panel.js` / `m15-test.mjs` 均 `node --check` 通过。
- **Host 内实测**（热重载后，`http://127.0.0.1:64354`）：
  - `POST /config`：无 Origin → **403**（本轮收紧：写路由必须显式同源 Origin）；`Origin: http://evil.example` → **403**；同源 Origin → 200；`Content-Type: text/plain` → **415**；另补 `Host` 回环围栏：伪造 `Host: evil.example`（DNS rebinding 形态）→ **403**；
  - `GET /panel` 带跨站 Origin → **403**；
  - 直链媒体回归：`video_read("https://media.w3.org/2010/05/bunny/trailer.mp4", fps=0.02, max_frames=1)` → 下载成功、`00:33.0 · 853x480 · audio=true`、返回 1 帧（DNS/逐跳校验未破坏正常下载）。
- **残留风险（未闭环，属于设计边界）**：① yt-dlp 自身跟随重定向，插件无法逐跳拦截（初始 URL 已校验；通用站点场景存在残余 SSRF 面）；② npm 镜像二进制仅保证传输完整性，无法证明包作者身份（可用 `ytdlpPath` 指向自己信任的安装）；③ 面板可编辑 `cookieFile` / `ytdlpPath`，属于「本机用户已经在控制本机」的权限面，跨站写入已被同源校验阻断。

### 2026-11-01 0.3.3 复审加固（信任边界 / 私网分类 / 一致性）

第二轮对安全报告与正确性报告逐项落地：

- **面板信任边界（HIGH）**：两条路由新增 **Host 回环围栏**（`127.0.0.1` / `[::1]` / `localhost` 之外的 `Host` 一律 403，覆盖 DNS rebinding）；写路由 `POST /config` 的 Origin 由「可选」改为 **必需**（无 Origin 的本地/LAN 客户端不再能直接写配置）；跨站 Origin 仍 403。
- **私网分类（HIGH）**：`isPrivateAddress` 重写为 `net.isIP` + 完整 CIDR：补 `100.64/10`、`192.0.0.0/24`、`198.18/15`、`198.51.100/24`、`203.0.113/24`、`240/4`、组播，并把 IPv6 字面量展开为 8 个 hextet 后判定（`::ffff:7f00:1` 这类十六进制 IPv4-mapped 现在正确拒绝）。16 个边界用例全过。
- **面板可写键收缩（MEDIUM）**：`cookieFile` / `ytdlpPath` 移出可编辑集（它们会变成「写配置 → 执行 exe / 读任意本地文件」），面板提交这两个键会被 `ignored` 显式返回；仍需手改 `settings.json` / bundle patch。
- **yt-dlp 供应链（MEDIUM）**：registry 缺少 `dist.integrity` 时 **fail closed**（不再跳过校验直接执行）；tarball 必须与 registry 同域；下载走 `validateUrl`；解包前用 `tar -tvf` 校验目标成员是普通文件（拒绝符号链接/绝对路径）。
- **原子写（MEDIUM）**：`settings.json` 临时文件名带进程内自增序号 + `flag:'wx'` 独占创建，避免并发/跨进程写抢同一个 tmp。
- **缓存与一致性（HIGH/MED）**：直链缓存命中时重新做魔数检查（HTML/JSON 错误页或 kill 留下的半截文件会被删除并记为不可用），并用 `source.json` 的 `webpageUrl + bytes` 校验身份；多 P 越界仍抛错；B 站 `durl`：DASH 为空时回退 durl、多段 durl 明确报错而不是静默只下第一段；yt-dlp 遇到 playlist/合集 URL 明确报错（此前会把列表名与最后一集画面拼在一起）。
- **时间标签（HIGH）**：`even` 采样先把范围收到 `duration-1.4s` 再等距生成（不再事后改最后一个时间点导致整段标签偏移）；`nearestCue` 先取「覆盖该时刻」的字幕，再退回最近；probe/摘要的 `Origin:` 按 `kind` 显示 `bilibili` / `direct URL` / `yt-dlp` / `local file`。
- **其他一致性**：`maxFrames` 默认 32 → 16（与 schema/文档一致）；`quality` 默认 64 → 3 且三处硬编码 `quality:3` 改为读配置；grid 模式下不再逐帧附加图片（只附联系表），contact sheet 附加失败时不再清空逐帧图片；caption 与 attachFrames 改为有界并发（默认 3）；`video_cache prune ttl_days=0` 明确报错而不是静默不删；`video_digest` 的 `cueCount` 改为段内总数并新增 `shownCueCount`。
- **面板路由注册时机（404 根因修复）**：Host bundle 在启动早期 `apply` 时，`webServer` 服务往往还没组合出来，旧代码直接 `ctx.get('webServer')` 得到 `undefined` → 两条 `/api/dsh-video-read/*` 精确路由从未注册，浏览器面板只能看到 404/401。现在改为「有则立即挂载，否则 `ctx.inject(['webServer'], …)` 等服务出现再挂载」；Electron-only profile 永不挂载，但工具照常工作。客户端设置页本身仍受 DSH「client module 图在启动时组合」限制，首次出现需要重启 Host。
- **测试**：`m15-test.mjs` **56/56**（新增 blackdetect 解析用例；此前 52/52 含面板挂载用例：有 Web carrier 时注册两条路由、无 carrier 时 no-op）、`client-test.mjs` **15/15**；改动 JS 文件 `node --check` 全过。
- **Host 内实测**（热重载后）：
  - 面板：`GET /panel` → 200、`version=0.3.3`、可编辑键 21 个；无 Origin POST → 403、跨站 Origin POST → 403、伪造 Host POST → 403、同源 Origin POST → 200 且 `ignored=["ytdlpPath","cookieFile"]`；
  - 直链：`video_read("https://media.w3.org/2010/05/sintel/trailer.mp4", fps=0.02)` → `Origin: direct URL …`、末帧提前 1.4s 并注明；
  - B 站回归：`BV1kvxF6zEDu` → 17 条字幕、1080×1920、图片证据正常，缓存复用；
  - grid 回归：本地样例 `fps=2` → 13 帧拼成 4×4 联系表，无逐帧重复附图。
- **仍未闭环（记录为已知项）**：DNS 校验与连接分离（rebinding TOCTOU，需要 pin 解析 IP）；ffmpeg zip 兜底无完整性校验、允许关闭校验的开关仍在（默认 npm 路径有 sha512）；B 站 `durl` 多段合并、playlist 多集选择、yt-dlp 旧文件复用/无字节上限、字幕侧车匹配的次级问题（`a.mp4` vs `another.srt` 已修）、`video_ask` 去重与单字中文、digest 缺字幕原因提示等低频项仍待做。

### 2026-11-01 0.4.0 增量（模型适配 / 主动调用 / 时间轴 / 首尾黑边）

**1）三种模型怎么区分、怎么用**

插件不按模型名硬编码，而是每次调用时解析「当前会话路由」声明的 `inputModalities`（`llm.resolveModelInfo`）：

| 模型能力 | 推荐读法 | 说明 |
| --- | --- | --- |
| 纯文本（`text`） | `video_digest` / `video_ask`（+ `video_probe`） | 不下载视频、不花图片 token；只读字幕/弹幕/关键帧时间点 |
| 纯文本 + 配置了 `captionModel` | `video_read`（`captions="auto"`） | C1 视觉桥：抽帧后由 `ctx.llm.stream` 逐帧写中文描述，帧图仍附给调用方但文本模型只消费描述 |
| 图片+文本（`text,image`） | `video_read` / `video_frames mode="grid"` / `video_storyboard` | 帧作为 `image` block 返回，模型直接看图 |
| 声明 `video` 的多模态 | 同上 | DSH 内容块没有 `video` 类型，插件只能抽帧；`video_probe` 会注明内核无 video block |

`video_probe` 返回 `recommended.modelFit = {kind, use, captionModel, captionBridgeEnabled}`，Agent 可直接据此选工具。

**2）如何让 Agent 主动调用**

- 工具描述已改成触发式：出现「视频链接 / BV 号 / YouTube / mp4 / 看看这个视频」时优先调用 `video_probe`；`video_probe` 描述标了「FIRST」。
- 工程侧补充：在工作区 `AGENTS.md` 或项目说明里写「凡涉及视频链接或视频内容，先用 dsh-video-read」；经验是名称与描述里的场景词越具体，越容易被选中。
- 注意：DSH 不会「自动推荐」工具，是否调用最终取决于请求语义与工具描述的匹配度。

**3）图片要不要带时间轴**

- 已带：每帧文本标签 `[frame i/N] t=… subtitle=…`；联系表把 `HH:MM:SS` 烧进每格（row-major）；storyboard 输出 `[start–end]` 分镜区间。
- 原因：模型看多图是并行的，没有时间戳只能猜顺序；烧录后即使只看一张联系表也能读出先后与间隔。
- 单帧模式默认不烧录（文本标签已够，省一次编码），可开 `burn_timestamps`（目前 grid 生效）。

**4）首尾帧跳过与控制**

- 自动：`skip_black_edges="auto"`（默认）只对首尾各 3s 跑 `blackdetect`（近黑 `pix_th=0.10`，最短 0.05s），把黑边从采样范围裁掉，notes 写 `auto-skipped black edges …`。
- 显式：`trim_head` / `trim_tail`（秒，绝对位置）优先于自动裁剪；`skip_black_edges="never"` 关闭自动。
- 为什么不是「固定截掉前 1s」：开头常是台标/白闪/渐变，固定裁剪会误伤真实内容；亮度检测只裁真黑段，且只分析首尾 3s（约 2 次快速 seek）。
- 已知限制：检测不识别「非黑的片头/片尾」（logo、片尾字幕卡），用 `trim_head`/`trim_tail` 手动控制；检测结果按文件大小 + mtime 缓存 5 分钟（同一媒体重复调用不再重跑 ffmpeg）。

### 2026-11-08 0.4.1 增量（安全审计 / 主流插件兼容 / 边界加固）

**1）审计范围与结论**

- 审计对象：0.4.0 新增的 `lib/edges.js`、`lib/grid.js` 的 drawtext 路径、`index.js` 新增参数与配置读取、`lib/panel.js` 配置白名单。
- 结论：无命令注入（ffmpeg 全部 `spawn` 数组参数、无 shell；drawtext 文本只来自 `formatClock` 生成的时间戳，不拼接用户输入）；blackdetect 参数为内部数值常量，`parseBlackIntervals` 只解析 `[\d.]+`；无新增网络出口（edges 只对本地文件跑 ffmpeg）；面板仍保留 loopback Host + 同源 Origin + JSON Content-Type + 404/415/403 分层校验；`DSH_VIDEO_READ_FONT` 仅本地环境变量。
- 已知残余（不阻塞）：DNS 校验与连接分离（rebinding TOCTOU）仍未 pin IP；ffmpeg 4.1（2018）解码不可信媒体存在已知 CVE 风险；客户端设置页 bundle 在 Host 启动时组合，改动后需重启 Host 生效。

**2）本版修复**

- 附件上限对齐 DSH：`maxAttachImages` 默认值与硬上限从 32 降到 **20**（DSH `maxImagesPerMessage = 20`，超出的图在请求投影阶段也会被丢，等于白花 token）；面板白名单同步 1–20。
- 联系表尺寸一致性：某格时间戳烧录失败时，旧逻辑直接 `copyFile` 原图导致混合尺寸、`tile` 失败；现在失败格也统一 scale+pad（只是不带时间戳），notes 明确显示 `timestamps on X/N cells`。
- 首尾黑边检测 memo：按 `file + size + mtime + 参数` 缓存 5 分钟，同一缓存媒体重复调用不再重跑 2 次 ffmpeg；短片（短于头尾窗口）加 notes 提示窗口重叠。
- 抽帧策略自适应：`extractEven` 在「采样跨度 > (帧数 − 1) × 10s」时改为逐帧 seek（长视频只取少量帧时不再整段解码，实测 627s/8 帧 11.7s → 1.9s），短跨度仍走单遍解码（约 15× 快于逐帧）。
- 配置边界加固：`imageWidth` clamp 320–2560；`gridCellWidth` 160–640、`gridCellHeight` 120–480；`burn_timestamps` 对手工配置里的字符串 `"false"` 不再误当真（新增 `flag()` 严格布尔解析）；`maxCaptionFrames` 上限 8。
- 版本 0.4.1；`node --check` 全过；`m15-test.mjs` 60/60、`self-test.mjs` 36/36、`client-test.mjs` 15/15。

**3）与主流插件的兼容矩阵**

| 插件 | 可能的冲突面 | 结论 |
| --- | --- | --- |
| better-sidebar | 设置页槽位 / 侧边栏 | 无：本插件只注册 `settings.section` 的 `dsh-video-read`（order 140），不注册侧边栏；与 account / general / models / plugins / better-sidebar / web-ui-plugins / skin-center / pet / dsh-workshop / dsh-usage / wallpaper-engine 的 id 与 order 均不重复 |
| dsh-context / billion-context | 上下文压缩、工具结果裁剪 | 兼容：图片帧会按上游规则被折叠/压缩，但每帧文本带磁盘路径，可用 `read_image` 复读；长视频建议 `grid` 或 digest 以少占图片预算 |
| dsh-auto-router | 模型路由 | 兼容：每次调用实时解析当前路由 `inputModalities`，不缓存全局模型假设；跨轮切模型时下一步自动改走 caption/digest |
| dsh-token-steward | token 预算 | 兼容：默认 20 图上限 + grid 联系表是主要省 token 手段；未改动全局预算 |
| dsh-media-desk | 媒体页面 / 路由 | 无：对方使用 `/media-desk` 前缀，本插件使用 `/api/dsh-video-read/...` 精确路由，无路径重叠 |
| genui / wallpaper-engine / pet / usage / guizang-design | 客户端 UI 槽位 | 无：本插件只占 `settings.section` 一个 id |
| 其它工具插件 | 工具名 | 无：全 profile 内 `video_probe / video_read / video_frames / video_digest / video_ask / video_scenes / video_shots / video_storyboard / video_cache` 均未被占用 |

> 说明：冲突检查基于「工具名、HTTP 路由、客户端槽位 id/order」三类共享资源穷举；功能层面没有替代关系（media-desk 是媒体工作台，本插件是给 Agent 读视频的工具集）。

## 仓库与许可

- 源码仓库：<https://github.com/Kuest10n/dsh-video-read>

### 2026-11-14 0.5.1 增量（可访问性 / 错误韧性 / 性能与反馈）

**1）错误码体系（错误韧性）**：全部用户可见失败路径挂结构化 `error.code`（`E_FFMPEG_MISSING` / `E_YTDLP_MISSING` / `E_RISK_CONTROL` / `E_NEEDS_COOKIE` / `E_VIP_CONTENT` / `E_PRIVATE_URL` / `E_DRM` / `E_TOO_LONG` / `E_SEGMENTED` / `E_PLAYLIST` / `E_NO_SPRITE` / `E_FILE_NOT_FOUND` / `E_DOWNLOAD` / `E_BILIBILI_API`）；`finishRun` 把 `errorCode` 写进进度文件，面板把「码 + 中文提示」一起显示；README 新增排查表（见上文）。无字幕返回显式原因枚举 `no-subs / needs-cookie / fetch-failed`，note 写明「画面正常，只是没有词」（借鉴 dsh-video-storyboard #77 的用户误解教训）。

**2）面板（设计美学 + 可访问性）**：配置拆三组 fieldset（阅读预算 / 下载与辅助模型 / 产物与缓存），布尔项整行可点、触控目标 24px；字段级校验（非法值即时标红 + `aria-invalid` + `role=alert` 错误节点），保存失败聚焦第一个错误项，无修改/校验失败/保存中禁用保存，新增「放弃未保存修改」；进度条改为原生语义（有字节进度显示确定百分比 + `aria-valuetext="45% · 下载视频"`，无进度显示不定态样式，不再伪装固定 28%），`prefers-reduced-motion` 下关闭过渡；危险清理保持「预览 → 明确文案确认」，确认/取消后焦点返回触发按钮；轮询改自适应（运行 2s / 空闲 15s），后台标签页暂停不变。

**3）进度全覆盖（性能与反馈）**：`video_probe` / `video_digest` / `video_ask` / `video_shots` 全部接入 startRun/updateRun/finishRun，阶段补齐 `resolving / probing / captions / danmaku`；运行记录带视频 `title`，面板显示标题而不是裸 URL。

**4）正确性与兼容修复**：yt-dlp 全部调用加 `--ignore-config`，防止用户全局 `yt-dlp.conf`（如 `--embed-subs`）破坏固定 CLI 契约（dsh-video-storyboard #91 同款问题）；`video_shots` 裁切质量改走 `cfg.quality`；`video_probe`/`video_digest` 等工具 `source` 描述补全 YouTube/直链支持；`video_frames` 的 `times`（超 32 抽稀而非拒绝）与 `captions`（auto 仅在"无图模态且已配 captionModel"时生效）描述与实际行为对齐；`video_scenes` 描述写明无切点时的中点回退；`lib/progress.js` settings 读取加 5s memo、`describeWorkspaceCache` 加 5s memo 且清理后主动失效，面板轮询不再每秒打盘。

**5）验证**：`node --check` 全过；`m15-test.mjs` 60/60、`client-test.mjs` 22/22、`panel-test.mjs` 20/20、`self-test.mjs` 36/36；真机回归见下。
- 提交市场索引：`dsh-community-plugins` 的 `community.json`（id `dsh-video-read`，repo 指向上面的仓库）
- 许可证：Apache License 2.0，见 [LICENSE](LICENSE)
- 问题反馈：<https://github.com/Kuest10n/dsh-video-read/issues>

