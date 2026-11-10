# Pi Codex image generation

Adds one LLM-callable Pi tool, `image_generation`, backed by the locally installed Codex CLI and its native image-generation capability.

## Requirements

- Codex CLI 0.146.0 or newer on `PATH`
- A ChatGPT-backed Codex login (`codex login`)
- An active Codex model provider that reports image-generation support
- Linux with `/proc` descriptor paths, or Windows with WSL and Python 3, for race-resistant output confinement

No separate OpenAI API key is required.

## Tool

```json
{
  "prompt": "Add XYZ as a third centered row matching the existing white type",
  "outputPath": "logo2.png",
  "inputImages": ["logo.jpg"],
  "overwrite": false
}
```

- `prompt` is required and limited to 10,000 characters.
- `outputPath` is required, its parent directory must already exist inside Pi's current working directory, and it must use `.png`, `.jpg`/`.jpeg`, `.webp`, or `.gif` matching the format returned by Codex. Windows output paths must be relative and cannot contain reserved or ambiguous Windows path components.
- `inputImages` is optional and accepts up to four PNG, JPEG, WebP, or GIF files.
- `overwrite` defaults to `false`; symbolic-link outputs are never replaced.

The request is validated before network use. The result is saved atomically through a descriptor-anchored parent directory. Successful tool content is text only: generated/edited, saved path, MIME type, byte length, and completion status. Revised prompts and complete result metadata remain in `details`, not model-visible content.

Interactive TUI calls retain an immediate inline preview through the result renderer (when image display is enabled and the terminal supports it). Preview bytes are stored only in TUI result `details`, so they can be rendered again after session reload without rereading a changed file. Headless/print/JSON/RPC calls return the same text metadata without preview bytes. The preview does not give the model visual access: explicitly use `read` on the saved path when visual inspection is needed. Reading an image remains an intentional way to attach it to model context.

On Windows, a bundled Python helper runs locally under WSL and performs the same handle-relative validation and commit without receiving the prompt or any source image.

## Privacy and isolation

Use this tool only after an explicit user request authorizes that specific generation or edit. Send only the minimum necessary prompt and source images; never include secrets, credentials, unrelated files, or unrelated conversation context.

Each call sends the explicit prompt, static image-worker instructions, and any listed input images to OpenAI through the user's Codex login. The extension does not place Pi's conversation, system prompt, repository contents, output path, credential values, or unrelated files in model input or logs.

Every request runs with a fresh temporary working directory, isolated HOME/XDG/application-data roots, a clean temporary Codex home, and a fresh ephemeral Codex thread. The clean home bridges only the existing Codex authentication material; the extension does not parse or log token values and does not load the user's Codex configuration. Source images are bounded-read through no-follow file handles, checked for concurrent replacement, and embedded as image data, so the nested native tool receives the image without receiving its local path. The nested turn disables shell, unified execution, code mode, web search, browser/computer use, MCP servers, plugins, apps, multi-agent features, plan updates, and user interaction. Any unexpected turn item or server request fails the call. Temporary files and the app-server subprocess are cleaned up on success, failure, cancellation, and timeout.

Use `PI_CODEX_IMAGE_HOME` to select the Codex login source. Otherwise the extension uses `CODEX_HOME`, then `%USERPROFILE%/.codex` on Windows, or `~/.codex` elsewhere.

## Lifecycle

A separate `codex app-server --stdio` process is created per tool call. Calls time out after five minutes and honor Pi turn cancellation. Shutdown escalates from `SIGTERM` to `SIGKILL` if needed.
