# Client Request Signing

## 状态

- 本文是 ZCode CLI 模型请求签名的事实规范。
- 协议与计费背景见仓库根目录
  [`docs/coding-plan/client-request-signing-and-usage-allowance.md`](../../../../../../docs/coding-plan/client-request-signing-and-usage-allowance.md)：
  Z.AI Coding Plan 只对**签名流量**按约 2/3 用量计费（有效的 150% allowance），
  未签名流量按标准系数计费，与 endpoint 无关。
- 实现位于 adapters `model/request-security-edition/`，共享策略位于
  `packages/shared/src/request-security-edition/`；公开装配点仍是
  `ModelRequestSecurityState` / `ModelRequestSecurityPort`，不新增用户配置或环境变量。

## 目标

在**不改变模型请求语义**的前提下，为 Coding Plan 流量补上官方客户端签名：

```text
AI SDK provider request（已带 x-request-id / x-session-id 归因头）
  -> business error / option map 观察
  -> 请求签名（本文）            <- 看到原始 baseURL 与最终 header
  -> provider endpoint routing   <- 改写为 zcode.z.ai 网关
  -> 网络代理 / No Proxy / 自定义 CA
  -> provider streaming response
```

签名器必须看到**重写前**的 URL：origin 校验针对 Provider 自身域名，签名不覆盖 URL；
路由仍决定最终出口。顺序由 `AiSdkModelExecution.createFactory` 固定，本文不改变该顺序。

## 签名策略

| Provider access | 行为 |
| --- | --- |
| `zhipu-coding-plan-api-key` | 签名 |
| `zhipu-account` → `individual-coding-plan` / `team-coding-plan` | 签名 |
| 任意 `baseURL` 命中 family 域名（`*.z.ai` / `*.bigmodel.cn`） | 签名 |
| 任意 `baseURL` hostname ∈ {`api.chatglm.site`, `zcode.chatglm.site`} | 签名 |
| `zhipu-account` → `start-plan` / `off-peak` / `highspeed` | 不签名；family 域名下记录一次 `unsigned_sent(access_mode)` |
| 其它第三方 Provider | 原样透传 |

`clientVersion` 取 provider header `X-ZCode-App-Version`，缺失时回退构建常量
`ZCODE_VERSION`（打包时由 `__ZCODE_VERSION__` 注入，源码态为 `0.0.0-dev`）。
官方客户端的该 header 由 bootstrap 默认来源头提供，因此两者一致。

## 凭据与握手

Provider API Key 被解释为签名凭据（`parseClientSigningCredential`）：

| 形态 | apiKeyId | secret | 握手字段 |
| --- | --- | --- | --- |
| Project Access Token（JWT `SIGN`，`token_use=project_access`） | `api_key` claim | 整段 JWT | `accessToken` |
| `id.secret`（恰好一个点） | 左侧 | 右侧 | `apiKey` |

握手 `POST {providerOrigin}/api/paas/c1f3a7e2/v2/client`（HTTPS，10s 超时）：

```text
sig = base64(HMAC-SHA256(
        HKDF(secret, salt="WD_CLIENT_SIGN_KDF_SALT", info="getSignKey_hmac", 256),
        "get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"))
```

响应 `{code:200, data:{privateCipher}}` 后，用
`HKDF(secret, info="ed25519_priv")` 派生 AES-256-GCM 密钥解出 Ed25519 pkcs8 私钥
（`iv = cipher[0:12]`，AAD = apiKeyId，tag 128 bit）。

私钥按 `apiKey + origin` 进程内缓存；同一 Provider 的 apiKey / baseURL /
clientVersion / transport 都没变时复用签名器，变更时销毁旧签名器并重新握手。
key state 上还挂 BYPASS 标记（见“失败与降级”），跨签名器重建共享。

## 单请求签名

请求必须带 `X-Session-Id`（开源 CLI 由归因层写入，使用剥离 `sess_` 前缀后的 session id）。
签名前先删除任何残留的 `X-Client-*` / `X-App-Id` / `X-Client-Sign-Verified`。

