# 企业微信 × Codex 桥接

把企业微信当成 Codex 的聊天入口：你在企微（个人微信里也能收到）发消息，本机调用
`codex exec` 在指定工作目录里干活，结果以**流式打字机效果**推回企微。
支持按用户选择项目（或「无项目」模式）、多轮续接上下文。
支持文字和语音消息：语音由企业微信先转成文字再回调，**仅限单聊**。

**零第三方依赖**，只用 Node 内置模块（Node ≥ 20），不需要 `npm install`。

## 两种接入方式

| 方式 | 是否需要公网 | 加解密 | 说明 |
|---|---|---|---|
| **长连接（推荐）** | ❌ 不需要 | 不需要 | 本机主动 `wss://` 外连企微，内网/家用宽带都能跑 |
| 回调 URL | ✅ 需要 HTTPS 公网地址 | 需要 AES 验签 | 适合部署在云服务器；本地要内网穿透 |

两条路的调度逻辑完全共用（`src/bot.js`），只有传输层不同。

```
你在企业微信/个人微信发消息
        │
        ▼
企微服务器 ──WebSocket 长连接──▶ 本机 src/longconn.js
                                   │ 1. aibot_subscribe（BotID + Secret）鉴权
                                   │ 2. aibot_msg_callback 收到你的消息
                                   │ 3. 跑 codex exec --json -C <项目目录>
                                   │ 4. aibot_respond_msg 流式回推（finish=true 收尾）
                                   ▼
                              你在企业微信收到
```

## 一、企微后台准备（长连接）

1. 企业微信管理后台 → 智能办公 → 智能机器人 → **API 模式机器人**
2. 连接方式选 **长连接**，拿到 **Bot ID** 和 **Secret**
3. 把这两个值填进 `config.json` 的 `wecom.longconn`

个人主体（无营业执照）就能注册团队并开通，权限门槛比回调低。

> ⚠️ **每个机器人同一时间只能有一条有效长连接**。新连接会踢掉旧连接，
> 被踢的那条会收到 `disconnected_event`。所以**不要同时开两份**。
> 代码里检测到被踢会主动停止重连，避免两边互相踢。

## 二、配置

```bash
cp config.example.json config.json
open -e config.json          # 或 nano / vim / code
chmod 600 config.json        # 里面有 Secret
```

只需要改这几项：

```jsonc
{
  "wecom": {
    "mode": "longconn",
    "longconn": {
      "botId": "aibxxxxxxxxxxxxx",
      "secret": "xxxxxxxxxxxx"
    }
  },
  "projects": {
    "source": "codex",                  // 直接读 Codex 自己的项目列表（默认）
    "roots": [],                        // 只给 source=scan/both 用，默认留空
    "list": []                          // 想手动加/改名就写这里
  },
  "security": {
    "allowedUsers": []                  // 留空=所有人可用；填了则只有这些 userid 可用
  }
}
```

`allowedUsers` 里的 userid 怎么拿？先随便发一条消息，服务端日志会打印 `[bot] <- <userid> ...`。

也可以用环境变量覆盖，避免密钥落盘：
`WECOM_BOT_ID`、`WECOM_BOT_SECRET`、`CODEX_BIN`。

### 让 Codex 能联网

默认 `codex.networkAccess: false`：每个 run 都在 `workspace-write` 沙箱里，**不能联网**。
遇到需要外部信息的问题（分析某家公司、查文档、抓网页），模型只能退回去用
computer-use 驱动你的浏览器——一次网页操作要 60 秒上下，一个问题能拖到 6 分钟。

打开它：

```jsonc
"codex": { "networkAccess": true }
```

等价于给每次 `codex exec` 加 `-c sandbox_workspace_write.network_access=true`。
只影响机器人触发的 run，不动你交互式 Codex 的设置。想反过来在全局开，就写
`~/.codex/config.toml`：

```toml
[sandbox_workspace_write]
network_access = true
```

⚠️ **开之前先把 `security.allowedUsers` 填上。** 空数组 = 谁能给机器人发消息，
谁就能在你电脑上跑命令；再加上能联网，风险是叠加的。

怎么确认生效：跑一条需要联网的消息，然后看会话文件里的 turn_context：

```bash
grep -o '"network_access":[a-z]*' ~/.codex/sessions/2026/09/29/rollout-*.jsonl | tail -1
# 期望看到 "network_access":true
```

### 机器人说话多少

只发结果、不刷屏，是默认行为：

