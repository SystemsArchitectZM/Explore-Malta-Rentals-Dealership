import type { ReactNode } from "react";
import { MotionProvider } from "@/components/motion/motion-provider";

type KioskLayoutProps = {
  children: ReactNode;
};

export default function KioskLayout({ children }: KioskLayoutProps) {
  return (
    <MotionProvider>
      <div className="flex min-h-dvh flex-col bg-[#e8edf2] text-[#0c2340]">{children}</div>
    </MotionProvider>
  );
}
