import type { ReactNode } from "react";

type KioskPanelProps = {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  children: ReactNode;
};

export function KioskPanel({ title, subtitle, icon, children }: KioskPanelProps) {
  return (
    <section className="rounded-2xl bg-white p-5 text-[#0c2340] shadow-lg sm:p-8">
      <div className="mb-6 flex items-start gap-3">
        {icon ? (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#0c2340]/10 text-[#0c2340]">
            {icon}
          </span>
        ) : null}
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#0c2340] sm:text-2xl">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm text-slate-600">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}
