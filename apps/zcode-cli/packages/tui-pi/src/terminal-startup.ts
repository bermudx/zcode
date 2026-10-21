// 启动期终端查询排空：runPiTui 在 tui.start() 之前调用。
//
// 修复的 bug：原先在 canonical+echo 模式下由 tui.queryTerminalColors 发
// OSC 10/11/4 + DA 查询——此时 ProcessTerminal.start() 尚未运行（raw 未开、
// stdin 无消费者），PTY 行纪律把终端回复原样回显到屏幕（tmux capture-pane
// 里的 ^[[?1;2;4c、真机里的 ]10;rgb:… 垃圾行）；start() 后迟到的回复又越过
// consumeTerminalColorResponse（查询已被哨兵弹出）落入 composer 变成乱码输入。
//
// 本模块在发查询前先自行把 stdin 切 raw 并接管数据：查询串末尾以 DA1(ESC[c)
// 作哨兵——所有真终端必答 DA，哨兵到达即证明其前回复全部到齐；超时兜底。
// 窗口内识别出的回复字节静默吞掉；其余字节（用户抢跑按键）unshift 回 stdin，
// start() 后由 stdinBuffer 正常消费，不丢输入。

import type { RgbColor, TerminalColors } from "@earendil-works/pi-tui";

const ESC = 0x1b;
const PALETTE_SIZE = 16;

// 与 pi-tui TERMINAL_COLOR_QUERY 相同的查询集：OSC 10 + OSC 11 + OSC 4;0..15，
// 以 DA1 收尾做完成哨兵。
const STARTUP_TERMINAL_QUERY =
  "\x1b]10;?\x07\x1b]11;?\x07" +
  Array.from({ length: PALETTE_SIZE }, (_, i) => `\x1b]4;${i};?\x07`).join("") +
  "\x1b[c";

export const STARTUP_QUERY_TIMEOUT_MS = 600;

// 到达 input 侧即判定为“终端应答”的完整序列形态（锚定到序列起点，供
// 增量扫描器按最长匹配切分；isStrayTerminalResponse 用锚定全程的版本）。
// 控制字符经具名常量插值进 new RegExp：同 terminal-input-filter.ts。
const ESC_RE = "\x1b";
const BEL = "\x07";
const re = (body: string): RegExp => new RegExp(body);

const OSC_REPLY_PATTERN = re(`^${ESC_RE}][^${BEL}${ESC_RE}]*(?:${BEL}|${ESC_RE}\\\\)`);
const DCS_REPLY_PATTERN = re(`^${ESC_RE}P[\\s\\S]*?${ESC_RE}\\\\`);
const APC_REPLY_PATTERN = re(`^${ESC_RE}_G[\\s\\S]*?(?:${ESC_RE}\\\\|${BEL})`);
const DA_REPLY_PATTERN = re(`^${ESC_RE}\\[[?>][\\d;]*c`);
const DECRQM_REPLY_PATTERN = re(`^${ESC_RE}\\[\\?\\d+(?:;\\d+)*y`);
const CPR_REPLY_PATTERN = re(`^${ESC_RE}\\[\\d+;\\d+R`);
const CELL_SIZE_REPLY_PATTERN = re(`^${ESC_RE}\\[6;\\d+;\\d+t`);
const COLOR_SCHEME_REPORT_PATTERN = re(`^${ESC_RE}\\[\\?997;[12]n`);

const RESPONSE_PATTERNS = [
  OSC_REPLY_PATTERN,
  DCS_REPLY_PATTERN,
  APC_REPLY_PATTERN,
  DA_REPLY_PATTERN,
  DECRQM_REPLY_PATTERN,
  CPR_REPLY_PATTERN,
  CELL_SIZE_REPLY_PATTERN,
  COLOR_SCHEME_REPORT_PATTERN,
];

// 一个 ESC 开头的残余字节串"还可能长成应答序列"的前缀形态：
// OSC 未到 ST/BEL、CSI 参数段未完结、DCS/APC 未到 ST、或孤 ESC。
const INCOMPLETE_RESPONSE_PATTERN = re(
  `^(?:${ESC_RE}\\][^${BEL}${ESC_RE}]*|${ESC_RE}\\[[\\d;?>=]*|${ESC_RE}P[\\s\\S]*|${ESC_RE}_G?[\\s\\S]*|${ESC_RE})$`,
);

const OSC_COLOR_REPLY_PATTERN = re(
  `^${ESC_RE}\\](?:(1[01])|4;(\\d{1,3}));([^${BEL}${ESC_RE}]*)(?:${BEL}|${ESC_RE}\\\\)`,
);
const DA1_REPLY_PATTERN = re(`^${ESC_RE}\\[\\?[\\d;]*c`);

