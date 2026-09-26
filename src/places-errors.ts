export type PlacesOperationErrorCode =
  | "STALE_ACTION"
  | "INVALID_ACTION"
  | "DUPLICATE_CATEGORY"
  | "DUPLICATE_PLACE";

// Expected domain failures only; unexpected storage errors remain sanitized by the service.
export class PlacesOperationError extends Error {
  constructor(readonly code: PlacesOperationErrorCode, message: string) {
    super(message);
    this.name = "PlacesOperationError";
  }
}
