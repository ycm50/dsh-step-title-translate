# dsh-step-title-translate

把对话里每一次工具调用那一行的**标题、描述与报错**经 Bing 翻译后**就地替换显示**，按 `Alt+T` 立刻切回原文。

> 代码 · Verify tunnel reaches Windows RustDesk
> → 代码 · 验证隧道进入 Windows RustDesk

参考官方实验包 `@deepseek-ai/dsh-experimental-cot-translation-bundle`（把展开的思考内容经 Bing 翻译），
本插件把同一套「Bing 匿名翻译 + 可切回原文」的思路用在**工具调用行**上。

## 为什么是覆盖显示而不是改写数据

工具行由 `@deepseek-ai/dsh-client-ui-tool` 的 `ToolCallTree` 用 keyed slot `tool.call.toolview` 渲染，
每个工具名对应一张卡片；行文字来自 `t('tool.title.code')` 与参数推导出的 summary。要换文字只有两条路：

1. 按工具名逐个 keyed 覆盖 —— 只能覆盖已知工具，且**改不到** summary（它由 `toolRowModel` 内部推导），
   并且 `apply_patch` / `ask_user_question` 这类卡片会被整体替换，风险高；
2. 在渲染完成后，对行内被「描绘」的文字节点做一次替换 —— 不改变任何插件、不改变 Session 数据、不改变模型输入。

本插件走第 2 条：行文字由 `TextShimmer` 用 `data-shimmer-text` 属性 + CSS `content` 绘制，
所以替换的是那个属性（没有该属性的旧式纯文本节点则替换 `textContent`），并把原文写进 `title`，
鼠标悬停即可对照原文。React 重渲染会把属性写回原文，`MutationObserver` 会重新套用译文。

## 它做什么 / 不做什么

| 做 | 不做 |
| --- | --- |
| 翻译工具行标题（`代码` / `运行命令` …，可关）、描述，以及**失败行的报错与失败输出** | 不改 Session 日志、不改模型上下文 |
| 报错里的**堆栈帧逐字保留**（只翻帧前的说明文字） | 不翻译代码块、终端输出、diff、工具结果正文 |
| echo 的句子立刻回原文，备用引擎在后台补译，下一轮自动取用 | 备用引擎不再阻塞整批请求 |
| 结果缓存在 Host 内存（6 小时、2000 条、总字符预算 200k），同一句只请求一次 | 不落盘、不跨进程持久化 |
| 长报错按 1200 字符切片、跨行合批（浏览器侧每批 ≤ 8 段 / ≤ 6000 字符；Host 侧上限 24 段 / 24000 字符） | — |
| `Alt+T` 一键原文/译文切换 | 不翻译展开后的终端输出、diff、文件内容 |
| 目标语言：简体 / 繁体 / 英 / 日 / 韩 / 俄 | 不对模型调用任何服务 |
| 代理可选（中国大陆网络通常需要） | 不把你机器的 DNS/证书策略强加给其它插件 |
| **思考行**（`data-variant="think"`）也翻 | 不翻译展开后的思考正文 |
| 每行右侧有**「译」按钮**，只补这一行没翻的内容 | 点它不会展开/折叠该行 |
| Bing 原样回传原文时自动换备用引擎 | 备用引擎只接 echo 的句子，不是默认通道 |

发送到 Bing 的只有行标题与描述文本本身（可能包含文件路径），点「保存」前请知悉。

## 逐行「译」按钮

折叠状态下的每一行，只要还有没翻成目标语言的内容，行尾就会出现一个小的「译」按钮
(data-stt-ui="row-action"，由插件自己创建，不经过 React)。它解决两类「看起来没翻译」的情况：

- **Bing 原样回传原文**(echo)。例如 `Dump composed test profile config` 这类短句，Bing 会把它原封不动返回，
  旧版把这种结果当成译文缓存，于是那行永远停在英文。现在 echo 不再进缓存，自动流程会单独重试一次，
  再不行就交给备用引擎(MyMemory 匿名接口，只对 echo 的句子生效)。
