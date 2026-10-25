import { describe, expect, it } from "vitest";
import {
  appendFootnoteDefinition,
  findHighlightSpans,
  getFootnoteDefinition,
  insertFootnoteRef,
  lineOfOffset,
  locateSpan,
  matchMarkToSpan,
  nextFootnoteLabel,
  removeFootnoteDefinition,
  removeHighlightSpan,
  replaceFootnoteDefinition,
  sectionRange,
  setSpanNote,
} from "./highlights";

describe("findHighlightSpans", () => {
  it("finds a single highlight with its offsets and inner text", () => {
    const raw = "Some ==marked text== here.";
    const [span] = findHighlightSpans(raw);
    expect(span.inner).toBe("marked text");
    expect(raw.slice(span.start, span.end)).toBe("==marked text==");
    expect(span.footnoteLabel).toBeNull();
    expect(span.refEnd).toBe(span.end);
  });

  it("finds several highlights on one line and across lines", () => {
    const raw = "==a== and ==b==\nthen ==c==";
    expect(findHighlightSpans(raw).map((s) => s.inner)).toEqual(["a", "b", "c"]);
  });

  it("attaches a directly following plugin footnote ref", () => {
    const raw = "x ==quote==[^hl4] y";
    const [span] = findHighlightSpans(raw);
    expect(span.footnoteLabel).toBe("hl4");
    expect(raw.slice(span.start, span.refEnd)).toBe("==quote==[^hl4]");
  });

  it("does not claim user footnotes", () => {
    const [span] = findHighlightSpans("==quote==[^1]");
    expect(span.footnoteLabel).toBeNull();
    expect(span.refEnd).toBe(span.end);
  });

  it("skips highlights inside inline code", () => {
    expect(findHighlightSpans("`==not==` but ==yes==").map((s) => s.inner)).toEqual([
      "yes",
    ]);
  });

  it("skips highlights inside fenced code blocks", () => {
    const raw = "```\n==not==\n```\n==yes==\n~~~js\n==nope==\n~~~";
    expect(findHighlightSpans(raw).map((s) => s.inner)).toEqual(["yes"]);
  });

  it("skips highlights inside frontmatter", () => {
    const raw = "---\ntitle: ==no==\n---\n==yes==";
    expect(findHighlightSpans(raw).map((s) => s.inner)).toEqual(["yes"]);
  });
});

describe("nextFootnoteLabel", () => {
  it("starts at hl1", () => {
    expect(nextFootnoteLabel("no notes")).toBe("hl1");
  });

  it("uses one more than the highest existing label", () => {
    expect(nextFootnoteLabel("a[^hl2] b[^hl7] [^3]")).toBe("hl8");
  });
});

describe("insertFootnoteRef", () => {
  it("puts the ref after the closing ==", () => {
    expect(insertFootnoteRef("==foo==", "hl1")).toBe("==foo==[^hl1]");
  });

  it("puts the ref after the last line of a multi-paragraph highlight", () => {
    expect(insertFootnoteRef("==a==\n\n- ==b==", "hl2")).toBe("==a==\n\n- ==b==[^hl2]");
  });
});

describe("appendFootnoteDefinition", () => {
  it("adds a blank line then the definition", () => {
    expect(appendFootnoteDefinition("Body\n", "hl1", "note")).toBe(
      "Body\n\n[^hl1]: note\n"
    );
  });

  it("handles a file without a trailing newline", () => {
    expect(appendFootnoteDefinition("Body", "hl1", "note")).toBe(
      "Body\n\n[^hl1]: note\n"
    );
  });

  it("joins an existing trailing footnote block", () => {
    expect(appendFootnoteDefinition("Body\n\n[^1]: theirs\n", "hl1", "mine")).toBe(
      "Body\n\n[^1]: theirs\n[^hl1]: mine\n"
    );
  });

  it("indents continuation lines of a multi-line note", () => {
    expect(appendFootnoteDefinition("Body\n", "hl1", "one\ntwo")).toBe(
      "Body\n\n[^hl1]: one\n    two\n"
    );
  });
});

describe("getFootnoteDefinition", () => {
  it("returns the note text with continuation indent removed", () => {
    const raw = "Body\n\n[^hl1]: one\n    two\n[^hl2]: other\n";
    expect(getFootnoteDefinition(raw, "hl1")).toBe("one\ntwo");
    expect(getFootnoteDefinition(raw, "hl2")).toBe("other");
  });

  it("returns null when the label has no definition", () => {
    expect(getFootnoteDefinition("Body", "hl1")).toBeNull();
  });
});

describe("replaceFootnoteDefinition", () => {
  it("swaps the note text and keeps the rest", () => {
    const raw = "Body\n\n[^hl1]: old\n    lines\n[^hl2]: keep\n";
    expect(replaceFootnoteDefinition(raw, "hl1", "new")).toBe(
      "Body\n\n[^hl1]: new\n[^hl2]: keep\n"
    );
  });
});

describe("removeFootnoteDefinition", () => {
  it("round-trips with appendFootnoteDefinition", () => {
    const raw = "Body\n";
    const added = appendFootnoteDefinition(raw, "hl1", "note\nmore");
    expect(removeFootnoteDefinition(added, "hl1")).toBe(raw);
  });

  it("leaves other footnotes alone", () => {
    const raw = "Body\n\n[^1]: theirs\n[^hl1]: mine\n";
    expect(removeFootnoteDefinition(raw, "hl1")).toBe("Body\n\n[^1]: theirs\n");
  });

  it("removes a definition in the middle of the block", () => {
    const raw = "Body\n\n[^hl1]: a\n[^hl2]: b\n";
    expect(removeFootnoteDefinition(raw, "hl1")).toBe("Body\n\n[^hl2]: b\n");
  });
});

