# SillyTavern Multiplayer — V1 执行计划

> 状态：已批准，按里程碑顺序执行。
> 范围：`sillytavern-multiplayer-relay`（中继）与 `sillytavern-multiplayer-plugin`（酒馆扩展）两个仓库。
> 决定日期：2026-07-11

## 1. 目标与非目标

**目标**：2–6 位朋友的私密联机房间。每人跑自己本地的 SillyTavern；客人提交文字行动提案，房主审核后写入自己的本地聊天并独家调用 AI 生成；中继只负责房间成员、邀请、事件排序和断线重连。

**V1 明确不做**：附件、语音、房主迁移、P2P 生成、自动写入客人的原生酒馆聊天、酒馆服务端插件形态的外壳（推迟到 V2）。

## 2. 核心架构决定：单内核、双外壳

中继不做两条代码路径，而是一份纯逻辑内核 + 两个部署外壳：

```text
sillytavern-multiplayer-relay/
├── src/core/              纯逻辑：协议、RoomManager、RoomStore 接口、事件日志
│   ├── protocol.ts
│   ├── room-manager.ts
│   ├── room-store.ts      存储接口 + 内存实现（V1）
│   └── config.ts          配置类型定义（由外壳注入，core 不读 env）
├── src/standalone.ts      外壳 A：VPS 模式（Docker + Caddy 终止 TLS）
└── src/local.ts           外壳 B：Windows 房主本地直跑（配隧道，不要求 Docker）
```

**内核纪律（评审时逐条检查）**：

1. `core/` 不直接读 `process.env`，配置全部由外壳注入。
2. `core/` 不假设 TLS 存在、不假设进程长寿命、不出现任何 Docker/Caddy/路径假设。
3. 存储只通过 `RoomStore` 接口访问；V1 用内存实现，接口设计为可替换 SQLite。
4. 协议支持从快照重建房间（本地模式重启后可恢复）。

**客户端零感知**：插件只认一个 relay URL。邀请码内编码 `{v, relayUrl, roomId, token}`，客人粘贴一个码即可入房，部署模式对客人完全不可见。

**隐私不变量（任何里程碑不得违反）**：中继永远不接收 API key、隐藏角色数据、世界书内容、本地文件路径。共享文本仅为重连而临时保存，须有明确的保留期限。

## 3. 里程碑

### M0 — 中继仓库重构为双外壳（当前第一步）

- [ ] 抽出 `src/core/`：迁移 `protocol.ts`、`room-manager.ts`，新增 `room-store.ts` 接口 + 内存实现、`config.ts` 配置类型。
- [ ] `src/standalone.ts`：现有 VPS 入口改为薄外壳（读 env → 构造 config → 启动 core），Docker/Caddy 配置保持可用。
- [ ] `src/local.ts`：本地入口，默认监听 `127.0.0.1`，首次启动自动生成并持久化 creator key（免去 Windows 用户手配 env）。
- [ ] `start-relay.bat`：Windows 双击启动（检测 node → npm install → 运行 local 外壳）。
- [ ] **验收**：两个外壳都能启动；`/health` 正常；`relay.ping` 走 WS 收到 ack；`core/` 内 grep 不到 `process.env`。

> 命令词汇表的唯一权威见插件仓库 `docs/V1-PLAN.md` 第 2 节（以插件 `src/protocol.js` 的既有命名为准）；relay 侧 `src/core/protocol.ts` 必须与其逐字一致。插件侧的模块细化计划也在该文档（阶段 P0–P2 对应本计划 M1–M4）。

### M1 — 房间与邀请

- [ ] 命令：`auth.hello` / `room.create` / `room.join` / `room.leave` / `room.kick`（kick 仅房主）。
- [ ] 邀请码：编码 `{v, relayUrl, roomId, token}`（base64url JSON），token 高熵、有过期时间、可单次或限次使用。
- [ ] 角色模型：host / guest，写操作服务端强制校验角色。
- [ ] 成员事件广播：加入、离开、掉线、重连。
- [ ] **验收**：两个浏览器客户端可通过邀请码进入同一房间并互相看到成员变化；非房主调用房主命令被拒绝。

