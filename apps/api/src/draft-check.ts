import {SCHEDULE_JSON_LIMIT} from './schedule-serialization';
import { optimizerInputSchema } from "../../../packages/contracts/optimizer-input.generated";
import { boundedBytes } from "./compute-jobs";
import type { ContainerTransport } from "./compute-execution";
import { readInputSnapshot, sha256 } from "./input-snapshots";
import {
  candidateCommand,
  draftValidation,
  type CandidateCommand,
  type CandidateResult,
} from "./draft-contract";
import { assertPublishedLocks } from "./published-fixed";

export async function checkDraftCandidate(
  env: Pick<Env, "DB" | "INPUTS">,
  data: CandidateCommand,
  transport: ContainerTransport,
  terminate: () => Promise<void>,
): Promise<CandidateResult> {
  try {
    const c = candidateCommand.parse(data);
    const frozen = await readInputSnapshot(
      env.DB,
      env.INPUTS,
      c.companyId,
      c.teamId,
      c.userId,
      c.snapshotId,
      true,
      true,
    );
    const input = optimizerInputSchema.parse({
      ...frozen.input,
      locks: c.locks,
      exceptions: c.exceptions,
    });
    if (input.mode === "reallocation")
      await assertPublishedLocks(
        env.DB,
        c.companyId,
        c.teamId,
        input.month,
        c.locks,
      );
    const payload = { input, assignments: c.assignments },
      body = new TextEncoder().encode(JSON.stringify(payload));
    if (body.byteLength > SCHEDULE_JSON_LIMIT) throw new Error("CHECK_PAYLOAD_TOO_LARGE");
    const response = await transport("/check", payload);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`CHECK_HTTP_${response.status}`);
    }
    const validation = draftValidation.parse(
      JSON.parse(
        new TextDecoder().decode(await boundedBytes(response.body, SCHEDULE_JSON_LIMIT)),
      ),
    );
    return {
      snapshotSha256: frozen.snapshot.sha256,
      inputSha256: await sha256(
        new TextEncoder().encode(JSON.stringify(input)),
      ),
      validation,
    };
  } finally {
    // The result is returned only after process termination is confirmed.
    await terminate();
  }
}
