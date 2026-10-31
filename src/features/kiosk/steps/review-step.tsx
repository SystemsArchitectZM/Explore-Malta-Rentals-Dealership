"use client";

import { useEffect, useMemo, useState } from "react";
import { ClipboardList } from "lucide-react";
import { KioskTermsModal } from "@/features/kiosk/components/kiosk-terms-modal";
import { KioskPanel } from "@/features/kiosk/components/kiosk-panel";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import { buildKioskPricingInput } from "@/features/kiosk/lib/build-pricing-input";
import {
  calculateBookingPrice,
  formatEur,
  getCdwLabel,
} from "@/lib/pricing/calculate-booking-price";
import { INSURANCE_PLANS, isInsurancePlanCode } from "@/lib/pricing/insurance-plans";
import { LOYALTY_CREDIT_AMOUNT_EUR } from "@/lib/loyalty/loyalty-credit";
import { buildBookingPaymentSummary } from "@/lib/booking/build-booking-payment-summary";

const rowClass = "flex justify-between gap-4 border-b border-slate-100 py-2 text-sm";

export function ReviewStep() {
  const { state, updateSection, stepError, isSubmitting, setLoyaltyCreditPreview } = useKioskBooking();
  const [termsModalOpen, setTermsModalOpen] = useState(false);
  const [loyaltyOffer, setLoyaltyOffer] = useState<{ email: string; available: boolean } | null>(
    null,
  );

  const pricingInput = buildKioskPricingInput(state);
  const pricing = pricingInput ? calculateBookingPrice(pricingInput) : null;
  const insuranceLabel =
    state.addons.cdwPlan && isInsurancePlanCode(state.addons.cdwPlan)
      ? INSURANCE_PLANS[state.addons.cdwPlan].label
      : "—";

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

  const paymentSummary = useMemo(() => {
    if (!pricing) return null;
    return buildBookingPaymentSummary({
      subtotal: pricing.subtotal,
      depositAmount: pricing.depositAmount,
      depositMethod: "in_person",
      totalDueOnline: 0,
      totalDueLater: pricing.subtotal + pricing.depositAmount,
      loyaltyCreditAmount,
    });
  }, [pricing, loyaltyCreditAmount]);

  const dueAtCounter = paymentSummary?.totalCustomerLiability ?? null;

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
      subtitle="Pay rental and security deposit at the counter (pay at counter)."
      icon={<ClipboardList className="h-6 w-6" aria-hidden />}
    >
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50/80 px-4">
        <div className={rowClass}>
          <span className="text-slate-600">Vehicle</span>
          <span className="font-medium text-[#0c2340]">{state.rental.vehicleName || "—"}</span>
        </div>
        <div className={rowClass}>
          <span className="text-slate-600">Dates</span>
          <span className="text-right font-medium tabular-nums">
            {state.rental.pickupDate} {state.rental.pickupTime} → {state.rental.returnDate}{" "}
            {state.rental.returnTime}
          </span>
        </div>
        <div className={rowClass}>
          <span className="text-slate-600">Pickup</span>
          <span className="font-medium capitalize">office</span>
        </div>
        <div className={rowClass}>
          <span className="text-slate-600">Return</span>
          <span className="font-medium capitalize">office</span>
        </div>
        <div className={rowClass}>
          <span className="text-slate-600">Insurance</span>
          <span className="font-medium text-[#0c2340]">{insuranceLabel}</span>
        </div>
        <div className={rowClass}>
          <span className="text-slate-600">Customer</span>
          <span className="text-right font-medium">{state.customer.fullName}</span>
        </div>
        {state.hotelCode.appliedCode ? (
          <div className={rowClass}>
            <span className="text-slate-600">Hotel code</span>
            <span className="font-medium">
              {state.hotelCode.appliedCode}
              {state.hotelCode.discountPercent != null
                ? ` (−${state.hotelCode.discountPercent}%)`
                : ""}
            </span>
          </div>
        ) : null}
      </div>

      {pricing && paymentSummary ? (
        <div className="mt-6 rounded-xl border border-[#0c2340]/20 bg-white p-4">
          <h3 className="font-bold text-[#0c2340]">Price summary</h3>
          <div className="mt-3 space-y-1 text-sm">
            <div className={rowClass}>
              <span>Rental & add-ons</span>
              <span className="tabular-nums">{formatEur(pricing.subtotal)}</span>
            </div>
            {loyaltyCreditAmount > 0 ? (
              <div className={rowClass}>
                <span>Loyalty credit</span>
                <span className="tabular-nums text-emerald-700">
                  −{formatEur(loyaltyCreditAmount)}
                </span>
              </div>
            ) : null}
            <div className={rowClass}>
              <span>Booking charges</span>
              <span className="tabular-nums">{formatEur(paymentSummary.bookingChargesTotal)}</span>
            </div>
            <div className={rowClass}>
              <span>Security deposit (at counter)</span>
              <span className="tabular-nums">{formatEur(pricing.depositAmount)}</span>
            </div>
            <div className={`${rowClass} border-none text-base font-bold`}>
              <span>Due at counter</span>
              <span className="tabular-nums text-[#f9900f]">
                {formatEur(dueAtCounter ?? 0)}
              </span>
            </div>
            <p className="pt-1 text-xs text-slate-500">
              Payment and document verification happen at the shop counter — this kiosk does not
              charge your card online (no Stripe).
            </p>
            {pricing.cdwCost > 0 ? (
              <p className="pt-2 text-xs text-slate-500">
                Insurance: {getCdwLabel(pricing.cdwOptionApplied)}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

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
