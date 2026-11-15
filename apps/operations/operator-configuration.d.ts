// Generated from infra/operator-provision.jsonc and infra/wrangler.jsonc by Wrangler via scripts/generate-operator-types.mjs.
export interface OperatorEnv {
	DB: D1Database;
	OPERATOR_PRINCIPAL: string;
	RECOVERY_SECURITY_ID: string;
	RECOVERY_DATABASE_ID: string;
	OPERATOR_TOKEN: string;
	SOLVER: DurableObjectNamespace<import("../api/src/index").OptimizerContainer>;
}
