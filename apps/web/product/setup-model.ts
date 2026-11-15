import { z } from "zod";
import { teamConfig, companyPolicy } from "../../api/src/input-contracts";
import { SettingsInputError } from "./settings-input-error";
export function readBreakRule(f: FormData) {
  const integer = (key: string) => {
    const v = f.get(key);
    if (typeof v !== "string" || !/^\d+$/.test(v))
      throw new Error("INTEGER_REQUIRED");
    const number = Number(v);
    if (!Number.isSafeInteger(number)) throw new Error("INTEGER_REQUIRED");
    return number;
  };
  return companyPolicy.shape.breakRule.parse({
    basis: f.get("breakBasis"),
    threshold: integer("threshold"),
    requiredMinutes: integer("requiredMinutes"),
    afterStart: integer("afterStart"),
    beforeEnd: integer("beforeEnd"),
  });
}
import { scaledCount } from "./view-model";
export type Config = z.infer<typeof teamConfig>;
export type TaskDraft = {
  key: string;
  id: string;
  existing: boolean;
  kind: string;
  minimumLevel: string;
  minimumMinutes: string;
  capacities: Record<string, string>;
  rolePriority: string;
};
export type PatternDraft = {
  key: string;
  id: string;
  existing: boolean;
  start: string;
  end: string;
  breakKind: string;
  breakStart: string;
  breakEnd: string;
};
export type RoleDraft = {
  key: string;
  id: string;
  existing: boolean;
  allowed: string[];
};
export type TeamDraft = {
  slot: string;
  priority: string;
  scale: string;
  tasks: TaskDraft[];
  patterns: PatternDraft[];
  roles: RoleDraft[];
  rolePriority: string;
  transitions: Record<string, string>;
};
export const rowKey = () => crypto.randomUUID();
export const emptyTask = (): TaskDraft => ({
  key: rowKey(),
  id: "",
  existing: false,
  kind: "",
  minimumLevel: "",
  minimumMinutes: "",
  capacities: {},
  rolePriority: "",
});
export const emptyPattern = (): PatternDraft => ({
  key: rowKey(),
  id: "",
  existing: false,
  start: "",
  end: "",
  breakKind: "",
  breakStart: "",
  breakEnd: "",
});
export const pairKey = (from: string, to: string) => from + ":" + to;
export function coefficient(value: number, scale: number): string {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isSafeInteger(scale) ||
    scale < 1 ||
    scale > 10000
  )
    throw new Error("INVALID_PRECISION");
  let numerator = BigInt(value),
    denominator = BigInt(scale),
    a = numerator,
    b = denominator;
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  numerator /= a || 1n;
  denominator /= a || 1n;
  let remaining = denominator,
    two = 0,
    five = 0;
  while (remaining % 2n === 0n) {
    remaining /= 2n;
    two++;
  }
  while (remaining % 5n === 0n) {
    remaining /= 5n;
    five++;
  }
  if (remaining !== 1n) return `${numerator}/${denominator}`;
  const digits = Math.max(two, five),
    whole = (numerator * 10n ** BigInt(digits)) / denominator;
  if (!digits) return String(whole);
  const raw = String(whole).padStart(digits + 1, "0");
  return (raw.slice(0, -digits) + "." + raw.slice(-digits))
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}
export function parseCoefficient(value: string, scale: number): number {
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 10000)
    throw new Error("INVALID_PRECISION");
  const fraction = value.match(/^(\d+)\/(\d+)$/);
  if (!fraction) {
    const parsed = scaledCount(value, scale);
    if (parsed === null) throw new Error("COEFFICIENT_REQUIRED");
    return parsed;
  }
  const denominator = BigInt(fraction[2]),
    numerator = BigInt(fraction[1]) * BigInt(scale);
  if (!denominator || numerator % denominator)
    throw new Error("INVALID_PRECISION");
  const result = Number(numerator / denominator);
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("INVALID_PRECISION");
  return result;
}
export function teamDraft(config: Config | null): TeamDraft {
  if (!config)
    return {
      slot: "",
      priority: "",
      scale: "",
      tasks: [emptyTask()],
      patterns: [emptyPattern()],
      roles: [],
      rolePriority: "",
      transitions: {},
    };
  const tasks = config.tasks.map((t) => ({
    key: rowKey(),
    id: t.id,
    existing: true,
    kind: t.kind,
    minimumLevel: String(t.minimumLevel),
    minimumMinutes: String(t.minimumMinutes),
    capacities: Object.fromEntries(
      t.capacities.map((c) => [
        c.level,
        coefficient(c.capacity, config.capacityScale),
      ]),
    ),
    rolePriority:
      config.rolePolicies.find((p) => p.taskId === t.id)?.priority ?? "",
  }));
  const keyOf = (id: string) =>
    tasks.find((t) => t.id === id)?.key ?? "unresolved:" + id;
  return {
    slot: String(config.slotMinutes),
    priority: config.priority,
    scale: String(config.capacityScale),
    tasks,
    patterns: config.patterns.map((p) => ({
      key: rowKey(),
      id: p.id,
      existing: true,
      start: String(p.start),
      end: String(p.end),
      breakKind: p.breakKind,
      breakStart: p.fixedBreak ? String(p.fixedBreak[0]) : "",
      breakEnd: p.fixedBreak ? String(p.fixedBreak[1]) : "",
    })),
    roles: config.roles.map((r) => ({
      key: rowKey(),
      id: r.id,
      existing: true,
      allowed: r.allowedTasks.map(keyOf),
    })),
    rolePriority:
      config.rolePolicies.find((p) => p.taskId === null)?.priority ?? "",
    transitions: Object.fromEntries(
      config.transitions.map((t) => [
        pairKey(keyOf(t.fromTaskId), keyOf(t.toTaskId)),
        String(t.minutes),
      ]),
    ),
  };
}
export function buildTeam(d: TeamDraft, levels: { level: number; name?: string }[]): Config {
  const number = (v: string) => {
    if (!/^\d+$/.test(v)) throw new Error("INTEGER_REQUIRED");
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new Error("INTEGER_REQUIRED");
    return n;
  };
  const scale = number(d.scale),
    taskId = (key: string) => {
      const task = d.tasks.find((t) => t.key === key);
      if (!task) throw new Error("INVALID_REFERENCE");
      return task.id;
    };
  if (scale < 1 || scale > 10000) throw new Error("INVALID_PRECISION");
  const tasks = d.tasks.map((t, index) => ({
    id: t.id,
    kind: t.kind,
    minimumLevel: number(t.minimumLevel),
    minimumMinutes: number(t.minimumMinutes),
    capacities: levels.map((l) => ({
      level: l.level,
      capacity: (() => {
        if (t.kind === "dedicated") return 0;
        const value = t.capacities[l.level] ?? "";
        const label = `業務 ${index + 1}の「${l.name ?? `習熟度 ${l.level}`} の能力係数」`;
        try {
          return parseCoefficient(value, scale);
        } catch (error) {
          const code = error instanceof Error ? error.message : 'INVALID_PRECISION';
          const explanation = value === ''
            ? `${label}を入力してください。保存していません。`
            : /^(?:\d+(?:\.\d+)?|\d+\/[1-9]\d*)$/.test(value)
              ? `${label}は、能力係数の精度（現在${scale}）では正確に表せません。チームの計算設定で使用する小数の桁数に合う精度（例：0.01刻みなら100）へ変更し、「すべてのチーム設定を保存」を押してください。保存していません。`
              : `${label}は、半角の0以上の数値または分数（例：0.5、1、1/3）で入力してください。保存していません。`;
          throw new SettingsInputError(code, explanation);
        }
      })(),
    })),
  }));
  const config = teamConfig.parse({
    slotMinutes: number(d.slot),
    priority: d.priority,
    capacityScale: scale,
    tasks,
    patterns: d.patterns.map((p) => ({
      id: p.id,
      start: number(p.start),
      end: number(p.end),
      breakKind: p.breakKind,
      ...(p.breakKind === "fixed"
        ? { fixedBreak: [number(p.breakStart), number(p.breakEnd)] }
        : {}),
    })),
    roles: d.roles.map((r) => ({
      id: r.id,
      allowedTasks: r.allowed.map(taskId),
    })),
    rolePolicies: [
      { taskId: null, priority: d.rolePriority },
      ...d.tasks
        .filter((t) => t.kind === "general")
        .map((t) => ({ taskId: t.id, priority: t.rolePriority })),
    ],
    transitions: d.tasks.flatMap((from) =>
      d.tasks
        .filter((to) => to.key !== from.key)
        .map((to) => ({
          fromTaskId: from.id,
          toTaskId: to.id,
          minutes: number(d.transitions[pairKey(from.key, to.key)] ?? ""),
        })),
    ),
  });
  if (config.transitions.some((t) => t.minutes > config.slotMinutes))
    throw new Error("PREPARATION_EXCEEDS_SLOT");
  return config;
}
