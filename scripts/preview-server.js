import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { load as loadYaml, dump as dumpYaml, FAILSAFE_SCHEMA } from 'js-yaml'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const marpBin = join(rootDir, 'node_modules/.bin/marp')
const themePath = join(rootDir, 'themes/azulite.css')

// A `---`/`---` block only counts as real frontmatter if it actually parses
// as a YAML mapping — the same check marpit itself uses — so plain-text
// content between two horizontal rules isn't mistaken for frontmatter, while
// real-world YAML (e.g. Obsidian's `tags:` lists) is still recognized.
// `json: true` makes duplicate keys overwrite instead of throwing, matching
// how a lenient YAML consumer (and Obsidian itself) would read such a file.
function parseFrontmatter(text) {
  try {
    const obj = loadYaml(text, { schema: FAILSAFE_SCHEMA, json: true })
    return obj !== null && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch {
    return null
  }
}

// Force marp:true + theme:azulite regardless of what the picked file declares,
// since the whole point of this tool is previewing content against this theme.
// Editing the parsed object (rather than pattern-matching lines of text) means
// a `marp:`/`theme:`-looking line inside an unrelated block-scalar value can't
// be mistaken for the real directive and stripped by accident.
function withAzuliteFrontmatter(markdown) {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const parsed = fm && parseFrontmatter(fm[1])

  if (parsed) {
    delete parsed.marp
    delete parsed.theme
    // Drop keys with no value (e.g. Obsidian leaves `header:`/`tags:` empty)
    // instead of writing them back as `key: null` — marpit's directive
    // parser reads YAML with FAILSAFE_SCHEMA, which never treats the text
    // "null" as empty, so a directive like `header: null` would render the
    // literal word "null" on every slide instead of showing nothing.
    for (const key of Object.keys(parsed)) {
      if (parsed[key] === null) delete parsed[key]
    }
    const rest = Object.keys(parsed).length > 0 ? `${dumpYaml(parsed).trimEnd()}\n` : ''
    return `---\nmarp: true\ntheme: azulite\n${rest}---\n${markdown.slice(fm[0].length)}`
  }
  return `---\nmarp: true\ntheme: azulite\n---\n\n${markdown}`
}

const RENDER_TIMEOUT_MS = 15_000
const MAX_MARKDOWN_SIZE = 5 * 1024 * 1024
const MAX_TOTAL_UPLOAD_SIZE = 80 * 1024 * 1024

const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

// marp-cli's --html output keeps local <img src="..."> as plain relative
// paths (it assumes the .html file stays next to the original assets, as it
// would with `bun run build`). We serve the HTML text on its own and delete
// the temp folder right after, so those relative paths would otherwise point
// nowhere — inline each local image as a data URI while the folder still
// exists, so the returned HTML is fully self-contained.
//
// `baseDir` (the target file's own folder) is where relative paths resolve
// from, matching how a browser/marp would read `../attachments/x.png`.
// `uploadRootDir` (the whole reconstructed temp folder, which may be an
// ancestor of `baseDir`) is the traversal boundary — an Obsidian vault
// commonly keeps a single attachments folder at the vault root while notes
// live in nested subfolders, so "../" references legitimately climb back
// out of `baseDir` without ever leaving `uploadRootDir`.
async function inlineLocalImages(html, baseDir, uploadRootDir) {
  const srcs = new Set()
  for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
    if (!/^(?:[a-z]+:)/i.test(m[1])) srcs.add(m[1])
  }
  if (srcs.size === 0) return html

  const resolvedRoot = resolve(uploadRootDir) + sep
  const replacements = new Map()

  for (const src of srcs) {
    try {
      const filePath = resolve(baseDir, decodeURIComponent(src))
      if (!filePath.startsWith(resolvedRoot)) continue // reject path traversal
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
      const mime = IMAGE_MIME_TYPES[ext]
      if (!mime) continue
      const data = await readFile(filePath)
      replacements.set(src, `data:${mime};base64,${data.toString('base64')}`)
    } catch {
      // Leave unreadable/missing images as-is rather than failing the whole render.
    }
  }

  if (replacements.size === 0) return html
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (full, prefix, src, suffix) =>
    replacements.has(src) ? `${prefix}${replacements.get(src)}${suffix}` : full,
  )
}

async function runMarp(inputPath, outputPath, uploadRootDir) {
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

  const html = await readFile(outputPath, 'utf-8')
  return await inlineLocalImages(html, dirname(inputPath), uploadRootDir)
}

