defmodule Symphony.LogFile do
  @moduledoc "Structured JSON logging to file."
  require Logger

  @doc "Log a structured event to the Symphony log file."
  def log(event, data \\ %{}) do
    entry = %{
      timestamp: DateTime.utc_now() |> DateTime.to_iso8601(),
      event: event,
      data: data
    }

    line = Jason.encode!(entry)

    case log_path() do
      nil ->
        Logger.debug("[LogFile] #{line}")

      path ->
        File.write(path, line <> "\n", [:append, :utf8])
    end
  end

  defp log_path do
    Application.get_env(:symphony, :log_file)
  end
end
