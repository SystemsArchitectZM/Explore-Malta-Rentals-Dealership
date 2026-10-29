/**
 * Pure UI/policy helpers for historical refund reconciliation forms.
 * Purpose must be explicitly chosen — never defaulted to RENTAL.
 */

export type ReconcileAllocationPurpose = "RENTAL" | "SECURITY_DEPOSIT";

export function isExplicitReconcilePurpose(
  value: unknown,
): value is ReconcileAllocationPurpose {
  return value === "RENTAL" || value === "SECURITY_DEPOSIT";
}

export function areReconcileAllocationsComplete(
  unmatchedRefundIds: string[],
  allocations: Record<string, string | undefined>,
): boolean {
  if (unmatchedRefundIds.length === 0) return false;
  return unmatchedRefundIds.every((id) => isExplicitReconcilePurpose(allocations[id]));
}

export function canSubmitHistoricalReconcile(input: {
  evidence: string;
  unmatchedRefundIds: string[];
  allocations: Record<string, string | undefined>;
  minEvidenceLength?: number;
}): boolean {
  const min = input.minEvidenceLength ?? 8;
  if (input.evidence.trim().length < min) return false;
  return areReconcileAllocationsComplete(input.unmatchedRefundIds, input.allocations);
}

export function buildReconcileAllocationsPayload(
  unmatchedRefundIds: string[],
  allocations: Record<string, string | undefined>,
):
  | { ok: true; allocations: Array<{ stripeRefundId: string; purpose: ReconcileAllocationPurpose }> }
  | { ok: false; error: "missing_purpose" | "empty_unmatched" } {
  if (unmatchedRefundIds.length === 0) {
    return { ok: false, error: "empty_unmatched" };
  }
  const rows: Array<{ stripeRefundId: string; purpose: ReconcileAllocationPurpose }> = [];
  for (const stripeRefundId of unmatchedRefundIds) {
    const purpose = allocations[stripeRefundId];
    if (!isExplicitReconcilePurpose(purpose)) {
      return { ok: false, error: "missing_purpose" };
    }
    rows.push({ stripeRefundId, purpose });
  }
  return { ok: true, allocations: rows };
}
