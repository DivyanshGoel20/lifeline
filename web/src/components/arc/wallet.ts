/** What the host app supplies to every panel that can send a transaction. */
export type Wallet = {
  available: boolean;
  address: string | null;
  onArc: boolean;
  connecting: boolean;
  error: string | null;
  connect(): Promise<void>;
  sendCalls(calls: { to: string; data: string }[]): Promise<string[]>;
  signMessage(message: string): Promise<string>;
};
