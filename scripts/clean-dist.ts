import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const project = await fs.realpath(fileURLToPath(new URL('..', import.meta.url)))
const output = path.resolve(project, 'dist')
if (path.dirname(output) !== project) throw new Error('Build output must be inside the project')
const info = await fs.lstat(output).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error
  return undefined
})
// Refuse redirected output so a local link cannot make a build touch another directory.
if (info?.isSymbolicLink()) throw new Error('Refusing to clean a linked dist directory')
await fs.rm(output, { recursive: true, force: true })
