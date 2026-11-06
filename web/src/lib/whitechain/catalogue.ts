/** What the demo merchant sells on Whitechain. Prices fit a $0.50 line, as on the other rails. */
export const WC_ITEMS = {
  signal: { title: "Market signal", priceUsd: 0.01 },
  report: { title: "Merchant risk report", priceUsd: 0.2 },
} as const;
export type WcItem = keyof typeof WC_ITEMS;
export const isWcItem = (s: string): s is WcItem => s in WC_ITEMS;