| 配置 | 默认 | 作用 |
|---|---|---|
| `codex.showAck` | `true` | 开始处理时先推一行 `▶ 已收到 · 项目 X · 新会话` |
| `codex.keepaliveMs` | `60000` | 处理中每隔这么久把那一行刷成 `⏳ 正在处理… 3m12s`；`0` 关闭 |
| `codex.streamProgress` | `false` | 是否把 Codex 跑的每条命令（`$ /bin/zsh -lc '...'`）也推过来 |
| `codex.transport` | `app-server` | `app-server` 常驻进程并流式返回；`exec` 每次起进程、只发最终结果 |
| `codex.streamDeltas` | `true` | 是否把模型逐字增量推进同一条微信消息 |

推的那一行 ack 不是"多出来的一条消息"：它和最终结果**共用同一条消息**，
结果出来后会原地替换掉。所以保留它，你既能马上知道"收到了"，
长任务也有个"正在干活"的指示；不想要就 `"showAck": false`。

`streamProgress` 默认关掉，是因为那些命令行又长又密，在聊天窗口里很吵。
想在手机上看长任务进度，把它设成 `true` 即可（目前只在 `exec` 模式下生效）。

`transport: "app-server"` 会保留一个常驻的 Codex 进程，把
`item/agentMessage/delta` 实时推进同一条流式消息：模型一开始写，聊天里就能
看到文字逐步出现，而不是等整段生成完才一次性弹出。`exec` 模式没有增量事件，
只能等最终结果。app-server 启动失败时会自动回退到 `exec`，不影响可用性。

`keepaliveMs` 解决的是另一个问题：一个任务可能跑十几分钟，中间聊天窗口完全没动静，
你会以为它卡住了。它做的事只是**把那一行 ack 原地刷成计时器**，不新增任何消息：

```
▶ 已收到 · 无项目 · 新会话          ← 刚开始
▶ 已收到 · 无项目 · 新会话
⏳ 正在处理… 1m00s                  ← 同一行，60 秒后
▶ 已收到 · 无项目 · 新会话
⏳ 正在处理… 2m00s                  ← 还是同一行
<最终结果>                          ← 结果直接替换掉上面全部
— 无项目 · 13m02s
```

不想要这个计时器就 `"keepaliveMs": 0`；连 ack 也不想要就 `"showAck": false`
（这时 keepalive 也一并失效，真正做到「只发结果」）。

日志侧同样能看出在不在跑：

```
[bot] <- WenZhiLi (single/text) "帮我分析一下福赛科技"
[bridge] run started · WenZhiLi · 无项目 · "帮我分析一下福赛科技"
[bridge] run finished · WenZhiLi · 13m02s · session 01a0ec39-… · 97 events
```

看到 `run started` 没有对应的 `run finished`，才是真的在跑；两条都不见，
说明消息根本没进来。

### 项目列表从哪来

默认 `projects.source = "codex"`：**直接读 Codex 桌面版自己的项目列表**，
所以 `/projects` 列出来的、以及 `/use 3` 里的序号，跟你 Codex 侧栏里看到的**一模一样**
（包括你手动拖动排过的顺序）。

数据来自 `~/.codex/.codex-global-state.json` 的 `local-projects` + `project-order`：

```jsonc
"local-projects": {
  "7c04cf12-…": { "name": "茄子生活flutter", "rootPaths": ["/Users/you/…/flutter_qiezi"] }
},
"project-order": ["7c04cf12-…", …]   // 侧栏顺序
```

| `projects.source` | 行为 |
|---|---|
| `"codex"`（默认） | 只读 Codex 的项目列表；`roots` 为空时不做任何磁盘扫描 |
| `"codex"` + 非空 `roots` | 只读 Codex 的项目列表；万一读不到，才退回扫 `roots` |
| `"scan"` | 只扫 `roots`，找 git 仓库 |
| `"both"` | Codex 项目在前，磁盘上扫到的排在后面 |

几个细节：

- Codex 项目里路径已经不存在（仓库被删/移走）的会被跳过，不会让你选到一个死目录。
- 项目有多个 `rootPaths` 时取第一个，桥接只在一个目录里跑 Codex。
- `projects.list` 里的条目永远排在最前面，同名路径会覆盖 Codex 里的名字，
  适合"我就想给它起个别名"。
- 状态文件不在默认位置（比如另一个 Codex 配置目录）时，用 `projects.codexStateFile` 指定。

