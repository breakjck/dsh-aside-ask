# 旁问 · dsh-aside-ask

> 在对话记录里圈出一段，**右键**，直接问一个小问题。答案由一条旁支子对话给出，不打断主对话。

[DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）的插件。

对话进行到一半，看到一句想追问的话——直接问，主对话就被推向新话题了；不问，又怕漏掉。旁问给这种情况留一个出口：把那段话圈出来，在旁边问一句小的，问完继续原来的事。

```
主对话 ────●──────────────────────────●──────────▶
           │ 选中一段                  │ 下次开口时带上
           └─▶ 旁支子对话 ──┐           │ 一条折叠记录
                （fork）   └── 答案 ────┘
```

## 效果

1. 用鼠标选中对话里的一段文字（你之前发的、或我已经答完的回复都可以）。
2. 在**选中的字上**右键。
3. 右下角弹出旁问框：上面是圈出的那段话，下面一个输入框。
4. 输入问题，`Ctrl+Enter`（macOS 上 `⌘+Enter`）或点「问」。
5. 答案出现在右下角的卡片里，可以复制、可以单条关掉。

主对话不受影响：不新增轮次、不打断正在跑的任务、不会因为你在旁边问一句就换话题。

## 它为什么不打断

三处设计合起来才成立，任何一处换掉都会"漏"进主对话：

| 做法 | 换成别的会怎样 |
| --- | --- |
| 旁支用 `fork` provider 起子会话 | 用 `spawn` 也行，但旁支不知道你们刚才在聊什么，只能看圈出的那一段 |
| `delivery: 'caller'`，不设 `'parent'` | `'parent'` 会在旁支结算后向主会话追加完成通知，**到达空闲主会话时会触发一次独立模型请求**——主 agent 会开口说话 |
| 回流走 `agent/pre-step` 钩子 | 用 `agent.inject` 要求主会话此刻有活着的 agent，且只在下一次 pre-step 生效；钩子对之后任何一次恢复的会话都成立 |

答完之后，主对话在**下一次真正发请求时**才会收到一条折叠记录（圈出的内容、问题、答案），追加进上下文、也进 KV 缓存，但不会唤醒空闲的主 agent、不制造多余的一轮输出。记录长这样：

```
[旁问] 用户在主圈出一段内容，另开了一条旁支问了一个小问题，已经答完。
这条只是记录：不必回应它，也不要据此改变当前任务；和正在做的事相关时可以作为参考。

圈出的内容：…
问题：…
旁支回答：…
```

细节见 [`docs/DETAIL.md`](docs/DETAIL.md)。

## 安装

### 前置条件

- **DSH 0.2.2-rc.5 或更高**（本插件就是在这个版本上开发并验证的；更低版本没测过）。
- profile 里要有子代理能力：`@deepseek-ai/dsh-subagent`，以及本地 provider `@deepseek-ai/dsh-subagent-fork-in-process`（默认 profile 自带；缺了 fork 会退回 `spawn`，功能仍可用）。
- 不需要 `npm install`：本插件没有第三方运行时依赖，只用到 DSH 自带的服务。

### 步骤

**1) 克隆到你喜欢的位置**

```powershell
git clone https://github.com/breakjck/dsh-aside-ask.git
cd dsh-aside-ask
```

**2) 在 DSH 里安装这个 bundle**

DSH 的插件管理走 agent 的 `plugin_manager`。新开一个会话，把下面这句连同你的实际路径粘给它：

```text
用 plugin_manager 把下面这个目录作为插件 bundle 安装：
<你克隆下来的目录，例如 D:\code\dsh-aside-ask>
（action 用 install_bundle，target 填这个绝对路径）
```

装成功后应该看到类似输出：

```
+ dsh-aside-ask 0.1.0 <- D:\code\dsh-aside-ask
{"stage":"enable","target":"dsh-aside-ask","enabled":true,"application":"applied"}
```

**3) 刷新页面**

在 DSH 窗口里按 `Ctrl+R`。客户端那一半（右键菜单、旁问框）要页面重载之后才会被加载——宿主那一半已经热生效了，页面不会自己带上新的客户端模块。

**4) 确认装好了**

让 agent 执行 `plugin_manager` 的 `list_plugins`，列表里应该有：

```
id: include:aside-ask    moduleName: dsh-aside-ask    enabled: true    fiberPhase: active
```

`fiberPhase` 是 `active` 才算真跑起来了。也可以看自检日志（Windows）：

```powershell
Get-Content "$env:TEMP\dsh-aside-ask-boot.log" -Tail 3
```

出现 `aside-ask host applied (pid …)` 说明宿主半已加载、依赖服务都解析到了。

### 卸载

```text
用 plugin_manager 卸载 dsh-aside-ask（action 用 remove_bundle，target 填 dsh-aside-ask）
```

卸完刷新一次页面。

## 验证清单

装完按这个顺序自查，能定位到具体哪一层没通：

| 现象 | 说明哪一层没通 | 处理 |
| --- | --- | --- |
| 右键什么都没弹 | 客户端半没加载 | 页面没刷新（按 `Ctrl+R`）、或 `fiberPhase` 不是 `active` |
| 右键弹的是浏览器原生菜单 | 手势没接管：右键点没落在选区的矩形内 | 先选中文字，然后在**加亮的那几个字上**右键，不要点在旁边的空白处 |
| 弹出框但右下角什么都没有 | 覆盖层没挂上 | 同上，先确认客户端半已加载 |
| 卡片里红字「这个会话当前没有在运行，无法旁问」 | 宿主拿不到活着的 agent | 等主会话这一轮跑完再右键；或确认插件 `active` |
| 卡片里红字里有 `fork` 字样 | 两个 provider 都起不来 | profile 里确认 `@deepseek-ai/dsh-subagent-fork-in-process` / `-spawn-in-process` 存在且启用 |

## 已知限制

- 只接管"有选区时的右键"。没选中文字时右键行为不变（原生菜单照旧）。
- 旁问记录在内存里。答完之后、主对话下一次开口之前如果重启了应用，这条记录会丢（旁支会话本身还在，可以继续）。
- 旁支用主会话当前的模型与工具，成本大约是一次短对话。
- 同时最多 8 条旁支（受子代理 `maxActiveSubagents` 约束）。
- 用到的 `agent/pre-step`、`ctx.connection.fetch`、`ctx.subagents` 是 DSH 的插件 API，DSH 大版本升级时可能变；升级后如果坏了，看上面的验证清单。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主半：`POST /api/aside-ask`，起 fork 子会话、流式回答案、把记录排进主会话下一次 pre-step |
| `client.js` | 客户端半：接管 `contextmenu` 手势，旁问框与答案卡放在 `shell.overlay` |
| `cordis.patch.yml` | 往 profile 里插一行 `aside-ask` |
| `locale/zh.json`、`locale/en.json` | 插件列表里的名字与说明 |
| `docs/DETAIL.md` | 用法、回流记录样例、实现取舍 |
| `icon.svg` | 插件列表图标 |

改完代码怎么重载：宿主半用 `plugin_manager` 把 `include:aside-ask` 禁用再启用（不用重启应用）；客户端半改完按 `Ctrl+R`。

## 兼容性

| DSH 版本 | 状态 |
| --- | --- |
| 0.2.2-rc.5 | 已验证 |

## 许可

[MIT](LICENSE)
