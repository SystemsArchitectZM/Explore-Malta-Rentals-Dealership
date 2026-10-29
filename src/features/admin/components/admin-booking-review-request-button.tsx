"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

type AdminBookingReviewRequestButtonProps = Readonly<{
  bookingId: string;
  disabled: boolean;
  label: string;
  sendingLabel: string;
  successMessage: string;
  fallbackError: string;
  children?: ReactNode;
}>;

export function AdminBookingReviewRequestButton({
  bookingId,
  disabled,
  label,
  sendingLabel,
  successMessage,
  fallbackError,
  children,
}: AdminBookingReviewRequestButtonProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function resend() {
    setIsSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/bookings/${bookingId}/review-request/resend`, {
        method: "POST",
      });
      const payload = (await response.json()) as { success?: boolean; message?: string };
      if (!response.ok || !payload.success) {
        setError(payload.message ?? fallbackError);
        return;
      }
      setMessage(successMessage);
      router.refresh();
    } catch {
      setError(fallbackError);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            void resend();
          }}
          disabled={disabled || isSubmitting}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {isSubmitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {isSubmitting ? sendingLabel : label}
        </button>
        {children}
      </div>
      {message ? <p className="text-sm text-emerald-700">{message}</p> : null}
      {error ? <p className="text-sm text-rose-700">{error}</p> : null}
    </div>
  );
}
