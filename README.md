# coc-kotlin-lsp

`coc.nvim` extension for [Kotlin Language Server (kotlin-lsp)](https://github.com/Kotlin/kotlin-lsp).

## Requirements

- Neovim/Vim with `coc.nvim`
- `coc.nvim` version `>= 0.0.78`
- Node.js 18+
- Java 17+ (the extension warns if Java is missing or too old)
- `unzip` available in your shell (used by the downloader)

## Install Behavior

When you run `npm install` in this extension:

- it downloads a pinned standalone Kotlin LSP release (`262.2310.0`) for your OS/arch
- it verifies the SHA-256 checksum
- it extracts the server into `server/kotlin-lsp`

Supported by the bundled downloader in v1:

- macOS: `x64`, `arm64`
- Linux: `x64`, `arm64`

## Local Install in coc.nvim

Use local npm install into coc.nvim's extension directory (recommended for coc extensions).

1. `cd /Users/minhchu/codes/coc-nvim-kotlin-lsp`
2. `npm install`
3. `npm run build`
4. In Vim/Neovim, get coc data dir:
   - `:echo coc#util#get_data_home()`
5. In shell, install this extension from local path (replace `$COC_DATA_HOME` with step 4 output):
   - `mkdir -p "$COC_DATA_HOME/extensions"`
   - `cd "$COC_DATA_HOME/extensions"`
   - `npm install /Users/minhchu/codes/coc-nvim-kotlin-lsp`
6. Restart Vim/Neovim, run `:CocRestart`, then open a `.kt` file.
7. Verify extension is loaded:
   - `:CocList extensions`
   - `:CocCommand workspace.showOutput extensions`

If you previously added `runtimepath` for this project, remove it to avoid confusion.

## Configuration

Available settings in `coc-settings.json`:

- `kotlin-lsp.enable` (default: `true`)
- `kotlin-lsp.command` (default: `null`, use bundled server when null)
- `kotlin-lsp.args` (default: `["--stdio"]`)
- `kotlin-lsp.trace.server` (default: `"off"`, options: `"off" | "messages" | "verbose"`)
- `kotlin-lsp.java.check` (default: `true`)

Optional command override example:

```json
{
  "kotlin-lsp.command": "/absolute/path/to/kotlin-lsp",
  "kotlin-lsp.args": [
    "--stdio"
  ]
}
```
