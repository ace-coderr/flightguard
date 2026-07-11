const COSTON2_EXPLORER = "https://coston2-explorer.flare.network";

function shorten(value: string, lead = 6, tail = 4) {
  return `${value.slice(0, lead)}...${value.slice(-tail)}`;
}

export function explorerUrl(value: string, kind: "address" | "tx" = "address") {
  return `${COSTON2_EXPLORER}/${kind}/${value}`;
}

export function ExplorerLink({
  address,
  kind = "address",
  label,
  className = "",
}: {
  address: string;
  kind?: "address" | "tx";
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={explorerUrl(address, kind)}
      target="_blank"
      rel="noreferrer"
      className={`font-mono text-brand underline-offset-4 transition-colors hover:text-brand-hover hover:underline ${className}`}
    >
      {label ?? shorten(address)}
    </a>
  );
}
