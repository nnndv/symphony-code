import { test, expect } from "bun:test"

test("CLI displays server address on startup", async () => {
  const proc = Bun.spawn(
    ["bun", "run", "./src/cli.ts", "./WORKFLOW.md", "--no-tui"],
    {
      env: { ...process.env, ANTHROPIC_API_KEY: "test-key" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  const decoder = new TextDecoder()
  let output = ""
  const deadline = Date.now() + 8_000

  const reader = proc.stdout.getReader()
  while (Date.now() < deadline) {
    const readPromise = reader.read()
    const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), 500))
    const result = await Promise.race([readPromise, timeoutPromise])
    if (result === null) continue
    const { value, done } = result as ReadableStreamReadResult<Uint8Array>
    if (done) break
    output += decoder.decode(value)
    if (output.includes("http://localhost:")) break
  }

  proc.kill()

  expect(output).toContain("http://localhost:")
}, 10_000)
