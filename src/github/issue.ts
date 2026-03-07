import { Schema } from "@effect/schema"

export const Priority = Schema.Literal("p1", "p2", "p3", "p4")
export type Priority = typeof Priority.Type

export interface Issue {
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  readonly labels: readonly string[]
  readonly assignees: readonly string[]
  readonly url: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly priority: Priority
  readonly blockers: readonly number[]
}

/** Parse a raw `gh` CLI JSON object into an Issue. */
export function fromGh(raw: Record<string, unknown>): Issue {
  const labels: string[] = Array.isArray(raw["labels"])
    ? (raw["labels"] as Array<Record<string, unknown>>).map((l) => String(l["name"] ?? ""))
    : []

  const assignees: string[] = Array.isArray(raw["assignees"])
    ? (raw["assignees"] as Array<Record<string, unknown>>).map((a) => String(a["login"] ?? ""))
    : []

  const body = String(raw["body"] ?? "")

  return {
    number: Number(raw["number"]),
    title: String(raw["title"] ?? ""),
    body,
    state: String(raw["state"] ?? ""),
    labels,
    assignees,
    url: String(raw["url"] ?? raw["html_url"] ?? ""),
    createdAt: String(raw["createdAt"] ?? raw["created_at"] ?? ""),
    updatedAt: String(raw["updatedAt"] ?? raw["updated_at"] ?? ""),
    priority: parsePriority(labels),
    blockers: parseBlockers(body),
  }
}

export function identifier(issue: Issue): string {
  return String(issue.number)
}

function parsePriority(labels: readonly string[]): Priority {
  if (labels.includes("P1") || labels.includes("priority:critical")) return "p1"
  if (labels.includes("P2") || labels.includes("priority:high")) return "p2"
  if (labels.includes("P3") || labels.includes("priority:medium")) return "p3"
  if (labels.includes("P4") || labels.includes("priority:low")) return "p4"
  return "p3"
}

function parseBlockers(body: string): number[] {
  const matches = body.matchAll(/blocked\s+by\s+#(\d+)/gi)
  return Array.from(matches, (m) => Number(m[1]))
}
