# coc-kotlin-lsp

`coc.nvim` extension for [Kotlin Language Server (kotlin-lsp)](https://github.com/Kotlin/kotlin-lsp).

## Requirements

- Neovim/Vim with `coc.nvim`
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

1. `cd /Users/minhchu/codes/coc-nvim-kotlin-lsp`
2. `npm install`
3. `npm run build`
4. Add this to your vim config:
   - `set runtimepath^=/Users/minhchu/codes/coc-nvim-kotlin-lsp`
5. Restart Vim/Neovim and open a `.kt` file.

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

