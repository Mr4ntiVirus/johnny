// Mental-model documents are short markdown with `## ` sections. Sections are the
// unit of matching and priming: a prompt is compared against the section that
// answers it, and only that section is injected.

export function splitSections(content: string): string[] {
  return content.split(/\n(?=##\s)/).map(s => s.trim()).filter(Boolean);
}

/** Text embedded for a section: heading + body, cleaned elsewhere (see embedChunkText). */
export const sectionTitle = (section: string): string => (section.match(/^##\s+(.+)$/m)?.[1] ?? '').trim();
