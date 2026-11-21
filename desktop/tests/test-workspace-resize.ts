import assert from "node:assert/strict";
import test from "node:test";
import { getWorkspaceResizeLayout } from "../src/workspace/useWorkspaceResize";

test("defaults to the 600px single-row composer width", () => {
  assert.deepEqual(getWorkspaceResizeLayout(1400), {
    totalWidth: 1400, minChatWidth: 600, maxChatWidth: 760, chatWidth: 600, singlePane: false,
  });
});

test("clamps user input to the chat and workspace limits", () => {
  for (const [total, preferred, expected] of [
    [1400, 300, 600], [1400, 900, 760], [1100, 760, 680], [1020, 760, 600], [1180, 760, 760],
  ]) {
    const result = getWorkspaceResizeLayout(total, preferred);
    assert.equal(result.chatWidth, expected);
    assert.equal(result.singlePane, false);
    assert.ok(total - result.chatWidth >= 420);
  }
});

test("switches to single pane strictly below 1020px without shrinking chat", () => {
  for (const total of [0, 420, 599, 600, 900, 1019, 1019.99]) {
    const result = getWorkspaceResizeLayout(total, 760);
    assert.equal(result.singlePane, true);
    assert.equal(result.chatWidth, 600);
    assert.equal(result.maxChatWidth, 600);
  }
  assert.equal(getWorkspaceResizeLayout(1020).singlePane, false);
});

test("transient container changes do not consume the preferred width", () => {
  const preferred = 744;
  assert.deepEqual([1400, 1100, 800, 0, 1020, 1400].map(total => getWorkspaceResizeLayout(total, preferred).chatWidth),
    [744, 680, 600, 600, 600, 744]);
});

test("rounds chat pixels without stealing fractional space from the workspace", () => {
  assert.equal(getWorkspaceResizeLayout(1400, 640.6).chatWidth, 641);
  assert.equal(getWorkspaceResizeLayout(1060.75, 760).chatWidth, 640);
  for (let total = 1020; total <= 1300; total += 0.25) {
    const result = getWorkspaceResizeLayout(total, 760);
    assert.ok(Number.isInteger(result.chatWidth));
    assert.ok(result.chatWidth >= 600 && result.chatWidth <= 760);
    assert.ok(total - result.chatWidth >= 420);
  }
});

test("invalid measurements and preferences produce finite, safe defaults", () => {
  for (const total of [-1, NaN, Infinity, -Infinity]) {
    const result = getWorkspaceResizeLayout(total, 760);
    assert.equal(result.totalWidth, 0);
    assert.equal(result.singlePane, true);
    assert.equal(result.chatWidth, 600);
  }
  for (const preferred of [NaN, Infinity, -Infinity]) {
    assert.equal(getWorkspaceResizeLayout(1400, preferred).chatWidth, 600);
  }
});
