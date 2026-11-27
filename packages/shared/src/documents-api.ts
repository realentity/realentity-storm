/** A document name: lowercase letters, digits, ".", "_" and "-", e.g. "cv-main". */
export const DOCUMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface DocumentView {
  documentId: string;
  name: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  dateCreated: string;
}
