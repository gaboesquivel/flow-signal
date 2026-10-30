"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/button";

import { formatDate } from "../_lib/console";
import type { SavedReport, ShareResult } from "../_lib/reports";
import { shareUrl } from "../_lib/reports";

export type ShareFlags = Extract<ShareResult, { status: "needs_acknowledgement" }>["flags"];
export type ShareAction = "refresh" | "revoke" | "share";

/** Share inline: names check first, then the link with copy, refresh, and revoke (spec 013). */
export function SharePanel({
  busy,
  flags,
  onAction,
  onDismissFlags,
  share,
}: {
  busy: boolean;
  flags: ShareFlags | null;
  onAction: (action: ShareAction, acknowledgeFlags?: boolean) => void;
  onDismissFlags: () => void;
  share: SavedReport["share"];
}) {
  return (
    <section aria-label="Share" className="border-border flex flex-col gap-3 border-y py-4 text-sm">
      {flags ? (
        <Flags busy={busy} flags={flags} onAction={onAction} onDismiss={onDismissFlags} />
      ) : null}
      {!flags && share ? <Link busy={busy} onAction={onAction} share={share} /> : null}
      {!flags && !share ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-muted-foreground">
            Creates a read-only link with a snapshot of this report. No sign-in needed to view it.
          </p>
          <Button disabled={busy} onClick={() => onAction("share")} size="sm" variant="outline">
            Create link
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function Flags({
  busy,
  flags,
  onAction,
  onDismiss,
}: {
  busy: boolean;
  flags: ShareFlags;
  onAction: (action: ShareAction, acknowledgeFlags?: boolean) => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <p>This report names people, accounts, or emails. Anyone with the link will see them:</p>
      <ul className="text-muted-foreground list-disc pl-5">
        {flags.map((flag) => (
          <li key={`${flag.kind}:${flag.match}`}>
            {flag.match} <span className="text-xs">({flag.kind})</span>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button disabled={busy} onClick={() => onAction("share", true)} variant="outline">
          Share anyway
        </Button>
        <Button onClick={onDismiss} variant="ghost">
          Cancel
        </Button>
      </div>
    </>
  );
}

function Link({
  busy,
  onAction,
  share,
}: {
  busy: boolean;
  onAction: (action: ShareAction) => void;
  share: NonNullable<SavedReport["share"]>;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl(share.path));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <p className="text-muted-foreground">
        Anyone with this link sees the report as of{" "}
        <span className="font-mono">{formatDate(share.snapshotAt)}</span>. Refresh it to show new
        data.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="bg-muted min-w-0 truncate rounded px-2 py-1 font-mono text-xs">
          {shareUrl(share.path)}
        </code>
        <Button onClick={copy} size="sm" variant="outline">
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button disabled={busy} onClick={() => onAction("refresh")} size="sm" variant="outline">
          Refresh link data
        </Button>
        <Button disabled={busy} onClick={() => onAction("revoke")} size="sm" variant="ghost">
          Revoke
        </Button>
      </div>
    </>
  );
}
