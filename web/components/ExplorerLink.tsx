const COSTON2_EXPLORER = "https://coston2-explorer.flare.network";

function shorten(value: string, lead = 6, tail = 4) {
  return `${value.slice(0, lead)}...${value.slice(-tail)}`;
}

export function ExplorerLink({
  address,
  label,
  className = "",
}: {
  address: string;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={`${COSTON2_EXPLORER}/address/${address}`}
      target="_blank"
      rel="noreferrer"
      className={`font-mono text-brand underline-offset-4 transition-colors hover:text-brand-hover hover:underline ${className}`}
    >
      {label ?? shorten(address)}
    </a>
  );
}
