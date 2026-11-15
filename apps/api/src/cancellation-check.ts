import {SCHEDULE_JSON_LIMIT} from './schedule-serialization';
import { boundedBytes } from "./compute-jobs";
import type { ContainerTransport } from "./compute-execution";
import { publicationValidation } from "./checker-contract";
import {
  buildCancellationCandidate,
  assertCancellationCurrent,
} from "./cancellation-candidate";
import {
  cancellationCheckResult,
  type CancellationCandidateCommand,
  type CancellationCheckResult,
} from "./cancellation-contract";
import type { InputDatabase } from "./input-versions";

export async function checkCancellationCandidate(
  env: { DB: InputDatabase; INPUTS: R2Bucket },
  command: CancellationCandidateCommand,
  transport: ContainerTransport,
  terminate: () => Promise<void>,
): Promise<CancellationCheckResult> {
  try {
    const candidate = await buildCancellationCandidate(env, command);
    const payload = {
      input: candidate.input,
      assignments: candidate.assignments,
    };
    if (
      new TextEncoder().encode(JSON.stringify(payload)).byteLength > SCHEDULE_JSON_LIMIT
    )
      throw new Error("CHECK_PAYLOAD_TOO_LARGE");
    const response = await transport("/check", payload);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("CHECK_HTTP_" + response.status);
    }
    const validation = publicationValidation.parse(
      JSON.parse(
        new TextDecoder().decode(await boundedBytes(response.body, SCHEDULE_JSON_LIMIT)),
      ),
    );
    // Re-read all scoped sources after Container I/O. This is a preflight result,
    // never authorization to commit after any later input/permission change.
    await assertCancellationCurrent(env, candidate);
    return cancellationCheckResult.parse({
      operationId: command.operationId,
      requestId: command.requestId,
      requestRevision: candidate.record.requestRevision,
      publicationId: command.publicationId,
      publicationRevision: command.expectedPublicationRevision,
      inputRevision: command.expectedRevision,
      candidateSha256: candidate.candidateSha256,
      publicationSha256: candidate.evidence.row.sha256,
      capacityScale: candidate.input.capacityScale,
      validation,
      removedParticipations: candidate.removedParticipations,
      approval: "NOT_COMMITTED",
    });
  } finally {
    await terminate();
  }
}
