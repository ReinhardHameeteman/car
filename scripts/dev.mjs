import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const children = []
let shuttingDown = false

function run(label, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  })
  children.push(child)

  const prefix = (chunk, stream) => {
    const text = chunk.toString()
    for (const line of text.split(/\r?\n/)) {
      if (line.length) stream.write(`[${label}] ${line}\n`)
    }
  }
  child.stdout.on('data', (c) => prefix(c, process.stdout))
  child.stderr.on('data', (c) => prefix(c, process.stderr))

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    shuttingDown = true
    const reason = signal ? `signal ${signal}` : `code ${code ?? 0}`
    console.error(`[dev] ${label} exited (${reason}); stopping the rest`)
    for (const other of children) {
      if (other !== child && !other.killed) other.kill()
    }
    process.exit(code && code !== 0 ? code : 1)
  })
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill()
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

run('server', process.execPath, [path.join(root, 'server', 'index.js')])
run('client', process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')])
