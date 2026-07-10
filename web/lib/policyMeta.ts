const STORAGE_KEY = "flightguard:policy-meta";

type PolicyMeta = { flightIata: string; date: string };

function readStore(): Record<string, PolicyMeta> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** Local-only convenience cache: requestHash -> flight info, so /policies can show
 *  the flight a policy covers without the contract needing to store it onchain. */
export function savePolicyMeta(requestHash: string, meta: PolicyMeta) {
  if (typeof window === "undefined") return;
  const store = readStore();
  store[requestHash] = meta;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export function getPolicyMeta(requestHash: string): PolicyMeta | undefined {
  return readStore()[requestHash];
}
