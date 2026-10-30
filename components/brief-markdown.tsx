import { cn } from "cn";

// Brief markdown ------------------------------------------------------------------------------

type BriefBlock =
  | { level: number; text: string; type: "heading" }
  | { items: string[]; type: "list" }
  | { text: string; type: "paragraph" };

/** Headings, bullet lists, and paragraphs: all the brief's markdown uses. */
const briefBlocks = (markdown: string): BriefBlock[] => {
  const blocks: BriefBlock[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const last = blocks.at(-1);
    const heading = /^(?<hashes>#{1,6})\s+(?<text>.*)$/u.exec(trimmed)?.groups;
    const item = /^[-*]\s+(?<text>.*)$/u.exec(trimmed)?.groups;
    if (!trimmed) {
      blocks.push({ text: "", type: "paragraph" });
    } else if (heading) {
      blocks.push({
        level: heading.hashes?.length ?? 1,
        text: heading.text ?? "",
        type: "heading",
      });
    } else if (item) {
      if (last?.type === "list") last.items.push(item.text ?? "");
      else blocks.push({ items: [item.text ?? ""], type: "list" });
    } else if (last?.type === "paragraph" && last.text) {
      last.text = `${last.text} ${trimmed}`;
    } else {
      blocks.push({ text: trimmed, type: "paragraph" });
    }
  }
  return blocks.filter((block) => block.type !== "paragraph" || block.text);
};

/** Bold (`**x**`) and code (`` `x` ``) spans; everything else is text. */
const inlineSegments = (text: string) => {
  const segments: { kind: "code" | "strong" | "text"; text: string }[] = [];
  let rest = text;
  while (rest) {
    const match = /\*\*(?<strong>.+?)\*\*|`(?<code>[^`]+)`/u.exec(rest);
    if (!match) {
      segments.push({ kind: "text", text: rest });
      break;
    }
    if (match.index > 0) segments.push({ kind: "text", text: rest.slice(0, match.index) });
    const { code, strong } = match.groups ?? {};
    segments.push(
      strong === undefined ? { kind: "code", text: code ?? "" } : { kind: "strong", text: strong },
    );
    rest = rest.slice(match.index + match[0].length);
  }
  return segments;
};

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineSegments(text).map((segment, index) => {
        const key = `${index}-${segment.kind}`;
        if (segment.kind === "strong")
          return (
            <strong className="font-semibold" key={key}>
              {segment.text}
            </strong>
          );
        if (segment.kind === "code")
          return (
            <code className="font-mono text-[12px]" key={key}>
              {segment.text}
            </code>
          );
        return <span key={key}>{segment.text}</span>;
      })}
    </>
  );
}

/** The decision brief's markdown (headings, lists, paragraphs, bold, code) as plain text. */
export function BriefMarkdown({ className, markdown }: { className?: string; markdown: string }) {
  return (
    <div className={cn("flex flex-col gap-2 text-[14px] leading-relaxed break-words", className)}>
      {briefBlocks(markdown).map((block, index) => {
        const key = `${index}-${block.type}`;
        if (block.type === "heading")
          return block.level === 1 ? null : (
            <h4 className="mt-2 text-[11px] font-semibold tracking-[0.08em] uppercase" key={key}>
              <Inline text={block.text} />
            </h4>
          );
        if (block.type === "list")
          return (
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5" key={key}>
              {block.items.map((item, itemIndex) => (
                // oxlint-disable-next-line react/no-array-index-key
                <li key={itemIndex}>
                  <Inline text={item} />
                </li>
              ))}
            </ul>
          );
        return (
          <p className="m-0" key={key}>
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}
