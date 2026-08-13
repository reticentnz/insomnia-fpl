import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

fs.rmSync('dist', { recursive: true, force: true })
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
  '--minify'
], { stdio: 'inherit' })

execFileSync(esbuildBin, [
  'src/optimizer-worker.ts',
  '--bundle',
  '--outfile=dist/assets/optimizer-worker.js',
  '--format=esm',
  '--minify'
], { stdio: 'inherit' })

fs.copyFileSync('src/styles.css', 'dist/assets/app.css')
fs.copyFileSync('src/favicon.svg', 'dist/favicon.svg')
fs.copyFileSync('index.html', 'dist/index.html')
fs.appendFileSync('dist/index.html', '\n<link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script>\n')
console.log('production bundle written to dist/')
