/** Private subprocess entry for the host attachment and its image-side pipe relay. */
import { parseInvocation, runGuest, runHost } from './runner.ts'

try {
  const [mode, text] = process.argv.slice(2)
  if (text === undefined) throw new Error('sandbox-container: missing runner arguments')
  if (mode === 'host') process.exitCode = await runHost(parseInvocation(text))
  else if (mode === 'plain' || mode === 'control') {
    const command: unknown = JSON.parse(text)
    if (!Array.isArray(command) || command.length === 0 || !command.every((item: unknown) => typeof item === 'string')) {
      throw new Error('sandbox-container: invalid guest command')
    }
    process.exitCode = await runGuest(command, mode === 'control')
  } else throw new Error('sandbox-container: invalid runner mode')
} catch (error) {
  process.stderr.write(`sandbox-container: ${String(error)}\n`)
  process.exitCode = 1
}
