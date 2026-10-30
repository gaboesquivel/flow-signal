# 0005 — My signals links carry forward; never grouped by email

Status: Accepted (2026-10-30)

## Context

Spec 001 issues one private, unguessable tracking token per submission, so a person who files three requests holds three My signals links. The product owner wants one person's signals on one page. Submitters are not signed in and emails are not verified, and the MVP sends no email (spec 001, Out of Scope). Anyone can type any address into the submit form.

## Options

1. **Group by email.** The link shows every signal filed with that email. Anyone who submits with someone else's address gets a link to that person's verbatim words, use cases, and urgency: a privacy leak by design.
2. **Email magic link.** Verify the address by sending a sign-in link, then group by verified email. Correct grouping, but needs email delivery, which the MVP excludes.
3. **The link carries forward.** A submitter who already holds a link (remembered on the device or pasted in) files new signals onto that same link. Possession of the link is the proof; nothing is grouped by email.

## Decision

Option 3. `submit_signal` accepts an optional `trackingToken`; when it names an existing link, the new signal joins that link and the response returns the same `trackingUrl`. The web submit flow remembers the holder's link on the device and offers "Not you? Start a new link". Agents pass the token only when the submitter gave it to them. Links are never derived from or grouped by email.

## Consequences

- One person's signals collect on one page without verifying anyone, and no one can claim another person's link.
- A person on two devices, or who loses their link, ends up with more than one link; that stays acceptable until option 2 is affordable.
- Schema: a tracking token is no longer unique per signal. Signals reference a tracking link; the token is unique per link.
- Shared devices are a risk: the next person on that browser would file onto the previous person's link. The submit flow shows which link it will use and makes starting a new one one click.
- A replayed `submit_signal` (same `idempotencyKey`, email, title, and body) returns the link's URL, which now shows every signal on that link, not just one. Keys are random per submission, so this stays low risk.
- Moving to option 2 later stays open: verified email can merge links the person proves they hold.
