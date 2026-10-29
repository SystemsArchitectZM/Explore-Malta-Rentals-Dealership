"use client";

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { AlreadyPaidProofModal } from "@/features/booking-flow/components/already-paid-proof-modal";
import { StepShell } from "@/features/booking-flow/components/step-shell";
import { useBookingFlow } from "@/features/booking-flow/context/booking-flow-context";
import { useVehicle, useVehicles } from "@/features/vehicles/lib/use-vehicles";
import {
  calculateBookingPrice,
  formatEur,
  getCdwLabel,
} from "@/lib/pricing/calculate-booking-price";
import { buildBookingPaymentSummary } from "@/lib/booking/build-booking-payment-summary";
import { LOYALTY_CREDIT_AMOUNT_EUR } from "@/lib/loyalty/loyalty-credit";

/** Receipt row: label left, value right, hairline separated by the parent `divide-y`. */
const rowClass = "flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 py-2.5";
const labelClass = "text-[var(--text-secondary)]";
const valueClass = "text-right font-medium tabular-nums text-[var(--text-primary)]";

/** Selection-card treatment shared with the insurance plan options. */
const depositOptionBase =
  "relative flex flex-col gap-1 rounded-[var(--r-card)] border p-3.5 text-left transition duration-[var(--dur-base)] ease-[var(--ease-standard)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2";
const depositOptionSelected =
  "border-blue-400 bg-blue-50/70 ring-2 ring-blue-500/25 shadow-[var(--elev-2)]";
const depositOptionIdle =
  "border-[var(--line)] bg-[var(--surface-card)] hover:border-[var(--line-strong)] hover:bg-[var(--surface-soft)]";

function DepositOptionCheck() {
  return (
    <span
      className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full bg-blue-500 text-white"
      aria-hidden
    >
      <Check className="h-2.5 w-2.5" strokeWidth={4} />
    </span>
  );
}