```text
ts    = 当前毫秒
nonce = 16 字节随机 hex（32 字符）
pow   = 8 bit hashcash：
        n = hex(sha256("{apiKeyId}\nzcode\n{sessionId}\n{ts}"))[0:32]
        candidate = randomHex(12) + counter.toString(16).padStart(8, "0")
        sha256("{n}\n{candidate}") 有 8 bit 前导零时取该 candidate
sig   = base64(Ed25519-sign(privateKey,
        "{apiKeyId}\n{ts}\n{clientVersion}\n{sessionId}\n{nonce}"))
```

写入：`X-Client-Ts`、`X-Client-Version`、`X-Client-Sig`、`X-Session-Id`、
`X-Client-Nonce`、`X-App-Id: zcode`、`X-Client-Pow`。
请求体先缓冲为字节，签名重试可以原样重放；`cache` / `credentials` / `redirect` /
`referrerPolicy` 等 fetch 语义保持原值。

## 失败与降级（fail-open）

| 场景 | 行为 |
| --- | --- |
| 需签名 Provider 缺少 `baseURL` | 抛 `invalid-config`（fail-closed）：这是配置错误而非签名失败，静默降级会把 Coding Plan 凭据未签名发往错误端点 |
| 请求 origin ≠ Provider origin | 未签名直发，`unsigned_sent(origin_mismatch)` |
| 握手网络/超时/协议/业务失败 | 未签名直发，`unsigned_sent(handshake_failed)` + `handshake_failed` 观测 |
| API Key 不能解析为签名凭据 | 未签名直发，`unsigned_sent(invalid_credential)` |
| 缺少 `X-Session-Id` | 未签名直发，`unsigned_sent(missing_session)` |
| `401` + `VERIFY_SIGNATURE_INVALID` / `VERIFY_APIKEY_EXPIRED` | 失效私钥 → 重新握手 → 重放一次（`signed_sent(signedAttempt=2)`） |
| 第二次仍被拒绝 | 进入 BYPASS，未签名直发（`verify_refresh_exhausted`），后续请求不再尝试签名 |

签名失败**永远不阻断**模型请求：最坏情况只是回到未签名计费（唯一例外是上面的
`baseURL` 配置错误）。BYPASS 记录在按 `apiKey + origin` 共享的 key state 上：装配层
每次请求都会因 transport 身份变化重建签名器，共享标记保证 BYPASS 跨签名器代存活；
Provider 账号/key 变更换到新 key state，自然重置并重新尝试。

与官方的两处刻意差异（开源版更保守）：

1. 官方在缺少 `X-Session-Id` 或凭据不可解析时抛错；开源版改为未签名直发，
   避免后台/工具类无 session 请求或普通 `sk-` API Key 因签名能力不可用而失败。
2. `requestVerificationInteractionAvailable` 保持 `false`：开源版没有 captcha 交互 UI。
   `requiresRequestVerification` 采用上游 3.17.1 的配置快照语义：非 `start-plan` 恒
   `false`；`start-plan` 在配置显式关闭或 `skipModelRequest` 时 `false`，其余情况回落
   发行策略（本版即 `false`）。start-plan 的 fail-closed 不再由该谓词承担，改由
   Host 流程负责：`zcodeAgentService` 在需要验证而配置读取失败/缺失时显式报错
   （`configNetwork`/`configInvalid`），不发送未验证流量。

## 观测与日志

每次请求按 `x-request-id` 记录观测（最多 64 个 request，attempt 终态时消费）：

| kind | 字段 |
| --- | --- |
| `signed_sent` | `signedAttempt` |
| `unsigned_sent` | `reason` |
| `handshake_failed` | `errorKind` / `httpStatus` / `businessCode` / `reason` |
| `verify_rejected` | `reason` / `signedAttempt` |
| `bypass_entered` | — |
| `request_failed_closed` | `errorKind` |