describe("removeHighlightSpan", () => {
  it("unwraps a plain highlight", () => {
    const raw = "x ==foo== y";
    const [span] = findHighlightSpans(raw);
    expect(removeHighlightSpan(raw, span)).toBe("x foo y");
  });

  it("removes the ref and the definition of a noted highlight", () => {
    const raw = "x ==foo==[^hl1] y\n\n[^1]: theirs\n[^hl1]: note\n";
    const [span] = findHighlightSpans(raw);
    expect(removeHighlightSpan(raw, span)).toBe("x foo y\n\n[^1]: theirs\n");
  });
});

describe("locateSpan", () => {
  it("uses the recorded position when it still matches", () => {
    expect(locateSpan("ab ==x== ==x==", { start: 9, text: "==x==" })).toBe(9);
  });

  it("falls back to a unique match when the position drifted", () => {
    expect(locateSpan("new text ==x==", { start: 2, text: "==x==" })).toBe(9);
  });

  it("gives up when the text is gone or ambiguous", () => {
    expect(locateSpan("nothing", { start: 0, text: "==x==" })).toBeNull();
    expect(locateSpan("==x== ==x==", { start: 3, text: "==x==" })).toBeNull();
  });
});

describe("lineOfOffset", () => {
  it("returns the zero-based line of an offset", () => {
    expect(lineOfOffset("a\nb\nc", 0)).toBe(0);
    expect(lineOfOffset("a\nb\nc", 4)).toBe(2);
  });
});

describe("matchMarkToSpan", () => {
  const raw = "==same== text ==same==\n\n==other== ==same==";
  const spans = findHighlightSpans(raw);
  const render = (inner: string) => inner;

  it("picks the n-th highlight inside the tapped block", () => {
    const window = { start: 0, end: 22 };
    const second = matchMarkToSpan(spans, { text: "same", indexInBlock: 1, window }, render);
    expect(second?.start).toBe(14);
  });

  it("falls back to the only text match in the block when the index is off", () => {
    const window = { start: 24, end: raw.length };
    const span = matchMarkToSpan(spans, { text: "other", indexInBlock: 5, window }, render);
    expect(span?.inner).toBe("other");
  });

  it("falls back to a unique match in the whole file without a block", () => {
    const span = matchMarkToSpan(spans, { text: "other", indexInBlock: 0, window: null }, render);
    expect(span?.start).toBe(24);
  });

  it("returns null when the text is ambiguous and the block does not help", () => {
    expect(
      matchMarkToSpan(spans, { text: "same", indexInBlock: 0, window: null }, render)
    ).toBeNull();
  });

  it("compares rendered text, ignoring whitespace differences", () => {
    const md = findHighlightSpans("==**bold**  word==");
    const strip = (inner: string) => inner.replace(/\*/g, "");
    const span = matchMarkToSpan(md, { text: "bold word", indexInBlock: 0, window: null }, strip);
    expect(span?.inner).toBe("**bold**  word");
  });
});

describe("setSpanNote", () => {
  it("adds a ref and a definition to a highlight without a note", () => {
    const raw = "x ==foo== y\n";
    const [span] = findHighlightSpans(raw);
    expect(setSpanNote(raw, span, "why")).toBe("x ==foo==[^hl1] y\n\n[^hl1]: why\n");
  });

  it("numbers the new note after existing plugin notes", () => {
    const raw = "==a==[^hl2] ==b==\n\n[^hl2]: first\n";
    const span = findHighlightSpans(raw)[1];
    expect(setSpanNote(raw, span, "second")).toBe(
      "==a==[^hl2] ==b==[^hl3]\n\n[^hl2]: first\n[^hl3]: second\n"
    );
  });

  it("replaces the text of an existing note", () => {
    const raw = "==foo==[^hl1]\n\n[^hl1]: old\n";
    const [span] = findHighlightSpans(raw);
    expect(setSpanNote(raw, span, "new")).toBe("==foo==[^hl1]\n\n[^hl1]: new\n");
  });

  it("removes the note but keeps the highlight when given empty text", () => {
    const raw = "==foo==[^hl1] bar\n\n[^hl1]: old\n";
    const [span] = findHighlightSpans(raw);
    expect(setSpanNote(raw, span, "")).toBe("==foo== bar\n");
  });

  it("does nothing for empty text on a highlight without a note", () => {
    const raw = "==foo==\n";
    const [span] = findHighlightSpans(raw);
    expect(setSpanNote(raw, span, "  ")).toBe(raw);
  });
});

describe("sectionRange", () => {
  const raw = "# Title\n\nPara one.\n\n- a\n- b\n";
  // Reading view sections: header (0 lines), h1 (2), p (2), list (3)
  const counts = [0, 2, 2, 3];

  it("maps a section to the source offsets of its lines", () => {
    const range = sectionRange(raw, counts, 2);
    expect(range && raw.slice(range.start, range.end)).toBe("Para one.\n\n");
  });

  it("runs the last section to the end of the file", () => {
    const range = sectionRange(raw, counts, 3);
    expect(range && raw.slice(range.start, range.end)).toBe("- a\n- b\n");
  });

  it("returns null for an empty section or a bad index", () => {
    expect(sectionRange(raw, counts, 0)).toBeNull();
    expect(sectionRange(raw, counts, 9)).toBeNull();
  });
});