// A single .md with no folder context — the common case, and the only case
// where we can't resolve relative image paths (there's no folder to resolve
// them against), which is fine since there's nothing relative to break.
async function renderMarkdown(markdown) {
  const dir = await mkdtemp(join(tmpdir(), 'azulite-preview-'))
  const inputPath = join(dir, 'slide.md')
  const outputPath = join(dir, 'slide.html')

  try {
    await writeFile(inputPath, withAzuliteFrontmatter(markdown), 'utf-8')
    return await runMarp(inputPath, outputPath, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// A whole folder (e.g. an Obsidian vault, or just a note's own folder) plus a
// target .md within it. Reproducing the same relative layout in a temp dir
// lets marp-cli's --allow-local-files resolve relative image paths exactly
// as it would from the original folder, instead of a bare text upload that
// throws away which directory the note used to live in.
async function renderFolder(entries, targetPath) {
  const dir = await mkdtemp(join(tmpdir(), 'azulite-preview-'))
  const resolvedDir = resolve(dir) + sep

  try {
    for (const [relPath, content] of entries) {
      const fullPath = resolve(dir, relPath)
      if (!fullPath.startsWith(resolvedDir)) continue // reject path traversal
      await mkdir(dirname(fullPath), { recursive: true })
      await writeFile(fullPath, content)
    }

    const targetFull = resolve(dir, targetPath)
    if (!targetFull.startsWith(resolvedDir)) throw new Error('invalid target path')

    const original = await readFile(targetFull, 'utf-8')
    await writeFile(targetFull, withAzuliteFrontmatter(original), 'utf-8')

    const outputPath = join(dir, '__azulite_preview_output__.html')
    return await runMarp(targetFull, outputPath, dir)
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
  header { padding: 12px 16px; border-bottom: 1px solid #ddd; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header label { font-size: 13px; color: #555; display: flex; gap: 6px; align-items: center; }
  #drop { flex: 1; display: flex; align-items: center; justify-content: center; color: #888; text-align: center; padding: 24px; }
  #drop.drag { background: #eef2ff; }
  iframe { flex: 1; width: 100%; border: 0; display: none; }
  #error { color: #dc2626; padding: 0 16px; white-space: pre-wrap; }
  #pick-target { display: none; }
</style>
</head>
<body>
  <header>
    <label>.mdファイル単体<input type="file" id="file" accept=".md,.markdown,text/markdown"></label>
    <label>フォルダごと(画像がある場合)<input type="file" id="folder" webkitdirectory multiple></label>
    <select id="pick-target"></select>
    <span id="filename"></span>
  </header>
  <div id="error"></div>
  <div id="drop">.md ファイルをドラッグ&ドロップ、または上のボタンで読み込んでください</div>
  <iframe id="frame" sandbox="allow-scripts" allow="fullscreen" allowfullscreen></iframe>
  <script>
    const fileInput = document.getElementById('file')
    const folderInput = document.getElementById('folder')
    const pickTarget = document.getElementById('pick-target')
    const drop = document.getElementById('drop')
    const frame = document.getElementById('frame')
    const filenameEl = document.getElementById('filename')
    const errorEl = document.getElementById('error')
    const MAX_SIZE = 5 * 1024 * 1024
    const MAX_TOTAL_SIZE = 80 * 1024 * 1024

    function showResult(html, label) {
      filenameEl.textContent = label
      frame.srcdoc = html
      frame.style.display = 'block'
      drop.style.display = 'none'
      frame.focus()
    }

    async function renderSingleFile(file) {
      errorEl.textContent = ''
      if (!/\\.(md|markdown)$/i.test(file.name)) {
        errorEl.textContent = '.md / .markdown ファイルを選んでください'
        return
      }
      if (file.size > MAX_SIZE) {
        errorEl.textContent = 'ファイルが大きすぎます(5MBまで)'
        return
      }
      const text = await file.text()
      const res = await fetch('/render', { method: 'POST', body: text })
      if (!res.ok) {
        errorEl.textContent = await res.text()
        return
      }
      showResult(await res.text(), file.name)
    }

    async function renderFolderFiles(files, targetPath) {
      errorEl.textContent = ''
      const totalSize = files.reduce((sum, f) => sum + f.size, 0)
      if (totalSize > MAX_TOTAL_SIZE) {
        errorEl.textContent = 'フォルダが大きすぎます(80MBまで)'
        return
      }
      const formData = new FormData()
      formData.append('__target__', targetPath)
      for (const file of files) {
        formData.append(file.webkitRelativePath || file.name, file)
      }
      const res = await fetch('/render', { method: 'POST', body: formData })
      if (!res.ok) {
        errorEl.textContent = await res.text()
        return
      }
      showResult(await res.text(), targetPath)
    }

    fileInput.addEventListener('change', (e) => {
      if (e.target.files[0]) renderSingleFile(e.target.files[0])
    })

    folderInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files)
      const mdFiles = files.filter((f) => /\\.(md|markdown)$/i.test(f.name))
      if (mdFiles.length === 0) {
        errorEl.textContent = 'フォルダの中に.md / .markdownファイルが見つかりません'
        return
      }
      if (mdFiles.length === 1) {
        pickTarget.style.display = 'none'
        renderFolderFiles(files, mdFiles[0].webkitRelativePath)
        return
      }
      pickTarget.replaceChildren()
      for (const f of mdFiles) {
        const opt = document.createElement('option')
        opt.value = f.webkitRelativePath
        opt.textContent = f.webkitRelativePath
        pickTarget.appendChild(opt)
      }
      pickTarget.style.display = 'inline-block'
      pickTarget.onchange = () => renderFolderFiles(files, pickTarget.value)
      renderFolderFiles(files, mdFiles[0].webkitRelativePath)
    })

    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag') })
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'))
    drop.addEventListener('drop', (e) => {
      e.preventDefault()
      drop.classList.remove('drag')
      if (e.dataTransfer.files[0]) renderSingleFile(e.dataTransfer.files[0])
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
      const contentType = req.headers.get('content-type') || ''

      try {
        if (contentType.includes('multipart/form-data')) {
          const formData = await req.formData()
          const targetPath = formData.get('__target__')
          if (typeof targetPath !== 'string' || !targetPath) {
            return new Response('対象ファイルが指定されていません', { status: 400 })
          }

          const entries = []
          let totalSize = 0
          for (const [relPath, value] of formData.entries()) {
            if (relPath === '__target__' || !(value instanceof Blob)) continue
            totalSize += value.size
            if (totalSize > MAX_TOTAL_UPLOAD_SIZE) {
              return new Response('フォルダが大きすぎます(80MBまで)', { status: 413 })
            }
            entries.push([relPath, new Uint8Array(await value.arrayBuffer())])
          }

          const html = await renderFolder(entries, targetPath)
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        }

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
