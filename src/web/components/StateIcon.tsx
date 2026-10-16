// Small glyphs that carry a state next to its word, so a chart or a strip never
// relies on color alone: a cross for blocked or failed, pause for waiting on a
// person, play for running, a clock for the employee's checklist, a check for
// done or ready, an empty circle for not started, and an exclamation mark for
// overdue or the last round. Drawn in currentColor (text ink), decorative: the
// word beside them is what assistive technology reads.
export type StateGlyph = "cross" | "pause" | "play" | "clock" | "check" | "circle" | "alert";

export function StateIcon({ glyph, size = 12 }: { glyph: StateGlyph; size?: number }) {
  return (
    <svg className="state-icon" width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {glyph === "cross" ? <path d="M3 3l6 6M9 3l-6 6" /> : null}
      {glyph === "pause" ? <path d="M4.25 2.5v7M7.75 2.5v7" /> : null}
      {glyph === "play" ? <path d="M3.5 2.5l6 3.5-6 3.5z" fill="currentColor" /> : null}
      {glyph === "clock" ? (
        <>
          <circle cx="6" cy="6" r="4.5" />
          <path d="M6 3.5V6l1.75 1.25" />
        </>
      ) : null}
      {glyph === "check" ? <path d="M2.5 6.25l2.5 2.5 4.5-5" /> : null}
      {glyph === "circle" ? <circle cx="6" cy="6" r="4" strokeDasharray="2 1.6" /> : null}
      {glyph === "alert" ? (
        <>
          <path d="M6 2.25v4.5" />
          <circle cx="6" cy="9.25" r="0.6" fill="currentColor" />
        </>
      ) : null}
    </svg>
  );
}
