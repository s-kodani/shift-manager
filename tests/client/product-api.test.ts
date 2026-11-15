import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { api, ApiError } from "../../apps/web/product/api";

afterEach(() => vi.restoreAllMocks());

it("keeps server failures, incompatible responses and unmapped errors distinguishable", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  for (const [body, status, code] of [
    [{ error: "INTERNAL_ERROR" }, 500, "INTERNAL_ERROR"],
    [{ value: 1 }, 200, "INVALID_RESPONSE"],
    [{ error: "UNMAPPED_FAILURE" }, 400, "UNMAPPED_FAILURE"],
    [{ detail: "unrecognized error envelope" }, 502, "UNKNOWN"],
  ] as const) {
    fetch.mockResolvedValueOnce(Response.json(body, { status }));
    const error = await api("/example", z.object({ value: z.string() })).catch(e => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code, status });
    expect(error.message).toContain(`エラーコード：${code}／HTTP ${status}`);
    expect(error.message).not.toContain("入力や権限を確認");
  }
  expect(new ApiError("INTERNAL_ERROR", 500).message).toContain("サーバーで処理に失敗");
  expect(new ApiError("INVALID_RESPONSE", 200).message).toContain("応答形式");
});

it("never echoes arbitrary server text as a diagnostic code and preserves actionable messages", () => {
  const error = new ApiError("unexpected private data", 500);
  expect(error.message).toContain("エラーコード：UNKNOWN／HTTP 500");
  expect(error.message).not.toContain("unexpected private data");
  expect(new ApiError("FORBIDDEN", 403).message).toBe("この操作の権限がありません。");
  expect(new ApiError("INPUT_NOT_CONFIGURED", 400).message).toContain("対象月に必要な設定が未登録");
  expect(new ApiError("CALENDAR_NOT_CONFIGURED", 400).message).toContain("企業カレンダーが未登録");
  expect(new ApiError("UNKNOWN", 429, [], undefined, 12).message).toContain("12秒後に");
});

it("preserves caller cancellation while waiting for response headers", async () => {
  const controller = new AbortController();
  const reason = new Error("screen changed");
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    controller.abort(reason);
    throw reason;
  });
  await expect(api("/example", z.unknown(), undefined, controller.signal)).rejects.toBe(reason);
});

it("preserves caller cancellation during body reading instead of reporting a network failure", async () => {
  const controller = new AbortController();
  const reason = new Error("screen changed while reading");
  const response = Response.json({ value: "old screen" });
  vi.spyOn(response, "json").mockImplementationOnce(async () => {
    controller.abort(reason);
    throw reason;
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
  await expect(api("/example", z.unknown(), undefined, controller.signal)).rejects.toBe(reason);
});

it("does not accept or validate an old screen's body when cancellation races with decoding", async () => {
  const controller = new AbortController();
  const reason = new Error("screen changed after decoding");
  const response = Response.json({ value: "old screen" });
  vi.spyOn(response, "json").mockImplementationOnce(async () => {
    controller.abort(reason);
    return { value: "old screen" };
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
  await expect(api("/example", z.object({ value: z.number() }), undefined, controller.signal)).rejects.toBe(reason);
});

it("continues to report a real transport or body failure on the active screen", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  fetch.mockRejectedValueOnce(new TypeError("connection lost"));
  await expect(api("/example", z.unknown())).rejects.toMatchObject({ code: "NETWORK_UNCERTAIN", status: 0 });
  const response = new Response("not json");
  fetch.mockResolvedValueOnce(response);
  await expect(api("/example", z.unknown())).rejects.toMatchObject({ code: "NETWORK_UNCERTAIN", status: 0 });
});