### 关于 `codex.bin`

默认 `"codex"` 会先查 `PATH`，查不到再自动探测常见位置，包括
`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`（ChatGPT 桌面版自带 CLI）。

为什么需要：Codex 桌面版会给自己的子进程注入 PATH，所以**在它的会话里
`which codex` 有结果，但在你自己的终端里没有**，直接 `spawn codex` 会 `ENOENT`。
自动探测就是为这个场景加的，启动时会打印实际用到的路径。

想长期稳定，建议装独立 CLI：

```bash
npm i -g @openai/codex
```

## 三、跑起来

```bash
# 1. 自检（不需要企微、不需要联网）
npm run selftest            # 加解密 / XML / 参数构造 / 二进制解析 / WebSocket 帧编解码
npm run simulate            # 回调模式端到端
npm run simulate:longconn   # 长连接模式端到端（假 WebSocket 驱动完整协议）

# 连不上时用这两个，输出贴回来即可定位
npm run diagnose            # 代理 → DNS → TCP → TLS → HTTP 升级，逐层定位
npm run probe               # 原始 TLS 逐条对比请求头，找出服务端到底要什么

# 2. 先在终端里试一把（可选但推荐）
npm run chat
#   和企微机器人共用同一套逻辑，回复打到终端。
#   用来确认「工作目录选择 + Codex 调用」这半边没问题。

# 3. 启动
npm start                   # 长连接（推荐）
npm run start:callback      # 回调 URL 模式
```

正常启动会看到：

```
WeCom long-connection × Codex bridge
  ws url    : wss://openws.work.weixin.qq.com
  bot id    : aibakj8N…
  projects  : 22 discovered
  projects  : 18 discovered (Codex 项目列表)
  codex bin : /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex (candidate)
[longconn] connected, sending aibot_subscribe
[longconn] subscribed, receiving callbacks
[bot] ready · 22 projects · sandbox workspace-write
```

## 四、怎么用

直接发消息就是提问，`/` 开头是命令：

| 命令 | 作用 |
|---|---|
| `/projects` | 列出可选项目（序号与 Codex 侧栏一致） |
| `/use <序号\|名称>` | 切换项目（会自动开新会话） |
| `/none` | 切到**「无项目」模式**：不绑定任何仓库，在临时目录里干活 |
| `/p` | 查看当前工作目录和会话 |
| `/new` | 开新会话，丢弃上下文 |
| `/stop` | 中断当前任务，清空排队 |
| `/status` | 看运行状态和并发占用 |
| `/help` | 帮助 |

典型流程：

```
你：/projects
机器人：可选项目（共 3 个）：1. alpha-api ... 2. beta-web ...
你：/use 2
机器人：已切换到项目：beta-web
你：登录接口为什么返回 401？
机器人：▶ 已收到 · 项目 beta-web · 新会话
        `$ rg "401" src/`            ← 流式刷新，同一条消息原地更新
        <Codex 的完整回答>
        — beta-web · 43s
```

**「工作目录」和「会话」是两件事**：工作目录是代码在哪儿干活，选定后一直生效；
会话是对话上下文，`/new` 或切换工作目录才重开。所以每条消息的 ack 会明确写
`新会话` 还是 `继续会话`，避免误以为一直在重开。

同一用户同一工作目录，下一条消息用 `codex exec resume <sessionId>` 继承上下文。

### 不想绑定项目？用「无项目」模式

`/none` 会让 Codex 在一个**不绑定任何仓库**的目录里干活，默认是
`~/.codex/wecom-scratch`（可用 `codex.scratchDir` 改）：

```
你：/none
机器人：已切换到「无项目」模式，之前的会话上下文已清除。
        Codex 会在一个不绑定仓库的目录里工作：/Users/you/.codex/wecom-scratch
        现在直接发消息就行；想回到某个项目发 /use <序号>。
你：帮我把这段 JSON 转成 YAML
机器人：▶ 已收到 · 无项目 · 新会话
        ...
        — 无项目 · 6s
```

适合"跟代码无关"的活儿：写脚本片段、整理文本、查资料、算东西。目录不存在会自动创建，
沙箱仍然是 `workspace-write`，所以 Codex 只会在这个临时目录里写文件。
发 `/use <序号>` 随时切回项目。

## 五、协议实现要点

来源：`developer.work.weixin.qq.com/document/path/101463`

