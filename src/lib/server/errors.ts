export class ApiError extends Error {
  /** `code` names a condition the client acts on (e.g. UPLOAD_MISSING) beyond the status. */
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
