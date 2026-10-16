// Links into other pages that more than one page builds.

/** An approval's card or row on /approvals: the page scrolls to it and focuses it. */
export function approvalAnchor(approvalId: string): string {
  return `/approvals#approval-${encodeURIComponent(approvalId)}`;
}