### M2 — 共享时间线、提案队列与重连

- [ ] 事件日志：房间内单调递增 `seq`，中继是排序的唯一权威。
- [ ] 命令：`proposal.submit` / `proposal.withdraw`（客人）、`proposal.accept` / `proposal.reject` / `story.message.publish`（仅房主）、`sidechat.message.post`（所有人）、`generation.start` / `generation.progress` / `generation.finish`（仅房主，生成状态广播）。
- [ ] 重连：客户端带最后已知 `seq` 请求 `room.resume`，中继返回快照 + 增量；`opId` 幂等去重。
- [ ] 保留策略：共享文本保留期限可配置（默认建议 72h 或房间关闭即清）。
- [ ] **验收**：断网重连后时间线无缺失、无重复；提案被拒后不出现在故事时间线。

### M3 — 插件客户端（客人体验）

- [ ] `relay-client.js`：连接、指数退避重连、心跳、`opId` 生成。
- [ ] `room-store.js`：本地只读投影（成员、时间线、提案队列、副聊天），按 `seq` 应用事件。
- [ ] `ui.js`：扩展面板——粘贴邀请码入房、提案编辑器、故事时间线视图、副聊天、房主的提案审核队列。
- [ ] **验收**：客人全流程（入房 → 提案 → 看到房主接受后的故事推进 → 副聊天）不触碰酒馆原生聊天。

### M4 — 房主桥接（最脆弱层，单独成段）

- [ ] `host-bridge.js`：全部通过 `SillyTavern.getContext()` 访问酒馆 API，不 import 内部模块。
- [ ] `publishAcceptedAction()`：把已接受的提案作为用户侧消息写入房主选定的本地聊天。
- [ ] `generateReply()`：房主端触发生成，完成后把 AI 回复镜像到共享时间线。
- [ ] 一致性：房主对消息的编辑/删除/swipe 通过显式"重新同步"操作反映到时间线（V1 不做自动监听）。
- [ ] 版本护栏：`manifest.json` 的 `minimum_client_version` 严格维护；`getContext()` 缺少所需 API 时给出明确报错而非静默失败。
- [ ] **验收**：完整一局——客人提案、房主接受、AI 生成、全员看到回复；房主酒馆升级一个小版本后插件仍工作或明确报错。

### M5 — 加固与文档

- [ ] 限流（每连接命令频率）、消息体积上限、房间数/成员数上限。
- [ ] 协议版本协商：`v` 不匹配时的明确错误与升级提示。
- [ ] 文档：Windows 本地模式教程（cloudflared 一条命令出公网 wss 地址；Tailscale 备选）、VPS 部署教程、故障排查。
- [ ] core 单元测试：协议解析、seq 排序、幂等去重、快照重建。
- [ ] **验收**：一位不懂运维的 Windows 用户能照文档独立开房。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 酒馆内部 API 变动打断 host-bridge | 只走 `getContext()`；版本护栏；M4 单独隔离该层 |
| 房主单点（掉线即停摆） | V1 接受此限制；事件日志 + 快照使重开成本低；房主迁移留待 V2 |
| 客人投影与房主真实聊天不一致 | `seq` 全序 + `room.resume` 全量重同步兜底；房主编辑走显式重同步 |
| 本地模式仍需隧道，配置劝退 | M5 文档给 cloudflared 一条命令方案；V2 再考虑自动拉起隧道 |
| 两外壳行为漂移 | 纪律 1–4 + 验收里对两外壳跑同一套冒烟测试 |

## 5. 执行顺序

M0 → M1 → M2 → M3 → M4 → M5，严格串行。M2 完成前不动插件 UI（协议先稳）；M4 放在 M3 之后，保证桥接调试时客人链路已可用作观察端。
