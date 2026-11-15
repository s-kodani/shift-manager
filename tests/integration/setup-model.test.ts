import { expect, it } from "vitest";
import {
  buildTeam,
  coefficient,
  parseCoefficient,
  pairKey,
  teamDraft,
  readBreakRule,
  emptyTask,
} from "../../apps/web/product/setup-model";
import { SettingsInputError } from "../../apps/web/product/settings-input-error";
import { probeConfig, probePolicy } from "../../apps/api/src/input-probes";
import { teamConfig } from "../../apps/api/src/input-contracts";
it("Q70: company break form preserves explicit zero and integer-minute windows and refuses blank or unaligned values", () => {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    breakBasis: "worked",
    threshold: "0",
    requiredMinutes: "30",
    afterStart: "7",
    beforeEnd: "11",
  }))
    form.set(key, value);
  expect(readBreakRule(form)).toEqual({
    basis: "worked",
    threshold: 0,
    requiredMinutes: 30,
    afterStart: 7,
    beforeEnd: 11,
  });
  form.set("afterStart", "");
  expect(() => readBreakRule(form)).toThrow("INTEGER_REQUIRED");
  form.set("afterStart", "7.5");
  expect(() => readBreakRule(form)).toThrow("INTEGER_REQUIRED");
  form.set("afterStart", "7");
  form.set("requiredMinutes", "31");
  expect(() => readBreakRule(form)).toThrow();
});
it("setup: exact coefficient round-trip includes decimal and nondecimal precision; never approximates", () => {
  expect(coefficient(29, 100)).toBe("0.29");
  expect(coefficient(1, 3)).toBe("1/3");
  expect(coefficient(0, 100)).toBe("0");
  expect(parseCoefficient("0.29", 100)).toBe(29);
  expect(parseCoefficient("1/3", 3)).toBe(1);
  expect(() => parseCoefficient("0.333", 3)).toThrow();
  expect(() => parseCoefficient("1/3", 100)).toThrow();
  expect(() => parseCoefficient("", 100)).toThrow();
  expect(() => parseCoefficient("0", 0)).toThrow();
  expect(() => coefficient(0, 0)).toThrow();
});
it("setup: loaded configuration preserves exact time, identities, role references and all coefficients", () => {
  const config = teamConfig.parse(probeConfig);
  expect(buildTeam(teamDraft(config), probePolicy.skillLevels)).toEqual(config);
  const nondecimal = teamConfig.parse({
    ...probeConfig,
    capacityScale: 3,
    tasks: [
      {
        ...probeConfig.tasks[0],
        capacities: [
          { level: 0, capacity: 1 },
          { level: 1, capacity: 3 },
        ],
      },
      probeConfig.tasks[1],
    ],
  });
  expect(buildTeam(teamDraft(nondecimal), probePolicy.skillLevels)).toEqual(
    nondecimal,
  );
});
it("setup: empty settings have no saved defaults, and each ordered transition requires explicit minutes", () => {
  const empty = teamDraft(null);
  expect(empty.slot).toBe("");
  expect(empty.tasks[0].minimumMinutes).toBe("");
  expect(() => buildTeam(empty, probePolicy.skillLevels)).toThrow();
  const d = teamDraft(teamConfig.parse(probeConfig)),
    key = pairKey(d.tasks[0].key, d.tasks[1].key);
  delete d.transitions[key];
  expect(() => buildTeam(d, probePolicy.skillLevels)).toThrow(
    "INTEGER_REQUIRED",
  );
  d.transitions[key] = "0";
  expect(buildTeam(d, probePolicy.skillLevels).transitions[0].minutes).toBe(0);
  d.transitions[key] = "7";
  expect(buildTeam(d, probePolicy.skillLevels).transitions[0].minutes).toBe(7);
  d.transitions[key] = "31";
  expect(() => buildTeam(d, probePolicy.skillLevels)).toThrow(
    "PREPARATION_EXCEEDS_SLOT",
  );
});
it('TS-DETAIL-05: slot changes never round a saved forty-minute preparation; zero and thirty are allowed in a thirty-minute slot',()=>{
  const d=teamDraft(teamConfig.parse(probeConfig)),key=pairKey(d.tasks[0].key,d.tasks[1].key);
  d.slot='30';
  for(const minutes of ['0','30']){
    d.transitions[key]=minutes;
    expect(buildTeam(d,probePolicy.skillLevels).transitions[0].minutes).toBe(Number(minutes));
  }
  d.slot='60';d.transitions[key]='40';
  expect(buildTeam(d,probePolicy.skillLevels).transitions[0].minutes).toBe(40);
  d.slot='30';
  expect(()=>buildTeam(d,probePolicy.skillLevels)).toThrow('PREPARATION_EXCEEDS_SLOT');
  expect(d.transitions[key]).toBe('40');
});
it("setup: renaming a new draft keeps qualified task references connected; deleted references fail closed", () => {
  const d = teamDraft(teamConfig.parse(probeConfig));
  d.tasks[0].id = "架空電話";
  const result = buildTeam(d, probePolicy.skillLevels);
  expect(result.roles[0].allowedTasks).toEqual(["架空電話"]);
  expect(result.transitions[0].fromTaskId).toBe("架空電話");
  d.roles[0].allowed = ["missing"];
  expect(() => buildTeam(d, probePolicy.skillLevels)).toThrow(
    "INVALID_REFERENCE",
  );
});

