import assert from "node:assert/strict";
import test from "node:test";
import type { TurnId } from "@zcode/contracts";
import { clearSettledActiveTurn } from "../src/app-result.js";

test("settle guard clears the matching active turn and its anchor with plain values", () => {
  const calls: Array<readonly [string, unknown]> = [];
  clearSettledActiveTurn({
    activeTurnId: "turn-1" as TurnId,
    settledTurnId: "turn-1" as TurnId,
    // 记录实参本身：若清理被藏回 state updater，这里收到的会是函数而非
    // undefined，断言随即失败——updater 内的副作用正是要防的回归。
    setActiveTurnId: (turnId) => {
      calls.push(["turn", turnId]);
    },
    setActiveTurnStartedAtMs: (startedAtMs) => {
      calls.push(["anchor", startedAtMs]);
    },
  });

  assert.deepEqual(calls, [
    ["turn", undefined],
    ["anchor", undefined],
  ]);
});

test("settle guard leaves a different active turn and its anchor untouched", () => {
  const calls: Array<readonly [string, unknown]> = [];
  clearSettledActiveTurn({
    activeTurnId: "turn-2" as TurnId,
    settledTurnId: "turn-1" as TurnId,
    setActiveTurnId: (turnId) => {
      calls.push(["turn", turnId]);
    },
    setActiveTurnStartedAtMs: (startedAtMs) => {
      calls.push(["anchor", startedAtMs]);
    },
  });

  assert.deepEqual(calls, []);
});

test("settle guard does nothing when the result carries no turn id", () => {
  const calls: Array<readonly [string, unknown]> = [];
  clearSettledActiveTurn({
    activeTurnId: "turn-1" as TurnId,
    settledTurnId: undefined,
    setActiveTurnId: (turnId) => {
      calls.push(["turn", turnId]);
    },
    setActiveTurnStartedAtMs: (startedAtMs) => {
      calls.push(["anchor", startedAtMs]);
    },
  });

  assert.deepEqual(calls, []);
});
