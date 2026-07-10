import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { coston2 } from "./chain";

export const wagmiConfig = createConfig({
  chains: [coston2],
  connectors: [injected()],
  transports: {
    [coston2.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
