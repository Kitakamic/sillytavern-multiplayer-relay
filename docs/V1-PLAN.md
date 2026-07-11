# SillyTavern Multiplayer — V1 执行计划

> 状态：已批准，按里程碑顺序执行。
> 范围：`sillytavern-multiplayer-relay`（中继）与 `sillytavern-multiplayer-plugin`（酒馆扩展）两个仓库。
> 决定日期：2026-07-11

## 1. 目标与非目标

**目标**：2–6 位朋友的私密联机房间。每人跑自己本地的 SillyTavern；客人提交文字行动提案，房主审核后写入自己的本地聊天并独家调用 AI 生成；中继只负责房间成员、邀请、事件排序和断线重连。

**V1 明确不做**：通用附件（M2.5 的卡片/头像资产通道是唯一例外）、语音、房主迁移、P2P 生成、触碰客人自有的聊天与角色数据（插件自建的托管镜像聊天除外，见插件计划 P3）、酒馆服务端插件形态的外壳（推迟到 V2）。

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

**隐私不变量（任何里程碑不得违反，2026-07-11 修订）**：中继永远不接收 API key 与本地文件路径（无任何例外）。角色卡与世界书数据默认同样不接收；唯一例外是房主对单个房间**显式开启分享**的卡片资产（见 M2.5），且中继只做临时中转、到期即删。共享文本仅为重连而临时保存，须有明确的保留期限。

## 3. 里程碑

### M0 — 中继仓库重构为双外壳（✅ 完成于 2026-07-11）

- [x] 抽出 `src/core/`：迁移 `protocol.ts`（并补入与插件对齐的 `CommandType` 词汇）、`room-manager.ts`，新增 `room-store.ts` 接口 + 内存实现、`config.ts` 配置类型、`server.ts` 服务构造。
- [x] `src/standalone.ts`：现有 VPS 入口改为薄外壳（读 env → 构造 config → 启动 core），Docker/Caddy 配置保持可用；默认监听 `0.0.0.0`（修复了 .env.example 中 `HOST=127.0.0.1` 导致容器内 Caddy 连不上的隐患）；拒绝空/占位 creator key 启动。
- [x] `src/local.ts`：本地入口，固定监听 `127.0.0.1`，首次启动自动生成并持久化 creator key 到 `data/local-relay-state.json`（已加入 .gitignore）。
- [x] `start-relay.bat`：Windows 双击启动（检测 node → npm install → build → 运行 local 外壳）。
- [x] **验收**：两个外壳均通过 `scripts/smoke.mjs`（/health、`relay.ping` ack、未知命令拒绝）；`src/core/` 内 grep 不到 `process.env`。
- 备注：Windows 有保留端口段会导致 `listen EACCES`（`netsh interface ipv4 show excludedportrange protocol=tcp` 可查，本机 3007–3106 等段被占）；默认端口 3001 通常安全，M5 故障排查文档需收录此条。

> 命令词汇表的唯一权威见插件仓库 `docs/V1-PLAN.md` 第 2 节（以插件 `src/protocol.js` 的既有命名为准）；relay 侧 `src/core/protocol.ts` 必须与其逐字一致。插件侧的模块细化计划也在该文档（阶段 P0–P2 对应本计划 M1–M4）。

### M1 — 房间与邀请（✅ 完成于 2026-07-11）

- [x] 命令：`auth.hello` / `room.create` / `room.join` / `room.leave` / `room.kick`（kick 仅房主）。`auth.hello` 颁发 `{clientId, sessionToken}` 恢复凭据，重连时携带即可恢复身份与房间席位（掉线保留席位，广播 offline/online 在线状态事件）。
- [x] 邀请码：`room.create` 的 ack 返回 `inviteToken`（24 字节随机、base64url），由插件侧拼装成 `{v, relayUrl, roomId, token}` 邀请码；有效期 `inviteTtlHours`（默认 24h，封顶于房间过期时间），限次使用（`maxRoomMembers - 1` 次）。V1 每房一码、不支持重新签发。
- [x] 角色模型：host / guest；`room.kick` 服务端校验 host 角色，非房主返回 `FORBIDDEN`。密钥/令牌比较恒定时间（sha256 + timingSafeEqual）。
- [x] 成员事件广播：`room.member.joined` / `room.member.left`（含 kicked 原因）/ `room.member.offline` / `room.member.online` / `room.closed`，全部写入房间事件日志（带 seq）后向在线成员扇出。事件与错误码词汇表见插件仓库 V1-PLAN §2.1。
- [x] **验收**：`scripts/smoke.mjs` 双客户端全流程——建房、邀请码往返、入房互见成员与在线状态、错误密钥/令牌被拒、客人越权 kick 被拒（FORBIDDEN）、掉线→offline 广播、凭恢复凭据重连→online 广播、踢人通知被踢者、房主离房→room.closed→房间不可再加入。
- 备注（V1 决定）：房主显式 `room.leave` 即关房（掉线不关房，接受"房主单点"限制）；房间过期采用访问时惰性清理；被踢者若邀请码仍有剩余次数可重新加入，V1 接受（限次+有效期兜底）。

