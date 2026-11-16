# OAuth 多提供方改造实施说明（Desktop）

更新时间：2026-11-15

## 1. 本次落地范围

本次在 Desktop OAuth 多提供方实现上做结构重排，目标是让 provider 同级扩展、按 provider 内聚配置，不再在公共入口里写某个 provider 的特例逻辑。

## 2. 核心改动

### 2.1 Shared 只保留领域类型

`packages/shared/src/oauth.ts` 现在只保留 OAuth 领域类型与 provider id（`bigmodel`、`zai`），不再放 provider 默认端点配置。

### 2.2 Provider 配置下沉

在 `packages/services/src/oauth/providers/` 新增 provider 配置模块：

- `bigmodelProviderConfig.ts`
- `zaiProviderConfig.ts`
- `configUtils.ts`

每个 provider 自己维护默认配置和环境变量映射；`runtimeConfig.ts` 只做聚合。

### 2.3 Runtime 配置职责收敛

`packages/services/src/oauth/runtimeConfig.ts` 现在只负责：

1. 定义 `OAuthProviderRuntimeConfig` / `OAuthRuntimeConfig`
2. 聚合各 provider 的 runtime config

不再承载 BigModel/ZAI 的具体字段拼装细节。

### 2.4 凭据仓储去除全局 legacy provider 语义

`packages/services/src/oauth/repo/oauthCredentialRepo.ts` 仅处理 namespaced key：

- `oauth:<provider>:access_token`
- `oauth:<provider>:refresh_token`
- `oauth:<provider>:user_info`
- `oauth:active_provider`

不再通过全局 `LEGACY_PROVIDER_ID` 推断或迁移某个 provider。

BigModel `oauth:bigmodel:user_info` 当前保存归一化 profile，并通过
`rawProfile.zcodeProfileSchemaVersion = 2` 标记已按 `customerName -> nickName -> "user"`
展示名优先级生成。启动 `restoreCachedSession()` 时，如果检测到 BigModel 旧缓存缺少
该版本标记或版本低于 2，会先立即返回本地缓存展示态，再在后台尝试用 BigModel
provider 命名空间下的 access token 做一次 best-effort userinfo 刷新；已高于 2 的缓存
视为未来版本数据，不请求、不改写、不降级。成功后写回 schema version 2 与新展示名。
401/403、缺少 token，或命中 `unknown/User` 哨兵 profile 时，继续保留旧缓存展示字段并
写入 schema version 2，避免之后每次启动重复触发确定失败的迁移。超时、离线或 5xx
这类暂时性失败只写入 `rawProfile.zcodeProfileMigrationRetryAfter` 退避时间，不写
schema version 2；退避窗口过后仍可再次尝试迁移。后台迁移写入必须固定到
`oauth:bigmodel:user_info`，且保存前确认当前 active provider 与 BigModel 缓存仍是启动时
捕获的旧状态；用户已 logout、切到 ZAI 或重新登录 BigModel 时，旧迁移结果必须失效。

### 2.5 BigModel fallback secret 移除

BigModel 不再内置历史 fallback secret；未显式配置 `BIGMODEL_OAUTH_APP_SECRET` 时运行时配置保持 `undefined`。当前 BigModel callback 只通过 zcode OAuth token 路由消费一次性 code。

### 2.6 OAuth callback 收敛

Desktop OAuth 统一使用 `zcode://oauth/callback`：

- ZAI 默认 `redirectUri` 从 `zcode://zai-auth/callback` 收敛为 `zcode://oauth/callback`
- BigModel 保持 `zcode://oauth/callback`
- Desktop main 进程不再识别 `zcode://zai-auth/callback` / `zcode://bigmodel-auth/callback`
- `ZAI_OAUTH_REDIRECT_URI` / `BIGMODEL_OAUTH_REDIRECT_URI` 及 legacy redirect URI override 已移除

Provider 归属不依赖 callback host，而是由发起登录时注册的 `state` 绑定关系决定。

## 3. 运行时配置说明（Host Process）

BigModel 环境变量：

