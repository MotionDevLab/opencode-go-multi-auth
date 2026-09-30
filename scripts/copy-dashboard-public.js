import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(__dirname, '..', 'src', 'dashboard', 'public')
const dest = path.join(__dirname, '..', 'dist', 'dashboard', 'public')

fs.mkdirSync(dest, { recursive: true })
fs.cpSync(src, dest, { recursive: true })
