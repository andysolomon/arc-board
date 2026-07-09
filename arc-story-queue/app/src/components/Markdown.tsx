import { Fragment, type ReactNode } from "react";

/**
 * Dependency-free, XSS-safe Markdown renderer.
 *
 * Delegation-contract values (notably the Outcome, which mirrors a story's
 * description) arrive as authored Markdown — headings, bold, inline code, and
 * lists. Rendered as a plain text node those markers print literally and the
 * surrounding whitespace collapses into one run-on line. This component parses
 * the common block/inline constructs into React elements so the drawer shows
 * formatted prose instead of raw syntax. It intentionally returns real nodes
 * (never `dangerouslySetInnerHTML`), so no HTML in the source is ever executed.
 */

const INLINE = /(\*\*([^*]+?)\*\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)\s]+?)\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{match[2]}</strong>);
    } else if (match[3]) {
      nodes.push(
        <code key={`${keyPrefix}-${i++}`} className="sq-md-code">
          {match[4]}
        </code>,
      );
    } else if (match[5]) {
      nodes.push(
        <a key={`${keyPrefix}-${i++}`} href={match[7]} target="_blank" rel="noreferrer">
          {match[6]}
        </a>,
      );
    }
    last = INLINE.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^\s*([-*]|\d+[.)])\s+(.*)$/;

function parseBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      blocks.push(
        <div key={key++} className={`sq-md-h sq-md-h${level}`}>
          {renderInline(heading[2].trim(), `h${key}`)}
        </div>,
      );
      i += 1;
      continue;
    }

    const listMatch = LIST_ITEM.exec(line);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]);
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i]);
        if (!item) break;
        items.push(<li key={items.length}>{renderInline(item[2].trim(), `li${key}-${items.length}`)}</li>);
        i += 1;
      }
      blocks.push(
        ordered ? (
          <ol key={key++} className="sq-md-list">
            {items}
          </ol>
        ) : (
          <ul key={key++} className="sq-md-list">
            {items}
          </ul>
        ),
      );
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-heading, non-list lines.
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i];
      if (current.trim() === "" || HEADING.test(current) || LIST_ITEM.test(current)) break;
      paragraph.push(current.trim());
      i += 1;
    }
    blocks.push(
      <p key={key++} className="sq-md-p">
        {renderInline(paragraph.join(" "), `p${key}`)}
      </p>,
    );
  }

  return blocks;
}

interface MarkdownProps {
  text: string;
  className?: string;
}

export function Markdown({ text, className }: MarkdownProps) {
  const cls = className ? `sq-md ${className}` : "sq-md";
  return <div className={cls}>{parseBlocks(text ?? "").map((block, i) => <Fragment key={i}>{block}</Fragment>)}</div>;
}