export function BookingSummaryStep() {
  const t = useTranslations("BookingWizard.bookingSummary");
  const tCommon = useTranslations("Common");
  const { state, reservationHold, updateSection, bookingSessionId, getFieldError } = useBookingFlow();
  const [proofModalOpen, setProofModalOpen] = useState(false);
  const [loyaltyOffer, setLoyaltyOffer] = useState<{ email: string; available: boolean } | null>(null);

  useEffect(() => {
    const email = state.customer.email.trim();
    if (!email.includes("@")) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch("/api/loyalty-credits/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) return { available: false };
          return (await response.json()) as { available?: boolean };
        })
        .then((offer) => {
          if (!controller.signal.aborted) {
            setLoyaltyOffer({ email, available: offer.available === true });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setLoyaltyOffer({ email, available: false });
        });
    }, 300);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [state.customer.email]);

  const isAlreadyPaid = state.payment.mode === "already_paid";
  const paymentProofError = getFieldError("payment.proofPath");

  const rentalWindow = useMemo(() => {
    const { pickupDate, pickupTime, returnDate, returnTime } = state.rental;
    if (!pickupDate.trim() || !pickupTime.trim() || !returnDate.trim() || !returnTime.trim()) {
      return null;
    }
    return {
      pickupDate: pickupDate.trim(),
      pickupTime: pickupTime.trim(),
      returnDate: returnDate.trim(),
      returnTime: returnTime.trim(),
      sessionKey: reservationHold.sessionKey?.trim() || undefined,
    };
  }, [
    reservationHold.sessionKey,
    state.rental.pickupDate,
    state.rental.pickupTime,
    state.rental.returnDate,
    state.rental.returnTime,
  ]);

  const { vehicles } = useVehicles({ rentalWindow });
  const incomingSlug = state.rental.vehicleSlug?.trim() ?? "";
  const { vehicle: slugVehicle } = useVehicle(incomingSlug);

  const selectedVehicle = useMemo(() => {
    if (state.rental.vehicleId) {
      const byId = vehicles.find((vehicle) => vehicle.id === state.rental.vehicleId);
      if (byId) {
        return byId;
      }
    }
    if (incomingSlug) {
      const bySlug = vehicles.find((vehicle) => vehicle.slug === incomingSlug);
      if (bySlug) {
        return bySlug;
      }
    }
    return slugVehicle;
  }, [incomingSlug, slugVehicle, state.rental.vehicleId, vehicles]);

  const pricing = useMemo(
    () => {
      if (!selectedVehicle || selectedVehicle.baseDailyRate <= 0) {
        return null;
      }

      const vehicleType = state.rental.vehicleType || selectedVehicle.apiVehicleType;
      if (!vehicleType) {
        return null;
      }

      return calculateBookingPrice({
        rental: {
          vehicle: {
            id: state.rental.vehicleId || selectedVehicle.id,
            slug: state.rental.vehicleSlug || selectedVehicle.slug,
            name: state.rental.vehicleName || selectedVehicle.name,
            type: vehicleType,
          },
          pickupDate: state.rental.pickupDate,
          returnDate: state.rental.returnDate,
          pickupTime: state.rental.pickupTime,
          returnTime: state.rental.returnTime,
        },
        delivery: {
          pickupOption: state.delivery.pickupOption,
          pickupAddress: state.delivery.pickupAddress,
          dropoffOption: state.delivery.dropoffOption,
          dropoffAddress: state.delivery.dropoffAddress,
        },
        addons: {
          cdwOption: state.addons.cdwPlan,
          additionalDriver: state.addons.additionalDriver,
          storageBox: state.addons.storageBox,
          helmetSize1: state.addons.helmetSize1,
          helmetSize2: state.addons.helmetSize2,
        },
        additionalDriver: {
          enabled: state.addons.additionalDriver,
        },
        deposit: {
          method: state.deposit.depositMethod,
        },
        vehiclePricing: {
          baseDailyRate: selectedVehicle.baseDailyRate,
          vehicleType: selectedVehicle.apiVehicleType,
          supportsStorageBox: selectedVehicle.supportsStorageBox,
        },
        hotelDiscount:
          state.hotelCode.appliedCode && state.hotelCode.discountPercent != null
            ? { discountPercent: state.hotelCode.discountPercent }
            : undefined,
      });
    },
    [selectedVehicle, state],
  );

  const loyaltyCreditAvailable =
    loyaltyOffer?.email === state.customer.email.trim() && loyaltyOffer.available === true;
  const loyaltyCreditAmount =
    loyaltyCreditAvailable && pricing && pricing.subtotal >= LOYALTY_CREDIT_AMOUNT_EUR
      ? LOYALTY_CREDIT_AMOUNT_EUR
      : 0;

  const paymentSummary = useMemo(() => {
    if (!pricing) {
      return null;
    }

    const summary = buildBookingPaymentSummary({
      subtotal: pricing.subtotal,
      depositAmount: pricing.depositAmount,
      depositMethod: state.deposit.depositMethod || "in_person",
      totalDueOnline: pricing.totalDueOnline,
      totalDueLater: pricing.totalDueLater,
      loyaltyCreditAmount,
    });

    if (isAlreadyPaid) {
      return {
        ...summary,
        securityDepositDueAtPickup: false,
        amountPayableOnline: 0,
        amountDueAtPickupLater: 0,
      };
    }

    return summary;
  }, [pricing, state.deposit.depositMethod, isAlreadyPaid, loyaltyCreditAmount]);

  const cdwLabel =
    state.addons.cdwPlan === null
      ? t("insuranceNotSelected")
      : pricing
        ? getCdwLabel(pricing.cdwOptionApplied)
        : "-";
  const addOnList = [
    t("cdwLine", { label: cdwLabel }),
    t("addDriverLine", {
      value: state.addons.additionalDriver ? tCommon("yes") : tCommon("no"),
    }),
    `${t("helmet1")} ${state.addons.helmetSize1 || "-"}`,
    `${t("helmet2")} ${state.addons.helmetSize2 || "-"}`,
    `${t("storageBox")} ${
      selectedVehicle?.supportsStorageBox && state.addons.storageBox
        ? tCommon("yes")
        : tCommon("no")
    }`,
  ];

  function selectStripeOnlineDeposit() {
    updateSection("deposit", { depositMethod: "online" });
    updateSection("payment", { mode: "stripe", proofPath: "" });
  }

  function selectAlreadyPaid() {
    updateSection("payment", { mode: "already_paid" });
    setProofModalOpen(true);
  }

  const payOnlineSelected = !isAlreadyPaid && state.deposit.depositMethod === "online";

  return (
    <StepShell title={t("shellTitle")} description={t("shellDescription")}>
      <div className="space-y-4">
        {/* ── Trip details ──────────────────────────────────────────────── */}
        <section className="surface-card p-4 text-sm sm:p-5">
          <p className="type-spec text-[var(--text-muted)]">{t("section1")}</p>
          <ul className="mt-3 divide-y divide-[var(--line-subtle)]">
            <li className={rowClass}>
              <span className={labelClass}>{t("vehicleSelected")}</span>
              <span className={valueClass}>
                {state.rental.vehicleName || state.rental.vehicleId || t("categoryOnly")}
              </span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>{t("rentalDates")}</span>
              <span className={valueClass}>
                {state.rental.pickupDate || "-"} {state.rental.pickupTime || ""} {t("to")}{" "}
                {state.rental.returnDate || "-"} {state.rental.returnTime || ""}
              </span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>{t("billableDuration")}</span>
              <span className={valueClass}>
                {pricing ? (
                  <>
                    {t("actualHours", {
                      hours: Number.isInteger(pricing.actualDurationHours)
                        ? String(pricing.actualDurationHours)
                        : String(pricing.actualDurationHours),
                    })}
                    {" · "}
                    {t("dayCount", { count: pricing.rentalDays })}
                  </>
                ) : (
                  "-"
                )}
              </span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>{t("pickupMethod")}</span>
              <span className={valueClass}>{state.delivery.pickupOption}</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>{t("pickupAddress")}</span>
              <span className={valueClass}>{state.delivery.pickupAddress || "-"}</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>{t("dropoffMethod")}</span>
              <span className={valueClass}>{state.delivery.dropoffOption}</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>{t("dropoffAddress")}</span>
              <span className={valueClass}>{state.delivery.dropoffAddress || "-"}</span>
            </li>
            {addOnList.map((line) => (
              <li key={line} className={`${rowClass} tabular-nums text-[var(--text-secondary)]`}>
                {line}
              </li>
            ))}
          </ul>
        </section>

        {/* ── Charges ───────────────────────────────────────────────────── */}
        <section className="surface-card p-4 text-sm sm:p-5">
          <p className="type-spec text-[var(--text-muted)]">{t("section2")}</p>
          {pricing ? (
            <>
              <ul className="mt-3 divide-y divide-[var(--line-subtle)]">
                <li className={rowClass}>
                  <span className={labelClass}>{t("baseDailyRate")}</span>
                  <span className={valueClass}>{formatEur(pricing.baseDailyRate)}/day</span>
                </li>
                <li className={rowClass}>
                  <span className={labelClass}>{t("rentalDuration")}</span>
                  <span className={valueClass}>
                    {t("dayCount", { count: pricing.rentalDays })} ({pricing.tierRange})
                  </span>
                </li>
                {pricing.durationDiscountPercent > 0 ? (
                  <li className={`${rowClass} font-medium tabular-nums text-emerald-700`}>
                    {t("durationDiscount", {
                      percent: pricing.durationDiscountPercent,
                      rate: formatEur(pricing.appliedDailyRate),
                    })}
                  </li>
                ) : null}
                <li className={rowClass}>
                  <span className={labelClass}>{t("rentalCost")}</span>
                  <span className={valueClass}>{formatEur(pricing.rentalCost)}</span>
                </li>
                {pricing.hotelDiscountAmount > 0 ? (
                  <li className={`${rowClass} font-medium tabular-nums text-emerald-700`}>
                    {t("hotelDiscount", {
                      percent: pricing.hotelDiscountPercent,
                      amount: formatEur(pricing.hotelDiscountAmount),
                      hotel: state.hotelCode.partnerName ?? "",
                    })}
                  </li>
                ) : null}
                <li className={`${rowClass} tabular-nums text-[var(--text-secondary)]`}>
                  {t("deliveryLine", {
                    total: formatEur(pricing.deliveryTotal),
                    pickup: formatEur(pricing.deliveryFee),
                    dropoff: formatEur(pricing.dropoffFee),
                    discount:
                      pricing.deliveryDiscount > 0
                        ? t("bundleDiscount", { amount: formatEur(pricing.deliveryDiscount) })
                        : "",
                  })}
                </li>
                <li className={rowClass}>
                  <span className={labelClass}>{t("cdwCost")}</span>
                  <span className={valueClass}>{formatEur(pricing.cdwCost)}</span>
                </li>
                <li className={rowClass}>
                  <span className={labelClass}>{t("addDriverCost")}</span>
                  <span className={valueClass}>{formatEur(pricing.additionalDriverCost)}</span>
                </li>
                <li className={rowClass}>
                  <span className={labelClass}>{t("storageCost")}</span>
                  <span className={valueClass}>{formatEur(pricing.storageBoxCost)}</span>
                </li>
                {loyaltyCreditAmount > 0 ? (
                  <li className={`${rowClass} font-medium tabular-nums text-emerald-700`}>
                    <span className={labelClass}>{t("loyaltyCredit", { amount: formatEur(loyaltyCreditAmount) })}</span>
                  </li>
                ) : null}
              </ul>
              <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t-2 border-[var(--line-strong)] pt-3">
                <p className="text-sm font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
                  {t("bookingChargesTotal")}
                </p>
                <p className="text-lg font-bold tabular-nums tracking-[-0.02em] text-[var(--text-primary)]">
                  {formatEur(paymentSummary?.bookingChargesTotal ?? pricing.subtotal)}
                </p>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
                {t("bookingChargesExcludesDepositNote")}
                {loyaltyCreditAmount > 0 ? ` ${t("loyaltyCreditNote")}` : ""}
              </p>
            </>
          ) : (
            <p className="mt-3 text-xs leading-relaxed text-[var(--text-muted)]">
              {t("pricingPending")}
            </p>
          )}
        </section>

        {/* ── Deposit + payment ─────────────────────────────────────────── */}
        <section className="rounded-[var(--r-panel)] border border-blue-200 bg-blue-50/50 p-4 text-sm sm:p-5">
          <p className="type-spec text-blue-700">{t("section3")}</p>

          <div className="mt-4">
            <p className="text-sm font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
              {t("securityDepositMethod")}
            </p>
            <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                onClick={selectStripeOnlineDeposit}
                className={`${depositOptionBase} ${
                  payOnlineSelected ? depositOptionSelected : depositOptionIdle
                }`}
              >
                {payOnlineSelected ? <DepositOptionCheck /> : null}
                <span
                  className={`pr-5 text-sm font-semibold tracking-[-0.01em] ${
                    payOnlineSelected ? "text-blue-800" : "text-[var(--text-primary)]"
                  }`}
                >
                  {t("payOnlineNow")}
                </span>
                <span className="text-xs leading-relaxed text-[var(--text-secondary)]">
                  {t("payOnlineDescription")}
                </span>
              </button>
              <button
                type="button"
                onClick={selectAlreadyPaid}
                className={`${depositOptionBase} ${
                  isAlreadyPaid ? depositOptionSelected : depositOptionIdle
                }`}
              >
                {isAlreadyPaid ? <DepositOptionCheck /> : null}
                <span
                  className={`pr-5 text-sm font-semibold tracking-[-0.01em] ${
                    isAlreadyPaid ? "text-blue-800" : "text-[var(--text-primary)]"
                  }`}
                >
                  {t("alreadyPaid")}
                </span>
                <span className="text-xs leading-relaxed text-[var(--text-secondary)]">
                  {t("alreadyPaidDescription")}
                </span>
              </button>
            </div>
            {isAlreadyPaid && state.payment.proofPath ? (
              <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200">
                <Check className="h-3 w-3 shrink-0" strokeWidth={3} aria-hidden />
                {t("alreadyPaidProofAttached", { name: state.payment.proofPath })}
              </p>
            ) : null}
            {paymentProofError ? (
              <p
                className="mt-2.5 rounded-[var(--r-field)] border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
                role="alert"
              >
                {paymentProofError}
              </p>
            ) : null}
          </div>

          {paymentSummary ? (
            <div className="surface-card mt-4 px-4 py-3.5">
              <p className="type-spec text-[var(--text-muted)]">{t("paymentSummaryTitle")}</p>
              <dl className="mt-2 divide-y divide-[var(--line-subtle)]">
                <div className={rowClass}>
                  <dt className={labelClass}>{t("bookingChargesTotal")}</dt>
                  <dd className={valueClass}>{formatEur(paymentSummary.bookingChargesTotal)}</dd>
                </div>
                <div className={rowClass}>
                  <dt className={labelClass}>
                    {paymentSummary.securityDepositDueAtPickup
                      ? t("securityDepositDueAtPickup")
                      : t("securityDeposit")}
                  </dt>
                  <dd className={valueClass}>{formatEur(paymentSummary.securityDeposit)}</dd>
                </div>
                {isAlreadyPaid ? (
                  <div className={`${rowClass} font-semibold text-emerald-700`}>
                    <dt className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                      {t("alreadyPaidSummaryLabel")}
                    </dt>
                    <dd className="text-right tabular-nums">
                      {formatEur(paymentSummary.totalCustomerLiability)}
                    </dd>
                  </div>
                ) : (
                  <>
                    <div className={`${rowClass} font-semibold text-emerald-700`}>
                      <dt className="flex items-center gap-1.5">
                        <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                        {t("payNowOnlineStripe")}
                      </dt>
                      <dd className="text-right tabular-nums">
                        {formatEur(paymentSummary.amountPayableOnline ?? 0)}
                      </dd>
                    </div>
                    <div className={rowClass}>
                      <dt className={labelClass}>{t("amountDueAtPickupLater")}</dt>
                      <dd className={valueClass}>
                        {formatEur(paymentSummary.amountDueAtPickupLater)}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
              <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t-2 border-[var(--line-strong)] pt-3">
                <p className="text-sm font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
                  {t("totalCustomerLiability")}
                </p>
                <p className="text-lg font-bold tabular-nums tracking-[-0.02em] text-[var(--text-primary)]">
                  {formatEur(paymentSummary.totalCustomerLiability)}
                </p>
              </div>
            </div>
          ) : null}

          <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
            {t("securityDepositHelperText")}
          </p>
          {isAlreadyPaid ? (
            <p className="mt-2.5 rounded-[var(--r-field)] border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm leading-relaxed text-emerald-800">
              {t("alreadyPaidNote")}
            </p>
          ) : (
            <p className="mt-2.5 rounded-[var(--r-field)] border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm leading-relaxed text-emerald-800">
              {t("depositOnlineNote")}
            </p>
          )}
        </section>
      </div>

      <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--surface-card)] px-4 py-3.5 text-sm leading-relaxed text-[var(--text-secondary)] shadow-[var(--elev-1)] transition duration-[var(--dur-fast)] hover:border-[var(--line-strong)] has-[:checked]:border-blue-400 has-[:checked]:bg-blue-50/60 has-[:checked]:ring-2 has-[:checked]:ring-blue-500/20 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-500 has-[:focus-visible]:ring-offset-2">
        <input
          type="checkbox"
          checked={state.consent.summaryReviewed}
          onChange={(event) => updateSection("consent", { summaryReviewed: event.target.checked })}
          className="mt-0.5 h-4 w-4 shrink-0 rounded-sm accent-[var(--blue-500)] focus:outline-none"
        />
        <span>{t("reviewCheckbox")}</span>
      </label>

      <AlreadyPaidProofModal
        isOpen={proofModalOpen}
        bookingSessionId={bookingSessionId}
        proofPath={state.payment.proofPath}
        onProofPathChange={(path) => updateSection("payment", { proofPath: path })}
        onCancel={() => {
          setProofModalOpen(false);
          if (!state.payment.proofPath.trim()) {
            updateSection("payment", { mode: "stripe", proofPath: "" });
            updateSection("deposit", { depositMethod: "online" });
          }
        }}
        onConfirm={() => setProofModalOpen(false)}
      />
    </StepShell>
  );
}
