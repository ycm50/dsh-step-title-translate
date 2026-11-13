# 测试清单（全量）

> 由插件作者维护，**全局测试**时按本清单逐条执行，**只跑一次**。
> 更新测试列表时再逐条重写。测试 profile：`stt-clean`（`dsh --profile stt-clean --no-open --port 58903`）。
> 该 profile 只装 `dsh-base` + `dsh-web-app` + 本插件，配置全为默认值；跑之前请先确认 `$DSH_HOME/step-title-translate.json` 不存在（它会覆盖 profile patch）。
> 非项目脚本一律放在 `./tmpscripts`，不入库。

## A. 静态检查

| # | 项目 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| A1 | Host 与 Client 语法 | `node --check lib/index.js` / `lib/client.js` | 均无输出、退出码 0 |
| A2 | Host 模块可加载 | `node -e "import('file:///…/lib/index.js').then(m=>Object.keys(m))"` | 导出含 `apply`、`inject`、`translateBatch`、`FALLBACK_TIMEOUT_MS` |
| A3 | 客户端 JSX 运行时依赖 | 检查 `lib/client.js` 只 `require("react")` 与 `"react/jsx-runtime"` | 无第三方依赖 |

## B. Host 桥接（`/api/dsh-step-title-translate`）

| # | 项目 | 方法 | 通过标准 |
| --- | --- | --- | --- |
| B1 | `/config` 可读 | POST `{}` | `ok:true`，含 5 个设置字段 |
| B2 | `/health` | POST `{}` | `ok:true`，返回 settings 与 cache 计数 |
| B3 | `/translate` 基本翻译 | POST 中英混排 8 条 | 8 条全部返回、均含中文 |
| B4 | `/translate` 唯一文本连发 | 20 轮×8 条不重复文本 | 20/20 成功，单轮 < 10 s |
| B5 | `/translate` 并发 | 14 路并发（14 组不同文本） | 每路 `ok:true` 或 `ok:false, code:"busy"`；**`busy` 必须在 ~5 s 内返回**（`BUSY_WAIT_MS`），不得拖到出站预算（20 s）；成功路数 ≥ 1 且无异常挂起 |
| B6 | echo 不阻塞整批 | 提交 3 条会被 Bing 原样回传的标识符 | 整批在 ≤ 8 s 内返回（旧版需等 MyMemory 20 s） |
| B7 | echo 二次请求走缓存 | B6 之后 6 s 再请求同一批 | ≤ 2 s 返回 |
| B8 | 非法请求被拒 | 缺 `texts`、超过 24 条、单条 > 4000 字符、总数 > 24000 字符、请求体 > 512 KiB | 前四项 `ok:false` 且 code 分别为 `texts-required`/`too-many-texts`/`text-too-long`/`batch-too-large`；超体积请求体回 **HTTP 413** + `code:"body-too-large"` |
| B8b | 并发超限被快速拒绝 | 同时发 14 路、让前 4 路的出站被拖住 | 超出的路在 ~5 s 内返回 `ok:false, code:"busy"`，不是 20 s |
| B9 | 非 POST 被拒 | GET `/config` | HTTP 405 |
| B10 | 代理非法值 | `proxy: "ftp://x"` | `ok:false`，code `proxy-unsupported` |
| B11 | 设置往返 | `/config/set` 改 targetLanguage 再读回 | 读回一致，随后恢复原值 |
| B12 | `/config/set` 并发写 | 4 路并发写不同字段 | 4/4 `ok:true`；落盘文件可 `JSON.parse`；`/config` 读回的值与磁盘一致；`$DSH_HOME` 下无残留 `*.tmp` |
| B13 | `TunnelAgent` 握手超时 | 假代理回 `200 Connection Established` 后不再说话，起 1 路翻译 | 在 `REQUEST_TIMEOUT_MS`（20 s）内以 `tunnel-handshake-timeout` 失败；进程 socket 数在 ~20 s 内回落，不随请求次数线性增长 |
| B14 | `postJson` 响应截断 | 本地 https 桩：发头 + 部分 body 后 destroy socket，连发 40 次 | **40/40 全部 settle**（`translation-aborted`），无一个永久 pending；连发 120 次后 heap 不线性增长 |
| B15 | 请求体慢速滴灌 | 声明大 `Content-Length`，每 200 ms 发 64 B | 连接在 `READ_BODY_TIMEOUT_MS`（10 s）左右被服务端掐断，不会一直占着 socket |

