"use client";

import { ArrowRight, ArrowRightLeft, Bike, CalendarPlus, CheckCircle2, KeyRound, Loader2, RotateCcw, Undo2, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { AdminBookingChangeVehicleDialog } from "@/features/admin/components/admin-booking-change-vehicle-dialog";
import { AdminBookingReplaceVehicleDialog } from "@/features/admin/components/admin-booking-replace-vehicle-dialog";
import { AdminBookingExtendDialog } from "@/features/admin/components/admin-booking-extend-dialog";
import { resolveHandOverVehicleUnitId } from "@/lib/admin/bookings/resolve-hand-over-vehicle-unit-id";
import type { AdminBookingDetail } from "@/lib/admin/bookings/types";
import type { AdminVehicleUnitDto } from "@/lib/admin/vehicle-units/types";
import { buildBookingCancellationEmailDraft } from "@/lib/email/buildBookingCancellationEmailDraft";

type AdminBookingLifecycleActionsProps = Readonly<{
  booking: AdminBookingDetail;
  vehicleUnits: AdminVehicleUnitDto[];
}>;

const LIFECYCLE_SUCCESS_STORAGE_KEY = "admin-booking-lifecycle-success";

function readLifecycleSuccess(bookingId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(LIFECYCLE_SUCCESS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { bookingId?: string; message?: string };
    if (parsed.bookingId !== bookingId || !parsed.message?.trim()) {
      return null;
    }
    window.sessionStorage.removeItem(LIFECYCLE_SUCCESS_STORAGE_KEY);
    return parsed.message;
  } catch {
    return null;
  }
}

function storeLifecycleSuccess(bookingId: string, message: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      LIFECYCLE_SUCCESS_STORAGE_KEY,
      JSON.stringify({ bookingId, message }),
    );
  } catch {
    // Ignore quota / private-mode failures; in-memory toast still runs.
  }
}

type ActiveDialog = "handOver" | "markReturned" | "complete" | "cancel" | "restore" | "extend" | "changeVehicle" | "replaceVehicle" | null;

function previousStatusBeforeCancel(booking: AdminBookingDetail): "CONFIRMED" | "PENDING_PAYMENT" {
  const cancelled = booking.statusHistory.find(
    (entry) =>
      entry.newStatus === "CANCELLED" &&
      (entry.oldStatus === "CONFIRMED" || entry.oldStatus === "PENDING_PAYMENT"),
  );
  return cancelled?.oldStatus === "PENDING_PAYMENT" ? "PENDING_PAYMENT" : "CONFIRMED";
}

type CancelDialogStep = "details" | "email";

