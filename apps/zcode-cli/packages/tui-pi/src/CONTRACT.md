# tui-pi

pi-tui 渲染引擎上的第二个交互式前端（`zcode tui --tui-frontend=pi`）。
与默认 OpenTUI/React 前端行为对齐，但不复制业务实现：transcript 投影、
提交分支、审批/选择/问题状态机、工作流镜像、键位判断全部复用
`@zcode/tui/internals` 的框架无关导出；本模块只做 pi-tui 组件挂载、
焦点路由与 chord 分派。

不变量：

- 唯一公共入口是 `index.ts` 的 `runTui(options)`；调用方只提供
  `TuiOptions` 端口（submitPrompt / sendInput / recallPreviousInput /
  subscribeSessionEvents / subscribeConnectionStatus / …），本模块
  不向 cli 反查实现细节。
- 业务状态单一所有者是 `AppStore` + 共享 reducers；pi 组件只渲染并
  路由焦点，不得新增第二条状态写入路径。
- 键位语义与 OpenTUI 端一致：全局 input listener 先分派 chord；面板
  可见时面板独占键盘；bracketed paste 在面板层还原为逐字输入。
- 业务逻辑 bug 修在 `@zcode/tui/internals` 共享层，本模块只修渲染与
  pi-tui 适配问题。

交集 hook 点：`packages/cli` 的 tui-command 装载器按
`--tui-frontend` 选择动态 import 本包；startup/result 元数据经
`TuiOptions` / `TuiStartupOptions` 传递。

shared-core attach：`zcode tui --tui-frontend=pi --shared-core`
（别名 `zcode attach`）把 TuiOptions 端口全部代理到 Unix socket 上
的共享 app-server core；`subscribeConnectionStatus` 提供断线/重连
状态，pi-tui 渲染在 composer 下方状态行（
`Connexion au core perdue — reconnexion…` / `Reconnecté au core`）。
