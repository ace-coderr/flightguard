"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectWallet } from "./ConnectWallet";

const links = [
  { href: "/cover", label: "Buy Cover" },
  { href: "/policies", label: "My Policies" },
  { href: "/pool", label: "Pool" },
  { href: "/radar", label: "Radar" },
];

export function Nav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 bg-canvas/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3 md:grid md:grid-cols-[1fr_auto_1fr] md:py-5">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight md:justify-self-start">
          <span className="h-2.5 w-2.5 rounded-full bg-brand" aria-hidden />
          FlightGuard
        </Link>

        <nav className="hidden items-center gap-8 rounded-full bg-white px-6 py-3 shadow-sm ring-1 ring-ink/5 md:flex md:justify-self-center">
          {links.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={
                  isActive
                    ? "rounded-full bg-ink px-3 py-1.5 text-sm font-medium text-white"
                    : "text-sm font-medium text-muted transition-colors hover:text-ink"
                }
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-3 md:justify-self-end">
          <div className="hidden md:block">
            <ConnectWallet />
          </div>

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Toggle menu"
            aria-expanded={menuOpen}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-ink/5 md:hidden"
          >
            <span className="relative block h-3 w-4" aria-hidden>
              <span
                className={`absolute left-0 h-0.5 w-4 bg-ink transition-transform ${menuOpen ? "top-1.5 rotate-45" : "top-0"}`}
              />
              <span className={`absolute left-0 top-1.5 h-0.5 w-4 bg-ink transition-opacity ${menuOpen ? "opacity-0" : "opacity-100"}`} />
              <span
                className={`absolute left-0 h-0.5 w-4 bg-ink transition-transform ${menuOpen ? "top-1.5 -rotate-45" : "top-3"}`}
              />
            </span>
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="mx-auto max-w-6xl px-6 pb-5 md:hidden">
          <div className="flex flex-col gap-2 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-ink/5">
            {links.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className={
                    isActive
                      ? "rounded-xl bg-ink px-4 py-2.5 text-sm font-medium text-white"
                      : "rounded-xl px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:bg-canvas hover:text-ink"
                  }
                >
                  {link.label}
                </Link>
              );
            })}
            <div className="px-1 pt-1">
              <ConnectWallet />
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