## C. Client 行为（DOM 桩，`tmpscripts/test-stt-client3.mjs`）

| # | 项目 | 通过标准 |
| --- | --- | --- |
| C1 | 自动翻译 | 两行英文在 1 次请求内全部变中文，按钮消失 |
| C2 | 失败可见 | 连续失败后按钮变红 `!翻译这一行`，tooltip 含 `上次失败原因：` |
| C3 | 点击有反馈 | 点击后立即出现 `→已重新请求`（`data-pinged`） |
| C4 | 点击不误伤折叠 | 全程行折叠计数为 0 |
| C5 | 恢复后点击生效 | 网络恢复后点击 → 翻译完成、按钮消失 |
| C6 | 僵死请求超时 | 挂起的请求在 ~22 s 内结束，按钮退出「翻译中…」 |
| C7 | 超时后自动重试 | 超时后自动再次进入「翻译中…」 |
| C8 | 路径/标识符不翻 | `intercom\src\main.cpp` 保持原文 |
| C9 | 宿主 tooltip 还原 | 给叶子预置 `title="host-tip"`，翻译后按 `Alt+T` | 还原后 `title` 回到 `host-tip`（不是 `null`）；原本无 `title` 的叶子还原后仍无 |
| C10 | 缓存与记录有界 | 连续灌 8000 段不重复文本 | `state.cache.size` 不超过 `CACHE_LIMIT`；已 detach 的行被 `pruneState()` 回收，`records`/`pings` 不随行数线性增长 |

## D. 真实页面（headless Chrome + `stt-fixture2.js`）

| # | 项目 | 通过标准 |
| --- | --- | --- |
| D1 | 页面加载无异常 | Console 无 exception |
| D2 | 行内就地翻译 | `data-shimmer-text` 变为中文，原英文仍在 tooltip |
| D3 | 行尾按钮注入 | 有未翻内容时出现，全翻完消失 |
| D4 | 点击经 document 代理生效 | 按钮重渲染后点击仍然触发（fixture 每次点击都重建按钮亦有效） |
| D5 | 按钮不触发展开 | `__toggles` 计数为 0 |
| D6 | Alt+T 还原原文 | 按 Alt+T 后行文字回到英文，再按恢复译文 |

## E. 打包与集成

| # | 项目 | 通过标准 |
| --- | --- | --- |
| E1 | `package.json` 字段 | `main`/`exports`/`files`/`dsh.bundle.patch`/`dsh.client.platform` 齐全 |
| E2 | `files` 覆盖产物 | 清单里的 4 个文件都存在 |
| E3 | profile 组合 | `dsh --profile stt-clean --dump-config` 含 `step-title-translate` 行，无解析错误 |
| E4 | 干净 profile 启动 | 全新 profile 启动后 `/health` 返回 `ok:true` |
| E5 | 无残留全局副作用（Host） | 卸载（关闭）后不残留路由/样式（进程退出即清） | 四路由 disposer 全部执行；`agents` 清空且 `destroy()` 到位；`cache` 清空 |
| E5b | 无残留全局副作用（Client） | 在 DOM 桩里挂载 → 卸载 → 再挂载 → 再卸载 | 每次卸载后 `document` 上的**监听器数为 0**（`keydown`/`click` 捕获期代理都解绑）；`MutationObserver.disconnect()` 次数 == 挂载次数；重挂载后功能仍生效（`state.disposed` 已复位） |

## 判定

- 全部 A–E 通过 = 可以提交/发布。
- 任一失败：记录编号与现象，修完后**只重跑失败项**。
