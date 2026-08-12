import fs from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'

for (const envFile of ['.env.local', '.env']) {
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '')
    }
  }
}

function getLatestMtime(dir) {
  let max = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      max = Math.max(max, getLatestMtime(fullPath))
    } else {
      max = Math.max(max, fs.statSync(fullPath).mtimeMs)
    }
  }
  return max
}

const outFile = path.join(process.cwd(), 'dist', 'assets', 'app.js')
const srcMtime = getLatestMtime(path.join(process.cwd(), 'src'))
const outMtime = fs.existsSync(outFile) ? fs.statSync(outFile).mtimeMs : 0

if (!fs.existsSync(outFile) || srcMtime > outMtime) {
  console.log('⚡ Building app with esbuild...')
  console.time('⚡ Build complete')

  fs.mkdirSync('dist/assets', { recursive: true })

  let esbuildBin = path.join(process.cwd(), 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild')
  if (!fs.existsSync(esbuildBin)) esbuildBin = path.join(process.cwd(), 'node_modules', '.bin', 'esbuild')

  execFileSync(esbuildBin, [
    'src/main.tsx',
    '--bundle',
    '--outfile=dist/assets/app.js',
    '--format=esm',
    '--jsx=automatic',
    '--loader:.css=empty',
    '--loader:.tsx=tsx',
    '--sourcemap',
    '--log-level=warning'
  ], { stdio: ['ignore', 'ignore', 'inherit'] })

  fs.copyFileSync('src/styles.css', 'dist/assets/app.css')
  fs.copyFileSync('src/favicon.svg', 'dist/favicon.svg')
  console.timeEnd('⚡ Build complete')
} else {
  console.log('⚡ App bundle up-to-date (cached)')
}

fs.copyFileSync('index.html', 'dist/index.html')
fs.copyFileSync('src/favicon.svg', 'dist/favicon.svg')
fs.appendFileSync('dist/index.html', '\n<link rel="stylesheet" href="/assets/app.css"><script>window.addEventListener("error",e=>{const r=document.getElementById("root");if(r&&!r.innerHTML)r.innerHTML=`<main style="padding:40px;font-family:system-ui;color:#7b3028"><h1>Insomnia FPL failed to start</h1><p>${e.message||"The app bundle could not load."}</p><p>Check the terminal and refresh after fixing the error.</p></main>`});window.addEventListener("unhandledrejection",e=>{const r=document.getElementById("root");if(r&&!r.innerHTML)r.innerHTML=`<main style="padding:40px;font-family:system-ui;color:#7b3028"><h1>Insomnia FPL failed to start</h1><p>${e.reason?.message||e.reason||"The app bundle rejected during startup."}</p></main>`})</script><script type="module" src="/assets/app.js"></script>\n')

console.log('🚀 Starting dev server...')
const server = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', 'scripts/serve.mjs'], { stdio: 'inherit', env: process.env })
const stop = () => server.kill('SIGINT')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
server.on('exit', code => process.exit(code ?? 0))