- `BIGMODEL_OAUTH_ENABLED`
- `BIGMODEL_OAUTH_AUTHORIZE_URL`
- `BIGMODEL_OAUTH_TOKEN_URL`
- `BIGMODEL_OAUTH_USERINFO_URL`
- `BIGMODEL_OAUTH_APP_ID`
- `BIGMODEL_OAUTH_APP_SECRET`

ZAI 环境变量：

- `ZAI_OAUTH_ENABLED`
- `ZAI_OAUTH_AUTHORIZE_URL`
- `ZAI_OAUTH_TOKEN_URL`
- `ZAI_OAUTH_USERINFO_URL`
- `ZAI_OAUTH_CLIENT_ID`（兼容 `ZAI_OAUTH_APP_ID`）
- `ZAI_BUSINESS_BASE_URL`：派生 `POST /api/auth/z/login`，用于把 ZAI OAuth access token 换成业务 token；测试环境为 `https://api.z.ai`
- `ZAI_BUSINESS_LOGIN_URL`：完整业务 token 交换 URL override，优先级高于 `ZAI_BUSINESS_BASE_URL`

ZAI 默认登录链路已切换为后端 JWT token 交换，授权入口和业务 token 交换入口按 `ZCODE_ENV=test|production` 选择：

- 授权页：由 `ZAI_<ENV>_OAUTH_ORIGIN` 派生 `/api/oauth/authorize`，生产默认为 `https://chat.z.ai/api/oauth/authorize`
- token 交换：由 `ZCODE_<ENV>_BASE_URL` 派生 `/api/v1/oauth/token`
- 桌面端请求体：`{ code, redirect_uri, state }`
- 本地保存的 `oauth:zai:access_token` 是 `data.zai.access_token` 经 `POST /api/auth/z/login` 换得的 Z.AI 业务 token；`data.token`（zcode JWT）单独保存为 `zcodejwttoken`

## 4. ZAI 后端 JWT 登录链路（增量）

ZAI OAuth 登录不再由桌面端直接请求三方 ZAI token 接口。桌面端只负责打开授权页、接收 `zcode://oauth/callback` deep link，并把 `code`、`redirect_uri`、`state` 传给后端 `https://zcode.z.ai/api/v1/oauth/token`。

后端完成 z.ai token 交换、userinfo 拉取、用户创建与 JWT 签发。客户端把响应中的 `data.zai.access_token` 经 `POST /api/auth/z/login` 换成业务 token 后保存为 `oauth:zai:access_token`，把 `data.token`（zcode JWT）保存为 `zcodejwttoken`，把 `data.user` 映射为 `oauth:zai:user_info`，并把 `oauth:active_provider` 设置为 `zai`。

## 5. 验证结果

已执行：

- `pnpm vitest run packages/services/test/oauthService.test.ts`
- `pnpm typecheck`
- `pnpm lint`

结果：通过。

## 6. OAuth 凭据自动加解密（增量）

为避免 OAuth token / user_info 以明文落盘，本次在凭据服务层增加透明加解密：

- 入口：`packages/services/src/credential/credentialService.ts`
- 加解密实现：`packages/services/src/credential/providers/credentialCipherProvider.ts`
- 密文格式：`enc:v1:<iv>.<authTag>.<cipherText>`（AES-256-GCM）

行为说明：

1. `credentialService.save` 自动加密后写入 `~/.zcode/v2/credentials.json`
2. `credentialService.load` 自动解密并返回明文给上层业务
3. 历史明文值（无 `enc:v1:` 前缀）保持兼容读取，避免升级后登录态失效

密钥说明：

- 优先使用环境变量 `ZCODE_CREDENTIAL_SECRET`
- 未配置时使用本机上下文生成 fallback key（用于本地/远程模式下的最小可用加密）

测试：

- `packages/services/test/credentialService.test.ts`
  - 验证写盘非明文
  - 验证读取自动解密
  - 验证历史明文兼容

## 7. 启动登录态恢复改造（增量）

为避免启动时仅凭本地文件值判断“已登录”，本次把登录态恢复收敛到 `oauthService.restoreSession()`：

- 接口：`packages/services/src/oauth/oauth.ts`
- 实现：`packages/services/src/oauth/oauthService.ts`
- UI 调用入口：`packages/ui/src/Root.tsx`

行为变化：