Telemetry 映射：`signed_sent` / `unsigned_sent` / `request_failed_closed` 写
`zcode.model_attempt.client_signing` 属性；`handshake_failed`、`verify_rejected`、
`bypass_entered` 写 span 事件。只记录稳定枚举，不记录签名、nonce、session id。

日志级别：`signed_sent` 为 `debug`；`unsigned_sent` 与 `access_mode` 跳过为 `info`
（每个 Provider 只记一次，不随流量膨胀）；`handshake_failed` / `verify_rejected` /
`bypass_entered` / `request_failed_closed` 为 `warn`。事件名统一
`model.client_signing.<kind>`，不包含 API Key、cookie 或请求体。观测回调自身抛错
记 `model.client_signing.observation_failed`（debug，仅错误消息），绝不影响请求主路径。

## 安全边界

- 私钥与派生密钥只在内存中存在，用完清零；不落盘、不写日志、不进入 session event。
- `x-client-sig`、`x-client-pow`、`x-aliyun-captcha-verify-param` 进入
  `requestSecuritySensitiveHeaders`，因此网络抓包、debug 面板与 E2E 抓包都会脱敏。
- 签名头不参与 `x-api-key-id` 等控制面 header 的构造；配置请求（`/agent/configs`）不签名。

## 已确认用例

| Case | Setup | Assertions |
| --- | --- | --- |
| CRS-001 | `zhipu-coding-plan-api-key` | 签名；header 齐全；Ed25519 签名可验证 |
| CRS-002 | `zhipu-account` + individual/team | 签名 |
| CRS-003 | `zhipu-account` + start-plan / off-peak / highspeed | 不签名，`unsigned_sent(access_mode)` 只记一次 |
| CRS-004 | 手工 provider，baseURL `api.z.ai` | 签名 |
| CRS-005 | 手工 provider，第三方 baseURL | 原样透传，无观测 |
| CRS-006 | PoW | 8 bit 前导零，候选为 32 hex |
| CRS-007 | 握手 401/VERIFY_SIGNATURE_INVALID | 重新握手并重放一次，第二次 `signedAttempt=2` |
| CRS-008 | 连续两次验证拒绝 | 第三次未签名，`bypass_entered`，后续请求不再签名 |
| CRS-009 | 握手超时/网络失败 | 未签名直发，`handshake_failed` + `unsigned_sent(handshake_failed)` |
| CRS-010 | 无 `x-session-id` | 未签名直发，`unsigned_sent(missing_session)` |
| CRS-011 | 普通 `sk-` API Key（无点） | 未签名直发，`unsigned_sent(invalid_credential)` |
| CRS-012 | 请求带残留 `X-Client-Sig` | 签名前删除，最终只有一组本代签名头 |
| CRS-013 | 请求体重放 | 第二次发送 body 字节与首次一致 |
| CRS-014 | 需签名 Provider 缺少 `baseURL` | `protectTransport` 抛 `invalid-config`，不产生未签名流量 |
| CRS-015 | 连续两次验证拒绝后 transport 身份变化（新 routing fetch 闭包） | BYPASS 存活：不再握手，`unsigned_sent(bypass)`；换 apiKey 后重新签名 |

## Impact Brief

| Field | Value |
| --- | --- |
| Developer intent | 使开源 CLI 的 Coding Plan 流量获得官方客户端签名计费系数 |
| Capability | client request signing (allowance) |
| Change layer | transport |
| Operating mode | implementation-handoff |
| Primary seeds | `createModelRequestSecurityState`, `AiSdkModelExecution.createFactory`, `publishRequestObservations` |
| Out of scope | UI、provider 配置、endpoint routing、off-peak 空闲队列、captcha 交互 UI |

无 UI surface、草稿状态或持久化 owner。权威 owner 是进程内私钥缓存与每个 execution
的签名器；下游是 provider fetch 组合顺序与 request observation 消费点。
