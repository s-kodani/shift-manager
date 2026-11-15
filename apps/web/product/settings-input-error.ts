/** A validation failure with a deliberately user-facing explanation. */
export class SettingsInputError extends Error {
  constructor(code: string, readonly explanation: string) {
    super(code);
  }
}