/** 解析 OSC 颜色值：`rgb:r/g/b`（各 1-4 位 hex）或 `#rrggbb`/`#rrrrggggbbbb`。 */
const parseOscColorValue = (raw: string): RgbColor | undefined => {
  const value = raw.trim();
  const scaled = (hex: string): RgbColor | undefined => {
    const step = hex.length / 3;
    if (![2, 4].includes(step) || !/^[0-9a-f]+$/i.test(hex)) return undefined;
    const max = 16 ** step - 1;
    const channel = (at: number) =>
      Math.round((Number.parseInt(hex.slice(at, at + step), 16) / max) * 255);
    return { r: channel(0), g: channel(step), b: channel(step * 2) };
  };
  if (value.startsWith("#")) return scaled(value.slice(1));
  const match = value.match(/^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i);
  if (!match) return undefined;
  return scaled(`${match[1]}${match[2]}${match[3]}`);
};

type ColorTarget = "foreground" | "background" | number;

interface DrainState {
  colors: TerminalColors & { palette?: RgbColor[] };
  replied: Set<string>;
  done: boolean;
  pendingUser: Buffer[];
  palette: Array<RgbColor | undefined>;
}

const recordColorReply = (state: DrainState, sequence: string): void => {
  const match = sequence.match(OSC_COLOR_REPLY_PATTERN);
  if (!match) return;
  const target: ColorTarget =
    match[1] === "10" ? "foreground" : match[1] === "11" ? "background" : Number.parseInt(match[2] ?? "", 10);
  const rgb = parseOscColorValue(match[3] ?? "");
  const key = String(target);
  if (rgb === undefined || state.replied.has(key)) return;
  state.replied.add(key);
  if (target === "foreground") state.colors.foreground = rgb;
  else if (target === "background") state.colors.background = rgb;
  else if (target >= 0 && target < PALETTE_SIZE) state.palette[target] = rgb;
};

/**
 * 在 canonical+echo 隐患窗口内完成终端颜色查询并排空全部回复。
 * 返回终端上报的颜色；终端不答 DA1 时按 timeoutMs 兜底返回已收集部分。
 * 调用方须已确认 stdin.isTTY；本函数负责 raw 切换、哨兵等待、字节归类。
 */
export const queryTerminalColorsAtStartup = (options: {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  timeoutMs: number;
}): Promise<TerminalColors> =>
  new Promise((resolve) => {
    const { stdin, stdout, timeoutMs } = options;
    const state: DrainState = {
      colors: {},
      done: false,
      pendingUser: [],
      palette: Array.from({ length: PALETTE_SIZE }, () => undefined),
      replied: new Set(),
    };
    let buffer = Buffer.alloc(0);

    const finish = () => {
      if (state.done) return;
      state.done = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      // buffer 尾部（未完结片段或哨兵后同批到达的字节）并入用户字节：
      // 回复碎片交给 start() 后的静默丢弃器处理，可打印按键原样放行。
      if (buffer.length > 0) state.pendingUser.push(buffer);
      stdin.pause();
      const leftover = Buffer.concat(state.pendingUser);
      if (leftover.length > 0) stdin.unshift(leftover);
      if (state.palette.every((c) => c !== undefined)) {
        state.colors.palette = state.palette as RgbColor[];
      }
      resolve(state.colors);
    };

    const timer = setTimeout(finish, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let cursor = 0;
      while (cursor < buffer.length && !state.done) {
        if (buffer[cursor] !== ESC) {
          state.pendingUser.push(buffer.subarray(cursor, cursor + 1));
          cursor += 1;
          continue;
        }
        const rest = buffer.toString("latin1", cursor);
        let consumed = 0;
        for (const pattern of RESPONSE_PATTERNS) {
          const match = rest.match(pattern);
          if (match && match[0].length > consumed) consumed = match[0].length;
        }
        if (consumed > 0) {
          const sequence = rest.slice(0, consumed);
          recordColorReply(state, sequence);
          cursor += consumed;
          if (DA1_REPLY_PATTERN.test(sequence)) {
            // DA1 哨兵：其前回复全部到齐。剩余字节不再逐条解析，整体并入
            // 用户字节 unshift——回复形态由 start() 后的静默丢弃器兜底。
            buffer = buffer.subarray(cursor);
            cursor = 0;
            finish();
            return;
          }
          continue;
        }
        if (INCOMPLETE_RESPONSE_PATTERN.test(rest)) break; // 等更多字节
        // 以 ESC 开头的用户按键序列：ESC 字节归入用户输入，其余字节下一轮再判。
        state.pendingUser.push(buffer.subarray(cursor, cursor + 1));
        cursor += 1;
      }
      buffer = buffer.subarray(cursor);
    };

    // raw 先行：行纪律从此刻起不再回显，回复只进我们的解析器。
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    stdout.write(STARTUP_TERMINAL_QUERY);
  });
