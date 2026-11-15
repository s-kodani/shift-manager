import { Field, Button, Card, CardContent, Input, MinuteTimeInput, NativeSelect, Table, TableCell, TableHead } from "./components/ui";
import { UnsavedForm } from "./unsaved-input";
import { useState, type ReactNode } from "react";
import type { OptimizerInput } from "../../../packages/contracts/optimizer-input.generated";
import {
  changeBreak,
  changePattern,
  setFixed,
  type EditingDraft,
} from "./draft-model";
const time = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
export function DraftEditor({
  initial,
  input,
  disabled,
  nameOf,
  label,
  save,
}: {
  initial: EditingDraft;
  input: OptimizerInput;
  disabled: boolean;
  nameOf: (id: string) => string;
  label: (id: string) => string;
  save: (draft: EditingDraft) => Promise<void>;
}) {
  const [edit, setEdit] = useState(() => structuredClone(initial)),
    [index, setIndex] = useState(0),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState("");
  const a = edit.assignments[index],
    locks = edit.locks.filter(
      (l) => l.staffId === a?.staffId && l.date === a?.date,
    ),
    parts = [...new Set(locks.flatMap((l) => l.parts))],
    person = input.staff.find((s) => s.id === a?.staffId);
  if (!a) return null;
  function update(fn: (copy: EditingDraft) => void) {
    const copy = structuredClone(edit);
    fn(copy);
    setEdit(copy);
    setDirty(true);
    setError("");
  }
  function editBreak(value: number | null, start: boolean) {
    if (!a.shift) return;
    const interval: [number, number] | null = value === null
      ? null
      : start
        ? [
            value,
            a.shift.break?.[1] ?? value + input.breakRule.requiredMinutes,
          ]
        : [
            a.shift.break?.[0] ?? value - input.breakRule.requiredMinutes,
            value,
          ];
    try {
      setEdit(changeBreak(edit, index, interval, input));
      setDirty(true);
      setError("");
    } catch (x) {
      setError(String(x));
      throw x;
    }
  }
  return (
    <Card className="panel draft-editor">
      <details className="draft-editor-disclosure">
      <summary><h2>手動編集・固定</h2></summary>
      <CardContent className="panel-body">
        <p className="muted">
          時刻はコロンなしの数字4桁（例：0930）で入力してください。編集しただけでは固定しません。再計算で維持する勤務・休憩を明示して固定してください。業務は再計算の対象です。必須条件に違反する編集は保存できません。
        </p>
        <UnsavedForm dirty={dirty}
          onSubmit={(e) => {
            e.preventDefault();
            void save(edit);
          }}
        >
          <fieldset disabled={disabled}>
            <div className="form-grid">
              <Field title="編集するスタッフ">
                <NativeSelect
                  value={a.staffId}
                  onChange={(e) =>
                    setIndex(
                      edit.assignments.findIndex(
                        (x) =>
                          x.staffId === e.target.value && x.date === a.date,
                      ),
                    )
                  }
                >
                  {input.staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {nameOf(s.id)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field title="編集する日">
                <NativeSelect
                  value={a.date}
                  onChange={(e) =>
                    setIndex(
                      edit.assignments.findIndex(
                        (x) =>
                          x.staffId === a.staffId && x.date === e.target.value,
                      ),
                    )
                  }
                >
                  {edit.assignments
                    .filter((x) => x.staffId === a.staffId)
                    .map((x) => (
                      <option key={x.date}>{x.date}</option>
                    ))}
                </NativeSelect>
              </Field>
              <Field title="勤務パターン">
                <NativeSelect
                  value={a.shift?.patternId ?? ""}
                  disabled={parts.length > 0}
                  onChange={(e) => {
                    try {
                      setEdit(
                        changePattern(edit, index, e.target.value, input),
                      );
                      setDirty(true);
                      setError("");
                    } catch (x) {
                      setError(String(x));
                    }
                  }}
                >
                  <option value="">休日</option>
                  {input.patterns.map((p) => (
                    <option key={p.id} value={p.id}>
                      {label(p.id)} {time(p.start)}〜{time(p.end)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {parts.length > 0 && (
              <p className="muted">
                固定中です。勤務を変更する場合は、下の固定を解除してください。
              </p>
            )}
            <div className="form-grid">
              {(["pattern", "time", "break"] as const).map((part, i) => (
                <label className="check-field" key={part}>
                  <Input
                    type="checkbox"
                    checked={parts.includes(part)}
                    onChange={(e) => {
                      setEdit(
                        setFixed(
                          edit,
                          index,
                          e.target.checked
                            ? [...parts, part]
                            : parts.filter((p) => p !== part),
                        ),
                      );
                      setDirty(true);
                    }}
                  />
                  {["勤務パターンを固定", "出退勤を固定", "休憩を固定"][i]}
                </label>
              ))}
            </div>
            {a.shift && (
              <>
                <p>
                  出退勤 {time(a.shift.start)}〜{time(a.shift.end)} ／ 勤務量{" "}
                  {a.shift.workedMinutes}分
                </p>
                <div className="form-grid">
                  <Field title="休憩開始">
                    <MinuteTimeInput
                      key={`${a.staffId}:${a.date}:break-start`}
                      onEdit={() => setDirty(true)}
                      stepMinutes={30}
                      value={a.shift.break?.[0] ?? null}
                      disabled={
                        parts.includes("break") || a.shift.breakKind === "fixed"
                      }
                      onMinutesChange={(value) => editBreak(value, true)}
                    />
                  </Field>
                  <Field title="休憩終了">
                    <MinuteTimeInput
                      key={`${a.staffId}:${a.date}:break-end`}
                      onEdit={() => setDirty(true)}
                      stepMinutes={30}
                      value={a.shift.break?.[1] ?? null}
                      disabled={
                        parts.includes("break") || a.shift.breakKind === "fixed"
                      }
                      onMinutesChange={(value) => editBreak(value, false)}
                    />
                  </Field>
                </div>
                <p className="muted">
                  休憩の固定／自動の種別は勤務パターンの設定を保持します。自動休憩は必要量と一致させてください。
                </p>
                <h3>業務配置</h3>
                <div className="table-scroll">
                  <Table>
                    <thead>
                      <tr>
                        <TableHead>時間枠</TableHead>
                        <TableHead>担当業務</TableHead>
                        <TableHead>担当区分</TableHead>
                      </tr>
                    </thead>
                    <tbody>
                      {a.blocks.map((b, i) => (
                        <tr key={i}>
                          <TableCell>
                            {time(b.start)}〜{time(b.end)}
                          </TableCell>
                          <TableCell>
                            <NativeSelect
                              aria-label={`業務 ${time(b.start)}`}
                              value={b.taskId}
                              onChange={(e) =>
                                update((copy) => {
                                  copy.assignments[index].blocks[i].taskId =
                                    e.target.value;
                                })
                              }
                            >
                              {input.tasks.map((t) => (
                                <option key={t.id} value={t.id}>
                                  {label(t.id)}
                                </option>
                              ))}
                            </NativeSelect>
                          </TableCell>
                          <TableCell>
                            <NativeSelect
                              aria-label={`担当区分 ${time(b.start)}`}
                              value={b.roleId ?? ""}
                              onChange={(e) =>
                                update((copy) => {
                                  copy.assignments[index].blocks[i].roleId =
                                    e.target.value || null;
                                })
                              }
                            >
                              <option value="">なし</option>
                              {input.roles
                                .filter((r) => person?.roleIds.includes(r.id))
                                .map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {label(r.id)}
                                  </option>
                                ))}
                            </NativeSelect>
                          </TableCell>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
                <h3>分単位の担当区分</h3>
                {(a.roleIntervals ?? []).map((r, i) => (
                  <div className="form-grid" key={i}>
                    <Field title={`担当区分の区間${i + 1}の開始`}>
                      <MinuteTimeInput
                        key={`${a.staffId}:${a.date}:role-start:${i}`}
                        onEdit={() => setDirty(true)}
                        value={r.start}
                        required
                        onMinutesChange={(value) =>
                          update((c) => {
                            c.assignments[index].roleIntervals![i].start =
                              value!;
                          })
                        }
                      />
                    </Field>
                    <Field title={`担当区分の区間${i + 1}の終了`}>
                      <MinuteTimeInput
                        key={`${a.staffId}:${a.date}:role-end:${i}`}
                        onEdit={() => setDirty(true)}
                        value={r.end}
                        required
                        onMinutesChange={(value) =>
                          update((c) => {
                            c.assignments[index].roleIntervals![i].end =
                              value!;
                          })
                        }
                      />
                    </Field>
                    <Field title={`担当区分の区間${i + 1}の担当区分`}>
                      <NativeSelect
                        value={r.roleId}
                        onChange={(e) =>
                          update((c) => {
                            c.assignments[index].roleIntervals![i].roleId =
                              e.target.value;
                          })
                        }
                      >
                        {input.roles
                          .filter((role) => person?.roleIds.includes(role.id))
                          .map((role) => (
                            <option key={role.id} value={role.id}>
                              {label(role.id)}
                            </option>
                          ))}
                      </NativeSelect>
                    </Field>
                    <Button
                      type="button"
                      onClick={() =>
                        update((c) => {
                          c.assignments[index].roleIntervals!.splice(i, 1);
                        })
                      }
                    >
                      担当区分の区間を削除
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  disabled={!person?.roleIds.length}
                  onClick={() =>
                    update((c) => {
                      (c.assignments[index].roleIntervals ??= []).push({
                        start: a.shift!.start,
                        end: Math.min(
                          a.shift!.end,
                          a.shift!.start + input.slotMinutes,
                        ),
                        roleId: person!.roleIds[0],
                      });
                    })
                  }
                >
                  担当区分の区間を追加
                </Button>
              </>
            )}
            <h3>勤務不可への手動配置の理由</h3>
            <p className="muted">
              本人・日付・区間ごとに理由を記録します。再計算へ例外を引き継ぐには、その勤務パターン・出退勤・休憩をすべて明示固定してください。
            </p>
            {edit.exceptions
              .filter((x) => x.staffId === a.staffId && x.date === a.date)
              .map((x) => (
                <div className="form-grid" key={x.id}>
                  <Field title="例外の開始">
                    <MinuteTimeInput
                      key={`${a.staffId}:${a.date}:exception-start:${x.id}`}
                      onEdit={() => setDirty(true)}
                      required
                      value={x.start}
                      onMinutesChange={(value) =>
                        update((c) => {
                          c.exceptions.find((v) => v.id === x.id)!.start =
                            value!;
                        })
                      }
                    />
                  </Field>
                  <Field title="例外の終了">
                    <MinuteTimeInput
                      key={`${a.staffId}:${a.date}:exception-end:${x.id}`}
                      onEdit={() => setDirty(true)}
                      required
                      value={x.end}
                      onMinutesChange={(value) =>
                        update((c) => {
                          c.exceptions.find((v) => v.id === x.id)!.end =
                            value!;
                        })
                      }
                    />
                  </Field>
                  <Field title="手動配置の理由">
                    <Input
                      required
                      maxLength={1000}
                      value={x.reason}
                      onChange={(e) =>
                        update((c) => {
                          c.exceptions.find((v) => v.id === x.id)!.reason =
                            e.target.value;
                        })
                      }
                    />
                  </Field>
                  <Button
                    type="button"
                    onClick={() =>
                      update((c) => {
                        c.exceptions = c.exceptions.filter(
                          (v) => v.id !== x.id,
                        );
                      })
                    }
                  >
                    例外を削除
                  </Button>
                </div>
              ))}
            <Button
              type="button"
              disabled={!a.shift}
              onClick={() =>
                update((c) => {
                  c.exceptions.push({
                    id: crypto.randomUUID(),
                    lockId: null,
                    staffId: a.staffId,
                    date: a.date,
                    start: a.shift!.start,
                    end: a.shift!.end,
                    reason: "",
                  });
                })
              }
            >
              理由付き例外を追加
            </Button>
            <div className="toolbar">
              <Button className="primary" disabled={!dirty}>
                検証して編集案を保存
              </Button>
              <span role="status">
                {dirty ? "編集中・未保存" : "保存済みの内容"}
              </span>
            </div>
          </fieldset>
        </UnsavedForm>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </CardContent>
      </details>
    </Card>
  );
}
