// A channel is a program that comes to the hub for cards and makes a chat app match them: `plugins/<use>/channel.ts`,
// in this install's folder first, then the ones that ship. A channel in another language needs only the protocol.
import type { Hub } from "../protocol/client.ts";
import { loadPlugin } from "./plugins.ts";

export type Card = {
  id: number;
  version: number;
  ref: string | null;
  kind: "ask" | "notice";
  state: "open" | "decided" | "done" | "closed";
  title: string;
  text: string;
  options: string[];
  recommend: number | null;
  choice: number | null;
  answer: string | null;
  result: string | null;
  link: string | null;
  rule?: string;
  /** The matter this card belongs to, when the rule splits work by subject; a chat can show which project is asking. */
  lane?: string;
  /** A source conversation the card belongs to, e.g. `qq-private-10001` or `qq-group-20002`; a channel decides whether it
   * can reach it. */
  reply?: string;
  /** A receipt the hub keeps as already closed: it still has to reach the person, so it is not ordinary progress. */
  fyi?: boolean;
  /** When the card was created by the hub. Used by long-lived channels to avoid replaying cards from before a restart. */
  createdAt?: string;
};
export type ChannelContext = {
  hub: Pick<Hub, "nextCard" | "delivered" | "failed" | "answer">;
  options: Record<string, unknown>;
  log: (line: string) => void;
  signal: AbortSignal;
};

export async function loadChannel(use: string) {
  return (await loadPlugin(use, "channel")) as (context: ChannelContext) => Promise<void>;
}
