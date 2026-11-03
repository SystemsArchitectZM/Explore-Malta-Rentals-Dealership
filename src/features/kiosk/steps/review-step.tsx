"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ClipboardList } from "lucide-react";
import { KioskTermsModal } from "@/features/kiosk/components/kiosk-terms-modal";
import { KioskPanel } from "@/features/kiosk/components/kiosk-panel";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import { buildKioskPricingInput } from "@/features/kiosk/lib/build-pricing-input";
import {
  calculateBookingPrice,
  formatEur,
  getCdwLabel,
} from "@/lib/pricing/calculate-booking-price";
import { LOYALTY_CREDIT_AMOUNT_EUR } from "@/lib/loyalty/loyalty-credit";
import { buildBookingPaymentSummary } from "@/lib/booking/build-booking-payment-summary";

const rowClass = "flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 border-b border-slate-100 py-2.5 text-sm last:border-b-0";
const labelClass = "text-slate-600";
const valueClass = "text-right font-medium tabular-nums text-[#0c2340]";
const sectionLabelClass = "text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500";

const depositOptionBase =
  "relative flex flex-col gap-1 rounded-xl border p-3.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2";
const depositOptionSelected = "border-blue-400 bg-blue-50/70 ring-2 ring-blue-500/25";
const depositOptionIdle = "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50";

function dayCountLabel(count: number) {
  return `charged as ${count} ${count === 1 ? "day" : "days"}`;
}

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