- **自动流程放弃的句子**(失败到上限、或退避等待中)。点一下「译」会清掉该句的缓存、失败计数、退避与排队任务，
  立刻向接口重新要一次，不等下一轮扫描。

按钮行为：

| 情况 | 表现 |
| --- | --- |
| 行里还有未翻译的英文 | 显示「译」，光标悬停行或键盘聚焦时高亮 |
| 刚点过、请求在路上 | `→` + 「已重新请求」，1.2 秒后回到常态 |
| 正在请求(自动或手动) | 旋转箭头 + 「翻译中…」，不重复入队 |
| 连续失败 | 变红显示 `!`，悬停提示「上次失败原因：…」（HTTP 码 / 代理拒绝 / 请求超时） |
| 行里已经全翻完(或本来就是中文/路径/标识符) | 按钮消失 |

点击只会落到按钮自己身上：`pointerdown` / `mousedown` / `touchstart` / `pointerup` / `mouseup`
全部 `stopPropagation`，click 与 Enter / Space 走 document 上的捕获期代理，行折叠状态不变
(测试里用 `__toggles` 计数验证为 0)。代理而不是绑在按钮上，是因为 React 会在按下与抬起之间重渲染
表头把按钮换掉——绑在旧节点上的 `click` 会随之丢失，这正是「有时候点了没反应」的来源。

### 失败与重试

- 请求 22 秒不返回就中止（`AbortController`），按钮不再无限「翻译中…」；
- 失败不封顶：按 3 秒、6 秒、12 秒… 退避自动重试（上限 60 秒一次），代理恢复后行会自己好；
- 连续失败 3 次后按钮变红（`MAX_FAILURES`），但**仍会按上面的退避继续重试**——变红只是提示，不是封禁；
- 失败任务立刻从队列释放，下一次点击从零开始，不会卡在填了一半的任务上；
- 浏览器侧只保留最近 2000 条译文、1000 条失败/退避记录（`CACHE_LIMIT` / `META_LIMIT`），长时间会话不会无限涨。

### 并发与背压

浏览器一次只开一个请求（客户端 `pump()` 是串行的），但多个标签页、或点了「译」之后的自动重试，仍可能同时打过来。Host 侧因此有几道闸：

- **出站并发上限 4 路**（`MAX_INFLIGHT_REQUESTS`）。超出的请求在队列里等一个空位，最多等 `BUSY_WAIT_MS`（当前 5 秒），等不到就立刻回 `{ ok:false, code:"busy" }`，浏览器按普通失败处理并退避重试。**等待是有界的**：不会为了拿一个槽位拖满 20 秒的出站预算。
- **相同批次去重**。同一组文本在同一时刻只会发出一次请求，后到的调用者直接 await 前一个的结果，缓存也只写一次。
- **代理 agent 也有上限**（`AGENT_LIMIT`，当前 4 个）。按代理地址做 LRU，被淘汰的 agent 会连同它的 keep-alive 隧道一起销毁，不会因为用户反复改代理而堆积。

> 这些闸门的值（4 路 / 5 秒 / 4 个 agent）以 `lib/index.js` 的 `MAX_INFLIGHT_REQUESTS`、`BUSY_WAIT_MS`、`AGENT_LIMIT` 为准，可能随上游额度调整。

**备用引擎（refinement）的压力边界**：Bing 若把原文原样回传（echo），这些句子不会占着请求不放——先把 echo 立刻返回浏览器，再由后台单独问 MyMemory 补译。后台补译有**自己独立的预算**：

- 独立并发上限 `REFINE_MAX_INFLIGHT`（当前 2），与上面的 4 路前台槽位**分开计**：出站总并发最多 `MAX_INFLIGHT_REQUESTS + REFINE_MAX_INFLIGHT`。
- 后台补译**永远不占前台槽位**，所以一批 echo 再多也不会让 `/translate` 返回 `busy`；反过来，前台也不会把补译饿死。
- 拿不到补译槽位时**直接跳过**该句（下一轮请求会再试），不排队——补译只是锦上添花，不值得为它拖延。
- 每批最多 `FALLBACK_MAX_TEXTS`（当前 4）条，超出部分只回 echo、不补问；单条预算 `FALLBACK_TIMEOUT_MS`（当前 4 秒），远短于 Bing 的 20 秒。
- 补译任务登记在插件的 `background` 集合里，卸载时统一等待收尾，不会往已卸载插件的缓存里写。