function toLocalDateTimeInputValue(iso: string | null | undefined): string {
  if (!iso) {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const local = new Date(now.getTime() - offset * 60_000);
    return local.toISOString().slice(0, 16);
  }
  const date = new Date(iso);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

function inputClassName(): string {
  return "w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[#3a7ca5]/40 focus:bg-white focus:ring-2 focus:ring-[#3a7ca5]/15";
}

function labelClassName(): string {
  return "mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500";
}

const lifecycleConfirmButtonClassName =
  "inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60";

type LifecycleActionVariant = "primary" | "danger" | "orange" | "sky";

function stageGuidelineTheme(status: AdminBookingDetail["status"]) {
  switch (status) {
    case "PENDING_PAYMENT":
      return {
        box: "border-amber-300/60 bg-amber-50",
        label: "text-amber-700",
        divider: "border-amber-200",
      };
    case "CONFIRMED":
      return {
        box: "border-emerald-300/60 bg-emerald-50",
        label: "text-emerald-700",
        divider: "border-emerald-200",
      };
    case "VEHICLE_HANDED_OVER":
      return {
        box: "border-orange-300/60 bg-orange-50",
        label: "text-orange-700",
        divider: "border-orange-200",
      };
    case "RETURNED":
      return {
        box: "border-sky-300/60 bg-sky-50",
        label: "text-sky-700",
        divider: "border-sky-200",
      };
    default:
      return {
        box: "border-slate-200 bg-slate-50",
        label: "text-slate-600",
        divider: "border-slate-200",
      };
  }
}

function progressStepClasses(step: LifecycleProgressStep, isCurrent: boolean, isComplete: boolean): string {
  const isConfirmedStep = step === "CONFIRMED";
  const isHandedOverStep = step === "VEHICLE_HANDED_OVER";
  const isReturnedStep = step === "RETURNED";

  if (isCurrent && isConfirmedStep) {
    return "border-emerald-300 bg-emerald-50 text-emerald-800";
  }
  if (isCurrent && isHandedOverStep) {
    return "border-orange-300 bg-orange-50 text-orange-800";
  }
  if (isCurrent && isReturnedStep) {
    return "border-sky-300 bg-sky-50 text-sky-800";
  }
  if (isCurrent) {
    return "border-[#3a7ca5] bg-[#3a7ca5]/10 text-[#2f6688]";
  }
  if (isComplete) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  return "border-slate-200 bg-slate-50 text-slate-500";
}

function progressStepBadgeClasses(step: LifecycleProgressStep, isCurrent: boolean, isComplete: boolean): string {
  const isConfirmedStep = step === "CONFIRMED";
  const isHandedOverStep = step === "VEHICLE_HANDED_OVER";
  const isReturnedStep = step === "RETURNED";

  if (isCurrent && isConfirmedStep) {
    return "bg-emerald-600 text-white";
  }
  if (isCurrent && isHandedOverStep) {
    return "bg-orange-600 text-white";
  }
  if (isCurrent && isReturnedStep) {
    return "bg-sky-600 text-white";
  }
  if (isCurrent) {
    return "bg-[#3a7ca5] text-white";
  }
  if (isComplete) {
    return "bg-emerald-600 text-white";
  }
  return "bg-slate-200 text-slate-600";
}

const LIFECYCLE_PROGRESS_STEPS = [
  "CONFIRMED",
  "VEHICLE_HANDED_OVER",
  "RETURNED",
  "COMPLETED",
] as const;

type LifecycleProgressStep = (typeof LIFECYCLE_PROGRESS_STEPS)[number];

function LifecycleProgress({
  currentStatus,
  t,
}: Readonly<{
  currentStatus: AdminBookingDetail["status"];
  t: ReturnType<typeof useTranslations<"Admin.bookings.lifecycle">>;
}>) {
  if (currentStatus === "CANCELLED") {
    return null;
  }

  const currentIndex = LIFECYCLE_PROGRESS_STEPS.indexOf(currentStatus as LifecycleProgressStep);

  return (
    <ol className="mt-4 flex flex-wrap gap-2" aria-label={t("guidelines.progress.confirmed")}>
      {LIFECYCLE_PROGRESS_STEPS.map((step, index) => {
        const isFinalStepComplete = currentStatus === "COMPLETED" && step === "COMPLETED";
        const isComplete = currentIndex > index || isFinalStepComplete;
        const isCurrent = currentIndex === index && !isFinalStepComplete;
        const progressKey =
          step === "CONFIRMED"
            ? "confirmed"
            : step === "VEHICLE_HANDED_OVER"
              ? "handedOver"
              : step === "RETURNED"
                ? "returned"
                : "completed";

        return (
          <li
            key={step}
            className={[
              "flex min-w-[7rem] flex-1 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold",
              progressStepClasses(step, isCurrent, isComplete),
            ].join(" ")}
          >
            <span
              className={[
                "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px]",
                progressStepBadgeClasses(step, isCurrent, isComplete),
              ].join(" ")}
              aria-hidden
            >
              {isComplete ? "✓" : index + 1}
            </span>
            {t(`guidelines.progress.${progressKey}` as "guidelines.progress.confirmed")}
          </li>
        );
      })}
    </ol>
  );
}

function LifecycleGuideline({
  status,
  t,
}: Readonly<{
  status: AdminBookingDetail["status"];
  t: ReturnType<typeof useTranslations<"Admin.bookings.lifecycle">>;
}>) {
  const stepStatuses = [
    "PENDING_PAYMENT",
    "CONFIRMED",
    "VEHICLE_HANDED_OVER",
    "RETURNED",
    "COMPLETED",
    "CANCELLED",
  ] as const;

  if (!stepStatuses.includes(status as (typeof stepStatuses)[number])) {
    return null;
  }

  const theme = stageGuidelineTheme(status);

  return (
    <div className="mt-4 space-y-3">
      <LifecycleProgress currentStatus={status} t={t} />
      <div className={["rounded-xl border px-4 py-3", theme.box].join(" ")}>
        <p className={["text-sm font-semibold", theme.label].join(" ")}>
          {t("guidelines.currentStage")}
        </p>
        <p className="mt-1 text-sm font-semibold text-slate-900">
          {t(`guidelines.steps.${status}.title` as "guidelines.steps.CONFIRMED.title")}
        </p>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">
          {t(`guidelines.steps.${status}.description` as "guidelines.steps.CONFIRMED.description")}
        </p>
        {status !== "COMPLETED" ? (
          <p className={["mt-3 border-t pt-3 text-sm leading-relaxed text-slate-700", theme.divider].join(" ")}>
            <span className="font-semibold text-slate-800">{t("guidelines.whatToDoNext")}: </span>
            {t(`guidelines.steps.${status}.nextStep` as "guidelines.steps.CONFIRMED.nextStep")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function LifecycleActionCard({
  title,
  summary,
  effects,
  effectsLabel,
  icon: Icon,
  onAction,
  variant = "primary",
}: Readonly<{
  title: string;
  summary: string;
  effects: string;
  effectsLabel: string;
  icon: typeof KeyRound;
  onAction: () => void;
  variant?: LifecycleActionVariant;
}>) {
  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <div className="space-y-4">
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
          <p className="text-sm leading-relaxed text-slate-600">{summary}</p>
          <p className="text-xs leading-relaxed text-slate-500">
            <span className="font-semibold text-slate-600">{effectsLabel}: </span>
            {effects}
          </p>
        </div>
        <div className="flex justify-end border-t border-slate-200/80 pt-3">
          <button
            type="button"
            onClick={onAction}
            className={[
              "inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold",
              variant === "danger"
                ? "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                : variant === "orange"
                  ? "bg-orange-600 text-white hover:bg-orange-700"
                  : variant === "sky"
                    ? "bg-sky-600 text-white hover:bg-sky-700"
                    : "bg-[#3a7ca5] text-white hover:bg-[#2f6688]",
            ].join(" ")}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            {title}
          </button>
        </div>
      </div>
    </article>
  );
}

export function AdminBookingLifecycleActions({
  booking,
  vehicleUnits,
}: AdminBookingLifecycleActionsProps) {
  const t = useTranslations("Admin.bookings.lifecycle");
  const router = useRouter();
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [cancelDialogStep, setCancelDialogStep] = useState<CancelDialogStep>("details");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [handOverForm, setHandOverForm] = useState({
    paymentReceivedAmount: booking.totalDueLater + booking.totalDueOnline,
    paymentMethod: "CASH" as const,
    paymentConfirmed: true,
    securityDepositCollectedAmount: booking.depositAmount,
    depositCollectedConfirmed: true,
    handoverDateTime: toLocalDateTimeInputValue(null),
    handoverNotes: "",
    vehicleUnitId: booking.vehicleUnitId ?? "",
    note: "",
  });

  const [returnForm, setReturnForm] = useState({
    returnRecordedAt: toLocalDateTimeInputValue(null),
    returnNotes: "",
    unitStatusAfterReturn: "AVAILABLE" as const,
    note: "",
  });

  const [completeForm, setCompleteForm] = useState({
    depositOutcome: "REFUNDED" as const,
    depositRefundAmount: booking.depositAmount,
    depositDeductionAmount: 0,
    depositDeductionReason: "",
    unitStatusAfterCompletion: "AVAILABLE" as const,
    completionNotes: "",
    note: "",
  });

  const [cancelForm, setCancelForm] = useState({
    depositOutcome: "UNCHANGED" as const,
    depositRefundAmount: booking.depositAmount,
    depositDeductionAmount: 0,
    depositDeductionReason: "",
    note: "",
    emailSubject: "",
    emailBody: "",
    emailCustomized: false,
  });
  const [restoreNote, setRestoreNote] = useState("");
  const restoreTargetStatus = previousStatusBeforeCancel(booking);

  const selectableUnits = useMemo(
    () =>
      vehicleUnits.filter(
        (unit) =>
          unit.isActive &&
          (unit.id === booking.vehicleUnitId || unit.status === "AVAILABLE"),
      ),
    [booking.vehicleUnitId, vehicleUnits],
  );

  const handOverUnitId = useMemo(
    () =>
      resolveHandOverVehicleUnitId({
        formVehicleUnitId: handOverForm.vehicleUnitId,
        bookingVehicleUnitId: booking.vehicleUnitId,
        selectableUnitIds: selectableUnits.map((unit) => unit.id),
      }),
    [booking.vehicleUnitId, handOverForm.vehicleUnitId, selectableUnits],
  );

  useEffect(() => {
    setHandOverForm((current) => {
      const nextUnitId = booking.vehicleUnitId ?? selectableUnits[0]?.id ?? "";
      const unitStillValid =
        Boolean(current.vehicleUnitId) &&
        selectableUnits.some((unit) => unit.id === current.vehicleUnitId);
      if (unitStillValid && current.vehicleUnitId === (booking.vehicleUnitId ?? current.vehicleUnitId)) {
        return current;
      }
      return {
        ...current,
        paymentReceivedAmount: booking.totalDueLater + booking.totalDueOnline,
        securityDepositCollectedAmount: booking.depositAmount,
        vehicleUnitId: nextUnitId,
      };
    });
  }, [
    booking.depositAmount,
    booking.totalDueLater,
    booking.totalDueOnline,
    booking.vehicleId,
    booking.vehicleUnitId,
    selectableUnits,
  ]);

  useEffect(() => {
    const stored = readLifecycleSuccess(booking.id);
    if (stored) {
      setSuccessMessage(stored);
    }
  }, [booking.id, booking.updatedAt]);

  useEffect(() => {
    if (!successMessage) return;
    const timer = window.setTimeout(() => setSuccessMessage(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [successMessage]);

  function announceSuccess(message: string) {
    storeLifecycleSuccess(booking.id, message);
    setSuccessMessage(message);
  }

  async function submitAction(path: string, body: unknown) {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/bookings/${booking.id}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as {
        success: boolean;
        message?: string;
        emailSent?: boolean;
        booking?: AdminBookingDetail;
      };
      if (!response.ok || !payload.success) {
        setError(payload.message ?? t("genericError"));
        return;
      }
      if (path === "cancel" && payload.emailSent === false) {
        window.alert(payload.message ?? t("cancelDialog.emailFailed"));
      }
      if (path === "change-vehicle") {
        announceSuccess(
          t("changeVehicle.successToast", {
            vehicle: payload.booking?.vehicleName ?? t("changeVehicle.vehicle"),
          }),
        );
      }
      if (path === "extend") {
        const latestExtension = payload.booking?.extensions[0];
        const amount =
          latestExtension !== undefined
            ? new Intl.NumberFormat("en-MT", {
                style: "currency",
                currency: "EUR",
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              }).format(latestExtension.additionalAmount)
            : "—";
        announceSuccess(t("extend.successToast", { amount }));
      }
      setActiveDialog(null);
      setCancelDialogStep("details");
      router.refresh();
    } catch {
      setError(t("genericError"));
    } finally {
      setIsSubmitting(false);
    }
  }

  function openCancelDialog() {
    setError(null);
    setCancelDialogStep("details");
    setCancelForm((current) => ({
      ...current,
      emailSubject: "",
      emailBody: "",
      emailCustomized: false,
    }));
    setActiveDialog("cancel");
  }

  function continueToCancellationEmail() {
    const draft = buildBookingCancellationEmailDraft({
      customerFullName: booking.customerFullName,
      bookingReference: booking.bookingReference,
      vehicleName: booking.vehicleName,
      pickupDateTime: booking.pickupDateTime,
      returnDateTime: booking.returnDateTime,
    });
    setCancelForm((current) => ({
      ...current,
      emailSubject: current.emailCustomized ? current.emailSubject : draft.subject,
      emailBody: current.emailCustomized ? current.emailBody : draft.body,
    }));
    setCancelDialogStep("email");
  }

  function closeLifecycleDialog() {
    setActiveDialog(null);
    setCancelDialogStep("details");
    setError(null);
  }

  function openRestoreDialog() {
    setError(null);
    setRestoreNote("");
    setActiveDialog("restore");
  }

  const showChangeVehicle = booking.status === "CONFIRMED" || booking.status === "PENDING_PAYMENT";
  const showReplaceVehicle = booking.status === "VEHICLE_HANDED_OVER" && Boolean(booking.vehicleUnitId);
  const showHandOver =
    booking.status === "CONFIRMED" &&
    (Number(booking.totalDueOnline) <= 0 || booking.paymentStatus === "PAID");
  const showExtend =
    (booking.status === "CONFIRMED" || booking.status === "VEHICLE_HANDED_OVER") &&
    Boolean(booking.vehicleUnitId);
  const showCancel = booking.status === "CONFIRMED" || booking.status === "PENDING_PAYMENT";
  const showMarkReturned = booking.status === "VEHICLE_HANDED_OVER";
  const showComplete = booking.status === "RETURNED";
  const showRestore = booking.status === "CANCELLED";
  const readOnlyLifecycle = booking.status === "COMPLETED";

  if (
    !showChangeVehicle &&
    !showReplaceVehicle &&
    !showHandOver &&
    !showExtend &&
    !showCancel &&
    !showMarkReturned &&
    !showComplete &&
    !showRestore &&
    !readOnlyLifecycle
  ) {
    return null;
  }

  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
      {successMessage ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed right-4 bottom-4 z-[60] w-[min(92vw,24rem)] rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3.5 text-sm text-emerald-950 shadow-lg"
        >
          <p className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden />
            {successMessage}
          </p>
        </div>
      ) : null}

      <h3 className="text-base font-bold text-slate-950">{t("title")}</h3>

      <LifecycleGuideline status={booking.status} t={t} />

      {readOnlyLifecycle ? (
        <p className="mt-4 text-sm text-slate-600">{t("readOnlyCompleted")}</p>
      ) : (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-semibold text-slate-700">
            {t("guidelines.availableActions")}
          </p>
          {showChangeVehicle ? (
            <LifecycleActionCard
              title={t("actions.changeVehicle")}
              summary={t("guidelines.actions.changeVehicle.summary")}
              effects={t("guidelines.actions.changeVehicle.effects")}
              effectsLabel={t("guidelines.effectsLabel")}
              icon={Bike}
              onAction={() => {
                setError(null);
                setSuccessMessage(null);
                setActiveDialog("changeVehicle");
              }}
            />
          ) : null}
          {showHandOver ? (
            <LifecycleActionCard
              title={t("actions.handOver")}
              summary={t("guidelines.actions.handOver.summary")}
              effects={t("guidelines.actions.handOver.effects")}
              effectsLabel={t("guidelines.effectsLabel")}
              icon={KeyRound}
              onAction={() => {
                setError(null);
                setHandOverForm((current) => ({
                  ...current,
                  paymentReceivedAmount: booking.totalDueLater + booking.totalDueOnline,
                  securityDepositCollectedAmount: booking.depositAmount,
                  handoverDateTime: toLocalDateTimeInputValue(null),
                  vehicleUnitId:
                    booking.vehicleUnitId ??
                    selectableUnits[0]?.id ??
                    "",
                }));
                setActiveDialog("handOver");
              }}
            />
          ) : null}
          {showExtend ? (
            <LifecycleActionCard
              title={t("actions.extend")}
              summary={t("guidelines.actions.extend.summary")}
              effects={t("guidelines.actions.extend.effects")}
              effectsLabel={t("guidelines.effectsLabel")}
              icon={CalendarPlus}
              onAction={() => {
                setError(null);
                setActiveDialog("extend");
              }}
            />
          ) : null}
          {showReplaceVehicle ? (
            <LifecycleActionCard
              title={t("actions.replaceVehicle")}
              summary={t("guidelines.actions.replaceVehicle.summary")}
              effects={t("guidelines.actions.replaceVehicle.effects")}
              effectsLabel={t("guidelines.effectsLabel")}
              icon={ArrowRightLeft}
              variant="orange"
              onAction={() => {
                setError(null);
                setActiveDialog("replaceVehicle");
              }}
            />
          ) : null}
          {showMarkReturned ? (
            <LifecycleActionCard
              title={t("actions.markReturned")}
              summary={t("guidelines.actions.markReturned.summary")}
              effects={t("guidelines.actions.markReturned.effects")}
              effectsLabel={t("guidelines.effectsLabel")}
              icon={RotateCcw}
              variant="orange"
              onAction={() => setActiveDialog("markReturned")}
            />
          ) : null}
          {showComplete ? (
            <LifecycleActionCard
              title={t("actions.complete")}
              summary={t("guidelines.actions.complete.summary")}
              effects={t("guidelines.actions.complete.effects")}
              effectsLabel={t("guidelines.effectsLabel")}
              icon={CheckCircle2}
              variant="sky"
              onAction={() => setActiveDialog("complete")}
            />
          ) : null}
          {showRestore ? (
            <LifecycleActionCard
              title={t("actions.restore")}
              summary={t("guidelines.actions.restore.summary")}
              effects={t("guidelines.actions.restore.effects")}
              effectsLabel={t("guidelines.effectsLabel")}
              icon={Undo2}
              onAction={openRestoreDialog}
            />
          ) : null}
          {showCancel ? (
            <LifecycleActionCard
              title={t("actions.cancel")}
              summary={t("guidelines.actions.cancel.summary")}
              effects={t("guidelines.actions.cancel.effects")}
              effectsLabel={t("guidelines.effectsLabel")}
              icon={XCircle}
              onAction={openCancelDialog}
              variant="danger"
            />
          ) : null}
        </div>
      )}

      {activeDialog === "changeVehicle" ? (
        <AdminBookingChangeVehicleDialog
          booking={booking}
          isSubmitting={isSubmitting}
          error={error}
          onClose={closeLifecycleDialog}
          onConfirm={(input) => {
            void submitAction("change-vehicle", input);
          }}
        />
      ) : null}

      {activeDialog === "replaceVehicle" ? (
        <AdminBookingReplaceVehicleDialog
          booking={booking}
          isSubmitting={isSubmitting}
          error={error}
          onClose={closeLifecycleDialog}
          onConfirm={(input) => {
            void submitAction("replace-vehicle", input);
          }}
        />
      ) : null}

      {activeDialog === "extend" ? (
        <AdminBookingExtendDialog
          booking={booking}
          isSubmitting={isSubmitting}
          error={error}
          onClose={closeLifecycleDialog}
          onConfirm={(input) => {
            void submitAction("extend", input);
          }}
        />
      ) : null}

      {activeDialog === "handOver" ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div role="dialog" aria-modal="true" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h4 className="text-lg font-bold text-slate-950">{t("handOver.title")}</h4>
            <p className="mt-1 text-sm text-slate-600">{t("handOver.description", { reference: booking.bookingReference })}</p>
            <div className="mt-4 space-y-3">
              <label>
                <span className={labelClassName()}>{t("handOver.vehicleUnit")}</span>
                <select
                  value={handOverUnitId}
                  onChange={(event) => setHandOverForm((current) => ({ ...current, vehicleUnitId: event.target.value }))}
                  className={inputClassName()}
                >
                  {selectableUnits.map((unit) => (
                    <option key={unit.id} value={unit.id}>
                      {unit.licensePlate} ({t(`unitStatus.${unit.status}` as "unitStatus.AVAILABLE")})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelClassName()}>{t("handOver.paymentAmount")}</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={handOverForm.paymentReceivedAmount}
                  onChange={(event) =>
                    setHandOverForm((current) => ({
                      ...current,
                      paymentReceivedAmount: Number(event.target.value),
                    }))
                  }
                  className={inputClassName()}
                />
              </label>
              <label>
                <span className={labelClassName()}>{t("handOver.paymentMethod")}</span>
                <select
                  value={handOverForm.paymentMethod}
                  onChange={(event) =>
                    setHandOverForm((current) => ({
                      ...current,
                      paymentMethod: event.target.value as typeof current.paymentMethod,
                    }))
                  }
                  className={inputClassName()}
                >
                  <option value="CASH">{t("paymentMethod.CASH")}</option>
                  <option value="CARD">{t("paymentMethod.CARD")}</option>
                  <option value="BANK">{t("paymentMethod.BANK")}</option>
                  <option value="OTHER">{t("paymentMethod.OTHER")}</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={handOverForm.paymentConfirmed}
                  onChange={(event) =>
                    setHandOverForm((current) => ({ ...current, paymentConfirmed: event.target.checked }))
                  }
                />
                {t("handOver.paymentConfirmed")}
              </label>
              <label>
                <span className={labelClassName()}>{t("handOver.depositAmount")}</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={handOverForm.securityDepositCollectedAmount}
                  onChange={(event) =>
                    setHandOverForm((current) => ({
                      ...current,
                      securityDepositCollectedAmount: Number(event.target.value),
                    }))
                  }
                  className={inputClassName()}
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={handOverForm.depositCollectedConfirmed}
                  onChange={(event) =>
                    setHandOverForm((current) => ({
                      ...current,
                      depositCollectedConfirmed: event.target.checked,
                    }))
                  }
                />
                {t("handOver.depositConfirmed")}
              </label>
              <label>
                <span className={labelClassName()}>{t("handOver.handoverDateTime")}</span>
                <input
                  type="datetime-local"
                  value={handOverForm.handoverDateTime}
                  onChange={(event) =>
                    setHandOverForm((current) => ({ ...current, handoverDateTime: event.target.value }))
                  }
                  className={inputClassName()}
                />
              </label>
              <label>
                <span className={labelClassName()}>{t("handOver.notes")}</span>
                <textarea
                  rows={3}
                  value={handOverForm.handoverNotes}
                  onChange={(event) =>
                    setHandOverForm((current) => ({ ...current, handoverNotes: event.target.value }))
                  }
                  className={inputClassName()}
                />
              </label>
            </div>
            {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={isSubmitting} onClick={closeLifecycleDialog} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">
                {t("cancel")}
              </button>
              <button
                type="button"
                disabled={isSubmitting || !handOverUnitId}
                onClick={() =>
                  submitAction("hand-over", {
                    ...handOverForm,
                    handoverDateTime: new Date(handOverForm.handoverDateTime).toISOString(),
                    vehicleUnitId: handOverUnitId || undefined,
                  })
                }
                className={lifecycleConfirmButtonClassName}
              >
                {isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <ArrowRight className="size-4 shrink-0" aria-hidden />
                )}
                {t("confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {activeDialog === "markReturned" ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h4 className="text-lg font-bold text-slate-950">{t("markReturned.title")}</h4>
            <div className="mt-4 space-y-3">
              <label>
                <span className={labelClassName()}>{t("markReturned.returnDateTime")}</span>
                <input
                  type="datetime-local"
                  value={returnForm.returnRecordedAt}
                  onChange={(event) =>
                    setReturnForm((current) => ({ ...current, returnRecordedAt: event.target.value }))
                  }
                  className={inputClassName()}
                />
              </label>
              <label>
                <span className={labelClassName()}>{t("markReturned.unitStatus")}</span>
                <select
                  value={returnForm.unitStatusAfterReturn}
                  onChange={(event) =>
                    setReturnForm((current) => ({
                      ...current,
                      unitStatusAfterReturn: event.target.value as typeof current.unitStatusAfterReturn,
                    }))
                  }
                  className={inputClassName()}
                >
                  <option value="AVAILABLE">{t("unitStatus.AVAILABLE")}</option>
                  <option value="MAINTENANCE">{t("unitStatus.MAINTENANCE")}</option>
                </select>
              </label>
              <label>
                <span className={labelClassName()}>{t("markReturned.notes")}</span>
                <textarea
                  rows={3}
                  value={returnForm.returnNotes}
                  onChange={(event) =>
                    setReturnForm((current) => ({ ...current, returnNotes: event.target.value }))
                  }
                  className={inputClassName()}
                />
              </label>
            </div>
            {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={isSubmitting} onClick={closeLifecycleDialog} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">
                {t("cancel")}
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() =>
                  submitAction("mark-returned", {
                    ...returnForm,
                    returnRecordedAt: new Date(returnForm.returnRecordedAt).toISOString(),
                  })
                }
                className={lifecycleConfirmButtonClassName}
              >
                {isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <ArrowRight className="size-4 shrink-0" aria-hidden />
                )}
                {t("confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {activeDialog === "complete" ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div role="dialog" aria-modal="true" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h4 className="text-lg font-bold text-slate-950">{t("complete.title")}</h4>
            <div className="mt-4 space-y-3">
              <label>
                <span className={labelClassName()}>{t("complete.depositOutcome")}</span>
                <select
                  value={completeForm.depositOutcome}
                  onChange={(event) =>
                    setCompleteForm((current) => ({
                      ...current,
                      depositOutcome: event.target.value as typeof current.depositOutcome,
                    }))
                  }
                  className={inputClassName()}
                >
                  <option value="REFUNDED">{t("depositStatus.REFUNDED")}</option>
                  <option value="DEDUCTED">{t("depositStatus.DEDUCTED")}</option>
                </select>
              </label>
              {completeForm.depositOutcome === "REFUNDED" ? (
                <label>
                  <span className={labelClassName()}>{t("complete.refundAmount")}</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={completeForm.depositRefundAmount}
                    onChange={(event) =>
                      setCompleteForm((current) => ({
                        ...current,
                        depositRefundAmount: Number(event.target.value),
                      }))
                    }
                    className={inputClassName()}
                  />
                </label>
              ) : (
                <>
                  <label>
                    <span className={labelClassName()}>{t("complete.deductionAmount")}</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={completeForm.depositDeductionAmount}
                      onChange={(event) =>
                        setCompleteForm((current) => ({
                          ...current,
                          depositDeductionAmount: Number(event.target.value),
                        }))
                      }
                      className={inputClassName()}
                    />
                  </label>
                  <label>
                    <span className={labelClassName()}>{t("complete.deductionReason")}</span>
                    <textarea
                      rows={2}
                      value={completeForm.depositDeductionReason}
                      onChange={(event) =>
                        setCompleteForm((current) => ({
                          ...current,
                          depositDeductionReason: event.target.value,
                        }))
                      }
                      className={inputClassName()}
                    />
                  </label>
                </>
              )}
              <label>
                <span className={labelClassName()}>{t("complete.unitStatus")}</span>
                <select
                  value={completeForm.unitStatusAfterCompletion}
                  onChange={(event) =>
                    setCompleteForm((current) => ({
                      ...current,
                      unitStatusAfterCompletion: event.target.value as typeof current.unitStatusAfterCompletion,
                    }))
                  }
                  className={inputClassName()}
                >
                  <option value="AVAILABLE">{t("unitStatus.AVAILABLE")}</option>
                  <option value="MAINTENANCE">{t("unitStatus.MAINTENANCE")}</option>
                  <option value="NOT_AVAILABLE">{t("unitStatus.NOT_AVAILABLE")}</option>
                </select>
              </label>
              <label>
                <span className={labelClassName()}>{t("complete.notes")}</span>
                <textarea
                  rows={3}
                  value={completeForm.completionNotes}
                  onChange={(event) =>
                    setCompleteForm((current) => ({ ...current, completionNotes: event.target.value }))
                  }
                  className={inputClassName()}
                />
              </label>
            </div>
            {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={isSubmitting} onClick={closeLifecycleDialog} className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">
                {t("cancel")}
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => submitAction("complete", completeForm)}
                className={lifecycleConfirmButtonClassName}
              >
                {isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <ArrowRight className="size-4 shrink-0" aria-hidden />
                )}
                {t("confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {activeDialog === "cancel" ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            {cancelDialogStep === "details" ? (
              <>
                <h4 className="text-lg font-bold text-slate-950">{t("cancelDialog.title")}</h4>
                <p className="mt-1 text-sm text-slate-600">
                  {t("cancelDialog.description", { reference: booking.bookingReference })}
                </p>
                <div className="mt-4 space-y-3">
                  {booking.paymentStatus === "PAID" ? (
                    <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                      {t("cancelDialog.paidPaymentNotice")}
                    </p>
                  ) : null}
                  {booking.securityDepositStatus === "COLLECTED" ? (
                    <label>
                      <span className={labelClassName()}>{t("cancelDialog.depositOutcome")}</span>
                      <select
                        value={cancelForm.depositOutcome}
                        onChange={(event) =>
                          setCancelForm((current) => ({
                            ...current,
                            depositOutcome: event.target.value as typeof current.depositOutcome,
                          }))
                        }
                        className={inputClassName()}
                      >
                        <option value="UNCHANGED">{t("cancelDialog.depositUnchanged")}</option>
                        <option value="REFUNDED">{t("depositStatus.REFUNDED")}</option>
                        <option value="DEDUCTED">{t("depositStatus.DEDUCTED")}</option>
                      </select>
                    </label>
                  ) : null}
                  <label>
                    <span className={labelClassName()}>{t("cancelDialog.note")}</span>
                    <textarea
                      rows={3}
                      value={cancelForm.note}
                      onChange={(event) => setCancelForm((current) => ({ ...current, note: event.target.value }))}
                      className={inputClassName()}
                    />
                  </label>
                </div>
                {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={closeLifecycleDialog}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"
                  >
                    {t("cancelDialog.dismiss")}
                  </button>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={continueToCancellationEmail}
                    className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white"
                  >
                    {t("cancelDialog.continue")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h4 className="text-lg font-bold text-slate-950">{t("cancelDialog.emailTitle")}</h4>
                <p className="mt-1 text-sm text-slate-600">
                  {t("cancelDialog.emailDescription", { email: booking.customerEmail })}
                </p>
                <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                  {t("cancelDialog.emailRefundWarning")}
                </p>
                <div className="mt-4 space-y-3">
                  <label>
                    <span className={labelClassName()}>{t("cancelDialog.emailRecipient")}</span>
                    <input type="text" value={booking.customerEmail} readOnly className={inputClassName()} />
                  </label>
                  <label>
                    <span className={labelClassName()}>{t("cancelDialog.emailSubject")}</span>
                    <input
                      type="text"
                      value={cancelForm.emailSubject}
                      onChange={(event) =>
                        setCancelForm((current) => ({
                          ...current,
                          emailSubject: event.target.value,
                          emailCustomized: true,
                        }))
                      }
                      className={inputClassName()}
                    />
                  </label>
                  <label>
                    <span className={labelClassName()}>{t("cancelDialog.emailBody")}</span>
                    <textarea
                      rows={14}
                      value={cancelForm.emailBody}
                      onChange={(event) =>
                        setCancelForm((current) => ({
                          ...current,
                          emailBody: event.target.value,
                          emailCustomized: true,
                        }))
                      }
                      className={`${inputClassName()} min-h-[16rem] font-sans`}
                    />
                  </label>
                </div>
                {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => setCancelDialogStep("details")}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"
                  >
                    {t("cancelDialog.back")}
                  </button>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={closeLifecycleDialog}
                    className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"
                  >
                    {t("cancelDialog.dismiss")}
                  </button>
                  <button
                    type="button"
                    disabled={
                      isSubmitting || !cancelForm.emailSubject.trim() || !cancelForm.emailBody.trim()
                    }
                    onClick={() =>
                      submitAction("cancel", {
                        depositOutcome: cancelForm.depositOutcome,
                        depositRefundAmount: cancelForm.depositRefundAmount,
                        depositDeductionAmount: cancelForm.depositDeductionAmount,
                        depositDeductionReason: cancelForm.depositDeductionReason,
                        note: cancelForm.note,
                        emailSubject: cancelForm.emailSubject,
                        emailBody: cancelForm.emailBody,
                      })
                    }
                    className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  >
                    {isSubmitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    {t("cancelDialog.confirmAndSend")}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {activeDialog === "restore" ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div role="dialog" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h4 className="text-lg font-bold text-slate-950">{t("restoreDialog.title")}</h4>
            <p className="mt-1 text-sm text-slate-600">
              {t("restoreDialog.description", {
                reference: booking.bookingReference,
                status: t(`restoreDialog.status.${restoreTargetStatus}` as "restoreDialog.status.CONFIRMED"),
              })}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">{t("restoreDialog.emailWarning")}</p>
            <div className="mt-4">
              <label>
                <span className={labelClassName()}>{t("restoreDialog.note")}</span>
                <textarea
                  rows={3}
                  value={restoreNote}
                  onChange={(event) => setRestoreNote(event.target.value)}
                  className={inputClassName()}
                />
              </label>
            </div>
            {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={closeLifecycleDialog}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => submitAction("restore", { note: restoreNote })}
                className={lifecycleConfirmButtonClassName}
              >
                {isSubmitting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Undo2 className="size-4 shrink-0" aria-hidden />
                )}
                {t("restoreDialog.confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
