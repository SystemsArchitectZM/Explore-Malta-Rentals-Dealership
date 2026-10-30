"use client";

import { Eye, EyeOff, Lock, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { AdminLoginHeroImage } from "@/features/admin/components/admin-login-hero-image";
import { safeAdminRedirectPath } from "@/lib/admin-auth/path-utils";

type AdminLoginFormProps = Readonly<{
  locale: string;
  contactEmail: string;
}>;

function AdminInputIcon({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <span className="inline-flex size-9 shrink-0 items-center justify-center border-r border-slate-200 bg-slate-50 text-slate-500">
      {children}
    </span>
  );
}

export function AdminLoginForm({ locale, contactEmail }: AdminLoginFormProps) {
  const t = useTranslations("Admin");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keepLoggedIn, setKeepLoggedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const redirectTarget = safeAdminRedirectPath(locale, searchParams.get("redirect"));
  const forgotPasswordHref = `mailto:${contactEmail}?subject=${encodeURIComponent("Admin password reset request")}`;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ email, password }),
      });

      let payload: { success?: boolean; message?: string } = {};
      try {
        payload = (await response.json()) as { success?: boolean; message?: string };
      } catch {
        payload = {};
      }

      if (!response.ok || !payload.success) {
        setError(payload.message ?? t("loginErrorGeneric"));
        return;
      }

      router.replace(redirectTarget);
      router.refresh();
    } catch {
      setError(t("loginErrorGeneric"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-[374px] overflow-hidden rounded-[24px] bg-white shadow-[0_20px_50px_rgba(15,34,51,0.12)]">
      <AdminLoginHeroImage alt={t("loginHeroAlt")} brandLabel={t("loginHeroBrand")} />

      <section className="border-b border-slate-100 bg-white px-5 pb-3.5 pt-3.5 text-center">
        <h2 className="text-lg font-bold tracking-[-0.02em] text-[#24345b]">
          {t("loginAccessTitle")}
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm text-xs leading-snug text-slate-500">
          {t("loginAccessDescription")}
        </p>
      </section>

      <form onSubmit={handleSubmit} className="px-5 py-5">
        <header className="mb-4">
          <h1 className="text-[1.65rem] font-bold leading-none tracking-[-0.04em] text-[#24345b]">
            {t("loginHeading")}
          </h1>
          <p className="mt-1.5 text-xs text-slate-500">{t("loginSubtitle")}</p>
        </header>

        <div className="space-y-3">
          <label className="block">
            <span className="sr-only">{t("emailLabel")}</span>
            <span className="flex overflow-hidden rounded-xl border border-slate-200 bg-white transition focus-within:border-[#24345b] focus-within:ring-2 focus-within:ring-[#24345b]/10">
              <AdminInputIcon>
                <UserRound className="size-[18px]" aria-hidden />
              </AdminInputIcon>
              <input
                type="email"
                name="email"
                autoComplete="username"
                required
                placeholder={t("emailPlaceholder")}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-slate-800 outline-none placeholder:text-slate-400"
              />
            </span>
          </label>

          <label className="block">
            <span className="sr-only">{t("passwordLabel")}</span>
            <span className="flex overflow-hidden rounded-xl border border-slate-200 bg-white transition focus-within:border-[#24345b] focus-within:ring-2 focus-within:ring-[#24345b]/10">
              <AdminInputIcon>
                <Lock className="size-[18px]" aria-hidden />
              </AdminInputIcon>
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                autoComplete="current-password"
                required
                placeholder={t("passwordPlaceholder")}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-sm text-slate-800 outline-none placeholder:text-slate-400"
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                className="inline-flex size-9 shrink-0 items-center justify-center border-l border-slate-200 bg-slate-50 text-slate-500 transition hover:text-[#24345b]"
                aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                aria-pressed={showPassword}
              >
                {showPassword ? (
                  <EyeOff className="size-[18px]" aria-hidden />
                ) : (
                  <Eye className="size-[18px]" aria-hidden />
                )}
              </button>
            </span>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <label className="inline-flex cursor-pointer items-center gap-2 text-slate-600">
            <input
              type="checkbox"
              checked={keepLoggedIn}
              onChange={(event) => setKeepLoggedIn(event.target.checked)}
              className="size-4 rounded border-slate-300 text-[#24345b] focus:ring-[#24345b]/20"
            />
            {t("keepLoggedIn")}
          </label>
          <a
            href={forgotPasswordHref}
            className="font-medium text-slate-500 transition hover:text-[#24345b]"
          >
            {t("forgotPassword")}
          </a>
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-medium text-red-700"
          >
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-4 w-full rounded-xl bg-[#24345b] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#1a2744] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? t("signingIn") : t("logInButton")}
        </button>
      </form>
    </div>
  );
}
