import { Link } from "@/i18n/navigation";
import { KioskHeader } from "@/features/kiosk/components/kiosk-header";

export default function KioskHomePage() {
  return (
    <div className="flex min-h-dvh flex-col bg-[#e8edf2] text-[#0c2340]">
      <KioskHeader />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <div className="rounded-3xl bg-white p-10 shadow-xl">
          <p className="text-sm font-semibold uppercase tracking-[0.15em] text-[#f9900f]">
            Welcome
          </p>
          <h2 className="mt-3 text-3xl font-bold text-[#0c2340] sm:text-4xl">
            Book your rental in minutes
          </h2>
          <p className="mt-4 text-base text-slate-600">
            Choose dates, pick a scooter or bike, and pay at our counter when you arrive. No card
            required on this kiosk.
          </p>
          <Link
            href="/kiosk/booking"
            className="mt-8 inline-flex min-h-14 items-center justify-center rounded-xl px-10 text-lg font-bold text-white shadow-lg"
            style={{ background: "linear-gradient(180deg, #ffa939 0%, #f9900f 100%)" }}
          >
            Start booking
          </Link>
        </div>
      </main>
    </div>
  );
}
