import type { Rule } from "../kernel/rules.ts";
export type Job = {
  run: number;
  token: string;
  attempt: number;
  /**
   * `assess` is a round of the assessor Agent: it reads the event and answers with a verdict, doing no work.
   * `speculate` is a background try whose result is only delivered when it found something worth it.
   */
  kind?: "assess" | "speculate";
  rule: Pick<Rule, "name" | "cwd" | "skill" | "prompt" | "title" | "emits">;
  /** How this rule's messages read where they land: a chat wants a sentence, a review wants a write-up. */
  style?: "im" | "async";
  agent: {
    id: string;
    name: string;
    use: string;
    model?: string;
    effort?: string;
    tier?: string;
    access: string;
    command?: string[];
    program?: string;
    timeout?: number;
  };
  session: string | null;
  askFirst: string[];
  /**
   * Stable references for recalling context by hops: this matter, the rounds already done on it, and other live matters on
   * the same subject. Each carries an id a later round can name, so an agent needn't be handed everything at once.
   */
  thread?: {
    id: string;
    rule: string;
    lane: string;
    project?: string;
    rounds: { run: number; state: string; summary: string; at: string | null }[];
    related: { rule: string; lane: string; stage: string }[];
  };
  context: {
    events: {
      id: string;
      source: string;
      sourceName: string;
      type: string;
      subject: string;
      summary: string;
      detail: string;
      link: string;
      receivedAt: string;
      hops?: number;
    }[];
    answers: {
      card: number;
      title: string;
      options: string[];
      choice: number | null;
      chosen: string | null;
      text: string | null;
      about: string;
      by: string | null;
      at: string;
    }[];
    timers: { key: string; about: string; at: string }[];
    waiting: { key: string; about: string; at: string }[];
    open: { card: number; title: string; text: string; at: string }[];
    decided: { card: number; title: string; choice: string | null; at: string }[];
  };
};
