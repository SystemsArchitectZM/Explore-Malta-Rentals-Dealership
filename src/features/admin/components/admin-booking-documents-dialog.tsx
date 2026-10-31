"use client";

import { FileUp, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { uploadBookingDocument } from "@/features/booking-flow/lib/upload-booking-document";
import type { AdminBookingDetail } from "@/lib/admin/bookings/types";
import type { UploadCategory } from "@/lib/uploads/types";

type AdminBookingDocumentsDialogProps = Readonly<{
  booking: AdminBookingDetail;
  isSubmitting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (input: {
    customerLicenseUploadPath?: string;
    customerPassportUploadPath?: string;
    additionalDriverLicenseUploadPath?: string;
    additionalDriverPassportUploadPath?: string;
  }) => void;
}>;

function fileLabel(path: string | null, noneLabel: string): string {
  if (!path?.trim()) return noneLabel;
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] ?? path;
}

type DocField = {
  key: "license" | "passport" | "additionalLicense" | "additionalPassport";
  label: string;
  category: UploadCategory;
  currentPath: string | null;
};

export function AdminBookingDocumentsDialog({
  booking,
  isSubmitting,
  error,
  onClose,
  onConfirm,
}: AdminBookingDocumentsDialogProps) {
  const t = useTranslations("Admin.bookings.lifecycle.documents");
  const tLifecycle = useTranslations("Admin.bookings.lifecycle");
  const [paths, setPaths] = useState<{
    license?: string;
    passport?: string;
    additionalLicense?: string;
    additionalPassport?: string;
  }>({});
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const fields: DocField[] = [
    {
      key: "license",
      label: t("license"),
      category: "customer_license",
      currentPath: booking.customerLicenseUploadPath,
    },
    {
      key: "passport",
      label: t("passport"),
      category: "customer_passport",
      currentPath: booking.customerPassportUploadPath,
    },
    ...(booking.additionalDriverEnabled
      ? ([
          {
            key: "additionalLicense",
            label: t("additionalLicense"),
            category: "additional_driver_license",
            currentPath: booking.additionalDriverLicenseUploadPath,
          },
          {
            key: "additionalPassport",
            label: t("additionalPassport"),
            category: "additional_driver_passport",
            currentPath: booking.additionalDriverPassportUploadPath,
          },
        ] as const)
      : []),
  ];

  async function handleFileChange(field: DocField, file: File | null) {
    if (!file) return;
    setLocalError(null);
    setUploadingKey(field.key);
    const result = await uploadBookingDocument(file, field.category, booking.bookingReference);
    setUploadingKey(null);
    if (!result.ok) {
      setLocalError(result.message || t("uploadFailed"));
      return;
    }
    setPaths((current) => ({ ...current, [field.key]: result.relativePath }));
  }

  const canSave =
    Boolean(paths.license || paths.passport || paths.additionalLicense || paths.additionalPassport) &&
    !uploadingKey &&
    !isSubmitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
      >
        <h4 className="text-lg font-bold text-slate-950">{t("title")}</h4>
        <p className="mt-1 text-sm text-slate-600">
          {t("description", { reference: booking.bookingReference })}
        </p>

        <div className="mt-4 space-y-4">
          {fields.map((field) => {
            const nextPath = paths[field.key];
            const displayPath = nextPath ?? field.currentPath;
            return (
              <div key={field.key} className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                <p className="text-sm font-semibold text-slate-900">{field.label}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {t("current", {
                    file: fileLabel(displayPath, t("none")),
                  })}
                </p>
                <label className="mt-3 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50">
                  <FileUp className="size-4 shrink-0" aria-hidden />
                  {uploadingKey === field.key ? t("uploading") : t("chooseFile")}
                  <input
                    type="file"
                    accept="image/*,.pdf,application/pdf"
                    className="sr-only"
                    disabled={Boolean(uploadingKey) || isSubmitting}
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      void handleFileChange(field, file);
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
            );
          })}
        </div>

        {localError || error ? (
          <p className="mt-3 text-sm text-red-600">{localError ?? error}</p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={isSubmitting || Boolean(uploadingKey)}
            onClick={onClose}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"
          >
            {tLifecycle("cancel")}
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() =>
              onConfirm({
                ...(paths.license ? { customerLicenseUploadPath: paths.license } : {}),
                ...(paths.passport ? { customerPassportUploadPath: paths.passport } : {}),
                ...(paths.additionalLicense
                  ? { additionalDriverLicenseUploadPath: paths.additionalLicense }
                  : {}),
                ...(paths.additionalPassport
                  ? { additionalDriverPassportUploadPath: paths.additionalPassport }
                  : {}),
              })
            }
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {isSubmitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
