import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("renders headings as styled heading blocks, not literal '#'", () => {
    const out = html("## Parent PRD");
    expect(out).toContain('class="sq-md-h sq-md-h2"');
    expect(out).toContain("Parent PRD");
    expect(out).not.toContain("## Parent");
  });

  it("renders bold and inline code as elements, not literal markers", () => {
    const out = html("Add **arc-contracts** as a `dependency`");
    expect(out).toContain("<strong>arc-contracts</strong>");
    expect(out).toContain('<code class="sq-md-code">dependency</code>');
    expect(out).not.toContain("**arc-contracts**");
    expect(out).not.toContain("`dependency`");
  });

  it("groups consecutive bullet lines into a single list", () => {
    const out = html("- one\n- two\n- three");
    expect(out).toContain('<ul class="sq-md-list">');
    expect((out.match(/<li>/g) ?? []).length).toBe(3);
  });

  it("groups numbered lines into an ordered list", () => {
    const out = html("1. first\n2. second");
    expect(out).toContain('<ol class="sq-md-list">');
    expect((out.match(/<li>/g) ?? []).length).toBe(2);
  });

  it("keeps separate paragraphs separated instead of one run-on line", () => {
    const out = html("First para.\n\nSecond para.");
    expect((out.match(/<p class="sq-md-p">/g) ?? []).length).toBe(2);
  });

  it("does not execute embedded HTML (XSS-safe)", () => {
    const out = html("<img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  it("renders links as anchors that open safely", () => {
    const out = html("See [the docs](https://example.com/x)");
    expect(out).toContain('href="https://example.com/x"');
    expect(out).toContain('rel="noreferrer"');
    expect(out).toContain("the docs");
  });

  it("applies a passed className to the wrapper", () => {
    const out = renderToStaticMarkup(<Markdown text="hi" className="sq-contract-row__value" />);
    expect(out).toContain('class="sq-md sq-contract-row__value"');
  });
});
