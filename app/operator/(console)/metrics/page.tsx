import type { Metadata } from "next";

import { ConsoleHeading } from "../_components/console-bits";

export const metadata: Metadata = { title: "Metrics · Signal" };

/**
 * Stub route owned by spec 006 task 07 (The three MVP metrics for 28 and 90 days, people and agents apart).
 * Task 05 only adds the route so the console's top bar links somewhere; task 07 replaces this
 * file with the real screen.
 */
export default function MetricsPage() {
  return (
    <div data-stub="006-07">
      <ConsoleHeading title="Metrics">Not built yet (spec 006, task 07).</ConsoleHeading>
    </div>
  );
}
