import { z } from 'zod';
import { optimizerInputSchema } from '../../../packages/contracts/optimizer-input.generated';

const input = optimizerInputSchema.shape;
const person = input.staff.element.shape;
export const workRule = person.rules.element.omit({ id: true });
export const workContract = person.contract;
const skillLevel = z.number().int().min(0).max(10000);
const unique = (values: unknown[]) => new Set(values.map((v) => JSON.stringify(v))).size === values.length;
const policyBase = z.object({
  rule: workRule, contract: workContract,
  skillLevels: z.array(z.object({ level: skillLevel, name: z.string().trim().min(1).max(120) }).strict()).min(1).max(100)
    .refine((levels) => unique(levels.map((l) => l.level)), 'DUPLICATE_LEVEL'),
}).strict();
export const companyPolicy = policyBase.extend({breakRule:input.breakRule}).strict();
// Old immutable versions remain readable for explicit administrator setup.
// Missing company rules are never synthesized from a team's previous value.
export const storedCompanyPolicy = policyBase.extend({breakRule:input.breakRule.optional()}).strict();
export const employmentPolicy = z.object({ name: z.string().trim().min(1).max(120), rule: workRule, contract: workContract }).strict();
export const staffContract = z.object({
  employmentTypeId: z.string().uuid(), contract: workContract, rule: workRule.nullable(),
  skills: z.array(person.skills.element.omit({ capacity: true })).max(5)
    .refine((skills) => unique(skills.map((s) => s.taskId)), 'DUPLICATE_SKILL'),
  roleIds: person.roleIds,
}).strict();
export const teamConfig = optimizerInputSchema.pick({ slotMinutes:true,priority:true,patterns:true,roles:true,transitions:true,capacityScale:true }).extend({
  tasks: z.array(input.tasks.element.extend({
    capacities: z.array(z.object({ level: skillLevel, capacity: person.skills.element.shape.capacity }).strict()).max(100)
      .refine((levels) => unique(levels.map((l) => l.level)), 'DUPLICATE_CAPACITY_LEVEL'),
  })).min(1).max(5),
  rolePolicies: z.array(z.object({ taskId: z.string().nullable(), priority: z.enum(['first','same']) }).strict()).max(6)
    .refine((policies) => unique(policies.map((p) => p.taskId)), 'DUPLICATE_ROLE_POLICY'),
}).strict();
export const storedTeamConfig=teamConfig.extend({breakRule:input.breakRule.optional()}).transform(({breakRule:_,...config})=>config);
export const planning = z.object({
  demand: input.demand, events: input.events,
  roleRequirements: z.array(input.roleRequirements.element.omit({ rounding:true,priority:true })),
}).strict();
export const staffMonth = z.object({ unavailable: person.unavailable, preferences: person.preferences }).strict();
export const resourceSchemas = { company_policy:companyPolicy,employment_policy:employmentPolicy,staff_contract:staffContract,team_config:teamConfig,planning,staff_month:staffMonth };
export type InputKind = keyof typeof resourceSchemas;
export function parseResource(kind: InputKind, value: unknown) { return resourceSchemas[kind].parse(value); }
export function readResource(kind:InputKind,value:unknown){
  return kind==='company_policy'?storedCompanyPolicy.parse(value):kind==='team_config'?storedTeamConfig.parse(value):parseResource(kind,value);
}
