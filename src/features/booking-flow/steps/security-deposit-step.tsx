"use client";

import { useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { StepShell } from "@/features/booking-flow/components/step-shell";
import { useBookingFlow } from "@/features/booking-flow/context/booking-flow-context";
import { SECURITY_DEPOSIT_EUR } from "@/features/booking/lib/booking-schema";

export function SecurityDepositStep() {
  const t = useTranslations("BookingWizard.securityDeposit");
  const { state, updateSection } = useBookingFlow();

  useEffect(() => {
    if (state.deposit.depositMethod !== "online") {
      updateSection("deposit", { depositMethod: "online" });
    }
  }, [state.deposit.depositMethod, updateSection]);

  return (
    <StepShell title={t("shellTitle")} description={t("shellDescription")}>
      <div className="mb-3 flex items-start gap-3.5 rounded-[var(--r-card)] border border-blue-200 bg-blue-50/60 px-4 py-3.5 text-sm text-[var(--text-secondary)]">
        <span
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700"
          aria-hidden
        >
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="font-semibold tracking-[-0.01em] tabular-nums text-[var(--text-primary)]">
            {t("intro", { amount: SECURITY_DEPOSIT_EUR })}
          </p>
          <p className="mt-1 leading-relaxed">{t("heldNote")}</p>
        </div>
      </div>
      <div className="surface-card p-4 text-sm leading-relaxed text-[var(--text-secondary)] sm:p-5">
        <p>{t("payOnline")}</p>
      </div>
    </StepShell>
  );
}
