import {
  cancellationCommitCommand,
  type CancellationCommitCommand,
} from "../../api/src/cancellation-contract";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
// Opaque operation/version metadata only. Never store login tokens, credentials,
// names, leave reasons, shifts or checker output in browser storage.
export const cancellationOwnerKey = (company: string, request: string) =>
  "shift-cancellation:" + company + ":" + request;
export function readCancellationOwner(store: Store, key: string) {
  const raw = store.getItem(key);
  if (raw === null) return null;
  try {
    return cancellationCommitCommand.parse(JSON.parse(raw));
  } catch {
    throw Error(
      "保存した取消操作を確認できません。新しい操作を開始せず管理者へ確認してください。",
    );
  }
}
export function persistCancellationOwner(
  store: Store,
  key: string,
  input: CancellationCommitCommand,
) {
  const c = cancellationCommitCommand.parse(input),
    old = readCancellationOwner(store, key);
  if (old && JSON.stringify(old) !== JSON.stringify(c))
    throw Error(
      "未確認の取消操作が残っています。同じ操作の結果を確認してください。",
    );
  store.setItem(key, JSON.stringify(c));
  return c;
}
export function clearCancellationOwner(store: Store, key: string, id: string) {
  const old = readCancellationOwner(store, key);
  if (old && old.operationId !== id)
    throw Error("保存した取消操作の識別情報が変わりました。");
  store.removeItem(key);
}
