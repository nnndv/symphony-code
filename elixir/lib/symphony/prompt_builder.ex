defmodule Symphony.PromptBuilder do
  @moduledoc """
  Renders Liquid (Solid) templates with issue fields as context.
  """

  @doc "Render a Liquid template string with issue context."
  def render(template, issue) do
    context = build_context(issue)

    with {:ok, parsed} <- Solid.parse(template),
         {:ok, iodata} <- Solid.render(parsed, context) do
      {:ok, IO.iodata_to_binary(iodata)}
    else
      {:error, reason} -> {:error, {:template_error, reason}}
      {:error, errors, _} -> {:error, {:template_error, errors}}
    end
  end

  defp build_context(issue) do
    %{
      "identifier" => Symphony.GitHub.Issue.identifier(issue),
      "number" => issue.number,
      "title" => issue.title || "",
      "description" => issue.body || "",
      "body" => issue.body || "",
      "state" => issue.state || "",
      "labels" => issue.labels || [],
      "assignees" => issue.assignees || [],
      "url" => issue.url || "",
      "priority" => to_string(issue.priority),
      "blockers" => Enum.map(issue.blockers, &to_string/1),
      "repo" => Symphony.Config.tracker_repo() || ""
    }
  end
end
