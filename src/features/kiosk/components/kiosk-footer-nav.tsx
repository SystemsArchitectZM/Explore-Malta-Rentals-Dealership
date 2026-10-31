"use client";

type KioskFooterNavProps = {
  onBack?: () => void;
  onPrimary: () => void;
  primaryLabel?: string;
  primaryLoading?: boolean;
  backDisabled?: boolean;
  primaryDisabled?: boolean;
  hideBack?: boolean;
};

export function KioskFooterNav({
  onBack,
  onPrimary,
  primaryLabel = "Continue",
  primaryLoading = false,
  backDisabled = false,
  primaryDisabled = false,
  hideBack = false,
}: KioskFooterNavProps) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 px-4 py-4 backdrop-blur sm:px-8">
      <div className="mx-auto flex max-w-4xl gap-3 sm:justify-between">
        {!hideBack ? (
          <button
            type="button"
            onClick={onBack}
            disabled={backDisabled || primaryLoading}
            className="min-h-12 flex-1 rounded-xl border-2 border-[#0c2340] px-6 text-base font-semibold text-[#0c2340] transition hover:bg-[#0c2340]/5 disabled:cursor-not-allowed disabled:opacity-40 sm:max-w-[200px] sm:flex-none"
          >
            Back
          </button>
        ) : (
          <span className="hidden sm:block sm:max-w-[200px]" />
        )}
        <button
          type="button"
          onClick={onPrimary}
          disabled={primaryDisabled || primaryLoading}
          className="min-h-12 flex-[2] rounded-xl px-6 text-base font-bold text-white shadow-md transition disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-md sm:flex-none"
          style={{
            background: primaryDisabled ? "#cbd5e1" : "linear-gradient(180deg, #ffa939 0%, #f9900f 100%)",
          }}
        >
          {primaryLoading ? "Please wait…" : primaryLabel}
        </button>
      </div>
    </div>
  );
}
