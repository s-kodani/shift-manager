import type {InputDatabase} from './input-versions';
import type {PublicationDocument} from './publication-contract';

// Commit triggers check prerequisites; this postcondition also checks that the
// final INSERT and its derived heads/revision actually took effect in the batch.
export function publicationCompletionGuard(db:InputDatabase,d:PublicationDocument,key:string,digest:string,size:number,fingerprint:string) {
  return db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM schedule_publication_version p
    JOIN schedule_publication_commit m ON m.company_id=p.company_id AND m.publication_id=p.id
    JOIN schedule_publication_head h ON h.company_id=p.company_id AND h.team_id=p.team_id AND h.month=p.month
    JOIN publication_validation_head v ON v.company_id=p.company_id AND v.team_id=p.team_id AND v.month=p.month
    JOIN company c ON c.id=p.company_id
    JOIN product_audit a ON a.company_id=p.company_id AND a.id=p.id
    JOIN published_fixed_source f ON f.company_id=p.company_id AND f.publication_id=p.id
    JOIN published_fixed_seal s ON s.company_id=f.company_id AND s.publication_id=f.publication_id
    WHERE p.company_id=? AND p.id=? AND p.team_id=? AND p.month=? AND p.actor_id=?
      AND p.object_key=? AND p.sha256=? AND p.byte_length=? AND p.fingerprint=?
      AND p.input_revision=? AND p.applied_revision=? AND p.expected_publication_revision=?
      AND p.assignment_count=? AND p.assignment_count=(SELECT count(*) FROM schedule_publication_assignment WHERE company_id=p.company_id AND publication_id=p.id)
      AND h.publication_id=p.id AND h.revision=p.expected_publication_revision+1
      AND v.publication_id=p.id AND v.required_revision=p.applied_revision AND v.validation_id IS NULL
      AND c.revision=p.applied_revision AND a.actor_id=p.actor_id AND a.revision=p.applied_revision
      AND a.kind=CASE WHEN p.origin='cancellation' THEN 'schedule:cancelled' ELSE 'schedule:published' END
      AND f.document_sha256=p.sha256
    ) THEN 1 ELSE abs(-9223372036854775808) END AS publication_saved`)
    .bind(d.tenantId,d.publicationId,d.teamId,d.month,d.actorId,key,digest,size,fingerprint,
      d.inputRevision,d.appliedRevision,d.publicationRevision-1,d.assignments.length);
}
