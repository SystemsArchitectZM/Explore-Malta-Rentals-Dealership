"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import {
  buildReconcileAllocationsPayload,
  canSubmitHistoricalReconcile,
} from "@/features/admin/lib/stripe-reconcile-form";
import {
  canOfferNewRefundAction,
  canOfferReconcileAction,
  canSubmitRefundDialog,
  isConfirmedRefundSuccessStatus,
  refundErrorMessageKey,
} from "@/features/admin/lib/stripe-refund-ui-policy";

type StripePaymentRow = {
  id: string;
  bookingId: string;
  bookingReference: string;
  customerName: string;
  customerEmail: string;
  amountEur: number;
  rentalAmountEur: number;
  depositAmountEur: number;
  rentalAvailableEur: number;
  depositAvailableEur: number;
  combinedAvailableEur?: number;
  availabilityReliable?: boolean;
  stripeStatus: string;
  refundStatus: string;
  refundedAmountEur: number;
  bookingStatus: string;
  depositMethod: string;
  needsReconciliation: boolean;
  unmatchedRefundIds: string[];
};

type RefundPurpose = "RENTAL" | "SECURITY_DEPOSIT";

type AdminStripePaymentPanelProps = Readonly<{
  viewerRole: string;
}>;

function newClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `refund_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatEur(amount: number): string {
  return amount.toFixed(2);
}

export function AdminStripePaymentPanel({ viewerRole }: AdminStripePaymentPanelProps) {
  const t = useTranslations("Admin.stripePayments");
  const formId = useId();
  const [payments, setPayments] = useState<StripePaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activePayment, setActivePayment] = useState<StripePaymentRow | null>(null);
  const [mode, setMode] = useState<"refund" | "reconcile" | null>(null);
  const [purpose, setPurpose] = useState<RefundPurpose>("RENTAL");
  const [amountEur, setAmountEur] = useState("");
  const [reason, setReason] = useState<"requested_by_customer" | "duplicate" | "fraudulent">(
    "requested_by_customer",
  );
  const [notes, setNotes] = useState("");
  const [clientRequestId, setClientRequestId] = useState(newClientRequestId);
  const [evidence, setEvidence] = useState("");
  /** Explicit purpose only — never pre-filled with RENTAL. */
  const [allocations, setAllocations] = useState<Record<string, RefundPurpose | "">>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);

  const canMutate = viewerRole === "ADMIN";

  const loadPayments = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const params = new URLSearchParams({ limit: "50" });
      if (search.trim()) params.set("search", search.trim());
      const response = await fetch(`/api/admin/payments?${params.toString()}`, {
        credentials: "same-origin",
      });
      const payload = (await response.json()) as {
        success?: boolean;
        payments?: StripePaymentRow[];
        message?: string;
      };
      if (!response.ok || !payload.success || !payload.payments) {
        throw new Error(payload.message ?? t("loadError"));
      }
      setPayments(payload.payments);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("loadError"));
      setPayments([]);
    } finally {
      setLoading(false);
    }
  }, [search, t]);

  useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

  const openRefund = (payment: StripePaymentRow) => {
    if (
      !canOfferNewRefundAction({
        viewerRole,
        needsReconciliation: payment.needsReconciliation,
        stripeStatus: payment.stripeStatus,
        rentalAvailableEur: payment.rentalAvailableEur,
        depositAvailableEur: payment.depositAvailableEur,
        availabilityReliable: payment.availabilityReliable,
      })
    ) {
      return;
    }
    setActivePayment(payment);
    setMode("refund");
    setPurpose("RENTAL");
    setAmountEur("");
    setReason("requested_by_customer");
    setNotes("");
    setClientRequestId(newClientRequestId());
    setFeedback(null);
    setFeedbackError(false);
  };

  const openReconcile = (payment: StripePaymentRow) => {
    if (!canOfferReconcileAction({ viewerRole, needsReconciliation: payment.needsReconciliation })) {
      return;
    }
    setActivePayment(payment);
    setMode("reconcile");
    setEvidence("");
    const initial: Record<string, RefundPurpose | ""> = {};
    for (const id of payment.unmatchedRefundIds) {
      initial[id] = "";
    }
    setAllocations(initial);
    setFeedback(null);
    setFeedbackError(false);
  };

  const reconcileReady = useMemo(() => {
    if (!activePayment || mode !== "reconcile" || !canMutate) return false;
    return canSubmitHistoricalReconcile({
      evidence,
      unmatchedRefundIds: activePayment.unmatchedRefundIds,
      allocations,
    });
  }, [activePayment, allocations, canMutate, evidence, mode]);

  const refundSubmitEnabled = useMemo(() => {
    if (!activePayment || mode !== "refund") return false;
    return canSubmitRefundDialog({
      viewerRole,
      needsReconciliation: activePayment.needsReconciliation,
      purpose,
      bookingStatus: activePayment.bookingStatus,
      busy,
    });
  }, [activePayment, busy, mode, purpose, viewerRole]);

  const closeDialog = () => {
    if (busy) return;
    setActivePayment(null);
    setMode(null);
  };

  const submitRefund = async () => {
    if (!activePayment || busy) return;
    if (
      !canSubmitRefundDialog({
        viewerRole,
        needsReconciliation: activePayment.needsReconciliation,
        purpose,
        bookingStatus: activePayment.bookingStatus,
        busy: false,
      })
    ) {
      return;
    }
    setBusy(true);
    setFeedback(null);
    setFeedbackError(false);
    try {
      const body: Record<string, unknown> = {
        purpose,
        clientRequestId,
        reason,
      };
      if (notes.trim()) body.notes = notes.trim();
      if (amountEur.trim()) {
        const parsed = Number(amountEur);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(t("dialog.error"));
        }
        body.amountEur = parsed;
      }

      const response = await fetch(`/api/admin/payments/${activePayment.id}/refund`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        success?: boolean;
        status?: string;
        message?: string;
        code?: string | null;
      };
      if (!response.ok || !payload.success) {
        const mapped = refundErrorMessageKey(payload.code ?? undefined);
        throw new Error(mapped ? t(`errors.${mapped}`) : (payload.message ?? t("dialog.error")));
      }
      const confirmed = isConfirmedRefundSuccessStatus(payload.status);
      setFeedback(confirmed ? t("dialog.success") : t("dialog.pending"));
      setFeedbackError(false);
      if (confirmed) {
        setClientRequestId(newClientRequestId());
      }
      await loadPayments();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : t("dialog.error"));
      setFeedbackError(true);
    } finally {
      setBusy(false);
    }
  };

  const submitReconcile = async () => {
    if (!activePayment || busy || !canMutate) return;
    const built = buildReconcileAllocationsPayload(
      activePayment.unmatchedRefundIds,
      allocations,
    );
    if (!built.ok || !canSubmitHistoricalReconcile({
      evidence,
      unmatchedRefundIds: activePayment.unmatchedRefundIds,
      allocations,
    })) {
      setFeedback(t("reconcile.purposeRequired"));
      setFeedbackError(true);
      return;
    }
    setBusy(true);
    setFeedback(null);
    setFeedbackError(false);
    try {
      const response = await fetch(`/api/admin/payments/${activePayment.id}/reconcile-refunds`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          evidence: evidence.trim(),
          allocations: built.allocations,
        }),
      });
      const payload = (await response.json()) as {
        success?: boolean;
        message?: string;
        code?: string | null;
      };
      if (!response.ok || !payload.success) {
        const mapped = refundErrorMessageKey(payload.code ?? undefined);
        throw new Error(
          mapped ? t(`errors.${mapped}`) : (payload.message ?? t("reconcile.error")),
        );
      }
      setFeedback(t("reconcile.success"));
      setFeedbackError(false);
      await loadPayments();
      setMode(null);
      setActivePayment(null);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : t("reconcile.error"));
      setFeedbackError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {!canMutate ? (
        <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          {t("staffReadOnlyHint")}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="block flex-1 text-sm font-medium text-slate-700">
          <span className="sr-only">{t("searchPlaceholder")}</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-[#3a7ca5]/30 focus:ring-2"
          />
        </label>
        <button
          type="button"
          onClick={() => void loadPayments()}
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          {t("refresh")}
        </button>
      </div>

      {loading ? <p className="text-sm text-slate-600">{t("loading")}</p> : null}
      {loadError ? <p className="text-sm text-red-600">{loadError}</p> : null}
      {!loading && !loadError && payments.length === 0 ? (
        <p className="text-sm text-slate-600">{t("empty")}</p>
      ) : null}

      {payments.length > 0 ? (
        <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-semibold">{t("columns.booking")}</th>
                <th className="px-4 py-3 font-semibold">{t("columns.customer")}</th>
                <th className="px-4 py-3 font-semibold">{t("columns.amount")}</th>
                <th className="px-4 py-3 font-semibold">{t("columns.status")}</th>
                <th className="px-4 py-3 font-semibold">{t("columns.refund")}</th>
                <th className="px-4 py-3 font-semibold">{t("columns.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => {
                const offerRefund = canOfferNewRefundAction({
                  viewerRole,
                  needsReconciliation: payment.needsReconciliation,
                  stripeStatus: payment.stripeStatus,
                  rentalAvailableEur: payment.rentalAvailableEur,
                  depositAvailableEur: payment.depositAvailableEur,
                  availabilityReliable: payment.availabilityReliable,
                });
                const offerReconcile = canOfferReconcileAction({
                  viewerRole,
                  needsReconciliation: payment.needsReconciliation,
                });
                return (
                  <tr key={payment.id} className="border-b border-slate-100 align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{payment.bookingReference}</div>
                      <div className="text-xs text-slate-500">{payment.bookingStatus}</div>
                      {payment.needsReconciliation ? (
                        <p className="mt-1 max-w-xs text-xs text-amber-700">{t("needsReconciliation")}</p>
                      ) : null}
                      {payment.availabilityReliable === false ? (
                        <p className="mt-1 max-w-xs text-xs text-amber-700">{t("availabilityUnavailable")}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-slate-900">{payment.customerName}</div>
                      <div className="text-xs text-slate-500">{payment.customerEmail}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div>€{formatEur(payment.amountEur)}</div>
                      <div className="text-xs text-slate-500">
                        {t("rentalAllocated", { amount: formatEur(payment.rentalAmountEur) })}
                      </div>
                      <div className="text-xs text-slate-500">
                        {t("depositAllocated", { amount: formatEur(payment.depositAmountEur) })}
                      </div>
                      <div className="text-xs text-slate-500">
                        {t("rentalAvailable", { amount: formatEur(payment.rentalAvailableEur) })}
                      </div>
                      <div className="text-xs text-slate-500">
                        {t("depositAvailable", { amount: formatEur(payment.depositAvailableEur) })}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>{payment.stripeStatus}</div>
                      <div className="text-xs text-slate-500">{payment.depositMethod}</div>
                    </td>
                    <td className="px-4 py-3">
                      €{formatEur(payment.refundedAmountEur)} ({payment.refundStatus})
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-2">
                        {canMutate ? (
                          <button
                            type="button"
                            onClick={() => openRefund(payment)}
                            disabled={!offerRefund}
                            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {t("refundAction")}
                          </button>
                        ) : null}
                        {offerReconcile ? (
                          <button
                            type="button"
                            onClick={() => openReconcile(payment)}
                            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-900 transition hover:bg-amber-100"
                          >
                            {t("reconcileAction")}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {activePayment && mode === "refund" && canMutate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${formId}-refund-title`}
            className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl"
          >
            <h3 id={`${formId}-refund-title`} className="text-lg font-bold text-slate-950">
              {t("dialog.title")}
            </h3>
            <p className="mt-1 text-sm text-slate-600">{activePayment.bookingReference}</p>
            {activePayment.needsReconciliation ? (
              <p className="mt-3 text-sm text-amber-700">{t("dialog.blockedHint")}</p>
            ) : null}

            <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <div>
                {t("rentalAllocated", { amount: formatEur(activePayment.rentalAmountEur) })}
                {" · "}
                {t("rentalAvailable", { amount: formatEur(activePayment.rentalAvailableEur) })}
              </div>
              <div className="mt-1">
                {t("depositAllocated", { amount: formatEur(activePayment.depositAmountEur) })}
                {" · "}
                {t("depositAvailable", { amount: formatEur(activePayment.depositAvailableEur) })}
              </div>
            </div>

            <p className="mt-3 text-sm text-slate-600">{t("dialog.prePickupHint")}</p>

            <div className="mt-4 space-y-3">
              <label className="block text-sm font-medium text-slate-700">
                {t("dialog.purpose")}
                <select
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value as RefundPurpose)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                >
                  <option value="RENTAL">{t("dialog.purposeRental")}</option>
                  <option value="SECURITY_DEPOSIT">{t("dialog.purposeDeposit")}</option>
                </select>
              </label>

              {purpose === "SECURITY_DEPOSIT" && activePayment.bookingStatus !== "COMPLETED" ? (
                <p className="text-sm text-amber-800">{t("dialog.depositRequiresCompleted")}</p>
              ) : null}

              <label className="block text-sm font-medium text-slate-700">
                {t("dialog.amount")}
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={amountEur}
                  onChange={(event) => setAmountEur(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                />
              </label>

              <label className="block text-sm font-medium text-slate-700">
                {t("dialog.reason")}
                <select
                  value={reason}
                  onChange={(event) =>
                    setReason(event.target.value as typeof reason)
                  }
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                >
                  <option value="requested_by_customer">{t("reasons.requested_by_customer")}</option>
                  <option value="duplicate">{t("reasons.duplicate")}</option>
                  <option value="fraudulent">{t("reasons.fraudulent")}</option>
                </select>
              </label>

              <label className="block text-sm font-medium text-slate-700">
                {t("dialog.notes")}
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                />
              </label>

              <label className="block text-sm font-medium text-slate-700">
                {t("dialog.clientRequestId")}
                <input
                  type="text"
                  value={clientRequestId}
                  readOnly
                  className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700"
                />
              </label>
              <button
                type="button"
                onClick={() => setClientRequestId(newClientRequestId())}
                className="text-xs font-semibold text-[#3a7ca5] hover:underline"
              >
                {t("dialog.newAttempt")}
              </button>
            </div>

            {feedback ? (
              <p className={`mt-3 text-sm ${feedbackError ? "text-red-600" : "text-emerald-700"}`}>
                {feedback}
              </p>
            ) : null}
            <p className="mt-2 text-xs text-slate-500">{t("dialog.pendingHint")}</p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeDialog}
                disabled={busy}
                className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
              >
                {t("dialog.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void submitRefund()}
                disabled={!refundSubmitEnabled}
                className="rounded-xl bg-[#3a7ca5] px-4 py-2 text-sm font-semibold text-white hover:bg-[#326d91] disabled:opacity-40"
              >
                {busy ? t("dialog.submitting") : t("dialog.submit")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {activePayment && mode === "reconcile" && canMutate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${formId}-reconcile-title`}
            className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl"
          >
            <h3 id={`${formId}-reconcile-title`} className="text-lg font-bold text-slate-950">
              {t("reconcile.title")}
            </h3>
            <p className="mt-1 text-sm text-slate-600">{activePayment.bookingReference}</p>
            <p className="mt-2 text-sm text-amber-800">{t("needsReconciliation")}</p>
            <p className="mt-1 text-xs text-slate-500">{t("reconcile.purposeHint")}</p>

            <label className="mt-4 block text-sm font-medium text-slate-700">
              {t("reconcile.evidence")}
              <textarea
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                rows={3}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </label>

            <div className="mt-4 space-y-3">
              {activePayment.unmatchedRefundIds.map((refundId) => (
                <label key={refundId} className="block text-sm font-medium text-slate-700">
                  {t("reconcile.purpose", { refundId })}
                  <select
                    value={allocations[refundId] ?? ""}
                    onChange={(event) =>
                      setAllocations((prev) => ({
                        ...prev,
                        [refundId]: event.target.value as RefundPurpose | "",
                      }))
                    }
                    className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                    required
                  >
                    <option value="">{t("reconcile.purposePlaceholder")}</option>
                    <option value="RENTAL">{t("dialog.purposeRental")}</option>
                    <option value="SECURITY_DEPOSIT">{t("dialog.purposeDeposit")}</option>
                  </select>
                </label>
              ))}
            </div>

            {feedback ? (
              <p className={`mt-3 text-sm ${feedbackError ? "text-red-600" : "text-emerald-700"}`}>
                {feedback}
              </p>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeDialog}
                disabled={busy}
                className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
              >
                {t("reconcile.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void submitReconcile()}
                disabled={busy || !reconcileReady}
                className="rounded-xl bg-amber-700 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-800 disabled:opacity-40"
              >
                {busy ? t("reconcile.submitting") : t("reconcile.submit")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
