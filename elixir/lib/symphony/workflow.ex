defmodule Symphony.Workflow do
  @moduledoc """
  Parses WORKFLOW.md files: YAML front matter between `---` markers + Markdown body (Liquid template).
  """

  defstruct [:config, :template, :source_path]

  @type t :: %__MODULE__{
          config: map(),
          template: String.t(),
          source_path: String.t() | nil
        }

  @doc "Parse a WORKFLOW.md file from disk."
  def parse_file(path) do
    case File.read(path) do
      {:ok, content} ->
        case parse(content) do
          {:ok, workflow} -> {:ok, %{workflow | source_path: path}}
          error -> error
        end

      {:error, reason} ->
        {:error, {:file_error, reason, path}}
    end
  end

  @doc "Parse WORKFLOW.md content string."
  def parse(content) when is_binary(content) do
    case split_front_matter(content) do
      {:ok, yaml_str, template} ->
        case YamlElixir.read_from_string(yaml_str) do
          {:ok, config} ->
            {:ok, %__MODULE__{config: config, template: String.trim(template)}}

          {:error, reason} ->
            {:error, {:yaml_error, reason}}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp split_front_matter(content) do
    case String.split(content, ~r/^---\s*$/m, parts: 3) do
      [_before, yaml, body] ->
        {:ok, yaml, body}

      _ ->
        {:error, :no_front_matter}
    end
  end
end
