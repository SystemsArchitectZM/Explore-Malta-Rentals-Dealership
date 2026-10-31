"use client";

import Image from "next/image";
import { Pacifico } from "next/font/google";
import { LOGO_PATH } from "@/lib/site-brand-copy";

const rentalsScript = Pacifico({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

export function KioskHeader() {
  return (
    <header className="shrink-0 bg-[#0c2340] px-4 py-2.5 text-white sm:px-6 sm:py-3">
      <div className="flex items-center gap-2.5 sm:gap-3">
        <Image
          src={LOGO_PATH}
          alt=""
          width={56}
          height={56}
          className="h-10 w-10 shrink-0 object-contain sm:h-11 sm:w-11"
          priority
        />
        <h1
          className="flex min-w-0 items-baseline gap-x-1.5 leading-none"
          aria-label="Explore Malta Rentals"
        >
          {/* One phrase so Explore + Malta share the same tight tracking */}
          <span
            className="whitespace-nowrap text-[1.15rem] font-extrabold leading-none sm:text-[1.4rem]"
            style={{
              fontFamily:
                "var(--font-bricolage-grotesque), var(--font-plus-jakarta-sans), sans-serif",
              fontVariationSettings: '"opsz" 96',
              letterSpacing: "-0.06em",
            }}
          >
            <span className="text-white">Explore</span>
            <span className="text-[#e31b23]"> Malta</span>
          </span>
          <span
            className={`${rentalsScript.className} whitespace-nowrap text-[1.15rem] leading-none text-[#f5c518] sm:text-[1.35rem]`}
            style={{
              letterSpacing: "0",
              textShadow:
                "-1px -1px 0 #0a1420, 1px -1px 0 #0a1420, -1px 1px 0 #0a1420, 1px 1px 0 #0a1420",
            }}
          >
            Rentals.
          </span>
        </h1>
      </div>
    </header>
  );
}
