/** Render the HMWORK mascot source into Web, sidebar and install assets. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Versioned source artwork supplied for the HMWORK brand. */
export const SOURCE = fileURLToPath(new URL('../public/brand/hmwork-source.png', import.meta.url))
/** Public directory containing generated Web assets. */
export const OUTPUT = fileURLToPath(new URL('../public/', import.meta.url))

/** Generated square raster assets. */
export const VARIANTS = [
  { file: 'hmwork-mark-24.png', size: 24 },
  { file: 'hmwork-mark-34.png', size: 34 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
] as const

/** Trim transparent margins and center the mascot in a square canvas. */
async function squareSource(): Promise<Buffer> {
  const trimmed = await sharp(await readFile(SOURCE)).trim().ensureAlpha().toBuffer({ resolveWithObject: true })
  const edge = Math.max(trimmed.info.width, trimmed.info.height)
  const left = Math.floor((edge - trimmed.info.width) / 2)
  const right = edge - trimmed.info.width - left
  const top = Math.floor((edge - trimmed.info.height) / 2)
  const bottom = edge - trimmed.info.height - top
  return sharp(trimmed.data).extend({ left, right, top, bottom, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
}

/** Render one normal or maskable icon from the centered source. */
async function render(square: Buffer, size: number, maskable: boolean): Promise<Buffer> {
  if (!maskable) return sharp(square).resize(size, size, { fit: 'contain', kernel: 'lanczos3' }).png().toBuffer()
  const artwork = Math.round(size * 0.78)
  const inset = Math.floor((size - artwork) / 2)
  return sharp(square).resize(artwork, artwork, { fit: 'contain', kernel: 'lanczos3' })
    .extend({ left: inset, right: size - artwork - inset, top: inset, bottom: size - artwork - inset,
      background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer()
}

/** Write an SVG favicon embedding the generated 34px PNG for reliable browser loading. */
async function favicon(square: Buffer, dark: boolean): Promise<void> {
  const png = await render(square, 34, false)
  const background = dark ? '#111827' : '#ffffff'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34"><rect width="34" height="34" rx="8" fill="${background}"/><image href="data:image/png;base64,${png.toString('base64')}" width="34" height="34"/></svg>\n`
  await writeFile(join(OUTPUT, dark ? 'favicon-dark.svg' : 'favicon.svg'), svg)
}

/** Generate all committed HMWORK assets. */
export async function renderHmworkIcons(): Promise<void> {
  await mkdir(dirname(SOURCE), { recursive: true })
  await mkdir(OUTPUT, { recursive: true })
  const square = await squareSource()
  await Promise.all(VARIANTS.map(async ({ file, size }) => writeFile(join(OUTPUT, file), await render(square, size, false))))
  await writeFile(join(OUTPUT, 'icon-maskable-512.png'), await render(square, 512, true))
  await Promise.all([favicon(square, false), favicon(square, true)])
  console.info(`hmwork icons: wrote ${VARIANTS.map(({ file }) => file).join(', ')}, icon-maskable-512.png and favicons`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await renderHmworkIcons()
