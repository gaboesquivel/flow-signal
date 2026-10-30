import { cn } from "cn";

import { briefBlocks, inlineSegments } from "../../_lib/decide";

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