> 上面这些数字以 `lib/index.js` 的 `REFINE_MAX_INFLIGHT`、`FALLBACK_MAX_TEXTS`、`FALLBACK_TIMEOUT_MS` 为准。

## 安装

包目录：`A:\Downloads\dsh-step-title-translate`（已含构建产物 `lib/`，无需构建）。

在本会话使用的 desktop profile 里已经登记（`dsh.profile.bundles` + `cordis.patch.yml`），**重启 DSH 生效**。
手动安装到任意 profile：

```bash
dsh plugin --profile <profile> add dsh-step-title-translate@file:A:/Downloads/dsh-step-title-translate
```

然后在 profile 的 `package.json` 的 `dsh.profile.bundles` 里加一行 `dsh-step-title-translate`。

## 配置

插件页 → 已安装 → **dsh-step-title-translate** → 行配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 启用翻译 | 开 | 关掉等于停用（不装包也行） |
| 同时翻译工具类型标题 | 开 | 关掉只翻描述（`代码` / `运行命令` 这类短词保持原样） |
| 同时翻译报错与失败输出 | 开 | 只处理 `data-state="error"` 的行；关掉则报错区域一律保留原文 |
| 目标语言 | 简体中文 | 简体 / 繁体 / 英 / 日 / 韩 / 俄 |
| HTTP 代理 | 空 | 例 `http://127.0.0.1:10808`。**留空时依次读环境变量** `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy`，有值就走它（适配 `NODE_USE_ENV_PROXY=1` 的启动方式）；都没有才直连。显式填写会**覆盖**环境变量 |

设置保存在 `$DSH_HOME/step-title-translate.json`，与 profile patch 的 `config` 合并（文件优先），保存后立刻生效。

也可以在 profile 的 `cordis.patch.yml` 里直接写：

```yaml
- id: step-title-translate
  config:
    enabled: true
    targetLanguage: zh-Hans
    translateTitle: true
    proxy: "http://127.0.0.1:10808"
```

## 快捷键

`Alt+T`：在「原文」与「译文」之间切换（同一页面全局生效，切换时不重新请求）。

## 实现

### Host 半侧（`lib/index.js`）

在 `webServer` 上注册四个精确路由，全部只接受 loopback + POST：

| 路由 | 作用 |
| --- | --- |
| `/api/dsh-step-title-translate/config` | 读取合并后的设置 |
| `/api/dsh-step-title-translate/config/set` | 原子写入 `$DSH_HOME/step-title-translate.json` |
| `/api/dsh-step-title-translate/translate` | 一次最多 24 段、总长 24000 字符的批量翻译；超出回 `ok:false` + `too-many-texts`/`text-too-long`/`batch-too-large` |
| `/api/dsh-step-title-translate/health` | 诊断：设置 + 缓存条数 |

四个路由的请求体都有上限：超过 `MAX_BODY_BYTES`（当前 512 KiB）回 **HTTP 413** + `{ ok:false, code:"body-too-large" }`；超过 `MAX_BODY_DRAIN_BYTES`（当前 2 MiB）仍在往里灌的，直接断开连接（客户端看到的是网络错误）；一个请求体从开始读到读完最多 `READ_BODY_TIMEOUT_MS`（当前 10 秒），慢速滴灌会被掐断。

翻译走 Edge 匿名端点 `https://edge.microsoft.com/translate/translatetext`：

```text
POST /translate/translatetext?to=zh-Hans&isEnterpriseClient=false
content-type: application/json
user-agent: <浏览器 UA —— 缺了它端点直接 400 "Client Browser Version not supported">

["Verify tunnel reaches Windows RustDesk", "..."]
→ [{"detectedLanguage":{...},"translations":[{"text":"验证隧道进入Windows RustDesk",...}]}, ...]
```

