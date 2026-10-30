import type { Metadata } from "next";

import { ConsoleHeading } from "../_components/console-bits";

export const metadata: Metadata = { title: "Chat · Signal" };

/**
 * Stub route owned by spec 006 task 07 (Demand questions answered by the Operator agent, with linked needs).
 * Task 05 only adds the route so the console's top bar links somewhere; task 07 replaces this
 * file with the real screen.
 */
export default function ChatPage() {
  return (
    <div data-stub="006-07">
      <ConsoleHeading title="Chat">Not built yet (spec 006, task 07).</ConsoleHeading>
    </div>
  );
}