it('setup: editing and adding tasks with decimal coefficients explains precision failure and preserves exact values on full save', () => {
  const initial = teamConfig.parse({...probeConfig, capacityScale: 1,
    tasks: probeConfig.tasks.map(task => ({...task, capacities: task.capacities.map(c => ({...c, capacity: 1}))})),
  });
  const d = teamDraft(initial);
  d.tasks[0].minimumMinutes = '15';
  d.tasks[0].capacities = {0: '0.5', 1: '1.2'};
  d.tasks.push({...emptyTask(), id: '架空追加業務', kind: 'general', minimumLevel: '1',
    minimumMinutes: '30', rolePriority: 'same', capacities: {0: '0.5', 1: '1.5'}});
  for (const from of d.tasks) for (const to of d.tasks)
    if (from.key !== to.key) d.transitions[pairKey(from.key, to.key)] = '0';
  try {
    buildTeam(d, probePolicy.skillLevels);
    expect.fail('Precision 1 must refuse decimal coefficients');
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsInputError);
    expect((error as SettingsInputError).explanation).toContain('業務 1');
    expect((error as SettingsInputError).explanation).toContain('能力係数の精度（現在1）');
    expect((error as SettingsInputError).explanation).toContain('すべてのチーム設定を保存');
  }
  expect(d.tasks[0].capacities).toEqual({0: '0.5', 1: '1.2'});
  d.scale = '100';
  const saved = buildTeam(d, probePolicy.skillLevels);
  expect(saved.tasks[0].minimumMinutes).toBe(15);
  expect(saved.tasks[0].capacities.map(c => c.capacity)).toEqual([50, 120]);
  expect(saved.tasks[2].capacities.map(c => c.capacity)).toEqual([50, 150]);
  expect(saved.transitions).toHaveLength(6);
  expect(initial.capacityScale).toBe(1);
});

it('setup: coefficient errors identify the task and skill level without treating missing or malformed values as related-section changes', () => {
  const d = teamDraft(teamConfig.parse(probeConfig));
  for (const [value, message] of [['', '入力してください'], ['０．５', '半角の0以上の数値']]) {
    d.tasks[0].capacities[0] = value;
    try {
      buildTeam(d, probePolicy.skillLevels);
      expect.fail('Invalid coefficient must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsInputError);
      const explanation = (error as SettingsInputError).explanation;
      expect(explanation).toContain(`業務 1の「${probePolicy.skillLevels[0].name} の能力係数」`);
      expect(explanation).toContain(message);
      expect(explanation).not.toContain('すべてのチーム設定を保存');
    }
  }
});
