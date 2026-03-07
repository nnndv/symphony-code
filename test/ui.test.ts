import { test, expect } from "bun:test"
import { ui } from "../src/ui.js"

test("ui exports the expected functions", () => {
  expect(typeof ui.intro).toBe("function")
  expect(typeof ui.outro).toBe("function")
  expect(typeof ui.cancel).toBe("function")
  expect(typeof ui.info).toBe("function")
  expect(typeof ui.success).toBe("function")
  expect(typeof ui.warn).toBe("function")
  expect(typeof ui.error).toBe("function")
  expect(typeof ui.spinner).toBe("function")
})
