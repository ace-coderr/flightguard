import { flightGuardAddress } from "@/lib/contracts";
import { ExplorerLink } from "./ExplorerLink";

const links = [
  { label: "GitHub", href: "https://github.com/ace-coderr/flightguard" },
  { label: "Flare docs", href: "https://dev.flare.network" },
];

export function Footer() {
  return (
    <footer className="bg-ink text-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-2 text-lg font-semibold">
            <span className="h-2.5 w-2.5 rounded-full bg-brand" aria-hidden />
            FlightGuard
          </div>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="text-white/70 transition-colors hover:text-white"
              >
                {link.label}
              </a>
            ))}
            <span className="text-white/70">
              Contract: <ExplorerLink address={flightGuardAddress} />
            </span>
          </div>
        </div>
        <p className="mt-10 font-mono text-xs uppercase tracking-widest text-white/40">
          Built for Flare Summer Signal. FDC, FTSO, Coston2, all load-bearing.
        </p>
      </div>
    </footer>
  );
}
