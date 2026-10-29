import { getTranslations, setRequestLocale } from "next-intl/server";

import { AdminStripePaymentPanel } from "@/features/admin/components/admin-stripe-payment-panel";
import { requireAdminPage } from "@/lib/admin-auth/require-admin-page";

export const dynamic = "force-dynamic";

type AdminStripePaymentsPageProps = Readonly<{
  params: Promise<{ locale: string }>;
}>;

export default async function AdminStripePaymentsPage({ params }: AdminStripePaymentsPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireAdminPage({
    locale,
    redirectTo: `/${locale}/admin/stripe-payments`,
  });
  const t = await getTranslations({ locale, namespace: "Admin.stripePayments" });

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-950">{t("pageTitle")}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">{t("pageDescription")}</p>
      </section>

      <AdminStripePaymentPanel viewerRole={session.role} />
    </div>
  );
}
