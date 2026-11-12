// Small repairs to MusicXML before alphaTab reads it.

/**
 * A tab staff that lists its string tunings but not its number of lines: alphaTab assumes the default 5 lines and
 * drops the 6th string, then places every note by string/fret on the wrong string (seen in files from
 * guitarnotation.com). Other readers count the <staff-tuning> entries; do the same by adding <staff-lines>.
 */
export function addMissingStaffLines(xml: string): string {
  return xml.replace(/<staff-details(\s[^>]*)?>([\s\S]*?)<\/staff-details>/g, (block, attrs: string | undefined, body: string) => {
    if (/<staff-lines>/.test(body)) return block;
    const lines = [...body.matchAll(/<staff-tuning[^>]*\bline="(\d+)"/g)].map((m) => Number(m[1]));
    if (lines.length === 0) return block;
    const count = Math.max(...lines);
    if (count === 5) return block;
    // schema order: staff-type?, staff-lines?, line-detail*, staff-tuning*, …
    const typed = /^(\s*<staff-type>[^<]*<\/staff-type>)/.exec(body);
    const head = typed ? typed[1] : '';
    return `<staff-details${attrs ?? ''}>${head}<staff-lines>${count}</staff-lines>${body.slice(head.length)}</staff-details>`;
  });
}

/** All MusicXML repairs, in order. */
export function fixMusicXml(xml: string): string {
  return addMissingStaffLines(xml);
}