1. 启动恢复不再直接在 UI 读取 token/user_info
2. `restoreSession` 会用 active provider 的 access token 调用 provider `fetchUserInfo` 做真实有效性校验
3. 若返回未授权（401/403），立即执行 logout 流程并清理本地登录态

BigModel 兼容迁移：

- legacy `auth_token` / `refresh_token` 读取逻辑下沉到 provider 目录（`bigmodelProviderAdapter.ts`）
- 兼容命中后自动回填命名空间 key：`oauth:bigmodel:access_token` / `oauth:bigmodel:refresh_token`

测试：

- `packages/services/test/oauthService.test.ts`
  - 启动校验成功可恢复会话
  - BigModel legacy token 可恢复并迁移
  - 启动校验 401 会触发退出并清理凭据

## 8. Coding Plan 请求凭据链路（项目访问令牌）

ZAI 的 Coding Plan 请求凭据不再落盘长期 key；链路分登录期与请求期两段，业务 token 交换收敛在登录期完成。

登录期（deep link `exchangeToken` 与 CLI polling `normalizePolledTokenSet` 在同一 adapter 边界转换）：

1. 后端 `data.zai.access_token`（Z.AI OAuth token）经 `POST {businessLoginUrl}`（默认 `https://api.z.ai/api/auth/z/login`）换成 Z.AI 平台业务 token，由 `ZaiBusinessTokenResolver` 完成并带进程内缓存
2. 业务 token 持久化为 `oauth:zai:access_token`；`data.token`（zcode JWT）单独保存为 `zcodejwttoken`
3. ZAI_CN 不经过该交换，直接持久化后端返回的 access_token

请求期（Coding Plan 调用需要凭据时）：

1. `AccountProviderCredentialService.loadCodingPlanMaterial` 读取 `oauth:zai:access_token` 业务 token，经 `AccountProviderApiKeyResolver` 调共享 `ProjectAccessTokenClient.resolve`
2. `GET {origin}/api/biz/customer/getCustomerInfo` 选择机构/项目：个人 Key 只看非团队项目，优先“默认机构/默认项目”；解析出的 `{organizationId, projectId, apiKeyId}` 位置经 `locationStore` 写入凭据服务 `project-key-location:v1:...` 键复用
3. `GET`/`POST /api/biz/v1/organization/{organizationId}/projects/{projectId}/api_keys` 查找或创建 `zcode-api-key`（团队为 `zcode-team-api-key`，`keyType: 2`）
4. `POST {apiKeyId}/access_tokens` 签发短期项目访问令牌（PAT）；`ProjectAccessTokenCache` 进程内缓存并提前刷新，已知 Key 的签发临时失败在同一会话内重试一次
5. PAT 仅作请求期凭据，不落盘为供应商 apiKey；Key 定位 404 时删除缓存位置并重建

实现：

- 登录期交换：`packages/services/src/oauth/providers/zaiProviderAdapter.ts`、`packages/services/src/providers/zaiBusinessTokenResolver.ts`
- PAT 解析与缓存：`packages/shared/src/project-access-token-client.ts`
- Desktop 注入与编排：`packages/services/src/model-provider/accountProjectTokenClient.ts`、`accountProviderApiKeyResolver.ts`、`accountProviderCredentialService.ts`
- CLI 复用同一共享 client：`apps/zcode-cli/packages/adapters/src/auth/coding-plan-api-key.ts`；登录期交换在 `apps/zcode-cli/packages/bootstrap/src/auth-login.ts` 调 `exchangeZaiBusinessToken`

测试：

- `apps/zcode-cli/packages/adapters/tests/zai-business-token-refresh.test.ts`、`auth.test.ts`、`project-token-cancellation.test.ts`、`project-token-cold-recovery.test.ts`、`project-token-refresh.test.ts`
- `packages/desktop/test/e2e/coding-plan/`（含 `account-key-usage-scene.test.ts`）与 `packages/desktop/test/e2e/auth-config/login/oauth-completion-race.test.ts`

兼容策略：

- BigModel 走同一 PAT 链路（`family: "bigmodel"`，origin 由 `resolveBigModelApiOrigin` 解析）；`api_keys/copy` 的 `secretKey` 回退与“写预置供应商 apiKey”均已移除