export function ReviewStep() {
  const { state, updateSection, stepError, isSubmitting, setLoyaltyCreditPreview } = useKioskBooking();
  const [termsModalOpen, setTermsModalOpen] = useState(false);
  const [loyaltyOffer, setLoyaltyOffer] = useState<{ email: string; available: boolean } | null>(
    null,
  );

  const pricingInput = buildKioskPricingInput(state);
  const pricing = pricingInput ? calculateBookingPrice(pricingInput) : null;

  useEffect(() => {
    const email = state.customer.email.trim();
    if (!email.includes("@")) {
      setLoyaltyOffer(null);
      return;
    }

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

  const loyaltyCreditAvailable =
    loyaltyOffer?.email === state.customer.email.trim() && loyaltyOffer.available === true;
  const loyaltyCreditAmount =
    loyaltyCreditAvailable && pricing && pricing.subtotal >= LOYALTY_CREDIT_AMOUNT_EUR
      ? LOYALTY_CREDIT_AMOUNT_EUR
      : 0;

  useEffect(() => {
    setLoyaltyCreditPreview(loyaltyCreditAmount);
  }, [loyaltyCreditAmount, setLoyaltyCreditPreview]);

  const payOnline = state.payment.mode === "stripe";

  const paymentSummary = useMemo(() => {
    if (!pricing) return null;
    return buildBookingPaymentSummary({
      subtotal: pricing.subtotal,
      depositAmount: pricing.depositAmount,
      depositMethod: payOnline ? "online" : "in_person",
      totalDueOnline: payOnline ? pricing.totalDueOnline : 0,
      totalDueLater: payOnline
        ? pricing.totalDueLater
        : pricing.subtotal + pricing.depositAmount,
      loyaltyCreditAmount,
    });
  }, [pricing, loyaltyCreditAmount, payOnline]);

  const totalLiability = paymentSummary?.totalCustomerLiability ?? null;
  const amountPayableOnline = payOnline ? (paymentSummary?.amountPayableOnline ?? 0) : 0;
  const amountDueAtCounter = payOnline ? 0 : (totalLiability ?? 0);

  const insuranceLabel =
    state.addons.cdwPlan === null
      ? "Not selected yet"
      : pricing
        ? getCdwLabel(pricing.cdwOptionApplied)
        : "—";

  function selectPayOnline() {
    updateSection("deposit", { depositMethod: "online" });
    updateSection("payment", { mode: "stripe" });
  }

  function selectPayAtCounter() {
    updateSection("deposit", { depositMethod: "in_person" });
    updateSection("payment", { mode: "pay_at_counter" });
  }

  const openTermsModal = () => setTermsModalOpen(true);

  const clearTermsAcceptance = () => {
    updateSection("consent", {
      termsAccepted: false,
      termsAcceptedAt: "",
    });
  };

  const acceptTerms = () => {
    updateSection("consent", {
      termsAccepted: true,
      termsAcceptedAt: new Date().toISOString(),
    });
    setTermsModalOpen(false);
  };

  return (
    <KioskPanel
      title="Review & submit"
      subtitle="Final review of booking details, pricing, and payment method before confirmation."
      icon={<ClipboardList className="h-6 w-6" aria-hidden />}
    >
      <div className="space-y-4">
        {/* Section 1 — Booking summary */}
        <section className="rounded-xl border border-slate-200 bg-white px-4 py-4 sm:px-5">
          <p className={sectionLabelClass}>Section 1 — Booking summary</p>
          <ul className="mt-3">
            <li className={rowClass}>
              <span className={labelClass}>Vehicle selected:</span>
              <span className={valueClass}>{state.rental.vehicleName || "—"}</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Customer:</span>
              <span className={valueClass}>{state.customer.fullName || "—"}</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Rental dates:</span>
              <span className={valueClass}>
                {state.rental.pickupDate || "—"} {state.rental.pickupTime || ""} to{" "}
                {state.rental.returnDate || "—"} {state.rental.returnTime || ""}
              </span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Rental length:</span>
              <span className={valueClass}>
                {pricing ? (
                  <>
                    {Number.isInteger(pricing.actualDurationHours)
                      ? String(pricing.actualDurationHours)
                      : String(pricing.actualDurationHours)}{" "}
                    hours · {dayCountLabel(pricing.rentalDays)}
                  </>
                ) : (
                  "—"
                )}
              </span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Pickup method:</span>
              <span className={valueClass}>office</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Pickup address:</span>
              <span className={valueClass}>—</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Drop-off method:</span>
              <span className={valueClass}>office</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Drop-off address:</span>
              <span className={valueClass}>—</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Insurance selected:</span>
              <span className={valueClass}>{insuranceLabel}</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Additional driver:</span>
              <span className={valueClass}>{state.addons.additionalDriver ? "Yes" : "No"}</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Helmet size 1:</span>
              <span className={valueClass}>{state.addons.helmetSize1 || "—"}</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Helmet size 2:</span>
              <span className={valueClass}>{state.addons.helmetSize2 || "—"}</span>
            </li>
            <li className={rowClass}>
              <span className={labelClass}>Storage box:</span>
              <span className={valueClass}>
                {state.rental.supportsStorageBox && state.addons.storageBox ? "Yes" : "No"}
              </span>
            </li>
            {state.hotelCode.appliedCode ? (
              <li className={rowClass}>
                <span className={labelClass}>Hotel code:</span>
                <span className={valueClass}>
                  {state.hotelCode.appliedCode}
                  {state.hotelCode.discountPercent != null
                    ? ` (−${state.hotelCode.discountPercent}%)`
                    : ""}
                </span>
              </li>
            ) : null}
          </ul>
        </section>

        {/* Section 2 — Pricing summary */}
        <section className="rounded-xl border border-slate-200 bg-white px-4 py-4 sm:px-5">
          <p className={sectionLabelClass}>Section 2 — Pricing summary</p>
          {pricing ? (
            <>
              <ul className="mt-3">
                <li className={rowClass}>
                  <span className={labelClass}>Base daily rate:</span>
                  <span className={valueClass}>{formatEur(pricing.baseDailyRate)}/day</span>
                </li>
                <li className={rowClass}>
                  <span className={labelClass}>Rental duration:</span>
                  <span className={valueClass}>
                    {dayCountLabel(pricing.rentalDays)} ({pricing.tierRange})
                  </span>
                </li>
                {pricing.durationDiscountPercent > 0 ? (
                  <li className={`${rowClass} font-medium text-emerald-700`}>
                    Duration discount: {pricing.durationDiscountPercent}% →{" "}
                    {formatEur(pricing.appliedDailyRate)}/day
                  </li>
                ) : null}
                <li className={rowClass}>
                  <span className={labelClass}>Rental cost:</span>
                  <span className={valueClass}>{formatEur(pricing.rentalCost)}</span>
                </li>
                {pricing.hotelDiscountAmount > 0 ? (
                  <li className={`${rowClass} font-medium text-emerald-700`}>
                    Hotel discount ({pricing.hotelDiscountPercent}%
                    {state.hotelCode.partnerName ? ` via ${state.hotelCode.partnerName}` : ""}
                    ): −{formatEur(pricing.hotelDiscountAmount)}
                  </li>
                ) : null}
                <li className={rowClass}>
                  <span className={labelClass}>Delivery / Drop-off:</span>
                  <span className={valueClass}>
                    {formatEur(pricing.deliveryTotal)} (pickup {formatEur(pricing.deliveryFee)} +
                    drop-off {formatEur(pricing.dropoffFee)}
                    {pricing.deliveryDiscount > 0
                      ? ` − ${formatEur(pricing.deliveryDiscount)} bundle discount`
                      : ""}
                    )
                  </span>
                </li>
                <li className={rowClass}>
                  <span className={labelClass}>Insurance:</span>
                  <span className={valueClass}>{formatEur(pricing.cdwCost)}</span>
                </li>
                <li className={rowClass}>
                  <span className={labelClass}>Additional driver:</span>
                  <span className={valueClass}>{formatEur(pricing.additionalDriverCost)}</span>
                </li>
                <li className={rowClass}>
                  <span className={labelClass}>Storage box:</span>
                  <span className={valueClass}>{formatEur(pricing.storageBoxCost)}</span>
                </li>
                {loyaltyCreditAmount > 0 ? (
                  <li className={`${rowClass} font-medium text-emerald-700`}>
                    Loyalty credit: −{formatEur(loyaltyCreditAmount)}
                  </li>
                ) : null}
              </ul>
              <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t-2 border-slate-200 pt-3">
                <p className="text-sm font-semibold text-[#0c2340]">Booking charges total:</p>
                <p className="text-lg font-bold tabular-nums text-[#0c2340]">
                  {formatEur(paymentSummary?.bookingChargesTotal ?? pricing.subtotal)}
                </p>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                Excludes security deposit.
                {loyaltyCreditAmount > 0
                  ? " €5 from a completed rental. Applied once. The security deposit is not reduced."
                  : ""}
              </p>
            </>
          ) : (
            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              Pricing preview will appear once vehicle and rental dates/times are valid.
            </p>
          )}
        </section>

        {/* Section 3 — Security deposit & payment */}
        <section className="rounded-xl border border-[#0c2340]/20 bg-slate-50/80 px-4 py-4 sm:px-5">
          <p className={sectionLabelClass}>Section 3 — Security deposit & payment</p>

          <div className="mt-4">
            <p className="text-sm font-semibold text-[#0c2340]">Security deposit method</p>
            <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                onClick={selectPayOnline}
                className={`${depositOptionBase} ${
                  payOnline ? depositOptionSelected : depositOptionIdle
                }`}
              >
                {payOnline ? <DepositOptionCheck /> : null}
                <span
                  className={`pr-5 text-sm font-semibold ${
                    payOnline ? "text-blue-800" : "text-[#0c2340]"
                  }`}
                >
                  Pay online now
                </span>
                <span className="text-xs leading-relaxed text-slate-600">
                  Include the security deposit in your Stripe payment — fully refundable after the
                  rental.
                </span>
              </button>
              <button
                type="button"
                onClick={selectPayAtCounter}
                className={`${depositOptionBase} ${
                  !payOnline ? depositOptionSelected : depositOptionIdle
                }`}
              >
                {!payOnline ? <DepositOptionCheck /> : null}
                <span
                  className={`pr-5 text-sm font-semibold ${
                    !payOnline ? "text-blue-800" : "text-[#0c2340]"
                  }`}
                >
                  Pay at counter
                </span>
                <span className="text-xs leading-relaxed text-slate-600">
                  Hand over rental charges and the security deposit in person at the shop counter.
                </span>
              </button>
            </div>
          </div>

          {paymentSummary && pricing ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white px-4 py-3.5">
              <p className={sectionLabelClass}>Payment summary</p>
              <dl className="mt-2">
                <div className={rowClass}>
                  <dt className={labelClass}>Booking charges total:</dt>
                  <dd className={valueClass}>{formatEur(paymentSummary.bookingChargesTotal)}</dd>
                </div>
                <div className={rowClass}>
                  <dt className={labelClass}>
                    {payOnline ? "Security deposit:" : "Security deposit (at counter):"}
                  </dt>
                  <dd className={valueClass}>{formatEur(paymentSummary.securityDeposit)}</dd>
                </div>
                <div className={`${rowClass} ${payOnline ? "font-semibold text-emerald-700" : ""}`}>
                  <dt className={`flex items-center gap-1.5 ${payOnline ? "" : labelClass}`}>
                    {payOnline ? (
                      <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                    ) : null}
                    Pay now online (Stripe):
                  </dt>
                  <dd className={payOnline ? "text-right tabular-nums" : valueClass}>
                    {formatEur(amountPayableOnline)}
                  </dd>
                </div>
                <div className={rowClass}>
                  <dt className={labelClass}>Amount due at counter:</dt>
                  <dd className={valueClass}>{formatEur(amountDueAtCounter)}</dd>
                </div>
              </dl>
              <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t-2 border-slate-200 pt-3">
                <p className="text-sm font-semibold text-[#0c2340]">Total customer liability:</p>
                <p className="text-lg font-bold tabular-nums text-[#f9900f]">
                  {formatEur(totalLiability ?? 0)}
                </p>
              </div>
            </div>
          ) : null}

          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            Security deposit is separate from booking charges and may be refundable according to
            rental policy.
          </p>
          {payOnline ? (
            <p className="mt-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm leading-relaxed text-emerald-800">
              Your security deposit will be charged with your booking and refunded after the vehicle
              is returned in good condition. Document checks still happen at the counter.
            </p>
          ) : (
            <p className="mt-2.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-slate-700">
              Payment and document verification happen at the shop counter — no card is charged
              online for this option.
            </p>
          )}
        </section>
      </div>

      <div className="mt-6 flex min-h-12 items-start gap-3 rounded-xl border border-slate-200 p-4">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 accent-[#f9900f]"
          checked={state.consent.termsAccepted}
          onChange={(e) => {
            if (e.target.checked) {
              openTermsModal();
              return;
            }
            clearTermsAcceptance();
          }}
        />
        <span className="text-sm text-slate-700">
          I accept the{" "}
          <button
            type="button"
            onClick={openTermsModal}
            className="font-semibold text-[#0c2340] underline underline-offset-2"
          >
            terms & conditions
          </button>
          .
        </span>
      </div>

      {stepError ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {stepError}
        </p>
      ) : null}

      {isSubmitting ? (
        <p className="mt-4 text-sm text-slate-600">Submitting your booking…</p>
      ) : null}

      <KioskTermsModal
        isOpen={termsModalOpen}
        onCancel={() => {
          setTermsModalOpen(false);
          if (!state.consent.termsAccepted) {
            clearTermsAcceptance();
          }
        }}
        onAgree={acceptTerms}
      />
    </KioskPanel>
  );
}
