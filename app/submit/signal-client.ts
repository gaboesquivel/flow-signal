"use client";

import { createSignalClient } from "@/lib/signal/client";

/** The browser's Signal client: relative URLs on this origin, through the public REST API. */
export const signalClient = createSignalClient();