代理用自己实现的 `CONNECT` 隧道 Agent（`node:http`/`node:https`/`node:tls`），
**不依赖 undici**，也不会被别的插件装的全局 dispatcher 影响。

### Client 半侧（`lib/client.js`）

1. 启动时 POST `/config`，拿不到设置就保持静默（旧 Host / 行被禁用时不报错）；
2. `MutationObserver` 监听 body（防抖 160ms），收集 `[data-tool]` 与 bash 示例行
   （排除思考块 `[data-variant="think"]`）里 `[data-disclosure-header]` 的叶子文本；
3. 失败行（`data-state="error"`）额外收集 `[class*="ioText"]` / `[class*="errorSummary"]` 等承载报错的叶子，
   但**排除** `pre/code`、终端卡、diff 正文、代码体；
4. 跳过已含目标语言、纯标识符、`路径 + 1KB` 这类大小后缀、JSON/标签开头、超长（>20000 字符）的片段；
   报错文本先按 `/(^|\n)[ \t]+at[ \t]/` 切成「说明 + 堆栈帧」，只发说明，帧原样拼回；
5. 长文本按 1200 字符切片（优先在换行/空格处断开），**跨行合批**后 POST `/translate`：
   每批 ≤ 8 段、累计 ≤ 6000 字符（首段不受字符预算限制，所以一批至少 1 段），
   远低于 Host 的 24000 上限，不会再触发 `batch-too-large`；
6. 套用时记录「原文 / 已套用译文」，React 重渲染回原文后能识别并重新套用；`Alt+T` 时整体还原；
   **并记住该节点原本的 `title`**，还原时把宿主自己的 tooltip 写回去（没有就删掉），不会吃掉上游的悬停提示；
7. 连续失败 3 次后不再自动重试该段（按钮转红提示），点「译」可强制重来；
8. 每次扫描顺带回收已经离开 DOM 的行记录（`pruneState()`，单次检查上限 `PRUNE_MAX` 个节点），
   避免长会话里 `records`/`pings` 拖着已卸载的节点不放。

## 已知限制

- 折叠行的文字在 React 里被 `TextShimmer` 用属性描绘，替换的是该属性；未来若上游改成别的绘制方式，
  「跳过条件」需要跟着调整（`readText`/`writeText` 是唯一读写出入口）。
- 只覆盖对话内的工具行；终端卡片展开后的输出、diff 正文、代码块不翻译（翻译会破坏对齐与语法）。
- 报错里的堆栈帧虽然逐字保留，但**帧前的 message** 会被翻译，类名/函数名可能被改写大小写。
- 翻译可能改变标点与专有名词大小写（Bing 会照抄 `RustDesk` 之类），原文始终在 `title` 与 `Alt+T` 里。
- 匿名端点不保证额度与可用性；失败时保持原文并静默重试（下一次扫描）。
- 中国大陆直连该端点通常被重置（`ECONNRESET`），请在插件页填代理。
- 并发超过 4 路时，多出来的请求会拿到 `busy` 而不是排队干等；这是有意的背压，不是故障。
- 响应体被中途截断（代理抖动、连接被重置）时，本次翻译算失败并走退避重试，不会挂住浏览器。

## 开发

- 源码即产物：`lib/index.js`、`lib/client.js` 手写，无构建步骤。
- 探测/测试脚本不入库，统一放在 `./tmpscripts`（已被 `.gitignore` 忽略）；具体文件与覆盖范围**以 TESTS.md 为准**，本文不列举文件名。
- 测试 profile：`~/.dsh/profiles/stt-clean`（`--port 58903`），用 `dsh --profile stt-clean --no-open --port 58903` 启动。
  该 profile 只装 `dsh-base` + `dsh-web-app` + 本插件，不引入任何其它第三方插件；
  插件配置一律写**默认值**（`proxy: ""`，走环境变量代理），所以它验证的是代码默认行为，而不是某台机器的偏好。