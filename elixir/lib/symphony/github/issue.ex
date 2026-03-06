defmodule Symphony.GitHub.Issue do
  @moduledoc "Struct representing a GitHub issue."

  defstruct [
    :number,
    :title,
    :body,
    :state,
    :labels,
    :assignees,
    :url,
    :created_at,
    :updated_at,
    priority: :p3,
    blockers: []
  ]

  @type t :: %__MODULE__{
          number: integer(),
          title: String.t(),
          body: String.t(),
          state: String.t(),
          labels: [String.t()],
          assignees: [String.t()],
          url: String.t(),
          created_at: String.t(),
          updated_at: String.t(),
          priority: :p1 | :p2 | :p3 | :p4,
          blockers: [integer()]
        }

  @doc "Build an Issue from a `gh` JSON map."
  def from_gh(map) when is_map(map) do
    labels = Enum.map(map["labels"] || [], & &1["name"])
    assignees = Enum.map(map["assignees"] || [], & &1["login"])

    %__MODULE__{
      number: map["number"],
      title: map["title"],
      body: map["body"] || "",
      state: map["state"],
      labels: labels,
      assignees: assignees,
      url: map["url"] || map["html_url"] || "",
      created_at: map["createdAt"] || map["created_at"] || "",
      updated_at: map["updatedAt"] || map["updated_at"] || "",
      priority: parse_priority(labels),
      blockers: parse_blockers(map["body"] || "")
    }
  end

  @doc "Unique identifier string for this issue."
  def identifier(%__MODULE__{number: n}), do: to_string(n)

  defp parse_priority(labels) do
    cond do
      "P1" in labels or "priority:critical" in labels -> :p1
      "P2" in labels or "priority:high" in labels -> :p2
      "P3" in labels or "priority:medium" in labels -> :p3
      "P4" in labels or "priority:low" in labels -> :p4
      true -> :p3
    end
  end

  defp parse_blockers(body) do
    Regex.scan(~r/blocked\s+by\s+#(\d+)/i, body)
    |> Enum.map(fn [_, num] -> String.to_integer(num) end)
  end
end
