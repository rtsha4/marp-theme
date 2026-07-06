import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const marpBin = join(rootDir, 'node_modules/.bin/marp')
const themePath = join(rootDir, 'themes/azulite.css')

// Force marp:true + theme:azulite regardless of what the picked file declares,
// since the whole point of this tool is previewing content against this theme.
function withAzuliteFrontmatter(markdown) {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const fmLines = fm ? fm[1].split(/\r?\n/) : []
  // A `---`/`---` pair only counts as real frontmatter if every line inside
  // looks like `key: value` — otherwise it's just a markdown horizontal rule
  // that happens to appear twice near the top of the file.
  const looksLikeYaml = fm && fmLines.every((line) => line.trim() === '' || /^[\w.-]+\s*:/.test(line))

  if (looksLikeYaml) {
    const rest = fmLines.filter((line) => !/^\s*(marp|theme)\s*:/i.test(line)).join('\n')
    return `---\nmarp: true\ntheme: azulite\n${rest}\n---\n${markdown.slice(fm[0].length)}`
  }
  return `---\nmarp: true\ntheme: azulite\n---\n\n${markdown}`
}

const RENDER_TIMEOUT_MS = 15_000
const MAX_MARKDOWN_SIZE = 5 * 1024 * 1024

async function renderMarkdown(markdown) {
  const dir = await mkdtemp(join(tmpdir(), 'azulite-preview-'))
  const inputPath = join(dir, 'slide.md')
  const outputPath = join(dir, 'slide.html')

  try {
    await writeFile(inputPath, withAzuliteFrontmatter(markdown), 'utf-8')

    const proc = Bun.spawn(
      [marpBin, '--theme-set', themePath, '--html', '--allow-local-files', inputPath, '-o', outputPath],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    const timeout = setTimeout(() => proc.kill(), RENDER_TIMEOUT_MS)
    const exitCode = await proc.exited
    clearTimeout(timeout)

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const reason = exitCode === null ? 'timed out' : stderr.trim() || `exited with code ${exitCode}`
      throw new Error(`marp render failed: ${reason}`)
    }

    return await readFile(outputPath, 'utf-8')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const PORT = 8181

const PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Azulite Preview</title>
<style>
  body { margin: 0; font-family: -apple-system, sans-serif; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 12px 16px; border-bottom: 1px solid #ddd; display: flex; gap: 12px; align-items: center; }
  #drop { flex: 1; display: flex; align-items: center; justify-content: center; color: #888; text-align: center; padding: 24px; }
  #drop.drag { background: #eef2ff; }
  iframe { flex: 1; width: 100%; border: 0; display: none; }
  #error { color: #dc2626; padding: 0 16px; white-space: pre-wrap; }
</style>
</head>
<body>
  <header>
    <input type="file" id="file" accept=".md,.markdown,text/markdown">
    <span id="filename"></span>
  </header>
  <div id="error"></div>
  <div id="drop">.md ファイルをドラッグ&ドロップ、または「ファイルを選択」で読み込んでください</div>
  <iframe id="frame" sandbox="allow-scripts" allow="fullscreen" allowfullscreen></iframe>
  <script>
    const fileInput = document.getElementById('file')
    const drop = document.getElementById('drop')
    const frame = document.getElementById('frame')
    const filenameEl = document.getElementById('filename')
    const errorEl = document.getElementById('error')
    const MAX_SIZE = 5 * 1024 * 1024

    async function renderFile(file) {
      errorEl.textContent = ''
      if (!/\\.(md|markdown)$/i.test(file.name)) {
        errorEl.textContent = '.md / .markdown ファイルを選んでください'
        return
      }
      if (file.size > MAX_SIZE) {
        errorEl.textContent = 'ファイルが大きすぎます(5MBまで)'
        return
      }
      filenameEl.textContent = file.name
      const text = await file.text()
      const res = await fetch('/render', { method: 'POST', body: text })
      if (!res.ok) {
        errorEl.textContent = await res.text()
        return
      }
      frame.srcdoc = await res.text()
      frame.style.display = 'block'
      drop.style.display = 'none'
      frame.focus()
    }

    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) renderFile(e.target.files[0])
    })

    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag') })
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'))
    drop.addEventListener('drop', (e) => {
      e.preventDefault()
      drop.classList.remove('drag')
      if (e.dataTransfer.files[0]) renderFile(e.dataTransfer.files[0])
    })
  </script>
</body>
</html>`

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/') {
      return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    if (url.pathname === '/render' && req.method === 'POST') {
      try {
        const markdown = await req.text()
        if (markdown.length > MAX_MARKDOWN_SIZE) {
          return new Response('ファイルが大きすぎます(5MBまで)', { status: 413 })
        }
        const html = await renderMarkdown(markdown)
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      } catch (err) {
        return new Response(`Render error: ${err.message}`, { status: 500 })
      }
    }

    return new Response('Not Found', { status: 404 })
  },
})

console.log(`Azulite preview server: http://localhost:${PORT}`)
