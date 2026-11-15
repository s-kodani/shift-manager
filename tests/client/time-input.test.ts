import { expect, it } from "vitest";
import { formatTimeInput, parseTimeInput, timeInputError } from "../../apps/web/product/time-input-model";

it("HHMM入力は先頭ゼロ・分単位・当日末を内部の分へ正確に変換する", () => {
  expect(parseTimeInput("0000")).toBe(0);
  expect(parseTimeInput("0930")).toBe(570);
  expect(parseTimeInput("1007")).toBe(607);
  expect(parseTimeInput("2359")).toBe(1439);
  expect(parseTimeInput("2400")).toBe(1440);
  expect(formatTimeInput(7)).toBe("0007");
  expect(formatTimeInput(570)).toBe("0930");
  expect(formatTimeInput(1440)).toBe("2400");
});
it("不完全・コロン付き・不正な時刻を部分的な数値として受理しない", () => {
  for (const value of ["", "0", "093", "930", "09300", "09:30", " 0930", "０９３０", "09a0", "0960", "2401", "2500", "-100"]) {
    expect(() => parseTimeInput(value), value).toThrow("INVALID_TIME");
  }
});
it("休憩等の30分条件と分単位条件・追加受付の2359上限を区別する", () => {
  expect(timeInputError("1007")).toBe("");
  expect(timeInputError("1007", 30)).toContain("30分単位");
  expect(timeInputError("1030", 30)).toBe("");
  expect(timeInputError("2400", 30)).toBe("");
  expect(timeInputError("2400", 1, false)).toContain("2359");
  expect(timeInputError("2359", 1, false)).toBe("");
});
