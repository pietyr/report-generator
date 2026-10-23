import sharp from 'sharp'
import fs from 'node:fs'
import path from 'node:path'
import { ensureJpegPath, isHeic } from './heic.js'

export type PhotoVariant = 'thumb' | 'preview' | 'full'

export type PreparedPaths = {
  source: string
  full: string
  preview: string
  thumb: string
}

function rotatedPath(source: string, rotation: number) {
  if (rotation === 0) return source
  const base = path.basename(source, path.extname(source))
  return path.join(path.dirname(source), `${base}_rotated_${rotation}.png`)
}

function derivativePath(fullPath: string, kind: 'preview' | 'thumb') {
  const dir = path.dirname(fullPath)
  const base = path.basename(fullPath, path.extname(fullPath))
  return path.join(dir, `${base}_${kind}.jpg`)
}

function isFresh(source: string, derivative: string) {
  if (!fs.existsSync(derivative)) return false
  try {
    return fs.statSync(derivative).mtimeMs >= fs.statSync(source).mtimeMs
  } catch {
    return false
  }
}

function readHeader(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    return head
  } finally {
    fs.closeSync(fd)
  }
}

function needsHeicConvert(absPath: string, originalName?: string) {
  const head = readHeader(absPath)
  return isHeic(absPath, head) || (!!originalName && isHeic(originalName, head))
}

async function writeDerivative(
  fullPath: string,
  outPath: string,
  maxWidth: number,
  quality: number,
) {
  if (isFresh(fullPath, outPath)) return
  await sharp(fullPath)
    .rotate()
    .resize({
      width: maxWidth,
      height: maxWidth,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality, mozjpeg: true })
    .toFile(outPath)
}

/** Convert HEIC if needed, then ensure preview + thumb JPEGs exist. */
export async function preparePhotoDerivatives(
  absPath: string,
  originalName?: string,
  rotation = 0,
): Promise<PreparedPaths> {
  const source = await ensureJpegPath(absPath, originalName)
  const full = rotatedPath(source, rotation)
  if (rotation !== 0 && !isFresh(source, full)) {
    // Always rotate the source, so repeated edits do not degrade image quality.
    await sharp(source).autoOrient().rotate(rotation).png().toFile(full)
  }
  const preview = derivativePath(full, 'preview')
  const thumb = derivativePath(full, 'thumb')
  await writeDerivative(full, preview, 1600, 82)
  await writeDerivative(full, thumb, 400, 72)
  return { source, full, preview, thumb }
}

/** Fast path: if derivatives exist, return without queue; otherwise prepare. */
export async function resolvePhotoVariant(
  absPath: string,
  originalName: string | undefined,
  size: PhotoVariant,
  rotation = 0,
): Promise<{ path: string; fullPath: string }> {
  let full = absPath
  if (rotation !== 0 || needsHeicConvert(absPath, originalName)) {
    const prepared = await withImageQueue(() =>
      preparePhotoDerivatives(absPath, originalName, rotation),
    )
    full = prepared.full
    const chosen =
      size === 'thumb'
        ? prepared.thumb
        : size === 'full'
          ? prepared.full
          : prepared.preview
    return { path: chosen, fullPath: prepared.source }
  }

  // Already JPEG/PNG — derivatives may still be missing
  const preview = derivativePath(full, 'preview')
  const thumb = derivativePath(full, 'thumb')
  const target =
    size === 'thumb' ? thumb : size === 'full' ? full : preview

  if (size === 'full' || isFresh(full, target)) {
    return { path: size === 'full' ? full : target, fullPath: full }
  }

  const prepared = await withImageQueue(() =>
    preparePhotoDerivatives(full, originalName),
  )
  return {
    path: size === 'thumb' ? prepared.thumb : prepared.preview,
    fullPath: prepared.full,
  }
}

/** Remove the source and cached variants, including all saved orientations. */
export function removePhotoFiles(source: string) {
  for (const rotation of [0, 90, 180, 270]) {
    const full = rotatedPath(source, rotation)
    for (const file of [full, derivativePath(full, 'preview'), derivativePath(full, 'thumb')]) {
      fs.rmSync(file, { force: true })
    }
  }
}

/** Simple mutex so HEIC conversions don't stampede the CPU. */
let chain: Promise<unknown> = Promise.resolve()

export function withImageQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