### M2 — 共享时间线、提案队列与重连（✅ 完成于 2026-07-11）

- [x] 事件日志：房间内单调递增 `seq`，中继是排序的唯一权威（M1 已建；M2 全部内容事件入同一日志）。
- [x] 命令：`proposal.submit` / `proposal.withdraw`（客人；withdraw 仅限作者本人）、`proposal.accept` / `proposal.reject` / `story.message.publish`（仅房主）、`sidechat.message.post`（所有人）、`generation.start` / `generation.progress` / `generation.finish`（仅房主）。提案状态机 pending → accepted/rejected/withdrawn 由服务端强制（非 pending 转移返回 `PROPOSAL_NOT_PENDING`）。
- [x] 重连：序列为 `auth.hello`（凭据）→ `room.resume`（携带 `lastAppliedSeq`，应答含成员表、`generating` 标志、`lastSeq` 与增量事件数组）；内容类命令按房间缓存 `opId → ack`，重发只回放 ack、不重复产生事件。
- [x] 保留策略：V1 内存实现下共享文本与房间同生命周期——房间关闭/过期即整体清除，上限由 `roomTtlHours` 配置（默认 168h）；独立的文本保留期（如 72h）留待 SQLite 存储时实现。
- [x] **验收**：`scripts/smoke.mjs`（两外壳各 50 项）——断线期间发布的故事消息经 resume 追平且增量**无缺失、无重复**（seq 连续性断言）；被拒提案不出现在故事时间线；`opId` 重发的提案在全量回放中只出现一次。
- 设计决定（2026-07-11）：`generation.*` 为**瞬态事件**——无 seq、不入日志，只对在线成员广播；进行中状态以运行时 `generating` 标志维护，经 `auth.hello`/`room.resume` 应答恢复，避免日志被进度事件灌爆、重放出现陈旧"生成中"。文本长度上限：故事/提案 8000、副聊天 2000、拒绝理由 500。

### M2.5 — 资产通道（支撑插件 P3 镜像模式；2026-07-11 从 M4.5 提前）

> 提前原因：镜像聊天改为 V1 主路线（客人故事主界面），皮肤卡头像与档位二完整卡都走本通道，须在插件 P3 开工前就绪。

- [ ] 房间令牌鉴权的 HTTP 端点：POST 上传 / GET 下载房间资产（走外壳提供的 HTTP 服务，core 只做鉴权与元数据）。
- [ ] 仅限两类资产：角色卡 PNG、头像图片；单文件 ≤ 5MB；按房间与连接限频。
- [ ] TTL 清理：资产到期自动删除，房间关闭即删；存储走 `RoomStore` 同级的资产存储接口。
- [ ] 边界声明：这**不是**通用附件功能——除卡片/头像外一律拒收，通用附件仍是 V1 排除项。
- [ ] **验收**：房主上传卡片 → 客人凭房间令牌下载成功；无令牌或跨房间访问被拒；到期后资产不可再取。

### M3 — 插件客户端（控制中心与数据层；2026-07-11 改版：客人故事界面直接走镜像）

- [x] `relay-client.js`：连接、指数退避重连、心跳、`opId` 生成（插件 P0 已完成）。
- [ ] 镜像模式的**四项本地技术验证**前置到本阶段开头（明细见插件计划 P1）：消息截获、生成拦截、编辑回滚、卡片程序化导入导出。任一不过 → 镜像降级 V2、恢复原独立面板方案。
- [ ] `room-store.js`：本地只读投影（成员、时间线、提案队列、副聊天），按 `seq` 应用事件。
- [ ] `ui.js`：控制中心——粘贴邀请码入房、成员列表、提案编辑器（镜像可用后退为备用入口）、房主的提案审核队列、副聊天、简易文本时间线（调试/回退用）；不做气泡式时间线，原生观感由插件 P3 镜像聊天承担。
- [ ] **验收**：四项验证有结论并记录；客人全流程（入房 → 提案 → 看到房主接受后的故事推进 → 副聊天）不触碰酒馆原生聊天。

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
| 镜像模式技术验证不过（主路线全盘风险） | 四项本地验证前置到 M3 开头（可与 M2 并行）；不过则降级回原独立面板方案（存档见插件仓库 git 历史 f428586），协议与中继工作不受影响 |
| 两外壳行为漂移 | 纪律 1–4 + 验收里对两外壳跑同一套冒烟测试 |

## 5. 执行顺序

M0 → M1 → M2 → M2.5 → M3 → M4 → 插件 P3（镜像聊天）→ M5，严格串行（2026-07-11 改版：资产通道从 M4.5 提前为 M2.5，镜像聊天升级为客人故事主界面）。两个例外可并行：镜像模式的四项本地技术验证是纯酒馆侧实验、不碰协议，可在 M2 期间先行完成，任一不过则镜像降级 V2、M3 恢复原独立面板方案；M2 完成前不动插件 UI（协议先稳）。M4 放在 M3 之后，保证桥接调试时客人链路已可用作观察端；插件 P3 开头补验资产通道端到端后再动镜像实现。