| 项 | 实现 |
|---|---|
| 连接 | `wss://openws.work.weixin.qq.com` |
| 鉴权 | `aibot_subscribe`，body `{bot_id, secret}` |
| 收消息 | `aibot_msg_callback` → `msgid`/`chatid`/`chattype`/`from.userid`/`msgtype`；文字 `text.content`，语音 `voice.content` |
| 收事件 | `aibot_event_callback` → `enter_chat`/`disconnected_event`/… |
| 回复 | `aibot_respond_msg`，**透传回调的 `req_id`** |
| 流式 | `msgtype:"stream"` + `stream.id` + `finish`，10 分钟内收尾 |
| 主动推送 | `aibot_send_msg`（单聊填 userid / 群聊填 chatid，`chat_type` 1/2） |
| 心跳 | `{"cmd":"ping"}`，30 秒 |
| 限流 | 每会话 30 条/分钟、1000 条/小时 |

几个容易踩的点，代码里都处理了：

- **响应帧没有 `cmd`**，只能靠 `headers.req_id` 匹配。按 `cmd` 解析会把订阅响应丢掉，
  导致永远不 ready。
- **Node 的 HTTP/TLS 客户端栈跟这台服务器合不来**：curl 拿得到 `101`，
  Node 内置 WebSocket 报 `non-101 status code`，换 `https.request` 发同样的字节
  则得到 `404`。但把**一模一样的报文用 `tls.connect` 手写出去就是 `101`**。
  用 `npm run probe` 复现过，结论很干净。所以桥接自带了一个最小 RFC 6455 客户端
  （`src/ws-client.js`，仍然零依赖），**直接建 TLS socket、手写握手报文**，
  中间不留任何会被 Node 改写的一层。
- **Node 内置 WebSocket 握手失败时只触发 `error`，不触发 `close`**。
  重连若只挂在 `close` 上，连不上就永久卡死。测试里专门盯了这个。
- **分片消息（continuation 帧）必须能和多帧同批到达**：解析器遇到「本帧不完整」
  和「消息还没拼完」是两回事，混淆会把同批后续的帧一起卡住。
- **流式内容是「整体替换」而不是追加**，每次推送都要给完整内容。
- **流式通道不可用时要停止推送，而不是退化成一条条消息**：`aibot_respond_msg`
  失败（req_id 过期、触发限流）时，如果每条更新都补一条 markdown，聊天窗口里
  会刷出一屏气泡。现在一旦发现通道不可用，就停止中间推送，只在结束时发一条结果。
- **`disconnected_event` 不能自动重连**，否则两边会互相踢成死循环。
- **心跳的应答必须清掉超时定时器**：服务端是回一个带 `req_id` 的普通响应，
  会被通用的 pending 匹配分支吃掉，根本走不到 `case 'pong'`。不在匹配处清定时器，
  连接完全健康也会每 20 秒「心跳超时」重连一次，无限循环。
- **群聊文本带着 `@机器人` 前缀**，转发给 Codex 前要剥掉。
- **语音消息由企微先做语音识别**，回调里拿到的已经是文字（长连接 `voice.content`，
  回调 XML 是 `Recognition`），不需要再接第三方 ASR。官方限制**语音仅支持单聊**；
  收到的语音字段名会打一行 `[bot] voice keys=...` 日志，字段有变时一眼能看出来。
- **markdown 上限 20480 字节**，超长回复按行边界切分，不切坏代码块。
- **流有 10 分钟上限**，接近上限会主动收尾，剩余内容改走普通消息。注意「收尾」只是
  关掉那条流式消息，**不是结束任务**：真正跑十几分钟的任务，结果会另起一条普通消息
  送达。这里踩过一个坑——收尾时若把整轮标记成 finished，`finish()` 会直接 return，
  结果就静默丢了。测试里专门盯了这条（`a run longer than the stream limit still
  delivers its result`）。

## 六、安全，请务必看一眼

这个服务本质上是**把你的终端交给企微消息控制**。

1. **默认 `workspace-write` 沙箱**，Codex 只能在当前工作目录里写（项目目录，或
   `/none` 模式下的 `codex.scratchDir`）。
   只有在一次性虚拟机/容器里，才考虑打开 `codex.bypassApprovalsAndSandbox`。
2. **强烈建议设置 `security.allowedUsers`**，否则任何能找到这个机器人的人都能让你
   的电脑跑命令。
3. `config.json` 含 Secret，已加进 `.gitignore`，建议 `chmod 600`。
4. 会话状态存在 `data/state.json`（含工作目录和会话 id），也在 `.gitignore` 里。

