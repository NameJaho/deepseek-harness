// Docker attachment fixture: run the guest entry with only standard streams inherited.
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === 'version' || args[0] === 'rm') process.exit(0)
const entrypoint = args.indexOf('--entrypoint')
const executable = args[entrypoint + 1]
const child = spawn(executable, args.slice(entrypoint + 3), { stdio: 'inherit' })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
