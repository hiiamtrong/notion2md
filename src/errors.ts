export class CliError extends Error {
  code: string;
  hint: string | undefined;
  exit: number;

  constructor(code: string, message: string, hint?: string, exit = 1) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.exit = exit;
  }
}
