import * as clack from "@clack/prompts"

export const ui = {
  intro:   () => clack.intro("Welcome to Symphony."),
  outro:   (msg: string) => clack.outro(msg),
  cancel:  (msg: string) => clack.cancel(msg),
  info:    (msg: string) => clack.log.info(msg),
  success: (msg: string) => clack.log.success(msg),
  warn:    (msg: string) => clack.log.warn(msg),
  error:   (msg: string) => clack.log.error(msg),
  spinner: () => clack.spinner(),
  note: (msg: string, title?: string) => clack.note(msg, title),
}
