import type { Metadata } from "next";

import { ConsoleHeading } from "../_components/console-bits";

export const metadata: Metadata = { title: "Criteria · Signal" };

/**
 * Stub route owned by spec 006 task 07 (Four weights summing to 1.00, with a live re-rank preview before Save).
 * Task 05 only adds the route so the console's top bar links somewhere; task 07 replaces this
 * file with the real screen.
 */
export default function CriteriaPage() {
  return (
    <div data-stub="006-07">
      <ConsoleHeading title="Criteria">Not built yet (spec 006, task 07).</ConsoleHeading>
    </div>
  );
}