## 七、开机自启（macOS）

改一下 `deploy/com.wecom.codex-bridge.plist` 里的路径，然后：

```bash
cp deploy/com.wecom.codex-bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.wecom.codex-bridge.plist
launchctl list | grep codex-bridge
tail -f /tmp/wecom-codex-bridge.log
```

plist 里显式设了 `PATH`，因为 launchd 不会继承你 shell 的环境。

## 八、排查

| 现象 | 原因 |
|---|---|
| `Invalid config: ... still the example placeholders` | 还没填 Bot ID / Secret |
| 启动后一直 `socket error` + `reconnecting` | 网络/代理/DNS 问题。跑 `npm run diagnose` 逐层定位（它会打印真实失败原因） |
| 握手被拒（4xx）但 curl 能拿到 101 | 跑 `npm run probe`：对比 curl / 原始 TLS / Node https 三条路径 |
| `server refused the upgrade: HTTP 403` | 不是握手问题，是服务端明确拒绝，把整段 diagnose 输出贴出来 |
| `subscribe rejected: 40001 ...` | Bot ID 或 Secret 不对 |
| 日志出现 `kicked: another connection subscribed` | 你开了两份，或别处也连了同一个机器人。只能留一份 |
| `heartbeat timed out` 每隔 pongTimeoutMs 循环一次 | 已修的老 bug（心跳应答没清定时器）。更新后重启即可 |
| 收到消息但没回复 | 看服务端日志；多半是 Codex 侧报错（日志里有原始 stderr） |
| 回复「请先选择工作目录」 | 正常，先 `/projects` 再 `/use`，或者发 `/none` 用无项目模式 |
| 报错 `spawn codex ENOENT` | 已自动探测常见位置；仍失败就把 `codex.bin` 写成绝对路径 |
| 回复很慢 | Codex 在跑真实任务，属正常；可调大 `codex.timeoutMs`（默认 30 分钟） |
| 长回复被拆成多条 | 超过 20480 字节，按行边界切分，属预期行为 |

### 关于重启和「第一条消息慢」

- 改了 `src/` 下的代码或 `config.json` 之后**必须重启进程**：Node 在启动时把模块和配置
  读进内存，运行中改文件不会生效。只改 README、测试脚本则不需要。
- 重启后第一条消息的桥接侧开销只有 app-server 启动 + 会话恢复，实测约 **0.1–0.2 秒**。
  现在启动时会**预热 app-server**（日志 `[appserver] warmup complete in ...ms`），
  这部分不再落到第一条消息上。
- 真正决定首条速度的是**模型首包**。看日志里这两行就能分清：

  ```
  [appserver] resumed thread 01a1... in 62ms     ← 会话恢复，很快
  [bridge] first token · WenZhiLi · 6s           ← 模型首包，慢在这里
  ```

  如果 `resumed thread` 很快、`first token` 很慢，瓶颈在模型或中转站，不在桥接。
- 重启后的第一次请求没有服务端 prompt cache，历史很长的会话首包会明显更慢；
  同一会话后续通常快一些。历史太长可以 `/new` 开新会话，或换更快/更稳的模型通道。

## 九、目录结构

```
src/config.js          配置加载与校验（按 mode 分支）
src/longconn.js        长连接协议：帧构造 + 连接/订阅/心跳/重连
src/longconn-bot.js    入站回调 → Bridge 的分发（去重、剥 @、欢迎语）
src/longconn-main.js   长连接入口（npm start）
src/ws-client.js       自实现的 RFC 6455 WebSocket 客户端，基于原始 TLS socket（长连接的传输层）
src/transport.js       send / openStream 抽象；长连接·webhook·终端三种实现
src/bot.js             命令解析、工作目录切换、并发队列、中断
src/codex.js           调 codex exec，解析 --json 事件流，抓 session id
src/bin-resolver.js    codex 可执行文件定位（含自动探测）
src/wecom-crypto.js    回调模式：验签 + AES-256-CBC 加解密
src/wecom.js           XML 解析、长文本分片、webhook / 应用消息推送
src/app.js             回调模式请求处理
src/server.js          回调模式入口（npm run start:callback）
src/projects.js        项目发现（扫描 git 仓库）
src/sessions.js        每个企微用户的会话状态持久化
scripts/               selftest / simulate / chat / diagnose / probe
scripts/lib/           诊断用的公共工具（手写握手报文）
```
